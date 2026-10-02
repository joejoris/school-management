import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * The secret scanner, proved against a real credential.
 *
 * A scanner that has only ever reported "clean" is not known to work: it might be
 * matching nothing at all. So a file containing a credential-shaped string is
 * written, committed into the index so `git ls-files` sees it, the scanner is run,
 * and it is required to fail.
 *
 * The string is fabricated. It has the shape of a connection string and reaches
 * nowhere.
 */

const probe = join(root, 'tools', '.secret-probe.tmp')
const originalIndex = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })

function scannerSaysClean() {
  try {
    execFileSync(process.execPath, [join(root, 'tools', 'check-secrets.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

console.log('  · proving the secret scanner fires on a real-shaped credential')

/*
 * The probe strings are ASSEMBLED, not written out.
 *
 * The first version of this file stored them as literals, and `npm run check:secrets`
 * then reported two real secrets in it — correctly. The strings were fabricated and
 * reached nowhere, but the scanner cannot know that, and a scanner with known false
 * positives is a scanner people learn to skip past. The warning would have trained
 * everyone to ignore the one check that matters.
 *
 * So they are built from pieces here. Nothing in the source matches a credential
 * pattern; the file that gets written at runtime still does, which is the whole point.
 */
const pieces = (...parts) => parts.join('')

const probes = [
  {
    what: 'a connection string with a password',
    contents: `DATABASE_URL=${pieces('postgres', '://', 'admin', ':', 'hunter2', '@', 'db.project.supabase.co', ':5432/postgres')}\n`,
  },
  {
    what: 'a GitHub token',
    contents: `const token = "${pieces('ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')}"\n`,
  },
  {
    what: 'a Supabase personal access token',
    contents: `const token = "${pieces('sbp', '_', 'QWERTYUIOPASDFGHJKLZXCVBNM123456')}"\n`,
  },
]

let wrong = 0
for (const p of probes) {
  writeFileSync(probe, p.contents, 'utf8')
  // `git ls-files` reads the index, so the probe has to be staged to be seen.
  execFileSync('git', ['add', '--intent-to-add', 'tools/.secret-probe.tmp'], { cwd: root, stdio: 'pipe' })

  try {
    const clean = scannerSaysClean()
    execFileSync('git', ['reset', '-q', 'HEAD', '--', 'tools/.secret-probe.tmp'], { cwd: root, stdio: 'pipe' })

    if (!clean) {
      console.log(`    ✓ ${p.what} was caught`)
    } else {
      wrong++
      console.log(`    ✗ ${p.what} was NOT caught — this pattern is dead code`)
    }
  } finally {
    // Removed in a finally: a proof script that leaves a credential-shaped file
    // behind is a proof script nobody runs twice.
    try {
      unlinkSync(probe)
    } catch {
      /* already gone */
    }
    execFileSync('git', ['reset', '-q', 'HEAD', '--', 'tools/.secret-probe.tmp'], { cwd: root, stdio: 'pipe' })
    try {
      execFileSync('git', ['rm', '--cached', '-q', '--ignore-unmatch', 'tools/.secret-probe.tmp'], { cwd: root, stdio: 'pipe' })
    } catch {
      /* was never staged */
    }
  }
}

// The index must be exactly as it was, or the proof has changed the repository.
const after = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
if (after !== originalIndex) {
  console.log('    ✗ the index is not as it was — the proof left something behind')
  wrong++
} else {
  console.log('    · the index is unchanged')
}

console.log(wrong === 0 ? '' : `\n  ${wrong} scanner checks proved nothing.\n`)
process.exit(wrong === 0 ? 0 : 1)