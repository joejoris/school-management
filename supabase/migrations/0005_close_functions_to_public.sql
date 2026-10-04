-- ═══════════════════════════════════════════════════════════════════════
--  Close the functions to PUBLIC.  VERSION 1
--
--  ── Why this file exists ────────────────────────────────────────────
--
--  Measured, signed out, with only the public anon key, after 0004:
--
--    set_user_status     -> 200 {"ok":false,"code":"forbidden", ...}
--    set_user_role       -> 200 {"ok":false,"code":"forbidden", ...}
--    active_admin_count  -> 200 0
--
--  All three REACHABLE. Nothing there is protected by privileges -- they are protected
--  by the `can('users.write')` on their first line, which is the only reason a stranger
--  cannot use them.
--
--  ── The mistake ─────────────────────────────────────────────────────
--
--  0003 and 0004 both say
--
--    revoke all on function ... from anon;
--
--  and that revokes nothing. `CREATE FUNCTION` grants EXECUTE to **PUBLIC**, and every
--  role is a member of PUBLIC. Revoking from `anon` removes a grant to `anon` directly;
--  the privilege keeps arriving by the other route. It is like closing a door on a
--  corridor everybody already has a key to.
--
--  The only correct target is `public`:
--
--    revoke execute on all functions in schema public from public;
--
--  This applies to every function in the schema, including the nine circulation ones,
--  which were equally reachable and equally only self-defending.
--
--  ── Why it was not noticed ──────────────────────────────────────────
--
--  Because "200 with a refusal in it" reads as safe. It is not the same as being
--  refused, and the difference only shows if you check the status code rather than the
--  body. A librarian's account being switched off was never at risk; what was lost is
--  the second lock on the door.
--
--  ── What is re-opened afterwards, and only these two ────────────────
--
--  The sign-in screen has to ask whether accounts exist before anybody has signed in.
--  That is `has_any_accounts()`. The setup path needs `create_first_user()`.
--
--  Everything else stays shut until a signed-in `authenticated` account calls it, which
--  the grants in 0003 already allow.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- The blanket revoke. `public`, not `anon`.
revoke execute on all functions in schema public from public;

-- Re-open exactly two, for the two moments before anybody has signed in.
grant execute on function has_any_accounts() to anon, authenticated;
grant execute on function create_first_user(text, text, text) to anon, authenticated;

-- And say so, so the next person does not "fix" it by revoking from anon again.
comment on function current_user_id() is
  'The signed-in user''s id, or null. Note: functions here are closed to PUBLIC, not to anon -- see 0005.';
comment on function can(text) is
  'Whether the caller''s role includes this permission. anonymous holds nothing, deliberately.';

commit;