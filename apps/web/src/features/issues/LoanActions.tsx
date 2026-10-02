/**
 * The per-loan panel: return, renew, void, lost.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * A book could go out but could not come back. \`returnLoan\`, \`voidLoan\`, \`renew\`
 * and \`markLost\` were all implemented and all tested, and none of them was reachable
 * from a screen — so a register could only grow, and one that grows forever can
 * never be right.
 *
 * ── Four actions, not one, because they are four different claims ───
 *
 * The book came back. The book is being kept another fortnight. This was never a
 * loan. The book is gone.
 *
 * They cannot be one action with a dropdown: void and mark-lost both need a written
 * reason and are the two a librarian is most likely to press by mistake, so they
 * are the two that should be hardest to reach.
 *
 * ── The condition a book comes back in ───────────────────────────────
 *
 * Asked, because it is the origin of a damage fine and a repair record, and it
 * cannot be recovered later: nobody remembers that the cover was torn.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CopyCondition } from '@library/contracts'
import { api } from '../../api'
import { Button, Field, cn } from '../../components/ui'

const CONDITIONS: { value: CopyCondition; label: string }[] = [
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
]

export function LoanActions({ loanId }: { loanId: string }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [condition, setCondition] = useState<CopyCondition>('good')
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState<'return' | 'void' | 'lost' | null>(null)

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['loans'] })
    await queryClient.invalidateQueries({ queryKey: ['titles'] })
    await queryClient.invalidateQueries({ queryKey: ['title'] })
  }

  const act = useMutation({
    mutationFn: async (what: 'return' | 'renew' | 'void' | 'lost') => {
      setBusy(what)
      switch (what) {
        case 'return': {
          const result = await api.returnLoan({ loanId, conditionIn: condition })
          // A refusal is a sentence the librarian reads, not an exception to swallow.
          // Told the software had failed, somebody would press it again.
          if (!result.ok) throw new Error(result.message)
          return
        }
        case 'renew': {
          const result = await api.renew({ loanId })
          if (!result.ok) throw new Error(result.message)
          return
        }
        case 'void': {
          const result = await api.voidLoan(loanId, reason.trim())
          /*
           * The same shape as the two cases above it.
           *
           * This used to be the one action that could only fail by throwing, so a void
           * with no reason reached the error box as an exception while a return with a
           * bad condition reached it as a sentence — two failure shapes for the same
           * kind of mistake, and neither one better for the person reading it.
           */
          if (!result.ok) throw new Error(result.message)
          return
        }
        case 'lost':
          await api.markLost(loanId, reason.trim())
          return
      }
    },
    onSuccess: async () => {
      setError(null)
      setAsking(null)
      setReason('')
      setBusy(null)
      await invalidate()
    },
    onError: (e: unknown) => {
      setBusy(null)
      setError(e instanceof Error ? e.message : 'That did not work.')
    },
  })

  if (asking) {
    const isReturn = asking === 'return'
    return (
      <div className="rounded-lg border border-border bg-secondary/40 p-3">
        <p className="text-sm font-medium">
          {isReturn ? 'What condition is it in?' : asking === 'lost' ? 'Report it lost' : 'Void this loan'}
        </p>

        {isReturn ? (
          <Field label="Condition" htmlFor={`condition-${loanId}`}>
            <select
              id={`condition-${loanId}`}
              value={condition}
              onChange={(e) => setCondition(e.target.value as CopyCondition)}
              className="h-11 w-full rounded-lg border border-input bg-card px-3"
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field
            label="Reason"
            htmlFor={`reason-${loanId}`}
            hint={
              asking === 'lost'
                ? 'Required. This is the first thing anyone will ask.'
                : 'Required. A void with no reason is indistinguishable from a deletion.'
            }
          >
            <input
              id={`reason-${loanId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={asking === 'lost' ? 'Not returned; family informed' : 'Wrong admission number'}
              className="h-11 w-full rounded-lg border border-input bg-card px-3"
            />
          </Field>
        )}

        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!isReturn && reason.trim().length === 0}
            onClick={() => act.mutate(asking)}
          >
            {busy ? 'Working…' : isReturn ? 'Record the return' : asking === 'lost' ? 'Report lost' : 'Void it'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setAsking(null)
              setError(null)
              setReason('')
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" onClick={() => setAsking('return')}>
        Return
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy !== null}
        onClick={() => act.mutate('renew')}
      >
        Renew
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn('text-muted-foreground')}
        onClick={() => setAsking('void')}
      >
        Void
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn('text-destructive')}
        onClick={() => setAsking('lost')}
      >
        Lost
      </Button>

      {error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}