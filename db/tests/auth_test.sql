-- Sign-in tests. Run after rls_test.sql (uses its helper t()).
\set QUIET on
set client_min_messages = notice;
create or replace function t(ok boolean, name text) returns void language plpgsql as
$$ begin raise notice '%: %', case when ok then 'PASS' else 'FAIL' end, name; end $$;
create or replace function refused(stmt text) returns boolean language plpgsql as $$
declare n int;
begin execute stmt; get diagnostics n = row_count; return n = 0;
exception when others then return true; end $$;
grant execute on function t(boolean, text), refused(text) to authenticated, service_role;

set role service_role;
select auth.create_user('Moses.Masereka', 'river-stone-4821') as moses_id \gset
reset role; select t((select username from auth.users where id = :'moses_id') = 'moses.masereka', 'sign-in: usernames are stored in lower case'); set role service_role;
reset role; select t((select password_hash not like '%river%' from auth.users where id = :'moses_id'), 'sign-in: password stored only as a hash'); set role service_role;

select status as s1, token as tok, must_change_password as mc from auth.login('moses.masereka', 'river-stone-4821', 'test', '127.0.0.1') \gset
select t(:'s1' = 'ok' and length(:'tok') = 64, 'sign-in: right password gives a session');
select t(:'mc'::boolean, 'sign-in: a temporary password must be changed');
reset role; select t((select count(*) from auth.sessions where token_hash = :'tok') = 0, 'sign-in: the raw session token is never stored'); set role service_role;
select t((select user_id from auth.session_user_id(:'tok')) = :'moses_id', 'sign-in: the session cookie resolves to the user');
select t((select count(*) from auth.session_user_id('not-a-token')) = 0, 'sign-in: a made-up token resolves to nobody');

select t((select status from auth.login('moses.masereka', 'wrong-one', 'test', '127.0.0.1')) = 'wrong', 'sign-in: wrong password refused');
select t((select status from auth.login('nobody.here', 'whatever', 'test', '127.0.0.1')) = 'wrong', 'sign-in: unknown username gets the same answer');
select auth.login('moses.masereka', 'wrong-one', 'test', '127.0.0.1') from generate_series(1, 4);
select t((select status from auth.login('moses.masereka', 'river-stone-4821', 'test', '127.0.0.1')) = 'locked', 'sign-in: five wrong passwords lock the account');
reset role; update auth.users set locked_until = null, failed_logins = 0 where id = :'moses_id'; set role service_role;

select t(auth.change_password(:'moses_id', 'wrong', 'new-password-1', :'tok') = 'wrong', 'password: current password must be right');
select t(auth.change_password(:'moses_id', 'river-stone-4821', 'short', :'tok') = 'too_short', 'password: at least 8 characters');
select status as s2, token as tok2 from auth.login('moses.masereka', 'river-stone-4821', 'phone 2', '127.0.0.1') \gset
select t(auth.change_password(:'moses_id', 'river-stone-4821', 'kasese-2026!', :'tok') = 'ok', 'password: staff choose their own');
select t((select count(*) from auth.session_user_id(:'tok')) = 1, 'password: the device that changed it stays signed in');
select t((select count(*) from auth.session_user_id(:'tok2')) = 0, 'password: other devices are signed out');
reset role; select t(not (select must_change_password from auth.users where id = :'moses_id'), 'password: no longer temporary'); set role service_role;

select auth.reset_password(:'moses_id', 'falls-rain-0042');
select t((select count(*) from auth.session_user_id(:'tok')) = 0, 'reset: signs the person out everywhere');
select t((select status from auth.login('moses.masereka', 'falls-rain-0042', 'test', '127.0.0.1')) = 'ok', 'reset: the new temporary password works');
reset role;

set role authenticated;
select set_config('app.user_id', :'moses_id', false);
select t(refused($$select * from auth.users$$), 'sign-in: staff cannot read accounts or password hashes');
select t(refused($$select * from auth.sessions$$), 'sign-in: staff cannot read sessions');
select t(refused($$select * from auth.login('moses.masereka', 'x', 'x', 'x')$$), 'sign-in: staff cannot call the sign-in functions directly');
reset role;
