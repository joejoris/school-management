-- ═══════════════════════════════════════════════════════════════════════
--  0011: close create_user_account to the public anon key.
-- ═══════════════════════════════════════════════════════════════════════
--
--  create_user_account appoints staff. It is granted to `authenticated` and
--  refuses anybody without users.write, so an anon caller receives a sentence
--  rather than an effect. The sentence is not the point: the function should
--  not be reachable with the public anon key at all, and on the live project
--  it was. verify-live's security group caught it:
--
--    ✗ create_user_account is unreachable
--        got 200 — {"ok":false,"code":"forbidden",...}
--
--  Every other function answers that probe with a 401. This one did not,
--  which means anon held EXECUTE.
--
--  ── Why it slipped through ────────────────────────────────────────────
--
--  create_user_account lives in 0006. Every other function added after the
--  blanket revoke carries its own `revoke ... from anon` by name; this one
--  relied on 0006's `revoke execute on all functions ... from public`. That
--  blanket revoke is the right one, and on the live database it did not take
--  for this function — the schema was carrying a direct anon grant from an
--  earlier apply.
--
--  It also slipped past tools/check-sql.mjs because that tool reads a fixed
--  list of migration files and 0006 is not on it. So neither the database nor
--  the check had this function in hand. The file is added to the list now.
--
--  ── What this does ────────────────────────────────────────────────────
--
--  Revokes by name from PUBLIC *and* from anon, so it is closed whichever
--  route the grant arrived by, and leaves the `authenticated` grant that the
--  appointments screen needs.
begin;

-- From PUBLIC: the route that matters, because CREATE FUNCTION grants EXECUTE
-- to PUBLIC and every role is a member of PUBLIC.
revoke all on function create_user_account(uuid, text, text, role) from public;

-- From anon directly, in case an earlier apply left that grant behind. A
-- revoke from PUBLIC removes nothing that was granted to anon by name.
revoke all on function create_user_account(uuid, text, text, role) from anon;

-- The appointments screen signs in, so `authenticated` keeps the door.
grant execute on function create_user_account(uuid, text, text, role) to authenticated;

-- PostgREST caches function privileges. Without this the revocation is not
-- seen until the schema cache next reloads, and the probe would keep passing.
notify pgrst, 'reload schema';

commit;