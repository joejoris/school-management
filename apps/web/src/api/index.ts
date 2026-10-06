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
import { SupabaseApi, type SupabaseAuth } from './supabase-api'

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
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The app has its own sign-in and sign-up screens and its own words for what
      // went wrong. Supabase's built-in screens and its generic messages would replace
      // both with something a librarian cannot act on.
      //
      // It also matters here: the redirect URL would have to be configured in the
      // Supabase project for the built-in flow to work at all, and this way there is
      // nothing to configure and nothing to get wrong.
      flowType: 'implicit',
    },
  })

  /**
   * Supabase Auth, in the four methods `SupabaseAuth` asks for.
   *
   * The errors are rewritten here rather than passed through. Supabase says
   * "Invalid login credentials", which is accurate and tells a librarian nothing about
   * which of the two things they got wrong — and in a school, guessing which is the
   * difference between trying the other password and asking for help.
   */
  const auth: SupabaseAuth & {
    tokens: () => Promise<{ access_token: string; refresh_token: string } | null>
  } = {
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password })
      if (error) {
        /*
         * "There is already an account with that address" is the one case worth naming,
         * because the action is different: they need to sign in, not try again.
         *
         * Matching Supabase's wording is fragile, and it was wrong here. The pattern was
         * /already registered|already exists/, and Supabase actually says
         *
         *   "A user with this email address has already been registered"
         *
         * -- with "been" in the middle. So the first alternative did not match, the
         * message fell through to the generic "That address could not be registered",
         * and a librarian who had just created an account was told the opposite.
         *
         * Two changes, because one is not enough on its own:
         *
         *   · the structured `code` is checked first. Supabase sends
         *     `user_already_exists` / `email_exists`, which are stable identifiers and do
         *     not change with a rewording of the sentence.
         *   · the text fallback then matches on `already` alone. Within a *sign-up* error,
         *     "already" means a duplicate and nothing else, and a loose match is right where
         *     a precise one is brittle.
         */
        const code = (error as { code?: string }).code ?? ''
        const isDuplicate =
          /^(user_already_exists|email_exists)$/i.test(code) || /\balready\b/i.test(error.message ?? '')

        if (isDuplicate) {
          return { id: null, session: false, error: 'There is already an account with that address. Sign in instead.' }
        }

        /*
         * Everything else, named.
         *
         * These were all reported as "That address could not be registered", which is
         * worse than useless: it is the one thing that did NOT happen, and it gives a
         * librarian no idea which of the real causes to act on. Four of them are common
         * enough on a fresh project to be worth a sentence each.
         *
         * Matched on Supabase's own wording, so the list is a guess about a string rather
         * than a contract -- which is why the raw message is logged underneath. If a case
         * is not listed here it still logs; it just falls back to the generic sentence.
         */
        const why = error.message ?? ''
        if (/password should be at least|password is too weak|at least \d characters/i.test(why)) {
          return { id: null, session: false, error: 'That password is too short or too simple.' }
        }
        if (/signups not allowed|not allowed|signup.*disabled/i.test(why)) {
          return {
            id: null,
            session: false,
            error: 'New accounts are turned off for this library. Ask the head librarian to create yours.',
          }
        }
        if (/rate limit|too many requests|security purposes/i.test(why)) {
          return {
            id: null,
            session: false,
            error: 'Too many attempts from this device. Wait a few minutes and try once more.',
          }
        }
        if (/email.*(invalid|not valid|disposable|blocked)/i.test(why)) {
          return { id: null, session: false, error: 'Supabase will not accept that email address.' }
        }

        // The raw reason is logged, always. The next version of this list should come
        // from there rather than from another guess.
        console.warn('[supabase] sign-up refused:', why, error.status)
        return { id: null, session: false, error: 'That address could not be registered.' }
      }
      return { id: data.user?.id ?? null, session: Boolean(data.session), error: null }
    },

    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      if (error) {
        /*
         * Wrong-password and unknown-address share one sentence on purpose: telling a
         * caller which of the two it was is worth having to somebody probing for valid
         * addresses, and worth nothing to the person at the desk.
         *
         * Two other causes were being folded into that same sentence, and both are the
         * librarian's own mistake rather than an attack, so naming them helps and leaks
         * nothing:
         *
         *   · an address that has never been confirmed — Supabase refuses to issue a
         *     session, and the sentence said the password was wrong, which sends people
         *     retyping a password that was always correct.
         *   · the project asking for a CAPTCHA or a rate limit, which is a "not now"
         *     rather than a "not ever".
         */
        const why = error.message ?? ''

        if (/email not confirmed|not confirmed/i.test(why)) {
          return {
            id: null,
            error:
              'Open the confirmation link we sent you, then sign in. Ask the head librarian if you cannot find it.',
          }
        }
        if (/rate limit|too many requests|security purposes|captcha/i.test(why)) {
          return { id: null, error: 'Too many attempts from this device. Wait a few minutes and try once more.' }
        }
        if (/fetch|network|failed to fetch/i.test(why)) {
          return { id: null, error: 'Could not reach the library system. Check the connection and try again.' }
        }

        return { id: null, error: 'That email and password do not match.' }
      }
      return { id: data.user?.id ?? null, error: null }
    },

    async signOut() {
      // Clears the local session even if the network call fails, which is what somebody
      // signing out at the desk means. A failure here must not leave them apparently
      // still signed in on a shared machine.
      await client.auth.signOut().catch(() => undefined)
    },

    async userId() {
      const { data } = await client.auth.getSession()
      return data.session?.user?.id ?? null
    },

    async restore(accessToken, refreshToken) {
      const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      if (error) {
        // The administrator's session expired while they were typing somebody else's
        // details in. Telling them so is better than letting every subsequent request
        // fail with a permission error they cannot interpret.
        throw new Error('Your session expired. Sign in again.')
      }
    },

    async tokens() {
      const { data } = await client.auth.getSession()
      const s = data.session
      if (!s) return null
      return { access_token: s.access_token, refresh_token: s.refresh_token }
    },
  }

  resolved = new SupabaseApi({
    url: supabaseUrl!,
    anonKey: supabaseAnonKey!,
    accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
    auth,
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