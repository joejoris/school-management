/**
 * Days, as a person means them.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * It exists because of a bug that was live for a while and that every test passed.
 *
 * The entry form defaulted "date taken" to `new Date().toISOString().slice(0, 10)`
 * and then turned the answer into an instant with
 * `new Date(\`${day}T08:00:00\`)`. Those are two different timezones in one
 * expression: `toISOString` reports the date in **UTC**, and `new Date('…T08:00:00')`
 * with no offset is read as **local**.
 *
 * On this machine, at 19:23 Pacific, that produced:
 *
 *   date taken   2026-10-02     <- UTC, which was already tomorrow
 *   checked out  2026-10-02T15:00Z   <- 08:00 *local*, which was ~13 hours away
 *   returned at  2026-10-02T02:23Z   <- now
 *
 * So the loan was stamped in the future, and `returnLoan` refused it with "A book
 * cannot come back before it went out." Every return button in the application was
 * dead, and the domain was right to refuse: the book genuinely had not gone out yet.
 *
 * Two faults, either of which alone would have been survivable:
 *
 *   1. "Today" was computed in UTC. It is wrong for every reader except one
 *      standing on the prime meridian — and wrong in opposite directions on
 *      opposite sides of it, which is why nobody noticed it was systematically
 *      broken rather than occasionally odd.
 *
 *   2. The `T08:00:00` was a fiction. "Taken today" was stored as "taken at eight
 *      in the morning" whatever time it actually was, so for the first eight hours
 *      of every day a book taken today could not be brought back until eight the
 *      next morning.
 *
 * The tests did not catch it because they all ran between roughly 08:00 and 17:00
 * Pacific, which is the one window where the two bugs happen to cancel out.
 *
 * ── The rule this file encodes ───────────────────────────────────────
 *
 * **A day a person typed is a calendar day. It is read and written in the
 * reader's own timezone, and nowhere else.** An instant the machine generated is
 * stored in UTC, as it always should be, and only ever converted for display.
 *
 * The two are kept apart on purpose. Conflating them is what produced the bug, and
 * the confusion is invisible precisely because both sides look like dates.
 */

/** Milliseconds in a day. Not `24 * 60 * 60 * 1000` in a comment; it is here. */
const DAY = 86_400_000

/**
 * The local calendar day, as `YYYY-MM-DD`.
 *
 * Built from the local getters and then padded, rather than by slicing an ISO
 * string, because the ISO string is UTC and that is the entire bug.
 */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** The local calendar day an instant falls on, as `YYYY-MM-DD`. */
export function localDayOf(iso: string | Date, now: Date = new Date()): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(date.getTime())) return todayLocal(now)
  return todayLocal(date)
}

/**
 * The instant a local day begins, as an ISO string.
 *
 * `new Date('2026-10-02')` is **UTC** midnight — two days out in Nairobi, and eight
 * hours out in Portland. The `T00:00:00` is what makes it local instead, and it is
 * there on purpose rather than left to a default.
 *
 * Midnight rather than the current time of day, because the day is what was typed.
 * A librarian entering yesterday's issues in a batch needs the date they typed, and
 * midnight is the earliest instant that day could have been — so anything after it
 * is a valid return time, which is the property that makes the `08:00:00` bug
 * impossible to write again.
 */
export function startOfLocalDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!m) {
    // Not a day this understands. Returned as-is rather than coerced, so a caller
    // that ignores this gets the obvious failure instead of a silent wrong date.
    return day
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).toISOString()
}

/** Whether a local day is later than today, in the reader's own timezone. */
export function isFutureLocalDay(day: string, now: Date = new Date()): boolean {
  const start = startOfLocalDay(day)
  const today = startOfLocalDay(todayLocal(now))
  if (!/^\d{4}-\d{2}-\d{2}T/.test(start)) return false
  return Date.parse(start) > Date.parse(today)
}

/** Whole days between two instants, never negative. */
export function daysBetween(from: string, to: string = new Date().toISOString()): number {
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / DAY))
}

/**
 * A date for a person: `2 Oct 2026`, in their own timezone.
 *
 * Every screen formats with `toLocaleDateString` and nothing else, so the display
 * and the stored day agree. Centralised here because it was previously written out
 * five times, and five copies is four chances to pick the wrong timezone.
 */
export function formatDay(iso: string | Date | null | undefined, fallback = '—'): string {
  if (!iso) return fallback
  const date = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(date.getTime())) return fallback
  return date.toLocaleDateString('en-GB', { dateStyle: 'medium' })
}

/** A date and time for a person, for the cases where the time matters. */
export function formatMoment(iso: string | Date | null | undefined, fallback = '—'): string {
  if (!iso) return fallback
  const date = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(date.getTime())) return fallback
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}
