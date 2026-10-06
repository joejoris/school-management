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

import type { FineDetail, Loan } from './entities.ts'

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

/**
 * Reasons a renewal can be refused.
 *
 * `unpaid_fines` and `too_soon_to_renew` were here and nothing could ever return them:
 * the rule about owing money is called `fine_blocked` on a checkout and does not apply
 * to a renewal, and no "too soon" rule exists in the domain at all. Both were found by
 * `npm run check:sql`, which cross-checks the codes the database returns against these
 * unions.
 *
 * They are removed rather than kept as a wish list. A union that lists a refusal
 * nothing can return is one somebody will eventually write a screen case for, and that
 * case will be dead code with a sentence in it.
 */
export const RenewRefusal = ['not_found', 'already_returned', 'renewal_limit_reached', 'member_suspended', 'has_holds'] as const
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
  'issued_in_future',
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

/**
 * Reasons a return can be refused.
 *
 * `returned_before_issued` was missing here, and that is why the in-memory domain
 * threw an exception for it instead of returning a value: there was nowhere for it
 * to go. Every other refusal in the same function is a returned sentence, so one
 * refusal arriving as a thrown error meant the screens had two paths to handle for
 * no reason a person at a desk could act on.
 */
export const ReturnRefusal = ['not_found', 'already_returned', 'returned_before_issued'] as const
export type ReturnRefusal = (typeof ReturnRefusal)[number]

/**
 * Reasons a void can be refused.
 *
 * `voidLoan` was declared `Promise<Loan>`, which cannot express a refusal at all —
 * so the three reasons below had nowhere to go and the interface could only throw.
 * Every sibling in that switch statement returns a sentence, and a void that arrives
 * as an exception while a return arrives as a value means the same desk handles two
 * failure paths for the same kind of mistake.
 *
 * Found by `npm run check:sql`, which cross-checks the refusal codes the database can
 * return against the unions the interface knows about.
 */
export const VoidRefusal = ['not_found', 'not_active', 'reason_required', 'forbidden'] as const
export type VoidRefusal = (typeof VoidRefusal)[number]

/**
 * Refusals about the *account* rather than the book.
 *
 * These arrive from the staff and setup functions, which have no result shape of their
 * own — they return an object or raise — so they are thrown as a `SupabaseRefusal`
 * carrying this code. Collected here so the codes are typed and greppable rather than
 * being strings typed into two different files and hoped to match.
 */
export const AdminRefusal = ['forbidden', 'not_found', 'self', 'last_admin', 'already_set_up'] as const
export type AdminRefusal = (typeof AdminRefusal)[number]

export type VoidResult =
  | { ok: true; loan: Loan }
  | { ok: false; refusal: VoidRefusal; message: string }

/**
 * Reasons a payment or a waiver can be refused.
 *
 * `recordPayment` and `waiveFine` were both `Promise<FineDetail>`, which cannot express
 * a refusal — and both can refuse for ordinary reasons: no such fine, an amount of
 * zero, more than the outstanding balance, a fine that is already settled, a waiver
 * with no reason.
 *
 * Those are the refusals a school is most likely to hit by accident, and they were all
 * reaching the fines screen as exceptions. Told the software had failed, somebody pays
 * again and concludes the software is broken.
 */
export const PaymentRefusal = [
  'not_found',
  'forbidden',
  'bad_amount',
  'too_much',
  'already_settled',
  'reason_required',
] as const
export type PaymentRefusal = (typeof PaymentRefusal)[number]

export type PaymentResult =
  | { ok: true; fine: FineDetail }
  | { ok: false; refusal: PaymentRefusal; message: string }

export const BackupRefusal = ['malformed', 'restore_refused', 'forbidden'] as const
export type BackupRefusal = (typeof BackupRefusal)[number]

export type BackupResult =
  | {
      ok: true
      restored: { members: number; titles: number; copies: number; loans: number }
    }
  | { ok: false; refusal: BackupRefusal; message: string }

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
export const REFUSAL_MESSAGES: Record<
  CheckoutRefusal | RenewRefusal | ReturnRefusal | VoidRefusal | PaymentRefusal | AdminRefusal | BackupRefusal,
  string
> = {
  // backup
  malformed: 'That file is not a library backup.',
  restore_refused:
    'The school’s system never rewrites the register from a browser. This file is a copy to keep, not something to put back.',
  // checkout
  member_not_found: 'No student on file with that number.',
  member_suspended: 'That student is not active.',
  copy_not_found: 'No book on file with that number.',
  copy_on_loan: 'That book is already out.',
  copy_unavailable: 'That book is not on the shelf.',
  copy_lost: 'That book has been reported lost.',
  limit_exceeded: 'That student is already at their borrowing limit.',
  fine_blocked: 'That student owes more than they are allowed to owe.',
  /*
   * A loan dated ahead of the clock cannot be closed, so refusing it here is kinder
   * than accepting it and failing days later with nothing to act on. The wording
   * names the cause, because the cause is always a mis-typed or defaulted date rather
   * than a person doing something wrong.
   */
  issued_in_future: 'A book cannot go out on a date that has not happened yet.',
  // return
  not_found: 'No such loan record.',
  already_returned: 'That book has already come back.',
  /*
   * Said as a question about the dates, because the cause is always a date rather
   * than a permission: the loan is stamped for a day that has not happened. "Check
   * the date it went out" is the only thing a librarian can do about it, so the
   * sentence has to say so.
   */
  returned_before_issued: 'That book is recorded as going out later than it came back. Check the date it went out.',
  // renew
  renewal_limit_reached: 'That book has been renewed as many times as it can be.',
  has_holds: 'Other students are waiting for that book.',
  /*
   * `not_active` names the state the loan is actually in, because "cannot be voided"
   * on its own sends somebody hunting through the register to work out why. The state
   * is the answer they need.
   */
  not_active: 'That loan is not open any more, so there is nothing to void.',
  reason_required: 'That needs a reason. It is the first thing anyone will ask.',
  forbidden: 'Your role cannot do that.',
  /*
   * Money sentences.
   *
   * `bad_amount` says "whole number of shillings" rather than "greater than zero"
   * because the number a librarian types is in shillings and the stored value is in
   * cents, and the two being different units is exactly where the mistake comes from.
   */
  bad_amount: 'That is not an amount — enter a whole number of shillings, more than zero.',
  too_much: 'That is more than is outstanding.',
  already_settled: 'That fine is already settled.',
  // admin and setup
  /*
   * `self` and `last_admin` are the two ways somebody can lock the school out of its
   * own register. Both sentences say what happened and what to do, because the person
   * reading them is an administrator who has just been told no by their own software
   * and will want to know whether it is a fault or a rule.
   */
  self: 'You cannot do that to your own account.',
  last_admin: 'That is the last working account. Switch off or demote another first.',
  already_set_up: 'This library already has an account. Sign in instead.',
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