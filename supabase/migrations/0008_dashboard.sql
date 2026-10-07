-- ═══════════════════════════════════════════════════════════════════════
--  The dashboard.  VERSION 1
--
--  An at-a-glance page for the head of the library: how many titles, how many
--  copies, what is out, what is overdue, what students owe, how many students
--  are active. One function, so the numbers are computed in one place with the
--  same eyes as every other rule here — not assembled from six loose reads a
--  screen could outgrow.
--
--  Only an administrator sees it. The numbers are the whole library in six
--  counts, and the desk neither needs them nor is protected from misreading
--  them ("owed" without the "cents"). The gate is `reports.run`, the same
--  admin-only permission the reports screen uses: a dashboard is the when-you-
--  open-the-app report.
begin;

create or replace function get_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at       timestamptz := now();
  v_titles   int;
  v_copies   int;
  v_on_loan  int;
  v_overdue  int;
  v_fines    int;
  v_members  int;
begin
  if not can('reports.run') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot run the library figures.');
  end if;

  select count(*) into v_titles  from titles;
  select count(*) into v_copies  from copies;
  select count(*) into v_on_loan from loans where status = 'active';
  select count(*) into v_overdue from loans where status = 'active' and due_at < v_at;
  -- Money owed is what is still owed: settled balances are zero, and a note of
  -- what was once owed belongs to the fines register, not the front page.
  select coalesce(sum(balance), 0) into v_fines
    from fines where status in ('outstanding', 'partially_paid');
  select count(*) into v_members from members where status = 'active';

  return jsonb_build_object(
    'ok', true,
    'total_titles', v_titles,
    'total_copies', v_copies,
    'on_loan', v_on_loan,
    'overdue', v_overdue,
    'outstanding_fines', v_fines,
    'active_members', v_members);
end
$$;

-- The browser calls it (signed in), nobody anonymous does, and the 0005 blanket
-- revoke from PUBLIC predates this function — so PUBLIC must be closed by name
-- or the anon key could reach it that way.
grant execute on function get_dashboard() to authenticated;
revoke all on function get_dashboard() from anon;
revoke execute on function get_dashboard() from public;

commit;