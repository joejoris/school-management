/**
 * Days, and the bug they caused.
 *
 * ── Why this file is a bug report ────────────────────────────────────
 *
 * Every test here fails against the code as it was written. The bug was live, and
 * every other test in the repository passed while it was.
 *
 * The symptom: **every return button in the application was dead**, with the
 * sentence "A book cannot come back before it went out." The domain was not wrong —
 * it was correctly refusing a loan that had been stamped in the future.
 *
 * The cause was one expression in the entry form:
 *
 *   dateTaken:   new Date().toISOString().slice(0, 10)        <- UTC
 *   checkedOutAt: new Date(`${dateTaken}T08:00:00`)             <- local
 *
 * Two timezones in one line. West of Greenwich, `toISOString` has already rolled to
 * tomorrow by late afternoon, so the form defaulted to tomorrow, and reading that
 * back as *local* 08:00 put the loan twelve hours ahead of the clock. The librarian
 * was right; the software was stamping books as going out in the evening.
 *
 * The reason no test caught it is the part worth remembering: the two faults cancel
 * each other out between roughly 08:00 and 17:00 Pacific. Every run of the suite in
 * that window reported 95 passing, and the application was unusable at both ends of
 * the day.
 *
 * ── The clock is fixed, deliberately ────────────────────────────────
 *
 * These tests pass an explicit instant rather than reading the system clock. A test
 * that only fails in the evening is a test nobody runs in the morning, which is the
 * same failure one level up.
 */
import { describe, test, expect } from 'vitest'
import { isFutureLocalDay, localDayOf, startOfLocalDay, todayLocal } from '../lib/dates'
import { MockApi } from '../api/mock'

/**
 * Two moments, chosen because each one breaks exactly one of the two faults.
 *
 * Both are written as UTC instants, because that is the only timezone-independent way
 * to name a moment, and then explained in local time so the reason can be checked by
 * hand. On a machine in UTC-7:
 *
 * 1. `WEST_OF_UTC` — 02:00 UTC on the 2nd, which is 19:00 on the 1st locally.
 *    `toISOString` already says `2026-10-02`, so the form defaulted to a day that had
 *    not happened yet. Read back as local 08:00 that is 15:00 UTC — thirteen hours
 *    after the clock — and every return was refused.
 *
 *    This is the half where the fault points in *opposite* directions on opposite
 *    sides of Greenwich: east of it the form showed yesterday, west of it tomorrow,
 *    and each side had a different and equally convincing story. That is why nobody
 *    could see it as one bug.
 *
 * 2. `LOCAL_SMALL_HOURS` — 10:00 UTC on the 2nd, which is 03:00 locally. Even with
 *    the correct day, the old `T08:00:00` stamped the loan five hours ahead of the
 *    clock, so a book taken at three in the morning could not come back until eight.
 *
 *    This half is wrong in every timezone, for the first eight hours of every day.
 */
const WEST_OF_UTC = '2026-10-02T02:00:00.000Z'
const LOCAL_SMALL_HOURS = '2026-10-02T10:00:00.000Z'

describe('the day a person means', () => {
  test('is their own, not UTC', () => {
    // The line this replaced. West of Greenwich it is already tomorrow.
    expect(new Date(WEST_OF_UTC).toISOString().slice(0, 10)).toBe('2026-10-02')
    expect(todayLocal(new Date(WEST_OF_UTC))).toBe('2026-10-01')
  })

  test('agrees with the local date, whichever side of Greenwich', () => {
    // Nairobi, UTC+3: 02:00 UTC on the 2nd is 05:00 on the 2nd locally. Both the old
    // line and this one say the 2nd — which is exactly why the bug looked
    // intermittent rather than systematic.
    const nairobi = new Date(WEST_OF_UTC)
    expect(todayLocal(nairobi)).toBe(localDayOf(nairobi))
  })

  test('a day starts at local midnight, not at UTC midnight', () => {
    // `new Date('2026-10-02')` is UTC midnight, which is 07:00 on the 2nd in Nairobi
    // and 17:00 on the 1st in Portland. The explicit T00:00:00 is what makes it local.
    const start = startOfLocalDay('2026-10-02')
    const local = new Date(start)
    expect(local.getFullYear()).toBe(2026)
    expect(local.getMonth()).toBe(9)
    expect(local.getDate()).toBe(2)
    expect(local.getHours()).toBe(0)
    expect(local.getMinutes()).toBe(0)
  })

  test('midnight is never later than the day it names', () => {
    // The property that makes the old bug unwritable: any instant inside the typed
    // day is at or after its start, so a return today can never precede an issue
    // today.
    for (const day of ['2026-01-01', '2026-03-29', '2026-10-02', '2026-12-31']) {
      const start = Date.parse(startOfLocalDay(day))
      const noonish = new Date(`${day}T23:59:59`).getTime()
      const endOfDay = new Date(start).setHours(23, 59, 59, 999)
      expect(start).toBeLessThanOrEqual(noonish)
      expect(start).toBeLessThanOrEqual(endOfDay)
    }
  })

  test('a day in the future is recognised as one', () => {
    const now = new Date('2026-10-01T19:00:00.000Z')
    expect(isFutureLocalDay('2026-10-01', now)).toBe(false)
    expect(isFutureLocalDay('2026-10-02', now)).toBe(true)
    expect(isFutureLocalDay('2026-09-30', now)).toBe(false)
  })

  test('today is never a future day, at any hour', () => {
    // The check that would have caught it: the form's own default can never be
    // rejected by the form's own validation.
    for (const hour of [0, 1, 7, 8, 12, 17, 20, 23]) {
      const now = new Date(`2026-06-15T${String(hour).padStart(2, '0')}:30:00.000Z`)
      expect(isFutureLocalDay(todayLocal(now), now)).toBe(false)
    }
  })
})

/** A stocked library with somebody at the desk, on a clock we control. */
async function deskAt(iso: string) {
  const clock = { at: iso }
  const api = new MockApi({ now: () => clock.at })
  await api.createUser({ email: 'head@librarian', name: 'Head', password: 'x', role: 'admin' })
  await api.signIn('head@librarian', 'x')
  const member = await api.createMember({
    memberCode: 'S001',
    firstName: 'Kept',
    lastName: 'Student',
    type: 'student',
  })
  const title = await api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 1 })
  const copy = (await api.getTitle(title.id)).copies[0]!
  return { api, member, barcode: copy.barcode, clock }
}

/**
 * The exact call the entry form makes.
 *
 * Reproduced here rather than by mounting the screen, because the form is where the
 * bug was and the form is what this pins: if the timestamp ever stops being local
 * midnight of the typed day again, this fails.
 */
async function takeOutToday(api: MockApi, memberCode: string, barcode: string, now: Date) {
  return api.checkout({
    memberCode,
    barcode,
    checkedOutAt: startOfLocalDay(todayLocal(now)),
  })
}

describe('a book taken today can be brought back today', () => {
  test('late in the evening, west of UTC', async () => {
    const now = new Date(WEST_OF_UTC)
    const { api, member, barcode } = await deskAt(WEST_OF_UTC)

    const out = await takeOutToday(api, member.memberCode, barcode, now)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const back = await api.returnLoan({ loanId: out.loan.id, conditionIn: 'good' })
    // The old code refused here, with "A book cannot come back before it went out."
    expect(back.ok).toBe(true)
  })

  test('in the small hours, where the 08:00 fiction bit', async () => {
    const now = new Date(LOCAL_SMALL_HOURS)
    const { api, member, barcode } = await deskAt(LOCAL_SMALL_HOURS)

    const out = await takeOutToday(api, member.memberCode, barcode, now)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    // The old code stamped this at 08:00 local — five hours ahead — and the return
    // was refused for the first eight hours of every single day.
    const back = await api.returnLoan({ loanId: out.loan.id, conditionIn: 'good' })
    expect(back.ok).toBe(true)
  })

  test('and the loan is dated the day the librarian typed, not tomorrow', async () => {
    const now = new Date(WEST_OF_UTC)
    const { api, member, barcode } = await deskAt(WEST_OF_UTC)

    const out = await takeOutToday(api, member.memberCode, barcode, now)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(localDayOf(out.loan.checkedOutAt)).toBe('2026-10-01')
  })

  test('backdating still works, because a librarian does it in batches', async () => {
    const { api, member, barcode } = await deskAt(WEST_OF_UTC)

    // Entering yesterday's issues in one go is ordinary work, so it must not be
    // broken by the fix for the future-dated case.
    const out = await api.checkout({
      memberCode: member.memberCode,
      barcode,
      checkedOutAt: startOfLocalDay('2026-09-28'),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(localDayOf(out.loan.checkedOutAt)).toBe('2026-09-28')

    const back = await api.returnLoan({ loanId: out.loan.id, conditionIn: 'good' })
    expect(back.ok).toBe(true)
  })
})

describe('the impossible ordering is still refused', () => {
  test('as a sentence, not as an exception', async () => {
    const { api, member, barcode } = await deskAt('2026-10-10T12:00:00.000Z')

    const out = await api.checkout({
      memberCode: member.memberCode,
      barcode,
      checkedOutAt: startOfLocalDay('2026-10-20'),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    // Still refused — a book cannot come back before it went out, whatever the
    // reason. What changed is the shape: this used to throw, so a screen had to
    // handle two different failure paths for a refusal it could have been handed.
    const back = await api.returnLoan({ loanId: out.loan.id, conditionIn: 'good' })
    expect(back.ok).toBe(false)
    if (back.ok) return
    expect(back.refusal).toBe('returned_before_issued')
    // And the sentence tells the librarian what to do about it.
    expect(back.message).toMatch(/check the date it went out/i)
  })
})
