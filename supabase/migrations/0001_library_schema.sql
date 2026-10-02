-- ═══════════════════════════════════════════════════════════════════════
--  Dandora Secondary School — School Library
--  Supabase / Postgres schema.  VERSION 1
--
--  ── What this file is ─────────────────────────────────────────────────
--
--  The backend, in full. There is no server application: the browser talks to
--  Supabase directly, and every rule below is enforced here rather than in the
--  interface. A check in the browser is a check the person using the computer can
--  delete — it protects the appearance of a rule, not the rule.
--
--  ── How to apply it ──────────────────────────────────────────────────
--
--  Supabase dashboard -> SQL Editor -> paste this file -> Run. Or, with the
--  CLI:  supabase db push
--
--  It is written to be safe to run twice: every object is created with IF NOT
--  EXISTS, and the functions are CREATE OR REPLACE. That matters because a
--  migration that fails halfway leaves a schema nobody can reason about.
--
--  ── The one decision worth arguing with ───────────────────────────────
--
--  Circulation rules are Postgres *functions*, not views.
--
--  A view is just a query with a name. Anyone who can read the loans table can
--  read the view, so "SELECT * FROM active_loans" is not a rule — it is the loans
--  table again. A function can check the session, the borrow limit, the fine
--  balance and the copy's status, and refuse. So issue_book, return_book and
--  the rest are functions, and loans/fines/fine_txns have no INSERT, UPDATE or
--  DELETE policy at all: there is no way to write to them, only to call a
--  function that decides whether you may.
--
--  ── Money ────────────────────────────────────────────────────────────
--
--  Integer cents, everywhere, in every column. No floats, no numeric. A ledger
--  that accumulates 0.1 + 0.2 eventually tells a parent a number nobody expects,
--  and no amount of display rounding fixes the stored value.
--
--  ── Admission numbers ────────────────────────────────────────────────
--
--  `member_code` is text with a unique constraint and is never normalised. S001
--  and S1 are different children; stripping the zero produces a register that is
--  wrong and looks right.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── Enums ─────────────────────────────────────────────────────────────
-- The same closed lists as packages/contracts/src/enums.ts. They have to agree;
-- there is no build step that would catch it, so a test checks both.

do $$ begin
  create type role            as enum ('admin', 'assistant', 'teacher');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_status     as enum ('active', 'disabled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type member_type_key as enum ('student', 'teacher', 'staff', 'external');
exception when duplicate_object then null; end $$;

do $$ begin
  create type member_status   as enum ('active', 'suspended', 'graduated', 'withdrawn');
exception when duplicate_object then null; end $$;

do $$ begin
  create type copy_condition  as enum ('good', 'fair', 'poor', 'damaged');
exception when duplicate_object then null; end $$;

do $$ begin
  create type copy_status     as enum (
    'on_shelf', 'on_loan', 'in_transit', 'at_desk', 'withdrawn', 'lost', 'in_repair'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type loan_status     as enum ('active', 'returned', 'lost', 'damaged', 'void');
exception when duplicate_object then null; end $$;

do $$ begin
  create type loan_event_kind as enum (
    'checkout', 'renew', 'return', 'void', 'mark_lost', 'mark_damaged', 'override'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type fine_kind       as enum ('overdue', 'lost', 'damage', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fine_status     as enum ('outstanding', 'partially_paid', 'paid', 'waived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fine_txn_kind   as enum ('charge', 'payment', 'waiver', 'refund');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hold_status     as enum ('open', 'filled', 'expired', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type import_kind     as enum ('students', 'stock', 'loans');
exception when duplicate_object then null; end $$;

-- ── Tables ─────────────────────────────────────────────────────────────

-- Accounts. Students have none, ever.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  role          role not null default 'assistant',
  status        user_status not null default 'active',
  last_login_at timestamptz,
  created_at    timestamptz not null default now()
);

-- The rules that apply to everybody of a given type. Data, not code, because the
-- school sets these and a librarian with admin rights changes them at the start of
-- a term; encoding them as constants would mean a code deploy for a policy change.
create table if not exists member_types (
  key                  member_type_key primary key,
  label                text not null,
  loan_period_days     int  not null check (loan_period_days > 0),
  grace_days           int  not null default 1 check (grace_days >= 0),
  max_renewals         int  not null default 0 check (max_renewals >= 0),
  borrow_limit         int  not null default 0 check (borrow_limit >= 0),
  can_place_holds      boolean not null default true,
  fine_exempt          boolean not null default false,
  fine_block_threshold int  not null default 1500 check (fine_block_threshold >= 0),
  sort_order           int  not null default 0
);

-- Students, staff and external readers.
--
-- `form`, `stream`, `grade` and `class_name` are free text on purpose. A school
-- names its own streams, and a constrained list here is a list the school has to
-- argue with every year. The suggestions in the interface come from
-- packages/contracts/src/school.ts; the storage accepts whatever they type.
create table if not exists members (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid unique references users (id) on delete set null,
  member_code    text not null unique,
  type           member_type_key not null default 'student',
  form           text,
  stream         text,
  grade          text,
  class_name     text,
  first_name     text not null,
  last_name      text not null,
  email          text,
  phone          text,
  guardian_name  text,
  guardian_email text,
  join_date      date not null default current_date,
  status         member_status not null default 'active',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- A work, not an object. "Things We Carry".
create table if not exists titles (
  id             uuid primary key default gen_random_uuid(),
  isbn           text,
  title          text not null,
  author         text not null,
  publisher      text,
  published_year int,
  edition        text,
  subject        text,
  call_number    text,
  summary        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists shelf_locations (
  id    uuid primary key default gen_random_uuid(),
  code  text not null unique,
  label text not null
);

-- A physical object. "BK-0001". This is what goes out, comes back and gets lost.
--
-- `status` is stored rather than derived from the open loans, because the desk
-- looks up a barcode far more often than it counts loans, and this keeps that a
-- single indexed read. The functions below are the only thing allowed to change it.
create table if not exists copies (
  id                uuid primary key default gen_random_uuid(),
  title_id          uuid not null references titles (id) on delete cascade,
  barcode           text not null unique,
  location_id       uuid references shelf_locations (id) on delete set null,
  condition         copy_condition not null default 'good',
  status            copy_status not null default 'on_shelf',
  acquired_on       date,
  replacement_cost  int check (replacement_cost is null or replacement_cost >= 0),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists loans (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references members (id) on delete restrict,
  copy_id       uuid not null references copies (id) on delete restrict,
  checked_out_at timestamptz not null default now(),
  due_at        timestamptz not null,
  returned_at   timestamptz,
  renew_count   int not null default 0 check (renew_count >= 0),
  status        loan_status not null default 'active',
  -- A void keeps its row and its reason. A register with a hole in it is a register
  -- nobody trusts, and "who voided this and why" is exactly what an audit asks.
  void_reason   text,
  voided_at     timestamptz,
  checked_out_by uuid references users (id) on delete set null,
  condition_out copy_condition not null default 'good',
  condition_in  copy_condition,
  notes         text,
  created_at    timestamptz not null default now()
);

-- One open loan per copy, as a partial unique index.
--
-- This was a `unique (copy_id) where status = 'active'` table constraint until the
-- editor refused it: **Postgres has no partial UNIQUE constraint.** A table constraint
-- can only be a column list, and filtering by a predicate is possible only in
-- `CREATE UNIQUE INDEX`. The index below is exactly equivalent and is where the rule
-- now lives.
--
-- It is here rather than in the interface because issuing the same physical book to
-- two students is the one mistake in this system that cannot be undone. `issue_book`
-- checks it too, but a check that reads before writing loses a race; this cannot.
create unique index if not exists loans_one_open_per_copy_idx
  on loans (copy_id) where status = 'active';

-- Append-only history. Separate from the loan so the register can answer "when was
-- this renewed and by whom" without the loan row carrying a history in JSON.
create table if not exists loan_events (
  id         uuid primary key default gen_random_uuid(),
  loan_id    uuid not null references loans (id) on delete cascade,
  kind       loan_event_kind not null,
  actor      uuid references users (id) on delete set null,
  note       text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists holds (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references members (id) on delete cascade,
  title_id   uuid not null references titles (id) on delete cascade,
  placed_at  timestamptz not null default now(),
  copy_id    uuid references copies (id) on delete set null,
  expires_at timestamptz,
  status     hold_status not null default 'open'
);

create table if not exists fines (
  id               uuid primary key default gen_random_uuid(),
  member_id        uuid not null references members (id) on delete restrict,
  loan_id          uuid references loans (id) on delete set null,
  copy_id          uuid references copies (id) on delete set null,
  kind             fine_kind not null,
  assessed_amount  int not null default 0,
  -- The balance is a copy of the ledger's sum, kept in step by the functions below.
  -- It exists so the register can sort by what somebody owes without aggregating
  -- the ledger on every row; it is never written by hand.
  balance          int not null default 0,
  assessed_at      timestamptz not null default now(),
  status           fine_status not null default 'outstanding',
  note             text,
  created_by       uuid references users (id) on delete set null,
  created_at       timestamptz not null default now()
);

-- APPEND-ONLY. There is no update path and no delete policy. A correction is a new
-- row; that is what "append-only" means, and it is why a waiver leaves the charge
-- visible next to it.
create table if not exists fine_txns (
  id           uuid primary key default gen_random_uuid(),
  fine_id      uuid not null references fines (id) on delete cascade,
  kind         fine_txn_kind not null,
  -- Signed: charge positive, payment/waiver/refund negative.
  amount       int not null,
  reason       text,
  actor_user_id uuid references users (id) on delete set null,
  -- Carries the accrual day, which is what makes the nightly job idempotent per
  -- (loan, day). Never edited after insert.
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

create table if not exists imports (
  id             uuid primary key default gen_random_uuid(),
  kind           import_kind not null,
  filename       text not null,
  dry_run        boolean not null default true,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  rows_read      int not null default 0,
  rows_accepted  int not null default 0,
  rows_rejected  int not null default 0,
  errors         jsonb not null default '[]'::jsonb
);

create table if not exists audit (
  id         uuid primary key default gen_random_uuid(),
  actor      uuid references users (id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────
-- The three queries the desk actually runs, and nothing speculative.

create index if not exists members_code_idx    on members (member_code);
create index if not exists members_surname_idx on members (lower(last_name));
create index if not exists copies_barcode_idx  on copies (barcode);
create index if not exists copies_title_idx    on copies (title_id);
create index if not exists copies_status_idx   on copies (status);
create index if not exists titles_title_idx    on titles (lower(title));
create index if not exists titles_author_idx   on titles (lower(author));

-- The register: open loans, newest first, and overdue ones by deadline.
create index if not exists loans_open_idx on loans (checked_out_at desc) where status = 'active';
create index if not exists loans_due_idx  on loans (due_at) where status = 'active';
create index if not exists loans_member_idx on loans (member_id);

create index if not exists fine_txns_fine_idx  on fine_txns (fine_id, created_at);
create index if not exists fines_member_idx   on fines (member_id) where balance > 0;
create index if not exists fines_open_idx      on fines (assessed_at desc) where balance > 0;
create index if not exists holds_queue_idx     on holds (title_id, placed_at) where status = 'open';
create index if not exists loan_events_loan_idx on loan_events (loan_id, created_at);
create index if not exists audit_entity_idx   on audit (entity, entity_id, created_at desc);

-- ── Who is calling ─────────────────────────────────────────────────────

-- Supabase puts the signed-in user's id in request.jwt.claims.sub. This is the
-- only thing that identifies a caller, and reading it in one function means every
-- policy below agrees about what "signed in" means.
create or replace function current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  -- Two ways Supabase passes the caller's identity, and both are handled:
  --   request.jwt.claims      a JSON object   {"sub":"...","role":"anon"}
  --   request.jwt.claim.sub   the bare subject
  --
  -- The bare setting is tried first because it needs no cast. This function had it
  -- second, wrapped as `(nullif(current_setting('request.jwt.claim.sub', true), ''))::jsonb`
  -- -- and a UUID such as 9f1c... is not valid JSON, so that raises
  -- `invalid input syntax for type json`.
  --
  -- It stayed quiet only because `request.jwt.claims` is set first and satisfied the
  -- coalesce, so the broken branch was never taken. Every RLS policy calls `can()`,
  -- which calls this, so a single request arriving with only the older setting would
  -- have failed every table in the schema with a JSON parse error that says nothing
  -- about what actually went wrong.
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

comment on function current_user_id() is
  'The signed-in user''s id, or null. Every policy reads this rather than parsing the JWT itself.';

-- The caller's role. `anonymous` is a real value here, and it holds nothing —
-- that is what signed out means, not a reduced version of an account.
create or replace function current_role_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select u.role::text from users u where u.id = current_user_id() and u.status = 'active'),
    'anonymous'
  )
$$;

-- ── Permissions ────────────────────────────────────────────────────────
--
-- The same table as packages/contracts/src/permissions.ts, in SQL. It lives in
-- both places because the browser needs it to decide what to show and the database
-- needs it to decide what to allow, and a rule enforced in only one of them is a
-- rule the other one can ignore.

create or replace function can(permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case current_role_name()
    when 'admin' then permission = any (array[
      'titles.read','titles.write','copies.read','copies.write',
      'members.read','members.write',
      'loans.read','loans.checkout','loans.return','loans.void','loans.renew',
      'fines.read','fines.write','holds.read','holds.write',
      'reports.run','imports.run','settings.read','settings.write',
      'users.read','users.write','audit.read'])
    when 'assistant' then permission = any (array[
      'titles.read','copies.read','members.read',
      'loans.read','loans.checkout','loans.return','loans.void','loans.renew',
      'fines.read','holds.read'])
    when 'teacher' then permission = any (array[
      'titles.read','copies.read','members.read','loans.read'])
    else false  -- anonymous holds nothing
  end
$$;

comment on function can(text) is
  'Whether the caller''s role includes this permission. anonymous holds nothing, deliberately.';

-- ── shared checks ──────────────────────────────────────────────────────

-- The member and the copy behind a checkout, and why it cannot happen.
--
-- Returned as a table rather than raised so the caller can show all of it: "that
-- student already has 5 books out" is more useful than "refused", and it is the
-- sentence that stops a sixth being issued by accident.
create or replace function borrow_blockers(
  p_member_code text,
  p_barcode     text
)
returns table (
  code    text,
  message text,
  can_override boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with m as (
    select mem.*, mt.loan_period_days, mt.grace_days, mt.max_renewals,
           mt.borrow_limit, mt.fine_exempt, mt.fine_block_threshold
    from members mem
    join member_types mt on mt.key = mem.type
    where mem.member_code = p_member_code
  ),
  c as (
    select c.* from copies c where c.barcode = p_barcode
  ),
  open_loans as (
    select count(*)::int as n from loans l
    where l.member_id = (select id from m) and l.status = 'active'
  ),
  owed as (
    -- Never negative, and only counting what is still outstanding.
    select coalesce(sum(greatest(f.balance, 0)), 0)::int as cents
    from fines f
    where f.member_id = (select id from m)
      and f.status in ('outstanding', 'partially_paid')
  )
  select * from (
    select 'member_not_found'::text, 'No student on file with that number.'::text, false::boolean
    where not exists (select 1 from m)
    union all
    select 'copy_not_found', 'No book on file with that number.', false
    where not exists (select 1 from c)
    union all
    select 'member_suspended', 'That student is not active.', false
    where exists (select 1 from m) and (select status from m) <> 'active'
    union all
    select 'copy_on_loan', 'That book is already out.', false
    where exists (select 1 from c) and (select status from c) = 'on_loan'
    union all
    select 'copy_lost', 'That book has been reported lost.', false
    where exists (select 1 from c) and (select status from c) = 'lost'
    union all
    -- Everything except on_shelf is unissuable, and saying so differently from
    -- "already out" is the difference between a librarian checking and a librarian
    -- hunting.
    select 'copy_unavailable', 'That book is not on the shelf.', true
    where exists (select 1 from c) and (select status from c) not in ('on_shelf', 'on_loan', 'lost')
    union all
    select 'limit_exceeded', 'That student is already at their borrowing limit.', true
    where exists (select 1 from m) and (select n from open_loans) >= (select borrow_limit from m)
    union all
    select 'fine_blocked', 'That student owes more than they are allowed to owe.', true
    where exists (select 1 from m)
      and not (select fine_exempt from m)
      and (select cents from owed) >= (select fine_block_threshold from m)
      and (select fine_block_threshold from m) > 0
  ) blockers
$$;

comment on function borrow_blockers(text, text) is
  'Every reason a checkout cannot happen, so the caller can show all of it rather than the first.';

commit;