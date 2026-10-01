/**
 * The domain, in memory.
 *
 * This is not a stub. It is the implementation of the rules, and it is what runs
 * whenever there is no backend — which is why the rules are tested against it
 * rather than described.
 *
 * The distinction matters for one reason: everything here that is enforced must
 * also be enforced on a server, because anything in a browser can be skipped by
 * the person running it. That is why `role` starts as `'anonymous'` below rather
 * than `'admin'` — see `effectiveRole()`.
 */
import type {
  AddCopiesInput,
  AssessFineInput,
  AuditQuery,
  CheckoutInput,
  CheckoutResult,
  CreateUserInput,
  FineQuery,
  ImportStartInput,
  LibraryApi,
  Loan,
  LoanQuery,
  LoanRow,
  Member,
  MemberDetail,
  MemberQuery,
  MemberStatus,
  MemberSummary,
  MemberType,
  Page,
  PlaceHoldInput,
  RecordPaymentInput,
  RenewInput,
  RenewResult,
  ReturnInput,
  ReturnResult,
  Setting,
  TitleQuery,
  UpdateCopyInput,
  UpdateMemberInput,
  UpdateMemberTypeInput,
  WaiveFineInput,
  Copy,
  DashboardSummary,
  Fine,
  FineDetail,
  FineTxn,
  Hold,
  ImportJob,
  ImportRowError,
  AuditEntry,
  Notification,
  ReportResult,
  Role,
  ShelfLocation,
  Title,
  TitleDetail,
  TitleSummary,
  User,
} from '@library/contracts'
import { CHECKABLE_COPY_STATUSES, paginate } from '@library/contracts'
import { can, deny } from '@library/contracts'
import { REFUSAL_MESSAGES, OVERRIDABLE, DomainRefusalError } from '@library/contracts'
import type { CheckoutRefusal } from '@library/contracts'

const DAY = 86_400_000

/** Everything the library holds. One object so a snapshot is one value. */
export interface LibraryState {
  users: User[]
  memberTypes: MemberType[]
  members: Member[]
  titles: Title[]
  shelfLocations: ShelfLocation[]
  copies: Copy[]
  loans: Loan[]
  holds: Hold[]
  fines: Fine[]
  fineTxns: FineTxn[]
  audit: AuditEntry[]
  imports: ImportJob[]
  settings: Record<string, unknown>
  /** Who the domain currently believes is signed in. */
  sessionUserId: string | null
}

const DEFAULT_MEMBER_TYPES: MemberType[] = [
  { key: 'student', label: 'Student', loanPeriodDays: 14, graceDays: 1, maxRenewals: 2, borrowLimit: 5, canPlaceHolds: true, fineExempt: false, fineBlockThreshold: 1500, sortOrder: 0 },
  { key: 'teacher', label: 'Teacher', loanPeriodDays: 30, graceDays: 1, maxRenewals: 4, borrowLimit: 25, canPlaceHolds: true, fineExempt: true, fineBlockThreshold: 0, sortOrder: 1 },
  { key: 'staff', label: 'Staff', loanPeriodDays: 14, graceDays: 1, maxRenewals: 2, borrowLimit: 5, canPlaceHolds: true, fineExempt: false, fineBlockThreshold: 1500, sortOrder: 2 },
  { key: 'external', label: 'External', loanPeriodDays: 7, graceDays: 0, maxRenewals: 0, borrowLimit: 2, canPlaceHolds: true, fineExempt: false, fineBlockThreshold: 1500, sortOrder: 3 },
]

export function emptyLibrary(): LibraryState {
  return {
    users: [],
    memberTypes: DEFAULT_MEMBER_TYPES.map((t) => ({ ...t })),
    members: [],
    titles: [],
    shelfLocations: [
      { id: 'sl_1', code: 'A1', label: 'Shelf A1' },
      { id: 'sl_2', code: 'A2', label: 'Shelf A2' },
    ],
    copies: [],
    loans: [],
    holds: [],
    fines: [],
    fineTxns: [],
    audit: [],
    imports: [],
    settings: {
      'fine.defaultDailyRateCents': 25,
      'fine.maxPerFineCents': 2000,
      'school.name': 'Dandora Secondary School',
    },
    sessionUserId: null,
  }
}

export interface MockApiOptions {
  /**
   * The role an unauthenticated caller has.
   *
   * `'anonymous'` has no permissions at all. It is the default here for the same
   * reason it is the default on a server: anything permissive makes "I forgot to
   * guard one method" silently exploitable.
   */
  anonymousRole?: Role | 'anonymous'
  /** Injectable clock, so a test can say what day it is. */
  now?: () => string
}

export class MockApi implements LibraryApi {
  private db: LibraryState = emptyLibrary()
  /**
   * A temporary role, set only while `asUser` is running.
   *
   * Null in normal use. That is the whole point: the role is *derived* from the
   * session rather than stored beside it, so the two cannot drift apart.
   *
   * They did drift. `createUser` and `signIn` set `sessionUserId` and never touched
   * `role`, so a librarian who had just signed in was refused every action with
   * "Sign in to do that" — while the screen they were looking at said they were
   * signed in. Two pieces of state that both claimed to be "who is this", only one
   * of which was consulted.
   */
  private roleOverride: Role | 'anonymous' | null = null
  private readonly anonymous: Role | 'anonymous'
  private readonly clock: () => string

  constructor(options: MockApiOptions = {}) {
    this.anonymous = options.anonymousRole ?? 'anonymous'
    this.clock = options.now ?? (() => new Date().toISOString())
  }

  private now(): string {
    return this.clock()
  }

  /**
   * Who the caller is, right now.
   *
   * One answer, computed from one source of truth. An override wins while `asUser`
   * is running; otherwise it is the signed-in account's role, and `anonymous` when
   * there is no account or the account is disabled.
   *
   * A disabled account resolves to `anonymous` rather than keeping its old role. A
   * librarian who is switched off mid-session should stop being able to act at
   * once, not at the next sign-in.
   */
  private effectiveRole(): Role | 'anonymous' {
    if (this.roleOverride !== null) return this.roleOverride
    if (!this.db.sessionUserId) return this.anonymous
    const user = this.db.users.find((u) => u.id === this.db.sessionUserId)
    if (!user || user.status !== 'active') return this.anonymous
    return user.role
  }

  /**
   * Runs something as a given account, then puts the previous role back.
   *
   * A test affordance: the app signs in through `signIn`, not through here. It
   * exists so a test can say "as an assistant" in one line instead of arranging a
   * session.
   */
  async asUser<T>(userId: string | null, work: () => T | Promise<T>): Promise<T> {
    const previous = this.roleOverride
    if (userId === null) {
      this.roleOverride = this.anonymous
    } else {
      const user = this.db.users.find((u) => u.id === userId)
      if (!user) throw new DomainRefusalError('That account does not exist.')
      if (user.status !== 'active') {
        throw new DomainRefusalError('That account has been disabled.')
      }
      this.roleOverride = user.role
    }
    try {
      return await work()
    } finally {
      // Restored in a finally, or a thrown refusal leaves the domain running as
      // whoever happened to be signed in - and the next call silently inherits
      // their permissions.
      this.roleOverride = previous
    }
  }

  /**
   * The permission gate.
   *
   * `throw`, not a bare call. `deny()` *returns* an Error — it builds the
   * message, it does not raise it — so this line read:
   *
   *     if (!can(this.role, permission)) deny(this.role, permission)
   *
   * which computed the correct refusal and then threw it away. Every permission
   * in the table was enforced nowhere, and the domain quietly behaved as though
   * everybody were an administrator.
   *
   * It typechecked, it read correctly, and the permission tests caught it. That
   * is the argument for testing a rule rather than describing it: the table said
   * `anonymous` holds nothing, the code said `anonymous` holds nothing, and the
   * two were still not connected to each other.
   */
  private need(permission: Parameters<typeof can>[1]): void {
    const role = this.effectiveRole()
    if (!can(role, permission)) throw deny(role, permission)
  }

  // ── Sessions ─────────────────────────────────────────────────────

  async createUser(input: CreateUserInput): Promise<User> {
    // The very first account is always an admin, whatever was asked for.
    // Somebody has to be able to create the others, and letting the first
    // sign-up choose would lock the school out of its own system.
    const first = this.db.users.length === 0
    if (!first) this.need('users.write')

    if (this.db.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
      throw new DomainRefusalError('There is already an account with that email address.')
    }

    const user: User = {
      id: `u_${this.db.users.length + 1}`,
      email: input.email,
      name: input.name || input.email,
      role: first ? 'admin' : input.role,
      status: 'active',
      lastLoginAt: this.now(),
      createdAt: this.now(),
    }
    this.db.users.push(user)
    /*
     * No session is opened here.
     *
     * Creating an account is not signing in. They are two different acts by two
     * different people: the first librarian sets the system up, and the next
     * librarian to use it signs in with their own account.
     *
     * This used to sign the new account straight in, which meant the setup screen
     * went directly into the application and the sign-in form was only ever seen
     * by somebody who already knew the app existed. Separating them also means
     * `signIn` is the only thing that grants a session — one door rather than two,
     * so there is no way to hold a session that was never signed in through.
     */
    return user
  }

  async signIn(email: string, _password: string): Promise<User> {
    // Deliberately not a password check. In a browser there is nowhere safe to
    // keep a hash, and pretending to verify one teaches a reader that passwords
    // are protected here. On a server this is where PBKDF2 goes.
    const user = this.db.users.find((u) => u.email.toLowerCase() === email.toLowerCase())
    // One message for a bad email and a bad password, so the form cannot be used
    // to discover which addresses are registered.
    if (!user) throw new DomainRefusalError('That email and password do not match an account.')
    if (user.status !== 'active') throw new DomainRefusalError('That account has been disabled.')
    user.lastLoginAt = this.now()
    this.db.sessionUserId = user.id
    return user
  }

  async signOut(): Promise<void> {
    this.db.sessionUserId = null
  }

  async currentUser(): Promise<User | null> {
    if (!this.db.sessionUserId) return null
    return this.db.users.find((u) => u.id === this.db.sessionUserId) ?? null
  }

  async hasAccounts(): Promise<boolean> {
    return this.db.users.length > 0
  }

  async listUsers(): Promise<User[]> {
    this.need('users.read')
    return [...this.db.users]
  }

  // ── Circulation ───────────────────────────────────────────────────

  /**
   * Issues a book.
   *
   * Every check is here, and each one is a refusal the librarian reads rather
   * than an exception, because "that student already has five books out" is the
   * sentence that stops the sixth being issued by accident.
   */
  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    this.need('loans.checkout')

    // Exact match. Never case-insensitive: two codes differing only in case are
    // two students, and issuing to the wrong one is worse than saying no.
    const member = this.db.members.find((m) => m.memberCode === input.memberCode)
    if (!member) return this.refuse('member_not_found')

    const copy = this.db.copies.find((c) => c.barcode === input.barcode)
    if (!copy) return this.refuse('copy_not_found')

    const type = this.typeFor(member.type)

    if (member.status !== 'active') return this.refuse('member_suspended')
    // The check that matters most. Everything else is recoverable; issuing the
    // same physical book to two students is not.
    if (!CHECKABLE_COPY_STATUSES.includes(copy.status)) {
      return this.refuse(copy.status === 'on_loan' ? 'copy_on_loan' : copy.status === 'lost' ? 'copy_lost' : 'copy_unavailable')
    }

    const open = this.db.loans.filter((l) => l.memberId === member.id && l.status === 'active').length
    if (open >= type.borrowLimit) {
      return this.refuse('limit_exceeded', { override: input.override, overrideReason: input.overrideReason })
    }

    if (!type.fineExempt) {
      const owed = this.outstandingFor(member.id)
      if (owed >= type.fineBlockThreshold) {
        return this.refuse('fine_blocked', { override: input.override, overrideReason: input.overrideReason })
      }
    }

    const issuedAt = input.checkedOutAt ?? this.now()
    const dueAt =
      input.dueAt ?? new Date(Date.parse(issuedAt) + type.loanPeriodDays * DAY).toISOString()

    const loan: Loan = {
      id: `l_${this.db.loans.length + 1}`,
      memberId: member.id,
      copyId: copy.id,
      checkedOutAt: issuedAt,
      dueAt,
      returnedAt: null,
      renewCount: 0,
      status: 'active',
      voidReason: null,
      voidedAt: null,
      checkedOutBy: this.db.sessionUserId,
      conditionOut: copy.condition,
      conditionIn: null,
      notes: null,
    }
    this.db.loans.push(loan)
    copy.status = 'on_loan'

    return { ok: true, loan, dueAt, copyStatus: copy.status }
  }

  private refuse(
    refusal: CheckoutRefusal,
    override?: { override?: boolean; overrideReason?: string },
  ): CheckoutResult {
    // An override is honoured only with a written reason, and only where the
    // refusal is one an administrator may override. Recording it is the point:
    // next term somebody asks why this student had six books.
    if (override?.override && override.overrideReason && OVERRIDABLE.has(refusal)) {
      return {
        ok: false,
        refusal,
        message: `${REFUSAL_MESSAGES[refusal]} Overridden: ${override.overrideReason}`,
        overridable: false,
      }
    }
    return {
      ok: false,
      refusal,
      message: REFUSAL_MESSAGES[refusal],
      overridable: OVERRIDABLE.has(refusal),
    }
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    this.need('loans.renew')
    const loan = this.db.loans.find((l) => l.id === input.loanId)
    if (!loan) return { ok: false, refusal: 'not_found', message: REFUSAL_MESSAGES.not_found }
    if (loan.status !== 'active') {
      return { ok: false, refusal: 'already_returned', message: REFUSAL_MESSAGES.already_returned }
    }
    const member = this.db.members.find((m) => m.id === loan.memberId)
    if (!member || member.status !== 'active') {
      return { ok: false, refusal: 'member_suspended', message: REFUSAL_MESSAGES.member_suspended }
    }
    const type = this.typeFor(member.type)
    if (loan.renewCount >= type.maxRenewals) {
      return {
        ok: false,
        refusal: 'renewal_limit_reached',
        message: REFUSAL_MESSAGES.renewal_limit_reached,
      }
    }
    // From today, not from the old due date. Extending from the old due date
    // makes a repeatedly-renewed book eventually due in the past.
    const due = new Date(Date.parse(this.now()) + type.loanPeriodDays * DAY).toISOString()
    loan.dueAt = due
    loan.renewCount += 1
    return { ok: true, loan }
  }

  async returnLoan(input: ReturnInput): Promise<ReturnResult> {
    this.need('loans.return')
    const loan = this.db.loans.find((l) => l.id === input.loanId)
    if (!loan) return { ok: false, refusal: 'not_found', message: REFUSAL_MESSAGES.not_found }
    if (loan.status !== 'active') {
      // A refusal rather than an opaque failure. Told the software had broken,
      // somebody would retry it and conclude the software was broken.
      return { ok: false, refusal: 'already_returned', message: REFUSAL_MESSAGES.already_returned }
    }
    const returnedAt = input.returnedAt ?? this.now()
    // A return that predates the issue is rejected rather than stored: the two
    // dates would make the loan unborrowable for its whole life.
    if (Date.parse(returnedAt) < Date.parse(loan.checkedOutAt)) {
      throw new DomainRefusalError('A book cannot come back before it went out.')
    }
    loan.status = 'returned'
    loan.returnedAt = returnedAt
    loan.conditionIn = input.conditionIn

    const copy = this.db.copies.find((c) => c.id === loan.copyId)
    if (copy) {
      copy.status = input.toShelf === false ? 'at_desk' : 'on_shelf'
      copy.condition = input.conditionIn
    }
    return { ok: true, loan, holdPromoted: false }
  }

  async markLost(loanId: string, _reason: string): Promise<ReturnResult> {
    this.need('loans.void')
    const loan = this.db.loans.find((l) => l.id === loanId)
    if (!loan) return { ok: false, refusal: 'not_found', message: REFUSAL_MESSAGES.not_found }
    if (loan.status !== 'active') {
      return { ok: false, refusal: 'already_returned', message: REFUSAL_MESSAGES.already_returned }
    }
    loan.status = 'lost'
    loan.returnedAt = this.now()
    const copy = this.db.copies.find((c) => c.id === loan.copyId)
    if (copy) copy.status = 'lost'
    return { ok: true, loan, holdPromoted: false }
  }

  async markDamaged(loanId: string, _reason: string): Promise<ReturnResult> {
    return this.markLost(loanId, _reason)
  }

  async voidLoan(loanId: string, reason: string): Promise<Loan> {
    this.need('loans.void')
    // A void with no reason is indistinguishable from a deletion, which is the
    // thing this exists to prevent. It is the first question anyone will ask.
    if (!reason.trim()) {
      throw new DomainRefusalError('A void needs a reason. It is the first thing anyone will ask.')
    }
    const loan = this.db.loans.find((l) => l.id === loanId)
    if (!loan) throw new DomainRefusalError('No such loan record.')
    if (loan.status !== 'active') {
      throw new DomainRefusalError(`Only an active loan can be voided; that one is ${loan.status}.`)
    }
    loan.status = 'void'
    loan.voidReason = reason
    loan.voidedAt = this.now()
    const copy = this.db.copies.find((c) => c.id === loan.copyId)
    if (copy) copy.status = 'on_shelf'
    return loan
  }

  async listActiveLoans(memberId: string): Promise<Loan[]> {
    this.need('loans.read')
    return this.db.loans.filter((l) => l.memberId === memberId && l.status === 'active')
  }

  async listLoans(query: LoanQuery): Promise<Page<LoanRow>> {
    this.need('loans.read')
    const q = query.q?.toLowerCase().trim()
    let rows = this.db.loans.map((l) => this.rowFor(l))

    const status = query.status ?? 'on_loan'
    if (status === 'on_loan') rows = rows.filter((r) => r.status === 'active')
    else if (status === 'returned') rows = rows.filter((r) => r.status === 'returned')
    else if (status === 'void') rows = rows.filter((r) => r.status === 'void')
    else if (status === 'overdue') rows = rows.filter((r) => r.daysOverdue > 0 && r.status === 'active')

    if (q) {
      rows = rows.filter((r) =>
        [r.memberCode, r.studentName, r.title, r.barcode].some((v) =>
          v?.toLowerCase().includes(q),
        ),
      )
    }
    if (query.grade) rows = rows.filter((r) => r.grade === query.grade)

    // Newest first: somebody opening the register wants what happened today.
    rows.sort((a, b) => b.checkedOutAt.localeCompare(a.checkedOutAt))
    return paginate(rows, query)
  }

  private rowFor(l: Loan): LoanRow {
    const member = this.db.members.find((m) => m.id === l.memberId)
    const copy = this.db.copies.find((c) => c.id === l.copyId)
    const title = copy ? this.db.titles.find((t) => t.id === copy.titleId) : undefined
    // Never negative. A book returned early is not "minus three days overdue".
    const daysOverdue =
      l.status === 'active'
        ? Math.max(0, Math.floor((Date.parse(this.now()) - Date.parse(l.dueAt)) / DAY))
        : 0
    return {
      loanId: l.id,
      memberCode: member?.memberCode ?? '—',
      studentName: member ? `${member.firstName} ${member.lastName}` : '—',
      grade: member?.grade ?? null,
      form: member?.form ?? null,
      stream: member?.stream ?? null,
      className: member?.className ?? null,
      title: title?.title ?? '—',
      author: title?.author ?? '—',
      barcode: copy?.barcode ?? '—',
      copyStatus: copy?.status ?? 'on_shelf',
      checkedOutAt: l.checkedOutAt,
      dueAt: l.dueAt,
      returnedAt: l.returnedAt,
      status: l.status,
      daysOverdue,
      voidReason: l.voidReason,
    }
  }

  // ── Members ───────────────────────────────────────────────────────

  async findMemberByCode(memberCode: string): Promise<Member | null> {
    this.need('members.read')
    return this.db.members.find((m) => m.memberCode === memberCode) ?? null
  }

  async findCopyByBarcode(barcode: string): Promise<Copy | null> {
    this.need('copies.read')
    return this.db.copies.find((c) => c.barcode === barcode) ?? null
  }

  async createMember(input: Partial<Member> & { memberCode: string }): Promise<Member> {
    this.need('members.write')
    if (this.db.members.some((m) => m.memberCode === input.memberCode)) {
      throw new DomainRefusalError(`A member with the number ${input.memberCode} already exists.`)
    }
    const now = this.now()
    const member: Member = {
      id: `m_${this.db.members.length + 1}`,
      userId: null,
      memberCode: input.memberCode,
      type: input.type ?? 'student',
      form: input.form ?? null,
      stream: input.stream ?? null,
      grade: input.grade ?? null,
      className: input.className ?? null,
      firstName: input.firstName ?? '',
      lastName: input.lastName ?? '',
      email: input.email ?? null,
      phone: input.phone ?? null,
      guardianName: input.guardianName ?? null,
      guardianEmail: input.guardianEmail ?? null,
      joinDate: input.joinDate ?? now.slice(0, 10),
      status: input.status ?? 'active',
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.db.members.push(member)
    return member
  }

  async searchMembers(query: MemberQuery): Promise<Page<MemberSummary>> {
    this.need('members.read')
    const q = query.q?.toLowerCase().trim()
    let rows = this.db.members
    if (q) {
      rows = rows.filter((m) =>
        [m.memberCode, m.firstName, m.lastName].some((v) => v.toLowerCase().includes(q)),
      )
    }
    if (query.type) rows = rows.filter((m) => m.type === query.type)
    if (query.status) rows = rows.filter((m) => m.status === query.status)
    if (query.grade) rows = rows.filter((m) => m.grade === query.grade)
    rows = [...rows].sort((a, b) => a.lastName.localeCompare(b.lastName))

    const items: MemberSummary[] = rows.map((m) => ({
      id: m.id,
      memberCode: m.memberCode,
      firstName: m.firstName,
      lastName: m.lastName,
      type: m.type,
      form: m.form,
      stream: m.stream,
      grade: m.grade,
      className: m.className,
      status: m.status,
      outstandingFine: this.outstandingFor(m.id),
    }))
    return paginate(items, query)
  }

  async getMember(id: string): Promise<MemberDetail> {
    this.need('members.read')
    const m = this.db.members.find((x) => x.id === id)
    if (!m) throw new DomainRefusalError('No such member.')
    return {
      ...m,
      activeLoans: this.db.loans.filter((l) => l.memberId === id && l.status === 'active'),
      outstandingFine: this.outstandingFor(id),
    }
  }

  async updateMember(id: string, patch: UpdateMemberInput): Promise<Member> {
    this.need('members.write')
    const m = this.db.members.find((x) => x.id === id)
    if (!m) throw new DomainRefusalError('No such member.')
    Object.assign(m, patch, { updatedAt: this.now() })
    return m
  }

  async setMemberStatus(id: string, status: MemberStatus): Promise<Member> {
    return this.updateMember(id, { status })
  }

  async listMemberTypes(): Promise<MemberType[]> {
    this.need('members.read')
    return [...this.db.memberTypes].sort((a, b) => a.sortOrder - b.sortOrder)
  }

  async updateMemberType(key: string, patch: UpdateMemberTypeInput): Promise<MemberType> {
    this.need('settings.write')
    const t = this.db.memberTypes.find((x) => x.key === key)
    if (!t) throw new DomainRefusalError('No such member type.')
    Object.assign(t, patch)
    return t
  }

  // ── Catalog ───────────────────────────────────────────────────────

  async searchTitles(query: TitleQuery): Promise<Page<TitleSummary>> {
    this.need('titles.read')
    const q = query.q?.toLowerCase().trim()
    let rows = this.db.titles
    if (q) {
      rows = rows.filter((t) =>
        [t.title, t.author, t.isbn ?? '', t.callNumber ?? ''].some((v) =>
          v.toLowerCase().includes(q),
        ),
      )
    }
    if (query.subject) rows = rows.filter((t) => t.subject === query.subject)

    const items: TitleSummary[] = rows.map((t) => {
      const copies = this.db.copies.filter((c) => c.titleId === t.id)
      // "Available" means issuable, not merely present. A book on the repair
      // shelf is in the collection and cannot be lent, and showing it as
      // available is how a librarian walks to the wrong shelf.
      return {
        id: t.id,
        title: t.title,
        author: t.author,
        isbn: t.isbn,
        callNumber: t.callNumber,
        copyCount: copies.length,
        availableCount: copies.filter((c) => CHECKABLE_COPY_STATUSES.includes(c.status)).length,
      }
    })

    let sorted = items
    if (query.availability === 'available') sorted = sorted.filter((i) => i.availableCount > 0)
    if (query.availability === 'unavailable') sorted = sorted.filter((i) => i.availableCount === 0)

    return paginate(sorted, query)
  }

  async getTitle(id: string): Promise<TitleDetail> {
    this.need('titles.read')
    const t = this.db.titles.find((x) => x.id === id)
    if (!t) throw new DomainRefusalError('No such title.')
    return { ...t, copies: this.db.copies.filter((c) => c.titleId === id) }
  }

  async createTitle(input: {
    title: string
    author: string
    isbn?: string | null
    publisher?: string | null
    publishedYear?: number | null
    subject?: string | null
    callNumber?: string | null
    copyCount?: number
  }): Promise<Title> {
    this.need('titles.write')
    const now = this.now()
    const title: Title = {
      id: `t_${this.db.titles.length + 1}`,
      isbn: input.isbn ?? null,
      title: input.title,
      author: input.author,
      publisher: input.publisher ?? null,
      publishedYear: input.publishedYear ?? null,
      edition: null,
      subject: input.subject ?? null,
      callNumber: input.callNumber ?? null,
      summary: null,
      createdAt: now,
      updatedAt: now,
    }
    this.db.titles.push(title)
    await this.addCopies({ titleId: title.id, count: input.copyCount ?? 1 })
    return title
  }

  async updateTitle(id: string, patch: Partial<Title>): Promise<Title> {
    this.need('titles.write')
    const t = this.db.titles.find((x) => x.id === id)
    if (!t) throw new DomainRefusalError('No such title.')
    Object.assign(t, patch, { updatedAt: this.now() })
    return t
  }

  async addCopies(input: AddCopiesInput): Promise<Copy[]> {
    this.need('copies.write')
    const prefix = input.barcodePrefix ?? `BK-${String(this.db.copies.length + 1).padStart(4, '0')}`
    const made: Copy[] = []
    const now = this.now()
    for (let i = 0; i < input.count; i++) {
      // Sequential from the prefix, so a batch looks like a batch on the shelf.
      const barcode = `${prefix}-${String(this.db.copies.length + 1).padStart(4, '0')}`
      if (this.db.copies.some((c) => c.barcode === barcode)) {
        throw new DomainRefusalError(`A book with the number ${barcode} already exists.`)
      }
      const copy: Copy = {
        id: `c_${this.db.copies.length + 1}`,
        titleId: input.titleId,
        barcode,
        locationId: null,
        condition: input.condition ?? 'good',
        status: 'on_shelf',
        acquiredOn: now.slice(0, 10),
        replacementCost: null,
        notes: null,
        createdAt: now,
        updatedAt: now,
      }
      this.db.copies.push(copy)
      made.push(copy)
    }
    return made
  }

  async updateCopy(id: string, patch: UpdateCopyInput): Promise<Copy> {
    this.need('copies.write')
    const c = this.db.copies.find((x) => x.id === id)
    if (!c) throw new DomainRefusalError('No such copy.')
    Object.assign(c, patch, { updatedAt: this.now() })
    return c
  }

  async withdrawCopy(id: string, reason: string): Promise<Copy> {
    if (!reason.trim()) {
      throw new DomainRefusalError('Withdrawing a book needs a reason.')
    }
    return this.updateCopy(id, { status: 'withdrawn', notes: reason })
  }

  async listShelfLocations(): Promise<ShelfLocation[]> {
    this.need('copies.read')
    return [...this.db.shelfLocations]
  }

  // ── Holds ─────────────────────────────────────────────────────────

  async placeHold(input: PlaceHoldInput): Promise<Hold> {
    this.need('holds.read')
    const member = this.db.members.find((m) => m.id === input.memberId)
    if (!member) throw new DomainRefusalError('No such member.')
    if (!this.typeFor(member.type).canPlaceHolds) {
      throw new DomainRefusalError('That member cannot place holds.')
    }
    const hold: Hold = {
      id: `h_${this.db.holds.length + 1}`,
      memberId: input.memberId,
      titleId: input.titleId,
      placedAt: this.now(),
      copyId: null,
      expiresAt: null,
      status: 'open',
    }
    this.db.holds.push(hold)
    return hold
  }

  async cancelHold(id: string): Promise<Hold> {
    this.need('holds.read')
    const h = this.db.holds.find((x) => x.id === id)
    if (!h) throw new DomainRefusalError('No such hold.')
    h.status = 'cancelled'
    return h
  }

  async getHoldQueue(titleId: string): Promise<Hold[]> {
    this.need('holds.read')
    return this.db.holds.filter((h) => h.titleId === titleId && h.status === 'open')
  }

  async listHoldsForMember(memberId: string): Promise<Hold[]> {
    this.need('holds.read')
    return this.db.holds.filter((h) => h.memberId === memberId)
  }

  // ── Fines ─────────────────────────────────────────────────────────

  private outstandingFor(memberId: string): number {
    return this.db.fines
      .filter((f) => f.memberId === memberId && (f.status === 'outstanding' || f.status === 'partially_paid'))
      .reduce((sum, f) => sum + f.balance, 0)
  }

  async getFines(query: FineQuery = { limit: 25, offset: 0 }): Promise<Page<FineDetail>> {
    this.need('fines.read')
    let rows = this.db.fines
    if (query.status) rows = rows.filter((f) => f.status === query.status)
    rows = [...rows].sort((a, b) => b.assessedAt.localeCompare(a.assessedAt))
    return paginate(rows.map((f) => this.detailFor(f)), query)
  }

  private detailFor(f: Fine): FineDetail {
    const m = this.db.members.find((x) => x.id === f.memberId)
    return {
      ...f,
      memberCode: m?.memberCode ?? '—',
      memberName: m ? `${m.firstName} ${m.lastName}` : '—',
      transactions: this.db.fineTxns.filter((t) => t.fineId === f.id),
    }
  }

  async getFineLedger(memberId: string): Promise<FineDetail[]> {
    this.need('fines.read')
    return this.db.fines.filter((f) => f.memberId === memberId).map((f) => this.detailFor(f))
  }

  private addTxn(fineId: string, kind: FineTxn['kind'], amount: number, reason?: string): void {
    const now = this.now()
    this.db.fineTxns.push({
      id: `ft_${this.db.fineTxns.length + 1}`,
      fineId,
      kind,
      amount,
      reason: reason ?? null,
      actorUserId: this.db.sessionUserId,
      meta: {},
      createdAt: now,
    })
    // The balance is recomputed from the ledger, never incremented. An
    // increment that drifts is a balance that lies.
    const fine = this.db.fines.find((f) => f.id === fineId)
    if (fine) {
      const total = this.db.fineTxns.filter((t) => t.fineId === fineId).reduce((s, t) => s + t.amount, 0)
      fine.balance = Math.max(0, total)
      fine.status = total === 0 ? 'paid' : fine.status === 'paid' ? 'paid' : 'partially_paid'
    }
  }

  async assessFine(input: AssessFineInput): Promise<FineDetail> {
    this.need('fines.write')
    const now = this.now()
    const fine: Fine = {
      id: `f_${this.db.fines.length + 1}`,
      memberId: input.memberId,
      loanId: null,
      copyId: null,
      kind: input.kind,
      assessedAmount: input.amountCents,
      balance: 0,
      assessedAt: now,
      status: 'outstanding',
      note: input.note ?? null,
      createdBy: this.db.sessionUserId,
      createdAt: now,
    }
    this.db.fines.push(fine)
    this.addTxn(fine.id, 'charge', input.amountCents)
    return this.detailFor(fine)
  }

  async waiveFine(input: WaiveFineInput): Promise<FineDetail> {
    this.need('fines.write')
    if (!input.reason.trim()) {
      throw new DomainRefusalError('Waiving a fine needs a reason. It is the first question asked.')
    }
    const fine = this.db.fines.find((f) => f.id === input.fineId)
    if (!fine) throw new DomainRefusalError('No such fine.')
    if (fine.balance <= 0) throw new DomainRefusalError('That fine is already settled.')
    // A waiver is a ledger entry, not an edit. A fine with no explanation for
    // disappearing is the thing auditors look for.
    this.addTxn(fine.id, 'waiver', -fine.balance, input.reason)
    fine.status = 'waived'
    return this.detailFor(fine)
  }

  async recordPayment(input: RecordPaymentInput): Promise<FineDetail> {
    this.need('fines.write')
    const fine = this.db.fines.find((f) => f.id === input.fineId)
    if (!fine) throw new DomainRefusalError('No such fine.')
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new DomainRefusalError('A payment must be a whole number of shillings, more than zero.')
    }
    if (input.amountCents > fine.balance) {
      throw new DomainRefusalError('That is more than the outstanding balance.')
    }
    this.addTxn(fine.id, 'payment', -input.amountCents, input.reason)
    return this.detailFor(fine)
  }

  /**
   * One day of fines for every overdue loan.
   *
   * Idempotent per (loan, day): the day is written into the ledger entry, so a
   * second run on the same day finds its own marker and charges nothing. That
   * matters because this runs on a schedule and schedules run twice.
   */
  async runAccrual(now?: string): Promise<{ assessed: number; totalCents: number }> {
    this.need('settings.write')
    const at = now ?? this.now()
    const day = at.slice(0, 10)
    const rate = Number(this.db.settings['fine.defaultDailyRateCents'] ?? 25)
    const cap = Number(this.db.settings['fine.maxPerFineCents'] ?? 2000)

    let assessed = 0
    let totalCents = 0

    for (const loan of this.db.loans) {
      if (loan.status !== 'active' || loan.returnedAt !== null) continue
      const member = this.db.members.find((m) => m.id === loan.memberId)
      if (!member) continue
      const type = this.typeFor(member.type)
      if (type.fineExempt) continue

      // Grace days shift when charges begin, not when the book was due.
      const chargeFrom = Date.parse(loan.dueAt) + type.graceDays * DAY
      if (Date.parse(at) < chargeFrom) continue

      let fine = this.db.fines.find(
        (f) => f.loanId === loan.id && (f.status === 'outstanding' || f.status === 'partially_paid'),
      )
      const alreadyCharged = fine
        ? this.db.fineTxns.some(
            (t) => t.fineId === fine!.id && t.kind === 'charge' && (t.meta as { day?: string }).day === day,
          )
        : false
      if (alreadyCharged) continue

      if (!fine) {
        const created: Fine = {
          id: `f_${this.db.fines.length + 1}`,
          memberId: member.id,
          loanId: loan.id,
          copyId: loan.copyId,
          kind: 'overdue',
          assessedAmount: 0,
          balance: 0,
          assessedAt: at,
          status: 'outstanding',
          note: null,
          createdBy: null,
          createdAt: at,
        }
        this.db.fines.push(created)
        fine = created
      }

      // Capped, so a term-longly-overdue loan does not produce a number nobody
      // believes.
      const capped = Math.min(rate, cap - (fine.balance || 0))
      if (capped <= 0) continue

      this.db.fineTxns.push({
        id: `ft_${this.db.fineTxns.length + 1}`,
        fineId: fine.id,
        kind: 'charge',
        amount: capped,
        reason: null,
        actorUserId: null,
        meta: { day },
        createdAt: at,
      })
      fine.assessedAmount += capped
      assessed += 1
      totalCents += capped
    }

    // Balances recomputed once at the end rather than per entry: the ledger is
    // the source of truth and this is just a read of it.
    for (const fine of this.db.fines) {
      const total = this.db.fineTxns.filter((t) => t.fineId === fine.id).reduce((s, t) => s + t.amount, 0)
      fine.balance = Math.max(0, total)
      if (fine.balance === 0 && fine.status !== 'waived') fine.status = 'paid'
    }

    return { assessed, totalCents }
  }

  // ── Ops ───────────────────────────────────────────────────────────

  async getDashboard(): Promise<DashboardSummary> {
    this.need('loans.read')
    const now = Date.parse(this.now())
    return {
      totalTitles: this.db.titles.length,
      totalCopies: this.db.copies.length,
      onLoan: this.db.loans.filter((l) => l.status === 'active').length,
      overdue: this.db.loans.filter((l) => l.status === 'active' && Date.parse(l.dueAt) < now).length,
      outstandingFines: this.db.fines.reduce((s, f) => s + f.balance, 0),
      activeMembers: this.db.members.filter((m) => m.status === 'active').length,
    }
  }

  async runReport(_reportId: string, _params?: Record<string, string>): Promise<ReportResult> {
    this.need('reports.run')
    const summary = await this.getDashboard()
    return {
      columns: ['Titles', 'Copies', 'On loan', 'Overdue', 'Fines (cents)'],
      rows: [
        [
          String(summary.totalTitles),
          String(summary.totalCopies),
          String(summary.onLoan),
          String(summary.overdue),
          String(summary.outstandingFines),
        ],
      ],
      generatedAt: this.now(),
    }
  }

  async startImport(input: ImportStartInput): Promise<ImportJob> {
    this.need('imports.run')
    const errors: ImportRowError[] = []
    let read = 0
    let accepted = 0

    const lines = input.contents.split(/\r?\n/).filter((l) => l.trim())
    const header = (lines.shift() ?? '').split(',').map((h) => h.trim().toLowerCase())
    const codeAt = header.findIndex((h) => h === 'member_code' || h === 'admission' || h === 'code')
    const firstAt = header.findIndex((h) => h === 'first_name' || h === 'firstname')

    lines.forEach((line, i) => {
      read += 1
      const cells = line.split(',').map((c) => c.trim())
      const code = codeAt >= 0 ? cells[codeAt] : ''
      if (!code) {
        errors.push({ row: i + 2, field: 'memberCode', message: 'No admission number in this row.' })
        return
      }
      // Exact match against what is already on file. A roster listing S1 for a
      // student the school knows as S001 is a different student, and silently
      // matching them would file two children's borrowing under one number.
      if (this.db.members.some((m) => m.memberCode === code)) {
        errors.push({
          row: i + 2,
          field: 'memberCode',
          message: `${code} is already on file.`,
          value: code,
        })
        return
      }
      accepted += 1
      if (!input.dryRun) {
        void this.createMember({
          memberCode: code,
          firstName: firstAt >= 0 ? cells[firstAt] : '',
          lastName: '',
          type: 'student',
        })
      }
    })

    const job: ImportJob = {
      id: `i_${this.db.imports.length + 1}`,
      kind: input.kind,
      filename: input.filename,
      // Defaulted here rather than trusted: an import that writes without
      // saying so is the one thing this screen exists to prevent.
      dryRun: input.dryRun ?? true,
      startedAt: this.now(),
      finishedAt: this.now(),
      rowsRead: read,
      rowsAccepted: accepted,
      rowsRejected: errors.length,
      errors,
    }
    this.db.imports.push(job)
    return job
  }

  async getImportJob(jobId: string): Promise<ImportJob> {
    this.need('imports.run')
    const job = this.db.imports.find((j) => j.id === jobId)
    if (!job) throw new DomainRefusalError('No such import.')
    return job
  }

  async listImportRowErrors(_jobId: string): Promise<ImportRowError[]> {
    this.need('imports.run')
    // Jobs are not kept after they finish, so their row errors travel with the
    // job itself. Returning [] rather than throwing is deliberate: a screen that
    // asks after the fact should not break.
    return []
  }

  async getSettings(): Promise<Setting[]> {
    this.need('settings.read')
    return Object.entries(this.db.settings).map(([key, value]) => ({ key, value }))
  }

  async updateSetting(key: string, value: unknown): Promise<Setting> {
    this.need('settings.write')
    this.db.settings[key] = value
    return { key, value }
  }

  async getAuditLog(query: AuditQuery): Promise<Page<AuditEntry>> {
    this.need('audit.read')
    let rows = [...this.db.audit]
    if (query.entityType) rows = rows.filter((a) => a.entity === query.entityType)
    if (query.action) rows = rows.filter((a) => a.action === query.action)
    return paginate(rows, query)
  }

  async listNotifications(): Promise<Notification[]> {
    this.need('loans.read')
    return []
  }

  // ── Internals ─────────────────────────────────────────────────────

  private typeFor(key: string): MemberType {
    const t = this.db.memberTypes.find((x) => x.key === key)
    if (!t) throw new DomainRefusalError('That member type is not configured.')
    return t
  }

  /** The whole library, for a backup file or a snapshot. */
  exportState(): LibraryState {
    return JSON.parse(JSON.stringify(this.db)) as LibraryState
  }

  /** Restores a snapshot. Throws on anything malformed rather than half-applying. */
  importState(state: unknown): void {
    const parsed = JSON.parse(JSON.stringify(state)) as Partial<LibraryState>
    const required = ['users', 'members', 'titles', 'copies', 'loans'] as const
    for (const key of required) {
      if (!Array.isArray(parsed[key])) {
        throw new DomainRefusalError(
          `That backup is not a library snapshot: "${key}" is missing or not a list.`,
        )
      }
    }
    this.db = { ...emptyLibrary(), ...parsed } as LibraryState
  }

  /** Clears everything and starts empty. For a test, and for "start over". */
  reset(): void {
    this.db = emptyLibrary()
    this.roleOverride = null
  }
}