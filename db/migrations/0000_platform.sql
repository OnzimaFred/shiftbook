-- Shiftbook platform: database roles and the sign-in schema.
-- Runs first, as the database owner (the migration runner).
--
-- How requests reach the data:
--   The API connects as `shiftbook_api`, which can switch into two roles per transaction:
--     authenticated  a signed-in staff member; row-level security decides what they see
--     service_role   the server itself (clock-in checks, kiosk, sign-in); bypasses row-level security
--   For a staff request the API runs:  SET LOCAL ROLE authenticated; set_config('app.user_id', <id>, true)

create extension if not exists pgcrypto;

do $$ begin
  if not exists (select from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
  if not exists (select from pg_roles where rolname = 'shiftbook_api') then create role shiftbook_api login noinherit; end if;
end $$;
do $$ begin   -- the runner sets shiftbook_api's password from API_DB_PASSWORD
  if not pg_has_role('shiftbook_api', 'authenticated', 'member') then grant authenticated to shiftbook_api; end if;
  if not pg_has_role('shiftbook_api', 'service_role', 'member') then grant service_role to shiftbook_api; end if;
end $$;

-- Tables in public are reachable by the request roles; row-level security decides the rows.
grant usage on schema public to authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

-- ---------- Sign-in ----------
create schema if not exists auth;
revoke all on schema auth from public;
grant usage on schema auth to authenticated, service_role;

create table auth.users (
  id                   uuid primary key default gen_random_uuid(),
  username             text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,30}$'),
  password_hash        text not null,
  must_change_password boolean not null default true,
  failed_logins        integer not null default 0,
  locked_until         timestamptz,
  disabled             boolean not null default false,
  password_changed_at  timestamptz,
  created_at           timestamptz not null default now()
);

create table auth.sessions (
  token_hash   text primary key,               -- sha256 of the cookie value; the raw token is never stored
  user_id      uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent   text,
  ip           text
);
create index sessions_user_idx on auth.sessions(user_id);

-- The signed-in user for this transaction (set by the API), or null for the server itself.
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
grant execute on function auth.uid() to authenticated, service_role;
