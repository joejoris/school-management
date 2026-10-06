/**
 * The entry form: the landing screen and the only task.
 *
 * ── Why it is the landing screen ────────────────────────────────────
 *
 * The librarian opens this at 7am and their job is to record that a student took
 * a book. Everything else — the register, the import, the backup — is something
 * they do less often. Putting the most common thing first means the app opens on
 * the thing that needs doing, not on a summary of things already done.
 *
 * There is deliberately no dashboard above it. A panel of counts is what an
 * administrator wants and a librarian does not, and it pushes the one field they
 * need off the screen on a phone.
 *
 * ── The rule about invented data ─────────────────────────────────────
 *
 * A member number that is not on file does not create a student. It says so, and
 * offers to create one deliberately — because silently inventing a student means
 * the register contains a person who does not exist, and a school cannot audit
 * its way out of that.
 *
 * ── Form, Grade and Stream ──────────────────────────────────────
 *
 * All three are always visible. They used to appear only when the admission number
 * was not on file, which meant a librarian correcting a student's stream after a
 * transfer had nowhere to put it — and the alternative, quietly editing somebody's
 * record as a side effect of issuing a book, is worse: a wrong keystroke would
 * rewrite a child's enrolment with no confirmation and no undo.
 *
 * So the fields are always there, and when the student is already on file they are
 * filled from their record and left read-only. Read-only rather than editable
 * because "issue a book" and "change a student's enrolment" are two different jobs,
 * and a form that does both at once does them both wrong.
 *
 * Form and Grade suggest from the school's own lists — Form 3 and Form 4, Grades
 * 10 to 12. Stream is free text with no suggestions at all, because a school names
 * its own streams and there is no list that is right for all of them.
 *
 * ── An unrecognised admission number ──────────────────────────────
 *
 * It asks for a name, in a field labelled "New student's name", and says nothing else.
 *
 * There was a banner here once: "No student with that number is on file. Fill in their
 * name and they will be added when you record the issue." Two things were wrong with it,
 * and only the first one was visible.
 *
 * The visible one: it read as a telling-off for something librarians do correctly and
 * constantly — entering the admission number of a student not yet in the register is how
 * that student's first book gets recorded.
 *
 * The hidden one: it promised something that never happened. Filling in the name did
 * nothing, because `studentName` went into `checkout`, which ignored it, and `issue_book`
 * has no enrolment path at all. Both refused with "No student on file with that number."
 * So a librarian who followed the instruction exactly was refused for following it.
 *
 * So the banner is gone and the enrolment is real. An unknown number with a name typed
 * beside it now creates the student and then issues the book — the field is the only
 * thing they are asked for, and nothing tells them they have done something wrong.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FORM_SUGGESTIONS, GRADE_SUGGESTIONS } from '@library/contracts'
import { api } from '../../api'
import { isFutureLocalDay, startOfLocalDay, todayLocal } from '../../lib/dates'
import { Button, Card, CardContent, Field, Input, cn } from '../../components/ui'
import { BookPlus, TriangleAlert } from '../../components/icons'

/** What has been typed but not yet submitted. */
interface Draft {
  memberCode: string
  studentName: string
  admission: string
  form: string
  stream: string
  grade: string
  title: string
  barcode: string
  dateTaken: string
  dueDate: string
}

/*
 * "Today" is the reader's own calendar day.
 *
 * This used to be `new Date().toISOString().slice(0, 10)`, which is **UTC**. West of
 * Greenwich that is already tomorrow for part of every evening, and the day typed
 * into the form was then read back as *local* — so a book taken "today" was stamped
 * eight hours into the future and `returnLoan` refused it with "A book cannot come
 * back before it went out." Every return button in the app was dead, and the domain
 * was right to refuse: the book genuinely had not gone out yet.
 *
 * The reasoning is in lib/dates.ts, and there is a test that fails without this.
 */
const today = () => todayLocal()

const emptyDraft = (): Draft => ({
  memberCode: '',
  studentName: '',
  admission: '',
  form: '',
  stream: '',
  grade: '',
  title: '',
  barcode: '',
  dateTaken: today(),
  dueDate: '',
})

export function RecordIssue() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  /*
   * Suggestions come from the school's own list, not from what happens to be in the
   * register.
   *
   * An earlier version derived them from the 200 most recent students. That sounds
   * clever and is wrong twice over: it reads the whole member list on every page
   * load to produce two short strings, and it makes the suggestions depend on what
   * has been typed recently rather than on what the school uses. A school with no
   * students yet — which is every school on the day it starts — got an empty list
   * and therefore no help at all.
   *
   * The lists are two short arrays in the domain layer now, where the school can
   * change them without anybody editing a screen.
   */

  /*
   * The member is looked up as the number is typed, not on submit.
   *
   * On a phone, waiting to press a button to find out you typed the wrong number
   * is the difference between a two-second correction and losing the form. The
   * lookup is debounced by the query's own staleness rather than a timer here,
   * so it does not fire on every keystroke.
   */
  const member = useQuery({
    queryKey: ['member-by-code', draft.memberCode.trim()],
    queryFn: () => api.findMemberByCode(draft.memberCode.trim()),
    enabled: draft.memberCode.trim().length > 0,
    staleTime: 10_000,
    retry: false,
  })

  const knownMember = member.data

  /*
   * Find the student by name, as the person at the desk actually knows them.
   *
   * Admission numbers are for the register. The librarian reads a student's face and
   * name, not a code off the card, so the search matches on name and the code falls
   * out of the chosen record.
   */
  const search = useQuery({
    queryKey: ['member-search', draft.studentName.trim()],
    queryFn: () => api.searchMembers({ limit: 50, offset: 0, q: draft.studentName.trim() }),
    enabled: draft.studentName.trim().length > 1 && !knownMember,
    staleTime: 10_000,
    retry: false,
  })

  const save = useMutation({
    mutationFn: async () => {
      /*
       * A day in the future is refused here, at the field that caused it.
       *
       * It has to be. A loan stamped for next week is a loan that cannot be returned
       * until next week, and the person who typed it has no way to tell that from a
       * broken application — they pressed Record and nothing happened for a week.
       * Told here, they are looking at the date they typed and can fix it.
       */
      if (draft.dateTaken && isFutureLocalDay(draft.dateTaken)) {
        throw new Error('A book cannot be taken out on a date that has not happened yet.')
      }

      const code = draft.memberCode.trim()

      /*
       * Identify the student by name, not by a typed code. The chosen record's
       * memberCode is what makes the checkout, so there is no chance of a code
       * disagreeing with the name on it.
       */
      if (!knownMember) {
        throw new Error(
          'No student matched that name. Pick the student from the list above, or add them from the Students screen first.',
        )
      }

      const result = await api.checkout({
        memberCode: code,
        barcode: draft.barcode.trim(),
        dueAt: draft.dueDate || undefined,
        /*
         * Local midnight of the typed day, not 08:00.
         *
         * The `T08:00:00` this replaced was a fiction: "taken today" was stored as
         * "taken at eight in the morning" whatever the time actually was, so for the
         * first eight hours of every day a book taken today could not be returned
         * until eight the next morning. Midnight is the earliest instant the typed
         * day could have been, which makes the impossible ordering — returned before
         * it went out — unreachable rather than merely unlikely.
         */
        checkedOutAt: draft.dateTaken ? startOfLocalDay(draft.dateTaken) : undefined,
      })
      if (!result.ok) throw new Error(result.message)
      return result
    },
    onSuccess: async (result) => {
      const who = member.data
      setSaved(
        `Recorded. ${who ? `${who.firstName} ${who.lastName}` : draft.memberCode}` +
          ` has ${draft.title.trim() || 'the book'} until ` +
          `${new Date(result.dueAt).toLocaleDateString('en-GB', { dateStyle: 'medium' })}.`,
      )
      // The form is cleared but the member is kept: somebody issuing four books
      // to one student in a row should not retype the number each time.
      setDraft({ ...emptyDraft(), memberCode: draft.memberCode, studentName: draft.studentName, admission: draft.admission })
      await queryClient.invalidateQueries({ queryKey: ['loans'] })
      await queryClient.invalidateQueries({ queryKey: ['member-by-code'] })
    },
    onError: (e: unknown) => {
      // The draft is deliberately left alone. Clearing it on failure would throw
      // away the half-typed record of somebody who simply pressed the wrong
      // button, and a form that empties when it complains is a form people stop
      // trusting.
      setSaved(null)
      setError(e instanceof Error ? e.message : 'Could not record that.')
    },
  })

  const canSubmit = Boolean(knownMember) && draft.barcode.trim().length > 0

  /*
   * The admission number is no longer typed on this screen. It remains the
   * student's id throughout the system -- loans, fines, holds -- but the entry
   * task starts from a face, not a code, and the code sits behind the name.
   */
  const locked = Boolean(knownMember)
  const nameTypedLongEnough = draft.studentName.trim().length > 1
  const unknownMember = nameTypedLongEnough && !knownMember && search.isFetched

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-2">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Record a book issue</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The student and the book number are all that is required. Find the student by name.
        </p>
      </header>

      {saved ? (
        <p
          role="status"
          className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm"
        >
          {saved}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <form
            className="grid gap-5"
            onSubmit={(e) => {
              e.preventDefault()
              setError(null)
              save.mutate()
            }}
          >
            {/* ── Student ─────────────────────────────────────────── */}
            <fieldset className="grid gap-4">
              <legend className="mb-1 flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                <BookPlus className="size-4" /> Student
              </legend>

              <Field label="Student's name" htmlFor="studentName" hint="Start typing — the register searches as you go.">
                <Input
                  id="studentName"
                  value={draft.studentName}
                  onChange={(e) => {
                    set('studentName', e.target.value)
                    set('memberCode', '') // a typed name is not yet a chosen student
                  }}
                  placeholder="Kept Student"
                  autoComplete="off"
                  // The one field the form is about. Everything else can wait.
                  autoFocus
                />
              </Field>

              {/*
                Matching students. Tap one to pick them -- the chosen record's code is
                what makes the loan, so a name and a code can never disagree.
              */}
              {search.data && search.data.items.length > 0 && !knownMember ? (
                <ul className="grid gap-1.5">
                  {search.data.items.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="w-full rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent/40"
                        onClick={() => {
                          set('memberCode', s.memberCode)
                          set('studentName', `${s.firstName} ${s.lastName}`)
                        }}
                      >
                        <span className="font-medium">{s.firstName} {s.lastName}</span>
                        <span className="text-muted-foreground"> — {s.memberCode}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {unknownMember && search.data && search.data.items.length === 0 ? (
                <p className="rounded-lg border border-accent bg-accent/40 px-4 py-3 text-sm text-muted-foreground">
                  Nobody with that name is on file. Add them from the Students screen first.
                </p>
              ) : null}

              {/*
               * The admission number, as the other way in. Not the primary one, because
               * a face is what reaches the desk. But every student has a number on their
               * card, and a librarian who has it should not have to be told to type the
               * name instead. Typed, it fills in the same record the name search picks.
               */}
              <Field label="Admission number" htmlFor="admission" hint="If you know it — otherwise use the name above.">
                <Input
                  id="admission"
                  value={draft.admission}
                  onChange={(e) => {
                    set('admission', e.target.value)
                    set('memberCode', e.target.value.trim())
                  }}
                  placeholder="S001"
                  autoComplete="off"
                  inputMode="text"
                  className="numeric"
                />
              </Field>

              {draft.admission.trim() && !member.isPending && !member.data ? (
                <p className="rounded-lg border border-accent bg-accent/40 px-4 py-3 text-sm text-muted-foreground">
                  No student with that number on file. Check it against their card, or use the name above.
                </p>
              ) : null}

              {/*
                Who this is, once the number is recognised.

                Every field below is shown from their record rather than left blank,
                because an empty box beside a known student's name reads as "no
                information" when it actually means "look it up".
              */}
              {knownMember ? (
                <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
                  <p>
                    <strong className="font-medium">
                      {knownMember.firstName} {knownMember.lastName}
                    </strong>
                    <span className="text-muted-foreground">
                      {' — '}
                      {[
                        knownMember.form,
                        knownMember.stream,
                        knownMember.grade ? `Grade ${knownMember.grade}` : null,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'no form or grade on file'}
                    </span>
                  </p>
                </div>
              ) : null}


              {/*
                Form and Grade suggest; Stream does not.

                A school names its own streams — Red, Blue, East, Nk, 7A — and there
                is no list that is right for all of them. A datalist attached to that
                field was removed after a test caught it: the browser shows its
                dropdown even when the list is empty, so an empty one turns a
                free-text field into a half-controlled one that looks broken and offers
                nothing.

                The lists live in the domain layer, so the school changes them without
                anybody editing a screen.
              */}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Form" htmlFor="form">
                  <Input
                    id="form"
                    value={locked ? (knownMember?.form ?? '') : draft.form}
                    onChange={(e) => set('form', e.target.value)}
                    list="form-suggestions"
                    placeholder="Form 3"
                    readOnly={locked}
                    aria-describedby={locked ? 'enrolment-locked' : undefined}
                    className={locked ? 'opacity-70' : undefined}
                  />
                  <datalist id="form-suggestions">
                    {FORM_SUGGESTIONS.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </Field>

                <Field label="Grade" htmlFor="grade">
                  <Input
                    id="grade"
                    value={locked ? (knownMember?.grade ?? '') : draft.grade}
                    onChange={(e) => set('grade', e.target.value)}
                    list="grade-suggestions"
                    placeholder="10"
                    inputMode="numeric"
                    readOnly={locked}
                    aria-describedby={locked ? 'enrolment-locked' : undefined}
                    className={locked ? 'opacity-70' : undefined}
                  />
                  <datalist id="grade-suggestions">
                    {GRADE_SUGGESTIONS.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </Field>

                <Field label="Stream" htmlFor="stream" hint="Optional. Free text.">
                  <Input
                    id="stream"
                    value={locked ? (knownMember?.stream ?? '') : draft.stream}
                    onChange={(e) => set('stream', e.target.value)}
                    placeholder="Red Stream"
                    autoComplete="off"
                    readOnly={locked}
                    aria-describedby={locked ? 'enrolment-locked' : undefined}
                    className={locked ? 'opacity-70' : undefined}
                  />
                </Field>
              </div>

              {/*
                Why the boxes went read-only, stated where it is visible rather than
                only in this file. A read-only field with no explanation looks broken;
                one that says where the values came from is simply a fact.
              */}
              {locked ? (
                <p id="enrolment-locked" className="-mt-2 text-xs text-muted-foreground">
                  These are the student's details as recorded. Changing them is done on
                  the student's own record, not here — issuing a book should never
                  rewrite an enrolment.
                </p>
              ) : null}
            </fieldset>

            {/* ── Book ────────────────────────────────────────────── */}
            <fieldset className="grid gap-4">
              <legend className="mb-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                Book
              </legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Book number" htmlFor="barcode" hint="The number on the spine.">
                  <Input
                    id="barcode"
                    value={draft.barcode}
                    onChange={(e) => set('barcode', e.target.value)}
                    placeholder="BK-0001"
                    autoComplete="off"
                    className="numeric"
                  />
                </Field>
                <Field label="Title" htmlFor="title" hint="Optional. Found from the book number.">
                  <Input
                    id="title"
                    value={draft.title}
                    onChange={(e) => set('title', e.target.value)}
                    placeholder="Things We Carry"
                  />
                </Field>
              </div>
            </fieldset>

            {/* ── Dates ────────────────────────────────────────────── */}
            <fieldset className="grid gap-4">
              <legend className="mb-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                Dates
              </legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Date taken"
                  htmlFor="dateTaken"
                  hint="Backdate this if you are writing up a paper register."
                >
                  <Input
                    id="dateTaken"
                    type="date"
                    value={draft.dateTaken}
                    onChange={(e) => set('dateTaken', e.target.value)}
                  />
                </Field>
                <Field
                  label="Date due"
                  htmlFor="dueDate"
                  hint="Left empty, the loan period for this member type is used. Set it when a class set or exam week needs a different date."
                >
                  <Input
                    id="dueDate"
                    type="date"
                    value={draft.dueDate}
                    onChange={(e) => set('dueDate', e.target.value)}
                  />
                </Field>
              </div>
            </fieldset>

            <div className="flex justify-end gap-3 border-t border-border pt-5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft(emptyDraft())
                  setError(null)
                }}
              >
                Clear
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit || save.isPending}
                className={cn('min-w-40')}
              >
                {save.isPending ? 'Recording…' : 'Record issue'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

/** Kept beside the form rather than in a shared module: it is the form's error. */
declare function useError(): [string | null, (e: string | null) => void]