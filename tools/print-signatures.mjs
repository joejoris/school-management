import { readFileSync } from 'node:fs'

/**
 * The exact `GRANT ... ON FUNCTION` signature of every function in the migrations.
 *
 * Written because 0003 tried to grant thirteen functions in one statement:
 *
 *   GRANT EXECUTE ON FUNCTION a, b, c TO authenticated;
 *
 * which is not Postgres. `ON FUNCTION` takes exactly one function and it must be
 * named with its argument-type signature — because `can` and `can(text)` are different
 * functions, and a grant that matches nothing fails silently rather than loudly.
 *
 * So the signatures are read out of the migration rather than written from memory. A
 * hand-written signature that is subtly wrong is a function no signed-in librarian can
 * call, discovered by pressing a button.
 */

const files = ['0001_library_schema.sql', '0002_circulation.sql']
const sql = files.map((f) => readFileSync('supabase/migrations/' + f, 'utf8')).join('\n')

const names = [
  'current_user_id',
  'current_role_name',
  'can',
  'borrow_blockers',
  'issue_book',
  'return_book',
  'renew_loan',
  'void_loan',
  'mark_lost',
  'record_payment',
  'waive_fine',
  'recompute_fine_balance',
  'run_fine_accrual',
]

/** Split an argument list on top-level commas only, so a type with a comma in it survives. */
function splitTopLevel(text) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

const found = []
const missing = []

for (const n of names) {
  const re = new RegExp(`create or replace function ${n}\\s*\\(([\\s\\S]*?)\\)\\s*\\nreturns`, 'i')
  const m = re.exec(sql)
  if (!m) {
    missing.push(n)
    continue
  }
  const args = m[1].trim()
  if (!args) {
    found.push(`${n}()`)
    continue
  }
  const types = splitTopLevel(args).map((p) => {
    /*
     * The default clause is removed FIRST.
     *
     * Taking the last token before doing that yields the default value rather than the
     * type — `p_due_at timestamptz default null` gave `null`, and a signature reading
     * `issue_book(text, text, null, null, false, null)` would grant execute on a
     * function that does not exist, silently, because a grant that matches nothing is
     * not an error.
     */
    const declared = p.split(/\s+default\s+/i)[0].trim()
    const tokens = declared.split(/\s+/).filter(Boolean)
    let ty = tokens[tokens.length - 1] ?? ''
    // `int` is an alias; Postgres records the type as `integer`, and the signature in a
    // GRANT has to agree with how Postgres spells it.
    if (/^int$/i.test(ty)) ty = 'integer'
    return ty
  })
  found.push(`${n}(${types.join(', ')})`)
}

if (missing.length) {
  console.log('  NOT FOUND: ' + missing.join(', '))
  process.exit(1)
}

console.log('  Signatures, read from the migrations:')
for (const f of found) console.log("    '" + f + "',")

console.log('\n  Ready to paste into 0003:')
console.log(
  found
    .map((f) => `    '${f}',`)
    .join('\n'),
)
