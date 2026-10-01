/**
 * The register, as a file.
 *
 * ── Why a school needs this more than it needs a dashboard ───────────
 *
 * A school library keeps a paper register, and the head teacher asks for it. At the
 * end of a term somebody is expected to produce a list of what is out and what came
 * back, in a form they can put in a report.
 *
 * Without an export that is either retype it from the screen — which is how a
 * register and a report drift apart — or photograph the screen, which nobody does
 * twice.
 *
 * So the export is not a convenience. It is the thing that stops the register on the
 * screen and the register in the file becoming two different documents.
 *
 * ── The same rows, in the same order ─────────────────────────────────
 *
 * The export is built from the rows already on the page rather than asking the
 * domain again. That matters: an export that quietly fetched a different slice —
 * everything rather than what is filtered, a fresh ordering — would be a register
 * that did not match the one that was on the screen, which defeats the purpose
 * entirely.
 *
 * ── Quotes and newlines ──────────────────────────────────────────────
 *
 * A title containing a comma, a quote or a line break has to survive a round trip
 * through a spreadsheet. A student called `O"Brien` and a book called
 * `Things We Carry: A Memoir, Revised` are both ordinary, and both break a naive
 * join.
 */

/** One CSV file field, quoted only when it needs it. */
export function csvField(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  // Only quote when there is something to protect: a quoted number arrives in
  // Excel as text, which then refuses to sum.
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
  return text
}

/** Rows as CSV, with a header line and CRLF endings, which is what Excel expects. */
export function toCsv(columns: string[], rows: (string | number | null)[][]): string {
  const lines = [columns.map(csvField).join(',')]
  for (const row of rows) lines.push(row.map(csvField).join(','))
  return lines.join('\r\n') + '\r\n'
}

/**
 * Hands a file to the browser.
 *
 * The object URL is revoked immediately rather than on unload: a blob URL left
 * alive holds a whole term's register in memory for as long as the tab is open, and
 * the download has already started by then.
 */
export function download(filename: string, contents: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * The columns of the issue register.
 *
 * The same order and the same words as the screen, because this is the same
 * document in another shape. A different order would make somebody match the
 * columns up by hand, every time, forever.
 */
export const REGISTER_COLUMNS = [
  'Admission no.',
  'Student',
  'Form',
  'Stream',
  'Grade',
  'Title',
  'Author',
  'Book no.',
  'Taken',
  'Due',
  'Returned',
  'Status',
  'Days overdue',
  'Void reason',
] as const

/** One loan row, flattened for the file. */
export function registerRow(r: {
  memberCode: string
  studentName: string
  form: string | null
  stream: string | null
  grade: string | null
  title: string
  author: string
  barcode: string
  checkedOutAt: string
  dueAt: string
  returnedAt: string | null
  status: string
  daysOverdue: number
  voidReason: string | null
}): (string | number | null)[] {
  const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'short' }) : ''
  return [
    r.memberCode,
    r.studentName,
    r.form,
    r.stream,
    r.grade,
    r.title,
    r.author,
    r.barcode,
    day(r.checkedOutAt),
    day(r.dueAt),
    day(r.returnedAt),
    r.status,
    r.daysOverdue,
    r.voidReason,
  ]
}