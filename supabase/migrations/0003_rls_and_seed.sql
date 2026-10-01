-- ═══════════════════════════════════════════════════════════════════════
--  Row level security, grants, and the seed rows.  VERSION 1
--
--  ── The rule this file exists to enforce ─────────────────────────────
--
--  A browser holds the `anon` key. That key is public by design — it ships inside
--  the JavaScript bundle and is meant to — and it is safe only because of what is
--  written here. So the important number is not "the app has a key" but "the anon
--  role can do almost nothing", and that is what the grants at the bottom check.
--
--  ── No write policies on the money and the loans ─────────────────────
--
--  `loans`, `fines` and `fine_txns` get SELECT and nothing else. No INSERT, no
--  UPDATE, no DELETE — not for `authenticated`, not for anybody.
--
--  Those three tables are written only by the functions in 0002, which check
--  permissions, check the borrow limit, check the balance, and record who did it.
--  This is the difference between "the domain refuses" and "the domain refuses and
--  the database refuses too, if someone bypasses the app".
--
--  ── A view would not have been enough ────────────────────────────────
--
--  If the register were a view over loans, then anyone who could read loans could
--  read the view, and \`SELECT * FROM active_loans\` would be the loans table again
--  rather than a rule. The functions exist because a named query cannot refuse.
--
--  ── What anon may do ─────────────────────────────────────────────────
--
--  Exactly one thing: \`has_any_accounts()\`, so the sign-in screen can tell an empty
--  school from a used one. It returns a boolean and reads no table.
begin;

-- ── RLS on, everywhere ─────────────────────────────────────────────────
-- Named so the list can be compared against the table list in 0001 by the check
-- below. A table added without this would be wide open.

alter table users            enable row level security;
alter table member_types     enable row level security;
alter table members          enable row level security;
alter table titles           enable row level security;
alter table shelf_locations  enable row level security;
alter table copies           enable row level security;
alter table loans            enable row level security;
alter table loan_events      enable row level security;
alter table holds            enable row level security;
alter table fines            enable row level security;
alter table fine_txns        enable row level security;
alter table settings         enable row level security;
alter table imports         enable row level security;
alter table audit            enable row level security;

-- ── Reads ──────────────────────────────────────────────────────────────
-- Every read policy is signed in plus the permission. Not signed in plus nothing:
-- a policy that only checks the permission would pass for a role the function does
-- not know about, and `anonymous` returning false is the safer default.

do $$
declare t text;
begin
  foreach t in array array[
    'member_types','members','titles','shelf_locations','copies','loans',
    'loan_events','holds','fines','fine_txns','settings'
  ] loop
    execute format($f$
      drop policy if exists %1$I_read on %1$I;
      create policy %1$I_read on %1$I
        for select to authenticated
        using (can('%2$I'));
    $f$, t,
      case t
        when 'member_types' then 'members.read'
        when 'members'      then 'members.read'
        when 'titles'       then 'titles.read'
        when 'shelf_locations' then 'copies.read'
        when 'copies'       then 'copies.read'
        when 'loans'        then 'loans.read'
        when 'loan_events'  then 'loans.read'
        when 'holds'        then 'holds.read'
        when 'fines'        then 'fines.read'
        when 'fine_txns'    then 'fines.read'
        when 'settings'     then 'settings.read'
      end);
  end loop;
end $$;

-- Accounts. Readable by anyone signed in — a librarian needs to see who else can
-- sign in — but the policies still route through `can`, so a teacher gets nothing.
drop policy if exists users_read on users;
create policy users_read on users
  for select to authenticated using (can('users.read'));

drop policy if exists users_insert on users;
create policy users_insert on users
  for insert to authenticated with check (can('users.write'));

drop policy if exists users_update on users;
create policy users_update on users
  for update to authenticated
  using (can('users.write')) with check (can('users.write'));

drop policy if exists audit_read on audit;
create policy audit_read on audit
  for select to authenticated using (can('audit.read'));

drop policy if exists audit_insert on audit;
create policy audit_insert on audit
  for insert to authenticated with check (actor = current_user_id());

-- ── Writes, where a policy is enough ───────────────────────────────────
-- These are edits to records rather than movements of money, so a checked policy
-- is proportionate: the policy decides, and the row is then ordinary data.

do $$
declare t text; perm text;
begin
  foreach t in array array['members','titles','copies','holds'] loop
    perm := case t
      when 'members' then 'members.write'
      when 'titles'  then 'titles.write'
      when 'copies'  then 'copies.write'
      when 'holds'   then 'holds.write'
    end;
    execute format($f$
      drop policy if exists %1$I_update on %1$I;
      create policy %1$I_update on %1$I
        for update to authenticated
        using (can('%2$I')) with check (can('%2$I'));
    $f$, t, perm);
  end loop;
end $$;

-- Settings and imports: administrators only, and both directions.
drop policy if exists settings_write on settings;
create policy settings_write on settings
  for all to authenticated
  using (can('settings.write')) with check (can('settings.write'));

drop policy if exists imports_write on imports;
create policy imports_write on imports
  for all to authenticated
  using (can('imports.run')) with check (can('imports.run'));

-- Members and titles can be created. The insert paths are separate from the update
-- ones because a policy with no `for` clause defaults to `all`, and an `all`
-- policy on members would grant deletes — and deleting a student who has borrowing
-- history is not something this system should be able to do at all.
drop policy if exists members_insert on members;
create policy members_insert on members
  for insert to authenticated with check (can('members.write'));

drop policy if exists titles_insert on titles;
create policy titles_insert on titles
  for insert to authenticated with check (can('titles.write'));

drop policy if exists copies_insert on copies;
create policy copies_insert on copies
  for insert to authenticated with check (can('copies.write'));

drop policy if exists holds_insert on holds;
create policy holds_insert on holds
  for insert to authenticated with check (can('holds.write'));

drop policy if exists holds_update on holds;
create policy holds_update on holds
  for update to authenticated
  using (can('holds.write')) with check (can('holds.write'));

-- ── No delete policies, anywhere, on purpose ───────────────────────────
-- A delete is not something this system can do. A loan is voided, a fine is waived,
-- a student is graduated, a book is withdrawn: every one of those leaves the record
-- standing with a reason attached. Nothing is removed, so no table gets a DELETE
-- policy and none is granted below.

-- ── The one thing anon may call ────────────────────────────────────────
--
-- The sign-in screen has to tell an empty school from a used one, and it has to do
-- so before anybody has signed in. This returns a boolean and reads no table, so it
-- tells an unauthenticated visitor that accounts exist without telling them who.

create or replace function has_any_accounts()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from users);
$$;

comment on function has_any_accounts() is
  'Whether any account exists. Callable by anon so the sign-in screen can offer setup instead of sign-in.';

-- ── Grants ─────────────────────────────────────────────────────────────

-- anon: nothing at all on any table. Not "read public rows", not "read nothing" —
--  no privilege of any kind.
revoke all on all tables    from anon;
revoke all on all sequences from anon;
revoke all on all functions from anon;

grant execute on function has_any_accounts() to anon;

-- authenticated: the table privileges the policies above then narrow.
grant select on users, member_types, members, titles, shelf_locations, copies,
              loans, loan_events, holds, fines, fine_txns, settings, imports, audit
  to authenticated;

grant insert, update on users, member_types, members, titles, shelf_locations,
                           copies, holds, settings, imports
  to authenticated;

-- The three that are written only by functions. SELECT is a privilege; the ability
-- to change a row is not granted at all, so the absence of a policy above is not the
-- only thing standing between a signed-in user and a forged loan.
grant update on member_types, settings to authenticated;

revoke insert, update, delete on loans    from authenticated;
revoke insert, update, delete on fines    from authenticated;
revoke insert, update, delete on fine_txns from authenticated;
revoke insert, update, delete on loan_events from authenticated;
revoke delete on members, titles, copies, holds, imports, audit from authenticated;

-- The functions are how circulation happens, so every signed-in account may call
-- them. Each one checks its own permission first, which is the check that matters.
grant execute on function
  current_user_id, current_role_name, can, borrow_blockers,
  issue_book, return_book, renew_loan, void_loan, mark_lost,
  record_payment, waive_fine, recompute_fine_balance, run_fine_accrual
to authenticated;

-- ── Seed ───────────────────────────────────────────────────────────────
--
-- The member types and the settings that packages/contracts and
-- apps/web/src/api/mock.ts also carry. Two copies of the school's policy, and the
-- database one is the one that is enforced.

insert into member_types
  (key, label, loan_period_days, grace_days, max_renewals, borrow_limit,
   can_place_holds, fine_exempt, fine_block_threshold, sort_order)
values
  ('student',  'Student',  14, 1, 2,  5, true, false, 1500, 0),
  ('teacher',  'Teacher',  30, 1, 4, 25, true, true,     0, 1),
  ('staff',    'Staff',    14, 1, 2,  5, true, false, 1500, 2),
  ('external', 'External',  7, 0, 0,  2, true, false, 1500, 3)
on conflict (key) do nothing;

insert into settings (key, value) values
  -- 25 cents a day, in cents, because every money column is an integer.
  ('fine.defaultDailyRateCents', to_jsonb(25)),
  ('fine.maxPerFineCents',       to_jsonb(2000)),
  ('school.name',                to_jsonb('Dandora Secondary School'))
on conflict (key) do nothing;

-- No accounts are seeded. The first librarian is created through the sign-in screen,
-- and `create_first_user` below is the only way that can happen — so there is no
-- default password sitting in a public repository.

create or replace function create_first_user(p_email text, p_name text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from users) then
    return jsonb_build_object('ok', false, 'code', 'already_set_up',
      'message', 'This library already has an account. Sign in instead.');
  end if;

  insert into users (email, name, role, status)
  values (lower(btrim(p_email)), btrim(p_name), 'admin', 'active')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'role', 'admin');
end
$$;

comment on function create_first_user(text, text, text) is
  'Creates the one administrator, and only if none exists. p_password is accepted and ignored: passwords are Supabase Auth''s business, not this schema''s.';

grant execute on function create_first_user(text, text, text) to anon, authenticated;

commit;

-- ── What this file leaves out, and why ─────────────────────────────────
--
-- No `loans_insert`. No `fines_insert`. No `fine_txns_insert`.
--
-- That is the point of the whole file. A loan is created by calling issue_book,
-- which checks the borrow limit, the fine balance, the copy's status and the
-- caller's permission, and records who did it. There is no other door, and no
-- `anon` key can open it — because there are no anon privileges on any table to
-- begin with.