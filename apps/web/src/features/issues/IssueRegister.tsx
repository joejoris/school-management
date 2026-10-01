/**
 * The issue register — the school's paper register, on screen.
 *
 * ── Columns are the paper's columns ─────────────────────────────────
 *
 * Admission number, name, form and stream, book title, book number, date taken,
 * date due, date returned. Every one of those is something a librarian already
 * reads off a line in a book, and a register that cannot show what the paper
 * showed is not a register anybody trusts during an audit.
 *
 * ── Why it is cards on a phone and a table on a screen ───────────────
 *
 * Ten columns of codes and dates do not fit in 343 pixels. A horizontally
 * scrolling table on a phone means every row needs careful alignment to read,
 * and the most likely reading — the admission number and the book number — are
 * the two that scrolled off. One column of stacked facts per loan keeps the two
 * that matter visible first.
 *
 * Both renderings read from the same `LoanRow`s, so they cannot disagree about
 * what is in the register; only the layout differs.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LOAN_FILTERS, type LoanFilter, type LoanRow } from '@library/contracts'
import { api } from '../../api'
import { Button, Card, Field, Input, cn } from '../../components/ui'
import { Search, TriangleAlert } from '../../components/icons'
import { LoanActions } from './LoanActions'
import { REGISTER_COLUMNS, download, registerRow, toCsv } from '../../lib/csv'

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : '—'

/** "Form 3, Red Stream" — whichever parts the school actually recorded. */
const cohort = (r: LoanRow) =>
  [r.form, r.stream].filter(Boolean).join(', ') || r.grade || '—'

export function IssueRegister() {
  const [filter, setFilter] = useState<LoanFilter>('on_loan')
  const [q, setQ] = useState('')
  const [onlyOverdue, setOnlyOverdue] = useState(false)

  const loans = useQuery({
    queryKey: ['loans', filter, q],
    queryFn: () => api.listLoans({ limit: 100, offset: 0, status: filter, q: q.trim() || undefined }),
  })

  const rows = onlyOverdue ? (loans.data?.items ?? []).filter((r) => r.daysOverdue > 0) : (loans.data?.items ?? [])

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Issue register</h1>
        <p className="text-sm text-muted-foreground">
          Every book out, and everything that came back.
        </p>
      </header>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Search" htmlFor="register-search">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="register-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Admission number, name, title or book number"
                className="pl-9"
              />
            </div>
          </Field>

          <div className="flex items-end">
            <Button
              type="button"
              variant={onlyOverdue ? 'default' : 'outline'}
              onClick={() => setOnlyOverdue((v) => !v)}
              aria-pressed={onlyOverdue}
            >
              Overdue only
            </Button>
          </div>
        </div>

        {/*
          The register as a file.

          *
           * A school keeps a paper register, and the head teacher asks for it. At the
           * end of a term somebody is expected to produce a list of what is out and
           * what came back. Without this that is either retype it from the screen — which
           * is how the register and the report drift apart — or photograph the screen,
           * which nobody does twice.
           *
           * Built from the rows already on the page rather than asking the domain again.
           * An export that fetched a different slice — everything rather than what is
           * filtered, a fresh ordering — would be a register that did not match the one
           * on screen, which defeats the purpose.
           */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={rows.length === 0}
            onClick={() =>
              download(
                `register-${filter}-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv([...REGISTER_COLUMNS], rows.map(registerRow)),
              )
            }
          >
            Download these rows
          </Button>

          {/*
           * The count beside the button, because "what am I about to download" is the
           * question. A filter that quietly exported everything is worse than no export,
           * because it looks like the one on screen.
           */}
          <p className="text-xs text-muted-foreground">
            {rows.length === 0
              ? 'Nothing to download.'
              : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} — the ones on screen`}
          </p>
        </div>

        {/*
          The filter is radio buttons, not a <select>.

          A select on a phone is a full-screen overlay that hides the register you
          are choosing a filter for. Five options that fit in a row on any screen
          do not need a menu.
        */}
        <fieldset className="mt-4">
          <legend className="sr-only">Which loans to show</legend>
          <div className="flex flex-wrap gap-1">
            {LOAN_FILTERS.map((f) => (
              <label
                key={f}
                className={cn(
                  'cursor-pointer rounded-lg border px-3 py-2 text-sm capitalize',
                  'has-focus-visible:outline-2 has-focus-visible:outline-ring',
                  filter === f
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-card hover:bg-secondary',
                )}
              >
                <input
                  type="radio"
                  name="loan-filter"
                  value={f}
                  checked={filter === f}
                  onChange={() => setFilter(f)}
                  className="sr-only"
                />
                {f.replace('_', ' ')}
              </label>
            ))}
          </div>
        </fieldset>
      </Card>

      {loans.isPending ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading the register…</p>
      ) : loans.isError ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>Could not load the register. {loans.error instanceof Error ? loans.error.message : ''}</span>
        </p>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing matches. {filter === 'on_loan' ? 'No books are out.' : ''}
        </p>
      ) : (
        <>
          {/* Phone and tablet. One stacked card per loan. */}
          <ul className="grid gap-3 md:hidden">
            {rows.map((r) => (
              <li key={r.loanId}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="numeric text-sm font-semibold">{r.memberCode}</p>
                      <p className="truncate text-sm">{r.studentName}</p>
                      <p className="text-xs text-muted-foreground">{cohort(r)}</p>
                    </div>
                    <Status r={r} />
                  </div>

                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border pt-3 text-sm">
                    <dt className="text-muted-foreground">Book</dt>
                    <dd className="min-w-0 truncate">{r.title}</dd>
                    <dt className="text-muted-foreground">Number</dt>
                    <dd className="numeric">{r.barcode}</dd>
                    <dt className="text-muted-foreground">Taken</dt>
                    <dd className="numeric">{date(r.checkedOutAt)}</dd>
                    <dt className="text-muted-foreground">Due</dt>
                    <dd className="numeric">{date(r.dueAt)}</dd>
                    {r.returnedAt ? (
                      <>
                        <dt className="text-muted-foreground">Returned</dt>
                        <dd className="numeric">{date(r.returnedAt)}</dd>
                      </>
                    ) : null}
                    {r.voidReason ? (
                      <>
                        <dt className="text-muted-foreground">Voided</dt>
                        <dd>{r.voidReason}</dd>
                      </>
                    ) : null}
                  </dl>

                  {/*
                    Only while the book is actually out. On a returned loan the four
                    buttons would all be refused by the domain, and a row of buttons
                    that always say no is worse than no buttons.
                  */}
                  {r.status === 'active' ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <LoanActions loanId={r.loanId} />
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>

          {/* Wide screens. The paper register's columns. */}
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Loans matching the current search and filter, {rows.length} shown
              </caption>
              <thead className="border-b border-border bg-secondary/50 text-left">
                <tr>
                  {['No.', 'Student', 'Form / stream', 'Book', 'Book no.', 'Taken', 'Due', 'Returned'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2.5 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.loanId} className="border-b border-border last:border-0">
                    <td className="numeric px-3 py-2 whitespace-nowrap">{r.memberCode}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.studentName}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{cohort(r)}</td>
                    <td className="max-w-48 truncate px-3 py-2">{r.title}</td>
                    <td className="numeric px-3 py-2 whitespace-nowrap">{r.barcode}</td>
                    <td className="numeric px-3 py-2 whitespace-nowrap">{date(r.checkedOutAt)}</td>
                    <td className="numeric px-3 py-2 whitespace-nowrap">{date(r.dueAt)}</td>
                    <td className="numeric px-3 py-2 whitespace-nowrap">
                      {r.returnedAt ? date(r.returnedAt) : <Status r={r} />}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === 'active' ? <LoanActions loanId={r.loanId} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {loans.data && loans.data.hasMore ? (
            <p className="text-center text-sm text-muted-foreground">
              Showing {rows.length} of {loans.data.total}. Narrow the search to see the rest.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * The status of one loan, as a word.
 *
 * Overdue first and loudest, because it is the only status anybody acts on
 * without being asked. "Voided" carries its reason here rather than only on a
 * detail screen, because a void in a register with no explanation is the thing
 * an auditor asks about.
 */
function Status({ r }: { r: LoanRow }) {
  if (r.status === 'void') {
    return (
      <span className="shrink-0 text-right text-xs text-muted-foreground">
        Voided
        {r.voidReason ? <span className="block max-w-40">{r.voidReason}</span> : null}
      </span>
    )
  }
  if (r.status === 'returned') {
    return <span className="shrink-0 text-xs text-muted-foreground">Returned</span>
  }
  if (r.daysOverdue > 0) {
    return (
      <span className="shrink-0 rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive whitespace-nowrap">
        {r.daysOverdue}d overdue
      </span>
    )
  }
  return <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">On loan</span>
}