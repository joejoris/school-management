/**
 * Fines: who owes, in total.
 *
 * ── The other question from the student's page ───────────────────────
 *
 * The student page answers "what does this person owe". This one answers "who owes",
 * which is a different question with a different audience: a librarian deciding
 * whether to chase somebody, or a head teacher asking for a number at the end of
 * term.
 *
 * Payments are not taken here. They are taken on the student's own page, because
 * that happens in a conversation with that student — and splitting collect-from-
 * somebody into a screen they are not standing at means the conversation and the
 * money come apart. Every row here links to where that happens.
 *
 * ── The accrual is run by hand, and that is deliberate ────────────────
 *
 * Fines are computed when this is pressed, not while somebody is reading. A balance
 * that changes under the cursor is not an answer to anything, and a schedule that
 * nobody can see is a schedule nobody trusts.
 *
 * "Run now" says exactly what it does, and says how many loans it charged, so a
 * librarian who presses it twice in a row can see the second press do nothing —
 * which is the behaviour, and worth demonstrating rather than hiding.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api } from '../../api'
import { Button, Card, cn } from '../../components/ui'
import { TriangleAlert } from '../../components/icons'

const money = (cents: number) => (cents / 100).toFixed(2)

export function Fines() {
  const queryClient = useQueryClient()
  const [result, setResult] = useState<string | null>(null)

  const outstanding = useQuery({
    queryKey: ['fines-all'],
    queryFn: () => api.getFines({ limit: 200, offset: 0 }),
    staleTime: 5_000,
  })

  const accrue = useMutation({
    mutationFn: () => api.runAccrual(),
    onSuccess: async (r) => {
      // Saying what it did, including when it did nothing. The second press of a
      // day charging nothing is the behaviour worth showing somebody.
      setResult(
        r.assessed === 0
          ? 'Nothing was charged — either nothing is overdue, or today has already been charged.'
          : `Charged ${r.assessed} ${r.assessed === 1 ? 'loan' : 'loans'}, ${money(r.totalCents)} in total.`,
      )
      await queryClient.invalidateQueries({ queryKey: ['fines'] })
      await queryClient.invalidateQueries({ queryKey: ['fines-all'] })
      await queryClient.invalidateQueries({ queryKey: ['members'] })
    },
  })

  const owing = (outstanding.data?.items ?? []).filter((f) => f.balance > 0)
  const total = owing.reduce((sum, f) => sum + f.balance, 0)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Fines</h1>
          <p className="text-sm text-muted-foreground">
            {owing.length === 0 ? (
              'Nobody owes anything.'
            ) : (
              <>
                <span className="numeric font-medium text-foreground">{owing.length}</span>{' '}
                {owing.length === 1 ? 'person owes' : 'people owe'} a total of{' '}
                <span className="numeric font-medium text-foreground">{money(total)}</span>.
              </>
            )}
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          disabled={accrue.isPending}
          onClick={() => accrue.mutate()}
        >
          {accrue.isPending ? 'Charging…' : 'Charge overdue fines'}
        </Button>
      </header>

      {result ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
        >
          {result}
        </p>
      ) : null}

      {outstanding.isPending ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : outstanding.isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Could not load the fines. {outstanding.error instanceof Error ? outstanding.error.message : ''}
        </p>
      ) : owing.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="font-medium">Nothing owing.</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            A fine appears here the day after a book is overdue, once the grace period
            has passed.
          </p>
        </Card>
      ) : (
        <ul className="grid gap-2">
          {owing.map((f) => (
            <li key={f.id}>
              <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    <span className="numeric">{f.memberCode}</span>
                    {' — '}
                    {f.memberName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    <span className="capitalize">{f.kind}</span>
                    {' · '}
                    <span className="numeric">{money(f.balance)}</span>
                    {f.note ? ` · ${f.note}` : ''}
                  </p>
                </div>

                <p className={cn('numeric shrink-0 text-lg font-semibold')}>
                  {money(f.balance)}
                </p>

                {/*
                  To the student, not to a payment form here.

                  Money changes hands in a conversation with that student, so the
                  button goes where their record is. A "collect" form on this screen
                  would be a second place to enter the same payment, and two places is
                  one too many.
                */}
                <Button asChild size="sm" variant="outline">
                  <Link to="/students">Open</Link>
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Fines are charged once per loan per day, and each fine stops at its cap.
          Teachers are not charged at all. Pressing the button twice on the same day
          will tell you it charged nothing the second time.
        </span>
      </p>
    </div>
  )
}