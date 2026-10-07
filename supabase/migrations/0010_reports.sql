-- ═══════════════════════════════════════════════════════════════════════
--  Reports, as one function.  VERSION 1
--
--  A report is a named slice of the register, flattened to the columns a
--  spreadsheet wants. Four of them, and each is the same data the screens
--  show, ordered the way a reader asks:
--
--    overdue    — what is out past its due date, earliest first
--    register   — the whole register, what is out now
--    owing      — every fine with a balance, biggest first, in shillings
--    catalogue  — every title, with its copies and how many are on the shelf
--
--  One function rather than four because they share a gate: only an
--  administrator may run them. `reports.run` is the same admin-only
--  permission the dashboard uses — a report is the whole library summarised,
--  which is the head's answer to "how are we doing", not the desk's. The
--  client could assemble these from raw reads and never trip a policy, which
--  is exactly why they do not: the permission has to be the database's
--  decision, so the numbers come through a security-definer function that
--  checks it, like everything else here.
--
--  The rows come out as strings, ready for a CSV: dates as YYYY-MM-DD,
--  money as shillings with two decimals, counts as whole numbers. A
--  spreadsheet opened in Excel should not be doing the formatting.
begin;

create or replace function run_report(p_report text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at   timestamptz := now();
  v_cols jsonb;
  v_rows jsonb;
begin
  if not can('reports.run') then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
      'message', 'Your role cannot run the reports.');
  end if;

  case p_report
    when 'overdue' then
      v_cols := jsonb_build_array('Admission no.'::text, 'Student'::text, 'Title'::text, 'Book no.'::text, 'Taken'::text, 'Due'::text);
      select coalesce(jsonb_agg(jsonb_build_array(
               m.member_code,
               m.first_name || ' ' || m.last_name,
               t.title,
               c.barcode,
               to_char(l.checked_out_at, 'YYYY-MM-DD'),
               to_char(l.due_at, 'YYYY-MM-DD'))), '[]'::jsonb)
        into v_rows
        from loans l
        join members m on m.id = l.member_id
        join copies  c on c.id = l.copy_id
        join titles  t on t.id = c.title_id
       where l.status = 'active'
         and l.due_at < v_at
       order by l.due_at;

    when 'register' then
      v_cols := jsonb_build_array('Admission no.'::text, 'Student'::text, 'Title'::text, 'Book no.'::text, 'Taken'::text, 'Due'::text);
      select coalesce(jsonb_agg(jsonb_build_array(
               m.member_code,
               m.first_name || ' ' || m.last_name,
               t.title,
               c.barcode,
               to_char(l.checked_out_at, 'YYYY-MM-DD'),
               to_char(l.due_at, 'YYYY-MM-DD'))), '[]'::jsonb)
        into v_rows
        from loans l
        join members m on m.id = l.member_id
        join copies  c on c.id = l.copy_id
        join titles  t on t.id = c.title_id
       where l.status = 'active'
       order by l.due_at;

    when 'owing' then
      v_cols := jsonb_build_array('Admission no.'::text, 'Student'::text, 'Reason'::text, 'Balance'::text, 'Status'::text, 'Note'::text);
      select coalesce(jsonb_agg(jsonb_build_array(
               m.member_code,
               m.first_name || ' ' || m.last_name,
               f.kind,
               to_char(f.balance::numeric / 100, 'FM999999999990.00'),
               f.status,
               coalesce(f.note, ''))), '[]'::jsonb)
        into v_rows
        from fines f
        join members m on m.id = f.member_id
       where f.balance > 0
       order by f.balance desc;

    when 'catalogue' then
      v_cols := jsonb_build_array('Call no.'::text, 'Title'::text, 'Author'::text, 'Copies'::text, 'On shelf'::text);
      select coalesce(jsonb_agg(jsonb_build_array(
               coalesce(t.call_number, ''),
               t.title,
               t.author,
               count(c.id)::text,
               count(c.id) filter (where c.status = 'on_shelf')::text)), '[]'::jsonb)
        into v_rows
        from titles t
        left join copies c on c.title_id = t.id
       group by t.id
       order by t.title;

    else
      return jsonb_build_object('ok', false, 'code', 'unknown_report',
        'message', 'That report is not one this library offers.');
  end case;

  return jsonb_build_object(
    'ok', true,
    'columns', v_cols,
    'rows', v_rows,
    'generated_at', v_at);
end
$$;

-- The head of the library calls it (signed in), nobody anonymous does, and
-- the 0005 blanket revoke from PUBLIC predates this function — so PUBLIC must
-- be closed by name or the anon key could reach it that way.
grant execute on function run_report(text) to authenticated;
revoke all on function run_report(text) from anon;
revoke execute on function run_report(text) from public;

commit;