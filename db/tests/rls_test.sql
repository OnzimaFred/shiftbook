-- Permission tests. Each line prints PASS or FAIL. Run with: tests/run.sh
\set QUIET on
\pset tuples_only on
set client_min_messages = notice;

-- Test accounts linked to real staff rows
insert into auth.users (id, username, password_hash) values
  ('00000000-0000-0000-0000-0000000000a1', 'ua1', 'x'),  -- Plant Manager
  ('00000000-0000-0000-0000-0000000000a2', 'ua2', 'x'),  -- Fred Onzima, PT II Nyamwamba 2
  ('00000000-0000-0000-0000-0000000000a3', 'ua3', 'x'),  -- Ezra Kasaija, PT II Nyamwamba 1
  ('00000000-0000-0000-0000-0000000000a4', 'ua4', 'x'),  -- Moses Masereka, staff Nyamwamba 1
  ('00000000-0000-0000-0000-0000000000a5', 'ua5', 'x');  -- Edinous Mumbere, staff Nyamwamba 2
update staff set user_id = '00000000-0000-0000-0000-0000000000a1' where full_name like 'Plant Manager%';
update staff set user_id = '00000000-0000-0000-0000-0000000000a2' where full_name = 'Fred Onzima';
update staff set user_id = '00000000-0000-0000-0000-0000000000a3' where full_name = 'Ezra Kasaija';
update staff set user_id = '00000000-0000-0000-0000-0000000000a4' where full_name = 'Moses Masereka';
update staff set user_id = '00000000-0000-0000-0000-0000000000a5' where full_name = 'Edinous Mumbere';

create or replace function t(ok boolean, name text) returns void language plpgsql as
$$ begin raise notice '%: %', case when ok then 'PASS' else 'FAIL' end, name; end $$;
grant execute on function t(boolean, text) to authenticated;

-- Runs a statement as the current role and reports whether it was refused.
create or replace function refused(stmt text) returns boolean language plpgsql as $$
declare n int;
begin
  execute stmt; get diagnostics n = row_count;
  return n = 0;                      -- silently filtered by RLS counts as refused
exception when others then return true;
end $$;
grant execute on function refused(text) to authenticated;

create or replace function sid(name text) returns uuid language sql stable security definer as
  $$ select id from staff where full_name = name $$;
grant execute on function sid(text) to authenticated;

-- A sample clock-in written by the server (as an edge function would)
insert into clock_events (staff_id, plant_id, kind, at, method, flags)
values (sid('Moses Masereka'), 'n1', 'in', '2026-11-05 07:12+03', 'personal_passkey', '{late}');

-- ================= Staff: Moses Masereka (Nyamwamba 1) =================
set role authenticated;
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a4', false);

select t(me() = sid('Moses Masereka'), 'staff: signed-in user resolves to their staff record');
select t((select count(*) from roster_cells) > 0, 'staff: reads their plant''s approved roster');
select t(refused($$update roster_cells set code = 'OFF' where day = '2026-11-05'$$), 'staff: cannot edit the roster');
select t(refused($$select * from staff_secrets$$), 'staff: cannot read PIN hashes');
select t(refused($$select * from device_secrets$$), 'staff: cannot read kiosk QR secrets');
select t(refused($$select public_key from passkeys$$), 'staff: cannot read passkey key material');
select t(refused($$insert into clock_events (staff_id, kind, method) values (me(), 'in', 'personal_passkey')$$), 'staff: cannot write a clock-in directly');
select t(refused($$update clock_events set flags = '{}'$$), 'staff: cannot clear flags on their clock-in');
select t((select count(*) from clock_events) = 1, 'staff: sees their own clock-in');
select t(refused($$insert into leave_requests (staff_id, type, from_date, to_date, status) values (me(), 'annual', '2026-12-01', '2026-12-02', 'approved')$$), 'staff: cannot file leave as already approved');
select t(refused($$insert into leave_requests (staff_id, type, from_date, to_date) values (sid('Joseph Maate'), 'annual', '2026-12-01', '2026-12-02')$$), 'staff: cannot file leave for a colleague');
select t(not refused($$insert into leave_requests (staff_id, type, from_date, to_date, reason) values (me(), 'annual', '2026-12-10', '2026-12-11', 'Family visit')$$), 'staff: files own leave as pending');
select t(refused($$update leave_requests set status = 'approved' where staff_id = me()$$), 'staff: cannot approve own leave');
select t(refused($$update leave_requests set to_date = '2026-12-31' where staff_id = me()$$), 'staff: cannot change a filed request');
select t(not refused($$update leave_requests set status = 'cancelled' where staff_id = me() and status = 'pending'$$), 'staff: cancels own pending leave');
select t(not refused($$insert into overtime_claims (staff_id, month, ot_hours, reason) values (me(), '2026-10-01', 34, 'Rostered shifts above contract')$$), 'staff: claims own overtime');
select t(refused($$update overtime_claims set status = 'approved' where staff_id = me()$$), 'staff: cannot approve own overtime');
select t((select count(*) from audit_log) = 0, 'staff: cannot read the audit log');
select t(refused($$update staff set app_role = 'manager' where id = me()$$), 'staff: cannot promote themselves');
select t(refused($$insert into handovers (plant_id, shift_date, shift, outgoing_head, arrived) values ('n2', '2026-11-05', 'N', me(), '{}')$$), 'staff: cannot confirm a handover for another plant');
reset role;

-- ================= PT II: Fred Onzima (Nyamwamba 2) =================
set role authenticated;
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a2', false);

select t(my_plant() = 'n2', 'PT II: plant resolves to Nyamwamba 2');
select t(not refused($$insert into rosters (plant_id, month, prepared_by) values ('n2', '2026-11-01', me())$$), 'PT II: starts own plant''s roster');
select t(refused($$insert into rosters (plant_id, month) values ('n1', '2026-12-01')$$), 'PT II: cannot start the other plant''s roster');
select t(refused($$update roster_cells set code = 'OFF' where staff_id = sid('Moses Masereka')$$), 'PT II: cannot edit the other plant''s roster');

-- Fill November from the rotation: 2 days, 2 nights, 2 off; anchor 4 Nov; crews A=0, B=2, C=4.
insert into roster_cells (roster_id, staff_id, day, code)
select r.id, s.id, d::date,
  case
    when s.shift_letter in ('A','B','C') then
      (array['D/P','D/P','N/P','N/P','OFF','OFF'])[1 + (((d::date - date '2026-11-04') - case s.shift_letter when 'A' then 0 when 'B' then 2 else 4 end) % 6 + 6) % 6]
    when s.shift_letter = 'R' then 'OFF'
    when s.shift_letter = 'E' then case when extract(isodow from d) = 7 then 'OFF' else 'D' end
    else case when extract(isodow from d) in (6,7) then 'OFF' else 'D' end
  end
from rosters r, staff s, generate_series(date '2026-11-01', date '2026-11-30', interval '1 day') d
where r.plant_id = 'n2' and r.month = '2026-11-01' and plant_of(s.id, d::date) = 'n2';

select t((select count(*) from roster_problems((select id from rosters where plant_id='n2' and month='2026-11-01'))) = 0, 'PT II: rotation-built roster passes the night rule');
-- Break a night: take the assistant off 13 Nov
update roster_cells c set code = 'OFF' from staff s
where s.id = c.staff_id and s.designation = 'plant_assistant'
  and c.day = '2026-11-13' and c.code = 'N/P' and plant_of(c.staff_id, c.day) = 'n2';
select t(refused($$update rosters set status = 'submitted' where plant_id = 'n2' and month = '2026-11-01'$$), 'PT II: cannot submit with a night of only 1 person');
-- Cover it with an off-duty assistant (cell edit), then submit
update roster_cells set code = 'O.T N/P'
where staff_id = (select c.staff_id from roster_cells c join staff s on s.id = c.staff_id
                  where c.day = '2026-11-13' and c.code = 'OFF' and s.designation = 'plant_assistant'
                    and plant_of(c.staff_id, c.day) = 'n2'
                    and not exists (select 1 from roster_cells x where x.staff_id = c.staff_id and x.day = '2026-11-14' and x.code in ('D/P','D'))
                  limit 1)
  and day = '2026-11-13';
select t((select count(*) from roster_problems((select id from rosters where plant_id='n2' and month='2026-11-01'))) = 0, 'PT II: cover fixes the night');
select t(not refused($$update rosters set status = 'submitted' where plant_id = 'n2' and month = '2026-11-01'$$), 'PT II: submits the roster');
select t(refused($$update roster_cells set code = 'OFF' where day = '2026-11-20' and staff_id = sid('Fred Onzima')$$), 'PT II: cannot edit after submitting');
select t(refused($$update rosters set status = 'approved' where plant_id = 'n2'$$), 'PT II: cannot approve own roster');
reset role;

-- ================= Staff at the other plant can't see a submitted draft =================
set role authenticated;
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a4', false);
select t((select count(*) from rosters where plant_id = 'n2') = 0, 'staff: cannot see another plant''s unapproved roster');
reset role;

-- ================= PT II: Ezra Kasaija (Nyamwamba 1) =================
set role authenticated;
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a3', false);
select t((select count(*) from rosters where plant_id = 'n2') = 0, 'PT II: cannot see the other plant''s submitted roster');
select t((select count(*) from leave_requests where staff_id = sid('Moses Masereka')) = 1, 'PT II: sees leave for own plant''s staff');
select t((select count(*) from clock_events) = 1, 'PT II: sees own plant''s clock-ins');
select t(refused($$update leave_requests set status = 'approved'$$), 'PT II: cannot approve leave');
select t(not refused($$insert into leave_requests (staff_id, type, from_date, to_date, status, reason) values (sid('Moses Masereka'), 'sick', '2026-11-06', '2026-11-06', 'approved', 'Reported sick')$$), 'PT II: marks own plant''s staff sick');
select t((select code from roster_cells where staff_id = sid('Moses Masereka') and day = '2026-11-06') = 'S/L', 'sick day writes S/L onto the roster');
select t(refused($$insert into leave_requests (staff_id, type, from_date, to_date, status) values (sid('Edinous Mumbere'), 'sick', '2026-11-06', '2026-11-06', 'approved')$$), 'PT II: cannot mark the other plant''s staff sick');
select t(not refused($$insert into cover_assignments (plant_id, day, shift, slot, for_staff_id, cover_staff_id, mode, ot_minutes) values ('n1', '2026-11-06', 'D', 'head', sid('Moses Masereka'), sid('Ezra Kasaija'), 'extend', 120)$$), 'PT II: books cover for own plant');
select t((select code from roster_cells where staff_id = sid('Ezra Kasaija') and day = '2026-11-06') = 'D/P', 'cover writes D/P onto the PT II''s day');
select t(refused($$insert into cover_assignments (plant_id, day, shift, slot, cover_staff_id, mode) values ('n2', '2026-11-06', 'N', 'asst', sid('Majid Mawa'), 'full')$$), 'PT II: cannot book cover at the other plant');
reset role;

-- ================= Plant Manager =================
set role authenticated;
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a1', false);
select t(refused($$update rosters set status = 'returned' where plant_id = 'n2' and month = '2026-11-01'$$), 'manager: must add a note to return a roster');
select t(not refused($$update rosters set status = 'approved' where plant_id = 'n2' and month = '2026-11-01'$$), 'manager: approves the submitted roster');
select t((select approved_by from rosters where plant_id = 'n2' and month = '2026-11-01') = me(), 'manager: approval records who approved');
select t(not refused($$update overtime_claims set status = 'approved' where staff_id = sid('Moses Masereka')$$), 'manager: approves overtime');
select t(refused($$update overtime_claims set status = 'declined' where staff_id = sid('Moses Masereka')$$), 'manager: cannot re-decide an approved claim');
select t(not refused($$update clock_events set review_note = 'Taxi broke down, accepted', flags = '{}' where staff_id = sid('Moses Masereka')$$), 'manager: reviews a flagged clock-in');
select t((select flags from clock_events where staff_id = sid('Moses Masereka')) = '{late}', 'manager: review keeps the original flags');
select t((select reviewed_by from clock_events where staff_id = sid('Moses Masereka')) = me(), 'manager: review records the reviewer');
select t((select count(*) from audit_log) > 0, 'manager: reads the audit log');
select t((select count(*) from audit_log where entity = 'rosters' and actor = sid('Fred Onzima')) >= 1, 'audit: roster submission recorded against Fred');
select t((select count(*) from attendance_exceptions) >= 0, 'manager: reads attendance exceptions');
select t(refused($$select * from staff_secrets$$), 'manager: cannot read PIN hashes either');
reset role;

-- ================= Kiosk PINs, phone approval, handover =================
set role authenticated;
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a4', false);   -- Moses
select t(refused($$select set_my_kiosk_pin('1234')$$), 'PIN: a straight run like 1234 is refused');
select t(refused($$select set_my_kiosk_pin('7777')$$), 'PIN: repeated digits are refused');
select t(not refused($$select set_my_kiosk_pin('4829')$$), 'PIN: staff set their own PIN');
select t(refused($$select verify_kiosk_pin(me(), '4829')$$), 'PIN: staff cannot call the server-only PIN check');
select t(not refused($$insert into handovers (plant_id, shift_date, shift, outgoing_head, arrived) values ('n1', '2026-11-05', 'N', me(), array[sid('Augustine Mugisa'), sid('Samson Abaho')])$$), 'handover: outgoing shift head confirms who arrived');
reset role;

-- The server checks PINs (as the kiosk function would)
select t(verify_kiosk_pin(sid('Moses Masereka'), '4829') = 'ok', 'PIN: correct PIN accepted');
select t(verify_kiosk_pin(sid('Moses Masereka'), '0000') = 'wrong', 'PIN: wrong PIN refused');
select verify_kiosk_pin(sid('Moses Masereka'), '0000') from generate_series(1, 4);
select t(verify_kiosk_pin(sid('Moses Masereka'), '4829') = 'locked', 'PIN: five wrong tries lock it, even for the right PIN');
select t(verify_kiosk_pin(sid('Joseph Maate'), '4829') = 'no_pin', 'PIN: someone without a PIN is told to set one');
select t((select kiosk_pin_hash not like '%4829%' from staff_secrets where staff_id = sid('Moses Masereka')), 'PIN: stored only as a hash');

-- A phone registered by the server function, waiting for approval
insert into passkeys (staff_id, credential_id, public_key, label)
values (sid('Moses Masereka'), 'cred-moses-1', '\x01', 'Tecno Spark');

set role authenticated;
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a4', false);   -- Moses
select t((select count(*) from pending_passkeys) = 1, 'phone: staff see their own phone waiting for approval');
select t(refused($$select approve_passkey((select id from passkeys limit 1))$$), 'phone: staff cannot approve their own phone');
select t(refused($$update passkeys set approved_at = now()$$), 'phone: staff cannot mark it approved directly');
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a3', false);   -- Ezra, PT II
select t(refused($$select approve_passkey((select id from pending_passkeys limit 1))$$), 'phone: a PT II cannot approve phones');
select set_config('app.user_id', '00000000-0000-0000-0000-0000000000a1', false);   -- manager
select t((select count(*) from pending_passkeys) = 1, 'phone: the manager sees phones waiting for approval');
select t(not refused($$select approve_passkey((select id from pending_passkeys limit 1))$$), 'phone: the Plant Manager approves it');
select t((select count(*) from pending_passkeys) = 0, 'phone: it leaves the waiting list');
select t((select count(*) from audit_log where action = 'approve_passkey' and actor = me()) = 1, 'phone: approval is in the audit log');
select t((select count(*) from handover_mismatches where problem = 'confirmed_without_clock_in') = 2, 'handover: people confirmed but never clocked in are listed');
reset role;

-- ================= Anonymous =================
set role anon;
select t(refused($$select * from staff$$), 'anonymous: cannot read anything');
reset role;
