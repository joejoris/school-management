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
 * ── Four buckets, all on one screen ─────────────────────────────────
 *
 * On loan, Overdue, Returned, Void. A single "pick a filter" radio makes a
 * librarian at a busy desk open one bucket at a time and go hunting for the
 * others; the whole point of a register is to see the state of play at a glance.
 *
 * The four buckets are shown together, each as its own section, so the desk and
 * the whole feel of the week are visible at once. Overdue is pulled out of
 * "On loan" because an overdue book is the only thing on the register anybody
 * can act on without being asked. Each still offers its real actions — return,
 * void, renew — and a free "set the status" box would be worse: it would let a
 * loan say it was returned without a return date, or void without a reason,
 * which is the exact thing the domain refuses everywhere else.
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { type LoanRow } from '@library/contracts'
import { api } from '../../api'
import { Button, Card, Field, Input } from '../../components/ui'
import { Search, TriangleAlert } from '../../components/icons'
import { LoanActions } from './LoanActions'
import { REGISTER_COLUMNS, download, registerRow, toCsv } from '../../lib/csv'

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : '—'

/** "Form 3, Red Stream" — whichever parts the school actually recorded. */
const cohort = (r: LoanRow) => [r.form, r.stream].filter(Boolean).join(', ') || r.grade || '—'

export function IssueRegister() {
  const [q, setQ] = useState('')

  const loans = useQuery({
    queryKey: ['loans', 'all', q],
    queryFn: () => api.listLoans({ limit: 200, offset: 0, status: 'all', q: q.trim() || undefined }),
  })

  if (loans.isPending) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">Loading the register…</p>
    )
  }
  if (loans.isError) {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          Could not load the register. {loans.error instanceof Error ? loans.error.message : ''}
        </span>
      </p>
    )
  }

  const rows = loans.data?.items ?? []
  const active = rows.filter((r) => r.status === 'active')
  const overdue = active.filter((r) => r.daysOverdue > 0)
  const onLoan = active.filter((r) => r.daysOverdue <= 0)
  const returned = rows.filter((r) => r.status === 'returned')
  const voidd = rows.filter((r) => r.status === 'void')

  const buckets: { key: string; title: string; rows: LoanRow[] }[] = [
    { key: 'overdue', title: 'Overdue', rows: overdue },
    { key: 'on-loan', title: 'On loan', rows: onLoan },
    { key: 'returned', title: 'Returned', rows: returned },
    { key: 'void', title: 'Void', rows: voidd },
  ]

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Issue register</h1>
        <p className="text-sm text-muted-foreground">
          Overdue, on loan, returned and voided — all at a glance.
        </p>
      </header>

      <Card className="p-4">
        <div className="grid gap-3">
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
        </div>

        {/*
          The register as a file.

          An export reads the rows on screen, rather than asking the domain again,
          so the file always matches what a librarian is looking at.
        */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={rows.length === 0}
            onClick={() =>
              download(
                `register-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv([...REGISTER_COLUMNS], rows.map(registerRow)),
              )
            }
          >
            Download these rows
          </Button>
          <p className="text-xs text-muted-foreground">
            {rows.length === 0
              ? 'Nothing to download.'
              : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} — the ones on screen`}
          </p>
        </div>
      </Card>

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing matches. No books are out.
        </p>
      ) : null}

      {buckets.map(({ key, title, rows: b }) => (
        <section key={key} aria-label={title} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            {title} · {b.length}
          </h2>
          {b.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">None.</p>
          ) : (
            <>
              {/* Phone and tablet. One stacked card per loan. */}
              <ul className="grid gap-3 lg:hidden">
                {b.map((r) => (
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
              <Card className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    {title} loans, {b.length} shown
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
                    {b.map((r) => (
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
            </>
          )}
        </section>
      ))}

      {loans.data && loans.data.hasMore ? (
        <p className="text-center text-sm text-muted-foreground">
          Showing the first {rows.length}. Narrow the search to see the rest.
        </p>
      ) : null}
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
