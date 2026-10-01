/**
 * The school's own vocabulary — the words it uses, as opposed to the words the
 * software uses.
 *
 * ── These are suggestions, not constraints ───────────────────────────
 *
 * Nothing here is validated. A form may say "Form 3", and the storage layer will
 * happily keep "Form 5" or "Year 4" or "3 East" without complaint.
 *
 * That is deliberate, and it is the opposite of what an enum would do. A closed
 * list in the domain means a student cannot be enrolled under a name the school
 * actually uses, and the fix is a code deploy. A closed list in the interface is
 * only a suggestion, so it costs a librarian nothing to type something else and
 * costs the school nothing to change its mind.
 *
 * The cost of getting this wrong is asymmetric: an unhelpful suggestion is mildly
 * annoying, a rejected value is a student who cannot be recorded at all.
 */
import type { MemberTypeKey } from './enums.ts'

/**
 * The forms a Kenyan secondary school runs, as the school writes them.
 *
 * Form 3 and Form 4 — not "Grade 9". The two names for the same year sit in
 * different columns of the same record, which sounds redundant until you meet a
 * school that uses one for the timetable and the other on the report card.
 */
export const FORM_SUGGESTIONS = ['Form 3', 'Form 4'] as const

/**
 * Grades 10, 11 and 12.
 *
 * Kept as *strings*, not numbers. A grade is written on a report card and read
 * aloud, and `12` stored as a number comes back out of a text field needing a
 * conversion that somebody will eventually forget. Every school that writes
 * "Grade 10" and every school that writes just "10" is describing the same year,
 * and the school chooses.
 */
export const GRADE_SUGGESTIONS = ['10', '11', '12'] as const

/**
 * Streams. Deliberately empty.
 *
 * A stream is free text because a school names its own. "Red", "Blue", "East",
 * "Nk", "7A" — there is no list that is right for all of them, and a list that is
 * wrong is a list the school has to argue with.
 *
 * Declared as an empty array rather than omitted, so a caller that would have used
 * it has to make a decision rather than defaulting silently. See the note on the
 * datalist in the entry form: an empty suggestion list still produces a browser
 * dropdown, which makes a free-text field look broken and offer nothing.
 */
export const STREAM_SUGGESTIONS: readonly string[] = []

/**
 * Whether a member type is one that has enrolment details at all.
 *
 * A staff member or an external reader has no form and no grade. Asking for them
 * would mean typing something untrue to get past the form, which is how a register
 * ends up full of students who are all in "Form n/a".
 */
export function hasEnrolment(type: MemberTypeKey | string): boolean {
  return type === 'student'
}

/** How a member type is named on screen. */
export const MEMBER_TYPE_LABELS: Record<MemberTypeKey, string> = {
  student: 'Student',
  teacher: 'Teacher',
  staff: 'Staff',
  external: 'External',
}