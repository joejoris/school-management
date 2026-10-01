# Dandora Secondary School — Library Management System

Record book issues, deadlines, returns and fines for the school library. Built for
a phone at the desk, and for a tablet when there is time to sit down.

The default build runs entirely in the browser against an in-memory store, and
every rule is enforced. A Supabase backend now exists — schema, RLS and a client —
but **it has never been run**. See `supabase/README.md`, which says exactly what has
been checked and what has not, and gives you a way to check the rest yourself.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

Open it and it asks you to create the first account. That account is the head
librarian. There is no demo data and no second account to sign in as — the
screenshot in your head of a register full of books is not what you will see.

```bash
npm run check      # typecheck + all tests
npm run prove      # break the code on purpose, to prove the guards work
npm run build      # a static bundle in apps/web/dist
```

---

## What works, and how that was established

| | |
|---|---|
| Domain rules | 26 tests |
| Circulation, end to end | 43 tests |
| Screens, mounted and clicked | 20 tests |
| **Total** | **89 tests, 0 type errors** |
| Guards proved to fail against broken code | 6 of 6 |

`npm run prove` is the part worth keeping. It breaks six things on purpose — the
landing route redirecting to itself, a dashboard put back in front of the entry
form, the catch-all quietly redirecting, a suggestion list back on the stream
field, a form that empties when it complains, a submit button enabled too early —
and requires each guard to fail. A test that has never been seen to fail is not
known to work.

---

## Decisions worth arguing with

**Money is an integer number of cents.** No floats, anywhere. A fine ledger that
accumulates `0.1 + 0.2` eventually tells a parent they owe a number nobody
expects, and no amount of display rounding fixes the stored value.

**A due date is a calendar day, not an instant.** "Due on Tuesday" means Tuesday
at the school. A deadline stored at midnight UTC is a different day for half the
world, and that is a bug a librarian finds and a developer does not.

**An admission number is never normalised.** `S001` and `S1` are different
children. Stripping the zero produces a register that is wrong and looks right,
which is the worst combination available — and it is exactly what a helpful
normalisation does. `findMemberByCode` is exact-match on purpose.

**A voided loan is kept, with its reason.** The record was wrong; the fact that it
was wrong is worth keeping. A register with a hole in it is one nobody trusts. A
void with no written reason is refused outright, because an unexplained void is
indistinguishable from a deletion.

**Fines are materialised, never computed while somebody reads them.** A balance
that changes under the cursor is not an answer to anything. The ledger is
append-only; a correction is a new row, and the balance is the sum of it.

**Refusals are values, not exceptions.** "That student already has 5 books out"
*is* the feature — it is the sentence that stops a sixth being issued by
accident. Throwing it away would force the interface to guess, and guessing wrong
is how staff stop trusting the software.

**`assistant` is the role that exists because this is a school.** It is not a
lesser admin, it is the job: issue books, take them back, work the register, read
fines. What it cannot do is change the rules or manage accounts — the two things
that should not be lying around on a shared desk. `anonymous` holds nothing at
all, which is what "signed out" means: not a reduced account, but no permissions.

**`/` is the entry form. There is no `/login`.** The app opens on the thing a
librarian does forty times a day, not on a summary of things already recorded.
There is no dashboard, because a panel of counts pushes the admission number off a
phone screen. `/` decides what to show: the entry form for a signed-in librarian,
the sign-in panel for anyone else, and setup when the school has no accounts yet.

**Stream is free text, with no suggestions.** Form and Grade suggest from what the
school has actually recorded, because those are the ones with a small closed set
that is genuinely in use. Stream has no list because a school names its own
streams, and a datalist is a list the school has to argue with. The browser's
autocomplete appears even on an empty datalist, so an empty one is still a
half-controlled field that offers nothing.

**A book that is not on file does not create a student.** The form says so and
offers to create one deliberately. Silently inventing a student means the register
contains a person who does not exist, and a school cannot audit its way out of
that.

**The register is cards on a phone and a table on a screen.** Ten columns of codes
and dates do not fit in 343 pixels, and a scrolling table puts the admission
number and the book number — the two that matter — off the edge. Both renderings
read from the same rows, so they cannot disagree about what is in the register.

---

## Two bugs the tests found, worth recording

**`need()` computed the right refusal and threw it away.**

```ts
if (!can(this.role, permission)) deny(this.role, permission)
```

`deny()` *returns* an Error; it builds the message, it does not raise it. Every
permission in the table was enforced nowhere and the domain behaved as though
everybody were an administrator. It typechecked, and it read correctly. The table
said `anonymous` holds nothing, the code said `anonymous` holds nothing, and the
two were still not connected to each other.

**The session and the role were stored separately, and disagreed.**

`createUser` and `signIn` set `sessionUserId` and never touched `role`, so a
librarian who had just signed in was refused every action with "Sign in to do
that" — while the screen they were looking at said they were signed in. Two pieces
of state both claiming to be "who is this", and only one of them consulted. The
role is now derived from the session, so they cannot drift.

---

## What is not here yet

Stated plainly, because a README that overstates is worse than none.

**There is no database.** The app talks to an in-memory store through a single
seam (`apps/web/src/api/index.ts`). Set `VITE_API_MODE=supabase` and it throws
with an explanation rather than silently falling back — a mock register looks
exactly like a real one, and a fallback that cannot be noticed is a register that
empties on reload after somebody has typed a term into it.

**There is no password hashing.** `signIn` matches an email and ignores the
password. In a browser there is nowhere safe to keep a hash, and pretending to
verify one teaches a reader that passwords are protected here. The first real
backend must not inherit this. There is also no "forgot password" link, and no
reset mail — a link that says "email yourself a reset" and does nothing is worse
than no link.

**`getImportJob` and `listImportRowErrors` return what they have.** Imports are
kept in memory so those two work, but the job list is not durable.

**Nothing has run on a real phone.** The layout decisions are reasoned and the
screens are mounted and clicked in jsdom, which is not a viewport. 343px was
assumed to be the narrow case and `dvh` was used wherever a full-height layout is
wanted, but a real handset is the next thing to check.

**The dashboard, members list, catalogue, holds and reports are not built.** The
domain supports all of them and the interface declares them; the screens do not
exist yet.

---

## Layout

```
packages/contracts/    The rules. No React, no fetch, no mocking library.
  src/enums.ts           The school's vocabulary, as closed lists
  src/entities.ts        One zod schema per table, and why each is shaped so
  src/refusals.ts        Why a refusal is a value
  src/permissions.ts     Who may do what — one table, read by the engine only
  src/page.ts            Pagination, so the mock and a server cannot disagree
  src/api.ts             The only interface the interface layer knows about

apps/web/
  src/api/index.ts     THE SEAM. The one file that changes when the backend arrives
  src/api/mock.ts      The rules, running
  src/routes.tsx       No /login. No /dashboard. / is the entry form.
  src/features/auth/   The gate: setup, sign-in, and who is at the desk
  src/features/issues/ The entry form, the register, import, backup
  tools/prove-guards.mjs  Breaks the code to prove the tests are load-bearing
```