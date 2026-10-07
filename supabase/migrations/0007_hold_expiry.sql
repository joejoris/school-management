-- ═══════════════════════════════════════════════════════════════════════
--  Holds: the queue moves.  VERSION 1
--
--  A hold promised the book for three days, and nothing made good on the
--  promise. `hold_status` has listed 'expired' since 0001 and nothing ever
--  wrote it: a filled hold nobody collected sat at the desk forever, still
--  reading "ready", and the students behind it waited behind a book that
--  would never come.
--
--  This file makes the queue move:
--
--   - `sweep_holds()` lapses filled holds past their deadline, releases the
--     copy, and passes the promise to the next member in line;
--   - `issue_book()` will not hand a held copy to somebody it is not held
--     for, and lets the member it is held for take it — marking the hold
--     'collected' so their record stops reading "ready";
--   - the circulation functions sweep on the way in, the same on-access
--     pattern `run_fine_accrual` established. A school has no job runner;
--     time-based rules run when somebody uses the system, which is the only
--     moment they can act on the result anyway.
--
--  Runs after RUN-THIS.sql (which finishes 0006). You can paste this file
--  into the SQL Editor on its own.
begin;

alter type hold_status add value if not exists 'collected';

-- ── the sweep ────────────────────────────────────────────────────────────
--
--  Called from the circulation functions below, never by the client. Returns
--  how many holds lapsed and how many promises passed on, for a desk that
--  wants to know the queue moved.

create or replace function sweep_holds(p_at timestamptz default null)
returns table (expired_hold int, promoted_hold int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at          timestamptz := coalesce(p_at, now());
  v_expired     int := 0;
  v_promoted    int := 0;
  v_next_hold   uuid;
  v_next_member uuid;
  r             record;
begin
  -- Filled holds whose three days ran out. The join skips copies that have
  -- gone out again: a collected hold's copy is on loan, and sweeping it would
  -- set a book somebody is reading back on the shelf.
  for r in
    select h.id as hold_id, h.member_id, h.copy_id, c.title_id
      from holds h
      join copies c on c.id = h.copy_id
     where h.status = 'filled'
       and h.expires_at is not null
       and h.expires_at < v_at
       and c.status in ('at_desk', 'on_shelf')
     order by h.placed_at, h.id
  loop
    update holds set status = 'expired' where id = r.hold_id;

    insert into audit (actor, action, entity, entity_id, after)
    values (current_user_id(), 'hold_expired', 'hold', r.hold_id,
            jsonb_build_object('member_id', r.member_id, 'copy_id', r.copy_id));

    v_expired := v_expired + 1;

    -- The promise passes to the next member in line — the same choice
    -- `return_book` makes when a copy comes back.
    select h2.id, h2.member_id into v_next_hold, v_next_member
      from holds h2
     where h2.title_id = r.title_id
       and h2.status = 'open'
     order by h2.placed_at, h2.id
     limit 1;

    if v_next_hold is not null then
      update holds
         set status = 'filled', copy_id = r.copy_id, expires_at = v_at + interval '3 days'
       where id = v_next_hold;
      insert into audit (actor, action, entity, entity_id, after)
      values (current_user_id(), 'hold_filled', 'hold', v_next_hold,
              jsonb_build_object('member_id', v_next_member, 'copy_id', r.copy_id));
      v_promoted := v_promoted + 1;
    else
      -- Nobody waiting: the book leaves the desk pile for the shelf.
      update copies set status = 'on_shelf' where id = r.copy_id and status = 'at_desk';
    end if;
  end loop;

  expired_hold := v_expired;
  promoted_hold := v_promoted;
  return next;
end
$$;

-- ── issuing ──────────────────────────────────────────────────────────────
--
--  One new rule: a copy a filled hold pins belongs to the student it is held
--  for until it lapses or is collected. `sweep_holds` ran at the top of this
--  function, so any pin still standing here is a live promise — not a stale
--  one waiting to be cleared.

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
  v_hold     holds%rowtype;
begin
  if not can('loans.checkout') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot issue books.');
  end if;

  perform sweep_holds(v_at);

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

  -- A filled hold pins this copy to one student. The member it is for may take
  -- the book — and must be allowed to, even from the desk pile; anyone else may
  -- not, whatever pile it is in.
  select * into v_hold from holds
   where copy_id = v_copy.id
     and status = 'filled'
     and expires_at > v_at
   limit 1;
  if v_hold.id is not null and v_hold.member_id <> v_member.id then
    return jsonb_build_object('ok', false, 'code', 'copy_reserved',
      'message', 'That book is being held for another student. Let the queue serve them first.',
      'overridable', false);
  end if;
  if v_hold.id is not null and v_hold.member_id = v_member.id then
    -- Collecting. The promise is spent: the book is now on loan to them, and
    -- their record stops reading "ready — collect by".
    update holds set status = 'collected' where id = v_hold.id;
    insert into audit (actor, action, entity, entity_id, after)
    values (current_user_id(), 'hold_collected', 'hold', v_hold.id,
            jsonb_build_object('member_id', v_member.id, 'copy_id', v_copy.id));
  elsif v_copy.status <> 'on_shelf' then
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

-- ── returning ────────────────────────────────────────────────────────────
--
--  The original 0002 logic, plus the sweep at the top: a return is the natural
--  moment to clear a promise nobody kept.

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

  perform sweep_holds(v_at);

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

-- ── renewing ─────────────────────────────────────────────────────────────
--
--  The original 0002 logic, plus the sweep at the top and the declaration it
--  always needed: it referenced `v_at` (in the issued-in-future check) without
--  declaring it, which compiles the first time somebody renews and raises
--  there. Declared to `now()`, so the check has its intended meaning: nothing
--  a renewal can produce is a future-dated loan.

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
  v_at     timestamptz := now();
begin
  if not can('loans.renew') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot renew loans.');
  end if;

  perform sweep_holds(v_at);

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

-- The sweep is an internal step, not something a browser ever calls. The 0005
-- blanket revoke from PUBLIC predates this function, and CREATE FUNCTION grants
-- EXECUTE to PUBLIC by default — so close it by name. No grants anywhere.
revoke execute on function sweep_holds(timestamptz) from public;
revoke all on function sweep_holds(timestamptz) from anon;

commit;