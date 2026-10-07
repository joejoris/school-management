/**
 * The catalogue: the books the library holds.
 *
 * ── Why this screen exists at all ───────────────────────────────────
 *
 * Because without it the app cannot do its one job. Issuing a book means typing a
 * barcode, and a barcode has to already be on file — and nothing could put one
 * there. The register, returns and fines were all implemented, tested and
 * unreachable, because there was never a book to put in them.
 *
 * ── A title and a copy are two things ───────────────────────────────
 *
 * "Things We Carry" is a title. "BK-0001" is one physical copy of it, and it is
 * the copy that goes out, comes back and gets reported lost.
 *
 * This is the distinction the desk actually works in. A librarian is issued the
 * *copy*, not the title, so the copy is what the register shows and what can be
 * issued. The title is how the shelf is ordered and how a search finds it.
 *
 * ── "Available" means issuable, not merely present ───────────────────
 *
 * A book on the repair shelf is in the collection and cannot be lent. Counting it
 * as available is how somebody walks to the wrong shelf, so availability is read
 * from the domain's own list of issuable statuses rather than counted as "copies
 * minus copies on loan".
 */
import { useState, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TitleDetail, TitleSummary } from '@library/contracts'
import { api } from '../../api'
import { Button, Card, Field, Input, cn } from '../../components/ui'
import { BookPlus, Pencil, Plus, Search, TriangleAlert } from '../../components/icons'
import { CopyActions } from './CopyActions'

const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' })

/** How a copy's status reads on the shelf. */
const STATUS_LABEL: Record<string, string> = {
  on_shelf: 'On the shelf',
  on_loan: 'Out',
  in_transit: 'In transit',
  at_desk: 'At the desk',
  withdrawn: 'Withdrawn',
  lost: 'Lost',
  in_repair: 'In repair',
}

export function Catalogue() {
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const titles = useQuery({
    queryKey: ['titles', q],
    queryFn: () => api.searchTitles({ limit: 100, offset: 0, q: q.trim() || undefined }),
    // Long enough that typing does not fire a search per keystroke, short enough
    // that a book added on the other screen appears without a reload.
    staleTime: 5_000,
  })

  const addCopies = useMutation({
    mutationFn: (input: { titleId: string; count: number }) => api.addCopies(input),
    onSuccess: async (_made, input) => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['titles'] })
      await queryClient.invalidateQueries({ queryKey: ['title', input.titleId] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not add those.'),
  })

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Catalogue</h1>
        <p className="text-sm text-muted-foreground">
          Every book the library holds. Add a title, then add the copies.
        </p>
      </header>

      <AddTitle onAdded={async () => {
        await queryClient.invalidateQueries({ queryKey: ['titles'] })
      }} />

      <Card className="p-4">
        <Field label="Search" htmlFor="catalogue-search">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="catalogue-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Title, author, ISBN or shelf number"
              className="pl-9"
            />
          </div>
        </Field>
      </Card>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      {titles.isPending ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading the catalogue…</p>
      ) : titles.isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Could not load the catalogue. {titles.error instanceof Error ? titles.error.message : ''}
        </p>
      ) : titles.data && titles.data.items.length === 0 ? (
        <EmptyCatalogue searching={q.trim().length > 0} />
      ) : (
        <ul className="grid gap-3">
          {titles.data?.items.map((t) => (
            <li key={t.id}>
              <TitleRow
                title={t}
                open={expanded === t.id}
                onToggle={() => setExpanded((e) => (e === t.id ? null : t.id))}
                onAddCopies={(count) => addCopies.mutate({ titleId: t.id, count })}
                busy={addCopies.isPending}
              />
            </li>
          ))}
        </ul>
      )}

      {titles.data && titles.data.hasMore ? (
        <p className="text-center text-sm text-muted-foreground">
          Showing {titles.data.items.length} of {titles.data.total}. Narrow the search to see
          the rest.
        </p>
      ) : null}
    </div>
  )
}

function EmptyCatalogue({ searching }: { searching: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <BookPlus className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-3 font-medium">
        {searching ? 'Nothing matches that search.' : 'The catalogue is empty.'}
      </p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        {searching
          ? 'Search covers the title, the author, the ISBN and the shelf number.'
          : 'Add a title above to get started. You will need at least one copy before a book can be issued.'}
      </p>
    </div>
  )
}

/** One title, and — when opened — its copies. */
function TitleRow({
  title,
  open,
  onToggle,
  onAddCopies,
  busy,
}: {
  title: TitleSummary
  open: boolean
  onToggle: () => void
  onAddCopies: (count: number) => void
  busy: boolean
}) {
  const [count, setCount] = useState('1')

  const copies = useQuery({
    queryKey: ['title', title.id],
    queryFn: () => api.getTitle(title.id),
    enabled: open,
    staleTime: 5_000,
  })

  const none = title.availableCount === 0

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{title.title}</p>
          <p className="truncate text-sm text-muted-foreground">
            {title.author}
            {title.callNumber ? ` · ${title.callNumber}` : ''}
          </p>
        </div>

        <div className="shrink-0 text-right">
          {/*
            Availability in words as well as a number.

            "0/3" needs doing arithmetic to interpret, and the arithmetic changes what
            the librarian has to do next — find another copy, or check the shelf.
          */}
          <p
            className={cn(
              'numeric text-sm font-medium',
              none ? 'text-destructive' : 'text-foreground',
            )}
          >
            {title.availableCount} of {title.copyCount} available
          </p>
          {none ? <p className="text-xs text-destructive">None on the shelf</p> : null}
        </div>
      </button>

      {open ? (
        <div className="border-t border-border bg-secondary/25 px-4 py-4">
          {copies.isPending ? (
            <p className="text-sm text-muted-foreground">Loading the copies…</p>
          ) : copies.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Could not load the copies.
            </p>
          ) : (
            <>
              {/*
                The individual copies, because the copy is what gets issued and the
                number is on the spine. A count alone does not tell a librarian which
                book to walk to.
              */}
              <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {copies.data?.copies.map((c) => (
                  <li
                    key={c.id}
                    className="grid grid-cols-[1fr_auto] items-start gap-x-2 gap-y-1 rounded-md bg-card px-2.5 py-1.5 text-sm"
                  >
                    <span className="numeric font-medium">{c.barcode}</span>
                    <span
                      className={cn(
                        'text-xs',
                        c.status === 'on_shelf' ? 'text-muted-foreground' : 'text-destructive',
                      )}
                    >
                      {STATUS_LABEL[c.status] ?? c.status}
                      {/* The condition matters even when the copy is lendable: a
                          scuffed book is still issued, and a librarian looking for
                          "is this one any good" should not have to open it. */}
                      {c.condition !== 'good' ? ' · ' + c.condition : ''}
                    </span>

                    <CopyActions copy={c} />
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
                <div className="w-28">
                  <Field label="Copies to add" htmlFor={`add-${title.id}`}>
                    <Input
                      id={`add-${title.id}`}
                      value={count}
                      onChange={(e) => setCount(e.target.value)}
                      inputMode="numeric"
                      className="numeric"
                    />
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !isWholeNumber(count)}
                  onClick={() => onAddCopies(Number(count))}
                >
                  <Plus /> Add
                </Button>
              </div>

              <TitleDetails title={copies.data} />

              <WaitingList titleId={title.id} />
            </>
          )}
        </div>
      ) : null}
    </Card>
  )
}

/**
 * Whether a count is a number somebody could have meant.
 *
 * Not `!isNaN`: `Number('')` is 0 and `Number(' ')` is 0, so an empty box would
 * silently mean "add none" rather than "nothing typed yet".
 */
function isWholeNumber(v: string): boolean {
  return /^[1-9]\d*$/.test(v.trim())
}

/** The title's editable fields, as the form holds them — blank, never null. */
function detailsFrom(t: TitleDetail) {
  return {
    title: t.title,
    author: t.author,
    isbn: t.isbn ?? '',
    publisher: t.publisher ?? '',
    publishedYear: t.publishedYear?.toString() ?? '',
    subject: t.subject ?? '',
    callNumber: t.callNumber ?? '',
  }
}

/** A trimmed box that was left empty is "nothing", not the empty string. */
const orNull = (v: string): string | null => (v.trim().length > 0 ? v.trim() : null)

/** A year that is a whole number, or nothing. `Number('')` is 0, which is no year. */
function yearOrNull(v: string): number | null {
  if (v.trim().length === 0) return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

/**
 * Correcting a title's own details.
 *
 * A title's metadata is what a search finds and what a shelf label prints, so
 * getting it right matters and getting it wrong is ordinary: an author spelled
 * wrong at cataloguing, an ISBN added a term later, a shelf number that moved.
 *
 * The copies are not here. A copy is the thing with a barcode — added, marked
 * lost, withdrawn — and each of those is its own act with its own permission.
 * This form is only the row above them.
 *
 * `titles.write` is the permission and it belongs to the database: the live
 * backend PATCHes under the `titles_update` policy, and a desk without it — an
 * assistant reads the catalogue but does not rewrite it — gets the domain's
 * sentence rather than a button that was quietly hidden.
 */
function TitleDetails({ title }: { title: TitleDetail }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState(() => detailsFrom(title))

  const save = useMutation({
    mutationFn: () =>
      api.updateTitle(title.id, {
        title: form.title.trim(),
        author: form.author.trim(),
        isbn: orNull(form.isbn),
        publisher: orNull(form.publisher),
        publishedYear: yearOrNull(form.publishedYear),
        subject: orNull(form.subject),
        callNumber: orNull(form.callNumber),
      }),
    onSuccess: async () => {
      setError(null)
      setSaved(true)
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['titles'] })
      await queryClient.invalidateQueries({ queryKey: ['title', title.id] })
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'Could not save those details.'),
  })

  // Re-seeded on each open, so a form left half-edited and closed does not come
  // back holding fields the row no longer has.
  const openForm = () => {
    setForm(detailsFrom(title))
    setError(null)
    setSaved(false)
    setOpen(true)
  }

  const canSave =
    form.title.trim().length > 0 &&
    form.author.trim().length > 0 &&
    (form.publishedYear.trim().length === 0 || yearOrNull(form.publishedYear) !== null)

  const set = (k: keyof ReturnType<typeof detailsFrom>) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-medium">Title details</h4>
        {!open ? (
          <Button type="button" size="sm" variant="outline" onClick={openForm}>
            <Pencil className="size-4" /> Edit details
          </Button>
        ) : null}
      </div>

      {saved && !open ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Saved. The catalogue now shows those details.
        </p>
      ) : null}

      {open ? (
        <form
          className="mt-3 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            save.mutate()
          }}
        >
          <Field label="Title" htmlFor={`edit-title-${title.id}`}>
            <Input id={`edit-title-${title.id}`} value={form.title} onChange={set('title')} autoFocus />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Author" htmlFor={`edit-author-${title.id}`}>
              <Input id={`edit-author-${title.id}`} value={form.author} onChange={set('author')} />
            </Field>

            <Field label="ISBN" htmlFor={`edit-isbn-${title.id}`} hint="Optional.">
              <Input
                id={`edit-isbn-${title.id}`}
                value={form.isbn}
                onChange={set('isbn')}
                className="numeric"
              />
            </Field>

            <Field label="Publisher" htmlFor={`edit-publisher-${title.id}`} hint="Optional.">
              <Input
                id={`edit-publisher-${title.id}`}
                value={form.publisher}
                onChange={set('publisher')}
              />
            </Field>

            <Field label="Published" htmlFor={`edit-year-${title.id}`} hint="Optional. The year.">
              <Input
                id={`edit-year-${title.id}`}
                value={form.publishedYear}
                onChange={set('publishedYear')}
                inputMode="numeric"
                className="numeric"
              />
            </Field>

            <Field label="Subject" htmlFor={`edit-subject-${title.id}`} hint="Optional.">
              <Input
                id={`edit-subject-${title.id}`}
                value={form.subject}
                onChange={set('subject')}
              />
            </Field>

            <Field label="Shelf number" htmlFor={`edit-call-${title.id}`} hint="Optional.">
              <Input
                id={`edit-call-${title.id}`}
                value={form.callNumber}
                onChange={set('callNumber')}
                className="numeric"
              />
            </Field>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save the details'}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

/**
 * Who is waiting for a title, and how the desk adds the next person.
 *
 * A hold is the promise that the first member in line gets the next copy back.
 * That promise hangs on the title, not on any one copy, so it lives here beside
 * the copies — and it is written down at the desk, in front of the student,
 * which is the only honest way to take an order for a book that is out.
 *
 * Placement and cancellation are administrators' acts (`holds.write`), the same
 * permission the live database hangs on the holds table; every other screen in
 * the app hands an unfamiliar user the domain's refusal sentence rather than
 * hiding the control, and this one does the same.
 */
function WaitingList({ titleId }: { titleId: string }) {
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const queue = useQuery({
    queryKey: ['queue', titleId],
    queryFn: async () => {
      const holds = await api.getHoldQueue(titleId)
      // The queue is people first: a list of ids would make the desk count.
      const members = await Promise.all(holds.map((h) => api.getMember(h.memberId)))
      return holds.map((h, i) => ({ hold: h, member: members[i]! }))
    },
    staleTime: 5_000,
  })

  const place = useMutation({
    mutationFn: async () => {
      const member = await api.findMemberByCode(code.trim())
      if (!member) throw new Error('No member with that admission number.')
      await api.placeHold({ memberId: member.id, titleId })
    },
    onSuccess: async () => {
      setCode('')
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['queue', titleId] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not place that hold.'),
  })

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelHold(id),
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['queue', titleId] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not cancel that hold.'),
  })

  const rows = queue.data ?? []

  return (
    <div className="mt-4 border-t border-border pt-4">
      <h4 className="text-sm font-medium">Waiting list</h4>

      {queue.isError ? (
        <p role="alert" className="mt-1 text-sm text-destructive">
          Could not load the waiting list.
        </p>
      ) : queue.isPending ? (
        <p className="mt-1 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Nobody is waiting for this title.</p>
      ) : (
        <ol className="mt-2 grid gap-1.5">
          {rows.map(({ hold, member }, i) => (
            <li
              key={hold.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-card px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="numeric text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    <span className="numeric">{member.memberCode}</span> — {member.firstName}{' '}
                    {member.lastName}
                  </span>
                  <span className="text-xs text-muted-foreground">since {date(hold.placedAt)}</span>
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(hold.id)}
              >
                Cancel
              </Button>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Field label="Hold for a student" htmlFor={`hold-${titleId}`}>
            <Input
              id={`hold-${titleId}`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Admission number"
              autoCapitalize="characters"
              className="numeric"
            />
          </Field>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={place.isPending || code.trim().length === 0}
          onClick={() => place.mutate()}
        >
          {place.isPending ? 'Holding…' : 'Hold'}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Adding a title, and its first copies.
 *
 * Copies are asked for here rather than afterwards because the most common reason
 * somebody adds a book is to lend it this afternoon, and making that two screens
 * and a second press is how a book ends up entered with no copy and can never be
 * issued.
 */
function AddTitle({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [isbn, setIsbn] = useState('')
  const [copies, setCopies] = useState('1')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () =>
      api.createTitle({
        title: title.trim(),
        author: author.trim(),
        isbn: isbn.trim() || null,
        copyCount: Number(copies),
      }),
    onSuccess: async () => {
      // Cleared rather than kept: the next book is a different book, and a form
      // holding the last one's details invites the same title twice.
      setTitle('')
      setAuthor('')
      setIsbn('')
      setCopies('1')
      setError(null)
      setOpen(false)
      await onAdded()
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not add that book.'),
  })

  const canSubmit = title.trim().length > 0 && author.trim().length > 0 && isWholeNumber(copies)

  if (!open) {
    return (
      <div>
        <Button type="button" onClick={() => setOpen(true)}>
          <BookPlus /> Add a book
        </Button>
      </div>
    )
  }

  return (
    <Card className="p-5">
      <h2 className="font-medium">Add a book</h2>

      <form
        className="mt-4 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          add.mutate()
        }}
      >
        <Field label="Title" htmlFor="new-title">
          <Input
            id="new-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Things We Carry"
            autoFocus
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Author" htmlFor="new-author">
            <Input
              id="new-author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Tim O’Brien"
            />
          </Field>

          <Field label="ISBN" htmlFor="new-isbn" hint="Optional.">
            <Input
              id="new-isbn"
              value={isbn}
              onChange={(e) => setIsbn(e.target.value)}
              className="numeric"
            />
          </Field>

          <Field label="Copies" htmlFor="new-copies" hint="How many physical books.">
            <Input
              id="new-copies"
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
              inputMode="numeric"
              className="numeric"
            />
          </Field>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add the book'}
          </Button>
        </div>
      </form>
    </Card>
  )
}