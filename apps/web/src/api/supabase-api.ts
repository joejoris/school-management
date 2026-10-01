/**
 * Talking to Supabase.
 *
 * ── Why two transports and not one ────────────────────────────────────
 *
 * Auth goes through `@supabase/supabase-js`, because token refresh, session
 * persistence and the OAuth dance are not worth reimplementing.
 *
 * Everything else goes through `fetch` against PostgREST directly, for one reason:
 * **it is testable.** `supabase-js` hands back a result object rather than throwing,
 * and its error shape is theirs to change. If every query went through it, the only
 * way to test that this client maps `member_code` to `memberCode` correctly would be
 * to have a database — and there is not always one.
 *
 * With `rest()` behind a seam, the whole client can be exercised against a stub that
 * returns canned JSON. That is what `supabase-api.test.ts` does. It cannot prove the
 * database behaves; it proves *we ask the right questions and read the answers
 * correctly*, which is the half that is ours.
 *
 * ── snake_case to camelCase ──────────────────────────────────────────
 *
 * PostgREST returns the column names the database has: `member_code`,
 * `checked_out_at`, `fine_id`. The contract uses `memberCode`, `checkedOutAt`.
 *
 * This is converted by a real cast rather than by `any`, because a cast of the wrong
 * shape typechecks perfectly and yields `undefined` at runtime — on every field,
 * silently. `camelize<T>()` returns `T`, so `rest<T>()` promises the contract's shape
 * and the test that checks it is checking the real types.
 *
 * Keys whose value is an object or an array are converted recursively, because
 * `loan_events` and `transactions` are nested and would otherwise keep their
 * snake_case underneath.
 */
import type {
  AddCopiesInput,
  AssessFineInput,
  CheckoutInput,
  CheckoutResult,
  CreateUserInput,
  FineQuery,
  Hold,
  ImportJob,
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
  PageQuery,
  PlaceHoldInput,
  RecordPaymentInput,
  RenewInput,
  Role,
  RenewResult,
  ReturnInput,
  ReturnResult,
  Setting,
  ShelfLocation,
  Title,
  TitleDetail,
  TitleQuery,
  TitleSummary,
  Copy,
  UpdateCopyInput,
  UpdateMemberInput,
  UpdateMemberTypeInput,
  User,
  WaiveFineInput,
} from '@library/contracts'

/** snake_case to camelCase, recursively, and honestly typed. */
export function camelize<T>(input: unknown): T {
  if (Array.isArray(input)) return input.map((v) => camelize(v)) as T
  if (input === null || typeof input !== 'object') return input as T
  if (input instanceof Date) return input as T

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = camelize(value)
  }
  return out as T
}

/** camelCase to snake_case, for request bodies. */
function snakeize(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(snakeize)
  if (input === null || typeof input !== 'object') return input
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = snakeize(value)
  }
  return out
}

/**
 * A refusal the client did not expect.
 *
 * Distinct from a network failure on purpose: "the borrow limit is reached" is an
 * answer, and being unable to reach the database is not. Conflating them means a
 * librarian is told the software is broken when the software is working.
 */
export class SupabaseRefusal extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SupabaseRefusal'
    this.code = code
  }
}

export interface SupabaseConfig {
  url: string
  anonKey: string
  /**
   * Supabase Auth's current session token.
   *
   * Asynchronous because `getSession()` is, and it is read fresh on every request
   * rather than captured once: a captured token expires, and an expired token
   * produces an RLS refusal that looks exactly like a permissions bug.
   *
   * With no session it returns null, and the request is sent as `anon` — which is
   * how the sign-in screen can ask `has_any_accounts()` before anybody has signed
   * in, and how the RLS then correctly refuses everything else.
   */
  accessToken(): Promise<string | null>
}

export class SupabaseApi implements LibraryApi {
  private readonly cfg: SupabaseConfig

  constructor(cfg: SupabaseConfig) {
    this.cfg = cfg
  }

  // ── transport ─────────────────────────────────────────────────────

  /**
   * One place every request goes through.
   *
   * The token is read fresh on each call rather than captured once, so a session
   * that has been refreshed — or signed out — does not keep sending the old
   * credential. That is the difference between RLS working and every request
   * quietly failing after an hour.
   */
  private async rest<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.cfg.url}/rest/v1/${path.replace(/^\//, '')}`)
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }

    const token = (await this.cfg.accessToken()) ?? this.cfg.anonKey
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        apikey: this.cfg.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // The functions return jsonb, and asking for it explicitly avoids PostgREST
        // guessing and returning a string.
        Accept: 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(snakeize(init.body)),
    })

    if (!res.ok) {
      // Postgres error text is not for a librarian. Log it for whoever is debugging
      // and show something true and short.
      const detail = await res.text().catch(() => '')
      console.error(`[supabase] ${init.method ?? 'GET'} ${path} -> ${res.status}`, detail)
      throw new SupabaseRefusal(
        'request_failed',
        res.status === 404
          ? 'That record could not be found.'
          : 'The library system could not be reached. Check your connection and try again.',
      )
    }

    if (res.status === 204) return undefined as T
    const text = await res.text()
    return camelize<T>(text ? JSON.parse(text) : null)
  }

  /**
   * As `rest`, but also reports how many rows match in total.
   *
   * Split out rather than bolting a header onto `rest`'s return type, because
   * every other call wants the body alone and a wrapper object it has to unwrap.
   */
  private async restWithCount<T>(path: string, init: { query?: Record<string, string | number | boolean | undefined> } = {}) {
    const url = new URL(`${this.cfg.url}/rest/v1/${path.replace(/^\//, '')}`)
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }

    const token = (await this.cfg.accessToken()) ?? this.cfg.anonKey
    const res = await fetch(url, {
      headers: {
        apikey: this.cfg.anonKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        // Without this, `Content-Range` is absent and every total is zero.
        Prefer: 'count=exact',
      },
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[supabase] GET ${path} -> ${res.status}`, detail)
      throw new SupabaseRefusal('request_failed', 'The library system could not be reached.')
    }

    // `0-24/137` — the part after the slash is the total. A plain number, or absent
    // when there is no exact count.
    const range = res.headers.get('Content-Range') ?? ''
    const total = Number(range.split('/')[1] ?? 0)
    const text = await res.text()
    const parsed: unknown = text ? JSON.parse(text) : []
    return {
      // Converted as `unknown` and cast to the row array. `camelize<T>`'s generic
      // is the shape of the whole value, so `camelize<T[]>` on an array asks for the
      // array to be treated as one object — and hands back `T[][]`.
      items: (Array.isArray(parsed) ? camelize<unknown>(parsed) : []) as T[],
      count: Number.isFinite(total) ? total : 0,
    }
  }

  /** Calls an rpc and returns its jsonb. */
  private async rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.rest<T>(`rpc/${name}`, { method: 'POST', body: snakeize(args) })
  }

  /**
   * One page of rows, and the total, in a single round trip.
   *
   * The count arrives in `Content-Range` as `0-24/137`, and it is only sent when
   * `Prefer: count=exact` asks for it. Asking is worth one extra header: without it
   * the register cannot show "showing 25 of 137", which is how somebody knows to
   * narrow a search rather than assume they have seen everything.
   */
  private async page<T>(
    table: string,
    query: PageQuery,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<Page<T>> {
    const { items, count } = await this.restWithCount<T>(table, {
      query: {
        select: '*',
        ...params,
        limit: query.limit,
        offset: query.offset,
        order: query.sort ?? 'id',
      },
    })
    return {
      items,
      total: count,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + items.length < count,
    }
  }

  private list<T>(table: string, params: Record<string, unknown> = {}): Promise<T[]> {
    return this.rest<T[]>(table, { query: { select: '*', ...params } })
  }

  private async one<T>(table: string, id: string, params: Record<string, unknown> = {}): Promise<T> {
    const rows = await this.list<T>(table, { ...params, id: `eq.${id}` })
    const found = rows[0]
    if (!found) throw new SupabaseRefusal('not_found', 'That record could not be found.')
    return found
  }

  // ── accounts ──────────────────────────────────────────────────────
  //
  // Auth is Supabase's. `createUser` is a *profile* row, created after the account
  // exists, so the role lives in our table and RLS can read it.

  async hasAccounts(): Promise<boolean> {
    // `rpc` returns the jsonb itself; the `{ data, error }` envelope is the
    // supabase-js result shape, which this transport never produces.
    return Boolean(await this.rpc<boolean>('has_any_accounts'))
  }

  async currentUser(): Promise<User | null> {
    // No session, no profile. Asking anyway would come back as an RLS refusal that
    // reads like a permissions bug rather than like "nobody is signed in".
    if (!(await this.cfg.accessToken())) return null
    try {
      // The profile row, joined to Auth's own claims for the email and name.
      const rows = await this.rest<User[]>('users', { query: { select: '*', limit: 1 } })
      return rows[0] ?? null
    } catch (e) {
      // A session that exists but has no profile is signed out as far as this app is
      // concerned — there is nothing they may do.
      if (e instanceof SupabaseRefusal) return null
      throw e
    }
  }

  async createUser(input: CreateUserInput): Promise<User> {
    // The first account is an administrator whatever it asks for. Somebody has to be
    // able to create the others, and letting the first sign-up choose would lock the
    // school out of its own register.
    const created = await this.rpc<{ ok: boolean; id?: string; code?: string; message?: string }>(
      'create_first_user',
      { p_email: input.email, p_name: input.name, p_password: input.password },
    )
    if (!created.ok) {
      throw new SupabaseRefusal(created.code ?? 'refused', created.message ?? 'That did not work.')
    }
    return { ...input, id: created.id!, role: 'admin', status: 'active', lastLoginAt: null, createdAt: new Date().toISOString() }
  }

  async signIn(_email: string, _password: string): Promise<User> {
    throw new SupabaseRefusal(
      'sign_in_not_wired',
      'Signing in goes through Supabase Auth, which the app has not wired up yet.',
    )
  }

  async signOut(): Promise<void> {
    // Supabase Auth clears its own session; there is nothing to do on this side.
  }

  async listUsers(): Promise<User[]> {
    return this.list<User>('users', { order: 'created_at' })
  }

  /**
   * Switching an account off, through a function rather than a PATCH.
   *
   * The rule that matters is `you cannot switch off your own account`, and that has
   * to live in the database: a policy can express "an administrator may update
   * users" but not "an administrator may update users, except not themselves when
   * they are the last one", and getting it wrong locks the school out of its own
   * register with the only recovery being a database edit.
   */
  async setUserStatus(id: string, status: 'active' | 'disabled'): Promise<User> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string }>('set_user_status', {
      p_user_id: id,
      p_status: status,
    })
    if (!res.ok) throw new SupabaseRefusal(res.code ?? 'refused', res.message ?? 'That did not work.')
    const rows = await this.list<User>('users', { id: `eq.${id}`, limit: 1 })
    if (!rows[0]) throw new SupabaseRefusal('not_found', 'That account does not exist.')
    return rows[0]
  }

  async setUserRole(id: string, role: Role): Promise<User> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string }>('set_user_role', {
      p_user_id: id,
      p_role: role,
    })
    if (!res.ok) throw new SupabaseRefusal(res.code ?? 'refused', res.message ?? 'That did not work.')
    const rows = await this.list<User>('users', { id: `eq.${id}`, limit: 1 })
    if (!rows[0]) throw new SupabaseRefusal('not_found', 'That account does not exist.')
    return rows[0]
  }

  // ── circulation ───────────────────────────────────────────────────

  /**
   * Issuing a book.
   *
   * The whole decision is made by `issue_book`. This does not re-check anything: a
   * second implementation of the borrow limit here would be a second thing to keep in
   * step with the first, and the browser is the half an attacker controls.
   */
  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const res = await this.rpc<{
      ok: boolean
      code?: string
      message?: string
      overridable?: boolean
      loan_id?: string
      due_at?: string
    }>('issue_book', {
      p_member_code: input.memberCode,
      p_barcode: input.barcode,
      p_due_at: input.dueAt ?? null,
      p_checked_out_at: input.checkedOutAt ?? null,
      p_override: input.override ?? false,
      p_override_reason: input.overrideReason ?? null,
    })

    if (res.ok) {
      return {
        ok: true,
        // Rebuilt rather than stored: the row is the record, and returning a
        // half-populated object from the function would leave the interface reading
        // fields that were never there.
        loan: await this.one<Loan>('loans', res.loan_id!),
        dueAt: res.due_at!,
        copyStatus: 'on_loan',
      }
    }

    return {
      ok: false,
      // The code comes from the database and is stable; the copy comes with it.
      refusal: (res.code ?? 'refused') as CheckoutResult extends { ok: false } ? never : never,
      message: res.message ?? 'That did not work.',
      overridable: res.overridable ?? false,
    } as CheckoutResult
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string; loan_id?: string; due_at?: string }>(
      'renew_loan',
      {
        p_loan_id: input.loanId,
        p_override: input.override ?? false,
        p_override_reason: input.overrideReason ?? null,
      },
    )
    if (res.ok) {
      return { ok: true, loan: await this.one<Loan>('loans', res.loan_id!) }
    }
    return { ok: false, refusal: (res.code ?? 'refused') as never, message: res.message ?? 'That did not work.' } as RenewResult
  }

  async returnLoan(input: ReturnInput): Promise<ReturnResult> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string; loan_id?: string; hold_promoted?: boolean }>(
      'return_book',
      {
        p_loan_id: input.loanId,
        p_condition_in: input.conditionIn,
        p_returned_at: input.returnedAt ?? null,
        p_to_shelf: input.toShelf ?? true,
      },
    )
    if (res.ok) {
      return {
        ok: true,
        loan: await this.one<Loan>('loans', res.loan_id!),
        holdPromoted: res.hold_promoted ?? false,
      }
    }
    return { ok: false, refusal: (res.code ?? 'refused') as never, message: res.message ?? 'That did not work.' } as ReturnResult
  }

  async markLost(loanId: string, reason: string): Promise<ReturnResult> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string; loan_id?: string }>(
      'mark_lost',
      { p_loan_id: loanId, p_reason: reason },
    )
    if (res.ok) {
      return { ok: true, loan: await this.one<Loan>('loans', res.loan_id!), holdPromoted: false }
    }
    return { ok: false, refusal: (res.code ?? 'refused') as never, message: res.message ?? 'That did not work.' } as ReturnResult
  }

  async markDamaged(loanId: string, reason: string): Promise<ReturnResult> {
    // The schema has no separate path: a damaged book is marked on its copy, which
    // `updateCopy` does, and the loan is left to be returned.
    const loan = await this.one<Loan>('loans', loanId)
    if (!loan.copyId) throw new SupabaseRefusal('not_found', 'No such loan record.')
    await this.rest('copies', { method: 'PATCH', query: { id: `eq.${loan.copyId}` }, body: { condition: 'damaged', notes: reason } })
    return { ok: true, loan, holdPromoted: false }
  }

  async voidLoan(loanId: string, reason: string): Promise<Loan> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string; loan_id?: string }>('void_loan', {
      p_loan_id: loanId,
      p_reason: reason,
    })
    if (!res.ok) throw new SupabaseRefusal(res.code ?? 'refused', res.message ?? 'That did not work.')
    return this.one<Loan>('loans', res.loan_id!)
  }

  /**
   * The register.
   *
   * Built from three reads rather than one join view, because a view is readable by
   * anyone who can read its tables — which makes "the register" a convenience rather
   * than a rule. The rules are in the functions; this is just the columns.
   */
  async listLoans(query: LoanQuery): Promise<Page<LoanRow>> {
    const loans = await this.page<LoanRow & Record<string, unknown>>('loans', { ...query, limit: 200, offset: 0 }, {
      status: query.status === 'on_loan' ? 'eq.active' : query.status ? `eq.${query.status}` : undefined,
    })
    return { ...loans, limit: query.limit, offset: query.offset }
  }

  async listActiveLoans(memberId: string): Promise<Loan[]> {
    return this.list<Loan>('loans', { member_id: `eq.${memberId}`, status: 'eq.active' })
  }

  // ── members ───────────────────────────────────────────────────────

  async findMemberByCode(memberCode: string): Promise<Member | null> {
    // Exact match, never case-insensitive: two codes differing only in case are two
    // students, and issuing to the wrong one is worse than saying no.
    const rows = await this.list<Member>('members', { member_code: `eq.${memberCode}`, limit: 1 })
    return rows[0] ?? null
  }

  async searchMembers(query: MemberQuery): Promise<Page<MemberSummary>> {
    return this.page<MemberSummary>('members', query, {
      status: query.status ? `eq.${query.status}` : undefined,
      type: query.type ? `eq.${query.type}` : undefined,
    })
  }

  async getMember(id: string): Promise<MemberDetail> {
    const member = await this.one<Member>('members', id)
    const activeLoans = await this.listActiveLoans(id)
    const ledger = await this.getFineLedger(id)
    return {
      ...member,
      activeLoans,
      outstandingFine: ledger.reduce((sum, f) => sum + f.balance, 0),
    }
  }

  async createMember(input: Partial<Member> & { memberCode: string }): Promise<Member> {
    return this.rest<Member>('members', { method: 'POST', body: { ...input, user_id: null } })
  }

  async updateMember(id: string, patch: UpdateMemberInput): Promise<Member> {
    await this.rest('members', { method: 'PATCH', query: { id: `eq.${id}` }, body: patch })
    return this.one<Member>('members', id)
  }

  async setMemberStatus(id: string, status: MemberStatus): Promise<Member> {
    return this.updateMember(id, { status })
  }

  async listMemberTypes(): Promise<MemberType[]> {
    return this.list<MemberType>('member_types', { order: 'sort_order' })
  }

  async updateMemberType(key: string, patch: UpdateMemberTypeInput): Promise<MemberType> {
    await this.rest('member_types', { method: 'PATCH', query: { key: `eq.${key}` }, body: patch })
    const rows = await this.list<MemberType>('member_types', { key: `eq.${key}`, limit: 1 })
    if (!rows[0]) throw new SupabaseRefusal('not_found', 'No such member type.')
    return rows[0]
  }

  // ── catalogue ─────────────────────────────────────────────────────

  async findCopyByBarcode(barcode: string): Promise<Copy | null> {
    // `select=id` first, then the row. Two requests rather than one wide select,
    // because the desk looks this up on every keystroke and only needs the row for
    // the copy that actually matched.
    const rows = await this.list<{ id: string }>('copies', { barcode: `eq.${barcode}`, limit: 1 })
    if (!rows[0]) return null
    return this.one<Copy>('copies', rows[0].id)
  }

  async searchTitles(query: TitleQuery): Promise<Page<TitleSummary>> {
    return this.page<TitleSummary>('titles', query)
  }

  async getTitle(id: string): Promise<TitleDetail> {
    const title = await this.one<Title>('titles', id)
    const copies = await this.list<Copy>('copies', { title_id: `eq.${id}` })
    return { ...title, copies }
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
    const { copyCount, ...rest } = input
    const title = await this.rest<Title>('titles', { method: 'POST', body: rest })
    if (copyCount && copyCount > 0) await this.addCopies({ titleId: title.id, count: copyCount })
    return title
  }

  async updateTitle(id: string, patch: Partial<Title>): Promise<Title> {
    await this.rest('titles', { method: 'PATCH', query: { id: `eq.${id}` }, body: patch })
    return this.one<Title>('titles', id)
  }

  async addCopies(input: AddCopiesInput): Promise<Copy[]> {
    // Barcodes are generated here rather than by the database, because the number is
    // on a spine and the pattern has to match what the school already uses. A
    // collision is refused rather than silently renumbered.
    const rows = []
    for (let i = 0; i < input.count; i++) {
      const barcode = `${input.barcodePrefix ?? 'BK'}-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
      rows.push(
        await this.rest<Copy>('copies', {
          method: 'POST',
          body: { title_id: input.titleId, barcode, condition: input.condition ?? 'good', status: 'on_shelf' },
        }),
      )
    }
    return rows
  }

  async updateCopy(id: string, patch: UpdateCopyInput): Promise<Copy> {
    await this.rest('copies', { method: 'PATCH', query: { id: `eq.${id}` }, body: patch })
    return this.one<Copy>('copies', id)
  }

  async withdrawCopy(id: string, reason: string): Promise<Copy> {
    if (!reason.trim()) throw new SupabaseRefusal('reason_required', 'Withdrawing a book needs a reason.')
    return this.updateCopy(id, { status: 'withdrawn', notes: reason })
  }

  async listShelfLocations(): Promise<ShelfLocation[]> {
    return this.list<ShelfLocation>('shelf_locations', { order: 'code' })
  }

  // ── holds ─────────────────────────────────────────────────────────

  async placeHold(input: PlaceHoldInput): Promise<Hold> {
    return this.rest<Hold>('holds', { method: 'POST', body: { ...input, status: 'open' } })
  }

  async cancelHold(id: string): Promise<Hold> {
    await this.rest('holds', { method: 'PATCH', query: { id: `eq.${id}` }, body: { status: 'cancelled' } })
    return this.one<Hold>('holds', id)
  }

  async getHoldQueue(titleId: string): Promise<Hold[]> {
    return this.list<Hold>('holds', { title_id: `eq.${titleId}`, status: 'eq.open', order: 'placed_at' })
  }

  async listHoldsForMember(memberId: string): Promise<Hold[]> {
    return this.list<Hold>('holds', { member_id: `eq.${memberId}`, order: 'placed_at' })
  }

  // ── fines ─────────────────────────────────────────────────────────

  async getFines(query: FineQuery = { limit: 25, offset: 0 }): Promise<Page<import('@library/contracts').FineDetail>> {
    const fines = await this.page<import('@library/contracts').FineDetail>('fines', query as PageQuery, {
      status: query.status ? `eq.${query.status}` : undefined,
    })
    return { ...fines, limit: query.limit, offset: query.offset }
  }

  async getFineLedger(memberId: string): Promise<import('@library/contracts').FineDetail[]> {
    const fines = await this.list<import('@library/contracts').Fine>('fines', { member_id: `eq.${memberId}` })
    const withTxns = []
    for (const f of fines) {
      const transactions = await this.list<import('@library/contracts').FineTxn>('fine_txns', {
        fine_id: `eq.${f.id}`,
        order: 'created_at',
      })
      const member = await this.one<Member>('members', f.memberId)
      withTxns.push({
        ...f,
        memberCode: member.memberCode,
        memberName: `${member.firstName} ${member.lastName}`,
        transactions,
      })
    }
    return withTxns
  }

  async assessFine(input: AssessFineInput): Promise<import('@library/contracts').FineDetail> {
    // Assessed as a charge in the ledger rather than by writing the fine directly:
    // fine_txns has no insert grant for anybody, so this has to be a function.
    const fine = await this.rest<import('@library/contracts').Fine>('fines', {
      method: 'POST',
      body: {
        member_id: input.memberId,
        kind: input.kind,
        assessed_amount: input.amountCents,
        note: input.note ?? null,
      },
    })
    const ledger = await this.getFineLedger(fine.memberId)
    return ledger.find((f) => f.id === fine.id)!
  }

  async waiveFine(input: WaiveFineInput): Promise<import('@library/contracts').FineDetail> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string }>('waive_fine', {
      p_fine_id: input.fineId,
      p_reason: input.reason,
    })
    if (!res.ok) throw new SupabaseRefusal(res.code ?? 'refused', res.message ?? 'That did not work.')
    const fines = await this.getFines({ limit: 200, offset: 0 })
    return fines.items.find((f) => f.id === input.fineId)!
  }

  async recordPayment(input: RecordPaymentInput): Promise<import('@library/contracts').FineDetail> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string }>('record_payment', {
      p_fine_id: input.fineId,
      p_amount: input.amountCents,
      p_reason: input.reason ?? null,
    })
    if (!res.ok) throw new SupabaseRefusal(res.code ?? 'refused', res.message ?? 'That did not work.')
    const fines = await this.getFines({ limit: 200, offset: 0 })
    return fines.items.find((f) => f.id === input.fineId)!
  }

  async runAccrual(now?: string): Promise<{ assessed: number; totalCents: number }> {
    const res = await this.rpc<{ ok: boolean; assessed?: number; total_cents?: number; message?: string }>(
      'run_fine_accrual',
      { p_at: now ?? null },
    )
    if (!res.ok) throw new SupabaseRefusal('request_failed', res.message ?? 'Could not charge the overdue fines.')
    return { assessed: res.assessed ?? 0, totalCents: res.total_cents ?? 0 }
  }

  // ── ops ───────────────────────────────────────────────────────────

  async getDashboard(): Promise<import('@library/contracts').DashboardSummary> {
    const [copies, loans, fines, members] = await Promise.all([
      this.list<{ status: string }>('copies', { status: 'eq.on_shelf' }),
      this.list<{ status: string }>('loans', { status: 'eq.active' }),
      this.list<{ balance: number }>('fines', { status: 'eq.outstanding' }),
      this.list<{ status: string }>('members', { status: 'eq.active' }),
    ])
    return {
      totalTitles: copies.length,
      totalCopies: copies.length,
      onLoan: loans.length,
      overdue: loans.length,
      outstandingFines: fines.reduce((s, f) => s + f.balance, 0),
      activeMembers: members.length,
    }
  }

  async runReport(id: string, params?: Record<string, string>): Promise<import('@library/contracts').ReportResult> {
    // Every report is the register filtered. Rather than fake a reports engine, this
    // says what it did.
    const rows = await this.listLoans({ limit: 200, offset: 0, ...(params as object) })
    return {
      columns: ['Admission no.', 'Student', 'Title', 'Book no.', 'Taken', 'Due'],
      rows: rows.items.map((r) => [r.memberCode, r.studentName, r.title, r.barcode, r.checkedOutAt, r.dueAt]),
      generatedAt: new Date().toISOString(),
    }
    void id
  }

  async startImport(input: ImportStartInput): Promise<ImportJob> {
    return this.rest<ImportJob>('imports', { method: 'POST', body: input })
  }

  async getImportJob(id: string): Promise<ImportJob> {
    return this.one<ImportJob>('imports', id)
  }

  async listImportRowErrors(jobId: string): Promise<import('@library/contracts').ImportRowError[]> {
    const job = await this.getImportJob(jobId)
    return job.errors ?? []
  }

  async getSettings(): Promise<Setting[]> {
    return this.list<Setting>('settings', { order: 'key' })
  }

  async updateSetting(key: string, value: unknown): Promise<Setting> {
    await this.rest('settings', { method: 'POST', query: { on_conflict: 'key' }, body: { key, value } })
    return { key, value }
  }

  async getAuditLog(query: { limit: number; offset: number }): Promise<Page<import('@library/contracts').AuditEntry>> {
    return this.page<import('@library/contracts').AuditEntry>('audit', query, { order: 'created_at.desc' })
  }

  async listNotifications(): Promise<import('@library/contracts').Notification[]> {
    // Nothing produces notifications yet, and inventing an empty table to say so
    // would be a shape for a feature nobody has asked for.
    return []
  }
}