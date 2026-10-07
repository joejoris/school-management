/**
 * Reports: the library's numbers, as a CSV.
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * Four named slices of the register, each one a file a head teacher can open
 * in a spreadsheet or keep for filing: what is overdue, what is out, who owes,
 * and the catalogue. The rows are computed by `run_report` on the backend —
 * one function with the same permission and the same eyes as everything else —
 * so the door the numbers arrive through is the same door the dashboard is.
 *
 * ── Who uses it ──────────────────────────────────────────────────────
 *
 * Only administrators. The domain refuses the call without `reports.run`,
 * so a button pressed without that permission lands as the sentence rather
 * than a file — the desk is not the audience for "the whole library
 * summarised", and it is not left to the interface to decide who sees it.
 *
 * The CSV is built in the browser from the report's columns and rows, the
 * same way the backup is written: quoted where a spreadsheet would read a
 * comma wrong, with a byte-order mark so the shillings survive Excel.
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ReportId, type ReportResult } from '@library/contracts'
import { api } from '../../api'
import { Button, Card } from '../../components/ui'
import { TriangleAlert } from '../../components/icons'

const REPORTS: ReadonlyArray<{
  id: ReportId
  name: string
  blurb: string
}> = [
  {
    id: 'overdue',
    name: 'Overdue books',
    blurb: 'Everything out past its due date, earliest first.',
  },
  {
    id: 'register',
    name: 'All loans out',
    blurb: 'The whole register — what the desks say is out, row by row.',
  },
  {
    id: 'owing',
    name: 'Who owes',
    blurb: 'Every fine with a balance, biggest first, in shillings.',
  },
  {
    id: 'catalogue',
    name: 'Catalogue',
    blurb: 'Every title, with its copies and how many are on the shelf.',
  },
]

/**
 * Columns and rows into a file a spreadsheet will not mangle.
 *
 * A field holding a comma, a quote or a newline is quoted and its quotes
 * doubled. The byte-order mark at the front is what tells Excel the file is
 * UTF-8 rather than the local single-byte codepage — without it the shillings
 * and student names are the characters Excel guesses them to be.
 */
function toCsv(r: ReportResult): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return `\uFEFF${[r.columns, ...r.rows].map((row) => row.map(esc).join(',')).join('\r\n')}`
}

export function Reports() {
  const [status, setStatus] = useState<string | null>(null)

  const download = useMutation({
    mutationFn: (id: ReportId) => api.runReport(id),
    onSuccess: (report, id) => {
      const blob = new Blob([toCsv(report)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `library-${id}-${(report.generatedAt ?? '').slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoked immediately, like the backup: a blob URL left alive holds the
      // whole report in memory for as long as the page.
      URL.revokeObjectURL(url)
      setStatus(`Saved ${REPORTS.find((r) => r.id === id)?.name.toLowerCase() ?? id} to your downloads.`)
    },
  })

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          The library’s numbers as a CSV, for a spreadsheet or for filing.
        </p>
      </header>

      {download.isError ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Could not run that report. {download.error instanceof Error ? download.error.message : ''}
          </span>
        </p>
      ) : null}
      {status ? (
        <p role="status" className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
          {status}
        </p>
      ) : null}

      <ul className="grid gap-2">
        {REPORTS.map((r) => (
          <li key={r.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.name}</p>
                <p className="text-sm text-muted-foreground">{r.blurb}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={download.isPending}
                onClick={() => download.mutate(r.id)}
              >
                {download.isPending ? 'Preparing…' : 'Download CSV'}
              </Button>
            </Card>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        Reports are for the head of the library. They read the whole library in
        one file, so the domain lets only an administrator run them.
      </p>
    </div>
  )
}