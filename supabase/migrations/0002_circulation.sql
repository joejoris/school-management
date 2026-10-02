-- ═══════════════════════════════════════════════════════════════════════
--  Circulation.  VERSION 1
--
--  Every function here returns jsonb carrying \`ok\`, and on a refusal a \`code\`
--  and the sentence to show.
--
--  ── Why refusals come back as values ─────────────────────────────────
--
--  "That student already has 5 books out" IS the feature: it is the sentence that
--  stops a sixth being issued by accident. Raising an exception would throw the
--  sentence away and hand the client an error code, and every screen would have to
--  decide what to tell the person standing at the desk.
--
--  So the codes are stable and machine-readable, the copy is here in one place, and
--  the client renders it without inventing anything.
--
--  ── SECURITY DEFINER ─────────────────────────────────────────────────
--
--  These functions bypass RLS on purpose. RLS is what stops a browser writing
--  directly to loans; these functions are the only way to write at all, and each one
--  makes its own checks. A function that honoured RLS would find itself unable to
--  read the row it is about to update.
--
--  Every one of them calls \`can(...)\` first. That is the permission check, and it
--  lives inside the function so that calling it by hand over PostgREST gets the
--  same answer as pressing the button.
--
--  Each also writes a loan_event and an audit row. A loan whose author is unknown
--  is a loan nobody can defend, and the register's history is the reason for
--  recording the author in the first place.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── issuing ────────────────────────────────────────────────────────────

create or replace function issue_book(
  p_member_code   text,
  p_barcode       text,
  p_due_at        timestamptz default null,
  p_checked_out_at timestamptz default null,
  p_override      boolean default false,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member   members%rowtype;
  v_copy     copies%rowtype;
  v_type     member_types%rowtype;
  v_loan     loans%rowtype;
  v_block    record;
  v_out      timestamptz;
  v_at       timestamptz := coalesce(p_checked_out_at, now());
begin
  if not can('loans.checkout') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot issue books.');
  end if;

  select * into v_member from members where member_code = p_member_code;
  select * into v_copy   from copies   where barcode = p_barcode;

  if v_member.id is null then
    return jsonb_build_object('ok', false, 'code', 'member_not_found',
      'message', 'No student on file with that number.', 'overridable', false);
  end if;
  if v_copy.id is null then
    return jsonb_build_object('ok', false, 'code', 'copy_not_found',
      'message', 'No book on file with that number.', 'overridable', false);
  end if;

  select * into v_type from member_types where key = v_member.type;

  -- The policy refusals, in the order a librarian would want them told. The copy's
  -- status is checked before the student's, because "that book is already out" is
  -- the answer to the question they just asked and not a surprise about the student.
  if v_member.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'member_suspended',
      'message', 'That student is not active.', 'overridable', false);
  end if;
  if v_copy.status = 'on_loan' then
    return jsonb_build_object('ok', false, 'code', 'copy_on_loan',
      'message', 'That book is already out.', 'overridable', false);
  end if;
  if v_copy.status = 'lost' then
    return jsonb_build_object('ok', false, 'code', 'copy_lost',
      'message', 'That book has been reported lost.', 'overridable', false);
  end if;
  if v_copy.status <> 'on_shelf' then
    -- Everything except on_shelf is unissuable, and this says so differently from
    -- "already out" so a librarian can tell checking from hunting.
    if p_override and p_override_reason is not null and btrim(p_override_reason) <> '' then
      null;
    else
      return jsonb_build_object('ok', false, 'code', 'copy_unavailable',
        'message', 'That book is not on the shelf.', 'overridable', true);
    end if;
  end if;

  if (select count(*) from loans l
      where l.member_id = v_member.id and l.status = 'active') >= v_type.borrow_limit
  then
    if not (p_override and p_override_reason is not null and btrim(p_override_reason) <> '') then
      return jsonb_build_object('ok', false, 'code', 'limit_exceeded',
        'message', 'That student is already at their borrowing limit.', 'overridable', true);
    end if;
  end if;

  if not v_type.fine_exempt
     and v_type.fine_block_threshold > 0
     and coalesce((select sum(greatest(f.balance, 0)) from fines f
                   where f.member_id = v_member.id
                     and f.status in ('outstanding','partially_paid')), 0)
         >= v_type.fine_block_threshold
  then
    if not (p_override and p_override_reason is not null and btrim(p_override_reason) <> '') then
      return jsonb_build_object('ok', false, 'code', 'fine_blocked',
        'message', 'That student owes more than they are allowed to owe.', 'overridable', true);
    end if;
  end if;

  -- The deadline is the member type's period unless the school set one. Exam week
  -- is not "14 days from today", and deriving it would invent a deadline nobody
  -- chose.
  v_out := coalesce(p_due_at, v_at + make_interval(days => v_type.loan_period_days));

  insert into loans (
    member_id, copy_id, checked_out_at, due_at, checked_out_by,
    condition_out, status
  )
  values (
    v_member.id, v_copy.id, v_at, v_out, current_user_id(), v_copy.condition, 'active'
  )
  returning * into v_loan;

  update copies
     set status = 'on_loan', updated_at = now()
   where id = v_copy.id;

  insert into loan_events (loan_id, kind, actor, note, meta)
  values (v_loan.id, 'checkout', current_user_id(), p_override_reason,
          jsonb_build_object('barcode', p_barcode, 'due_at', v_out,
                             'overridden', coalesce(p_override, false)));

  insert into audit (actor, action, entity, entity_id, after)
  values (current_user_id(), 'checkout', 'loan', v_loan.id,
          jsonb_build_object('member_code', p_member_code, 'barcode', p_barcode,
                             'due_at', v_out, 'overridden', coalesce(p_override, false),
                             'reason', p_override_reason));

  return jsonb_build_object(
    'ok', true,
    'loan_id', v_loan.id,
    'due_at', v_out,
    'copy_status', 'on_loan',
    'overridden', coalesce(p_override, false));
end
$$;

-- ── returning ──────────────────────────────────────────────────────────
--
-- Also promotes a hold. That was the one thing the in-memory version did not do —
-- `holdPromoted` was hardcoded false — so a book came back and the student waiting
-- for it was never told. The queue is ordered by when each hold was placed, and
-- only the first one can be filled.

create or replace function return_book(
  p_loan_id      uuid,
  p_condition_in copy_condition,
  p_returned_at  timestamptz default null,
  p_to_shelf     boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan      loans%rowtype;
  v_copy      copies%rowtype;
  v_at        timestamptz := coalesce(p_returned_at, now());
  v_hold      holds%rowtype;
begin
  if not can('loans.return') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot record returns.');
  end if;

  select * into v_loan from loans where id = p_loan_id;
  if v_loan.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found',
      'message', 'No such loan record.');
  end if;
  if v_loan.status <> 'active' then
    -- A refusal with a sentence, not an error. Told the software had failed,
    -- somebody would press it again and conclude the software was broken.
    return jsonb_build_object('ok', false, 'code', 'already_returned',
      'message', 'That book has already come back.');
  end if;
  if v_at < v_loan.checked_out_at then
    -- Stored rather than clamped: the two dates would make the loan unreturnable
    -- for its whole life, and silently changing either would hide the mistake.
    return jsonb_build_object('ok', false, 'code', 'returned_before_issued',
      'message', 'A book cannot come back before it went out.');
  end if;

  update loans
     set status = 'returned', returned_at = v_at, condition_in = p_condition_in
   where id = p_loan_id
  returning * into v_loan;

  select * into v_copy from copies where id = v_loan.copy_id;
  update copies
     set status = case when p_to_shelf then 'on_shelf' else 'at_desk' end,
         condition = p_condition_in,
         updated_at = now()
   where id = v_loan.copy_id;

  insert into loan_events (loan_id, kind, actor, meta)
  values (p_loan_id, 'return', current_user_id(),
          jsonb_build_object('condition_in', p_condition_in));

  -- The first hold in the queue, and only that one.
  select * into v_hold
    from holds
   where title_id = (select title_id from copies where id = v_loan.copy_id)
     and status = 'open'
   order by placed_at
   limit 1;

  if v_hold.id is not null then
    update holds
       set status = 'filled', copy_id = v_loan.copy_id, expires_at = v_at + interval '3 days'
     where id = v_hold.id;

    insert into audit (actor, action, entity, entity_id, after)
    values (current_user_id(), 'hold_filled', 'hold', v_hold.id,
            jsonb_build_object('member_id', v_hold.member_id, 'copy_id', v_loan.copy_id));
  end if;

  insert into audit (actor, action, entity, entity_id, after)
  values (current_user_id(), 'return', 'loan', p_loan_id,
          jsonb_build_object('copy_id', v_loan.copy_id, 'condition_in', p_condition_in));

  return jsonb_build_object('ok', true, 'loan_id', p_loan_id,
                            'hold_promoted', v_hold.id is not null);
end
$$;

-- ── renewing ───────────────────────────────────────────────────────────

create or replace function renew_loan(
  p_loan_id uuid,
  p_override boolean default false,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan   loans%rowtype;
  v_member members%rowtype;
  v_type   member_types%rowtype;
  v_due    timestamptz;
begin
  if not can('loans.renew') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot renew loans.');
  end if;

  select * into v_loan from loans where id = p_loan_id;
  if v_loan.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found',
      'message', 'No such loan record.');
  end if;
  if v_loan.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'already_returned',
      'message', 'That book has already come back.');
  end if;

  select * into v_member from members where id = v_loan.member_id;
  select * into v_type from member_types where key = v_member.type;

  /*
   * A date that has not happened yet.
   *
   * Refused here rather than accepted, because a loan stamped for a future day is a
   * loan that cannot be returned until that day: `return_book` will correctly refuse
   * it with "cannot come back before it went out", and the person at the desk would
   * be looking at a book that left weeks ago and will not come back. Told now, they
   * are still looking at the date field and can fix it.
   *
   * Five minutes of slack, because a browser and a database never quite agree on the
   * clock and refusing a loan issued "now" would be a maddening intermittent fault.
   * The slack is generous enough for clock drift and not generous enough to be worth
   * exploiting.
   */
  if v_at > now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'issued_in_future',
      'message', 'A book cannot go out on a date that has not happened yet.',
      'overridable', false);
  end if;

  if v_member.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'member_suspended',
      'message', 'That student is not active.');
  end if;

  -- Somebody else is waiting for this title. Renewing it keeps it away from them.
  if exists (
    select 1 from holds h
    join copies c2 on c2.id = v_loan.copy_id
    where h.title_id = c2.title_id and h.status = 'open' and h.member_id <> v_loan.member_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'has_holds',
      'message', 'Other students are waiting for that book.');
  end if;

  if v_loan.renew_count >= v_type.max_renewals then
    if not (p_override and p_override_reason is not null and btrim(p_override_reason) <> '') then
      return jsonb_build_object('ok', false, 'code', 'renewal_limit_reached',
        'message', 'That book has been renewed as many times as it can be.');
    end if;
  end if;

  -- From today, not from the old due date. Extending from the old due date makes a
  -- repeatedly-renewed book eventually due in the past — a renewal that arrives as
  -- an instant overdue.
  v_due := now() + make_interval(days => v_type.loan_period_days);

  update loans
     set due_at = v_due, renew_count = renew_count + 1
   where id = p_loan_id
  returning * into v_loan;

  insert into loan_events (loan_id, kind, actor, note, meta)
  values (p_loan_id, 'renew', current_user_id(), p_override_reason,
          jsonb_build_object('due_at', v_due, 'renew_count', v_loan.renew_count));

  insert into audit (actor, action, entity, entity_id, after)
  values (current_user_id(), 'renew', 'loan', p_loan_id,
          jsonb_build_object('due_at', v_due, 'renew_count', v_loan.renew_count,
                             'reason', p_override_reason));

  return jsonb_build_object('ok', true, 'loan_id', p_loan_id, 'due_at', v_due,
                            'renew_count', v_loan.renew_count);
end
$$;

-- ── voiding ────────────────────────────────────────────────────────────
--
-- A void is not a deletion. The row stays, with its reason, and the copy goes back
-- on the shelf. The reason is mandatory: an unexplained void is indistinguishable
-- from a deletion, which is the thing this exists to prevent.

create or replace function void_loan(p_loan_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan loans%rowtype;
begin
  if not can('loans.void') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot void loans.');
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'A void needs a reason. It is the first thing anyone will ask.');
  end if;

  select * into v_loan from loans where id = p_loan_id;
  if v_loan.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found',
      'message', 'No such loan record.');
  end if;
  if v_loan.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'not_active',
      'message', format('Only an active loan can be voided; that one is %s.', v_loan.status));
  end if;

  update loans
     set status = 'void', void_reason = btrim(p_reason), voided_at = now()
   where id = p_loan_id
  returning * into v_loan;

  update copies set status = 'on_shelf', updated_at = now() where id = v_loan.copy_id;

  insert into loan_events (loan_id, kind, actor, note)
  values (p_loan_id, 'void', current_user_id(), btrim(p_reason));

  insert into audit (actor, action, entity, entity_id, before, after)
  values (current_user_id(), 'void', 'loan', p_loan_id,
          jsonb_build_object('status', 'active'),
          jsonb_build_object('status', 'void', 'reason', btrim(p_reason)));

  return jsonb_build_object('ok', true, 'loan_id', p_loan_id, 'status', 'void');
end
$$;

-- ── lost ───────────────────────────────────────────────────────────────

create or replace function mark_lost(p_loan_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan loans%rowtype;
begin
  if not can('loans.void') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot report a book lost.');
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'Reporting a book lost needs a reason.');
  end if;

  select * into v_loan from loans where id = p_loan_id;
  if v_loan.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such loan record.');
  end if;
  if v_loan.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'already_returned',
      'message', 'That book has already come back.');
  end if;

  update loans
     set status = 'lost', returned_at = now()
   where id = p_loan_id
  returning * into v_loan;

  update copies set status = 'lost', updated_at = now() where id = v_loan.copy_id;

  insert into loan_events (loan_id, kind, actor, note)
  values (p_loan_id, 'mark_lost', current_user_id(), btrim(p_reason));

  -- A lost book is money owed. Assessed here rather than by the accrual, because a
  -- replacement cost is a fact about the book and not a function of how long
  -- somebody kept it.
  insert into fines (member_id, loan_id, copy_id, kind, assessed_amount, balance, note, created_by)
  values (v_loan.member_id, v_loan.id, v_loan.copy_id, 'lost',
          coalesce((select replacement_cost from copies where id = v_loan.copy_id), 0),
          coalesce((select replacement_cost from copies where id = v_loan.copy_id), 0),
          btrim(p_reason), current_user_id());

  insert into audit (actor, action, entity, entity_id, after)
  values (current_user_id(), 'mark_lost', 'loan', p_loan_id,
          jsonb_build_object('reason', btrim(p_reason)));

  return jsonb_build_object('ok', true, 'loan_id', p_loan_id, 'status', 'lost');
end
$$;

-- ── fines ──────────────────────────────────────────────────────────────
--
-- The balance is always recomputed from the ledger, never incremented. An
-- increment drifts, and a drifted balance is a balance that lies.

create or replace function recompute_fine_balance(p_fine_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
begin
  select coalesce(sum(t.amount), 0)::int into v_total
    from fine_txns t where t.fine_id = p_fine_id;

  update fines
     set balance = greatest(v_total, 0)
   where id = p_fine_id;

  -- The status is derived from the ledger, never incremented, because an increment
  -- drifts and a drifted balance is a balance that lies.
  --
  -- greatest(v_total, 0) is compared here for the same reason it is stored: a refund
  -- on top of a charge can net below zero, and that is money returned rather than a
  -- fine that has been paid. Reading the same number the stored balance uses is what
  -- stops the status and the balance disagreeing about the same fine.
  --
  -- Two things were wrong here before the editor saw this file, and both were in the
  -- declaration rather than the logic:
  --
  --   v_kind was declared fine_status but fed fines.kind, which is fine_kind. The two
  --   enums share no labels -- kind is overdue/lost/damage/other, status is
  --   outstanding/partially_paid/paid/waived -- so the assignment raised
  --   "invalid input value for enum fine_status: overdue" on every call. That is every
  --   payment, every waiver and every nightly accrual charge: the whole money side.
  --   The message names a type the application never mentions, so nothing on screen
  --   would have pointed at it.
  --
  --   The guard meant to keep a waiver a waiver compared that value against 'waived',
  --   which was comparing a fine's *kind* to a *status*. The intent is now expressed
  --   where it belongs, as a condition on the update.
  update fines
     set status = case
                    when greatest(v_total, 0) = 0 then 'paid'::fine_status
                    when v_total < (select assessed_amount from fines where id = p_fine_id)
                      then 'partially_paid'::fine_status
                    else 'outstanding'::fine_status
                  end
   where id = p_fine_id
     and status <> 'waived'::fine_status;
end
$$;

create or replace function record_payment(p_fine_id uuid, p_amount int, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fine fines%rowtype;
begin
  if not can('fines.write') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot take payments.');
  end if;

  select * into v_fine from fines where id = p_fine_id;
  if v_fine.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such fine.');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount',
      'message', 'A payment must be a whole number of shillings, more than zero.');
  end if;
  if p_amount > v_fine.balance then
    return jsonb_build_object('ok', false, 'code', 'too_much',
      'message', 'That is more than the outstanding balance.');
  end if;

  -- Negative, because the convention is that a charge is positive and everything
  -- else reduces it. A positive payment would make a balance grow when money is
  -- handed in.
  insert into fine_txns (fine_id, kind, amount, reason, actor_user_id)
  values (p_fine_id, 'payment', -p_amount, p_reason, current_user_id());

  perform recompute_fine_balance(p_fine_id);

  insert into audit (actor, action, entity, entity_id, after)
  values (current_user_id(), 'payment', 'fine', p_fine_id,
          jsonb_build_object('amount', p_amount, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'fine_id', p_fine_id, 'paid', p_amount);
end
$$;

-- A waiver is a ledger entry, not an edit. A fine that vanished with no explanation
-- is the thing auditors look for, and the charge stays visible beside it.
create or replace function waive_fine(p_fine_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fine fines%rowtype;
begin
  if not can('fines.write') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot waive fines.');
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required',
      'message', 'Waiving a fine needs a reason. It is the first question asked.');
  end if;

  select * into v_fine from fines where id = p_fine_id;
  if v_fine.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such fine.');
  end if;
  if v_fine.balance <= 0 then
    return jsonb_build_object('ok', false, 'code', 'already_settled',
      'message', 'That fine is already settled.');
  end if;

  insert into fine_txns (fine_id, kind, amount, reason, actor_user_id)
  values (p_fine_id, 'waiver', -v_fine.balance, btrim(p_reason), current_user_id());

  perform recompute_fine_balance(p_fine_id);

  update fines set status = 'waived' where id = p_fine_id;

  insert into audit (actor, action, entity, entity_id, after) values
    (current_user_id(), 'waive', 'fine', p_fine_id,
     jsonb_build_object('amount', v_fine.balance, 'reason', btrim(p_reason)));

  return jsonb_build_object('ok', true, 'fine_id', p_fine_id, 'waived', v_fine.balance);
end
$$;

-- ── the nightly accrual ────────────────────────────────────────────────
--
-- Idempotent per (loan, day): the day is written into the ledger entry, so a second
-- run on the same day finds its own marker and charges nothing. Schedules run twice
-- — and a student whose family was charged two days for one day of lateness is the
-- kind of thing that ends with a complaint.

create or replace function run_fine_accrual(p_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at   timestamptz := coalesce(p_at, now());
  v_day  date := (coalesce(p_at, now()))::date;
  v_rate int;
  v_cap  int;
  v_count int := 0;
  v_total int := 0;
  v_fine_id uuid;
  v_charge int;
  r record;
begin
  if not can('fines.write') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot charge fines.');
  end if;

  v_rate := coalesce((select (value #>> '{}')::int from settings
                      where key = 'fine.defaultDailyRateCents'), 25);
  v_cap  := coalesce((select (value #>> '{}')::int from settings
                      where key = 'fine.maxPerFineCents'), 2000);

  for r in
    select l.id as loan_id, l.member_id, l.copy_id
    from loans l
    join members mem on mem.id = l.member_id
    join member_types mt on mt.key = mem.type
    where l.status = 'active'
      and l.returned_at is null
      -- Grace days shift when charges begin, not when the book was due.
      and v_at >= l.due_at + make_interval(days => mt.grace_days)
      and not mt.fine_exempt
  loop
    /*
     * One fine per loan, and exactly one charge per day for it.
     *
     * Written as two steps on purpose. The obvious version — insert a fine, then
     * check the ledger for today's marker — creates a *second* fine for the same
     * loan on the second run, because the insert is unconditional. The old fine
     * keeps its marker and the new one is fresh, so nothing stops the charge and the
     * student ends up with two overdue fines for one book.
     *
     * So: find the loan's fine, create it only if it is missing, and only charge
     * when today has not been charged yet.
     */
    select id into v_fine_id from fines
     where loan_id = r.loan_id and kind = 'overdue'
     order by assessed_at
     limit 1;

    if v_fine_id is null then
      insert into fines (member_id, loan_id, copy_id, kind, balance, note, created_by)
      values (r.member_id, r.loan_id, r.copy_id, 'overdue', 0, 'Overdue fine', current_user_id())
      returning id into v_fine_id;
    end if;

    -- The marker. This is the whole idempotency, and it lives in the ledger row
    -- rather than in a "last run" setting, so two concurrent runs cannot both
    -- decide they are first.
    if exists (select 1 from fine_txns t
                where t.fine_id = v_fine_id
                  and t.kind = 'charge'
                  and t.meta ->> 'day' = v_day::text) then
      continue;
    end if;

    -- Capped, so a term-longly-overdue loan does not produce a number nobody
    -- believes and nobody believes and pays.
    v_charge := least(v_rate, greatest(v_cap - (select balance from fines where id = v_fine_id), 0));
    if v_charge <= 0 then
      continue;
    end if;

    insert into fine_txns (fine_id, kind, amount, meta, actor_user_id)
    values (v_fine_id, 'charge', v_charge,
            jsonb_build_object('day', v_day::text, 'loan_id', r.loan_id),
            current_user_id());

    update fines set assessed_amount = assessed_amount + v_charge where id = v_fine_id;
    perform recompute_fine_balance(v_fine_id);

    v_count := v_count + 1;
    v_total := v_total + v_charge;
  end loop;

  return jsonb_build_object('ok', true, 'assessed', v_count, 'total_cents', v_total,
                            'day', v_day::text, 'rate_cents', v_rate, 'cap_cents', v_cap);
end
$$;

commit;