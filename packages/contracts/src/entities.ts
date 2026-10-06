/**
 * Entities — one per table.
 *
 * A few decisions worth stating, because each of them is a place where the
 * obvious choice is the wrong one:
 *
 * **Money is integer cents.** No floats, anywhere, ever. A fine ledger that
 * accumulates 0.1 + 0.2 eventually tells a parent they owe a number nobody
 * expects, and no amount of display rounding fixes the stored value.
 *
 * **A due date is a `date`, not an instant.** "Due on Tuesday" means Tuesday at
 * the school, not Tuesday at whichever timezone the browser is in. A loan due at
 * midnight UTC is due on a different day for half the world, which is a bug a
 * librarian finds and a developer does not.
 *
 * **`memberCode` is never normalised.** Leading zeros are significant: `S001` and
 * `S1` are different students. Stripping them produces a register that is wrong
 * and looks right, which is the worst combination available.
 *
 * **A voided loan is kept.** The record was wrong; the fact that it was wrong is
 * worth keeping, and a register with a hole in it is one nobody trusts.
 */
import { z } from 'zod'
import {
  CopyCondition,
  CopyStatus,
  FineKind,
  FineStatus,
  FineTxnKind,
  HoldStatus,
  ImportKind,
  LoanEventKind,
  LoanStatus,
  MemberStatus,
  MemberTypeKey,
  Role,
  UserStatus,
} from './enums.ts'

/** Opaque id. Kept opaque so nothing assumes uuids can be parsed for meaning. */
export const Id = z.string().min(1)

/** A calendar day, `YYYY-MM-DD`. Deliberately not a timestamp — see the header. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** An instant, ISO-8601 with a timezone. */
export const IsoDateTime = z.string().min(10)

/** Integer cents. The only money type in this system. */
export const Money = z.number().int()

// ── Accounts ────────────────────────────────────────────────────────

export const User = z.object({
  id: Id,
  email: z.string().min(3),
  name: z.string().min(1),
  role: z.enum(Role),
  status: z.enum(UserStatus),
  lastLoginAt: IsoDateTime.nullable().default(null),
  createdAt: IsoDateTime,
})
export type User = z.infer<typeof User>

// ── Members ─────────────────────────────────────────────────────────

/**
 * The rules that apply to everyone of a given type.
 *
 * Data rather than code, because the school sets these and a librarian with
 * admin rights changes them at the start of a term. Encoding them as constants
 * would mean a code deploy for a policy change.
 */
export const MemberType = z.object({
  key: z.enum(MemberTypeKey),
  label: z.string().min(1),
  loanPeriodDays: z.number().int().positive(),
  graceDays: z.number().int().min(0).default(1),
  maxRenewals: z.number().int().min(0),
  borrowLimit: z.number().int().min(0),
  canPlaceHolds: z.boolean().default(true),
  /** Teachers are not fined. It is the single most common school policy. */
  fineExempt: z.boolean().default(false),
  fineBlockThreshold: Money.default(1500),
  sortOrder: z.number().int().default(0),
})
export type MemberType = z.infer<typeof MemberType>

export const Member = z.object({
  id: Id,
  /** Set only for staff who also borrow. Students never have a user row. */
  userId: Id.nullable().default(null),
  /** The admission number on their card. Never renumbered once assigned. */
  memberCode: z.string().min(1),
  type: z.enum(MemberTypeKey),
  /**
   * The form or year, e.g. "Form 3".
   *
   * Free text on purpose: the school names its own forms, and a constrained list
   * here would be a list the school has to argue with every year. Suggestion
   * lists in the interface draw from what the school has actually used.
   */
  form: z.string().nullable().default(null),
  /**
   * The stream within the form. Kenyan secondary schools commonly split a large
   * cohort into named streams, so a student is "Form 3, Red Stream" and a form
   * on its own is not enough to identify them.
   */
  stream: z.string().nullable().default(null),
  grade: z.string().nullable().default(null),
  className: z.string().nullable().default(null),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  guardianName: z.string().nullable().default(null),
  guardianEmail: z.string().nullable().default(null),
  joinDate: IsoDate,
  status: z.enum(MemberStatus),
  notes: z.string().nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type Member = z.infer<typeof Member>

/** What a search result needs. The full record is a second fetch. */
export const MemberSummary = z.object({
  id: Id,
  memberCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  type: z.enum(MemberTypeKey),
  form: z.string().nullable(),
  stream: z.string().nullable(),
  grade: z.string().nullable(),
  className: z.string().nullable(),
  status: z.enum(MemberStatus),
  outstandingFine: Money.default(0),
})
export type MemberSummary = z.infer<typeof MemberSummary>

// ── Catalog ─────────────────────────────────────────────────────────

export const Title = z.object({
  id: Id,
  isbn: z.string().nullable().default(null),
  title: z.string().min(1),
  author: z.string().min(1),
  publisher: z.string().nullable().default(null),
  publishedYear: z.number().int().nullable().default(null),
  edition: z.string().nullable().default(null),
  subject: z.string().nullable().default(null),
  callNumber: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type Title = z.infer<typeof Title>

export const ShelfLocation = z.object({
  id: Id,
  code: z.string().min(1),
  label: z.string().min(1),
})
export type ShelfLocation = z.infer<typeof ShelfLocation>

export const Copy = z.object({
  id: Id,
  titleId: Id,
  /** The number on the spine. Unique, and leading zeros are significant. */
  barcode: z.string().min(1),
  locationId: Id.nullable().default(null),
  condition: z.enum(CopyCondition),
  status: z.enum(CopyStatus),
  acquiredOn: IsoDate.nullable().default(null),
  replacementCost: Money.nullable().default(null),
  notes: z.string().nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type Copy = z.infer<typeof Copy>

// ── Circulation ─────────────────────────────────────────────────────

export const Loan = z.object({
  id: Id,
  memberId: Id,
  copyId: Id,
  checkedOutAt: IsoDateTime,
  dueAt: IsoDateTime,
  returnedAt: IsoDateTime.nullable().default(null),
  renewCount: z.number().int().min(0).default(0),
  status: z.enum(LoanStatus),
  /** Why a librarian voided this, and when. Never deleted. */
  voidReason: z.string().nullable().default(null),
  voidedAt: IsoDateTime.nullable().default(null),
  /** Null when the system is run without a signed-in account. */
  checkedOutBy: Id.nullable().default(null),
  conditionOut: z.enum(CopyCondition),
  conditionIn: z.enum(CopyCondition).nullable().default(null),
  notes: z.string().nullable().default(null),
})
export type Loan = z.infer<typeof Loan>

/**
 * One line of the issue register.
 *
 * This is the record the school keeps on paper: admission number, name, class,
 * book title, book number, date taken, date due, date returned. It is derived
 * from the schema rather than written beside it, so the two cannot disagree.
 */
export const LoanRow = z.object({
  loanId: Id,
  memberCode: z.string(),
  studentName: z.string(),
  grade: z.string().nullable(),
  form: z.string().nullable(),
  stream: z.string().nullable(),
  className: z.string().nullable(),
  title: z.string(),
  author: z.string(),
  barcode: z.string(),
  copyStatus: z.enum(CopyStatus),
  checkedOutAt: IsoDateTime,
  dueAt: IsoDateTime,
  returnedAt: IsoDateTime.nullable(),
  status: z.enum(LoanStatus),
  daysOverdue: z.number().int(),
  voidReason: z.string().nullable(),
})
export type LoanRow = z.infer<typeof LoanRow>

export const LoanEvent = z.object({
  id: Id,
  loanId: Id,
  kind: z.enum(LoanEventKind),
  /** Who did it. Null for system-driven changes like nightly accrual. */
  actor: Id.nullable().default(null),
  note: z.string().nullable().default(null),
  meta: z.record(z.unknown()).default({}),
  createdAt: IsoDateTime,
})
export type LoanEvent = z.infer<typeof LoanEvent>

export const Hold = z.object({
  id: Id,
  memberId: Id,
  titleId: Id,
  placedAt: IsoDateTime,
  /** Null until filled. */
  copyId: Id.nullable().default(null),
  expiresAt: IsoDateTime.nullable().default(null),
  status: z.enum(HoldStatus),
})
export type Hold = z.infer<typeof Hold>

// ── Fines ───────────────────────────────────────────────────────────

export const Fine = z.object({
  id: Id,
  memberId: Id,
  loanId: Id.nullable().default(null),
  copyId: Id.nullable().default(null),
  kind: z.enum(FineKind),
  assessedAmount: Money,
  /** Derived from the ledger. Never written by hand. */
  balance: Money,
  assessedAt: IsoDateTime,
  status: z.enum(FineStatus),
  note: z.string().nullable().default(null),
  createdBy: Id.nullable().default(null),
  createdAt: IsoDateTime,
})
export type Fine = z.infer<typeof Fine>

/** APPEND-ONLY. A correction is a new row; there is no update path. */
export const FineTxn = z.object({
  id: Id,
  fineId: Id,
  kind: z.enum(FineTxnKind),
  /** Signed cents: charge positive, payment/waiver/refund negative. */
  amount: Money,
  reason: z.string().nullable().default(null),
  actorUserId: Id.nullable().default(null),
  /**
   * Carries the accrual day so the nightly job is idempotent per (loan, day).
   * Never edited after insert — that is what append-only means.
   */
  meta: z.record(z.unknown()).default({}),
  createdAt: IsoDateTime,
})
export type FineTxn = z.infer<typeof FineTxn>

export const FineDetail = Fine.extend({
  memberCode: z.string(),
  memberName: z.string(),
  transactions: z.array(FineTxn).default([]),
})
export type FineDetail = z.infer<typeof FineDetail>

// ── Ops ─────────────────────────────────────────────────────────────

export const MemberDetail = Member.extend({
  activeLoans: z.array(Loan).default([]),
  outstandingFine: Money.default(0),
})
export type MemberDetail = z.infer<typeof MemberDetail>

export const TitleDetail = Title.extend({
  copies: z.array(Copy).default([]),
})
export type TitleDetail = z.infer<typeof TitleDetail>

export const TitleSummary = z.object({
  id: Id,
  title: z.string(),
  author: z.string(),
  isbn: z.string().nullable(),
  callNumber: z.string().nullable(),
  copyCount: z.number().int().min(0),
  availableCount: z.number().int().min(0),
})
export type TitleSummary = z.infer<typeof TitleSummary>

export const ImportRowError = z.object({
  row: z.number().int(),
  field: z.string(),
  message: z.string(),
  value: z.string().optional(),
})
export type ImportRowError = z.infer<typeof ImportRowError>

export const ImportJob = z.object({
  id: Id,
  kind: z.enum(ImportKind),
  filename: z.string(),
  dryRun: z.boolean(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable().default(null),
  rowsRead: z.number().int().min(0).default(0),
  rowsAccepted: z.number().int().min(0).default(0),
  rowsRejected: z.number().int().min(0).default(0),
  errors: z.array(ImportRowError).default([]),
})
export type ImportJob = z.infer<typeof ImportJob>

export const AuditEntry = z.object({
  id: Id,
  actor: Id.nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  before: z.record(z.unknown()).nullable().default(null),
  after: z.record(z.unknown()).nullable().default(null),
  createdAt: IsoDateTime,
})
export type AuditEntry = z.infer<typeof AuditEntry>

export const Setting = z.object({
  key: z.string(),
  value: z.unknown(),
})
export type Setting = z.infer<typeof Setting>

export const Notification = z.object({
  id: Id,
  kind: z.string(),
  message: z.string(),
  createdAt: IsoDateTime,
  read: z.boolean().default(false),
})
export type Notification = z.infer<typeof Notification>

export const DashboardSummary = z.object({
  totalTitles: z.number().int().min(0),
  totalCopies: z.number().int().min(0),
  onLoan: z.number().int().min(0),
  overdue: z.number().int().min(0),
  outstandingFines: Money,
  activeMembers: z.number().int().min(0),
})
export type DashboardSummary = z.infer<typeof DashboardSummary>

export const LibrarySnapshot = z.object({
  users: z.array(User),
  memberTypes: z.array(MemberType),
  members: z.array(Member),
  titles: z.array(Title),
  shelfLocations: z.array(ShelfLocation),
  copies: z.array(Copy),
  loans: z.array(Loan),
  holds: z.array(Hold),
  fines: z.array(Fine),
  fineTxns: z.array(FineTxn),
  audit: z.array(AuditEntry),
  imports: z.array(ImportJob),
  settings: z.record(z.string(), z.unknown()),
})
export type LibrarySnapshot = z.infer<typeof LibrarySnapshot>

export const ReportResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  generatedAt: IsoDateTime,
})
export type ReportResult = z.infer<typeof ReportResult>

/** What a form supplies when creating a title. */
export const TitleCreateInput = z.object({
  title: z.string().min(1),
  author: z.string().min(1),
  isbn: z.string().nullable().default(null),
  publisher: z.string().nullable().default(null),
  publishedYear: z.number().int().nullable().default(null),
  subject: z.string().nullable().default(null),
  callNumber: z.string().nullable().default(null),
  copyCount: z.number().int().min(1).max(500).default(1),
})
export type TitleCreateInput = z.infer<typeof TitleCreateInput>

export type TitleInput = Partial<z.infer<typeof TitleCreateInput>>