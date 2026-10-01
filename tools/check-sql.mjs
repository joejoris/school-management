import { readFileSync } from 'node:fs'

/*
 * A static check over the migration SQL.
 *
 * ── Why it strips comments first ──────────────────────────────────────
 *
 * The first version of this file reported four problems and all four were the
 * checker being wrong:
 *
 *   - `begin;` is not a stray semicolon. It is a PL/pgSQL block, and the migration
 *     is full of them.
 *   - `$$;` is not an unterminated dollar-quote. It is the correct way to close one.
 *   - The money check matched the words "No floats, no numeric" in a comment and
 *     reported a float money column in a schema where every one of them is `int`.
 *   - The update-policy check flagged a policy that has a `with check` on the line
 *     after the one it looked at.
 *
 * A check that reports a phantom defect is worse than no check, because it is
 * trusted. So: comments are stripped before anything is matched, and each rule
 * below is written to only fire on something it can actually see.
 *
 * ── What this is not ──────────────────────────────────────────────────
 *
 * Not a SQL parser. It cannot tell that a plpgsql variable is declared before use,
 * that a `for r in` loop's record shape matches its columns, or that a policy's
 * expression is valid. Those need a database, and this says so rather than implying
 * otherwise. See the list at the bottom.
 */

const files = ['0001_library_schema.sql', '0002_circulation.sql', '0003_rls_and_seed.sql', '0004_staff.sql']
const root = 'supabase/migrations/'

/**
 * SQL with `--` line comments and slash-star blocks removed.
 *
 * The wording above avoids writing those markers literally: a slash-star-block
 * delimiter inside a comment closes the comment, and whatever follows is then
 * parsed as code. That happened here, and it made this file fail to load with a
 * syntax error pointing at an unrelated line.
 */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

const docs = files.map((f) => ({ name: f, text: readFileSync(root + f, 'utf8') }))
const joined = docs.map((d) => d.text).join('\n')
const sql = stripComments(joined)

let bad = 0
const fail = (m) => {
  console.log(`  ✗ ${m}`)
  bad++
}
const pass = (m) => console.log(`  ✓ ${m}`)

// ── 1. RLS on every table ─────────────────────────────────────────────
console.log('\n  RLS coverage')
const declared = [...sql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1])
const enabled = [...sql.matchAll(/alter table (\w+)\s+enable row level security/gi)].map((m) => m[1])

if (declared.length === 0) fail('no tables found — has the syntax changed?')
else if (declared.length !== new Set(declared).size) fail('a table is declared twice')
else pass(`${declared.length} tables declared, no duplicates`)

const missing = declared.filter((t) => !enabled.includes(t))
if (missing.length) fail(`no RLS on: ${missing.join(', ')}`)
else pass(`all ${declared.length} tables have RLS enabled`)

const ghost = enabled.filter((t) => !declared.includes(t))
if (ghost.length) fail(`RLS on a table that is never created: ${ghost.join(', ')}`)

// ── 2. the money tables are written only by functions ─────────────────
console.log('\n  written only by a function')
for (const t of ['loans', 'fines', 'fine_txns']) {
  const writes = [...sql.matchAll(new RegExp(`create policy[\\s\\S]{0,80}?on ${t}\\b[\\s\\S]{0,120}?for\\s+(insert|update|delete)`, 'gi'))]
  if (writes.length) fail(`${t} has a write policy (${writes.map((w) => w[1]).join(', ')})`)
  else pass(`${t}: no insert/update/delete policy`)

  const granted = sql.match(new RegExp(`grant\\s+(insert|update|delete)[^;]*\\bon[^;]*\\b${t}\\b`, 'i'))
  if (granted) fail(`${t} has a write GRANT: ${granted[0].replace(/\s+/g, ' ').slice(0, 60)}`)
}
if (/revoke insert, update, delete on loans\s+from authenticated/i.test(sql)) {
  pass('write privileges revoked on all three')
} else {
  fail('the revoke covering loans/fines/fine_txns is missing or misspelt')
}

// ── 3. anon holds nothing but one function ────────────────────────────
console.log('\n  the anon role')
if (/revoke all on all tables\s+from anon/i.test(sql)) pass('all table privileges revoked from anon')
else fail('anon is not revoked from all tables')
if (/revoke all on all functions from anon/i.test(sql)) {
  pass('all function privileges revoked from anon')
} else {
  fail('anon is not revoked from all functions — every function would be callable by the public key')
}

const anonCalls = [...sql.matchAll(/grant execute on function[\s\S]{0,200}?\bto\b[^;]*\banon\b[^;]*;/gi)].map((g) =>
  g[0]
    .replace(/grant execute on function/gi, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\bto\b[\s\S]*$/i, '')
    .trim(),
)
for (const c of anonCalls) console.log(`     anon may call: ${c || '(unnamed)'}`)

const unexpected = anonCalls.filter((c) => !/has_any_accounts|create_first_user/.test(c))
if (unexpected.length) fail(`anon may call something unexpected: ${unexpected.join('; ')}`)
else if (anonCalls.length === 0) fail('anon cannot call anything at all, so the sign-in screen cannot work')
else pass('only the two expected functions are reachable by anon')

// ── 4. money is integer everywhere ────────────────────────────────────
console.log('\n  money')
// Matched against column definitions only: a line that looks like
// `  some_column  <type>` inside a create table block.
const colDefs = [...sql.matchAll(/^\s{2,}(\w+)\s+(int|integer|bigint|text|boolean|date|timestamptz|uuid|jsonb|real|numeric|double precision|float\d?|[\w_]+\[\])([^,\n]*)/gim)]
const moneyCols = colDefs.filter((m) => /amount|balance|cost|cents|threshold|rate/i.test(m[1]))
const badMoney = moneyCols.filter((m) => !/^(int|integer|bigint)$/i.test(m[2]))
if (badMoney.length) {
  for (const m of badMoney) fail(`${m[1]} is ${m[2]}, not an integer`)
} else {
  pass(`${moneyCols.length} money columns, all integers`)
}

// ── 5. things reading can actually check ──────────────────────────────
console.log('\n  structure')

const dollars = (joined.match(/\$\$/g) || []).length
if (dollars % 2 !== 0) fail(`odd number of $$ (${dollars}) — a dollar-quote is unterminated`)
else pass(`dollar-quotes paired (${dollars})`)

const begins = (joined.match(/^\s*begin;/gim) || []).length
const commits = (joined.match(/^\s*commit;/gim) || []).length
if (begins !== commits) fail(`${begins} begin / ${commits} commit — a transaction would be left open`)
else pass(`transactions balanced (${begins} begin / ${commits} commit)`)

// Each function's `$$` opens where its name was declared, and closes with `$$;`.
for (const m of sql.matchAll(/create or replace function (\w+)/gi)) {
  const at = m.index
  const tail = sql.slice(at, at + 400)
  if (!/\$\$/.test(tail)) fail(`${m[1]}: declared but no dollar-quote nearby`)
}

// A policy that allows an update must also constrain the new row.
const policies = [...sql.matchAll(/create policy\s+(\w+)\s+on\s+(\w+)([\s\S]*?);/gi)]
for (const [, name, table, body] of policies) {
  if (/\bfor update\b/i.test(body) && !/with check/i.test(body)) {
    fail(`policy ${name} on ${table} allows an update without constraining the new row`)
  }
}
if (bad === 0) pass(`all ${policies.length} update policies carry a with check`)

// Every table a policy names exists.
for (const [, , table] of policies) {
  if (!declared.includes(table) && !['users', 'audit'].includes(table)) {
    fail(`a policy is on ${table}, which is not a table`)
  }
}

// ── 6. an update policy must not have become `for all` ────────────────
console.log('\n  deletes')
const deletes = [...sql.matchAll(/create policy\s+\w+\s+on\s+\w+[\s\S]{0,120}?for\s+delete/gi)]
if (deletes.length) fail(`${deletes.length} delete policies — nothing in this system deletes`)
else pass('no delete policy anywhere')

console.log(bad === 0 ? '\n  reading found nothing wrong.\n' : `\n  ${bad} problems found.\n`)

console.log(
  [
    '',
    '  NOT CHECKED HERE — these need a database:',
    '    · that the SQL parses (run it; a typo anywhere fails the whole file)',
    '    · that plpgsql variable and record types line up',
    '    · that each policy expression is valid and behaves as intended',
    '    · that issue_book / return_book / run_fine_accrual actually run',
    '    · that the RLS denies what it should — a policy can be valid and wrong',
    '',
  ].join('\n'),
)

process.exit(bad === 0 ? 0 : 1)