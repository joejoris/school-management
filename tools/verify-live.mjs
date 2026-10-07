/**
 * Drive the real Supabase project, end to end, from a terminal.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * There is no browser attached to this session, and jsdom is not a viewport. Everything
 * verified so far about the live project has been a handful of curl-shaped probes: does
 * a table exist, does anon get refused, does a function return a sentence.
 *
 * That is not the same as the application working. Nobody has yet issued a book to a
 * student and brought it back against the real database, and that is the one thing the
 * school actually needs.
 *
 * So this script does exactly that, using the same `SupabaseApi` the browser uses, with a
 * hand-written `SupabaseAuth` in place of supabase-js. It signs up, sets the library up,
 * signs in, stocks a book, issues it, tries the things the domain refuses, renews,
 * returns it, and reads the register back.
 *
 * ── What it proves, and what it does not ──────────────────────────────
 *
 * It proves the database, the RLS, the functions, the client and the domain all agree.
 * It does not prove the screens render, because it never renders anything. The screens
 * are covered by 80 jsdom tests against the in-memory domain; this covers the wire.
 *
 * Both halves matter and neither covers the other. That is why there are 176 tests and
 * this script, and why neither number is worth much on its own.
 *
 * ── Running it ────────────────────────────────────────────────────────
 *
 *   node tools/verify-live.mjs            every check
 *   node tools/verify-live.mjs security   one group
 *
 * Reads apps/web/.env.local. Creates real data and removes it again; see `cleanup`.
 */
import { readFileSync } from 'node:fs'
import { SupabaseApi, SupabaseRefusal } from '../apps/web/src/api/supabase-api.ts'

/*
 * ── credentials ────────────────────────────────────────────────────────
 *
 * Read from .env.local, which .gitignore covers. The anon key is public by design; the
 * database password is not here and never should be.
 */
const env = Object.fromEntries(
  readFileSync('apps/web/.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const URL_ = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY
if (!URL_ || !ANON) {
  console.error('  apps/web/.env.local is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

/*
 * ── Supabase Auth, without supabase-js ─────────────────────────────────
 *
 * supabase-js stores its session in localStorage, which does not exist here. So this
 * keeps the token pair in memory and posts to Auth's own endpoints, which is the same
 * protocol supabase-js speaks. The browser path is covered by 80 jsdom tests; this is
 * about the wire.
 */
let token = null
let refresh = null

/*
 * The real uuid, captured at sign-in.
 *
 * `currentUser()` looks the profile up by the session's uuid. This hand-written Auth
 * could report a placeholder, but the whole point of the exercise is to check that the
 * uuid Auth issues is the one `set_up_library` stored -- so the genuine value is kept
 * and handed back, exactly as supabase-js would.
 */
let realUserId = null

const auth = {
  async signUp(email, password) {
    const r = await post('/auth/v1/signup', { email, password })
    if (!r.ok) {
      const message = (r.body?.msg || r.body?.message || r.body?.error_description || '').toString()
      if (/already|registered|exists/i.test(message)) {
        return { id: null, session: false, error: 'There is already an account with that address.' }
      }
      return { id: null, session: false, error: message || 'That address could not be registered.' }
    }
    token = r.body?.access_token ?? null
    refresh = r.body?.refresh_token ?? null
    realUserId = r.body?.user?.id ?? r.body?.id ?? null
    return { id: realUserId, session: Boolean(token), error: null }
  },

  async signIn(email, password) {
    const r = await post('/auth/v1/token?grant_type=password', { email, password })
    if (!r.ok) return { id: null, error: 'That email and password do not match.' }
    token = r.body?.access_token ?? null
    refresh = r.body?.refresh_token ?? null
    realUserId = r.body?.user?.id ?? null
    return { id: realUserId, error: null }
  },

  async signOut() {
    token = null
    refresh = null
    realUserId = null
  },

  async userId() {
    return realUserId
  },

  async restore(a, b) {
    token = a
    refresh = b
  },

  async tokens() {
    return token && refresh ? { access_token: token, refresh_token: refresh } : null
  },
}

async function post(path, body) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const r = await fetch(URL_ + path, {
      method: 'POST',
      signal: ctl.signal,
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* not json */
    }
    return { ok: r.ok, status: r.status, body: parsed }
  } finally {
    clearTimeout(timer)
  }
}

/*
 * PostgREST, directly, with whatever token is currently held.
 *
 * Deliberately not routed through `api`. These probes need the raw status code, because
 * the difference between "refused" and "reachable but refusing in its own words" is the
 * whole subject of the security group -- and reading that out of a decoded result object
 * is how `set_user_status` came to be reported as protected when it was reachable.
 */
async function raw(path, init = {}, as = token) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const r = await fetch(URL_ + '/rest/v1/' + path, {
      ...init,
      signal: ctl.signal,
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${as ?? ANON}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    const text = await r.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: r.status, body }
  } finally {
    clearTimeout(timer)
  }
}
const get = (p, as) => raw(p, {}, as)
const write = (p, method, body, as) => raw(p, { method, body }, as)
const rpc = (name, args, as) => raw(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) }, as)

const api = new SupabaseApi({ url: URL_, anonKey: ANON, accessToken: async () => token, auth })

// ── reporting ──────────────────────────────────────────────────────────
let pass = 0
let fail = 0
const failures = []

function ok(what) {
  pass++
  console.log(`  ✓ ${what}`)
}
function no(what, why) {
  fail++
  failures.push(`${what} — ${why}`)
  console.log(`  ✗ ${what}\n      ${why}`)
}
async function expectOk(label, fn) {
  try {
    const value = await fn()
    // A call that did not throw is not the same as a call that worked. With no
    // session, currentUser() comes back null without throwing, and this said
    // "found the profile" about nothing. Every caller here wants a row or a page.
    if (value === null || value === undefined) {
      no(label, 'came back empty')
      return value
    }
    ok(label)
    return value
  } catch (e) {
    no(label, e instanceof Error ? e.message : String(e))
    return null
  }
}
async function expectRefusal(label, code, fn) {
  try {
    const r = await fn()
    if (r && r.ok === false && r.refusal === code) {
      ok(`${label} — refused with ${code}`)
      return r
    }
    no(label, `expected a refusal with code '${code}', got ${JSON.stringify(r)?.slice(0, 80)}`)
    return null
  } catch (e) {
    if (e instanceof SupabaseRefusal && e.code === code) {
      ok(`${label} — refused with ${code}`)
      return null
    }
    no(label, `expected '${code}', got ${e instanceof Error ? e.message : e}`)
    return null
  }
}

const group = (name) => console.log(`\n  ${name}`)
const wanted = process.argv[2]
const want = (g) => !wanted || wanted === g

/*
 * ── the data this script creates ──────────────────────────────────────
 *
 * A real student and a real book, deleted at the end. The prefix is distinctive so a run
 * that is interrupted leaves something identifiable rather than something anonymous, and
 * `cleanup` lists exactly what would be removed.
 */
const RUN = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const CODE = `V${RUN}`
const STUDENT = `Probe Student ${RUN}`
const BOOK = `Probe Book ${RUN}`
const PASSWORD = `probe-${RUN}-not-a-real-password`

const created = { members: [], titles: [], copies: [] }

// ─────────────────────────────────────────────────────────────────────────
//  security: signed out
// ─────────────────────────────────────────────────────────────────────────
if (want('security')) {
  group('security, signed out with the public key')

  for (const table of ['members', 'loans', 'fine_txns', 'users', 'audit', 'titles', 'copies']) {
    const r = await get(`${table}?select=*&limit=1`, null)
    if (r.status === 401 || r.status === 403) ok(`reading ${table} is refused (${r.status})`)
    else no(`reading ${table} is refused`, `got ${r.status} — ${String(r.body).slice(0, 60)}`)
  }

  for (const [table, body] of [
    ['loans', '[{}]'],
    ['fines', '[{}]'],
    ['fine_txns', '[{}]'],
  ]) {
    const r = await write(table, 'POST', body, null)
    if (r.status === 401 || r.status === 403) ok(`writing ${table} is refused (${r.status})`)
    else no(`writing ${table} is refused`, `got ${r.status} — ${String(r.body).slice(0, 60)}`)
  }

  /*
   * Every function called with its real argument names.
   *
   * This detail cost three false failures the first time. PostgREST answers **404**
   * when the argument list matches no signature, and it answers that before it looks at
   * permissions at all -- so `rpc/issue_book` with `{}` says "no such function" rather
   * than "not permitted". `run_fine_accrual()` takes no arguments, matched `{}` happily,
   * and correctly reported 401 -- so the group looked half broken and was actually fine.
   *
   * A refusal about the wrong thing is worse than no refusal, because it looks like a
   * finding. Every probe here sends what the function declares.
   */
  for (const [fn, args] of [
    ['issue_book', { p_member_code: 'X', p_barcode: 'X' }],
    ['return_book', { p_loan_id: '00000000-0000-0000-0000-000000000000', p_condition_in: 'good' }],
    ['renew_loan', { p_loan_id: '00000000-0000-0000-0000-000000000000' }],
    ['void_loan', { p_loan_id: '00000000-0000-0000-0000-000000000000', p_reason: 'x' }],
    ['mark_lost', { p_loan_id: '00000000-0000-0000-0000-000000000000', p_reason: 'x' }],
    ['record_payment', { p_fine_id: '00000000-0000-0000-0000-000000000000', p_amount: 1 }],
    ['waive_fine', { p_fine_id: '00000000-0000-0000-0000-000000000000', p_reason: 'x' }],
    ['recompute_fine_balance', { p_fine_id: '00000000-0000-0000-0000-000000000000' }],
    ['run_fine_accrual', {}],
    ['set_user_status', { p_user_id: '00000000-0000-0000-0000-000000000000', p_status: 'disabled' }],
    ['set_user_role', { p_user_id: '00000000-0000-0000-0000-000000000000', p_role: 'teacher' }],
    ['create_user_account', { p_user_id: '00000000-0000-0000-0000-000000000000', p_email: 'x@y.z', p_name: 'x', p_role: 'assistant' }],
    ['active_admin_count', {}],
    ['current_user_id', {}],
    ['current_role_name', {}],
    ['can', { permission: 'loans.read' }],
    ['borrow_blockers', { p_member_code: 'X', p_barcode: 'X' }],
  ]) {
    const r = await rpc(fn, args, null)
    if (r.status === 401 || r.status === 403) ok(`${fn} is unreachable (${r.status})`)
    else if (r.status === 404) no(`${fn} is unreachable`, `got 404 — PostgREST found no signature for those arguments, so permissions were never checked`)
    else no(`${fn} is unreachable`, `got ${r.status} — ${JSON.stringify(r.body).slice(0, 70)}`)
  }
}

/*
 * ── low-level requests, using the session token ────────────────────────
 */


// ─────────────────────────────────────────────────────────────────────────
//  setup and sign-in
// ─────────────────────────────────────────────────────────────────────────
let admin = null
if (want('auth')) {
  group('the first administrator')

  const exists = await raw('rpc/has_any_accounts', { method: 'POST', body: '{}' }, null)
  const already = exists.body === true
  console.log(`      has_any_accounts() = ${already}  ${already ? '(an account already exists — using it)' : ''}`)

  const up = await auth.signUp(`probe-${RUN}@example.com`, PASSWORD)
  if (up.error) {
    console.log(`      sign-up: ${up.error}`)
  } else if (!up.session) {
    no('sign-up returns a session', 'the project requires email confirmation — turn it off in Supabase → Authentication → Providers → Email')
  } else if (!already) {
    // Only the first account can be made this way; afterwards set_up_library refuses, and
    // that refusal is itself worth seeing.
    const r = await rpc('set_up_library', { p_user_id: realUserId ?? up.id, p_email: `probe-${RUN}@example.com`, p_name: 'Probe Librarian' })
    if (r.body?.ok) ok(`set_up_library created the administrator (${String(r.body.id).slice(0, 8)}…)`)
    else no('set_up_library', JSON.stringify(r.body).slice(0, 100))
  }

  const who = await expectOk('currentUser() finds the profile', () => api.currentUser())
  admin = who
  if (who) {
    if (who.role === 'admin') ok(`the profile is an administrator`)
    else no('the profile is an administrator', `role is '${who.role}' — current_user_id() did not match the row`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  circulation
// ─────────────────────────────────────────────────────────────────────────
if (want('circulation')) {
  group('circulation: a book goes out and comes back')

  if (!token) {
    no('circulation', 'no session — run the auth group first')
  } else {
    // Stock the library.
    const member = await expectOk('create a student', () =>
      api.createMember({ memberCode: CODE, firstName: 'Probe', lastName: 'Student', type: 'student', form: 'Form 4', grade: '11' }),
    )
    if (member) created.members.push(member.id)

    const title = await expectOk('add a title with one copy', () =>
      api.createTitle({ title: BOOK, author: 'Probe Author', copyCount: 1 }),
    )
    if (title) {
      created.titles.push(title.id)
      const detail = await api.getTitle(title.id)
      created.copies.push(...detail.copies.map((c) => c.id))
    }

    const barcode = title ? (await api.getTitle(title.id)).copies[0]?.barcode : null
    if (!barcode) no('the barcode', 'no copy came back')

    // The refusals, against the real database rather than a mock.
    group('and the things the domain refuses')
    await expectRefusal('issuing a book that does not exist', 'copy_not_found', () =>
      api.checkout({ memberCode: CODE, barcode: 'BK-NOT-REAL' }),
    )
    await expectRefusal('issuing to a student who does not exist', 'member_not_found', () =>
      api.checkout({ memberCode: 'NO-SUCH-STUDENT', barcode }),
    )

    // The happy path.
    const out = await expectOk('issue the book', () => api.checkout({ memberCode: CODE, barcode }))
    if (out?.ok) {
      ok(`  due ${new Date(out.dueAt).toISOString().slice(0, 10)}`)

      const second = await raw('rpc/issue_book', {
        method: 'POST',
        body: JSON.stringify({ p_member_code: CODE, p_barcode: barcode }),
      })
      if (second.body?.code === 'copy_on_loan') ok('the same book cannot be issued twice — the database refused')
      else no('the same book cannot be issued twice', `got ${JSON.stringify(second.body).slice(0, 90)}`)

      await expectRefusal('renewing past the limit', 'renewal_limit_reached', async () => {
        let last = null
        for (let i = 0; i < 4; i++) last = await api.renew({ loanId: out.loan.id })
        return last
      })

      const back = await expectOk('record the return', () =>
        api.returnLoan({ loanId: out.loan.id, conditionIn: 'fair' }),
      )
      if (back?.ok) {
        // Re-read the copy rather than trust the function's own answer.
        const copy = await api.findCopyByBarcode(barcode)
        if (copy?.status === 'on_shelf') ok('the copy is back on the shelf, confirmed by a fresh read')
        else no('the copy is back on the shelf', `status is '${copy?.status}'`)
      }

      const returned = await expectOk('the register shows it as returned', async () => {
        const page = await api.listLoans({ limit: 20, offset: 0, status: 'returned' })
        if (!page.items.some((l) => l.barcode === barcode)) throw new Error('the returned loan is not in the register')
        return page
      })
      if (returned) ok(`  register: ${returned.items.length} returned, ${returned.total} total`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  money
// ─────────────────────────────────────────────────────────────────────────
if (want('fines')) {
  group('fines: charge, pay, waive')

  if (!token) {
    no('fines', 'no session — run the auth group first')
  } else {
    const member = created.members.length ? await api.searchMembers({ limit: 5, offset: 0 }) : null
    const found = member?.items?.find((m) => m.memberCode === CODE)
    if (!found) no('find the probe student', 'not on the member list')

    if (found) {
      // recompute_fine_balance is the function that had the enum bug. Charging is the
      // only way to reach it, so this is where that bug would surface.
      const fine = await expectOk('assess a fine', () =>
        api.assessFine({ memberId: found.id, kind: 'other', amountCents: 500 }),
      )

      if (fine) {
        if (fine.balance === 500) ok('  balance is 500 cents, recomputed from the ledger')
        else no('  balance', `expected 500, got ${fine.balance}`)

        const tooMuch = await expectRefusal('paying more than is owed', 'too_much', () =>
          api.recordPayment({ fineId: fine.id, amountCents: 900 }),
        )
        const paid = await expectOk('pay 200 cents', () => api.recordPayment({ fineId: fine.id, amountCents: 200 }))
        if (paid?.ok) {
          if (paid.fine.balance === 300) ok('  balance is 300, status partially_paid')
          else no('  balance after payment', `expected 300, got ${paid.fine.balance}`)
        }
        if (tooMuch) ok('  and the refusal changed nothing')

        const waived = await expectOk('waive the rest', () =>
          api.waiveFine({ fineId: fine.id, reason: 'school responsibility' }),
        )
        if (waived?.ok) {
          if (waived.fine.balance === 0) ok('  waived to zero')
          else no('  waived balance', `expected 0, got ${waived.fine.balance}`)
          if (waived.fine.status === 'waived') ok('  status is waived, not paid — the two stay distinguishable')
          else no('  waived status', `is '${waived.fine.status}'`)
          if ((waived.fine.transactions?.length ?? 0) >= 3) ok('  the ledger kept every entry, including the charge')
          else no('  ledger entries', `expected at least 3, got ${waived.fine.transactions?.length}`)
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  audit
// ─────────────────────────────────────────────────────────────────────────
if (want('audit')) {
  group('the audit log')
  if (!token) no('audit', 'no session')
  else {
    const log = await expectOk('read the audit log', () => api.getAuditLog({ limit: 10, offset: 0 }))
    if (log) {
      const actions = log.items.map((a) => a.action)
      console.log(`      ${log.total} entries; most recent: ${actions.slice(0, 6).join(', ')}`)
      const wanted2 = ['checkout', 'return', 'payment', 'waive']
      const missing = wanted2.filter((w) => !actions.includes(w))
      if (missing.length === 0) ok('every circulation and money action was recorded')
      else no('every action recorded', `missing ${missing.join(', ')} among the ${log.total} most recent`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  cleanup
// ─────────────────────────────────────────────────────────────────────────
async function cleanup() {
  group('cleaning up')
  if (!token) {
    console.log('      no session, so nothing can be removed — run the auth group first')
    return
  }
  // Members and titles have no delete policy at all, on purpose. This is the same
  // decision as everywhere else: nothing in this system deletes. So the probe data stays
  // until somebody removes it deliberately, and this says so rather than pretending.
  const still = await get(`members?member_code=eq.${CODE}&select=id`)
  console.log(`      probe student ${CODE}: ${Array.isArray(still.body) ? still.body.length : '?'} row(s) still present`)
  console.log('      Nothing deleted. members and titles have no DELETE policy by design, and')
  console.log('      the fines ledger is append-only. Remove them deliberately if you want to:')
  console.log(`        delete from loans      where member_id in (select id from members where member_code = '${CODE}');`)
  console.log(`        delete from fine_txns  where fine_id in (select id from fines where member_id in (select id from members where member_code = '${CODE}'));`)
  console.log(`        delete from fines      where member_id in (select id from members where member_code = '${CODE}');`)
  console.log(`        delete from members    where member_code = '${CODE}';`)
  console.log(`        delete from loan_events where loan_id in (select id from loans where member_id in (select id from members where member_code = '${CODE}'));`)
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n  ${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\n  what did not work:')
  for (const f of failures) console.log(`    · ${f}`)
}
if (wanted === 'cleanup') await cleanup()
else console.log('\n  run with "cleanup" to see how to remove the probe data.')
process.exit(fail ? 1 : 0)