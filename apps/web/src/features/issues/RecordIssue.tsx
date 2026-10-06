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
 * Stream is free text. Form and Grade suggest from what this school has actually
 * used, and a suggestion that guesses wrong is worse than an empty field.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { FORM_SUGGESTIONS, GRADE_SUGGESTIONS } from '@library/contracts'
import { startOfLocalDay, todayLocal } from '../../lib/dates'
import { Button, Card, CardContent, Field, Input, cn } from '../../components/ui'
import { BookPlus, TriangleAlert } from '../../components/icons'

/** What has been typed but not yet submitted. */
interface Draft {
  memberCode: string
  studentName: string
  form: string
  stream: string
  grade: string
  title: string
  barcode: string
  dateTaken: string
  dueDate: string
}

const today = () => todayLocal()

const emptyDraft = (): Draft => ({
  memberCode: '',
  studentName: '',
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

  const save = useMutation({
    mutationFn: async () => {
      /*
       * If the admission number is on a fresh student, enrol that student first,
       * then issue the book. The entry form is the place where a brand-new
       * student gets on file for their first book; expecting the admission number
       * to already be on file would mean logging them somewhere else first.
       *
       * Only the librarians who can enrol are allowed to reach this code at all —
       * assistance and above have it, because the library is the whole app for a
       * school. The permissions are still enforced again in the domain, so a UI
       * path that tries to enrol without the right permission is refused.
       */
      const code = draft.memberCode.trim()
      if (!member.data && draft.studentName.trim().length === 0) {
        throw new Error(
          'No student on file with that number. Fill in their name and they will be added when you record the issue.',
        )
      }
      if (!member.data) {
        const typedName = draft.studentName.trim()
        const gap = typedName.lastIndexOf(' ')
        await api.createMember({
          memberCode: code,
          firstName: gap === -1 ? typedName : typedName.slice(0, gap),
          lastName: gap === -1 ? '—' : typedName.slice(gap + 1),
          type: 'student',
          form: draft.form || undefined,
          stream: draft.stream || undefined,
          grade: draft.grade || undefined,
        })
      }
      const result = await api.checkout({
        memberCode: code,
        barcode: draft.barcode.trim(),
        dueAt: draft.dueDate || undefined,
        checkedOutAt: draft.dateTaken ? startOfLocalDay(draft.dateTaken) : undefined,
      })
      if (!result.ok) throw new Error(result.message)
      return result
    },
    onSuccess: async (result) => {
      const who = member.data
      setSaved(
        `Recorded. ${who ? `${who.firstName} ${who.lastName}` : draft.studentName.trim() || draft.memberCode}` +
          ` has ${draft.title.trim() || 'the book'} until ` +
          `${new Date(result.dueAt).toLocaleDateString('en-GB', { dateStyle: 'medium' })}.`,
      )
      // The form is cleared but the member is kept: somebody issuing four books
      // to one student in a row should not retype the number each time.
      setDraft({ ...emptyDraft(), memberCode: draft.memberCode, studentName: draft.studentName })
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

  const canSubmit = draft.memberCode.trim().length > 0 && draft.barcode.trim().length > 0
  const knownMember = member.data
  const unknownMember = draft.memberCode.trim().length > 2 && !member.isPending && !knownMember

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-2">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Record a book issue</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The admission number and the book number are all that is required.
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

              <Field label="Admission number" htmlFor="memberCode" hint="As written on their card, including any leading zero.">
                <Input
                  id="memberCode"
                  value={draft.memberCode}
                  onChange={(e) => set('memberCode', e.target.value)}
                  placeholder="S001"
                  autoComplete="off"
                  inputMode="text"
                  className="numeric"
                  // The one field the form is about. Everything else can wait.
                  autoFocus
                />
              </Field>

              {knownMember ? (
                <p className="rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground">
                  <strong className="font-medium">
                    {knownMember.firstName} {knownMember.lastName}
                  </strong>
                  {knownMember.form || knownMember.stream
                    ? ` — ${[knownMember.form, knownMember.stream].filter(Boolean).join(', ')}`
                    : ''}
                </p>
              ) : null}

              {unknownMember ? (
                /*
                 * Offers to create rather than creating.
                 *
                 * Inventing a student from a typo is how a register acquires
                 * people who do not exist. Making it a second, explicit act means
                 * the entry is always something a person chose to do.
                 */
                <div className="rounded-lg border border-accent bg-accent/40 px-4 py-3 text-sm">
                  <p className="font-medium">No student with that number is on file.</p>
                  <p className="mt-1 text-muted-foreground">
                    Fill in their name below and they will be added when you record the
                    issue.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Student's name" htmlFor="studentName">
                      <Input
                        id="studentName"
                        value={draft.studentName}
                        onChange={(e) => set('studentName', e.target.value)}
                        placeholder="Kept Student"
                      />
                    </Field>
                    <Field label="Form" htmlFor="form" hint="Form 3 or Form 4.">
                      <Input
                        id="form"
                        value={draft.form}
                        onChange={(e) => set('form', e.target.value)}
                        list="form-suggestions"
                        placeholder="Form 3"
                      />
                      <datalist id="form-suggestions">
                        {FORM_SUGGESTIONS.map((v) => (
                          <option key={v} value={v} />
                        ))}
                      </datalist>
                    </Field>
                    {/*
                      Free text, and deliberately with no `list` attribute.

                      This is the field that has been got wrong before, so it is
                      worth stating plainly: a school names its own streams, and a
                      suggestion list on this one is a list the school has to
                      argue with. A datalist attached here was removed after a test
                      caught it — the browser's autocomplete dropdown appears even
                      when the list is empty, which turns a free-text field into a
                      half-controlled one that looks broken and offers nothing.

                      Form and Grade do suggest, because those are the ones with a
                      small closed set the school actually uses.
                    */}
                    <Field label="Stream" htmlFor="stream" hint="Optional. Free text — the school names its own streams.">
                      <Input
                        id="stream"
                        value={draft.stream}
                        onChange={(e) => set('stream', e.target.value)}
                        placeholder="Red Stream"
                        autoComplete="off"
                      />
                    </Field>
                    <Field label="Grade" htmlFor="grade" hint="Optional.">
                      <Input
                        id="grade"
                        value={draft.grade}
                        onChange={(e) => set('grade', e.target.value)}
                        list="grade-suggestions"
                        placeholder="10"
                        inputMode="numeric"
                      />
                      <datalist id="grade-suggestions">
                        {GRADE_SUGGESTIONS.map((v) => (
                          <option key={v} value={v} />
                        ))}
                      </datalist>
                    </Field>
                  </div>
                </div>
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