import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Prove the guards fail when the code breaks.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * A test that has never been seen to fail is not known to work. It can be
 * asserting the wrong selector, matching a substring that is never there, or
 * passing because the assertion sits in a block that never runs — and all three
 * look identical to a passing suite.
 *
 * So each guard below is broken on purpose, the suite is run, and the guard is
 * required to fail. A guard that still passes against broken code is worse than
 * no guard, because it is trusted.
 *
 * ── A broken harness must not look like a broken guard ───────────────
 *
 * This file was first written using `execFileSync('npx', ...)`. On Windows a
 * bare `npx` is `ENOENT`, every spawn failed, and all five guards were reported
 * as "the guard did NOT fail" — a result that reads like five bad assertions and
 * was in fact nothing running at all.
 *
 * That is the dangerous failure mode: a check that reports confidently while
 * measuring nothing. So the spawn error is now separated from the test failure,
 * and a command that cannot be started is a hard stop, never a verdict.
 *
 * Run with `npm run prove`.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROUTES = join(root, 'apps/web/src/routes.tsx')
const FORM = join(root, 'apps/web/src/features/issues/RecordIssue.tsx')
const GATE = join(root, 'apps/web/src/features/auth/AuthLayout.tsx')
const SCHOOL = join(root, 'packages/contracts/src/school.ts')
const SHELL = join(root, 'apps/web/src/shell.tsx')

/**
 * Run the suite by invoking the installed vitest entry point with this node.
 *
 * Not `npx`, and not `npm run` — both resolve to a `.cmd` shim on Windows and
 * neither is spawnable as a bare command. `process.execPath` plus the package's
 * own entry point works the same on every platform and does not depend on a
 * shell being present.
 */
const VITEST = join(root, 'node_modules/vitest/vitest.mjs')

function runTests() {
  if (!existsSync(VITEST)) {
    throw new Error(
      `Cannot find ${VITEST}. The suite was never started, so no verdict below is real. ` +
        'Run `npm install` first.',
    )
  }
  try {
    const out = execFileSync(process.execPath, [VITEST, 'run', '--root', 'apps/web'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: false,
    })
    return { ok: true, output: String(out) }
  } catch (e) {
    // A non-zero exit means the suite ran and something failed. An ENOENT here
    // would mean it did not run — and that is deliberately not folded in with a
    // test failure.
    //
    // Plain `.mjs`, so no TypeScript: this file is run by node directly, not
    // built, and a type assertion here would be a syntax error rather than a
    // type error.
    const err = e
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      throw new Error(`Could not start the test suite at all (${err.code}). No verdict below is real.`)
    }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** Confirmed once, up front, while the working tree is still known-good. */
const sanity = runTests()
if (!sanity.ok) {
  console.error('The suite does not pass before anything is broken. Fix that first.\n')
  console.error(sanity.output.split('\n').slice(-20).join('\n'))
  process.exit(1)
}
console.log(`  · the suite passes before anything is broken (${testsRun(sanity.output)})`)

function testsRun(output) {
  const m = output.replace(/\u001b\[[0-9;]*m/g, '').match(/Tests\s+(\d+ passed)/)
  return m ? m[1] : 'count unknown'
}

/** Each break: an exact string, its replacement, and the guard that must fail. */
const BREAKS = [
  {
    what: 'the landing route redirects to itself',
    /*
     * Not hypothetical. This was written once, and the symptom was a blank page
     * with no error anywhere: the router resolves `/`, the loader redirects to
     * `/`, the loader runs again, forever.
     */
    file: ROUTES,
    from: `  path: '/',
  component: RecordIssue,`,
    to: `  path: '/',
  beforeLoad: () => {
    throw new Error('redirect to /')
  },
  component: RecordIssue,`,
    mustFail: '/ is the entry form, and it is rendered there directly',
  },
  {
    what: 'a dashboard is put back in front of the entry form',
    file: GATE,
    file: ROUTES,
    from: `  path: '/',
  component: RecordIssue,`,
    to: `  path: '/',
  component: () => (
    <div>
      <h1>Books on loan</h1>
      <RecordIssue />
    </div>
  ),`,
    mustFail: 'there is no dashboard in front of the entry form',
  },
  {
    what: 'the unknown-path catch-all silently redirects to /',
    file: ROUTES,
    from: `  path: '/$',
  component: () => (`,
    to: `  path: '/$',
  beforeLoad: () => {
    throw new Error('redirect to /')
  },
  component: () => (`,
    mustFail: 'an unknown path says so rather than silently landing on the entry form',
  },
  {
    what: 'a failed record clears the form',
    file: FORM,
    from: `      setSaved(null)
      setError(e instanceof Error ? e.message : 'Could not record that.')`,
    to: `      setSaved(null)
      setDraft(emptyDraft())
      setError(e instanceof Error ? e.message : 'Could not record that.')`,
    mustFail: 'a failed record keeps what was typed',
  },
  {
    /*
     * The gate is moved below the chrome, which is the same defect as the one
     * above in a different place: the sidebar would wrap the sign-in screen again,
     * and every link on it would be a promise the domain refuses while signed out.
     */
    what: 'the sidebar is rendered even when nobody is signed in',
    file: GATE,
    from: `    return <SetupPanel firstRun={accounts.data !== true} onSignedIn={onSignedIn} />`,
    to: `    return <Shell />`,
    mustFail: 'signed out, there is no navigation at all',
  },
  {
    /*
     * The school's own lists, emptied.
     *
     * Worth proving separately from the other enrolment breaks because the failure
     * is invisible rather than loud: a missing Form or Grade suggestion still looks
     * like a working dropdown, it just offers nothing, and a librarian finds out
     * when the term starts.
     */
    what: 'the form suggestion list is emptied',
    file: SCHOOL,
    from: `export const FORM_SUGGESTIONS = ['Form 3', 'Form 4'] as const`,
    to: `export const FORM_SUGGESTIONS = [] as unknown as readonly ['Form 3', 'Form 4']`,
    mustFail: 'form suggests Form 3 and Form 4, and nothing else',
  },
  {
    what: 'the grade list gains a year the school does not run',
    file: SCHOOL,
    from: `export const GRADE_SUGGESTIONS = ['10', '11', '12'] as const`,
    to: `export const GRADE_SUGGESTIONS = ['10', '11', '12', '13'] as const`,
    mustFail: 'grade suggests 10, 11 and 12, and nothing else',
  },
  {
    what: 'a suggestion list is put back on the stream field',
    file: FORM,
    from: `                    placeholder="Red Stream"
                    autoComplete="off"`,
    to: `                    placeholder="Red Stream"
                    autoComplete="off"
                    list="stream-suggestions"`,
    mustFail: 'stream is free text with no suggestions at all',
  },
  {
    what: 'the Class field comes back',
    file: FORM,
    from: `                  <datalist id="form-suggestions">`,
    to: `                  {/* Injected by tools/prove-guards.mjs to prove the Class guard. */}
                  <Field label="Class" htmlFor="className">
                    <Input id="className" />
                  </Field>
                  <datalist id="form-suggestions">`,
    mustFail: 'there is no Class field',
  },
  {
    what: 'the submit button is enabled with an empty form',
    file: FORM,
    from: `  const canSubmit = draft.memberCode.trim().length > 0 && draft.barcode.trim().length > 0`,
    to: `  const canSubmit = true`,
    mustFail: 'the submit button is unavailable until there is something to record',
  },
]

let wrong = 0
for (const b of BREAKS) {
  const original = readFileSync(b.file, 'utf8')
  if (!original.includes(b.from)) {
    console.log(`  ?  ${b.what}\n       could not find the code to break — the file moved.`)
    wrong++
    continue
  }

  /*
   * The replacement is a function, not a string.
   *
   * `String.replace` with a string replacement treats `$'` in the replacement as
   * "the portion after the match". The catch-all route's path is the literal
   * `/$'`, so `path: '/$',` had its own `$,` eaten and the file became an
   * unterminated string — the suite failed to compile, reported zero tests, and
   * this script declared a working guard broken.
   *
   * A replacer function receives those patterns as plain text, so nothing is
   * interpreted. Any break in this file may contain `$` freely.
   */
  writeFileSync(b.file, original.replace(b.from, () => b.to))
  try {
    const { ok, output } = runTests()
    const clean = output.replace(/\u001b\[[0-9;]*m/g, '')
    /*
     * Three separate things, and all three must hold.
     *
     * The third was wrong twice before. Vitest reports a failure as
     *
     *     FAIL  src/test/app.test.tsx > the landing screen > / is the entry form…
     *
     * — the test name last, after `>` separators — and not as a bare marker next
     * to the name. Matching for `[×✕]` found nothing and reported five working
     * guards as broken. Read the real output rather than guessing its shape.
     */
    const suiteFailed = !ok
    const named = clean.includes(b.mustFail)
    const markedFailed = new RegExp(`FAIL\\s+[^\\n]*>\\s*${escapeRe(b.mustFail)}`).test(clean)

    if (suiteFailed && named && markedFailed) {
      console.log(`  ✓  ${b.what}`)
      console.log(`       "${b.mustFail}" failed, as it must`)
    } else {
      wrong++
      console.log(`  ✗  ${b.what}`)
      console.log(`       the guard did not fail. suiteFailed=${suiteFailed} named=${named} markedFailed=${markedFailed}`)
      for (const l of clean.split('\n').filter((l) => /Tests |Test Files/.test(l)).slice(-2)) {
        console.log(`       ${l.trim()}`)
      }
    }
  } finally {
    // Restored in a finally, so a guard that failed to be proved still leaves
    // the working tree clean. A proof script that leaves the code broken is a
    // proof script nobody runs twice.
    writeFileSync(b.file, original)
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

console.log(
  wrong === 0
    ? `\n  ${BREAKS.length} guards proved: each one fails against deliberately broken code.`
    : `\n  ${wrong} of ${BREAKS.length} guards did not fail. Those assertions are not load-bearing.`,
)
process.exit(wrong === 0 ? 0 : 1)