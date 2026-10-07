# Connecting the frontend to Supabase

Read this file as "here is what to try", not "here is what works". `npm run check`
reads the SQL and confirms the two halves agree — every refusal code, every
grant, every table — but it does not run any of it. What needs a live database
is listed at the bottom.

Eleven files, run in order, in the Supabase dashboard's **SQL Editor**:

| | |
|---|---|
| `migrations/0001_library_schema.sql` | 14 tables, indexes, the permission function |
| `migrations/0002_circulation.sql` | issuing, returning, renewing, voiding, fines, the accrual |
| `migrations/0003_rls_and_seed.sql` | row level security, grants, the seed rows |
| `migrations/0004_staff.sql` | switching an account off, changing a role |
| `migrations/0005_close_functions_to_public.sql` | close every function to `public`, then reopen two |
| `migrations/0006_appoint_staff.sql` | appointing a second librarian |
| `migrations/0007_hold_expiry.sql` | intraday hold expiry and queue rotation |
| `migrations/0008_dashboard.sql` | the library at a glance |
| `migrations/0009_assess_fine.sql` | assessing a fine by hand |
| `migrations/0010_reports.sql` | the library's numbers as CSV |
| `migrations/0011_close_create_user_account.sql` | close `create_user_account` to the anon key |

Run them one at a time. A typo in any statement fails that whole file, and running
them in one go means you cannot tell which.

---

## 1. Create the project

Supabase → **New project**. Give it a database password and keep it — you will need
it for the CLI or for a SQL session, and Supabase will not show it again.

## 2. Run the four migrations

Paste each file into the SQL Editor and press **Run**. Each is wrapped in a
transaction, so a failure leaves nothing half-applied.

Each is written to be safe to run twice (`IF NOT EXISTS`, `CREATE OR REPLACE`), so
re-running one that already succeeded is harmless. Running a *failed* one again is
not, which is why running them one at a time matters.

## 3. Check that anon can do almost nothing

This is the single most important check, and it is the one most worth doing by hand.
The `anon` key ships inside the JavaScript bundle — that is expected and safe — so
the only thing standing between the public internet and the register is the grants in
0003.

Open a **new private window** so you are not sending your own session, and run this in
the browser console with your project's URL and anon key:

```js
const url = 'https://YOUR-PROJECT.supabase.co'
const key = 'YOUR-ANON-KEY'

const ask = async (path, init) => {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  return `${r.status}  ${(await r.text()).slice(0, 90)}`
}

console.log('accounts exist :', await ask('rpc/has_any_accounts'))   // expect 200 and true/false
console.log('read loans     :', await ask('loans?select=*'))           // expect 401 or 403
console.log('read members   :', await ask('members?select=*'))         // expect 401 or 403
console.log('write a loan   :', await ask('loans', { method: 'POST', body: '{}' }))  // expect 401 or 403
console.log('write a fine   :', await ask('fine_txns', { method: 'POST', body: '{}' })) // expect 401 or 403
console.log('sign a user in :', await ask('rpc/issue_book', { method: 'POST', body: '{}' })) // expect 403, not a loan
```

**The first line should succeed and the rest should fail.** If `read loans` returns
200, the grants did not apply and the register is public — fix that before anything
else, because everything above it depends on it.

## 4. Point the frontend at it

Create `apps/web/.env.local`:

```
VITE_API_MODE=supabase
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY
```

Then `npm run dev`.

The app will **throw on load** if either value is missing. That is deliberate: it
refuses to fall back to the in-memory mock, because a mock register looks exactly
like a working one and is not one.

## 5. Create the first account

Open the app. It offers to set the library up. That calls `create_first_user()`,
which succeeds only while no account exists — so it cannot be run twice, and there is
no default password anywhere in this repository.

The first account is always an administrator, whatever it asks for.

---

## What has been checked, and what has not

**Checked** — by `npm run check`, which reads the SQL rather than running it:

- all 14 tables have RLS enabled
- every refusal code the SQL can return is in a contract union, and every code in a
  union is reachable from a SQL function or produced by the client itself (the two
  backup codes) — no invented codes, no dead ones
- every refusal code has a sentence in `REFUSAL_MESSAGES`, so no screen can render nothing
- `loans`, `fines` and `fine_txns` have **no** insert/update/delete policy, and their
  write privileges are revoked — so they are written only by the functions
- `anon` is revoked from all tables and all functions, and may call exactly two
- every money column is an integer
- no delete policy exists anywhere, on purpose
- every update policy carries a `with check`

**Not checked** — this needs a live database:

- that the SQL parses. A typo in any statement fails its whole file.
- that the plpgsql variable and record types line up.
- that `issue_book`, `return_book` and `run_fine_accrual` actually run.
- **that the RLS denies what it should.** A policy can be perfectly valid and wrong.

**Checked separately** — `apps/web/src/test/supabase-api.test.ts` runs the client
against a stubbed server, so we know it asks the right questions and reads the answers
correctly: the argument names, snake_case to camelCase including nested arrays, the
refusal codes surviving as values, the page total coming from a header, and the anon
key being sent when there is no session.

That proves the client's half. It cannot prove the database's.

---

## If something is refused and you expected it to work

In order of likelihood:

1. **Signed out.** Every table needs `authenticated`, and only `has_any_accounts()`
   and `create_first_user()` work for `anon`. Sign in first.
2. **A role.** `assistant` holds the desk permissions and nothing else. `can()` is the
   same table as `packages/contracts/src/permissions.ts` — if the two have drifted, that
   is where it shows.
3. **A function.** Circulation refuses *as values*, not as errors, so check the
   `code` and `message` in the response rather than the status.

The client logs every failed request with the Postgres detail:

```
[supabase] POST rpc/issue_book -> 403 {"code":"42501", ...}
```

That line is the fastest route to the cause. The password screen never shows it,
because nobody at a desk can act on a Postgres error code.