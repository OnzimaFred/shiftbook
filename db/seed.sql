-- Shiftbook starting data.
-- Plant staff come from the Nyamwamba 1 (November 2026) and Nyamwamba 2 (October 2026) duty schedules.
-- Shared positions are placeholders: set the real names before go-live.

insert into plants (id, name, doc_name) values
  ('n1', 'Nyamwamba 1 HPP', 'NYAMWAMBA 1 SHPP'),
  ('n2', 'Nyamwamba 2 HPP', 'NYAMWAMBA 2 SHPP');
-- Clock-in boundaries: set centre_lat / centre_lng for each power house from the manager screen.

insert into shift_definitions (letter, starts, ends, days, rotating) values
  ('A', '07:00', '19:00', 'Mon-Sun', true),
  ('B', '07:00', '19:00', 'Mon-Sun', true),
  ('C', '07:00', '19:00', 'Mon-Sun', true),
  ('R', '07:00', '19:00', 'As rostered, relief cover', true),
  ('F', '08:00', '17:00', 'Mon-Fri', false),
  ('E', '07:00', '16:00', 'Mon-Sat', false),
  ('G', '08:00', '17:00', 'Mon-Fri', false);

insert into settings (key, value) values
  ('rotation',  '{"cycle": ["D/P","D/P","N/P","N/P","OFF","OFF"], "offsets": {"A":0,"B":2,"C":4}, "anchor": "2026-11-04"}'),
  ('contract',  '{"shift_weekly_hours": 48, "general_daily_hours": 8}'),
  ('rates',     '{"overtime": 1.5, "public_holiday": 2.0}'),
  ('cover',     '{"pt2_extend_minutes": 120, "full_shift_minutes": 720}'),
  ('leave',     '{"annual_days": 25, "sick_days": 10, "casual_days": 5}');

-- Uganda public holidays. 2027 Eid dates are added once announced.
insert into holidays (day, name) values
  ('2026-01-01','New Year''s Day'),('2026-01-15','General elections'),('2026-01-16','General elections'),
  ('2026-01-26','NRM Liberation Day'),('2026-02-16','Archbishop Janani Luwum Day'),('2026-03-08','International Women''s Day'),
  ('2026-03-20','Eid al-Fitr'),('2026-04-03','Good Friday'),('2026-04-06','Easter Monday'),('2026-05-01','Labour Day'),
  ('2026-05-12','Presidential inauguration'),('2026-05-27','Eid al-Adha'),('2026-06-03','Martyrs'' Day'),
  ('2026-06-09','National Heroes'' Day'),('2026-07-28','Local elections'),('2026-10-09','Independence Day'),
  ('2026-12-25','Christmas Day'),('2026-12-26','Boxing Day'),
  ('2027-01-01','New Year''s Day'),('2027-01-26','NRM Liberation Day'),('2027-02-16','Archbishop Janani Luwum Day'),
  ('2027-03-08','International Women''s Day'),('2027-03-26','Good Friday'),('2027-03-29','Easter Monday'),
  ('2027-05-01','Labour Day'),('2027-06-03','Martyrs'' Day'),('2027-06-09','National Heroes'' Day'),
  ('2027-10-09','Independence Day'),('2027-12-25','Christmas Day'),('2027-12-26','Boxing Day');

-- ---------- Staff ----------
create temporary table _s (key text, emp_no text, full_name text, designation designation,
                           app_role app_role, letter text, plant text, from_date date) on commit drop;
insert into _s values
  -- Shared staff (placeholders)
  ('pm',  null, 'Plant Manager (set name)',          'plant_manager',          'manager', 'G', null, '2026-01-01'),
  ('ms',  null, 'Maintenance Supervisor (set name)', 'maintenance_supervisor', 'staff',   'G', null, '2026-01-01'),
  ('sa',  null, 'Site Admin (set name)',             'site_admin',             'staff',   'G', null, '2026-01-01'),
  ('ehs', null, 'EHS Officer (set name)',            'ehs_officer',            'staff',   'G', null, '2026-01-01'),
  -- Nyamwamba 1 HPP (November 2026 duty schedule)
  ('ezra',     null, 'Ezra Kasaija',      'plant_technician_2',     'pt2',   'F', 'n1', '2026-01-01'),
  ('denis',    null, 'Denis Mumbere',     'plant_assistant',        'staff', 'G', 'n1', '2026-01-01'),
  ('moses',    null, 'Moses Masereka',    'plant_technician',       'staff', 'A', 'n1', '2026-01-01'),
  ('joseph',   null, 'Joseph Maate',      'plant_assistant',        'staff', 'A', 'n1', '2026-01-01'),
  ('raphael',  null, 'Raphael Kambale',   'plant_technician',       'staff', 'R', 'n1', '2026-01-01'),
  ('brenda',   null, 'Brenda Biira',      'plant_technician',       'staff', 'B', 'n1', '2026-01-01'),
  ('jevis',    null, 'Jevis Bwambale',    'plant_assistant',        'staff', 'B', 'n1', '2026-01-01'),
  ('augustine',null, 'Augustine Mugisa',  'plant_technician',       'staff', 'C', 'n1', '2026-01-01'),
  ('samson',   null, 'Samson Abaho',      'plant_assistant',        'staff', 'C', 'n1', '2026-01-01'),
  ('martin',   null, 'Martin Bwambale',   'sanitation_environment', 'staff', 'E', 'n1', '2026-01-01'),
  ('amos',     null, 'Amos Kikenge',      'machine_operator',       'staff', 'G', 'n1', '2026-01-01'),
  -- Nyamwamba 2 HPP (October 2026 duty schedule)
  ('fred',     'UG016', 'Fred Onzima',       'plant_technician_2',     'pt2',   'F', 'n2', '2026-01-01'),
  ('edinous',  'UG021', 'Edinous Mumbere',   'plant_technician',       'staff', 'A', 'n2', '2026-01-01'),
  ('robert',   'UG060', 'Robert Bwambale',   'plant_assistant',        'staff', 'A', 'n2', '2026-01-01'),
  ('lilian',   'UG022', 'Lilian Tumusiime',  'plant_technician',       'staff', 'B', 'n2', '2026-01-01'),
  ('majid',    'UG062', 'Majid Mawa',        'plant_assistant',        'staff', 'B', 'n2', '2026-01-01'),
  ('yubu',     'UG059', 'Yubu Byabali',      'plant_technician',       'staff', 'C', 'n2', '2026-01-01'),
  ('adolf',    null,    'Adolf Ategeka',     'plant_assistant',        'staff', 'C', 'n2', '2026-01-01'),
  ('selevest', 'UG063', 'Selevest Bwambale', 'sanitation_environment', 'staff', 'E', 'n2', '2026-01-01');

create temporary table _ids (key text primary key, id uuid) on commit drop;
with ins as (
  insert into staff (emp_no, full_name, designation, app_role, shift_letter)
  select emp_no, full_name, designation, app_role, letter from _s order by key
  returning id, full_name
)
insert into _ids select s.key, ins.id from ins join _s s on s.full_name = ins.full_name;

insert into staff_assignments (staff_id, plant_id, from_date)
select i.id, s.plant, s.from_date from _s s join _ids i using (key);

-- Raphael Kambale moves to Nyamwamba 2 HPP on 7 November 2026.
insert into staff_assignments (staff_id, plant_id, from_date)
select id, 'n2', '2026-11-07' from _ids where key = 'raphael';

-- ---------- Nyamwamba 1 HPP, November 2026 (imported from the duty schedule, approved) ----------
insert into rosters (plant_id, month, status, prepared_by, approved_by, approved_at, imported_from)
select 'n1', '2026-11-01', 'approved', (select id from _ids where key = 'ezra'),
       (select id from _ids where key = 'pm'), '2026-10-30 12:00+03', 'November 2026 duty schedule (PDF)';

create temporary table _rows (key text, codes text) on commit drop;
insert into _rows values
  ('ezra',     'OFF D D D D D OFF OFF D D D/P D D/P OFF OFF D D D/P D D OFF OFF D D D/P D D OFF OFF D'),
  ('denis',    'OFF D/P D D D/P D OFF OFF D/P D D D D OFF OFF D D/P D D/P D OFF OFF D D D D/P D OFF OFF D'),
  ('moses',    'N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P OFF N/P OFF N/P N/P N/P N/P OFF OFF N/P N/P N/P N/P'),
  ('joseph',   'N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P'),
  ('raphael',  'A/L A/L N/P N/P OFF OFF'),
  ('brenda',   'ML ML ML ML OFF OFF D/P D/P D/P D/P OFF OFF OFF D/P D/P D/P OFF OFF D/P D/P D/P D/P OFF OFF OFF D/P D/P D/P OFF OFF'),
  ('jevis',    'D/P OFF N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF'),
  ('augustine','OFF OFF D/P D/P N/P N/P OFF OFF N/P N/P N/P N/P OFF OFF N/P N/P N/P N/P OFF N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P'),
  ('samson',   'OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P'),
  ('martin',   'OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D'),
  ('amos',     'OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D');

insert into roster_cells (roster_id, staff_id, day, code, source)
select (select id from rosters where plant_id = 'n1' and month = '2026-11-01'),
       i.id, date '2026-11-01' + (t.n - 1)::int, t.code, 'import'
from _rows r join _ids i using (key),
     lateral unnest(string_to_array(r.codes, ' ')) with ordinality as t(code, n);

-- The import is history, not an action anyone took: clear its audit rows.
delete from audit_log;
