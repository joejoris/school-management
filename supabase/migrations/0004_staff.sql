-- ═══════════════════════════════════════════════════════════════════════
--  Staff accounts.  VERSION 1
--
--  Two rules that cannot be expressed as a policy, which is why they are functions.
--
--  A policy can say "an administrator may update users". It cannot say "an
--  administrator may update users, except not themselves, and except not the last
--  working account" — and those two exceptions are the whole point. Getting either
--  wrong lets the last administrator switch themselves off, after which nobody can
--  sign in and manage accounts and the only recovery is a database edit.
--
--  So the check is here, in the same transaction as the change, where it cannot be
--  bypassed by calling the REST endpoint directly.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- How many administrators could still sign in. Counted from the table rather than
-- from the session, because the question is what happens once this one is gone.
create or replace function active_admin_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from users where role = 'admin' and status = 'active'
$$;

create or replace function set_user_status(p_user_id uuid, p_status user_status)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user users%rowtype;
begin
  if not can('users.write') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot manage accounts.');
  end if;

  select * into v_user from users where id = p_user_id;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found',
      'message', 'That account does not exist.');
  end if;

  -- On your own account. Refused rather than explained afterwards: the outcome of
  -- allowing it is unrecoverable.
  if v_user.id = current_user_id() then
    return jsonb_build_object('ok', false, 'code', 'self',
      'message', 'You cannot switch off your own account.');
  end if;

  -- The last working administrator. Asked about *this* account and not about the
  -- general count: an earlier version of this checked whether any administrator
  -- remained, which — because the first account is always an administrator and is
  -- often the only one — refused to disable anybody at all.
  if p_status = 'disabled'
     and v_user.role = 'admin'
     and active_admin_count() <= 1
  then
    return jsonb_build_object('ok', false, 'code', 'last_admin',
      'message', 'This is the last working account. You cannot switch it off.');
  end if;

  update users set status = p_status where id = p_user_id;

  insert into audit (actor, action, entity, entity_id, before, after)
  values (current_user_id(), 'set_user_status', 'user', p_user_id,
          jsonb_build_object('status', v_user.status),
          jsonb_build_object('status', p_status));

  return jsonb_build_object('ok', true, 'id', p_user_id, 'status', p_status);
end
$$;

create or replace function set_user_role(p_user_id uuid, p_role role)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user users%rowtype;
begin
  if not can('users.write') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot manage accounts.');
  end if;

  select * into v_user from users where id = p_user_id;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found',
      'message', 'That account does not exist.');
  end if;

  if v_user.id = current_user_id() then
    return jsonb_build_object('ok', false, 'code', 'self',
      'message', 'You cannot change your own role.');
  end if;

  if v_user.role = 'admin' and p_role <> 'admin' and active_admin_count() <= 1 then
    return jsonb_build_object('ok', false, 'code', 'last_admin',
      'message', 'This is the last working account. You cannot change its role.');
  end if;

  update users set role = p_role where id = p_user_id;

  insert into audit (actor, action, entity, entity_id, before, after)
  values (current_user_id(), 'set_user_role', 'user', p_user_id,
          jsonb_build_object('role', v_user.role), jsonb_build_object('role', p_role));

  return jsonb_build_object('ok', true, 'id', p_user_id, 'role', p_role);
end
$$;

grant execute on function active_admin_count() to authenticated;
grant execute on function set_user_status(uuid, user_status) to authenticated;
grant execute on function set_user_role(uuid, role) to authenticated;

-- And take it away from anon again, which looks redundant and is not.
--
-- 0003 revokes every routine in this schema from anon. It cannot revoke what does not
-- exist yet, and these three functions are created *after* that line -- so without
-- this they inherit Postgres's default of EXECUTE granted to PUBLIC, and PUBLIC
-- includes anon. The grants above narrow nothing on their own: a grant adds to whatever
-- is already permitted rather than replacing it.
--
-- Each of the three starts with can('users.write'), which is false for anonymous, so a
-- call would be refused on its first line. That is defence in depth rather than an open
-- door, and defence in depth is the point: the rule should still hold if somebody later
-- edits the check out of one of them.
--
-- Written as three explicit revokes rather than a blanket one because 0003's blanket
-- revoke already runs and a second `in schema public` revoke here would have nothing
-- left to remove. Any migration added *after* this one must repeat this step, and that
-- is the part worth remembering: Postgres gives every new function to PUBLIC.
revoke all on function active_admin_count() from anon;
revoke all on function set_user_status(uuid, user_status) from anon;
revoke all on function set_user_role(uuid, role) from anon;

-- The policies below are for the *row*, not for the rule: they let an administrator
-- reach these rows at all. The decision about whether a particular change is
-- allowed happens inside the functions above.
revoke update on users from authenticated;
grant update (status, role) on users to authenticated;

commit;
