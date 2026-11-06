-- Shiftbook schema: plants, staff, rosters, leave, overtime, clock-in.
-- Postgres 16. Times are stored in UTC; plant local time is Africa/Kampala (UTC+3).

-- ---------- Types ----------
create type app_role       as enum ('staff', 'pt2', 'manager');
create type designation    as enum ('plant_manager','maintenance_supervisor','site_admin','ehs_officer',
                                    'plant_technician_2','plant_technician','plant_assistant',
                                    'sanitation_environment','machine_operator');
create type roster_status  as enum ('draft','submitted','returned','approved');
create type leave_type     as enum ('annual','sick','casual','maternity_paternity','unpaid');
create type request_status as enum ('pending','approved','declined','cancelled');
create type clock_kind     as enum ('in','out');
create type clock_method   as enum ('personal_passkey','kiosk_pin_photo','manual_by_manager');
create type shift_type     as enum ('D','N');           -- day 07:00-19:00, night 19:00-07:00
create type cover_slot     as enum ('head','asst');

-- ---------- Reference data ----------
create table plants (
  id          text primary key check (id ~ '^[a-z0-9]+$'),
  name        text not null,                -- Nyamwamba 1 HPP
  doc_name    text not null,                -- NYAMWAMBA 1 SHPP (duty schedule title)
  centre_lat  double precision,             -- clock-in boundary centre; null until the manager sets it
  centre_lng  double precision,
  radius_m    integer not null default 300 check (radius_m between 50 and 5000),
  created_at  timestamptz not null default now()
);

create table shift_definitions (           -- the "Working Hour/Day" table
  letter      text primary key check (letter in ('A','B','C','R','F','E','G')),
  starts      time not null,
  ends        time not null,
  days        text not null,                -- e.g. Mon-Sun
  rotating    boolean not null default false
);

create table holidays (
  day         date primary key,
  name        text not null
);

create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------- People ----------
create table staff (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users(id) on delete set null,
  emp_no        text unique,                -- UG016; null if not yet issued
  full_name     text not null,
  designation   designation not null,
  app_role      app_role not null default 'staff',
  shift_letter  text not null references shift_definitions(letter),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index staff_user_idx on staff(user_id);

-- Plant assignment over time. plant_id null = shared staff (works across both plants).
create table staff_assignments (
  staff_id    uuid not null references staff(id) on delete cascade,
  plant_id    text references plants(id),
  from_date   date not null,
  primary key (staff_id, from_date)
);

-- Server-only secrets. No row-level security policies, so the app can never read them.
create table staff_secrets (
  staff_id      uuid primary key references staff(id) on delete cascade,
  kiosk_pin_hash text,                      -- crypt(pin, gen_salt('bf'))
  pin_failures  integer not null default 0,
  locked_until  timestamptz
);

-- ---------- Rosters ----------
create table rosters (
  id            uuid primary key default gen_random_uuid(),
  plant_id      text not null references plants(id),
  month         date not null check (extract(day from month) = 1),
  status        roster_status not null default 'draft',
  prepared_by   uuid references staff(id),
  prepared_at   timestamptz not null default now(),
  submitted_at  timestamptz,
  approved_by   uuid references staff(id),
  approved_at   timestamptz,
  return_note   text,
  imported_from text,                       -- e.g. "November 2026 duty schedule (PDF)"
  unique (plant_id, month)
);

create table roster_cells (
  roster_id   uuid not null references rosters(id) on delete cascade,
  staff_id    uuid not null references staff(id),
  day         date not null,
  code        text not null check (code in ('D/P','N/P','N/W','D','O.T D/P','O.T N/P','OFF',
                                            'A/L','S/L','C/L','ML','U/L','')),
  source      text not null default 'rotation' check (source in ('rotation','manual','cover','leave','import')),
  updated_by  uuid references staff(id),
  updated_at  timestamptz not null default now(),
  primary key (roster_id, staff_id, day)
);
create index roster_cells_day_idx on roster_cells(day);

create table cover_assignments (
  id            uuid primary key default gen_random_uuid(),
  plant_id      text not null references plants(id),
  day           date not null,
  shift         shift_type not null,
  slot          cover_slot not null,
  for_staff_id  uuid references staff(id),   -- who is away; null if the gap was never staffed
  cover_staff_id uuid not null references staff(id),
  mode          text not null check (mode in ('extend','full')),  -- extend = PT II stays 17:00-19:00
  ot_minutes    integer not null default 0 check (ot_minutes >= 0),
  created_by    uuid references staff(id),
  created_at    timestamptz not null default now(),
  unique (plant_id, day, shift, slot)
);

-- ---------- Requests ----------
create table leave_requests (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff(id),
  type          leave_type not null,
  from_date     date not null,
  to_date       date not null check (to_date >= from_date),
  reason        text not null default '',
  status        request_status not null default 'pending',
  decided_by    uuid references staff(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create index leave_staff_idx on leave_requests(staff_id, from_date);

create table overtime_claims (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff(id),
  month         date not null check (extract(day from month) = 1),
  ot_hours      numeric(6,2) not null default 0 check (ot_hours >= 0),
  ph_hours      numeric(6,2) not null default 0 check (ph_hours >= 0),
  reason        text not null,
  status        request_status not null default 'pending',
  decided_by    uuid references staff(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create unique index overtime_one_per_month on overtime_claims(staff_id, month) where status <> 'cancelled';

-- ---------- Clock-in ----------
create table devices (                     -- registered control-room phones
  id            uuid primary key default gen_random_uuid(),
  plant_id      text not null references plants(id),
  label         text not null,              -- "Nyamwamba 1 control room"
  active        boolean not null default true,
  registered_by uuid references staff(id),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

create table device_secrets (              -- server-only
  device_id     uuid primary key references devices(id) on delete cascade,
  qr_secret     bytea not null,             -- HMAC key for the rotating QR code
  token_hash    text not null               -- sha256 of the kiosk's API token
);

create table passkeys (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references staff(id) on delete cascade,
  credential_id   text not null unique,     -- base64url
  public_key      bytea not null,
  sign_count      bigint not null default 0,
  transports      text[] not null default '{}',
  label           text not null default 'Phone',
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);

create table webauthn_challenges (         -- server-only
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff(id) on delete cascade,
  purpose       text not null check (purpose in ('register','clock')),
  challenge     text not null,
  expires_at    timestamptz not null,
  used_at       timestamptz
);

create table clock_events (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff(id),
  plant_id      text references plants(id),
  kind          clock_kind not null,
  at            timestamptz not null default now(),
  method        clock_method not null,
  kiosk_id      uuid references devices(id),
  passkey_id    uuid references passkeys(id),
  qr_window     bigint,                      -- the 30-second window the QR code was valid for
  lat           double precision,
  lng           double precision,
  accuracy_m    double precision,
  distance_m    double precision,            -- from the plant's boundary centre
  photo_path    text,                        -- clock-photos/<plant>/<yyyy-mm-dd>/<id>.jpg
  browser_id    text,                        -- random ID stored in the phone's browser
  flags         text[] not null default '{}',
  reviewed_by   uuid references staff(id),
  reviewed_at   timestamptz,
  review_note   text,
  created_by    uuid                         -- auth user who submitted it (null for kiosk)
);
create index clock_staff_at_idx on clock_events(staff_id, at desc);
create index clock_browser_idx  on clock_events(browser_id, at desc);
create index clock_flagged_idx  on clock_events(at desc) where cardinality(flags) > 0 and reviewed_at is null;

create table handovers (
  id              uuid primary key default gen_random_uuid(),
  plant_id        text not null references plants(id),
  shift_date      date not null,             -- the day the incoming shift starts
  shift           shift_type not null,       -- the incoming shift
  outgoing_head   uuid not null references staff(id),
  arrived         uuid[] not null,           -- who the outgoing head saw arrive
  confirmed_at    timestamptz not null default now(),
  note            text,
  unique (plant_id, shift_date, shift)
);

create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid,                          -- staff id, or null for the server
  action      text not null,
  entity      text not null,
  entity_id   text,
  details     jsonb not null default '{}'
);
create index audit_entity_idx on audit_log(entity, entity_id);
