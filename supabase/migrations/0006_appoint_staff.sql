-- ═══════════════════════════════════════════════════════════════════════
--  Staff accounts, properly.  VERSION 1
--
--  ── What 0004 left undone ───────────────────────────────────────────
--
--  0004 can switch an account off and change a role, but it cannot *create* one. The
--  only creator was `create_first_user`, which succeeds only while no account exists --
--  so there was exactly one librarian in this school and no way to appoint a second.
--
--  ── Why passwords are not in this schema ────────────────────────────
--
--  Because they are not ours. They live in Supabase Auth's own tables, hashed, and this
--  schema has no business holding a second copy. `users` here is a *profile*: the same
--  uuid as the Auth user, carrying what the register needs -- a role, a status, a name.
--  That separation is why `current_user_id()` reads the JWT's `sub` and looks it up,
--  rather than a password column deciding anything.
--
--  So creating a librarian is two acts, not one:
--
--    1. Supabase Auth creates the credential. That is `auth.signUp`, from the browser.
--    2. This function creates the *profile*, so the account has a role and appears on
--       the staff list. It refuses without `users.write`.
--
--  Step 1 cannot be done from here without the service_role key, which is a secret that
--  must never ship in a browser bundle. That is a real constraint of a frontend-only
--  build, not an oversight, and it is why the first librarian is created through the
--  setup screen while later ones are created by an administrator signing the person up
--  and then restoring their own session.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════
--  set_up_library
-- ═════════════════════════════════════════════════════════════════════
--
--  Replaces `create_first_user`, which could not work.
--
--  It inserted a row into `users` without an id, so the table's
--  `default gen_random_uuid()` invented one. But `current_user_id()` returns the `sub`
--  from Supabase Auth's JWT, and `current_role_name()` looks up `users` by that id. So
--  the administrator it created had a profile the signed-in librarian could never be
--  matched against -- `can()` would have returned false for the head of the library,
--  every permission in the permissions table included, and the application would have
--  looked like it had no permissions at all.
--
--  Nothing about that is visible at the moment of creation: the account is made, the
--  message says so, and it only fails later when somebody presses a button. It was
--  found by reading what the id in the JWT is compared against, not by testing the
--  setup screen.
--
--  So the id is now supplied. It is the Auth account's own uuid, the two rows agree, and
--  every permission resolves.
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
  -- cannot be used a second time to appoint somebody else.
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

  -- No password parameter, and there is not one to accept. Credentials are Supabase
  -- Auth's; this schema has no password column and must not grow one.
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

-- ═════════════════════════════════════════════════════════════════════
--  create_user_account
-- ═════════════════════════════════════════════════════════════════════

-- Appoint a librarian: the profile row for an Auth account that now exists.
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

  -- The email is stored lower-cased, because Supabase Auth lower-cases it and a profile
  -- that disagrees with its own credential is a profile nobody can match up.
  v_role := coalesce(p_role, 'assistant'::role);

  -- An account that already has a profile. Refused rather than updated: re-running this
  -- would silently change somebody's role, and a role change should be a deliberate act
  -- with its own audit entry.
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
  'Creates the profile for an Auth account that exists. Refuses without users.write; the password is Auth''s business, not this schema''s.';

-- Closed to PUBLIC like everything else. 0005 explains why revoking from `anon` does not
-- work here: CREATE FUNCTION grants EXECUTE to PUBLIC, so PUBLIC is the only target that
-- removes anything.
revoke execute on all functions in schema public from public;
grant execute on function has_any_accounts() to anon, authenticated;
grant execute on function set_up_library(uuid, text, text) to anon, authenticated;

grant execute on function create_user_account(uuid, text, text, role) to authenticated;

-- ═════════════════════════════════════════════════════════════════════
--  retire create_first_user
-- ═════════════════════════════════════════════════════════════════════
--
-- It cannot be replaced -- Postgres fixes a function's argument types at creation, so
-- set_up_library had to be a new name rather than a new signature. The old one stays in
-- the schema, and leaving it callable would leave a second door to an administrator:
-- anybody could call it, it would create a profile whose id matches no session, and the
-- account would be real but powerless. Better that it is unreachable than that it works.
revoke execute on function create_first_user(text, text, text) from public;

commit;