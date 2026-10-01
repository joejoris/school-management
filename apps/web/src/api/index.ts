/**
 * THE SEAM.
 *
 * Everything in the interface imports `api` from here and nothing else. No feature
 * imports a backend, imports `fetch`, or knows how records are stored. Switching
 * where the records live is a change to this file and nowhere else.
 *
 * ── Two modes, and refusing to fall back ─────────────────────────────
 *
 * \`mock\`   the in-memory domain, mirrored into localStorage. Works with no
 *           infrastructure at all, which is what makes the frontend buildable and
 *           reviewable on its own.
 * \`supabase\` the real thing: Postgres, Auth and RLS, reached from the browser.
 *
 * If \`supabase\` is asked for and the credentials are missing, this throws at module
 * load rather than falling back. The fallback is the exact failure worth avoiding:
 * the app loads, looks completely healthy, and quietly keeps every record in one
 * browser tab. Somebody would type a term of borrowings into it and believe it was
 * saved.
 *
 * ── The token is read fresh on every request ─────────────────────────
 *
 * \`accessToken()\` calls into the Supabase client each time rather than capturing a
 * token once. A captured token expires, and an expired token produces an RLS refusal
 * that looks exactly like a permissions bug — which is a genuinely confusing thing
 * to debug hours later.
 *
 * ── What this file is not ───────────────────────────────────────────
 *
 * It is not a place for policy. The permissions table lives in
 * \`@library/contracts\` and is enforced again in SQL; a third copy here would be a
 * third thing to keep in step with the other two.
 */
import type { LibraryApi } from '@library/contracts'
import { MockApi } from './mock'
import { SupabaseApi } from './supabase-api'

export type Mode = 'mock' | 'supabase'

const mode = (import.meta.env.VITE_API_MODE as Mode | undefined) ?? 'mock'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

const missing: string[] = []
if (mode === 'supabase') {
  if (!supabaseUrl) missing.push('VITE_SUPABASE_URL')
  if (!supabaseAnonKey) missing.push('VITE_SUPABASE_ANON_KEY')
}

if (missing.length > 0) {
  throw new Error(
    `VITE_API_MODE=supabase needs ${missing.join(' and ')}. ` +
      'Refusing to fall back to the mock, because a mock register looks exactly like a ' +
      'working one and is not one.',
  )
}

const mock = new MockApi()

/**
 * The live client.
 *
 * Built with a dynamic import so a mock build does not carry the Supabase library —
 * which is about a hundred kilobytes that a school on a slow connection should not
 * download to read books that were never issued.
 *
 * The module is therefore async, and everything that needs `api` awaits `ready()`
 * once at start-up. A top-level await here would make this module asynchronous and
 * leave every `import { api }` in the app depending on module resolution order,
 * which fails as a blank screen rather than as an error.
 */
let resolved: LibraryApi | null = null

if (mode === 'supabase') {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: { persistSession: true, autoRefreshToken: true },
  })
  resolved = new SupabaseApi({
    url: supabaseUrl!,
    anonKey: supabaseAnonKey!,
    accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
  })
} else {
  resolved = mock
}

const base: LibraryApi = resolved

/**
 * Local mirroring, for the mock only.
 *
 * A real backend is the system of record, and copying its state into localStorage
 * would create a second source of truth that can disagree with it — the one thing a
 * shared register must not have.
 *
 * The check is \`mode === 'mock'\` and not \`mode !== 'supabase'\`: a mode added later
 * must not inherit mirroring by accident.
 */
const persistence = mode === 'mock' ? installLocalMirror(base, mock) : null

export const api: LibraryApi = persistence?.api ?? base

/** For dev tooling and tests. Not for feature code. */
export const __mock = mock
export const __mode = mode

/**
 * Where the records are, in one sentence, for the screens that have to be honest
 * about it.
 *
 * The wording names the school and never the vendor. "Stored in Supabase" is true
 * and useless to a librarian, who does not know what Supabase is and cannot act on
 * it. The sentence has one job — your records are not in this browser, so clearing
 * your browser will not lose them — and a product name buried it.
 */
export const storageNoteFor = (m: Mode): string =>
  m === 'mock'
    ? 'This is a practice copy. Records are kept in this browser only, so clearing your browser data deletes them.'
    : 'Your records are kept on the school’s system, not in this browser. Clearing your browser data will not lose them, and you can sign in from any device.'

export const storageNote = storageNoteFor(mode)

/** Mirrors the mock's state into localStorage, debounced. */
function installLocalMirror(target: LibraryApi, source: MockApi) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let handle: (() => void) | undefined

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => handle?.(), 400)
  }
  handle = () => {
    try {
      localStorage.setItem('library-local:v1', JSON.stringify(source.exportState()))
    } catch {
      // A full or disabled localStorage must not stop somebody issuing a book. The
      // session is the thing being recorded; mirroring is a convenience.
    }
  }

  // Restored first, so a reload does not silently empty the register in front of
  // whoever is using it.
  try {
    const saved = localStorage.getItem('library-local:v1')
    if (saved) source.importState(JSON.parse(saved))
  } catch {
    // Unreadable: start empty rather than refusing to run.
  }

  // Proxied rather than wrapped in a class, so the proxy handle cannot shadow a
  // method name on the object it wraps.
  const api = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver)
      if (typeof value !== 'function' || prop === 'exportState') return value
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(obj, args)
        if (out instanceof Promise) return out.then((r) => (schedule(), r))
        schedule()
        return out
      }
    },
  })

  const flush = () => {
    clearTimeout(timer)
    handle?.()
  }

  return { api, handle: { flush } }
}

/** Forgets the mirror and reloads. How you recover from an unreadable copy. */
export function resetLocalMirror(): void {
  try {
    localStorage.removeItem('library-local:v1')
  } catch {
    /* nothing to do */
  }
  location.reload()
}