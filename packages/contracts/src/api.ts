/**
 * `LibraryApi` — the only interface the interface layer knows about.
 *
 * Framework-free on purpose: no React, no fetch, no mocking library. That is
 * what lets the domain be tested without a browser and lets any backend be
 * validated into these shapes.
 *
 * Two rules that save pain later, stated once:
 *
 *   - **Every list operation returns a `Page<T>`.** Always. See page.ts.
 *   - **Refusals are returned, not thrown.** See refusals.ts.
 *
 * The interface is deliberately larger than what is implemented. A method that
 * exists here and throws is visible and honest; a method that is missing is a
 * compile error somewhere unrelated, and the gap gets papered over.
 */
import type {
  AuditEntry,
  Copy,
  DashboardSummary,
  Fine,
  FineDetail,
  Hold,
  ImportJob,
  ImportRowError,
  Loan,
  LoanRow,
  Member,
  MemberDetail,
  MemberSummary,
  MemberType,
  Notification,
  ReportResult,
  Setting,
  ShelfLocation,
  Title,
  TitleDetail,
  TitleSummary,
  User,
} from './entities.ts'
import type { CopyCondition, CopyStatus, MemberStatus, Role, UserStatus } from './enums.ts'
import type { CheckoutResult, PaymentResult, RenewResult, ReturnResult, VoidResult } from './refusals.ts'
import type { Page, PageQuery } from './page.ts'

// ── Queries ─────────────────────────────────────────────────────────

export interface TitleQuery extends PageQuery {
  /** Free text across title, author, ISBN and call number. */
  q?: string
  subject?: string
  availability?: 'any' | 'available' | 'unavailable'
}

export interface MemberQuery extends PageQuery {
  /** Free text across admission number and name. */
  q?: string
  type?: string
  status?: MemberStatus
  grade?: string
}

export interface LoanQuery extends PageQuery {
  /**
   * Free text across admission number, name, title and book number.
   *
   * The register's search is the librarian's main tool at a busy desk, so it
   * spans every column anyone would read off a paper register.
   */
  q?: string
  /**
   * `on_loan` is the default rather than `all`.
   *
   * Someone opening the register wants what is out now. A thousand returned
   * loans is history, and history has its own place.
   */
  status?: 'all' | 'on_loan' | 'returned' | 'overdue' | 'void'
  grade?: string
  className?: string
}

export interface AuditQuery extends PageQuery {
  entityType?: string
  action?: string
}

export interface FineQuery extends PageQuery {
  status?: string
}

// ── Inputs ──────────────────────────────────────────────────────────

export interface CreateUserInput {
  email: string
  name: string
  /** Plain text, hashed before it is stored. Never persisted. */
  password: string
  role: Role
}

export interface CheckoutInput {
  memberCode: string
  barcode: string
  /**
   * An explicit deadline, overriding the member type's loan period.
   *
   * Needed because the record-keeping screen asks the librarian for the date
   * directly: an exam week or a class set is not "14 days from today", and
   * deriving it there would be inventing a deadline the school never set.
   */
  dueAt?: string
  /**
   * An explicit issue date, for writing up a loan that already happened.
   *
   * Backdating is honest: the resulting loan genuinely is overdue from the
   * moment it is recorded, and the register says so.
   */
  checkedOutAt?: string
  /**
   * The student's name, used only when `memberCode` is not yet on file.
   * Ignored for an existing student — a librarian mistyping a name must not
   * rename somebody who already exists.
   */
  studentName?: string
  /** Enrolment details, also only when creating the student. */
  form?: string
  stream?: string
  grade?: string
  className?: string
  /** Staff-supplied reason. Required whenever `override` is true. */
  overrideReason?: string
  override?: boolean
}

export interface RenewInput {
  loanId: string
  override?: boolean
  overrideReason?: string
}

export interface ReturnInput {
  loanId: string
  conditionIn: CopyCondition
  /** When the book actually came back. Defaults to now. */
  returnedAt?: string
  /** Set when a copy is going to processing rather than back to the shelf. */
  toShelf?: boolean
}

export interface WaiveFineInput {
  fineId: string
  reason: string
}

export interface RecordPaymentInput {
  fineId: string
  amountCents: number
  reason?: string
}

export interface PlaceHoldInput {
  memberId: string
  titleId: string
}

export interface AddCopiesInput {
  titleId: string
  count: number
  barcodePrefix?: string
  condition?: CopyCondition
}

export interface UpdateCopyInput {
  condition?: CopyCondition
  status?: CopyStatus
  locationId?: string | null
  notes?: string | null
}

export interface UpdateMemberInput {
  type?: string
  grade?: string | null
  className?: string | null
  email?: string | null
  phone?: string | null
  guardianName?: string | null
  guardianEmail?: string | null
  status?: MemberStatus
  notes?: string | null
}

export interface UpdateMemberTypeInput {
  loanPeriodDays?: number
  graceDays?: number
  maxRenewals?: number
  borrowLimit?: number
  canPlaceHolds?: boolean
  fineExempt?: boolean
  fineBlockThreshold?: number
}

export interface AssessFineInput {
  memberId: string
  kind: Fine['kind']
  amountCents: number
  note?: string
}

export interface ImportStartInput {
  kind: ImportJob['kind']
  filename: string
  contents: string
  /** Defaults true. Staff must explicitly commit. */
  dryRun?: boolean
}

// ── The interface ───────────────────────────────────────────────────

export interface LibraryApi {
  // ── Accounts ───────────────────────────────────────────────
  /**
   * Creates an account.
   *
   * The first account is always an admin, whatever role is asked for: somebody
   * has to be able to create the others, and letting the first sign-up choose
   * would lock the school out of its own system. That account is signed in
   * immediately — the person setting it up is at the machine.
   */
  createUser(input: CreateUserInput): Promise<User>

  /**
   * Appoints somebody who already has credentials.
   *
   * A separate method from `createUser` because the two are genuinely different acts, and
   * conflating them broke the only way to get a second librarian into the school.
   *
   * `createUser` is the *first* librarian. It refuses once any account exists — that is
   * what stops a second caller becoming an administrator — and it always makes an admin.
   * The Staff screen was calling it to appoint assistants and teachers, so every attempt
   * was refused with "This library already has an account. Sign in instead." and nobody
   * could ever be appointed. Not an edge case: the second librarian was impossible.
   *
   * So:
   *
   *   createUser   once, on an empty database, always an administrator
   *   appointUser  every time after that, role as asked, refused without `users.write`
   *
   * The role comes from `input.role`, exactly as it does for `createUser`, so the two
   * calls read alike and a call site is a rename rather than a rewrite.
   *
   * The caller stays signed in as themselves throughout, which matters because this is
   * run by an administrator on a shared desk.
   */
  appointUser(input: CreateUserInput): Promise<User>

  /**
   * Verifies a password and opens a session.
   *
   * Rejects with the same message for a bad email, a bad password and a
   * disabled account, so the form cannot be used to discover which addresses are
   * registered.
   */
  signIn(email: string, password: string): Promise<User>

  signOut(): Promise<void>

  /** The signed-in account, or null. */
  currentUser(): Promise<User | null>

  /** True once any account exists. Drives the first-run screen. */
  hasAccounts(): Promise<boolean>

  listUsers(): Promise<User[]>

  /**
   * Switches an account on or off.
   *
   * Off means refused everywhere, immediately, not at the next sign-in: the reason
   * for disabling somebody is usually happening right now.
   *
   * Cannot be used on your own account. An administrator who switches themselves off
   * has locked the school out of its own register with no way back in, and the
   * recovery is editing the database — so it is refused at the domain rather than
   * explained in the interface.
   */
  setUserStatus(id: string, status: UserStatus): Promise<User>

  /**
   * Changes an account's role.
   *
   * Also cannot be your own. An administrator demoting themselves leaves nobody able
   * to create the replacement.
   */
  setUserRole(id: string, role: Role): Promise<User>

  // ── Catalog ────────────────────────────────────────────────
  searchTitles(query: TitleQuery): Promise<Page<TitleSummary>>
  getTitle(id: string): Promise<TitleDetail>
  createTitle(input: TitleCreateInputLike): Promise<Title>
  updateTitle(id: string, patch: TitlePatchLike): Promise<Title>
  addCopies(input: AddCopiesInput): Promise<Copy[]>
  updateCopy(id: string, patch: UpdateCopyInput): Promise<Copy>
  /** Removes a copy from circulation. Requires a reason; recorded in the audit. */
  withdrawCopy(id: string, reason: string): Promise<Copy>
  listShelfLocations(): Promise<ShelfLocation[]>

  // ── Members ────────────────────────────────────────────────
  searchMembers(query: MemberQuery): Promise<Page<MemberSummary>>
  getMember(id: string): Promise<MemberDetail>
  createMember(input: Partial<Member> & { memberCode: string }): Promise<Member>
  updateMember(id: string, patch: UpdateMemberInput): Promise<Member>
  setMemberStatus(id: string, status: MemberStatus): Promise<Member>
  listMemberTypes(): Promise<MemberType[]>
  updateMemberType(key: string, patch: UpdateMemberTypeInput): Promise<MemberType>

  // ── Circulation ────────────────────────────────────────────
  /** The hot path. A discriminated union; never throws for a policy refusal. */
  checkout(input: CheckoutInput): Promise<CheckoutResult>
  renew(input: RenewInput): Promise<RenewResult>
  returnLoan(input: ReturnInput): Promise<ReturnResult>
  markLost(loanId: string, reason: string): Promise<ReturnResult>
  markDamaged(loanId: string, reason: string): Promise<ReturnResult>
  /**
   * Finds a member by the exact code on their card.
   *
   * Exact match only, never case-insensitive. Two codes differing only in case
   * are two students, and a register that issues a book to the wrong one is
   * worse than one that says "no such number".
   */
  findMemberByCode(memberCode: string): Promise<Member | null>
  findCopyByBarcode(barcode: string): Promise<Copy | null>
  listActiveLoans(memberId: string): Promise<Loan[]>

  /**
   * Voids a mistaken loan: the copy goes back on the shelf, the row stays
   * visible with its reason, and the borrower stops owing.
   *
   * Requires a written reason. A void with no reason is indistinguishable from a
   * deletion, which is the thing this exists to prevent.
   */
  /**
   * Voiding a loan.
   *
   * Was `Promise<Loan>`, which could not express a refusal at all. The database can
   * refuse this with `not_found`, `not_active` or `reason_required`, and with a
   * return type that has no room for a refusal the only way to report one was to
   * throw. Its three siblings in the same switch statement return a sentence, so the
   * desk was handling two different failure shapes for the same kind of mistake.
   */
  voidLoan(loanId: string, reason: string): Promise<VoidResult>

  /** The issue register, school-wide. */
  listLoans(query: LoanQuery): Promise<Page<LoanRow>>

  // ── Holds ──────────────────────────────────────────────────
  placeHold(input: PlaceHoldInput): Promise<Hold>
  cancelHold(id: string): Promise<Hold>
  /** Ordered by queue position. */
  getHoldQueue(titleId: string): Promise<Hold[]>
  listHoldsForMember(memberId: string): Promise<Hold[]>

  // ── Fines ──────────────────────────────────────────────────
  getFines(query?: FineQuery): Promise<Page<FineDetail>>
  getFineLedger(memberId: string): Promise<FineDetail[]>
  /**
   * Waiving a fine, and taking a payment.
   *
   * Both were `Promise<FineDetail>`, which cannot express a refusal. Each can refuse
   * for ordinary reasons a school will hit by accident — an amount of zero, more than
   * is outstanding, a fine already settled, a waiver with no reason — and all of those
   * were reaching the fines screen as thrown errors rather than as sentences.
   */
  waiveFine(input: WaiveFineInput): Promise<PaymentResult>
  recordPayment(input: RecordPaymentInput): Promise<PaymentResult>
  assessFine(input: AssessFineInput): Promise<FineDetail>
  /**
   * The nightly accrual, exposed as a callable.
   *
   * Fines are materialised here, never computed at render time — a balance
   * that changes while somebody is reading it is not an answer to anything.
   */
  runAccrual(now?: string): Promise<{ assessed: number; totalCents: number }>

  // ── Ops ────────────────────────────────────────────────────
  getDashboard(): Promise<DashboardSummary>
  runReport(id: string, params?: Record<string, string>): Promise<ReportResult>
  startImport(input: ImportStartInput): Promise<ImportJob>
  getImportJob(id: string): Promise<ImportJob>
  listImportRowErrors(jobId: string): Promise<ImportRowError[]>
  getSettings(): Promise<Setting[]>
  updateSetting(key: string, value: unknown): Promise<Setting>
  getAuditLog(query: AuditQuery): Promise<Page<AuditEntry>>
  listNotifications(): Promise<Notification[]>
}

// Local aliases, so this file does not have to re-export the input shapes.
type TitleCreateInputLike = {
  title: string
  author: string
  isbn?: string | null
  publisher?: string | null
  publishedYear?: number | null
  subject?: string | null
  callNumber?: string | null
  copyCount?: number
}
type TitlePatchLike = Partial<TitleCreateInputLike>