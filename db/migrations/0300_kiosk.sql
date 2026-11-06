-- Kiosk PINs, photo storage and helpers used by the clock-in server functions.

-- A staff member sets their own control-room PIN (4-6 digits, not 1111 or 1234).
create or replace function set_my_kiosk_pin(p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if me() is null then raise exception 'Sign in first'; end if;
  if p_pin !~ '^\d{4,6}$' or p_pin ~ '^(\d)\1+$' or position(p_pin in '0123456789') > 0 or position(p_pin in '9876543210') > 0 then
    raise exception 'Choose 4 to 6 digits that aren''t all the same or in a straight run';
  end if;
  insert into staff_secrets (staff_id, kiosk_pin_hash, pin_failures, locked_until)
  values (me(), crypt(p_pin, gen_salt('bf', 10)), 0, null)
  on conflict (staff_id) do update set kiosk_pin_hash = excluded.kiosk_pin_hash, pin_failures = 0, locked_until = null;
  insert into audit_log(actor, action, entity, entity_id) values (me(), 'set_pin', 'staff', me()::text);
end $$;

-- The manager clears someone's PIN so they can set a new one (for example after it was shared).
create or replace function clear_kiosk_pin(p_staff uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_manager() then raise exception 'Only the Plant Manager can clear a PIN'; end if;
  update staff_secrets set kiosk_pin_hash = null, pin_failures = 0, locked_until = null where staff_id = p_staff;
  insert into audit_log(actor, action, entity, entity_id) values (me(), 'clear_pin', 'staff', p_staff::text);
end $$;

-- Server only: checks a kiosk PIN. Five wrong tries lock it for 15 minutes.
create or replace function verify_kiosk_pin(p_staff uuid, p_pin text) returns text
language plpgsql security definer set search_path = public as $$
declare s staff_secrets;
begin
  select * into s from staff_secrets where staff_id = p_staff for update;
  if s.staff_id is null or s.kiosk_pin_hash is null then return 'no_pin'; end if;
  if s.locked_until is not null and s.locked_until > now() then return 'locked'; end if;
  if crypt(p_pin, s.kiosk_pin_hash) = s.kiosk_pin_hash then
    update staff_secrets set pin_failures = 0, locked_until = null where staff_id = p_staff;
    return 'ok';
  end if;
  update staff_secrets
     set pin_failures = pin_failures + 1,
         locked_until = case when pin_failures + 1 >= 5 then now() + interval '15 minutes' end
   where staff_id = p_staff;
  return 'wrong';
end $$;
revoke all on function verify_kiosk_pin(uuid, text) from public, anon, authenticated;
grant execute on function verify_kiosk_pin(uuid, text) to service_role;
grant execute on function set_my_kiosk_pin(text), clear_kiosk_pin(uuid) to authenticated;

-- The duty code someone has on a day at a plant (any roster status), for working out their shift.
create or replace function duty_code(p_staff uuid, p_day date) returns text
language sql stable security definer set search_path = public as $$
  select c.code from roster_cells c join rosters r on r.id = c.roster_id
  where c.staff_id = p_staff and c.day = p_day
  order by (r.status = 'approved') desc limit 1
$$;
revoke all on function duty_code(uuid, date) from public, anon;
grant execute on function duty_code(uuid, date) to authenticated, service_role;

-- Who the outgoing shift head should confirm at handover: people rostered on the incoming shift.
create or replace function handover_expected(p_plant text, p_day date, p_shift shift_type)
returns table(staff_id uuid, full_name text, code text, clocked_in_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.full_name, c.code,
    (select min(e.at) from clock_events e where e.staff_id = s.id and e.kind = 'in'
       and e.at between ((p_day + case p_shift when 'D' then time '07:00' else time '19:00' end) at time zone 'Africa/Kampala') - interval '2 hours'
                    and ((p_day + case p_shift when 'D' then time '07:00' else time '19:00' end) at time zone 'Africa/Kampala') + interval '6 hours')
  from roster_cells c join rosters r on r.id = c.roster_id join staff s on s.id = c.staff_id
  where r.plant_id = p_plant and c.day = p_day and plant_of(s.id, p_day) = p_plant
    and c.code in (case p_shift when 'D' then 'D/P' else 'N/P' end, case p_shift when 'D' then 'O.T D/P' else 'O.T N/P' end)
    and (is_manager() or my_plant() = p_plant)
$$;
grant execute on function handover_expected(text, date, shift_type) to authenticated;

-- A handover whose list of who arrived doesn't match the clock-ins is an exception too.
create or replace view handover_mismatches with (security_invoker = true) as
  select h.id as handover_id, h.plant_id, h.shift_date, h.shift, x.staff_id, x.full_name,
    case when x.staff_id = any(h.arrived) and x.clocked_in_at is null then 'confirmed_without_clock_in'
         when not (x.staff_id = any(h.arrived)) and x.clocked_in_at is not null then 'clocked_in_but_not_seen'
    end as problem
  from handovers h, lateral handover_expected(h.plant_id, h.shift_date, h.shift) x
  where (x.staff_id = any(h.arrived)) <> (x.clocked_in_at is not null);
grant select on handover_mismatches to authenticated;

-- Clock-in photos are files on the server's photo volume. The API serves one only if the
-- requester can read its clock_events row (row-level security decides).

-- ---------- Passkey approval ----------
-- A new phone can't clock in until the Plant Manager approves it, ideally with the person present.
-- This stops a colleague who has learned someone's sign-in PIN registering their own fingerprint as them.
alter table passkeys add column approved_by uuid references staff(id), add column approved_at timestamptz;
grant select (approved_at) on passkeys to authenticated;

create or replace function approve_passkey(p_passkey uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_staff uuid;
begin
  if not is_manager() then raise exception 'Only the Plant Manager can approve a new phone'; end if;
  select staff_id into v_staff from passkeys where id = p_passkey and revoked_at is null;
  if v_staff is null then raise exception 'That phone has been removed or doesn''t exist'; end if;
  if v_staff = me() then raise exception 'Another manager must approve your own phone'; end if;
  update passkeys set approved_by = me(), approved_at = now() where id = p_passkey;
  insert into audit_log(actor, action, entity, entity_id, details)
  values (me(), 'approve_passkey', 'passkeys', p_passkey::text, jsonb_build_object('staff_id', v_staff));
end $$;
grant execute on function approve_passkey(uuid) to authenticated;

-- Phones waiting for approval, for the manager's screen.
create or replace view pending_passkeys with (security_invoker = true) as
  select p.id, p.staff_id, s.full_name, p.label, p.created_at
  from passkeys p join staff s on s.id = p.staff_id
  where p.approved_at is null and p.revoked_at is null;
grant select on pending_passkeys to authenticated;

-- ---------- Kiosk name list (server only) ----------
-- Everyone at this plant today plus shared staff, with today's code and last night's, in one query.
create or replace function kiosk_people(p_plant text, p_day date)
returns table(id uuid, name text, today text, last_night text, shared boolean, has_pin boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.full_name, duty_code(s.id, p_day),
         case when duty_code(s.id, p_day - 1) in ('N/P','O.T N/P','N/W') then duty_code(s.id, p_day - 1) end,
         plant_of(s.id, p_day) is null,
         exists (select 1 from staff_secrets x where x.staff_id = s.id and x.kiosk_pin_hash is not null)
  from staff s
  where s.active and (plant_of(s.id, p_day) = p_plant or plant_of(s.id, p_day) is null)
  order by (coalesce(duty_code(s.id, p_day), 'OFF') in ('OFF','')), s.full_name
$$;
revoke all on function kiosk_people(text, date) from public, anon, authenticated;
grant execute on function kiosk_people(text, date) to service_role;
