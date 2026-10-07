import { describe, test, expect } from 'vitest'
import { MockApi } from '../api/mock'

/**
 * Hold expiry and the moving queue.
 *
 * A filled hold promises the book for three days; nothing in feature 5 made
 * good on the promise. These tests clock-wind past the deadline (the mock's
 * clock is a parameter, so a test can say what day it is) and check the three
 * things the live `sweep_holds` does on the next desk action:
 *
 *   - the lapsed promise is marked 'expired' and reaches the audit log;
 *   - an uncollected copy leaves the desk pile for the shelf;
 *   - the promise passes to the next member in line (and a copy nobody will
 *     collect is not shelved while a live waiter is behind it).
 *
 * And the collection rules `issue_book` gained alongside it: the member a copy
 * is held for may take it (marking the hold 'collected'), and anybody else may
 * not — with a sentence, not a silence.
 */

const DAY = 24 * 60 * 60 * 1000

/** A clock a test can wind forward, so three days can pass without waiting. */
function makeClock(startIso: string) {
  let now = new Date(startIso)
  return {
    now: () => now.toISOString(),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

async function setUp(clock: { now(): string }): Promise<MockApi> {
  const api = new MockApi({ now: clock.now })
  await api.createUser({
    email: 'head@dandorasecondary.go.ke',
    name: 'Head Librarian',
    password: 'x',
    role: 'admin',
  })
  await api.signIn('head@dandorasecondary.go.ke', 'x')
  return api
}

async function student(api: MockApi, code: string, firstName: string) {
  return api.createMember({ memberCode: code, firstName, lastName: 'Student', type: 'student' })
}

async function titleWith(api: MockApi, title: string, copyCount = 1) {
  const created = await api.createTitle({ title, author: 'A. Author', copyCount })
  const detail = await api.getTitle(created.id)
  return { id: created.id, copies: detail.copies }
}

async function borrow(api: MockApi, memberCode: string, barcode: string) {
  const issued = await api.checkout({ memberCode, barcode })
  if (!issued.ok) throw new Error(`setup checkout refused: ${issued.refusal}`)
  return issued.loan.id
}

/** Returns the copy to the desk pile (not the shelf), as a hold-collection desk does. */
async function returnToDesk(api: MockApi, loanId: string) {
  const returned = await api.returnLoan({ loanId, conditionIn: 'good', toShelf: false })
  if (!returned.ok) throw new Error(`setup return refused: ${returned.refusal}`)
}

describe('hold expiry', () => {
  test('an uncollected hold lapses on the next desk action and the copy leaves the desk pile', async () => {
    const clock = makeClock('2026-10-01T08:00:00.000Z')
    const api = await setUp(clock)

    await student(api, 'S001', 'First')
    const s2 = await student(api, 'S002', 'Second')
    const queueBook = await titleWith(api, 'The Queue', 1)
    const spare = await titleWith(api, 'A Spare', 1)
    const barcode = queueBook.copies[0]!.barcode

    // S1 borrows the only copy; S2 waits for it.
    const loanId = await borrow(api, 'S001', barcode)
    const hold = await api.placeHold({ memberId: s2.id, titleId: queueBook.id })
    await returnToDesk(api, loanId)

    // Their record reads "ready": filled, pinned to the copy, three days to collect.
    const afterFill = (await api.listHoldsForMember(s2.id)).find((h) => h.id === hold.id)!
    expect(afterFill.status).toBe('filled')
    expect(afterFill.copyId).toBe(queueBook.copies[0]!.id)
    expect(Date.parse(afterFill.expiresAt!) - Date.parse(clock.now())).toBe(3 * DAY)

    // The copy waits at the desk. Nothing moves until the desk acts.
    let onDesk = (await api.getTitle(queueBook.id)).copies.find((c) => c.id === queueBook.copies[0]!.id)!
    expect(onDesk.status).toBe('at_desk')

    // Three days come and go without a collection. The next action — even an
    // unrelated one — sweeps: the promise lapsed, and with nobody behind it the
    // copy goes back to the shelf.
    clock.advance(4 * DAY)
    await borrow(api, 'S001', spare.copies[0]!.barcode)

    const lapsed = (await api.listHoldsForMember(s2.id)).find((h) => h.id === hold.id)!
    expect(lapsed.status).toBe('expired')
    onDesk = (await api.getTitle(queueBook.id)).copies.find((c) => c.id === queueBook.copies[0]!.id)!
    expect(onDesk.status).toBe('on_shelf')
    expect((await api.getHoldQueue(queueBook.id)).length).toBe(0)

    const holdAudit = (await api.getAuditLog({ entityType: 'hold', limit: 50, offset: 0 })).items
    const expiryLog = holdAudit.find((a) => a.action === 'hold_expired' && a.entityId === hold.id)
    expect(expiryLog).toBeDefined()
    expect(expiryLog!.after).toMatchObject({ member_id: s2.id, copy_id: queueBook.copies[0]!.id })
  })

  test('when a lapsed hold has a waiter behind it, the promise passes to them', async () => {
    const clock = makeClock('2026-10-05T09:00:00.000Z')
    const api = await setUp(clock)

    await student(api, 'S001', 'First')
    const s2 = await student(api, 'S002', 'Second')
    const s3 = await student(api, 'S003', 'Third')
    const book = await titleWith(api, 'One Copy', 1)
    const spare = await titleWith(api, 'A Spare', 1)
    const barcode = book.copies[0]!.barcode

    const loanId = await borrow(api, 'S001', barcode)
    const s2Hold = await api.placeHold({ memberId: s2.id, titleId: book.id })
    const s3Hold = await api.placeHold({ memberId: s3.id, titleId: book.id })
    await returnToDesk(api, loanId)

    // S2 is first in line: their record reads "ready".
    expect((await api.listHoldsForMember(s2.id)).find((h) => h.id === s2Hold.id)!.status).toBe('filled')

    // S2 never collects. Four days later the promise passes to S3, who is given
    // the same three days, on the same desk pile — not shelved, because the
    // queue is not empty.
    clock.advance(4 * DAY)
    await borrow(api, 'S001', spare.copies[0]!.barcode)

    const s2Lapsed = (await api.listHoldsForMember(s2.id)).find((h) => h.id === s2Hold.id)!
    expect(s2Lapsed.status).toBe('expired')

    const s3Promoted = (await api.listHoldsForMember(s3.id)).find((h) => h.id === s3Hold.id)!
    expect(s3Promoted.status).toBe('filled')
    expect(s3Promoted.copyId).toBe(book.copies[0]!.id)
    expect(Date.parse(s3Promoted.expiresAt!) - Date.parse(clock.now())).toBe(3 * DAY)

    const onDesk = (await api.getTitle(book.id)).copies.find((c) => c.id === book.copies[0]!.id)!
    expect(onDesk.status).toBe('at_desk')

    const holdAudit = (await api.getAuditLog({ entityType: 'hold', limit: 50, offset: 0 })).items
    expect(holdAudit.some((a) => a.action === 'hold_expired' && a.entityId === s2Hold.id)).toBe(true)
    expect(holdAudit.some((a) => a.action === 'hold_filled' && a.entityId === s3Hold.id)).toBe(true)
  })
})

describe('collecting a held copy', () => {
  test('the member a copy is held for may take it, and the hold then reads collected', async () => {
    const clock = makeClock('2026-10-05T09:00:00.000Z')
    const api = await setUp(clock)

    await student(api, 'S001', 'First')
    const s2 = await student(api, 'S002', 'Second')
    const book = await titleWith(api, 'Held Book', 1)
    const barcode = book.copies[0]!.barcode

    const loanId = await borrow(api, 'S001', barcode)
    const hold = await api.placeHold({ memberId: s2.id, titleId: book.id })
    await returnToDesk(api, loanId)

    // S2 comes to collect from the desk pile. Issuing an `at_desk` copy to them
    // is the whole point: the book is not on the shelf, it is behind the desk
    // for them.
    const collected = await api.checkout({ memberCode: 'S002', barcode })
    expect(collected.ok).toBe(true)

    const after = (await api.listHoldsForMember(s2.id)).find((h) => h.id === hold.id)!
    expect(after.status).toBe('collected')

    const holdAudit = (await api.getAuditLog({ entityType: 'hold', limit: 50, offset: 0 })).items
    expect(holdAudit.some((a) => a.action === 'hold_collected' && a.entityId === hold.id)).toBe(true)
  })

  test('a held copy is refused to anybody else, even with an override reason', async () => {
    const clock = makeClock('2026-10-05T09:00:00.000Z')
    const api = await setUp(clock)

    await student(api, 'S001', 'First')
    const s2 = await student(api, 'S002', 'Second')
    await student(api, 'S003', 'Third')
    const book = await titleWith(api, 'Held Book', 1)
    const barcode = book.copies[0]!.barcode

    const loanId = await borrow(api, 'S001', barcode)
    await api.placeHold({ memberId: s2.id, titleId: book.id })
    await returnToDesk(api, loanId)

    // S3 scans the barcode. The answer is a sentence, not a silence — and not
    // one a recorded reason can talk over: a promise to another student is not
    // overrideable like a borrowing limit is.
    const refused = await api.checkout({ memberCode: 'S003', barcode })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.refusal).toBe('copy_reserved')
    expect(refused.overridable).toBe(false)
    expect(refused.message).toContain('being held for another student')

    const stillRefused = await api.checkout({
      memberCode: 'S003',
      barcode,
      override: true,
      overrideReason: 'class assignment',
    })
    expect(stillRefused.ok).toBe(false)
    if (stillRefused.ok) return
    expect(stillRefused.refusal).toBe('copy_reserved')
  })
})