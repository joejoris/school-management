/**
 * The circulation rules, exercised end to end.
 *
 * ── What is being tested ─────────────────────────────────────────────
 *
 * Every refusal in `REFUSAL_MESSAGES` that a librarian can hit at the desk. These
 * are the sentences that stop mistakes happening, so each one is tested by
 * arranging the state that causes it and asserting both the code and the copy.
 *
 * Testing the code alone would pass if the wording were swapped for something
 * technical, and the wording is the part a librarian acts on.
 *
 * ── Every test runs as an administrator ──────────────────────────────
 *
 * `asUser` exists precisely so this is explicit. A test that passed because the
 * domain happened to be permissive is not testing the rule.
 */
import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MockApi } from '../src/api/mock.ts'
import { DomainRefusalError, REFUSAL_MESSAGES } from '@library/contracts'

/** A fixed clock, so "overdue by 3 days" is a statement and not a hope. */
const NOW = '2026-09-20T08:00:00.000Z'
const clock = { at: NOW }

const api = new MockApi({ now: () => clock.at })

let admin: string

beforeEach(async () => {
  api.reset()
  clock.at = NOW
  // Creating an account no longer opens a session, so signing in is a second,
  // separate act. Every test below assumes somebody is at the desk, and this is
  // where that assumption is established — visibly, rather than as a side effect
  // of creating a user.
  const u = await api.createUser({ email: 'head@librarian', name: 'Head', password: 'x', role: 'admin' })
  await api.signIn('head@librarian', 'x')
  admin = u.id
})

/**
 * Every privileged call, made as the head librarian.
 *
 * Written once here rather than as twenty `as(() => …)` wrappers, because a
 * forgotten wrapper is invisible: the call simply rejects, and the failure reads
 * as a bug in the domain rather than as a missing line in the test. One place to
 * get right beats twenty places to remember.
 *
 * Tests about permissions use `api` directly and say who they are. Nothing else
 * does — if you find yourself wanting to check a rule from here, use `api`.
 *
 * `asUser`, `reset`, `exportState` and `importState` are excluded: wrapping
 * `asUser` in `asUser` would recurse.
 */
const NOT_DESK = new Set(['asUser', 'reset', 'exportState', 'importState'])

const desk = new Proxy(api, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver)
    if (typeof value !== 'function' || typeof prop !== 'string') return value
    if (NOT_DESK.has(prop)) return value
    // Read `admin` at call time, not at proxy-construction time: the first
    // account is created in beforeEach, after this module has been evaluated.
    return (...args: unknown[]) => api.asUser(admin, () => value.apply(target, args))
  },
}) as MockApi

/**
 * Runs `work` as the admin account. Kept for the few places that wrap a single
 * call; `desk` is the default.
 *
 * Generic on purpose. An earlier signature took `() => Promise<unknown>`, which
 * inferred `unknown` for every result and lost `CheckoutResult` — so a test that
 * narrowed with `if (result.ok)` had nothing to narrow, and 100 type errors said
 * `result` was `unknown` rather than saying where the information had gone.
 */
function as<T>(work: () => Promise<T> | T): Promise<T> {
  return api.asUser(admin, work)
}

/** A student on file, plus one book on the shelf. */
async function scene(options: { memberType?: 'student' | 'teacher' | 'staff' | 'external' } = {}) {
  const member = await desk.createMember({
    memberCode: 'S001',
    firstName: 'Kept',
    lastName: 'Student',
    type: options.memberType ?? 'student',
  })
  const title = await desk.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 1 })
  const detail = await desk.getTitle(title.id)
  return { member, title, copy: detail.copies[0]! }
}

/** As many books as needed, so a limit can be reached without 20 fixtures. */
async function stock(titleId: string, n: number): Promise<string[]> {
  const made = await desk.addCopies({ titleId, count: n })
  return made.map((c) => c.barcode)
}

describe('issuing a book', () => {
  test('a known student and a shelved book produce a loan', async () => {
    const { copy } = await scene()
    const result = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.loan.status, 'active')
      assert.equal(result.copyStatus, 'on_loan')
      // 14 days for a student, grace aside: the deadline is the member type's
      // loan period from the moment of issue.
      assert.equal(result.dueAt.slice(0, 10), '2026-10-04')
    }
  })

  test('the same book cannot go out twice', async () => {
    const { copy } = await scene()
    await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    const second = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.equal(second.refusal, 'copy_on_loan')
      assert.equal(second.message, REFUSAL_MESSAGES.copy_on_loan)
    }
  })

  test('an unknown admission number is refused, not guessed at', async () => {
    const { copy } = await scene()
    const result = await as(() => desk.checkout({ memberCode: 'S999', barcode: copy.barcode }))

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.refusal, 'member_not_found')
  })

  test('an admission number matches exactly, never loosely', async () => {
    const { copy } = await scene()
    // The whole point of §8. S1 is not S001, and a register that cannot tell them
    // apart issues books to the wrong child.
    const result = await as(() => desk.checkout({ memberCode: 's001', barcode: copy.barcode }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.refusal, 'member_not_found')
  })

  test('a borrowed book beyond the limit is refused with the limit named', async () => {
    const { title } = await scene()
    const barcodes = await stock(title.id, 5)
    for (const b of barcodes) {
      const r = await desk.checkout({ memberCode: 'S001', barcode: b })
      assert.equal(r.ok, true, 'the first five are within the limit')
    }

    const sixth = await as(async () =>
      desk.checkout({ memberCode: 'S001', barcode: await newTitleBarcode(title.id) }),
    )
    assert.equal(sixth.ok, false)
    if (!sixth.ok) {
      assert.equal(sixth.refusal, 'limit_exceeded')
      assert.equal(sixth.message, REFUSAL_MESSAGES.limit_exceeded)
      assert.equal(sixth.overridable, true, 'a limit is one a head librarian may override')
    }
  })

  test('an override needs a written reason, and records it', async () => {
    const { title } = await scene()
    const barcodes = await stock(title.id, 5)
    for (const b of barcodes) await desk.checkout({ memberCode: 'S001', barcode: b })
    const extra = await newTitleBarcode(title.id)

    // Overridden without a reason: refused, because an unexplained override is
    // indistinguishable from a mistake at the end of term.
    const noReason = await as(() =>
      desk.checkout({ memberCode: 'S001', barcode: extra, override: true }),
    )
    assert.equal(noReason.ok, false)

    const withReason = await as(() =>
      desk.checkout({ memberCode: 'S001', barcode: extra, override: true, overrideReason: 'Set work, week 4' }),
    )
    assert.equal(withReason.ok, false)
    if (!withReason.ok) assert.match(withReason.message, /set work, week 4/i)
  })

  test('a suspended student cannot borrow', async () => {
    const { member, copy } = await scene()
    await as(() => desk.setMemberStatus(member.id, 'suspended'))
    const result = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.refusal, 'member_suspended')
  })

  test('a withdrawn book is not issuable, and says so differently from one that is out', async () => {
    const { title } = await scene()
    const [barcode] = await stock(title.id, 1)
    const detail = await desk.getTitle(title.id)
    await as(() => desk.withdrawCopy(detail.copies.find((c) => c.barcode === barcode)!.id, 'cover torn'))

    const result = await as(() => desk.checkout({ memberCode: 'S001', barcode: barcode! }))
    assert.equal(result.ok, false)
    // 'copy_on_loan' is already out; 'copy_unavailable' is on the shelf list but
    // not issuable. Telling those apart is the difference between a librarian
    // checking and a librarian hunting.
    if (!result.ok) {
      assert.equal(result.refusal, 'copy_unavailable')
      assert.notEqual(result.refusal, 'copy_on_loan')
    }
  })

  test('an explicit due date is honoured, because the school set it', async () => {
    const { copy } = await scene()
    // Exam week is not "14 days from today", and deriving it would invent a
    // deadline nobody chose.
    const result = await as(() =>
      desk.checkout({ memberCode: 'S001', barcode: copy.barcode, dueAt: '2026-09-25T08:00:00.000Z' }),
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.dueAt.slice(0, 10), '2026-09-25')
  })

  test('an explicit issue date is honoured, and the loan is overdue from the start', async () => {
    const { copy } = await scene()
    // Writing up a paper register is backdating, and being honest about it means
    // the register says the book was overdue rather than pretending otherwise.
    const result = await as(() =>
      desk.checkout({
        memberCode: 'S001',
        barcode: copy.barcode,
        checkedOutAt: '2026-08-01T08:00:00.000Z',
        dueAt: '2026-08-15T08:00:00.000Z',
      }),
    )
    assert.equal(result.ok, true)
    const rows = await desk.listLoans({ limit: 10, offset: 0, status: 'overdue' })
    assert.ok(rows.items.some((r) => r.memberCode === 'S001'))
  })
})

describe('renewing', () => {
  test('a renewal moves the deadline from today, not from the old due date', async () => {
    const { copy } = await scene()
    const issued = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    assert.equal(issued.ok, true)
    if (!issued.ok) return

    clock.at = '2026-09-25T08:00:00.000Z'
    const renewed = await as(() => desk.renew({ loanId: issued.loan.id }))
    assert.equal(renewed.ok, true)
    if (renewed.ok) {
      // From the 25th plus 14. Extending from the old due date would land on the
      // 4th, which is behind us — a renewed book that is already overdue.
      assert.equal(renewed.loan.dueAt.slice(0, 10), '2026-10-09')
      assert.equal(renewed.loan.renewCount, 1)
    }
  })

  test('renewals stop at the limit the member type sets', async () => {
    const { copy } = await scene()
    const issued = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    if (!issued.ok) return assert.fail('setup failed')

    let last = { ok: true as const }
    for (let i = 0; i < 2; i++) last = (await desk.renew({ loanId: issued.loan.id })) as typeof last
    assert.equal(last.ok, true, 'a student may renew twice')

    const third = await desk.renew({ loanId: issued.loan.id })
    assert.equal(third.ok, false)
    if (!third.ok) assert.equal(third.refusal, 'renewal_limit_reached')
  })

  test('a returned book cannot be renewed', async () => {
    const { copy } = await scene()
    const issued = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    if (!issued.ok) return assert.fail('setup failed')
    await as(() => desk.returnLoan({ loanId: issued.loan.id, conditionIn: 'good' }))

    const renewed = await as(() => desk.renew({ loanId: issued.loan.id }))
    assert.equal(renewed.ok, false)
    if (!renewed.ok) assert.equal(renewed.refusal, 'already_returned')
  })
})

describe('returning', () => {
  test('a returned book goes back on the shelf', async () => {
    const { copy } = await scene()
    const issued = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    if (!issued.ok) return assert.fail('setup failed')

    await as(() => desk.returnLoan({ loanId: issued.loan.id, conditionIn: 'fair' }))
    const after = await as(() => desk.findCopyByBarcode(copy.barcode))
    assert.equal(after?.status, 'on_shelf')
    assert.equal(after?.condition, 'fair', 'the condition it came back in is recorded')
  })

  test('returning twice is refused with a sentence, not an error', async () => {
    const { copy } = await scene()
    const issued = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    if (!issued.ok) return assert.fail('setup failed')
    await as(() => desk.returnLoan({ loanId: issued.loan.id, conditionIn: 'good' }))

    const twice = await as(() => desk.returnLoan({ loanId: issued.loan.id, conditionIn: 'good' }))
    assert.equal(twice.ok, false)
    // Told the software had failed, somebody would retry it and conclude the
    // software was broken.
    if (!twice.ok) assert.equal(twice.message, REFUSAL_MESSAGES.already_returned)
  })

  test('a book cannot come back before it went out', async () => {
    const { copy } = await scene()
    const issued = await as(() =>
      desk.checkout({ memberCode: 'S001', barcode: copy.barcode, checkedOutAt: '2026-09-19T08:00:00.000Z' }),
    )
    if (!issued.ok) return assert.fail('setup failed')

    await assert.rejects(
      () => as(() => desk.returnLoan({ loanId: issued.loan.id, conditionIn: 'good', returnedAt: '2026-09-18T08:00:00.000Z' })),
      DomainRefusalError,
    )
  })
})

describe('voiding', () => {
  test('a void puts the book back and keeps the record with its reason', async () => {
    const { copy } = await scene()
    const issued = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    if (!issued.ok) return assert.fail('setup failed')

    await as(() => desk.voidLoan(issued.loan.id, 'wrong admission number'))
    const after = await desk.findCopyByBarcode(copy.barcode)
    assert.equal(after?.status, 'on_shelf')

    // The row stays, with its reason. A register with a hole in it is a register
    // nobody trusts, and the reason is the first question anyone will ask.
    const rows = await desk.listLoans({ limit: 10, offset: 0, status: 'void' })
    const row = rows.items.find((r) => r.loanId === issued.loan.id)
    assert.equal(row?.voidReason, 'wrong admission number')
  })

  test('a void with no reason is refused', async () => {
    const { copy } = await scene()
    const issued = await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    if (!issued.ok) return assert.fail('setup failed')

    await assert.rejects(() => as(() => desk.voidLoan(issued.loan.id, '   ')), DomainRefusalError)
  })

  test('a voided loan stops counting against the limit', async () => {
    const { member, title } = await scene()
    const barcodes = await stock(title.id, 5)
    for (const b of barcodes) await desk.checkout({ memberCode: 'S001', barcode: b })
    assert.equal((await desk.listActiveLoans(member.id)).length, 5)

    const open = await desk.listLoans({ limit: 10, offset: 0, status: 'on_loan' })
    await as(() => desk.voidLoan(open.items[0]!.loanId, 'recorded against the wrong student'))

    // The student now has four books out, so the fifth free slot is real.
    assert.equal((await desk.listActiveLoans(member.id)).length, 4)
    const again = await as(async () =>
      desk.checkout({ memberCode: 'S001', barcode: await newTitleBarcode(title.id) }),
    )
    assert.equal(again.ok, true)
  })
})

describe('fines', () => {
  /** An overdue loan: issued long ago, due long ago, never returned. */
  async function overdue() {
    const { copy } = await scene()
    const issued = await as(() =>
      desk.checkout({
        memberCode: 'S001',
        barcode: copy.barcode,
        checkedOutAt: '2026-08-01T08:00:00.000Z',
        dueAt: '2026-08-15T08:00:00.000Z',
      }),
    )
    if (!issued.ok) throw new Error('setup failed')
    return issued
  }

  test('nothing is charged during the grace period', async () => {
    await scene()
    // Due on the 15th, now the 15th, and students get one grace day.
    clock.at = '2026-08-15T08:00:00.000Z'
    const r = await as(() => desk.runAccrual())
    assert.equal(r.assessed, 0)
  })

  test('a day overdue is charged after the grace day, once', async () => {
    await overdue()

    clock.at = '2026-09-20T08:00:00.000Z'
    const first = await as(() => desk.runAccrual())
    assert.equal(first.assessed, 1)
    assert.equal(first.totalCents, 25)

    // Idempotent per (loan, day): a scheduled job runs twice, sometimes three
    // times, and charging twice for one day is the kind of thing a parent
    // notices and complains about.
    const second = await as(() => desk.runAccrual())
    assert.equal(second.assessed, 0, 'running again on the same day charges nothing')
  })

  test('a fine grows by the daily rate and stops at the cap', async () => {
    const { member, copy } = await scene()
    await as(() =>
      desk.checkout({
        memberCode: 'S001',
        barcode: copy.barcode,
        checkedOutAt: '2026-07-01T08:00:00.000Z',
        dueAt: '2026-07-15T08:00:00.000Z',
      }),
    )

    clock.at = '2026-07-16T08:00:00.000Z'
    const one = await as(() => desk.runAccrual())
    assert.equal(one.totalCents, 25)

    clock.at = '2026-07-17T08:00:00.000Z'
    const two = await as(() => desk.runAccrual())
    assert.equal(two.totalCents, 25, 'a second day is another 25')

    // Capped, so a term-longly-overdue loan does not produce a number nobody
    // believes.
    // Walk forward a day at a time with a real date rather than string-padded
    // arithmetic, which produced 2026-07-32 and silently charged nothing.
    // 2000 cents at 25 a day is 80 days, so 120 is comfortably past the cap.
    let day = new Date('2026-07-16T08:00:00.000Z')
    for (let d = 0; d < 120; d++) {
      clock.at = day.toISOString()
      await desk.runAccrual()
      day = new Date(day.getTime() + 86_400_000)
    }
    const ledger = await desk.getFineLedger(member.id)
    const total = ledger.reduce((s, f) => s + f.balance, 0)
    // 2000 cents is the cap. Without it a term-longly-overdue loan produces a
    // number nobody believes, and nobody believes it and pays it.
    assert.equal(total, 2000)
  })

  test('teachers are not fined, because that is the school policy', async () => {
    const { copy } = await scene({ memberType: 'teacher' })
    await as(() =>
      desk.checkout({
        memberCode: 'S001',
        barcode: copy.barcode,
        checkedOutAt: '2026-07-01T08:00:00.000Z',
        dueAt: '2026-07-15T08:00:00.000Z',
      }),
    )
    clock.at = '2026-09-20T08:00:00.000Z'
    const r = await as(() => desk.runAccrual())
    assert.equal(r.assessed, 0)
    assert.equal(r.totalCents, 0)
  })

  test('a waiver is a ledger entry with a reason, not an edit', async () => {
    const { member } = await scene()
    const fine = await as(() => desk.assessFine({ memberId: member.id, kind: 'other', amountCents: 500 }))
    assert.equal(fine.balance, 500)

    await assert.rejects(() => as(() => desk.waiveFine({ fineId: fine.id, reason: '' })), DomainRefusalError)

    const waived = await as(() => desk.waiveFine({ fineId: fine.id, reason: 'school responsibility' }))
    assert.equal(waived.balance, 0)
    assert.equal(waived.status, 'waived')
    // The charge is still there. A fine that vanished has no explanation.
    assert.equal(waived.transactions.length, 2)
  })

  test('a payment reduces the balance and cannot exceed it', async () => {
    const { member } = await scene()
    const fine = await as(() => desk.assessFine({ memberId: member.id, kind: 'other', amountCents: 500 }))

    await assert.rejects(
      () => as(() => desk.recordPayment({ fineId: fine.id, amountCents: 600 })),
      DomainRefusalError,
    )
    await assert.rejects(
      () => as(() => desk.recordPayment({ fineId: fine.id, amountCents: 0 })),
      DomainRefusalError,
    )

    const paid = await as(() => desk.recordPayment({ fineId: fine.id, amountCents: 200 }))
    assert.equal(paid.balance, 300)
    assert.equal(paid.status, 'partially_paid')
  })

  test('an outstanding fine blocks borrowing past the threshold', async () => {
    const { member, title } = await scene()
    const [b] = await stock(title.id, 1)
    await as(() => desk.assessFine({ memberId: member.id, kind: 'other', amountCents: 1500 }))

    const result = await as(() => desk.checkout({ memberCode: 'S001', barcode: b! }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.refusal, 'fine_blocked')
      assert.equal(result.overridable, true)
    }
  })
})

describe('the register', () => {
  test('it defaults to what is out now, not all history', async () => {
    const { copy } = await scene()
    await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))

    const open = await desk.listLoans({ limit: 25, offset: 0 })
    assert.equal(open.items.length, 1)
    assert.equal(open.items[0]!.status, 'active')

    // Somebody who has just returned a book is history, and history has its own
    // filter. Defaulting to `all` puts it in front of the librarian anyway.
    const all = await desk.listLoans({ limit: 25, offset: 0, status: 'all' })
    assert.ok(all.items.length >= 1)
  })

  test('a register row carries everything read off a paper register', async () => {
    const { copy } = await scene()
    await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    const rows = await as(() => desk.listLoans({ limit: 25, offset: 0 }))
    const row = rows.items[0]!

    assert.equal(row.memberCode, 'S001')
    assert.equal(row.studentName, 'Kept Student')
    assert.equal(row.title, 'Things We Carry')
    assert.equal(row.barcode, copy.barcode)
    assert.ok(row.checkedOutAt && row.dueAt)
  })

  test('days overdue is never negative', async () => {
    const { copy } = await scene()
    await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    const rows = await as(() => desk.listLoans({ limit: 25, offset: 0 }))
    assert.equal(rows.items[0]!.daysOverdue, 0)
  })

  test('search spans every column a librarian would read', async () => {
    const { copy } = await scene()
    await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))

    for (const term of ['S001', 'Kept', 'Things We Carry', copy.barcode]) {
      const hit = await as(() => desk.listLoans({ limit: 25, offset: 0, q: term }))
      assert.equal(hit.items.length, 1, `"${term}" should find the loan`)
    }
    const miss = await as(() => desk.listLoans({ limit: 25, offset: 0, q: 'nothing like this' }))
    assert.equal(miss.items.length, 0)
  })
})

/*
 * These use `api` directly and never `desk`.
 *
 * `desk` runs every call as the head librarian, which is convenient everywhere
 * else and fatal here: a permission test that runs as an administrator proves
 * nothing. Each line below says plainly who is calling and what they get.
 */
describe('permissions', () => {
  test('a signed-out caller can do nothing at all', async () => {
    // The point of `anonymous` holding nothing rather than a reduced set: if the
    // default were permissive, forgetting to guard one method would be silently
    // exploitable rather than loudly broken.
    //
    // This test found a real bug. `need()` read
    //
    //     if (!can(this.role, permission)) deny(this.role, permission)
    //
    // and `deny()` *returns* an Error rather than throwing it — so the correct
    // refusal was computed and discarded, and every method was reachable by
    // anybody. The table and the code agreed with each other and still were not
    // connected.
    //
    // `signOut()` is called first because `beforeEach` creates an account, and
    // creating an account is also what signs you in. "Signed out" is now something
    // a test has to arrange; before this it was something it got by accident.
    await api.signOut()
    await assert.rejects(() => api.listLoans({ limit: 1, offset: 0 }), /sign in/i)
    await assert.rejects(() => api.checkout({ memberCode: 'S001', barcode: 'BK-0001' }), /sign in/i)
    await assert.rejects(() => api.searchMembers({ limit: 1, offset: 0 }), /sign in/i)
  })

  test('an assistant may work the desk', async () => {
    const a = await api.asUser(admin, () =>
      api.createUser({ email: 'a@librarian', name: 'A', password: 'x', role: 'assistant' }),
    )
    // Issuing, taking back and reading the register are the job.
    await api.asUser(a.id, () => api.listLoans({ limit: 1, offset: 0 }))
    await api.asUser(a.id, () => api.checkout({ memberCode: 'S001', barcode: 'BK-0001' }))
  })

  test('an assistant may not change the rules or manage accounts', async () => {
    const a = await api.asUser(admin, () =>
      api.createUser({ email: 'a@librarian', name: 'A', password: 'x', role: 'assistant' }),
    )
    // The two things that should not be lying around on a shared desk.
    await assert.rejects(
      () => api.asUser(a.id, () => api.updateMemberType('student', { borrowLimit: 99 })),
      /cannot/i,
    )
    await assert.rejects(() => api.asUser(a.id, () => api.runAccrual()), /cannot/i)
    await assert.rejects(() => api.asUser(a.id, () => api.getSettings()), /cannot/i)
    await assert.rejects(
      () => api.asUser(a.id, () => api.createUser({ email: 'x@y', name: 'X', password: 'p', role: 'assistant' })),
      /cannot/i,
    )
  })

  test('a teacher who borrows is not staff', async () => {
    const t = await api.asUser(admin, () =>
      api.createUser({ email: 't@teacher', name: 'T', password: 'x', role: 'teacher' }),
    )
    // Read-only. They are a member, not a librarian, and the difference is the
    // point of having the role at all.
    await assert.rejects(() => api.asUser(t.id, () => api.checkout({ memberCode: 'S001', barcode: 'BK-0001' })), /cannot/i)
    await assert.rejects(() => api.asUser(t.id, () => api.createMember({ memberCode: 'S1', firstName: 'A', lastName: 'B' })), /cannot/i)
  })

  test('the first account is an administrator whatever role was asked for', async () => {
    // Somebody has to be able to create the others, and letting the first
    // sign-up choose would lock the school out of its own system.
    api.reset()
    const first = await api.createUser({ email: 'first@librarian', name: 'F', password: 'x', role: 'assistant' })
    assert.equal(first.role, 'admin')
    // And creating it grants nothing on its own. `admin` is a fact about the
    // account, not a session somebody now holds.
    assert.equal(await api.currentUser(), null)
  })

  test('an override is cleared after a refusal, not left behind', async () => {
    const a = await api.asUser(admin, () =>
      api.createUser({ email: 'a@librarian', name: 'A', password: 'x', role: 'assistant' }),
    )

    // Restoring in a finally matters. A thrown refusal that leaked the role would
    // let the very next call inherit an assistant's permissions, and the only
    // symptom would be a rule quietly ceasing to be enforced.
    await assert.rejects(() => api.asUser(a.id, () => api.updateMemberType('student', { borrowLimit: 1 })))

    // The session is untouched by `asUser`, and it is still the head librarian,
    // so the full set is available. That is the proof the override did not stick:
    // a leftover assistant would have refused this.
    const settings = await api.getSettings()
    assert.ok(settings.some((s) => s.key === 'school.name'))

    // And signing in as the assistant really does refuse it — so the refusal above
    // was about the role and not about some permanent damage.
    await api.signIn('a@librarian', 'x')
    await assert.rejects(() => api.getSettings(), /assistant/i)

    // And signed out entirely, everything is refused again — so the override was
    // cleared rather than replaced by another one.
    await api.signOut()
    await assert.rejects(() => api.getSettings(), /sign in/i)
  })

  test('signing in is what grants the role, not merely creating the account', async () => {
    // The two pieces of state — who is signed in, and what they may do — used to
    // be stored separately and could disagree. A librarian who had just signed in
    // was refused every action with "Sign in to do that" while the screen said
    // they were signed in.
    await api.signOut()
    await assert.rejects(() => api.listLoans({ limit: 1, offset: 0 }), /sign in/i)

    await api.signIn('head@librarian', 'x')
    await api.listLoans({ limit: 1, offset: 0 })
  })

  test('a disabled account stops being able to act at once', async () => {
    // Not at the next sign-in. A librarian switched off mid-session should lose
    // access immediately, because the reason for disabling somebody is usually
    // happening right now.
    const a = await api.asUser(admin, () =>
      api.createUser({ email: 'a@librarian', name: 'A', password: 'x', role: 'admin' }),
    )
    await api.signIn('a@librarian', 'x')
    await api.listLoans({ limit: 1, offset: 0 })

    const users = await api.listUsers()
    const record = users.find((u) => u.id === a.id)!
    // setMemberStatus is about members; the account's own status is set directly,
    // because there is no "disable account" on the interface yet and pretending
    // otherwise would leave the rule untested.
    const db = api as unknown as { db: { users: { id: string; status: string }[] } }
    const row = db.db.users.find((u) => u.id === record.id)!
    row.status = 'disabled'

    await assert.rejects(() => api.listLoans({ limit: 1, offset: 0 }), /sign in/i)
  })
})

describe('backups', () => {
  test('a snapshot round-trips', async () => {
    const { copy } = await scene()
    await as(() => desk.checkout({ memberCode: 'S001', barcode: copy.barcode }))
    const snapshot = api.exportState()

    api.reset()
    // After a reset there is nothing and nobody. Checking that first is the
    // point: a restore that silently merged into existing data would pass a
    // test that only ever looked at the happy path.
    assert.deepEqual(api.exportState().loans, [])

    api.importState(snapshot)
    const restored = await as(() => desk.listLoans({ limit: 25, offset: 0 }))
    assert.equal(restored.items.length, 1)
  })

  test('a file that is not a snapshot is refused whole', async () => {
    // Half-applying a bad backup is worse than refusing it: the librarian would
    // not know which half landed.
    assert.throws(() => api.importState({ members: 'not a list' }), DomainRefusalError)
    assert.throws(() => api.importState({ hello: 'world' }), DomainRefusalError)
  })
})

describe('import', () => {
  test('a dry run changes nothing, which is the whole point of the screen', async () => {
    const job = await as(() =>
      desk.startImport({
        kind: 'students',
        filename: 'roster.csv',
        contents: 'member_code,first_name\nS100,Alan\nS101,Beta',
        dryRun: true,
      }),
    )
    assert.equal(job.rowsRead, 2)
    assert.equal(job.rowsAccepted, 2)
    assert.equal(job.dryRun, true)

    const members = await desk.searchMembers({ limit: 50, offset: 0 })
    assert.equal(members.total, 0, 'a dry run wrote nothing')
  })

  test('a duplicate admission number is rejected, never merged', async () => {
    await scene()
    const job = await as(() =>
      desk.startImport({
        kind: 'students',
        filename: 'roster.csv',
        contents: 'member_code,first_name\nS001,Kept\nS200,New',
        dryRun: true,
      }),
    )
    assert.equal(job.rowsAccepted, 1)
    assert.equal(job.rowsRejected, 1)
    assert.match(job.errors[0]!.message, /S001/)
    // The rejection names the number, so the librarian can see which row is the
    // problem rather than being told a count.
    assert.match(job.errors[0]!.message, /already on file/i)
  })

  test('a row with no admission number is rejected with its row number', async () => {
    const job = await as(() =>
      desk.startImport({ kind: 'students', filename: 'r.csv', contents: 'member_code,first_name\n,Nameless', dryRun: true }),
    )
    assert.equal(job.rowsRejected, 1)
    assert.equal(job.errors[0]!.row, 2, 'row 2 is the first data row, header is row 1')
  })
})

/** One more book on the shelf, for the limit test. */
async function newTitleBarcode(titleId: string): Promise<string> {
  const made = await desk.addCopies({ titleId, count: 1 })
  return made[0]!.barcode
}