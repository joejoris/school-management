/**
 * Student import.
 *
 * ── Dry run is the default, and has to be turned off on purpose ──────
 *
 * A librarian pastes a roster and presses one button. If that button writes, a
 * half-right paste writes 400 rows with blank names and there is no undo. So the
 * button says "Check the file", which reports exactly what would happen, and
 * writing is a separate press that names what it will do.
 *
 * The preview shows the *rejections* before the acceptances, in a deliberate
 * inversion: when something is wrong with a roster the interesting part is which
 * rows will be skipped, and putting those last means they are the ones scrolled
 * past.
 *
 * ── Duplicates are refused, never merged ─────────────────────────────
 *
 * A row whose admission number is already on file is rejected with its number
 * printed. It is not silently updated, because a roster listing "S1" for a
 * student the school knows as "S001" is a different student, and quietly
 * overwriting would file two children's borrowing under one number.
 */
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ImportJob } from '@library/contracts'
import { api } from '../../api'
import { Button, Card, Field, cn } from '../../components/ui'
import { TriangleAlert, Upload } from '../../components/icons'

export function ImportStudents() {
  const queryClient = useQueryClient()
  const [filename, setFilename] = useState('')
  const [contents, setContents] = useState('')
  const [committed, setCommitted] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.startImport({
        kind: 'students',
        filename: filename || 'pasted.csv',
        contents,
        dryRun,
      }),
    onSuccess: async (_job: ImportJob, dryRun) => {
      setCommitted(!dryRun)
      await queryClient.invalidateQueries({ queryKey: ['used-values'] })
      await queryClient.invalidateQueries({ queryKey: ['loans'] })
    },
  })

  const hasFile = contents.trim().length > 0
  const job = run.data

  const header = useMemo(() => {
    const first = contents.split(/\r?\n/).find((l) => l.trim())
    return first ? first.split(',').map((h) => h.trim()) : []
  }, [contents])

  const readFile = async (file: File) => {
    setFilename(file.name)
    setContents(await file.text())
    setCommitted(false)
    run.reset()
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Import students</h1>
        <p className="text-sm text-muted-foreground">
          A comma-separated file or a paste. Nothing is written until you say so.
        </p>
      </header>

      <Card className="grid gap-5 p-6">
        <Field label="File" htmlFor="import-file" hint="Or paste the rows below.">
          <input
            id="import-file"
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void readFile(f)
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
              <Upload /> Choose a file
            </Button>
            {filename ? <span className="text-sm text-muted-foreground">{filename}</span> : null}
          </div>
        </Field>

        <Field
          label="Rows"
          htmlFor="import-contents"
          hint={
            header.length > 0
              ? `Columns seen: ${header.join(', ')}. A column called member_code, admission or code carries the admission number.`
              : 'One student per line, comma separated, with a header row.'
          }
        >
          <textarea
            id="import-contents"
            value={contents}
            onChange={(e) => {
              setContents(e.target.value)
              setCommitted(false)
              run.reset()
            }}
            rows={8}
            className="w-full rounded-lg border border-input bg-card p-3 font-mono text-sm"
            placeholder={'member_code, first_name, last_name\nS001,Kept,Student'}
          />
        </Field>

        <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-5">
          <Button
            type="button"
            variant="outline"
            disabled={!hasFile || run.isPending}
            onClick={() => run.mutate(true)}
          >
            Check the file
          </Button>
          {/*
            The writing button, named for what it does.

            "Check" reads 400 rows and changes nothing. "Add these students"
            cannot be mistaken for it, and a button labelled only "Import" is the
            one most likely to be pressed twice.
          */}
          <Button
            type="button"
            disabled={!hasFile || run.isPending || !job || job.rowsAccepted === 0}
            onClick={() => run.mutate(false)}
            className={cn(job && job.rowsAccepted > 0 && 'bg-primary')}
          >
            {run.isPending ? 'Working…' : `Add ${job?.rowsAccepted ?? 0} students`}
          </Button>
        </div>
      </Card>

      {run.isError ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{run.error instanceof Error ? run.error.message : 'That file could not be read.'}</span>
        </p>
      ) : null}

      {job ? (
        <section
          aria-label="What would happen"
          className={cn(
            'rounded-xl border p-5',
            job.rowsRejected > 0 ? 'border-accent bg-accent/25' : 'border-border bg-card',
          )}
        >
          <h2 className="font-semibold">
            {committed ? 'Imported' : 'This is what would happen'}
          </h2>

          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <Stat label="Rows read" value={job.rowsRead} />
            <Stat label="Would add" value={job.rowsAccepted} tone={job.rowsAccepted > 0 ? 'good' : undefined} />
            <Stat label="Rejected" value={job.rowsRejected} tone={job.rowsRejected > 0 ? 'bad' : undefined} />
          </dl>

          {job.rowsRejected > 0 ? (
            <>
              <h3 className="mt-5 text-sm font-medium">Rows that will be skipped</h3>
              <ul className="mt-2 grid gap-1 text-sm">
                {job.errors.slice(0, 50).map((e, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2 text-muted-foreground">
                    <span className="numeric text-ink">Row {e.row}</span>
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
              {job.errors.length > 50 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  and {job.errors.length - 50} more.
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'good' | 'bad'
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'numeric text-lg font-semibold',
          tone === 'good' && 'text-primary',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </dd>
    </div>
  )
}