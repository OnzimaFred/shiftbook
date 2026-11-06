-- Sign-in functions. Only the server (service_role) can call them.
-- Passwords are hashed with bcrypt (pgcrypto). Five wrong passwords lock the account for 15 minutes.

create or replace function auth.token_hash(p_token text) returns text
language sql immutable as $$ select encode(digest(p_token, 'sha256'), 'hex') $$;

-- Returns status 'ok' | 'wrong' | 'locked' | 'disabled', and a new session token when ok.
create or replace function auth.login(p_username text, p_password text, p_user_agent text, p_ip text, p_days integer default 30)
returns table(status text, user_id uuid, token text, must_change_password boolean)
language plpgsql security definer set search_path = auth, public as $$
#variable_conflict use_column
declare u auth.users; v_token text;
begin
  select * into u from auth.users where username = lower(trim(p_username)) for update;
  if u.id is null then
    perform crypt(p_password, gen_salt('bf', 10));          -- same work as a real check, so timing reveals nothing
    return query select 'wrong'::text, null::uuid, null::text, null::boolean; return;
  end if;
  if u.disabled then return query select 'disabled'::text, null::uuid, null::text, null::boolean; return; end if;
  if u.locked_until is not null and u.locked_until > now() then
    return query select 'locked'::text, null::uuid, null::text, null::boolean; return;
  end if;
  if crypt(p_password, u.password_hash) <> u.password_hash then
    update auth.users set failed_logins = failed_logins + 1,
      locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' end
    where id = u.id;
    return query select 'wrong'::text, null::uuid, null::text, null::boolean; return;
  end if;
  update auth.users set failed_logins = 0, locked_until = null where id = u.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into auth.sessions(token_hash, user_id, expires_at, user_agent, ip)
  values (auth.token_hash(v_token), u.id, now() + make_interval(days => p_days), left(p_user_agent, 200), left(p_ip, 64));
  delete from auth.sessions where user_id = u.id and expires_at < now();
  return query select 'ok'::text, u.id, v_token, u.must_change_password;
end $$;

-- The user behind a session cookie, or null. Extends the session as it's used.
create or replace function auth.session_user_id(p_token text)
returns table(user_id uuid, must_change_password boolean)
language plpgsql security definer set search_path = auth, public as $$
#variable_conflict use_column
declare s auth.sessions;
begin
  select * into s from auth.sessions where token_hash = auth.token_hash(p_token);
  if s.token_hash is null or s.expires_at < now() then return; end if;
  if exists (select 1 from auth.users where id = s.user_id and disabled) then return; end if;
  if s.last_seen_at < now() - interval '10 minutes' then
    update auth.sessions set last_seen_at = now(), expires_at = greatest(expires_at, now() + interval '30 days')
    where token_hash = s.token_hash;
  end if;
  return query select u.id, u.must_change_password from auth.users u where u.id = s.user_id;
end $$;

create or replace function auth.logout(p_token text) returns void
language sql security definer set search_path = auth, public as $$
  delete from auth.sessions where token_hash = auth.token_hash(p_token)
$$;

-- Staff choose their own password (at least 8 characters). Signs out their other devices.
create or replace function auth.change_password(p_user uuid, p_current text, p_new text, p_keep_token text)
returns text
language plpgsql security definer set search_path = auth, public as $$
declare u auth.users;
begin
  select * into u from auth.users where id = p_user for update;
  if u.id is null then return 'wrong'; end if;
  if crypt(p_current, u.password_hash) <> u.password_hash then return 'wrong'; end if;
  if length(p_new) < 8 then return 'too_short'; end if;
  if p_new = p_current then return 'same'; end if;
  update auth.users set password_hash = crypt(p_new, gen_salt('bf', 10)), must_change_password = false,
    password_changed_at = now(), failed_logins = 0, locked_until = null where id = p_user;
  delete from auth.sessions where user_id = p_user and token_hash <> auth.token_hash(p_keep_token);
  return 'ok';
end $$;

-- The Plant Manager creates a sign-in with a temporary password (changed at first sign-in).
create or replace function auth.create_user(p_username text, p_temp_password text) returns uuid
language plpgsql security definer set search_path = auth, public as $$
declare v_id uuid;
begin
  insert into auth.users(username, password_hash, must_change_password)
  values (lower(trim(p_username)), crypt(p_temp_password, gen_salt('bf', 10)), true)
  returning id into v_id;
  return v_id;
end $$;

create or replace function auth.reset_password(p_user uuid, p_temp_password text) returns void
language plpgsql security definer set search_path = auth, public as $$
begin
  update auth.users set password_hash = crypt(p_temp_password, gen_salt('bf', 10)), must_change_password = true,
    failed_logins = 0, locked_until = null where id = p_user;
  delete from auth.sessions where user_id = p_user;
end $$;

revoke all on function auth.login(text, text, text, text, integer), auth.session_user_id(text), auth.logout(text),
  auth.change_password(uuid, text, text, text), auth.create_user(text, text), auth.reset_password(uuid, text),
  auth.token_hash(text) from public;
grant execute on function auth.login(text, text, text, text, integer), auth.session_user_id(text), auth.logout(text),
  auth.change_password(uuid, text, text, text), auth.create_user(text, text), auth.reset_password(uuid, text) to service_role;
revoke all on auth.users, auth.sessions from public, authenticated;
