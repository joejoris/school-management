import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * Nothing secret is in this repository.
 *
 * ── The distinction that matters here ─────────────────────────────────
 *
 * Two very different things get called "the key":
 *
 *   · The **anon key** is public *by design*. It ships inside the browser bundle,
 *     because the browser has to present something and that something must not be
 *     privileged. Publishing it is not a leak; Supabase's own documentation tells
 *     you to. What stops it being a problem is the grants in 0003, where anon is
 *     revoked from every table and may call exactly two functions.
 *
 *   · The **database password** is a real secret. It unlocks the whole database from
 *     anywhere, bypassing RLS entirely, and it must never be in this repository, in
 *     a build, or in a chat message.
 *
 * So this check is not really about the anon key. It is about the password, and
 * about not being casual.
 *
 * ── What it scans ─────────────────────────────────────────────────────
 *
 * Committed files, not the working tree, so an uncommitted secret on disk is
 * reported separately rather than as an emergency. A secret that was committed and
 * then removed is still in the history, so the history is checked too — for a few
 * specific patterns, because scanning every revision of a 15-commit repository for
 * every possible credential shape is guesswork rather than a check.
 */

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)

/**
 * Patterns, and what each one would mean.
 *
 * `anonJwt` is listed so that one appearing in a commit is *noticed*, not because it
 * is a crime — see the note above. Everything else is a genuine finding.
 */
const PATTERNS = [
  {
    name: 'a database connection string',
    re: /postgres(ql)?:\/\/[^:]+:[^@]+@/gi,
    severity: 'real secret',
    note: 'Carries the database password. Revoke it: Supabase → Settings → Database.',
  },
  {
    name: 'a Supabase access token (personal access token)',
    re: /\bsbp_[A-Za-z0-9]{20,}/g,
    severity: 'real secret',
    note: 'A personal access token. Revoke it under Settings → Personal access tokens.',
  },
  {
    name: 'a GitHub token',
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
    severity: 'real secret',
    note: 'Revoke under GitHub → Settings → Developer settings.',
  },
  {
    name: 'a generic private key block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    severity: 'real secret',
    note: 'Remove it, and rotate whatever it unlocked.',
  },
  {
    name: 'an AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: 'real secret',
  },
  {
    name: 'a Supabase anon or service JWT',
    re: /eyJhbGciOi[A-Za-z0-9_-]{10,}\./g,
    severity: 'public by design',
    note: 'The anon key ships in the bundle; a *service* key does not and would be a real leak.',
  },
]

let problems = 0
const found = []

for (const file of files) {
  let text
  try {
    if (statSync(file).size > 2_000_000) continue // not a text file we wrote
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }

  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      // The match itself is truncated: a file that contains a credential should
      // not have it printed back into a terminal that might be logged.
      found.push({ file, pattern: p, line: text.slice(0, m.index).split('\n').length })
    }
  }
}

// ── the working tree, separately ──────────────────────────────────────
// An uncommitted secret is much less serious than a committed one, and saying so
// keeps the committed findings credible.
const uncommitted = []
try {
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((l) => l && !l.startsWith('??'))
    .map((l) => l.slice(3).trim())
  for (const file of uncommitted) void file
  for (const line of dirty) {
    const file = line.replace(/^["']|["']$/g, '')
    try {
      const text = readFileSync(file, 'utf8')
      for (const p of PATTERNS) {
        if ([...text.matchAll(p.re)].length > 0) uncommitted.push({ file, pattern: p })
      }
    } catch {
      /* binary or unreadable */
    }
  }
} catch {
  /* not a repository, or git unavailable */
}

console.log(`  scanned ${files.length} committed files`)

if (found.length === 0) {
  console.log('  ✓ no credentials in any committed file')
} else {
  console.log('')
  for (const f of found) {
    const isPublic = f.pattern.severity === 'public by design'
    if (isPublic) {
      console.log(`  · ${f.file}:${f.line}  ${f.pattern.name}`)
      console.log(`      ${f.pattern.note}`)
    } else {
      console.log(`  ✗ ${f.file}:${f.line}  ${f.pattern.name}`)
      console.log(`      ${f.pattern.severity}. ${f.pattern.note ?? ''}`)
      problems++
    }
  }
}

if (uncommitted.length > 0) {
  console.log('')
  console.log('  not committed yet, so not urgent:')
  for (const f of uncommitted) console.log(`    ${f.file}  ${f.pattern.name}`)
}

console.log(
  problems === 0
    ? '\n  nothing to revoke.\n'
    : `\n  ${problems} committed ${problems === 1 ? 'secret' : 'secrets'}. Remove them and rotate.\n`,
)
process.exit(problems === 0 ? 0 : 1)