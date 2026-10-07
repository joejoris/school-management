/**
 * The dashboard — the library at a glance.
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * Six counts and nothing more: titles, copies, what is out, what is overdue,
 * what students owe, how many students are active. It is for the head of the
 * library, opening the app to see how the library is doing — not for the desk,
 * which is serving the person in front of it and would have to push this aside
 * to do that. The counts come from one function on the backend, `get_dashboard`,
 * so they are computed with the same eyes as every other rule.
 *
 * ── Who sees it ──────────────────────────────────────────────────────
 *
 * Only administrators. The domain refuses the call without `reports.run` —
 * that permission is the decision, not this screen — so an assistant opening
 * the page sees the same sentence the desk sees everywhere else, rather than
 * six numbers the assistant is not supposed to be reading.
 */
import { useQuery } from '@tanstack/react-query'
import { type DashboardSummary } from '@library/contracts'
import { api } from '../../api'
import { Card } from '../../components/ui'
import { TriangleAlert } from '../../components/icons'

const money = (cents: number) => (cents / 100).toFixed(2)

const CELLS: ReadonlyArray<{ key: keyof DashboardSummary; label: string; money?: boolean }> = [
  { key: 'totalTitles', label: 'Titles' },
  { key: 'totalCopies', label: 'Copies' },
  { key: 'onLoan', label: 'Out now' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'outstandingFines', label: 'Owed', money: true },
  { key: 'activeMembers', label: 'Active students' },
]

export function Dashboard() {
  const figures = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.getDashboard(),
  })

  if (figures.isPending) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">Loading the figures…</p>
    )
  }
  if (figures.isError) {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          Could not load the figures. {figures.error instanceof Error ? figures.error.message : ''}
        </span>
      </p>
    )
  }

  const d = figures.data
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">The library at a glance, right now.</p>
      </header>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {CELLS.map((cell) => (
          <Card key={cell.key} className="p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {cell.label}
            </dt>
            <dd className="numeric mt-1 text-2xl font-semibold tracking-tight">
              {cell.money ? `KSh ${money(d[cell.key])}` : d[cell.key]}
            </dd>
          </Card>
        ))}
      </dl>
    </div>
  )
}