/**
 * What can be done to one physical copy.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * There was no way to take a book out of circulation. \`withdrawCopy\` and
 * \`updateCopy\` existed in the domain and nothing could reach them.
 *
 * The only route to "this book is not lendable" was reporting lost on a loan — which
 * requires somebody to have borrowed it first. So a copy found on the shelf with a
 * torn cover, or water-damaged, or missing pages, could not be marked as such. It
 * sat in the catalogue as "available" and the next librarian to be handed that
 * barcode issued it.
 *
 * That is the worst kind of wrong in this system: the register says the book is
 * fine, the shelf says otherwise, and the evidence is a torn spine.
 *
 * ── Three actions, and they are not the same ─────────────────────────
 *
 * - **Mark damaged**: the condition is recorded and the copy goes back on the shelf.
 *   A scuffed cover is still lendable.
 * - **Withdraw**: out of circulation entirely, with a reason. The repair shelf.
 * - **Report lost**: gone. Only sensible for a book that was out on loan.
 *
 * Damaged and withdrawn are deliberately separate. "Damaged" that quietly takes the
 * book off the shelf is the version nobody can undo from the catalogue, because the
 * button that did it says "Damaged".
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Copy } from '@library/contracts'
import { api } from '../../api'
import { Button, Field, Input, cn } from '../../components/ui'

export function CopyActions({ copy }: { copy: Copy }) {
  const queryClient = useQueryClient()
  const [asking, setAsking] = useState<'damaged' | 'withdrawn' | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const offShelf = copy.status !== 'on_shelf'

  /*
   * `what` rather than the open panel's state, so restoring works from the closed
   * state too — there is no panel open when you put a book back.
   */
  const act = useMutation({
    mutationFn: async (what: 'damaged' | 'withdrawn' | 'restore') => {
      setBusy(true)
      if (what === 'damaged') {
        await api.updateCopy(copy.id, { condition: 'damaged' })
      } else if (what === 'withdrawn') {
        // A reason is required, and the domain refuses without one — same rule as a
        // void, for the same reason: a book that vanished with no explanation cannot
        // be chased.
        await api.withdrawCopy(copy.id, reason.trim())
      } else {
        // Repaired, or found. The condition goes back to good with it, because a
        // copy restored to the shelf while still marked damaged would show as
        // "available" and be issued damaged all over again.
        await api.updateCopy(copy.id, { status: 'on_shelf', condition: 'good' })
      }
    },
    onSuccess: async () => {
      setBusy(false)
      setError(null)
      setAsking(null)
      setReason('')
      await queryClient.invalidateQueries({ queryKey: ['title'] })
      await queryClient.invalidateQueries({ queryKey: ['titles'] })
    },
    onError: (e: unknown) => {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'That did not work.')
    },
  })

  if (asking) {
    return (
      <div className="mt-2 rounded-md border border-border bg-card p-3">
        <p className="text-sm font-medium">
          {asking === 'damaged' ? 'Mark this copy damaged' : 'Withdraw this copy'}
        </p>

        {asking === 'damaged' ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Its condition is recorded and it goes back on the shelf. Use this for a
            scuffed cover, not for a book that should not be lent.
          </p>
        ) : (
          <Field label="Reason" htmlFor={`withdraw-${copy.id}`} hint="Required and kept.">
            <Input
              id={`withdraw-${copy.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Water damage"
              autoFocus
            />
          </Field>
        )}

        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || (asking === 'withdrawn' && reason.trim().length === 0)}
            onClick={() => act.mutate(asking === 'damaged' ? 'damaged' : 'withdrawn')}
          >
            {busy ? 'Working…' : asking === 'damaged' ? 'Mark it damaged' : 'Withdraw it'}
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

  if (offShelf) {
    // Withdrawn, lost, in repair, or out on loan. None of the three buttons would do
    // anything useful, and a row of buttons that always say no is worse than none.
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => act.mutate('restore')}
        >
          Put back on the shelf
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn(copy.condition !== 'good' && 'text-muted-foreground')}
        onClick={() => {
          setError(null)
          setAsking('damaged')
        }}
      >
        Mark damaged
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={() => {
          setError(null)
          setAsking('withdrawn')
        }}
      >
        Withdraw
      </Button>
    </div>
  )
}