/**
 * The Supabase client, against a stub server.
 *
 * ── What this proves, and what it does not ───────────────────────────
 *
 * This replaces `fetch` with something that returns canned PostgREST responses, so
 * every request this client makes can be inspected and every response it reads can
 * be checked. It proves the half that is ours:
 *
 *   · that a checkout asks the function with the arguments in the right names
 *   · that snake_case from the database arrives as camelCase at the contract
 *   · that a refusal keeps its code and its sentence, and is not an exception
 *   · that a page reads its total out of a header rather than out of the body
 *   · that the anon key is sent, and a session token when there is one
 *
 * It does **not** prove that the database accepts any of it. The SQL has never been
 * run. A policy can be valid and wrong, and a plpgsql function can typecheck in
 * review and fail at runtime. This file is the reason someone can be reasonably
 * confident the bug, if there is one, is on the database side.
 *
 * ── Why it is worth having at all ────────────────────────────────────
 *
 * Because there is no database here. Without this, the client would be 600 lines
 * that nothing has ever executed, and "it typechecks" would be the only thing anyone
 * could say about it.
 */
import { describe, test, expect } from 'vitest'
import { camelize, SupabaseApi, SupabaseRefusal, type SupabaseAuth } from '../api/supabase-api'

/** Everything a stubbed call recorded, so a test can assert on the request. */
interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function stub(responses: { json?: unknown; status?: number; headers?: Record<string, string>; text?: string }[]) {
  const calls: Recorded[] = []
  let at = 0

  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v

    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })

    const r = responses[at++] ?? responses[responses.length - 1] ?? {}
    const status = r.status ?? 200
    return new Response(r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json)), {
      status,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    })
  }

  return { impl, calls }
}



/*
 * One factory rather than eleven inline constructions.
 *
 * `SupabaseConfig` gained an `auth` field and all eleven stopped compiling at once.
 * That is the argument for a factory: a field added to a constructor should be one edit
 * here rather than eleven scattered ones, and the next field will be too.
 *
 * The stub Auth is also what lets auth itself be tested without a project. `token` is
 * the whole difference between "nobody is signed in" and "somebody is", as far as this
 * client is concerned.
 *
 * The token may be a value or a function, because one test needs it to change between
 * requests -- that is the one proving a captured token would have expired, and a factory
 * that only took a value could not express it.
 */
function makeApi(
  token: string | null | (() => string | null) = null,
  overrides: Partial<SupabaseAuth> = {},
): SupabaseApi {
  const read = typeof token === 'function' ? token : () => token
  return new SupabaseApi({
    url: 'https://project.supabase.co',
    anonKey: 'the-anon-key',
    accessToken: async () => read(),
    auth: {
      signUp: async () => ({ id: null, session: false, error: null }),
      signIn: async () => ({ id: null, error: null }),
      signOut: async () => undefined,
      userId: async () => ((await read()) ? 'u_signed_in' : null),
      restore: async () => undefined,
      ...overrides,
    },
  })
}

describe('snake_case becomes camelCase', () => {
  test('at the top level', () => {
    expect(camelize({ member_code: 'S001', checked_out_at: '2026-09-01' })).toEqual({
      memberCode: 'S001',
      checkedOutAt: '2026-09-01',
    })
  })

  test('inside arrays, because loan events are nested', () => {
    // Without this, `loan_events[].created_at` stays snake_case while everything
    // around it is camelCase — and the inconsistency is invisible until a screen
    // renders "undefined" for a date that exists.
    expect(camelize([{ fine_id: 'f_1', created_at: 'x' }])).toEqual([{ fineId: 'f_1', createdAt: 'x' }])
  })

  test('recursively, because the ledger is nested twice', () => {
    expect(camelize({ transactions: [{ actor_user_id: 'u_1' }] })).toEqual({
      transactions: [{ actorUserId: 'u_1' }],
    })
  })

  test('without damaging anything else', () => {
    expect(camelize({ id: 'x', count: 3, on: true, nil: null })).toEqual({
      id: 'x',
      count: 3,
      on: true,
      nil: null,
    })
  })
})

describe('issuing a book', () => {
  test('the arguments are named the way the function declares them', async () => {
    const s = stub([
      { json: { ok: true, loan_id: 'l_1', due_at: '2026-10-04T08:00:00Z' } },
      { json: [{ id: 'l_1', member_id: 'm_1', copy_id: 'c_1', status: 'active' }] },
    ])
    const api = makeApi('session-token')
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.checkout({ memberCode: 'S001', barcode: 'BK-0001' })
      expect(result.ok).toBe(true)

      // `p_member_code`, not `memberCode`. The function's parameter names are the
      // contract, and PostgREST matches on them exactly — a camelCase body would
      // arrive with every argument null and issue nothing at all.
      expect(s.calls[0]!.url).toContain('/rest/v1/rpc/issue_book')
      expect(s.calls[0]!.body).toMatchObject({ p_member_code: 'S001', p_barcode: 'BK-0001' })
    } finally {
      globalThis.fetch = real
    }
  })

  test('a refusal comes back as a value, with its code and its sentence', async () => {
    const s = stub([
      { json: { ok: false, code: 'limit_exceeded', message: 'That student is already at their borrowing limit.', overridable: true } },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.checkout({ memberCode: 'S001', barcode: 'BK-0001' })

      // Not a throw. "That student already has five books out" IS the feature, and
      // throwing it away would force the interface to invent the sentence.
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.refusal).toBe('limit_exceeded')
        expect(result.message).toBe('That student is already at their borrowing limit.')
        expect(result.overridable).toBe(true)
      }
    } finally {
      globalThis.fetch = real
    }
  })

  test('the anon key is sent even with no session, so the sign-in screen can work', async () => {
    const s = stub([{ json: true }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      expect(await api.hasAccounts()).toBe(true)
      expect(s.calls[0]!.headers.apikey).toBe('the-anon-key')
      // No session, so it falls back to the anon key — which the RLS will then
      // correctly refuse everything else.
      expect(s.calls[0]!.headers.Authorization).toBe('Bearer the-anon-key')
    } finally {
      globalThis.fetch = real
    }
  })

  test('a session token is used when there is one, and read fresh each time', async () => {
    let token = 'first-token'
    const s = stub([{ json: true }, { json: true }])
    const api = makeApi(() => token)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      await api.hasAccounts()
      // Refreshed between calls. A token captured once expires, and an expired token
      // produces an RLS refusal that looks exactly like a permissions bug.
      token = 'second-token'
      await api.hasAccounts()
      expect(s.calls[0]!.headers.Authorization).toBe('Bearer first-token')
      expect(s.calls[1]!.headers.Authorization).toBe('Bearer second-token')
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('a page of rows', () => {
  test('the total comes from a header, not the body', async () => {
    // With plain fetch, PostgREST answers `select=*` with a JSON *array* and the
    // count in `Content-Range`. Reading the total out of the body — which is what
    // the first version did, using the supabase-js result shape — gives zero, and
    // "Load more" never appears.
    const s = stub([
      {
        json: [{ member_code: 'S001' }, { member_code: 'S002' }],
        headers: { 'Content-Range': '0-1/137' },
      },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const page = await api.searchMembers({ limit: 2, offset: 0 })
      expect(page.total).toBe(137)
      expect(page.items).toHaveLength(2)
      expect(page.hasMore).toBe(true)
      // And the count was actually asked for.
      expect(s.calls[0]!.headers.Prefer).toContain('count=exact')
    } finally {
      globalThis.fetch = real
    }
  })

  test('hasMore is false on the last page', async () => {
    const s = stub([{ json: [{ id: 'a' }], headers: { 'Content-Range': '0-0/1' } }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const page = await api.searchMembers({ limit: 25, offset: 0 })
      expect(page.hasMore).toBe(false)
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('finding a student', () => {
  test('the admission number is matched exactly, never case-insensitively', async () => {
    const s = stub([{ json: [] }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      expect(await api.findMemberByCode('S001')).toBeNull()
      // `eq.S001`, and never `ilike`. Two codes differing only in case are two
      // students, and issuing to the wrong one is worse than saying no.
      expect(s.calls[0]!.url).toContain('member_code=eq.S001')
      expect(s.calls[0]!.url).not.toContain('ilike')
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('when the database cannot be reached', () => {
  test('the failure is not dressed up as a policy refusal', async () => {
    const s = stub([{ status: 500, text: 'connection refused' }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      // "That student is at their limit" and "the server is down" are different
      // facts. Conflating them tells a librarian the software is refusing them when
      // it cannot reach anything.
      await expect(api.findMemberByCode('S001')).rejects.toThrow(/could not be reached/i)
    } finally {
      globalThis.fetch = real
    }
  })

  test('a 404 says so, rather than claiming the network is down', async () => {
    const s = stub([{ status: 404, text: 'not found' }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      await expect(api.getMember('nope')).rejects.toThrow(/could not be found/i)
    } finally {
      globalThis.fetch = real
    }
  })

  test('the refusal carries a code a caller can branch on', async () => {
    const s = stub([{ status: 500, text: '' }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      await api.findMemberByCode('S001').catch((e) => {
        expect(e).toBeInstanceOf(SupabaseRefusal)
        expect((e as SupabaseRefusal).code).toBe('request_failed')
      })
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('switching a member of staff off', () => {
  test('goes through a function, because a policy cannot say "not yourself"', async () => {
    const s = stub([{ json: { ok: false, code: 'self', message: 'You cannot switch off your own account.' } }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      await expect(api.setUserStatus('u_1', 'disabled')).rejects.toThrow(/your own account/i)
      // A PATCH on the table would be refused by a policy that can only say
      // "an administrator may update users" — and allowing it lets the last
      // administrator lock the school out.
      expect(s.calls[0]!.url).toContain('/rest/v1/rpc/set_user_status')
      expect(s.calls[0]!.method).toBe('POST')
      expect(s.calls[0]!.body).toMatchObject({ p_user_id: 'u_1', p_status: 'disabled' })
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('backup against the live system', () => {
  test('exporting reads every table, not the browser copy', async () => {
    const tables = [
      'users', 'member_types', 'members', 'titles', 'shelf_locations',
      'copies', 'loans', 'holds', 'fines', 'fine_txns', 'imports', 'audit', 'settings',
    ]
    // 13 responses, each a one-row array (settings needs its key/value shape).
    const s = stub(tables.map((t) => ({ json: t === 'settings' ? [{ key: 'k', value: 1 }] : [] })))
    const api = makeApi('session-token')
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const snap = await api.exportBackup()
      // Every table was asked for by name.
      for (const t of tables) {
        expect(s.calls.some((c) => c.url.includes(`/rest/v1/${t}`))).toBe(true)
      }
      expect(snap.settings).toEqual({ k: 1 })
      // The session user is not part of a backup file: it is who is signed in
      // right now, on this device, not something a file should carry.
      expect(Object.keys(snap)).not.toContain('sessionUserId')
    } finally {
      globalThis.fetch = real
    }
  })

  test('putting a copy back is refused with a sentence, not an exception', async () => {
    // No DELETE policies and no client INSERT on loans/fines/fine_txns exist by
    // design, so the live backend cannot "replace everything". The refusal is a
    // value the screen renders — a thrown error would reach the desk as an
    // unexpected failure rather than an explanation.
    const api = makeApi(null)
    const result = await api.importBackup({ users: [], members: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal).toBe('restore_refused')
      expect(result.message).toMatch(/copy to keep/i)
    }
  })
})

/*
 * One student's borrowing history.
 *
 * The `loans` table holds ids — who and which copy — and none of the columns a
 * person reads off a line: no name, no title, no book number. Until the join
 * existed, `listLoans` cast the raw table to the register row, so on the live
 * system every row rendered `undefined` for all four. The history screen is
 * where that shows up first, and the register right behind it.
 */
describe('one student’s borrowing history', () => {
  test('filters to the member, honours the page, and joins what the table has not got', async () => {
    const s = stub([
      // 1. the loans page: ids and dates only.
      {
        json: [
          {
            id: 'l_1',
            member_id: 'm_1',
            copy_id: 'c_1',
            status: 'returned',
            checked_out_at: '2026-09-01T09:00:00.000Z',
            due_at: '2026-09-15T09:00:00.000Z',
            returned_at: '2026-09-10T09:00:00.000Z',
            void_reason: null,
          },
        ],
        headers: { 'Content-Range': '0-0/3' },
      },
      // 2. and 3. the members and copies behind that page's ids.
      {
        json: [
          {
            id: 'm_1',
            member_code: 'S001',
            first_name: 'Kept',
            last_name: 'Student',
            form: 'Form 4',
            stream: null,
            grade: null,
            class_name: null,
          },
        ],
      },
      { json: [{ id: 'c_1', barcode: 'BK-1', status: 'on_shelf', title_id: 't_1' }] },
      // 4. and the titles behind those copies.
      { json: [{ id: 't_1', title: 'Things We Carry', author: 'Tim O’Brien' }] },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.listLoans({ memberId: 'm_1', status: 'all', limit: 25, offset: 0 })
      const asked = decodeURIComponent(s.calls[0]!.url)

      // The member filter reaches the table. Without it "their history" would be
      // everybody's loans with the others filtered off after the page was cut.
      expect(asked).toContain('member_id=eq.m_1')
      // The page is honoured rather than a hardcoded first 200 rows.
      expect(asked).toContain('limit=25')
      expect(asked).toContain('offset=0')
      // Newest first, tiebroken on the id so two loans taken in the same minute
      // cannot land on both sides of a page boundary.
      expect(asked).toContain('order=checked_out_at.desc,id.desc')

      // The total comes from Content-Range, so "3 in all" survives the join.
      expect(result.total).toBe(3)
      expect(result.hasMore).toBe(true)
      // And the row carries what the paper register carries.
      expect(result.items[0]).toMatchObject({
        memberCode: 'S001',
        studentName: 'Kept Student',
        title: 'Things We Carry',
        author: 'Tim O’Brien',
        barcode: 'BK-1',
        copyStatus: 'on_shelf',
        status: 'returned',
        daysOverdue: 0,
      })

      // The join's two rounds: members and copies together, then titles.
      expect(decodeURIComponent(s.calls[1]!.url)).toContain('members?')
      expect(decodeURIComponent(s.calls[1]!.url)).toContain('id=in.(m_1)')
      expect(decodeURIComponent(s.calls[2]!.url)).toContain('copies?')
      expect(decodeURIComponent(s.calls[3]!.url)).toContain('titles?')
      expect(decodeURIComponent(s.calls[3]!.url)).toContain('id=in.(t_1)')
    } finally {
      globalThis.fetch = real
    }
  })

  test('no loans is one read, not four', async () => {
    const s = stub([{ json: [], headers: { 'Content-Range': '0-0/0' } }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.listLoans({ memberId: 'm_new', status: 'all', limit: 25, offset: 0 })
      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
      // Fetching members for an empty id list would ask the database for
      // `in.()` — a malformed filter, and an error for a student with no loans.
      expect(s.calls).toHaveLength(1)
    } finally {
      globalThis.fetch = real
    }
  })
})

/*
 * The register's free-text search, on the live database.
 *
 * `loans` holds no name, no title, no book number, so "Kept carry" cannot be a
 * filter on the table — and it used to be no filter at all: the query's `q` was
 * dropped, the search silently returned every row, and every total on screen
 * was a count of nothing that was typed. Each word is now resolved to the
 * members, copies and titles it reaches, and the loans are asked for by id —
 * with the page and the count still the database's.
 */
describe('the register’s search on the live database', () => {
  test('resolves each word to ids, then pages the loans that carry them all', async () => {
    const s = stub([
      // "kept": members, copies, titles — only the name matches.
      { json: [{ id: 'm_1' }] },
      { json: [] },
      { json: [] },
      // "carry": members, copies, titles — only the title matches…
      { json: [] },
      { json: [] },
      { json: [{ id: 't_1' }] },
      // …so its copies are read off that title.
      { json: [{ id: 'c_1' }] },
      // The page of loans itself.
      {
        json: [
          {
            id: 'l_1',
            member_id: 'm_1',
            copy_id: 'c_1',
            status: 'active',
            checked_out_at: '2026-10-01T09:00:00.000Z',
            due_at: '2026-10-15T09:00:00.000Z',
            returned_at: null,
            void_reason: null,
          },
        ],
        headers: { 'Content-Range': '0-0/7' },
      },
      // And the join's members, copies and titles for that page.
      { json: [{ id: 'm_1', member_code: 'S001', first_name: 'Kept', last_name: 'Student', form: 'Form 4', stream: null, grade: null, class_name: null }] },
      { json: [{ id: 'c_1', barcode: 'BK-1', status: 'on_shelf', title_id: 't_1' }] },
      { json: [{ id: 't_1', title: 'Things We Carry', author: 'Tim O’Brien' }] },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.listLoans({ status: 'all', q: 'Kept carry', limit: 25, offset: 0 })

      // Both words reached the tables they live on: the name asked of members,
      // the title asked of titles — not only whichever column matched first.
      // The case travels as typed; `ilike` is what makes it not matter.
      expect(decodeURIComponent(s.calls[0]!.url)).toContain('first_name.ilike.*Kept*')
      expect(decodeURIComponent(s.calls[5]!.url)).toContain('title.ilike.*carry*')

      // The loans read carries one group per word, ANDed: a row must put every
      // word on the same line — this student, their copy of that title.
      const loansUrl = decodeURIComponent(s.calls[7]!.url)
      expect(loansUrl).toContain('and=(or=(member_id=in.(m_1)),or=(copy_id=in.(c_1)))')
      expect(loansUrl).toContain('limit=25')
      expect(loansUrl).toContain('offset=0')

      // The count is the database's: seven rows carry both words, one of them
      // is on this page — which is the number the pager shows.
      expect(result.total).toBe(7)
      expect(result.hasMore).toBe(true)
      expect(result.items[0]).toMatchObject({ memberCode: 'S001', title: 'Things We Carry' })
    } finally {
      globalThis.fetch = real
    }
  })

  test('a word nothing matches ends the search without reading the loans', async () => {
    const s = stub([{ json: [] }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.listLoans({
        status: 'all',
        q: 'nothing like this',
        limit: 25,
        offset: 0,
      })
      // An empty page, not an error, and not every loan in the school.
      expect(result).toEqual({ items: [], total: 0, limit: 25, offset: 0, hasMore: false })
      // The loans table is never asked: one unmatched word settles the whole
      // question, and reading the rows to filter them here would put the total
      // back where it was — a count of everything, showing nothing.
      expect(s.calls.some((c) => c.url.includes('/loans?'))).toBe(false)
    } finally {
      globalThis.fetch = real
    }
  })
})

/*
 * The audit log, on the live database.
 *
 * `audit` answers "who did what and why" and it is read newest-first. The page
 * goes through `camelize` at the boundary like everything else, so `entity_id`
 * and `created_at` arrive as the contract's `entityId` and `createdAt`; the
 * only translation left to the method is the query's own filters.
 */
describe('the audit log on the live database', () => {
  test('asks newest-first and maps the snake_case columns', async () => {
    const s = stub([
      {
        json: [
          {
            id: 'a_1',
            actor: 'u_1',
            action: 'void',
            entity: 'loan',
            entity_id: 'l_9',
            before: { status: 'active' },
            after: { status: 'void', reason: 'returned to stock' },
            created_at: '2026-10-06T08:00:00.000Z',
          },
        ],
        headers: { 'Content-Range': '0-0/12' },
      },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.getAuditLog({ limit: 25, offset: 0 })

      const asked = decodeURIComponent(s.calls[0]!.url)
      expect(asked).toContain('audit?')
      // A log opens on the most recent act, the way the register opens on the
      // newest loan.
      expect(asked).toContain('order=created_at.desc')
      expect(asked).toContain('limit=25')
      expect(asked).toContain('offset=0')

      // The total comes from Content-Range, the columns from camelize.
      expect(result.total).toBe(12)
      expect(result.hasMore).toBe(true)
      expect(result.items[0]).toMatchObject({
        actor: 'u_1',
        action: 'void',
        entity: 'loan',
        entityId: 'l_9',
        before: { status: 'active' },
        after: { status: 'void', reason: 'returned to stock' },
        createdAt: '2026-10-06T08:00:00.000Z',
      })
    } finally {
      globalThis.fetch = real
    }
  })

  test('narrows by entity and action when the screen asks', async () => {
    const s = stub([{ json: [], headers: { 'Content-Range': '0-0/0' } }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const result = await api.getAuditLog({ limit: 25, offset: 0, entityType: 'loan', action: 'void' })
      expect(result.items).toEqual([])

      const asked = decodeURIComponent(s.calls[0]!.url)
      expect(asked).toContain('entity=eq.loan')
      expect(asked).toContain('action=eq.void')
    } finally {
      globalThis.fetch = real
    }
  })
})

/*
 * Holds, on the live database.
 *
 * There is no RPC for a hold: the table is written and read directly through
 * REST, behind `holds.write`. These tests are the contract for that wire
 * shape — the snake_case columns, the open-only queue in placement order, and
 * the two verbs that sit on the same table.
 */
describe('holds against the live database', () => {
  test('the queue asks for open holds only, in placement order, and maps the columns', async () => {
    const s = stub([
      {
        json: [
          {
            id: 'h_1',
            member_id: 'm_2',
            title_id: 't_1',
            placed_at: '2026-10-01T08:00:00.000Z',
            copy_id: null,
            expires_at: null,
            status: 'open',
          },
        ],
      },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const queue = await api.getHoldQueue('t_1')

      const asked = decodeURIComponent(s.calls[0]!.url)
      expect(asked).toContain('/holds?')
      expect(asked).toContain('title_id=eq.t_1')
      expect(asked).toContain('status=eq.open')
      expect(asked).toContain('order=placed_at')

      expect(queue[0]).toMatchObject({
        id: 'h_1',
        memberId: 'm_2',
        titleId: 't_1',
        placedAt: '2026-10-01T08:00:00.000Z',
        status: 'open',
      })
    } finally {
      globalThis.fetch = real
    }
  })

  test('placing a hold is a POST to the table, with the columns the table has', async () => {
    const s = stub([{ json: [] }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      await api.placeHold({ memberId: 'm_2', titleId: 't_1' })

      const [first] = s.calls
      expect(first!.method).toBe('POST')
      // A raw insert carries no query string; the row goes in the body.
      expect(decodeURIComponent(first!.url)).toMatch(/\/rest\/v1\/holds$/)
      // `snakeize` at the boundary: a raw insert cannot send camelCase columns.
      expect(first!.body).toEqual({ member_id: 'm_2', title_id: 't_1', status: 'open' })
    } finally {
      globalThis.fetch = real
    }
  })

  test('cancelling a hold is a PATCH, and the re-read asks for the one row', async () => {
    const s = stub([
      { json: [] },
      { json: [{ id: 'h_1', member_id: 'm_2', title_id: 't_1', status: 'cancelled' }] },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const cancelled = await api.cancelHold('h_1')

      const [patch, reread] = s.calls
      expect(patch!.method).toBe('PATCH')
      expect(decodeURIComponent(patch!.url)).toContain('/holds?')
      expect(decodeURIComponent(patch!.url)).toContain('id=eq.h_1')
      expect(patch!.body).toEqual({ status: 'cancelled' })
      // The re-read (`one`) asks for the one row by id, with every column.
      expect(decodeURIComponent(reread!.url)).toMatch(/holds\?.*select=\*.*id=eq\.h_1/)

      expect(cancelled).toMatchObject({ id: 'h_1', status: 'cancelled' })
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('the dashboard', () => {
  test('comes from one function, and the snake_case figures land camelCase', async () => {
    const s = stub([
      {
        json: {
          ok: true,
          total_titles: 3,
          total_copies: 12,
          on_loan: 4,
          overdue: 1,
          outstanding_fines: 2500,
          active_members: 41,
        },
      },
    ])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      const d = await api.getDashboard()

      expect(s.calls[0]!.url).toContain('/rest/v1/rpc/get_dashboard')
      expect(s.calls[0]!.method).toBe('POST')

      expect(d).toEqual({
        totalTitles: 3,
        totalCopies: 12,
        onLoan: 4,
        overdue: 1,
        outstandingFines: 2500,
        activeMembers: 41,
      })
    } finally {
      globalThis.fetch = real
    }
  })

  test('a refused function keeps its sentence and is not thrown as a raw response', async () => {
    const s = stub([{ json: { ok: false, message: 'Your role cannot run the library figures.' } }])
    const api = makeApi(null)
    const real = globalThis.fetch
    globalThis.fetch = s.impl as never
    try {
      await expect(api.getDashboard()).rejects.toThrow(/your role cannot run the library figures/i)
    } finally {
      globalThis.fetch = real
    }
  })
})