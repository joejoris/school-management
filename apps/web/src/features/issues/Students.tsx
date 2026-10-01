/**
 * Students: find somebody, and see what they owe and what they have out.
 *
 * ── Why this is the screen that was missing ──────────────────────────
 *
 * Until now a student could only be found by typing their exact admission number
 * into the issue form. So when a checkout was refused — they are at their limit,
 * they owe too much, their record is suspended — the librarian got one sentence and
 * nowhere to look. The sentence is the right thing to show; being unable to do
 * anything with it is not.
 *
 * This is where the sentence is answered. The balance that caused it, the books
 * behind it, and the two buttons that change it.
 *
 * ── Money is settled here, not on a separate screen ──────────────────
 *
 * A fine is only ever collected at the moment somebody hands money over, which
 * happens while the librarian is talking to that student. Splitting "who owes" from
 * "take payment" would mean the librarian reads one screen, walks to another, and
 * comes back — for a conversation that is already happening.
 *
 * A separate Fines screen exists for the other question, which is "who owes
 * altogether", and it links here rather than duplicating the payment form.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MemberSummary } from '@library/contracts'
import { api } from '../../api'
import { Button, Card, Field, Input, cn } from '../../components/ui'
import { Search, UserPlus } from '../../components/icons'

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : '—'

export function Students() {
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const students = useQuery({
    queryKey: ['members', q],
    // Free text across the admission number and both names: whatever the librarian
    // happens to have written down.
    queryFn: () => api.searchMembers({ limit: 100, offset: 0, q: q.trim() || undefined }),
    staleTime: 5_000,
  })

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Students</h1>
        <p className="text-sm text-muted-foreground">
          Find somebody by name or admission number, and see what they have out.
        </p>
      </header>

      <Card className="p-4">
        <Field label="Search" htmlFor="students-search">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="students-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="S001, or a name"
              className="pl-9"
            />
          </div>
        </Field>
      </Card>

      {students.isPending ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Looking…</p>
      ) : students.isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Could not load the students. {students.error instanceof Error ? students.error.message : ''}
        </p>
      ) : students.data && students.data.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <UserPlus className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">
            {q.trim() ? 'Nobody matches that.' : 'No students yet.'}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {q.trim()
              ? 'Search covers the admission number and both names.'
              : 'Students are added from the entry form or by importing a roster.'}
          </p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {students.data?.items.map((m) => (
            <li key={m.id}>
              <StudentRow
                student={m}
                open={openId === m.id}
                onToggle={() => setOpenId((e) => (e === m.id ? null : m.id))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StudentRow({
  student,
  open,
  onToggle,
}: {
  student: MemberSummary
  open: boolean
  onToggle: () => void
}) {
  const [error, setError] = useState<string | null>(null)

  const detail = useQuery({
    queryKey: ['member', student.id],
    queryFn: () => api.getMember(student.id),
    enabled: open,
    staleTime: 5_000,
  })

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
      >
        <div className="min-w-0 flex-1">
          {/*
            Forename first, exactly as the register writes it.

            This said "Surname Forename", because that is how a register is
            conventionally sorted, and it made the same student appear under two
            different names depending on which screen you were looking at. A
            librarian scrolling this list would not find the row they had just been
            reading two screens earlier.

            Sorting still happens on the surname, in the domain. Only the
            presentation is first-name-first, to match everything else.
          */}
          <p className="truncate font-medium">
            <span className="numeric">{student.memberCode}</span>
            {' — '}
            {student.firstName} {student.lastName}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {[
              student.form,
              student.stream,
              student.grade ? `Grade ${student.grade}` : null,
            ]
              .filter(Boolean)
              .join(', ') || 'no form or grade on file'}
          </p>
        </div>

        <div className="shrink-0 text-right">
          {student.status !== 'active' ? (
            <p className="text-xs font-medium text-destructive capitalize">
              {student.status}
            </p>
          ) : null}
          {/*
            The balance, on the search result rather than only on the opened record.

            Because "that student is at their limit" and "that student owes money" are
            different refusals, and being able to tell them apart from the list is the
            difference between knowing and going to look.
          */}
          {student.outstandingFine > 0 ? (
            <p className="numeric text-sm font-medium text-destructive">
              {(student.outstandingFine / 100).toFixed(2)} owing
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing owing</p>
          )}
        </div>
      </button>

      {open ? (
        <div className="border-t border-border bg-secondary/25 px-4 py-4">
          {detail.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : detail.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Could not load this student.
            </p>
          ) : (
            <>
              <h3 className="text-sm font-medium">Books out</h3>
              {detail.data.activeLoans.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">Nothing out.</p>
              ) : (
                /*
                  * Due date and how late it is — which is the whole question when
                  * somebody is standing at the desk saying "but I only had it for a
                  * week".
                  *
                  * The spine number is deliberately absent. A loan carries a copy id
                  * and no barcode, and there is no "copy by id" on the API, so
                  * showing one would mean inventing it. The register, which already
                  * has the join, is where the book number belongs.
                  */
                <ul className="mt-2 grid gap-1.5">
                  {detail.data.activeLoans.map((l) => {
                    const overdue = new Date(l.dueAt) < new Date()
                    return (
                      <li
                        key={l.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-card px-3 py-2 text-sm"
                      >
                        <span className="text-muted-foreground">
                          Taken {date(l.checkedOutAt)}
                        </span>
                        <span className="numeric">due {date(l.dueAt)}</span>
                        {overdue ? (
                          <span className="text-xs font-medium text-destructive">overdue</span>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}

              <FineLedger
                memberId={student.id}
                balance={detail.data.outstandingFine}
                onError={setError}
              />

              {error ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <StudentStatus memberId={student.id} status={student.status} />
            </>
          )}
        </div>
      ) : null}
    </Card>
  )
}

/**
 * The ledger, and the two ways a balance changes.
 *
 * Shown as the ledger rather than as a single number because a balance nobody can
 * account for is the thing a parent disputes, and "KSh 40" with no explanation is
 * exactly that.
 */
function FineLedger({
  memberId,
  balance,
  onError,
}: {
  memberId: string
  balance: number
  onError: (e: string | null) => void
}) {
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const ledger = useQuery({
    queryKey: ['fines', memberId],
    queryFn: () => api.getFineLedger(memberId),
    enabled: true,
    staleTime: 5_000,
  })

  const settle = useMutation({
    mutationFn: async (how: 'pay' | 'waive') => {
      setBusy(true)
      const open = ledger.data?.find((f) => f.balance > 0)
      if (!open) throw new Error('There is nothing outstanding to settle.')
      if (how === 'pay') {
        // Entered in shillings, stored in cents. The conversion happens once, here,
        // at the edge — the ledger is integer cents everywhere else.
        const cents = Math.round(Number(amount) * 100)
        if (!Number.isFinite(cents) || cents <= 0) throw new Error('Enter an amount more than nothing.')
        if (cents > open.balance) throw new Error('That is more than they owe.')
        await api.recordPayment({ fineId: open.id, amountCents: cents })
      } else {
        if (reason.trim().length === 0) throw new Error('A waiver needs a reason.')
        await api.waiveFine({ fineId: open.id, reason: reason.trim() })
      }
    },
    onSuccess: async () => {
      setBusy(false)
      setAmount('')
      setReason('')
      onError(null)
      await queryClient.invalidateQueries({ queryKey: ['fines'] })
      await queryClient.invalidateQueries({ queryKey: ['members'] })
      /*
       * The open record too, and this one was missed.
       *
       * The panel's heading reads `detail.outstandingFine` from the `['member']`
       * query, while the fine list below it reads `['fines']`. Invalidating only the
       * second left the heading showing the pre-payment balance and the line beneath
       * showing the post-payment one — two different numbers for the same debt, on
       * the same screen, seconds apart.
       *
       * A librarian does not have to know which query is stale. They just see that
       * the total disagrees with the item, and stop trusting both.
       */
      await queryClient.invalidateQueries({ queryKey: ['member'] })
    },
    onError: (e: unknown) => {
      setBusy(false)
      onError(e instanceof Error ? e.message : 'That did not work.')
    },
  })

  const outstanding = (ledger.data ?? []).filter((f) => f.balance > 0)

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Fines</h3>

      {balance === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Nothing owing.</p>
      ) : (
        <>
          <p className="numeric mt-1 text-sm font-medium">
            {(balance / 100).toFixed(2)} outstanding
          </p>

          <ul className="mt-2 grid gap-1">
            {outstanding.map((f) => (
              <li key={f.id} className="text-xs text-muted-foreground">
                <span className="capitalize">{f.kind}</span>
                {' · '}
                {(f.balance / 100).toFixed(2)}
                {f.note ? ` · ${f.note}` : ''}
              </li>
            ))}
          </ul>

          {/*
            Payment and waiver side by side, because both happen at this desk and
            choosing between them is a judgement about the student in front of you —
            not something to be decided by which screen it lives on.
          */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Field label="Take payment (KSh)" htmlFor={`pay-${memberId}`}>
                <Input
                  id={`pay-${memberId}`}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="numeric"
                  placeholder="40"
                />
              </Field>
              <Button
                type="button"
                size="sm"
                disabled={busy || !isPositiveNumber(amount)}
                onClick={() => settle.mutate('pay')}
              >
                {busy ? 'Working…' : 'Take the money'}
              </Button>
            </div>

            <div className="grid gap-2">
              <Field
                label="Or waive it"
                htmlFor={`waive-${memberId}`}
                hint="A reason is required and is kept."
              >
                <Input
                  id={`waive-${memberId}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="School responsibility"
                />
              </Field>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || reason.trim().length === 0}
                onClick={() => settle.mutate('waive')}
              >
                Waive the balance
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Suspension, because "that student is not active" is a refusal with no way out.
 *
 * Deliberately one step and reversible: this is a school, a record gets entered
 * wrongly, and a rule that needs an administrator to undo is a rule that does not
 * get used.
 */
function StudentStatus({
  memberId,
  status,
}: {
  memberId: string
  status: string
}) {
  const queryClient = useQueryClient()
  const active = status === 'active'

  const set = useMutation({
    mutationFn: () => api.setMemberStatus(memberId, active ? 'suspended' : 'active'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members'] })
      await queryClient.invalidateQueries({ queryKey: ['member'] })
    },
  })

  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn(!active && 'text-destructive')}
        disabled={set.isPending}
        onClick={() => set.mutate()}
      >
        {active ? 'Suspend borrowing' : 'Allow borrowing again'}
      </Button>
    </div>
  )
}

function isPositiveNumber(v: string): boolean {
  const n = Number(v)
  return v.trim().length > 0 && Number.isFinite(n) && n > 0
}