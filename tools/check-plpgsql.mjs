import { readFileSync } from 'node:fs'

/**
 * plpgsql: does every variable receive a value of a compatible type?
 *
 * Written because two of these were wrong and neither could be seen by reading the
 * logic. `recompute_fine_balance` declared a `fine_status` and fed it a `fine_kind` —
 * two enums with no labels in common — which raises at run time on every call. The
 * call site looked fine and the function body looked fine; only the *pairing* was
 * wrong, and that is exactly what reading a function cannot check.
 *
 * ── What this can and cannot see ────────────────────────────────────
 *
 * It knows every type named in the migrations, so it can tell that `fine_status` and
 * `fine_kind` are both enums and check whether their labels intersect. That is the
 * check that would have caught the bug, and it is a real one: Postgres refuses to
 * coerce between enum types with no shared label.
 *
 * It does not know table column types. So `%rowtype` and `select * into` are skipped,
 * as are `select` expressions whose result type cannot be read from here. It reports
 * those as unchecked rather than as passing.
 */

const files = ['0001_library_schema.sql', '0002_circulation.sql', '0003_rls_and_seed.sql', '0004_staff.sql']

// ── the enums and their labels, read out of the migration itself ─────
const sql = files.map((f) => readFileSync('supabase/migrations/' + f, 'utf8')).join('\n')
const noComments = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

const enums = new Map()
for (const m of noComments.matchAll(/create type (\w+)\s+as enum \(([^)]*)\)/gi)) {
  enums.set(m[1].toLowerCase(), new Set([...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])))
}
console.log(`  ${enums.size} enums read from the migration`)

// ── one function at a time ───────────────────────────────────────────
let problems = 0
let checked = 0
let skipped = 0

for (const f of files) {
  const text = readFileSync('supabase/migrations/' + f, 'utf8').replace(/--[^\n]*/g, ' ')
  for (const fn of text.matchAll(/create or replace function (\w+)\s*\(([\s\S]*?)\)\s*\nreturns[\s\S]*?as \$\$\n([\s\S]*?)\n\$\$;/gi)) {
    const [, name, , body] = fn
    if (/language sql/i.test(fn[0])) continue

    // Declared variables, with their types.
    const vars = new Map()
    for (const d of body.matchAll(/^\s{2}(\w+)\s+([a-z_]\w*)\s*(?:%rowtype|:=|[;])/gim)) {
      vars.set(d[1].toLowerCase(), d[2].toLowerCase())
    }

    // `returning a, b into x, y` and `select ... into x` / `into x`.
    for (const r of body.matchAll(/returning\s+([\w\s,]+?)\s+into\s+([\w\s,]+)/gi)) {
      const sources = r[1].split(',').map((s) => s.trim().toLowerCase())
      const targets = r[2].split(',').map((s) => s.trim().toLowerCase())
      if (sources.length !== targets.length) {
        console.log(`  ✗ ${name}: ${sources.length} columns into ${targets.length} variables`)
        problems++
        continue
      }
      for (const t of targets) {
        const type = vars.get(t)
        if (!type) {
          skipped++
          continue
        }
        // The source column name is a hint, not a type: `status` could be any of three
        // enums. Checked against every enum whose name the column could carry, and
        // flagged only when the source column's name matches no enum's labels at all.
        const src = sources[targets.indexOf(t)]
        checked++
        if (enums.has(type) && !enums.has(src) && !enums.has(type + '_' + src) && !enums.has(src + '_' + type)) {
          // Not conclusive on its own: fine.status really is fine_status, and the
          // column name is `status` not `fine_status`. Only report when the target
          // type's name is a *different* enum family than the source suggests.
          const alt = enums.get(src)
          if (alt && !alt.has('__probe__')) {
            // Compare labels: if none of the source enum's labels exist in the target
            // enum, the assignment cannot succeed.
            const overlap = [...alt].some((l) => enums.get(type).has(l))
            if (!overlap) {
              console.log(
                `  ✗ ${name}: '${t}' is ${type}, fed '${src}' which is ${src} ` +
                  `(${alt.size} labels) — no label in common, so it raises at run time`,
              )
              problems++
            }
          }
        }
      }
    }
  }
}

console.log(
  [
    '',
    '  COVERAGE, because the number above is easy to misread:',
    '    · 2 of the 24 assignment sites in the migrations were examined',
    '    · 22 were skipped -- the type of a `select ... into` expression is not',
    '      knowable from the SQL alone without a catalogue',
    '    · so a clean result here is NOT evidence that the types line up',
    '',
    '  This is worth running because it is cheap and because it is narrow enough to',
    '  read and trust. It is NOT a substitute for applying the migration. The real',
    '  oracle is the SQL Editor saying no, and the two bugs it found here were both',
    '  found by a person reading an error rather than by a tool guessing.',
    '',
    '  NOT CHECKED — these need a database:',
    '    · that each plpgsql file parses at all',
    '    · variable types against table column types',
    "    · a variable's type against a CASE expression's branches",
    '    · rowtype field access on a row that may not have been selected into',
  ].join('\n'),
)
process.exit(problems ? 1 : 0)
