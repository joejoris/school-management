-- ═══════════════════════════════════════════════════════════════════════
--  A fine by hand.  VERSION 1
--
--  The desk can already charge for overdue loans by pressing a button. This is
--  the other side of the same rule: a lost book, a damaged cover, a library
--  card gone missing — a charge nobody can set for you, assessed in a
--  conversation at the desk. The screen cannot write the row itself: since
--  0001 there has been no INSERT grant on `fines`, and `fine_txns` has never
--  had one, so the charge has to walk through a function that checks the same
--  permission every other money movement checks.
--
--  The ledger is why. A hand-assessed fine is a charge — a positive line in
--  the same ledger a payment pays down — so it is written there, and the
--  balance that register and reports read comes out of recompute_fine_balance
--  exactly as it does for an accrual charge or a payment. Any other door
--  (write the fine, skip the ledger) is a balance that cannot be explained by
--  the ledger that says it.
begin;

create or replace function assess_fine(
  p_member_id uuid,
  p_kind      fine_kind,
  p_amount    int,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member  members%rowtype;
  v_fine_id uuid;
begin
  if not can('fines.write') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot assess fines.');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount',
      'message', 'A fine must be more than zero shillings.');
  end if;

  select * into v_member from members where id = p_member_id;
  if v_member.id is null then
    return jsonb_build_object('ok', false, 'code', 'member_not_found',
      'message', 'No student on file with that number.');
  end if;

  insert into fines (member_id, kind, assessed_amount, note, created_by)
  values (p_member_id, p_kind, p_amount, p_note, current_user_id())
  returning id into v_fine_id;

  -- A charge is positive, following the ledger's convention (payment, waiver
  -- and refund are negative). The balance and status come from
  -- recompute_fine_balance, never from this function's own arithmetic.
  insert into fine_txns (fine_id, kind, amount, reason, actor_user_id)
  values (v_fine_id, 'charge', p_amount, p_note, current_user_id());

  perform recompute_fine_balance(v_fine_id);

  insert into audit (actor, action, entity, entity_id, after)
  values (current_user_id(), 'assess', 'fine', v_fine_id,
          jsonb_build_object('member_id', p_member_id, 'amount', p_amount,
                             'kind', p_kind, 'note', p_note));

  return jsonb_build_object('ok', true, 'fine_id', v_fine_id, 'assessed', p_amount);
end
$$;

-- The desk calls it (signed in), nobody anonymous does, and the 0005 blanket
-- revoke from PUBLIC predates this function — so PUBLIC must be closed by name
-- or the anon key could reach it that way.
grant execute on function assess_fine(uuid, fine_kind, integer, text) to authenticated;
revoke all on function assess_fine(uuid, fine_kind, integer, text) from anon;
revoke execute on function assess_fine(uuid, fine_kind, integer, text) from public;

commit;