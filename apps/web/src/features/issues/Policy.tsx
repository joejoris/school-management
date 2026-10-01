/**
 * Policy: the rules the school borrows by.
 *
 * ── Why this is data and not code ────────────────────────────────────
 *
 * Fourteen days, five books, two renewals and twenty-five cents a day were written
 * into the seed data and could not be changed by anybody, ever. A school that wants
 * two books per student — which is a perfectly ordinary decision — could not have it.
 *
 * So the rules were already a table in the domain, and this screen is the only thing
 * that was missing.
 *
 * ── What a change does to loans already out ──────────────────────────
 *
 * Nothing. A loan keeps the deadline it was issued with. Re-reading the current
 * policy on a loan issued last term would silently move every due date in the
 * register, and a librarian looking at a register of fixed deadlines would have no
 * way to tell which ones had moved or why.
 *
 * That is why the screen says so at the bottom rather than leaving it to be
 * discovered.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MemberType } from '@library/contracts'
import { api } from '../../api'
import { Button, Card, Field, Input } from '../../components/ui'
import { TriangleAlert } from '../../components/icons'

/** One member type, with its rules editable. */
function TypeRow({ type }: { type: MemberType }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState({
    loanPeriodDays: String(type.loanPeriodDays),
    graceDays: String(type.graceDays),
    maxRenewals: String(type.maxRenewals),
    borrowLimit: String(type.borrowLimit),
    fineBlockThreshold: String(type.fineBlockThreshold / 100),
  })
  const [error, setError] = useState<string | null>(null)

  // Re-seed when the server value changes under us, so the boxes do not sit there
  // showing a number the domain has moved on from.
  useEffect(() => {
    setDraft({
      loanPeriodDays: String(type.loanPeriodDays),
      graceDays: String(type.graceDays),
      maxRenewals: String(type.maxRenewals),
      borrowLimit: String(type.borrowLimit),
      fineBlockThreshold: String(type.fineBlockThreshold / 100),
    })
  }, [type])

  const save = useMutation({
    mutationFn: () =>
      api.updateMemberType(type.key, {
        loanPeriodDays: whole(draft.loanPeriodDays),
        graceDays: whole(draft.graceDays),
        maxRenewals: whole(draft.maxRenewals),
        borrowLimit: whole(draft.borrowLimit),
        // Stored in cents, entered in shillings. The conversion happens once, here,
        // at the edge, so the rest of the system never has to think about it.
        fineBlockThreshold: Math.round(Number(draft.fineBlockThreshold) * 100),
      }),
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['member-types'] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save those rules.'),
  })

  const valid = whole(draft.loanPeriodDays) > 0 && whole(draft.borrowLimit) >= 0

  return (
    <Card className="px-4 py-4">
      <h3 className="font-medium capitalize">{type.label}</h3>

      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Loan period (days)" htmlFor={`days-${type.key}`}>
          <Input
            id={`days-${type.key}`}
            value={draft.loanPeriodDays}
            onChange={(e) => setDraft((d) => ({ ...d, loanPeriodDays: e.target.value }))}
            inputMode="numeric"
            className="numeric"
          />
        </Field>

        <Field label="Books at once" htmlFor={`limit-${type.key}`}>
          <Input
            id={`limit-${type.key}`}
            value={draft.borrowLimit}
            onChange={(e) => setDraft((d) => ({ ...d, borrowLimit: e.target.value }))}
            inputMode="numeric"
            className="numeric"
          />
        </Field>

        <Field label="Renewals allowed" htmlFor={`renewals-${type.key}`}>
          <Input
            id={`renewals-${type.key}`}
            value={draft.maxRenewals}
            onChange={(e) => setDraft((d) => ({ ...d, maxRenewals: e.target.value }))}
            inputMode="numeric"
            className="numeric"
          />
        </Field>

        <Field label="Grace days" htmlFor={`grace-${type.key}`} hint="Before a fine starts.">
          <Input
            id={`grace-${type.key}`}
            value={draft.graceDays}
            onChange={(e) => setDraft((d) => ({ ...d, graceDays: e.target.value }))}
            inputMode="numeric"
            className="numeric"
          />
        </Field>

        <Field label="Blocked above (KSh)" htmlFor={`block-${type.key}`}>
          <Input
            id={`block-${type.key}`}
            value={draft.fineBlockThreshold}
            onChange={(e) => setDraft((d) => ({ ...d, fineBlockThreshold: e.target.value }))}
            inputMode="decimal"
            className="numeric"
          />
        </Field>

        <div className="flex items-end">
          <Button
            type="button"
            size="sm"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </Card>
  )
}

/**
 * What a late book costs.
 *
 * Entered in shillings, stored in cents. The conversion happens once, here, at the
 * edge — every other part of the system deals in integer cents and never has to
 * think about it.
 *
 * Kept as a local draft with an explicit save rather than saving on every keystroke,
 * because "20" is a half-typed "200" and a rate that flickers through every value
 * between zero and the intended one would charge somebody a penny before the button
 * is pressed.
 */
function FineRates() {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
    staleTime: 30_000,
  })

  /*
   * The fallback matches the seed exactly: 25 cents, which is KSh 0.25.
   *
   * It was 2500. So on a screen where the setting had not loaded — the first paint,
   * and any time the query failed — the box read 25.00 a day, and pressing Save
   * would have written 2500 cents. A fallback that disagrees with the real default
   * is worse than no fallback: it looks like a value.
   */
  const daily = String(
    Number((settings.data ?? []).find((s) => s.key === 'fine.defaultDailyRateCents')?.value ?? 25) / 100,
  )
  const cap = String(
    Number((settings.data ?? []).find((s) => s.key === 'fine.maxPerFineCents')?.value ?? 2000) / 100,
  )

  const [draft, setDraft] = useState({ daily, cap })
  const [error, setError] = useState<string | null>(null)

  // Seeded from the server, then left alone — otherwise every re-render of the
  // settings query would overwrite whatever was half-typed.
  useEffect(() => {
    setDraft({ daily, cap })
    // Intentionally keyed on the two server values only, so it does not fight the
    // person typing.
  }, [daily, cap])

  const save = useMutation({
    mutationFn: async () => {
      await api.updateSetting('fine.defaultDailyRateCents', Math.round(Number(draft.daily) * 100))
      await api.updateSetting('fine.maxPerFineCents', Math.round(Number(draft.cap) * 100))
      // The accrual reads these on every run, so anything derived from a fine has to
      // go — or the change appears not to have taken.
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await queryClient.invalidateQueries({ queryKey: ['member-types'] })
      await queryClient.invalidateQueries({ queryKey: ['fines'] })
      await queryClient.invalidateQueries({ queryKey: ['members'] })
    },
    onSuccess: () => setError(null),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save that.'),
  })

  const valid = Number(draft.daily) >= 0 && Number(draft.cap) > 0
  const unchanged = draft.daily === daily && draft.cap === cap

  return (
    <Card className="px-4 py-4">
      <h3 className="font-medium">Late books cost</h3>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Each day after (KSh)" htmlFor="fine-daily">
          <Input
            id="fine-daily"
            value={draft.daily}
            onChange={(e) => setDraft((d) => ({ ...d, daily: e.target.value }))}
            inputMode="decimal"
            className="numeric"
          />
        </Field>

        <Field
          label="Never more than (KSh)"
          htmlFor="fine-cap"
          hint="A book overdue all term should not produce a number nobody believes."
        >
          <Input
            id="fine-cap"
            value={draft.cap}
            onChange={(e) => setDraft((d) => ({ ...d, cap: e.target.value }))}
            inputMode="decimal"
            className="numeric"
          />
        </Field>
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!valid || unchanged || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save the rates'}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </Card>
  )
}

export function Policy() {
  const types = useQuery({
    queryKey: ['member-types'],
    queryFn: () => api.listMemberTypes(),
    staleTime: 30_000,
  })

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Borrowing rules</h1>
        <p className="text-sm text-muted-foreground">
          How long a book is kept for, how many at once, and what a late one costs.
        </p>
      </header>

      {types.isPending ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : types.isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Could not load the rules. {types.error instanceof Error ? types.error.message : ''}
        </p>
      ) : (
        <>
          <ul className="grid gap-3">
            {types.data?.map((t) => (
              <li key={t.key}>
                <TypeRow type={t} />
              </li>
            ))}
          </ul>

          {/*
            The rates card owns its error, and so does each type row above. They
            differ: a failed save of one member type should not blank the page, and a
            single page-level slot cannot show both at once anyway.
          */}
          <FineRates />
        </>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          These rules apply to loans issued from now on. Books already out keep the
          deadline they were issued with — re-reading the rules on them would silently
          move every date in the register.
        </span>
      </p>
    </div>
  )
}

/** A whole number, or zero. Blank is not zero. */
function whole(v: string): number {
  const n = Number(v.trim())
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}