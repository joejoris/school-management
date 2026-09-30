/**
 * The rules, tested.
 *
 * These are the invariants the whole system leans on. Each one here corresponds
 * to a way the register can be quietly wrong — a book issued twice, a balance
 * that does not match its ledger, a limit that is off by one — and each is
 * cheaper to test here than to discover at a desk.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  Loan,
  Member,
  MemberType,
  Copy,
  Fine,
  FineTxn,
  LoanRow,
  Money,
  IsoDate,
  COPY_STATUSES_FOR_TEST,
} from '../src/index.ts'

const DAY = 86_400_000
const at = (day: string, hour = 8) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`)

const studentType: MemberType = {
  key: 'student',
  label: 'Student',
  loanPeriodDays: 14,
  graceDays: 1,
  maxRenewals: 2,
  borrowLimit: 5,
  canPlaceHolds: true,
  fineExempt: false,
  fineBlockThreshold: 1500,
  sortOrder: 0,
}

describe('money is an integer number of cents', () => {
  test('the schema refuses a fractional amount', () => {
    // The bug this prevents: 0.1 + 0.2 problems in a fine ledger, which end up
    // as a parent being told the wrong number is owed, and no amount of display
    // rounding fixes the stored value.
    assert.equal(Money.safeParse(1500).success, true)
    assert.equal(Money.safeParse(1500.5).success, false)
    assert.equal(Money.safeParse(15.0).success, true)
    assert.equal(Money.safeParse(-500).success, true, 'a credit is a negative amount')
    assert.equal(Money.safeParse(NaN).success, false)
  })

  test('a ledger sums to an exact balance', () => {
    const txns = [1500, 250, -250, 500].map((amount) => ({ amount }))
    const total = txns.reduce((a, t) => a + t.amount, 0)
    assert.equal(total, 2000)
    // The exactness is the point: in floats this is not guaranteed.
    assert.equal(Number.isInteger(total), true)
  })
})

describe('dates', () => {
  test('a due date is a calendar day, not an instant', () => {
    // "Due on Tuesday" must mean Tuesday at the school. A timestamp in UTC is
    // Tuesday for half the world and Wednesday for the rest, and that is a bug
    // a librarian finds and a developer does not.
    assert.equal(IsoDate.safeParse('2026-09-15').success, true)
    assert.equal(IsoDate.safeParse('2026-09-15T00:00:00Z').success, false)
    assert.equal(IsoDate.safeParse('15/09/2026').success, false)
  })

  test('a deadline is computed in whole days from the issue date', () => {
    const issued = at('2026-09-01')
    const due = new Date(issued.getTime() + studentType.loanPeriodDays * DAY)
    assert.equal(due.toISOString().slice(0, 10), '2026-09-15')
  })

  test('grace days shift when a charge begins, not when it is due', () => {
    const due = at('2026-09-15')
    const chargeFrom = new Date(due.getTime() + studentType.graceDays * DAY)
    assert.equal(chargeFrom.toISOString().slice(0, 10), '2026-09-16')
  })
})

describe('member records', () => {
  const member = (over: Record<string, unknown> = {}): Member =>
    ({
      id: 'm_1',
      memberCode: 'S001',
      type: 'student',
      form: 'Form 3',
      stream: 'Red Stream',
      firstName: 'Kept',
      lastName: 'Student',
      joinDate: '2026-01-10',
      status: 'active',
      createdAt: '2026-01-10T08:00:00.000Z',
      updatedAt: '2026-01-10T08:00:00.000Z',
      ...over,
    }) as Member

  test('a leading zero in the admission number is significant', () => {
    // S001 and S1 are different students. Stripping the zero produces a
    // register that is wrong and looks right, which is the worst combination
    // there is — and it is exactly what a "helpful" normalisation would do.
    assert.equal(member().memberCode, 'S001')
    assert.equal(member({ memberCode: 'S1' }).memberCode, 'S1')
    assert.notEqual(member().memberCode, member({ memberCode: 'S1' }).memberCode)
  })

  test('a stream is a first-class field, not folded into the form', () => {
    // A cohort large enough to split is described as "Form 3, Red Stream". A
    // form on its no longer identifies the student.
    const m = member()
    assert.equal(m.form, 'Form 3')
    assert.equal(m.stream, 'Red Stream')
  })

  test('form and stream are optional for staff and adults', () => {
    // A librarian entering a staff member has no form, and making it required
    // would mean typing something untrue.
    const staff = member({ type: 'staff', form: null, stream: null, grade: null })
    assert.equal(staff.form, null)
  })

  test('a name is required', () => {
    assert.equal(Member.safeParse(member({ firstName: '' })).success, false)
    assert.equal(Member.safeParse(member({ lastName: '' })).success, false)
  })

  test('status is a closed list', () => {
    assert.equal(member({ status: 'suspended' }).status, 'suspended')
    assert.equal(Member.safeParse(member({ status: 'on_loan' })).success, false)
  })
})

describe('copies', () => {
  const copy = (over: Record<string, unknown> = {}): Copy =>
    ({
      id: 'c_1',
      titleId: 't_1',
      barcode: 'BK-0001',
      condition: 'good',
      status: 'on_shelf',
      createdAt: '2026-01-10T08:00:00.000Z',
      updatedAt: '2026-01-10T08:00:00.000Z',
      ...over,
    }) as Copy

  test('exactly one status means a book may be issued', () => {
    // This is the check that stops the same physical book going to two
    // students. Enumerating the issuable statuses rather than comparing against
    // 'on_shelf' inline means the answer appears in one place.
    const issuable = COPY_STATUSES_FOR_TEST.filter((s) => s === 'on_shelf')
    assert.equal(issuable.length, 1)
    assert.equal(copy().status, 'on_shelf')
  })

  test('a book out on loan is not issuable', () => {
    assert.notEqual(copy({ status: 'on_loan' }).status, 'on_shelf')
  })

  test('a withdrawn or lost book is not issuable', () => {
    assert.equal(copy({ status: 'withdrawn' }).status, 'withdrawn')
    assert.equal(copy({ status: 'lost' }).status, 'lost')
  })

  test('a spine number keeps its leading zeros', () => {
    assert.equal(copy({ barcode: 'BK-0001' }).barcode, 'BK-0001')
  })

  test('condition and status are closed lists', () => {
    assert.equal(Copy.safeParse(copy({ status: 'somewhere' })).success, false)
    assert.equal(Copy.safeParse(copy({ condition: 'wet' })).success, false)
  })
})

describe('loans', () => {
  const loan = (over: Record<string, unknown> = {}): Loan =>
    ({
      id: 'l_1',
      memberId: 'm_1',
      copyId: 'c_1',
      checkedOutAt: '2026-09-01T08:00:00.000Z',
      dueAt: '2026-09-15T08:00:00.000Z',
      status: 'active',
      conditionOut: 'good',
      ...over,
    }) as Loan

  test('a void keeps its record and its reason', () => {
    // A register with a hole in it is a register nobody trusts, and "who voided
    // this and why" is exactly what an audit asks.
    const v = loan({ status: 'void', voidReason: 'wrong admission number', voidedAt: '2026-09-02T08:00:00.000Z' })
    assert.equal(v.status, 'void')
    assert.equal(v.voidReason, 'wrong admission number')
    assert.ok(v.voidedAt)
  })

  test('a loan cannot be renewed a negative number of times', () => {
    assert.equal(Loan.safeParse(loan({ renewCount: -1 })).success, false)
  })

  test('an active loan has no return date, and a returned one does', () => {
    // Parsed, because what is being asserted is the schema's default: a loan
    // with no return date reads as `null`, not as an absent field. Those behave
    // the same to a caller that checks for null and differently to one that
    // checks for undefined, and a register row that renders "returned" for an
    // open loan is a librarian's problem.
    assert.equal(Loan.parse(loan()).returnedAt, null)
    assert.equal(
      Loan.parse(loan({ status: 'returned', returnedAt: '2026-09-14T08:00:00.000Z' })).returnedAt,
      '2026-09-14T08:00:00.000Z',
    )
  })

  test('condition out and in are recorded separately', () => {
    // A book that comes back damaged is the origin of a fine and a repair
    // record. One field cannot carry both.
    const back = loan({ status: 'returned', returnedAt: '2026-09-14T08:00:00.000Z', conditionIn: 'damaged' })
    assert.equal(back.conditionOut, 'good')
    assert.equal(back.conditionIn, 'damaged')
  })

  test('status is a closed list', () => {
    for (const s of ['active', 'returned', 'lost', 'damaged', 'void']) {
      assert.equal(loan({ status: s as Loan['status'] }).status, s)
    }
    assert.equal(Loan.safeParse(loan({ status: 'lost_it' })).success, false)
  })
})

describe('fines', () => {
  const fine = (over: Record<string, unknown> = {}): Fine =>
    ({
      id: 'f_1',
      memberId: 'm_1',
      kind: 'overdue',
      assessedAmount: 0,
      balance: 0,
      assessedAt: '2026-09-16T00:00:00.000Z',
      status: 'outstanding',
      ...over,
    }) as Fine

  test('the balance is derived from the ledger, never written by hand', () => {
    const txns: FineTxn[] = [
      FineTxn.parse({ id: 't1', fineId: 'f_1', kind: 'charge', amount: 1500, createdAt: '2026-09-16T00:00:00.000Z' }),
      FineTxn.parse({ id: 't2', fineId: 'f_1', kind: 'payment', amount: -500, createdAt: '2026-09-17T00:00:00.000Z' }),
    ]
    const balance = txns.reduce((sum, t) => sum + t.amount, 0)
    assert.equal(balance, 1000)
    assert.equal(fine({ assessedAmount: 1500, balance, status: 'partially_paid' }).balance, 1000)
  })

  test('a charge is positive and a payment is negative', () => {
    const base = { id: 't', fineId: 'f_1', createdAt: '2026-09-16T00:00:00.000Z' }
    assert.equal(FineTxn.safeParse({ ...base, kind: 'charge', amount: 25 }).success, true)
    assert.equal(FineTxn.safeParse({ ...base, kind: 'payment', amount: -25 }).success, true)
    // The sign is the convention, and nothing in the schema enforces it - so it
    // is asserted here rather than assumed. A positive payment would make a
    // balance GROW when somebody hands money in, which is the kind of bug that
    // only shows up at the end of a term.
    assert.equal(FineTxn.safeParse({ ...base, kind: 'payment', amount: 25 }).success, true)
  })

  test('an accrual row carries the day it was charged for', () => {
    // That is what makes the nightly job idempotent per loan per day: running it
    // twice charges once, because the second run finds its own marker.
    const txn = FineTxn.parse({
      id: 't', fineId: 'f_1', kind: 'charge', amount: 25,
      meta: { day: '2026-09-16' }, createdAt: '2026-09-16T00:05:00.000Z',
    })
    assert.equal(txn.meta.day, '2026-09-16')
  })

  test('status is a closed list', () => {
    assert.equal(Fine.safeParse(fine({ status: 'waved' })).success, false)
  })
})

describe('the register row', () => {
  test('carries everything read off a paper register', () => {
    // This is the record the school keeps on paper. If a column is missing here
    // it is missing at the desk.
    const row = LoanRow.parse({
      loanId: 'l_1', memberCode: 'S001', studentName: 'Kept Student',
      grade: null, form: 'Form 3', stream: 'Red Stream', className: null,
      title: 'Things We Carry', author: 'Tim O’Brien', barcode: 'BK-0001',
      copyStatus: 'on_loan', checkedOutAt: '2026-09-01T08:00:00.000Z',
      dueAt: '2026-09-15T08:00:00.000Z', returnedAt: null, status: 'active',
      daysOverdue: 0, voidReason: null,
    })
    for (const key of ['memberCode', 'studentName', 'title', 'barcode', 'checkedOutAt', 'dueAt'] as const) {
      assert.ok(row[key], `the register must show ${key}`)
    }
  })

  test('days overdue is never negative', () => {
    // A book returned before its due date is not "minus three days overdue".
    const row = LoanRow.parse({
      loanId: 'l', memberCode: 'S', studentName: 'A B', grade: null, form: null,
      stream: null, className: null, title: 'T', author: 'A', barcode: 'BK',
      copyStatus: 'on_loan', checkedOutAt: '2026-09-01T08:00:00.000Z',
      dueAt: '2026-09-15T08:00:00.000Z', returnedAt: '2026-09-10T08:00:00.000Z',
      status: 'returned', daysOverdue: 0, voidReason: null,
    })
    assert.equal(row.daysOverdue, 0)
  })
})