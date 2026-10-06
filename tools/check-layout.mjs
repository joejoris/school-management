import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/*
 * Does the layout hold up on a phone and a tablet?
 *
 * ── Why this is a static check and not a test ─────────────────────────
 *
 * jsdom has no viewport. It does not lay out, it does not evaluate media queries, and
 * `hidden` is inert, so a test asserting "nothing overflows at 360px" would pass
 * unconditionally and prove nothing. There is no browser attached to this session, so a
 * rendered check is not available either.
 *
 * That leaves reading the code, which is worth doing precisely because the bug it finds
 * is invisible in every other check this project has.
 *
 * ── The bug that motivated it ─────────────────────────────────────────
 *
 * The rail is `fixed inset-y-0 left-0 w-[4rem]` at every breakpoint. The content column
 * reserved room for it with `lg:pl-[4rem]` — only at 1024px and up. So on every phone
 * and every tablet in portrait, a 64px strip sat permanently on top of the content,
 * covering the start of every field, every heading and every button. 80 jsdom tests
 * passed throughout, and my static SQL checks passed throughout, because none of them
 * knows what a pixel is.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'apps/web/src')

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(SRC)
let problems = 0
const fail = (m) => {
  console.log(`  ✗ ${m}`)
  problems++
}
const pass = (m) => console.log(`  ✓ ${m}`)

// ── 1. the rail is fixed, so the space for it is not optional ─────────
console.log('\n  the rail')
const shell = readFileSync(join(SRC, 'shell.tsx'), 'utf8')
const navClasses = /<nav[\s\S]{0,600}?className=\{cn\(([\s\S]*?)\)\}/.exec(shell)?.[1] ?? ''
const navIsFixed = /\bfixed\b/.test(navClasses)
const navIsSticky = /\bsticky\b/.test(navClasses)

if (!navIsFixed && !navIsSticky) {
  fail('the rail is neither fixed nor sticky, so this check cannot reason about it — update the rule')
} else {
  pass(`the rail is ${navIsFixed ? 'fixed' : 'sticky'} at every breakpoint, so it overlays the content column`)

  // Whatever it is, the content column must clear it at every breakpoint. A breakpoint
  // prefix here is the whole bug: it means the space appears only where the rail is
  // least in the way.
  //
  // The prefix is captured as its own group. Reading it by splitting the matched class on
  // ':' was wrong -- `pl-[4rem]` contains no colon, so the "prefix" came back as the class
  // itself and every screen was reported as broken, including the one just fixed.
  const pad = /(?:['"\s])((?:([a-z]{2}):)?pl-(\[[^\]]+\]|var\(--[\w-]+\)|\d+))(?=['"\s])/.exec(shell)
  const prefix = pad?.[2]
  if (!pad) {
    fail('the content column has no left padding, so the fixed rail covers the start of everything')
  } else if (prefix) {
    fail(
      `the content column clears the rail with '${pad[1]}' — prefixed '${prefix}:', so below that ` +
        `breakpoint the rail covers the content. A fixed element is fixed at every size.`,
    )
  } else {
    pass(`the content column clears the rail at every breakpoint (${pad[1]})`)
  }

  /*
   * And the two must be the SAME NUMBER.
   *
   * This is the part that was checked and did not help: for a long time the rule only
   * complained about a breakpoint prefix, so a rail of 4rem beside a padding of 3rem
   * passed — which is the same covering bug, quieter. They are now both
   * `var(--rail-w)`, so there is one number and it cannot disagree with itself.
   *
   * Two literals in the same file that have to agree are a coupling with nothing
   * enforcing it. One variable is the whole fix.
   */
  const railWidth = /(?:['"\s])w-(\[[^\]]+\]|var\(--[\w-]+\)|\d+)(?=['"\s])/.exec(shell)?.[1]
  const padValue = pad?.[3]
  if (railWidth && padValue && railWidth !== padValue) {
    fail(
      `the rail is ${railWidth} but the content column reserves ${padValue} for it — ` +
        'they must be one value, or the rail covers the content',
    )
  } else if (railWidth && padValue) {
    pass(`the rail (${railWidth}) and the space reserved for it (${padValue}) are the same value`)
  }

  /*
   * The rail's own contents must fit inside it.
   *
   * `w-[4rem]` is 64px. A 44px touch target with `px-3` — 12px either side — is 68px,
   * and `shrink-0` means it cannot give way. So the header stuck 4px out over the content.
   * Read off the class names, because the alternative is not seeing it at all: jsdom does
   * no layout, so no test could have caught it either.
   */
  const railRem = railWidth?.match(/^(\d+(?:\.\d+)?)rem$/)?.[1]
  if (railRem) {
    const railPx = Number(railRem) * 16
    const target = /size-(\d+)/.exec(shell)
    const px3 = /gap-3 px-3/.test(shell)
    if (target) {
      const touch = Number(target[1]) * 4 // Tailwind's size-N is N/4 rem
      const rowWidth = touch + (px3 ? 24 : 16)
      if (rowWidth > railPx) {
        fail(
          `the rail is ${railPx}px wide but its header row needs ${rowWidth}px ` +
            `(a ${touch}px touch target with ${px3 ? 'px-3' : 'px-2'}), so it overhangs the content`,
        )
      } else {
        pass(`the rail's header row fits inside it (${rowWidth}px in ${railPx}px)`)
      }
    }
  }
}

// ── 2. no fixed pixel width on a screen ───────────────────────────────
console.log('\n  fixed widths')
let fixed = 0
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/(?<![-a-z])w-\[(\d+)px\]/g)) {
    // A fixed width in the *chrome* is fine — the rail is 4rem and always will be. What
    // breaks a phone is a fixed width on something that holds content.
    const line = text.slice(0, m.index).split('\n').length
    fail(`${relative(root, f)}:${line}  w-[${m[1]}px] cannot shrink — use max-w-*, or w-… with a min() bound`)
    fixed++
  }
}
if (fixed === 0) pass('no fixed pixel width on any element')

// ── 3. every table can scroll, or is hidden on a small screen ─────────
//
// The mechanism matters: a wide table in normal flow makes the *page* scroll sideways,
// which on a phone hides whatever is to its right with nothing to drag. Scrolling the
// table itself keeps the page still.
console.log('\n  tables')
let tables = 0
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/<table/g)) {
    tables++
    const line = text.slice(0, m.index).split('\n').length
    const where = `${relative(root, f)}:${line}`
    // Look at the wrapper: the 400 characters before the table.
    const before = text.slice(Math.max(0, m.index - 400), m.index)
    const scrolls = /overflow-x-auto|overflow-auto/.test(before)
    const hiddenOnPhone = /\bhidden\b[^"']*(?:sm|md|lg):(block|flex|grid)/.test(before)
    if (scrolls) pass(`${where}  scrolls horizontally rather than scrolling the page`)
    else if (hiddenOnPhone) pass(`${where}  hidden on a small screen`)
    else fail(`${where}  a table with neither an overflow wrapper nor a small-screen fallback — it will scroll the whole page sideways`)
  }
}
if (tables === 0) console.log('     · no tables found — has the layout changed?')

// ── 4. grids whose children can be squeezed to nothing ───────────────
//
// `min-width: auto` on a grid item means it refuses to be narrower than its content.
// A long unbroken value then widens the column, the grid outgrows the viewport, and the
// page scrolls sideways. It is the most common cause of a phone layout that "mostly"
// fits.
console.log('\n  grids')
let multi = 0
let guarded = 0
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/className="([^"]*\bgrid-cols-[2-9][^"]*)"/g)) {
    multi++
    const classes = m[1]
    const line = text.slice(0, m.index).split('\n').length
    const where = `${relative(root, f)}:${line}`

    /*
     * A tablist is exempt, and deliberately.
     *
     * Two tabs side by side is the shape tabs have always had, the labels are two fixed
     * words chosen at build time rather than data, and neither can grow. Flagging it
     * would be a false positive on the one grid in the app that genuinely cannot overflow
     * -- and a check that reports correct code is a check people learn to ignore.
     */
    if (/role="tablist"/.test(text.slice(Math.max(0, m.index - 300), m.index + 120))) {
      guarded++
      continue
    }

    // Otherwise the columns must collapse on a small screen, or the items may shrink.
    const collapses = /(sm|md|lg):grid-cols-[2-9]/.test(classes)
    if (collapses) {
      guarded++
      continue
    }
    // Otherwise something in the file must set min-w-0 on the item, or the value is
    // short enough not to matter. A number in a tabular font is; a label is not.
    const hasMinW = /min-w-0/.test(text)
    if (hasMinW) {
      guarded++
      pass(`${where}  fixed columns, and the file sets min-w-0 on the items`)
    } else {
      fail(
        `${where}  fixed columns with no min-w-0 anywhere in the file — a grid item ` +
          "defaults to min-width:auto, so one long value widens its column and the grid outgrows the screen",
      )
    }
  }
}
if (multi === 0) console.log('     · no multi-column grids found')
else pass(`${guarded} of ${multi} grids either collapse on a small screen or can be squeezed`)

// ── what this cannot see ──────────────────────────────────────────────
console.log(
  problems === 0
    ? '\n  reading found nothing wrong.\n'
    : `\n  ${problems} problem(s).\n`,
)

console.log(
  [
    '',
    '  NOT CHECKED HERE — these need a real viewport:',
    '    · whether anything actually overflows at 360px, 390px or 768px',
    '    · touch target sizes against the 44px minimum',
    '    · that a rotated phone reflows rather than staying broken',
    '    · the open rail at 320px, which is 240px of a 320px screen',
    '',
    '  This reads the code. It does not render anything, and a layout that passes here',
    '  can still be wrong on a device. Open it on a real phone before trusting it.',
  ].join('\n'),
)

process.exit(problems ? 1 : 0)