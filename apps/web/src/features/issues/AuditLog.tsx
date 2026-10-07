/**
 * The audit log — who did what, when.
 *
 * ── Why it exists ───────────────────────────────────────────────────
 *
 * The register says a loan was voided; the log says who voided it and why.
 * Neither row can be rebuilt once it was never written, which is why the domain
 * writes one log entry for every act — a checkout and a payment as much as a
 * void — rather than only the suspicious ones: a log with holes in it invites
 * the interpretation that what is missing was deliberate.
 *
 * ── What it shows, and what it leaves out ────────────────────────────
 *
 * Newest first, 25 at a time, like the register. Each row is the act, the
 * moment, the account that did it and the handful of details that make the act
 * readable — the admission number and book number for a checkout, the reason
 * for a void, the amount for a payment. The full before/after objects stay in
 * the database: nobody reads a diff from a phone, and this screen is read on a
 * phone.
 *
 * ── Who may read it ──────────────────────────────────────────────────
 *
 * Only administrators. The desk does not need to know who changed whose role,
 * and staff-side screens that named their colleague's edits would hand every
 * assistant a map of the accounts. The permission is the domain's; when an
 * assistant opens this page the query refuses with the same sentence it uses
 * everywhere else.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { type AuditEntry } from '@library/contracts'
import { api } from '../../api'
import { Button, Card } from '../../components/ui'
import { TriangleAlert } from '../../components/icons'

/** Rows per page — the same 25 the register serves. */
const PAGE = 25

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * The act, in the words the desk uses.
 *
 * The live functions name their actions as the verbs of the register — checkout,
 * return, void — and a log that echoed "checkout" raw would read like a log
 * nobody translated. These are the same verbs, turned into sentences.
 */
function actionLabel(a: AuditEntry): string {
  switch (a.action) {
    case 'checkout':
      return 'Checked out'
    case 'return':
      return 'Returned'
    case 'renew':
      return 'Renewed'
    case 'void':
      return 'Voided'
    case 'mark_lost':
      return 'Marked lost'
    case 'payment':
      return 'Payment recorded'
    case 'waive':
      return 'Waived'
    case 'assess':
      return 'Fine assessed'
    case 'hold_filled':
      return 'Hold filled'
    case 'hold_expired':
      return 'Hold lapsed'
    case 'hold_collected':
      return 'Hold collected'
    case 'create_user':
      return 'Account appointed'
    case 'set_user_role':
      return 'Role changed'
    case 'set_user_status':
      return a.after?.status === 'disabled' ? 'Account disabled' : 'Account enabled'
    case 'set_up_library':
      return 'Library set up'
    default:
      return a.action
  }
}

/**
 * The after-fields a reader of this log is after, in the order they ask.
 *
 * A checkout reads as "S001 · BK-0001 · due 6 Oct 2026"; a void as its reason; a
 * payment as its amount. Anything not in that list — a uuid the next screen
 * could not be held to — is left out rather than shown as noise.
 */
function detail(a: AuditEntry): string | null {
  const after = a.after
  if (!after) return null
  const parts: string[] = []
  if (after.member_code) parts.push(String(after.member_code))
  if (after.barcode) parts.push(String(after.barcode))
  if (after.due_at) parts.push(`due ${dateTime(String(after.due_at))}`)
  if (after.amount !== undefined && after.amount !== null) {
    parts.push(`KSh ${(Number(after.amount) / 100).toFixed(2)}`)
  }
  if (after.condition_in) parts.push(`came back ${after.condition_in}`)
  if (after.reason) parts.push(String(after.reason))
  // The label above already says "Voided", "Account disabled" and the rest, so
  // a status line would repeat the headline rather than add to it.
  if (after.role) parts.push(`role: ${after.role}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function AuditLog() {
  const [offset, setOffset] = useState(0)

  const entries = useQuery({
    queryKey: ['audit', offset],
    queryFn: () => api.getAuditLog({ limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  })

  // Which account each entry names, resolved once so the log reads "by Head
  // Librarian" rather than by a uuid. Both this screen and the log it reads are
  // admin-only, so `users.read` is present; if the names ever fail, the log
  // shows the tail of the id instead of refusing to render.
  const users = useQuery({
    queryKey: ['audit-users'],
    queryFn: () => api.listUsers(),
    enabled: entries.isSuccess,
  })

  if (entries.isPending) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">Loading the audit log…</p>
    )
  }
  if (entries.isError) {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          Could not load the audit log. {entries.error instanceof Error ? entries.error.message : ''}
        </span>
      </p>
    )
  }

  const rows = entries.data?.items ?? []
  const names = new Map((users.data ?? []).map((u) => [u.id, u.name]))
  const actor = (a: AuditEntry) =>
    a.actor ? names.get(a.actor) ?? `account ${a.actor.slice(-6)}` : 'the system'

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">Who did what, when — newest first.</p>
      </header>

      {/*
        Which slice is on screen, and the way to the next one — the register's
        pager, above the list so the next page opens under the buttons pressed
        for it rather than mid-list.
      */}
      {rows.length > 0 && entries.data ? (
        <nav aria-label="Audit pages" className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset === 0 || entries.isFetching}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
          >
            ← Newer
          </Button>
          <p className="numeric text-xs text-muted-foreground">
            Showing {offset + 1}–{offset + rows.length} of {entries.data.total}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!entries.data.hasMore || entries.isFetching}
            onClick={() => setOffset((o) => o + PAGE)}
          >
            Older →
          </Button>
        </nav>
      ) : null}

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing here yet. The log fills as the desk works.
        </p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((a) => (
            <li key={a.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold">{actionLabel(a)}</p>
                  <p className="numeric text-xs text-muted-foreground">{dateTime(a.createdAt)}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.entity} · by {actor(a)}
                </p>
                {detail(a) ? (
                  <p className="mt-2 border-t border-border pt-2 text-sm">{detail(a)}</p>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}