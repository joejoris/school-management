-- ═══════════════════════════════════════════════════════════════════════
--  RUN THIS. It is the last SQL step.
-- ═══════════════════════════════════════════════════════════════════════
--
--  The sign-in screen is failing with "That record could not be found." That sentence
--  was wrong -- the record is not missing, a *function* is. `set_up_library` has never
--  been applied to your database, so calling it returns 404 PGRST202, and the client
--  reported that as a missing record.
--
--  Two things are outstanding, and this file does both. They have to be one paste
--  because neither is useful alone.
--
--  ── 1. The account a probe of mine created ───────────────────────────
--
--  When testing that anon could not reach the functions, a probe called
--  create_first_user with test values and it *succeeded*, creating an administrator.
--  That was careless of me: I should have called something guaranteed to refuse.
--
--  It matters because set_up_library refuses while any account exists. Until that row is
--  gone, the school cannot create its first librarian.
--
--  ── 2. set_up_library and create_user_account ────────────────────────
--
--  0006. Without set_up_library there is no way to create the first account at all.
--
--  ── What should happen ───────────────────────────────────────────────
--
--  The SELECT part-way through prints accounts_remaining. It must read 0.
--
--  After that, reload the app. It will offer to set the library up, and that will work.

begin;

-- ── part 1 ────────────────────────────────────────────────────────────
delete from users where id = '27dd76a6-0b9f-40c9-a6bf-5bee2482ec41';

select count(*) as accounts_remaining from users;

-- ── part 2 ────────────────────────────────────────────────────────────
create or replace function set_up_library(p_user_id uuid, p_email text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- One library, one first librarian. While any account exists this refuses, so it
  -- cannot be run twice to appoint somebody else.
  if exists (select 1 from users) then
    return jsonb_build_object('ok', false, 'code', 'already_set_up',
      'message', 'This library already has an account. Sign in instead.');
  end if;

  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'Set-up did not return an account. Try again.');
  end if;

  if coalesce(btrim(p_name), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'An account needs a name.');
  end if;

  if coalesce(btrim(p_email), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'An account needs an email address.');
  end if;

  -- No password parameter, and there is not one to accept. Credentials belong to
  -- Supabase Auth; this schema has no password column and must not grow one.
  --
  -- The id is the point of this function. current_user_id() returns the `sub` from
  -- Auth's JWT and current_role_name() looks `users` up by it, so the profile must carry
  -- Auth's own uuid. An earlier version inserted no id, let the table invent one, and
  -- produced an administrator whose profile could never be matched: can() false for
  -- every role, so the app would have looked like it had no permissions at all.
  insert into users (id, email, name, role, status)
  values (p_user_id, lower(btrim(p_email)), btrim(p_name), 'admin', 'active')
  returning id into v_id;

  insert into audit (actor, action, entity, entity_id, after)
  values (p_user_id, 'set_up_library', 'user', v_id,
          jsonb_build_object('email', lower(btrim(p_email)), 'name', btrim(p_name), 'role', 'admin'));

  return jsonb_build_object('ok', true, 'id', v_id, 'role', 'admin');
end
$$;

comment on function set_up_library(uuid, text, text) is
  'Creates the one administrator, and only while none exists. Takes the Auth account''s own uuid, which is what current_user_id() compares against.';

-- Appoint a librarian: the profile for an Auth account that already exists.
create or replace function create_user_account(
  p_user_id uuid,
  p_email    text,
  p_name     text,
  p_role     role
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid;
  v_role role;
begin
  if not can('users.write') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot appoint staff.');
  end if;

  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found',
      'message', 'That account has no credentials yet.');
  end if;

  if coalesce(btrim(p_name), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'An account needs a name. It is what appears on the audit log.');
  end if;

  if coalesce(btrim(p_email), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'An account needs an email address.');
  end if;

  v_role := coalesce(p_role, 'assistant'::role);

  -- An account that already has a profile. Refused rather than updated: re-running this
  -- would silently change somebody's role, and a role change should be its own act with
  -- its own audit entry.
  if exists (select 1 from users where id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'already_exists',
      'message', 'That account already has a profile. Change its role instead.');
  end if;

  insert into users (id, email, name, role, status)
  values (p_user_id, lower(btrim(p_email)), btrim(p_name), v_role, 'active')
  returning id into v_id;

  insert into audit (actor, action, entity, entity_id, after)
  values (current_user_id(), 'create_user', 'user', v_id,
          jsonb_build_object('email', lower(btrim(p_email)), 'name', btrim(p_name), 'role', v_role));

  return jsonb_build_object('ok', true, 'id', v_id, 'role', v_role);
end
$$;

comment on function create_user_account(uuid, text, text, role) is
  'Creates the profile for an Auth account that exists. Refuses without users.write.';

-- ── permissions ────────────────────────────────────────────────────────
--
-- `revoke ... from public`, not `from anon`. CREATE FUNCTION grants EXECUTE to PUBLIC
-- and every role is a member of PUBLIC, so revoking from anon removes nothing and the
-- function stays reachable by the public anon key. That was a real fault here once.
revoke execute on all functions in schema public from public;

grant execute on function has_any_accounts() to anon, authenticated;
grant execute on function set_up_library(uuid, text, text) to anon, authenticated;
grant execute on function create_user_account(uuid, text, text, role) to authenticated;

-- create_first_user cannot be replaced -- Postgres fixes a function's argument types at
-- creation -- so it still exists. Leaving it callable would leave a second door to an
-- administrator: anybody could call it and create a profile whose id matches no session.
-- Better unreachable than powerless.
revoke execute on function create_first_user(text, text, text) from public;

commit;