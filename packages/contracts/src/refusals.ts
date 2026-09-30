/**
 * Refusals are values, not exceptions.
 *
 * The circulation desk has to be able to say *why* something was refused. "You
 * already have 5 books out" IS the feature — it is the sentence that stops a
 * librarian issuing a sixth book by accident. Throwing that away forces the UI
 * to guess, and guessing wrong is how staff stop trusting the software.
 *
 * So a refusal is returned in the result, carries its own copy, and the screen
 * renders it. An `Error` would discard the one piece of information that matters.
 *
 * ── Why these are string unions and not zod enums ────────────────────
 *
 * They are only ever used as TypeScript types, never parsed at runtime, and zod's
 * inferred enum types do not reliably reduce to string-literal unions — which
 * breaks indexing into the message table below.
 */

import type { Loan } from './entities.ts'

/**
 * A refusal that cannot be expressed as a result union.
 *
 * Most operations return a union, which is the right shape and needs no error
 * type. `voidLoan` cannot: it returns a `Loan` or fails, and "already voided" or
 * "no such loan" are genuine conflicts with the current state rather than
 * answers.
 *
 * Marked so the server can tell a refusal from a bug. Unmarked, they answered
 * `500 Something went wrong`, and a librarian who voided a book that had already
 * come back was told the software had failed — rather than what they had done
 * wrong and what to do instead.
 */
export class DomainRefusalError extends Error {
  readonly code = 'domain_refusal' as const

  constructor(message: string) {
    super(message)
    this.name = 'DomainRefusalError'
  }
}

/** Reasons a renewal can be refused. */
export const RenewRefusal = [
  'not_found',
  'already_returned',
  'renewal_limit_reached',
  'member_suspended',
  'has_holds',
  'unpaid_fines',
  'too_soon_to_renew',
] as const
export type RenewRefusal = (typeof RenewRefusal)[number]

export type RenewResult =
  | { ok: true; loan: Loan }
  | { ok: false; refusal: RenewRefusal; message: string }

/**
 * Checkout refusals.
 *
 * The highest-traffic operation in the system, so it gets a full union rather
 * than a boolean and a message.
 */
export const CheckoutRefusal = [
  'member_not_found',
  'member_suspended',
  'copy_not_found',
  'copy_on_loan',
  'copy_unavailable',
  'copy_lost',
  'limit_exceeded',
  'fine_blocked',
  'member_not_borrower',
] as const
export type CheckoutRefusal = (typeof CheckoutRefusal)[number]

export type CheckoutResult =
  | { ok: true; loan: Loan; dueAt: string; copyStatus: string }
  | {
      ok: false
      refusal: CheckoutRefusal
      message: string
      /** Whether staff may override this with a recorded reason. */
      overridable: boolean
    }

export const ReturnRefusal = ['not_found', 'already_returned'] as const
export type ReturnRefusal = (typeof ReturnRefusal)[number]

export type ReturnResult =
  | {
      ok: true
      loan: Loan
      /** True when returning this satisfied a hold. */
      holdPromoted: boolean
    }
  | { ok: false; refusal: ReturnRefusal; message: string }

/**
 * The refusal copy, in one place.
 *
 * Kept beside the codes rather than in the screens, so a screen cannot
 * accidentally paraphrase "renewal limit reached" into something that sounds
 * optional. The wording is written for a librarian standing at a desk, not for a
 * developer reading a log.
 */
export const REFUSAL_MESSAGES: Record<CheckoutRefusal | RenewRefusal | ReturnRefusal, string> = {
  // checkout
  member_not_found: 'No student on file with that number.',
  member_suspended: 'That student is not active.',
  copy_not_found: 'No book on file with that number.',
  copy_on_loan: 'That book is already out.',
  copy_unavailable: 'That book is not on the shelf.',
  copy_lost: 'That book has been reported lost.',
  limit_exceeded: 'That student is already at their borrowing limit.',
  fine_blocked: 'That student owes more than they are allowed to owe.',
  member_not_borrower: 'That member cannot borrow.',
  // return
  not_found: 'No such loan record.',
  already_returned: 'That book has already come back.',
  // renew
  renewal_limit_reached: 'That book has been renewed as many times as it can be.',
  has_holds: 'Other students are waiting for that book.',
  unpaid_fines: 'That student owes an outstanding fine.',
  too_soon_to_renew: 'Too soon to renew that book.',
}
// `member_suspended` appears once and serves both unions. It was written twice
// in the first draft, which TypeScript accepts silently — the second value wins
// — so two screens could have shown different wording for the same refusal
// depending on which operation produced it.

/** Refusals staff may override, with a logged reason. */
export const OVERRIDABLE: ReadonlySet<string> = new Set<CheckoutRefusal>([
  'copy_unavailable',
  'limit_exceeded',
  'fine_blocked',
])