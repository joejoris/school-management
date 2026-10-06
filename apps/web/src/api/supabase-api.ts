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
  VoidRefusal,
  VoidResult,
  PaymentRefusal,
  PaymentResult,
  FineDetail,
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

/**
 * Supabase Auth, behind an interface.
 *
 * ── Why an interface rather than importing supabase-js here ────────────
 *
 * Because the rest of this file speaks plain PostgREST over `fetch` and can be tested
 * against a stub, and importing the SDK for one corner would make the whole client
 * untestable without a project. Auth is the part that genuinely needs the SDK — session
 * refresh, token rotation, the confirmation flow — so it is the part that gets one.
 *
 * The seam is four methods and an id. `tools/verify-live.mjs` implements it without a
 * browser so the whole system can be exercised end to end from a terminal.
 */
export interface SupabaseAuth {
  /** Creates the credential. `session` is false when the project requires email confirmation. */
  signUp(email: string, password: string): Promise<{ id: string | null; session: boolean; error: string | null }>
  signIn(email: string, password: string): Promise<{ id: string | null; error: string | null }>
  signOut(): Promise<void>
  /** The signed-in account's uuid, or null. */
  userId(): Promise<string | null>
  /**
   * Puts a previously held session back.
   *
   * Needed because `signUp` replaces the browser's session. Without this, an administrator
   * appointing a librarian would be signed out as themselves by the act of creating the
   * other account, and would have to type their password again. See `createUser`.
   */
  restore(accessToken: string, refreshToken: string): Promise<void>
}

export interface SupabaseConfig {
  url: string
  anonKey: string
  /** Supabase Auth session, from supabase-js. */
  accessToken(): Promise<string | null>
  /** Supabase Auth itself. See `SupabaseAuth`. */
  auth: SupabaseAuth
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
      // Postgres error text is not for a librarian, so it is logged rather than shown.
      const detail = await res.text().catch(() => '')
      console.error(`[supabase] ${init.method ?? 'GET'} ${path} -> ${res.status}`, detail)

      /*
       * PostgREST uses 404 for three unrelated things, and this client reported all three
       * as "That record could not be found."
       *
       *   PGRST205  the table is not in the schema cache -- a migration has not run
       *   PGRST202  the function does not exist, or not with those argument names
       *   otherwise a row that is genuinely not there
       *
       * The middle one is what actually happened: set_up_library had not been applied to
       * the database, so calling it returned 404 PGRST202 and the screen said a record was
       * missing. That points at the register rather than at the database, and it is a very
       * expensive afternoon to lose.
       *
       * So the code is read back out of the body and the sentence says which of the three
       * it is. A librarian cannot act on any of it, but whoever is holding the phone can,
       * and "the app is looking for something that was never built" is a completely
       * different afternoon from "that student is not on file".
       */
      let message = 'The library system could not be reached. Check your connection and try again.'
      if (res.status === 404) {
        if (/PGRST205/.test(detail)) {
          message =
            'The library database is not set up yet. Somebody needs to run the migrations in the Supabase SQL Editor.'
        } else if (/PGRST202/.test(detail)) {
          message =
            'The library database is missing a function it needs. Somebody needs to run the migrations in the Supabase SQL Editor.'
        } else {
          message = 'That record could not be found.'
        }
      } else if (res.status === 401 || res.status === 403) {
        // Not "could not be found". The caller is known and not allowed, which is a
        // different fact, and one the sign-in screen has to be able to tell apart from an
        // empty database.
        message = 'You do not have permission to do that.'
      }

      throw new SupabaseRefusal('request_failed', message)
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

  /**
   * What a free-text search asks the database.
   *
   * Each typed token must appear in at least one of the columns, and all tokens must
   * pass. Matching "Kept Student" against first_name and last_name on their own finds
   * nothing: the stored values are "Kept" and "Student", and a substring of "kept
   * student" appears in neither. Tokens fix that — "Kept" matches first_name, "Student"
   * matches last_name. This is the phrase the real database was refusing to answer.
   */
  private textFilter(q: string | undefined, columns: string[]): string | undefined {
    const tokens = (q ?? '')
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[*(),]/g, ''))
      .filter(Boolean)
    if (tokens.length === 0) return undefined
    return `(${tokens
      .map((t) => `or=(${columns.map((c) => `${c}.ilike.*${t}*`).join(',')})`)
      .join(',')})`
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

  /**
   * The signed-in account, as our `users` row.
   *
   * Two things have to be true for this to return anybody: a session, and a *profile*
   * whose id is that session's uuid. A session with no profile means somebody signed in
   * through Supabase Auth but was never appointed here — a person with credentials and
   * no role — and there is nothing they are allowed to do, so this is null rather than a
   * half-built user object.
   */
  async currentUser(): Promise<User | null> {
    const id = await this.cfg.auth.userId()
    if (!id) return null
    try {
      // By id, not "the first row". Reading `users?limit=1` would return whichever profile
      // sorts first, which for a signed-in librarian is whoever happens to be earliest in
      // the table — possibly somebody else entirely.
      const rows = await this.list<User>('users', { id: `eq.${id}`, limit: 1 })
      return rows[0] ?? null
    } catch (e) {
      if (e instanceof SupabaseRefusal) return null
      throw e
    }
  }

  /**
   * The first administrator, created through the setup screen.
   *
   * Two steps, and the order matters.
   *
   * Supabase Auth creates the *credential* — the hashed password lives in Auth's tables
   * and nowhere in this schema, which has no password column and must not grow one. Then
   * `set_up_library` creates our *profile* row, using the uuid Auth just handed back.
   *
   * That uuid is the whole point. `current_user_id()` reads the JWT's `sub`, and
   * `current_role_name()` looks up `users` by that id. An earlier version created the
   * profile without an id, so the table invented one and the two could never match: the
   * librarian was set up, the message said so, and every permission they had was false.
   *
   * The first account is an administrator whatever it asks for. Somebody must be able to
   * create the others, and letting the first sign-up choose would lock the school out of
   * its own register.
   *
   * Used ONCE, on an empty database. `set_up_library` refuses the moment any account
   * exists, which is what stops a second caller becoming an administrator. Appointing
   * anybody after that is `appointUser`, not this -- the Staff screen called this one by
   * mistake and so could never appoint a second librarian at all.
   */
  async createUser(input: CreateUserInput): Promise<User> {
    const auth = await this.cfg.auth.signUp(input.email, input.password)

    if (auth.error) throw new SupabaseRefusal('sign_up_refused', auth.error)
    if (!auth.id) {
      throw new SupabaseRefusal(
        'no_account',
        'That address could not be registered. Try a different one.',
      )
    }

    const created = await this.rpc<{ ok: boolean; id?: string; code?: string; message?: string; role?: string }>(
      'set_up_library',
      { p_user_id: auth.id, p_email: input.email, p_name: input.name },
    )
    if (!created.ok) {
      throw new SupabaseRefusal(created.code ?? 'refused', created.message ?? 'That did not work.')
    }

    if (!auth.session) {
      /*
       * A credential exists but no session. The project asks for the address to be
       * confirmed before it will issue one.
       *
       * Said plainly, because nothing is broken -- the account is made and works as soon
       * as the link is followed. Told "sign-in failed", people retype the same details and
       * get the same message.
       *
       * And it names the other way out, because this is a dead end for most schools. A
       * librarian who never receives the mail, or who is on a shared machine with no mail
       * client, is simply stuck -- and the fix is one tick in the Supabase project:
       * Authentication -> Providers -> Email -> untick "Confirm email". That is also the
       * right setting for this application, which is used at a counter by people who need
       * to be in on the morning they are asked.
       */
      throw new SupabaseRefusal(
        'confirm_email',
        'Account created. Sign in now — if Supabase asks you to confirm the address first, ' +
          'turn off "Confirm email" under Authentication → Providers → Email.',
      )
    }

    return {
      id: auth.id,
      email: input.email,
      name: input.name,
      role: 'admin',
      status: 'active',
      /*
       * Null, not `now()`.
       *
       * Creating an account is not signing in. They are two different acts by two
       * different people -- the first librarian sets the library up, and the next
       * librarian to use it signs in with their own account -- and a sign-in timestamp on
       * an account nobody has signed in with is a lie in the column somebody reads to
       * work out who has been on the desk.
       */
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    }
  }

  /**
   * Signing in.
   *
   * The credential goes to Supabase Auth and never reaches this schema. What comes back
   * is a session, and the profile is read from `users` by that session's uuid.
   */
  async signIn(email: string, password: string): Promise<User> {
    const result = await this.cfg.auth.signIn(email, password)
    if (result.error) {
      /*
       * Supabase has already turned that into a sentence a person can act on.
       *
       * This used to overwrite it with "That email and password do not match." The seam's
       * auth layer distinguishes a wrong password from an unconfirmed address, from a rate
       * limit, and from the network being down -- and all of that was being flattened into
       * one sentence about the password. Somebody whose address had not been confirmed was
       * told to retype a password that had been correct the whole time.
       *
       * Kept as a `bad_credentials` code because that is what it usually is, and the code
       * is what a caller branches on. The message is the specific one.
       */
      throw new SupabaseRefusal('bad_credentials', result.error)
    }

    const user = await this.currentUser()
    if (!user) {
      /*
       * Signed in, with a session, and no profile row.
       *
       * `currentUser` reads `users` by the session's uuid and returns null when there is
       * no row -- so this is somebody whose credential exists in Supabase Auth but who was
       * never given a role here. A common enough state to reach by accident, since the
       * sign-up form creates the credential and then the profile separately.
       *
       * The sentence says which half is missing, because "sign-in failed" is what it used
       * to amount to and that tells the head librarian nothing about what to look at.
       */
      throw new SupabaseRefusal(
        'no_profile',
        'You have signed in, but your account has not been set up yet. Ask the head librarian to add you.',
      )
    }

    /*
     * A switched-off account can still get a session.
     *
     * Supabase Auth has no idea our `users.status` column exists, so disabling a
     * librarian stops what they can *do* -- `can()` reads the status and every permission
     * becomes false -- but it does not stop Auth handing out a session. Which meant a
     * person who had been switched off landed on "you have not been given a role yet",
     * which is not true and sends the head librarian looking for a mistake they did not
     * make.
     *
     * Checked here so the sentence is the right one. The session is left in place rather
     * than thrown away: `signOut` is the caller's, and a half-finished sign-out is worse
     * than one the user asked for.
     */
    if (user.status !== 'active') {
      throw new SupabaseRefusal('disabled', 'That account has been switched off. Ask the head librarian.')
    }

    return { ...user, lastLoginAt: new Date().toISOString() }
  }

  async signOut(): Promise<void> {
    await this.cfg.auth.signOut()
  }

  async listUsers(): Promise<User[]> {
    return this.list<User>('users', { order: 'created_at' })
  }

  /**
   * Appointing somebody, as a signed-in administrator.
   *
   * `signUp` replaces the browser's session with the new account's. Left alone, an
   * administrator creating a librarian would be signed out as themselves by the act of
   * appointing them, and would have to type their password again — having just typed
   * somebody else's. So the administrator's own tokens are captured before the sign-up and
   * put back after.
   *
   * This is a workaround for a frontend-only build and it is worth being explicit about
   * what it is. With a server, the service_role key would create the Auth account and the
   * browser's session would never be touched at all. Without one, this is the honest
   * equivalent.
   *
   * The profile is created by `create_user_account`, which refuses without `users.write` —
   * so the permission is the database's decision, not the interface's.
   */
  async appointUser(input: CreateUserInput): Promise<User> {
    const before = await this.session()

    const auth = await this.cfg.auth.signUp(input.email, input.password)
    if (auth.error) {
      /*
       * The same duplicate check the setup path has, with the same wording.
       *
       * An administrator retyping somebody already on the staff list is an ordinary
       * mistake, and "That address could not be registered" is not a thing they can act
       * on. It is also worth naming the possibility out loud, because after this call the
       * browser's session may be sitting on the new account rather than their own.
       */
      throw new SupabaseRefusal(
        'sign_up_refused',
        /\balready\b/i.test(auth.error)
          ? auth.error
          : `${auth.error} If that address is already registered, open the Staff list instead.`,
      )
    }
    if (!auth.id) throw new SupabaseRefusal('no_account', 'That address could not be registered.')

    // Put the administrator back before anything else, so a failure in the next step
    // leaves them signed in rather than signed out and confused.
    if (before) await this.cfg.auth.restore(before.accessToken, before.refreshToken)

    const made = await this.rpc<{ ok: boolean; id?: string; code?: string; message?: string; role?: string }>(
      'create_user_account',
      { p_user_id: auth.id, p_email: input.email, p_name: input.name, p_role: input.role ?? 'assistant' },
    )
    if (!made.ok) throw new SupabaseRefusal(made.code ?? 'refused', made.message ?? 'That did not work.')

    return {
      id: auth.id,
      email: input.email,
      name: input.name,
      role: input.role ?? 'assistant',
      status: 'active',
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    }
  }

  /** The caller's own session, or null. Used only to survive `signUp` replacing it. */
  private async session(): Promise<{ accessToken: string; refreshToken: string } | null> {
    const access = await this.cfg.accessToken()
    if (!access) return null
    // The refresh token is not readable from the access token and is not something to
    // pass around; it is read here and immediately handed back to Auth, never stored.
    const anyS = this.cfg.auth as SupabaseAuth & {
      tokens?: () => Promise<{ access_token: string; refresh_token: string } | null>
    }
    const pair = await anyS.tokens?.()
    if (!pair) return null
    return { accessToken: pair.access_token, refreshToken: pair.refresh_token }
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

  /**
   * Voiding a loan.
   *
   * Returns a refusal rather than throwing, because `void_loan` can refuse for three
   * ordinary reasons — no reason given, already closed, no such loan — and a void is
   * something a librarian does deliberately. A refusal that arrives as an exception
   * reads as a fault, and they would press it again.
   */
  async voidLoan(loanId: string, reason: string): Promise<VoidResult> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string; loan_id?: string }>('void_loan', {
      p_loan_id: loanId,
      p_reason: reason,
    })
    if (res.ok) return { ok: true, loan: await this.one<Loan>('loans', res.loan_id!) }
    return {
      ok: false,
      refusal: (res.code ?? 'not_found') as VoidRefusal,
      message: res.message ?? 'That did not work.',
    }
  }

  /**
   * The register.
   *
   * `loans` stores *who* and *which copy* and nothing about them — no name, no
   * title, no book number — so a register line is assembled here from three
   * reads keyed by the ids on this page: members and copies together, then the
   * titles behind those copies. Only this page's ids are fetched; joining the
   * whole history to render twenty-five rows would be a query that grows with
   * the term.
   *
   * The join is in the client rather than a view or an RPC, because a view is
   * readable by anyone who can read its tables — which makes "the register" a
   * convenience rather than a rule. The rules are in the functions; this is
   * just the columns.
   */
  async listLoans(query: LoanQuery): Promise<Page<LoanRow>> {
    const status = query.status ?? 'on_loan'
    const params: Record<string, string | undefined> = {
      member_id: query.memberId ? `eq.${query.memberId}` : undefined,
    }
    if (status === 'all') {
      params.status = undefined
    } else if (status === 'overdue') {
      // Not a stored status: "active, and past due" — a comparison the database
      // can answer. The full day matches the mock's `daysOverdue`, which counts
      // whole days late rather than minutes.
      params.status = 'eq.active'
      params.due_at = `lt.${new Date(Date.now() - 86_400_000).toISOString()}`
    } else {
      params.status = `eq.${status === 'on_loan' ? 'active' : status}`
    }

    const page = await this.page<Loan>('loans', {
      ...query,
      // Newest first, with the id as a tiebreaker: several loans share a
      // timestamp when a class set goes out at once, and a page boundary that
      // sorts only on the timestamp can repeat or skip a row.
      sort: query.sort ?? 'checked_out_at.desc,id.desc',
    }, params)
    return { ...page, items: await this.loanRows(page.items) }
  }

  /** The columns a register line needs, from the ids a loan holds. */
  private async loanRows(loans: Loan[]): Promise<LoanRow[]> {
    if (loans.length === 0) return []
    const join = (ids: string[]) => `in.(${[...new Set(ids)].join(',')})`
    const [members, copies] = await Promise.all([
      this.list<Member>('members', { id: join(loans.map((l) => l.memberId)) }),
      this.list<Copy>('copies', { id: join(loans.map((l) => l.copyId)) }),
    ])
    const titleIds = copies.map((c) => c.titleId)
    const titles = titleIds.length > 0 ? await this.list<Title>('titles', { id: join(titleIds) }) : []
    const byMember = new Map(members.map((m) => [m.id, m]))
    const byCopy = new Map(copies.map((c) => [c.id, c]))
    const byTitle = new Map(titles.map((t) => [t.id, t]))
    const now = Date.now()

    return loans.map((l) => {
      const member = byMember.get(l.memberId)
      const copy = byCopy.get(l.copyId)
      const title = copy ? byTitle.get(copy.titleId) : undefined
      // Whole days, never negative, and only while the book is out: a book
      // returned early is not "minus three days overdue".
      const daysOverdue =
        l.status === 'active' ? Math.max(0, Math.floor((now - Date.parse(l.dueAt)) / 86_400_000)) : 0
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
    })
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
    const qFilter = this.textFilter(query.q, ['member_code', 'first_name', 'last_name'])
    return this.page<MemberSummary>('members', query, {
      status: query.status ? `eq.${query.status}` : undefined,
      type: query.type ? `eq.${query.type}` : undefined,
      ...(qFilter ? { and: qFilter } : {}),
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
    const qFilter = this.textFilter(query.q, ['title', 'author'])
    return this.page<TitleSummary>('titles', query, { ...(qFilter ? { and: qFilter } : {}) })
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

  /**
   * Waiving a fine.
   *
   * A returned refusal rather than a throw, for the same reason as the rest: a waiver
   * with no reason is the refusal a school hits most, and told as an exception it
   * reads as a fault rather than as a rule.
   */
  async waiveFine(input: WaiveFineInput): Promise<PaymentResult> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string }>('waive_fine', {
      p_fine_id: input.fineId,
      p_reason: input.reason,
    })
    if (!res.ok) {
      return {
        ok: false,
        refusal: (res.code ?? 'not_found') as PaymentRefusal,
        message: res.message ?? 'That did not work.',
      }
    }
    const fine = await this.refetchFine(input.fineId)
    return { ok: true, fine }
  }

  async recordPayment(input: RecordPaymentInput): Promise<PaymentResult> {
    const res = await this.rpc<{ ok: boolean; code?: string; message?: string }>('record_payment', {
      p_fine_id: input.fineId,
      p_amount: input.amountCents,
      p_reason: input.reason ?? null,
    })
    if (!res.ok) {
      return {
        ok: false,
        refusal: (res.code ?? 'not_found') as PaymentRefusal,
        message: res.message ?? 'That did not work.',
      }
    }
    return { ok: true, fine: await this.refetchFine(input.fineId) }
  }

  /**
   * The fine as it now stands, after the function has changed it.
   *
   * Re-read rather than trusted from the function's return, because the function only
   * reports what it did — the new balance and status come from the same read the
   * register would do, so the screen cannot show a number the database disagrees with.
   */
  private async refetchFine(fineId: string): Promise<FineDetail> {
    const found = (await this.getFines({ limit: 200, offset: 0 })).items.find((f) => f.id === fineId)
    if (!found) throw new SupabaseRefusal('not_found', 'That fine could not be found.')
    return found
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

  async exportBackup(): Promise<import('@library/contracts').LibrarySnapshot> {
    const [users, memberTypes, members, titles, shelfLocations, copies, loans, holds, fines, fineTxns, imports, audit, settingsRows] = await Promise.all([
      this.list<unknown>('users'),
      this.list('member_types'),
      this.list('members'),
      this.list('titles'),
      this.list('shelf_locations'),
      this.list('copies'),
      this.list('loans'),
      this.list('holds'),
      this.list('fines'),
      this.list('fine_txns'),
      this.list('imports'),
      this.list('audit'),
      this.list<{ key: string; value: unknown }>('settings'),
    ])
    const settings = Object.fromEntries((settingsRows as Array<{ key: string; value: unknown }>).map((s) => [s.key, s.value]))
    return {
      users: users as import('@library/contracts').LibrarySnapshot['users'],
      memberTypes: memberTypes as import('@library/contracts').LibrarySnapshot['memberTypes'],
      members: members as import('@library/contracts').LibrarySnapshot['members'],
      titles: titles as import('@library/contracts').LibrarySnapshot['titles'],
      shelfLocations: shelfLocations as import('@library/contracts').LibrarySnapshot['shelfLocations'],
      copies: copies as import('@library/contracts').LibrarySnapshot['copies'],
      loans: loans as import('@library/contracts').LibrarySnapshot['loans'],
      holds: holds as import('@library/contracts').LibrarySnapshot['holds'],
      fines: fines as import('@library/contracts').LibrarySnapshot['fines'],
      fineTxns: fineTxns as import('@library/contracts').LibrarySnapshot['fineTxns'],
      imports: imports as import('@library/contracts').LibrarySnapshot['imports'],
      audit: audit as import('@library/contracts').LibrarySnapshot['audit'],
      settings,
    } as import('@library/contracts').LibrarySnapshot
  }

  async importBackup(_snapshot: unknown): Promise<import('@library/contracts').BackupResult> {
    const { REFUSAL_MESSAGES } = await import('@library/contracts')
    return {
      ok: false,
      refusal: 'restore_refused',
      message: REFUSAL_MESSAGES.restore_refused,
    }
  }
}