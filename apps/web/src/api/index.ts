/**
 * THE SEAM.
 *
 * Everything in the interface imports `api` from here and nothing else. No
 * feature imports a backend, imports `fetch`, or knows how records are stored.
 * Switching where the records live is a change to this file and nowhere else.
 *
 * That is what makes it safe to start in the browser with no infrastructure and
 * move to a real backend later: the screens never learn that it happened.
 */

import type { LibraryApi } from '@library/contracts'
import { MockApi } from './mock'

/**
 * Where the records come from.
 *
 * `mock` keeps everything in the browser. `supabase` is the real one, and it is
 * not implemented yet — this build is the frontend, deliberately, before the
 * database. Asking for it fails loudly rather than falling back, because a
 * silent fallback looks exactly like a working register.
 */
export type Mode = 'mock' | 'supabase'

/**
 * Read once, at module load.
 *
 * `import.meta.env` is replaced at build time, so a value that is not set cannot
 * be read lazily - which is why this is a constant and not a function. It also
 * means a mode that is compiled in cannot be changed at runtime, and pretending
 * otherwise produces an app that half-believes it has a backend.
 */
const mode = (import.meta.env.VITE_API_MODE as Mode | undefined) ?? 'mock'

/*
 * Refuse to guess.
 *
 * If `supabase` is asked for and the credentials are missing, this throws at
 * module load rather than falling back to the mock. The fallback is the exact
 * failure this project has already had once: the app loads, looks completely
 * healthy, and quietly keeps every record in one browser tab. A person would
 * type a term of borrowings into it and believe it was saved.
 */
if (false) {
  throw new Error(
    'VITE_API_MODE=supabase needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. ' +
      'Refusing to fall back to the mock, because the mock looks exactly like a ' +
      'working register and is not one.',
  )
}

const mock = new MockApi()

/*
 * The mock is the only implementation so far, because this is the frontend and
 * the database comes next. The seam is the single place that changes: when
 * `supabase-api.ts` exists, this becomes
 *
 *     mode === 'supabase' ? new SupabaseApi({ url, anonKey }) : mock
 *
 * and nothing above this line changes.
 *
 * Until then, asking for `supabase` throws here rather than quietly using the
 * mock. That failure is the point: a build configured for the real backend and
 * silently running on a browser tab is a register that empties on reload and
 * looks fine until somebody has typed a term into it.
 */
if (mode === 'supabase') {
  throw new Error(
    'VITE_API_MODE=supabase is not available in this build. The database has not ' +
      'been built yet - see the seam in src/api/index.ts, which is the one place that ' +
      'changes when it is. Refusing to fall back to the mock, because a mock register ' +
      'looks exactly like a real one.',
  )
}

const base: LibraryApi = mock

/**
 * Local mirroring, for the mock only.
 *
 * A real backend is the system of record, and copying its state into
 * localStorage would create a second source of truth that can disagree with it —
 * which is the one thing a shared register must not have.
 *
 * The check is `mode === 'mock'` and not `mode !== 'supabase'`: a mode added
 * later must not inherit mirroring by accident.
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
 * A function as well as a value, so both wordings are testable without building
 * the bundle twice.
 *
 * The wording names the school and never the vendor. "Stored in Supabase" is
 * true and useless to a librarian, who does not know what Supabase is and cannot
 * act on it. The sentence has one job — your records are not in this browser, so
 * clearing your browser will not lose them — and a product name buried it.
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
      // A full or disabled localStorage must not stop somebody issuing a book.
      // The session is the thing being recorded; mirroring is a convenience.
    }
  }

  // Restore first, so a reload does not silently empty the register in front of
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

  return {
    api,
    handle: { flush },
  }
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