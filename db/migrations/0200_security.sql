-- Shiftbook security: who can see and change what.
-- Row-level security (RLS) on every table, plus triggers that guard status changes
-- so a modified app still can't approve its own roster, leave or overtime.

-- ---------- Helpers ----------
create or replace function local_today() returns date
language sql stable as $$ select (now() at time zone 'Africa/Kampala')::date $$;

-- The staff record of the signed-in user.
create or replace function me() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where user_id = auth.uid() and active
$$;

create or replace function my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select app_role from staff where user_id = auth.uid() and active
$$;

-- Which plant a person works at on a given day (null = shared staff or unknown).
create or replace function plant_of(p_staff uuid, p_day date) returns text
language sql stable security definer set search_path = public as $$
  select plant_id from staff_assignments
  where staff_id = p_staff and from_date <= p_day
  order by from_date desc limit 1
$$;

create or replace function my_plant() returns text
language sql stable security definer set search_path = public as $$
  select plant_of(me(), local_today())
$$;

create or replace function is_manager() returns boolean
language sql stable as $$ select coalesce(my_role() = 'manager', false) $$;

create or replace function is_pt2_of(p_plant text) returns boolean
language sql stable as $$ select coalesce(my_role() = 'pt2' and my_plant() = p_plant, false) $$;

-- Is someone in my plant on that day? (Plant Technician II's reach.)
create or replace function in_my_plant(p_staff uuid, p_day date) returns boolean
language sql stable as $$ select coalesce(plant_of(p_staff, p_day) = my_plant(), false) $$;

revoke all on function me(), my_role(), plant_of(uuid,date), my_plant() from public, anon;
grant execute on function me(), my_role(), plant_of(uuid,date), my_plant(), is_manager(),
  is_pt2_of(text), in_my_plant(uuid,date), local_today() to authenticated, service_role;

-- ---------- Audit ----------
create or replace function audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id text; v_details jsonb;
begin
  if tg_op = 'DELETE' then
    v_id := coalesce(to_jsonb(old)->>'id', to_jsonb(old)->>'roster_id');
    v_details := jsonb_build_object('old', to_jsonb(old));
  elsif tg_op = 'INSERT' then
    v_id := coalesce(to_jsonb(new)->>'id', to_jsonb(new)->>'roster_id');
    v_details := jsonb_build_object('new', to_jsonb(new));
  else
    v_id := coalesce(to_jsonb(new)->>'id', to_jsonb(new)->>'roster_id');
    v_details := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
  end if;
  insert into audit_log(actor, action, entity, entity_id, details)
  values (me(), lower(tg_op), tg_table_name, v_id, v_details);
  return coalesce(new, old);
end $$;

-- ---------- Roster checks (the strict night rule, enforced in the database) ----------
-- Returns one row per problem. Empty result = the roster can be submitted and approved.
create or replace function roster_problems(p_roster uuid)
returns table(day date, shift text, problem text)
language sql stable security definer set search_path = public as $$
  with r as (select plant_id, month from rosters where id = p_roster),
  days as (
    select d::date as day from r,
      generate_series(r.month, (r.month + interval '1 month - 1 day')::date, interval '1 day') d
  ),
  cells as (
    select c.day, c.code, s.designation, s.id as staff_id
    from roster_cells c join staff s on s.id = c.staff_id, r
    where c.roster_id = p_roster and plant_of(c.staff_id, c.day) = r.plant_id
  ),
  per_day as (
    select d.day,
      count(*) filter (where c.code in ('N/P','O.T N/P')) as n_total,
      count(*) filter (where c.code in ('N/P','O.T N/P') and c.designation in ('plant_technician','plant_technician_2')) as n_head,
      count(*) filter (where c.code in ('N/P','O.T N/P') and c.designation = 'plant_assistant') as n_asst,
      count(*) filter (where c.code in ('D/P','O.T D/P') and c.designation in ('plant_technician','plant_technician_2')) as d_head
    from days d left join cells c on c.day = d.day
    group by d.day
  )
  select day, 'N', format('night has %s on shift, needs exactly 2', n_total) from per_day where n_total <> 2
  union all
  select day, 'N', 'night has no shift head' from per_day where n_head = 0
  union all
  select day, 'N', 'night has no plant assistant' from per_day where n_asst = 0
  union all
  select day, 'D', 'day shift has no shift head' from per_day where d_head = 0
  union all
  select b.day, 'D', format('%s works a day straight after a night', s.full_name)
  from cells a join cells b on b.staff_id = a.staff_id and b.day = a.day + 1
  join staff s on s.id = a.staff_id
  where a.code in ('N/P','O.T N/P','N/W') and b.code in ('D/P','O.T D/P','D')
  order by 1, 2
$$;
grant execute on function roster_problems(uuid) to authenticated;

-- ---------- Status guards ----------
create or replace function guard_roster() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role app_role := my_role(); v_n int;
begin
  if auth.uid() is null then return new; end if;   -- server functions and migrations have no signed-in user
  if new.plant_id <> old.plant_id or new.month <> old.month then
    raise exception 'A roster''s plant and month can''t be changed';
  end if;
  if new.status is distinct from old.status then
    if v_role = 'pt2' and old.status in ('draft','returned') and new.status = 'submitted' then
      new.submitted_at := now(); new.return_note := null;
    elsif v_role = 'manager' and old.status = 'submitted' and new.status = 'approved' then
      new.approved_by := me(); new.approved_at := now();
    elsif v_role = 'manager' and old.status = 'submitted' and new.status = 'returned' then
      if coalesce(trim(new.return_note), '') = '' then
        raise exception 'Add a note saying what needs changing before returning the roster';
      end if;
    elsif v_role = 'manager' and new.status = 'draft' then
      new.approved_by := null; new.approved_at := null;
    else
      raise exception 'You can''t move a roster from % to %', old.status, new.status;
    end if;
    if new.status in ('submitted','approved') then
      select count(*) into v_n from roster_problems(new.id);
      if v_n > 0 then
        raise exception 'This roster has % problem(s) to fix first, for example every night needs exactly 2 people with a shift head', v_n;
      end if;
    end if;
  end if;
  if v_role <> 'manager' then        -- only the manager can set approval fields
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
  end if;
  return new;
end $$;
create trigger rosters_guard before update on rosters for each row execute function guard_roster();

create or replace function guard_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role app_role := my_role();
begin
  if auth.uid() is null then return new; end if;   -- server functions and migrations have no signed-in user
  if tg_op = 'INSERT' then
    if v_role = 'manager' then
      if new.status = 'approved' then new.decided_by := me(); new.decided_at := now(); end if;
      return new;
    end if;
    -- Plant Technician II may record a sick day for their own plant (the "Mark sick" button)
    if tg_table_name = 'leave_requests' and v_role = 'pt2' then
      -- read leave-only columns through jsonb: overtime_claims rows don't have them
      if to_jsonb(new)->>'type' = 'sick' and new.status = 'approved'
         and in_my_plant(new.staff_id, (to_jsonb(new)->>'from_date')::date) then
        new.decided_by := me(); new.decided_at := now(); return new;
      end if;
    end if;
    if new.staff_id <> me() or new.status <> 'pending' then
      raise exception 'You can only file your own requests, and they start as pending';
    end if;
    new.decided_by := null; new.decided_at := null;
    return new;
  end if;
  -- UPDATE
  if v_role = 'manager' then
    if new.status is distinct from old.status then
      if old.status <> 'pending' and not (old.status = 'approved' and new.status = 'cancelled') then
        raise exception 'This request has already been decided';
      end if;
      new.decided_by := me(); new.decided_at := now();
    end if;
    return new;
  end if;
  if old.staff_id = me() and old.status = 'pending' and new.status = 'cancelled' then
    old.status := 'cancelled';     -- owners may only cancel; every other field stays as it was
    return old;
  end if;
  raise exception 'Only the Plant Manager can decide requests. You can cancel your own pending request.';
end $$;
create trigger leave_guard before insert or update on leave_requests for each row execute function guard_request();
create trigger overtime_guard before insert or update on overtime_claims for each row execute function guard_request();

-- Clock-in rows: only review fields can change, and only by the manager.
create or replace function guard_clock_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- server functions and migrations have no signed-in user
  if not is_manager() then raise exception 'Only the Plant Manager can review clock-ins'; end if;
  old.reviewed_by := me(); old.reviewed_at := now(); old.review_note := new.review_note;
  return old;
end $$;
create trigger clock_review_guard before update on clock_events for each row execute function guard_clock_review();

-- ---------- Keep the roster in step with leave and cover ----------
-- Approved leave writes its code onto the person's rostered shifts.
create or replace function leave_to_roster() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_code text := case new.type when 'annual' then 'A/L' when 'sick' then 'S/L' when 'casual' then 'C/L'
                                     when 'maternity_paternity' then 'ML' else 'U/L' end;
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    update roster_cells c set code = v_code, source = 'leave', updated_by = me(), updated_at = now()
    from rosters r
    where c.roster_id = r.id and c.staff_id = new.staff_id
      and c.day between new.from_date and new.to_date
      and c.code not in ('OFF','');
  end if;
  return new;
end $$;
create trigger leave_roster after insert or update of status on leave_requests
  for each row execute function leave_to_roster();

-- Booked cover writes the cover code onto the coverer's day; removing it clears the cell.
create or replace function cover_to_roster() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_roster uuid; v_letter text; v_code text;
begin
  if tg_op = 'DELETE' then
    delete from roster_cells c using rosters r
    where c.roster_id = r.id and r.plant_id = old.plant_id and c.staff_id = old.cover_staff_id
      and c.day = old.day and c.source = 'cover';
    return old;
  end if;
  select id into v_roster from rosters where plant_id = new.plant_id and month = date_trunc('month', new.day)::date;
  if v_roster is null then raise exception 'There''s no roster for % yet. Start it first.', to_char(new.day, 'FMMonth YYYY'); end if;
  select shift_letter into v_letter from staff where id = new.cover_staff_id;
  v_code := case when v_letter in ('A','B','C','R') then 'O.T ' else '' end || case new.shift when 'D' then 'D/P' else 'N/P' end;
  insert into roster_cells(roster_id, staff_id, day, code, source, updated_by)
  values (v_roster, new.cover_staff_id, new.day, v_code, 'cover', me())
  on conflict (roster_id, staff_id, day) do update set code = excluded.code, source = 'cover',
    updated_by = excluded.updated_by, updated_at = now();
  return new;
end $$;
create trigger cover_roster after insert or delete on cover_assignments
  for each row execute function cover_to_roster();

-- Stamp who edited a cell.
create or replace function stamp_cell() returns trigger
language plpgsql as $$
begin new.updated_by := coalesce(me(), new.updated_by); new.updated_at := now(); return new; end $$;
create trigger roster_cells_stamp before insert or update on roster_cells for each row execute function stamp_cell();

-- ---------- Audit triggers ----------
create trigger audit_rosters   after insert or update or delete on rosters           for each row execute function audit();
create trigger audit_cells     after insert or update or delete on roster_cells      for each row execute function audit();
create trigger audit_cover     after insert or update or delete on cover_assignments for each row execute function audit();
create trigger audit_leave     after insert or update           on leave_requests    for each row execute function audit();
create trigger audit_overtime  after insert or update           on overtime_claims   for each row execute function audit();
create trigger audit_clock     after update                     on clock_events      for each row execute function audit();
create trigger audit_staff     after insert or update or delete on staff             for each row execute function audit();
create trigger audit_handover  after insert or update           on handovers         for each row execute function audit();

-- ---------- Row-level security ----------
alter table plants              enable row level security;
alter table shift_definitions   enable row level security;
alter table holidays            enable row level security;
alter table settings            enable row level security;
alter table staff               enable row level security;
alter table staff_assignments   enable row level security;
alter table staff_secrets       enable row level security;   -- no policies: server only
alter table rosters             enable row level security;
alter table roster_cells        enable row level security;
alter table cover_assignments   enable row level security;
alter table leave_requests      enable row level security;
alter table overtime_claims     enable row level security;
alter table devices             enable row level security;
alter table device_secrets      enable row level security;   -- no policies: server only
alter table passkeys            enable row level security;
alter table webauthn_challenges enable row level security;   -- no policies: server only
alter table clock_events        enable row level security;
alter table handovers           enable row level security;
alter table audit_log           enable row level security;

-- Reference data: everyone signed in reads; the manager edits.
create policy ref_read  on plants            for select to authenticated using (true);
create policy ref_write on plants            for all    to authenticated using (is_manager()) with check (is_manager());
create policy ref_read  on shift_definitions for select to authenticated using (true);
create policy ref_write on shift_definitions for all    to authenticated using (is_manager()) with check (is_manager());
create policy ref_read  on holidays          for select to authenticated using (true);
create policy ref_write on holidays          for all    to authenticated using (is_manager()) with check (is_manager());
create policy ref_read  on settings          for select to authenticated using (true);
create policy ref_write on settings          for all    to authenticated using (is_manager()) with check (is_manager());

-- Staff directory: names and roles are visible to colleagues; only the manager changes them.
create policy staff_read   on staff             for select to authenticated using (true);
create policy staff_write  on staff             for all    to authenticated using (is_manager()) with check (is_manager());
create policy assign_read  on staff_assignments for select to authenticated using (true);
create policy assign_write on staff_assignments for all    to authenticated using (is_manager()) with check (is_manager());

-- Rosters
create or replace function can_read_roster(p_plant text, p_status roster_status) returns boolean
language sql stable as $$
  select is_manager() or is_pt2_of(p_plant)
      or (p_status = 'approved' and (my_plant() = p_plant or my_plant() is null))
$$;
create or replace function can_edit_roster(p_roster uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rosters r where r.id = p_roster
    and (is_manager() or (is_pt2_of(r.plant_id) and r.status in ('draft','returned'))))
$$;
grant execute on function can_read_roster(text, roster_status), can_edit_roster(uuid) to authenticated;

create policy roster_read   on rosters for select to authenticated using (can_read_roster(plant_id, status));
create policy roster_create on rosters for insert to authenticated
  with check (is_manager() or (is_pt2_of(plant_id) and status = 'draft'));
create policy roster_update on rosters for update to authenticated
  using (is_manager() or (is_pt2_of(plant_id) and status in ('draft','returned')))
  with check (is_manager() or is_pt2_of(plant_id));
create policy roster_delete on rosters for delete to authenticated using (is_manager());

create policy cells_read on roster_cells for select to authenticated
  using (exists (select 1 from rosters r where r.id = roster_id and can_read_roster(r.plant_id, r.status)));
create policy cells_write on roster_cells for all to authenticated
  using (can_edit_roster(roster_id)) with check (can_edit_roster(roster_id));

-- Cover: the Plant Technician II books cover for their own plant at any time (sick days happen
-- after approval); the manager for both plants.
create policy cover_read  on cover_assignments for select to authenticated
  using (is_manager() or my_plant() = plant_id or cover_staff_id = me() or for_staff_id = me());
create policy cover_write on cover_assignments for all to authenticated
  using (is_manager() or is_pt2_of(plant_id)) with check (is_manager() or is_pt2_of(plant_id));

-- Leave and overtime: your own; your plant if you're its Plant Technician II; everything for the manager.
create policy leave_read on leave_requests for select to authenticated
  using (staff_id = me() or is_manager() or (my_role() = 'pt2' and in_my_plant(staff_id, from_date)));
create policy leave_insert on leave_requests for insert to authenticated
  with check (staff_id = me() or is_manager() or (my_role() = 'pt2' and in_my_plant(staff_id, from_date)));
create policy leave_update on leave_requests for update to authenticated
  using (staff_id = me() or is_manager());

create policy ot_read on overtime_claims for select to authenticated
  using (staff_id = me() or is_manager() or (my_role() = 'pt2' and in_my_plant(staff_id, month)));
create policy ot_insert on overtime_claims for insert to authenticated with check (staff_id = me() or is_manager());
create policy ot_update on overtime_claims for update to authenticated using (staff_id = me() or is_manager());

-- Clock-in: rows are written only by the server functions (service role). Reading follows the usual reach.
create policy clock_read on clock_events for select to authenticated
  using (staff_id = me() or is_manager() or (my_role() = 'pt2' and in_my_plant(staff_id, (at at time zone 'Africa/Kampala')::date)));
create policy clock_review on clock_events for update to authenticated using (is_manager());

create policy handover_read on handovers for select to authenticated using (is_manager() or my_plant() = plant_id);
create policy handover_insert on handovers for insert to authenticated
  with check (outgoing_head = me() and my_plant() = plant_id);

create policy devices_read  on devices for select to authenticated using (is_manager() or is_pt2_of(plant_id));
create policy devices_admin on devices for update to authenticated using (is_manager()) with check (is_manager());

create policy passkeys_own    on passkeys for select to authenticated using (staff_id = me() or is_manager());
create policy passkeys_revoke on passkeys for update to authenticated using (staff_id = me() or is_manager())
  with check (staff_id = me() or is_manager());

create policy audit_read on audit_log for select to authenticated using (is_manager());

-- The app sees passkey labels and dates, never the key material.
revoke all on passkeys from authenticated, anon;
grant select (id, staff_id, label, created_at, last_used_at, revoked_at) on passkeys to authenticated;
grant update (revoked_at, label) on passkeys to authenticated;

-- Secret tables: no access from the app at all, even if a policy is added by mistake.
revoke all on staff_secrets, device_secrets, webauthn_challenges from authenticated, anon;
-- Nothing is reachable without signing in.
revoke all on all tables in schema public from anon;

-- ---------- Exceptions for the Plant Manager ----------
-- Rostered shifts that have started with no clock-in, and unreviewed flagged clock-ins.
create or replace view attendance_exceptions with (security_invoker = true) as
  with duty as (
    select c.staff_id, c.day, c.code, r.plant_id,
      (c.day + case when c.code in ('N/P','O.T N/P','N/W') then time '19:00'
                    when c.code = 'D' then time '08:00' else time '07:00' end) at time zone 'Africa/Kampala' as starts_at
    from roster_cells c join rosters r on r.id = c.roster_id
    where r.status = 'approved' and c.code in ('D/P','N/P','N/W','D','O.T D/P','O.T N/P')
      and c.day between local_today() - 31 and local_today()
  )
  select 'no_clock_in'::text as kind, d.staff_id, d.plant_id, d.starts_at as at, d.code as detail, null::uuid as clock_event_id
  from duty d
  where d.starts_at + interval '30 minutes' < now()
    and not exists (select 1 from clock_events e where e.staff_id = d.staff_id and e.kind = 'in'
                    and e.at between d.starts_at - interval '2 hours' and d.starts_at + interval '6 hours')
  union all
  select 'flagged', e.staff_id, e.plant_id, e.at, array_to_string(e.flags, ', '), e.id
  from clock_events e where cardinality(e.flags) > 0 and e.reviewed_at is null;

grant select on attendance_exceptions to authenticated;
