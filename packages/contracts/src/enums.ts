/**
 * Enums — the school's vocabulary, in one place.
 *
 * Every value here is a closed list, and a value added later is a deliberate
 * change rather than a typo that happens to typecheck. Each maps to a CHECK
 * constraint in the database, so the two have to agree.
 */

/** Accounts. Students never have one; staff and teachers who borrow do. */
export const Role = ['admin', 'assistant', 'teacher'] as const
export type Role = (typeof Role)[number]

export const UserStatus = ['active', 'disabled'] as const
export type UserStatus = (typeof UserStatus)[number]

/** Who a member is. Decides loan period, limit, and whether fines apply. */
export const MemberTypeKey = ['student', 'teacher', 'staff', 'external'] as const
export type MemberTypeKey = (typeof MemberTypeKey)[number]

export const MemberStatus = ['active', 'suspended', 'graduated', 'withdrawn'] as const
export type MemberStatus = (typeof MemberStatus)[number]

/** The physical condition of a book, in and out. */
export const CopyCondition = ['good', 'fair', 'poor', 'damaged'] as const
export type CopyCondition = (typeof CopyCondition)[number]

/**
 * Where a copy is.
 *
 * `on_loan` is derivable from the open loans but is stored, because the desk
 * looks up a barcode far more often than it counts loans and this keeps that a
 * single indexed read.
 */
export const CopyStatus = [
  'on_shelf',
  'on_loan',
  'in_transit',
  'at_desk',
  'withdrawn',
  'lost',
  'in_repair',
] as const
export type CopyStatus = (typeof CopyStatus)[number]

/**
 * The only statuses a book may leave the shelf in.
 *
 * Kept as a named list rather than comparing against `'on_shelf'` inline,
 * because "which statuses are issuable" is a question with an answer and the
 * answer should appear exactly once.
 */
export const CHECKABLE_COPY_STATUSES: readonly CopyStatus[] = ['on_shelf']

/**
 * The full list of statuses, exported for the test that asserts exactly one of
 * them is issuable. Not for production code: the answer that matters is
 * CHECKABLE_COPY_STATUSES, and exporting the whole list invites a caller to
 * check against the wrong one.
 */
export const COPY_STATUSES_FOR_TEST = CopyStatus

export const LoanStatus = ['active', 'returned', 'lost', 'damaged', 'void'] as const
export type LoanStatus = (typeof LoanStatus)[number]

/**
 * Every event in a loan's life.
 *
 * Append-only and separate from the loan, so the register can answer "when was
 * this renewed and by whom" without the loan row carrying a history in JSON.
 */
export const LoanEventKind = [
  'checkout',
  'renew',
  'return',
  'void',
  'mark_lost',
  'mark_damaged',
  'override',
] as const
export type LoanEventKind = (typeof LoanEventKind)[number]

export const FineKind = ['overdue', 'lost', 'damage', 'other'] as const
export type FineKind = (typeof FineKind)[number]

export const FineStatus = ['outstanding', 'partially_paid', 'paid', 'waived'] as const
export type FineStatus = (typeof FineStatus)[number]

/**
 * Ledger movements against a fine.
 *
 * Signed in cents: charge positive, everything else negative. The balance is the
 * sum, so it is never written by hand and cannot drift from the entries that
 * explain it.
 */
export const FineTxnKind = ['charge', 'payment', 'waiver', 'refund'] as const
export type FineTxnKind = (typeof FineTxnKind)[number]

export const HoldStatus = ['open', 'filled', 'expired', 'cancelled', 'collected'] as const
export type HoldStatus = (typeof HoldStatus)[number]

export const ImportKind = ['students', 'stock', 'loans'] as const
export type ImportKind = (typeof ImportKind)[number]

/** Loan statuses a register filter can select. */
export const LOAN_FILTERS = ['all', 'on_loan', 'returned', 'overdue', 'void'] as const
export type LoanFilter = (typeof LOAN_FILTERS)[number]