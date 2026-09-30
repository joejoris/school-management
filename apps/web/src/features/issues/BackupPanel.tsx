/**
 * Backup and restore.
 *
 * ── Why this exists at all ──────────────────────────────────────────
 *
 * Until the database is connected, the records live in one browser. That makes a
 * downloadable copy the only way they leave this machine, and "the person who
 * typed the register closed the browser" is a total loss of a term's work. So the
 * panel says so plainly rather than offering a backup as though it were routine.
 *
 * ── Restore replaces, and says so ───────────────────────────────────
 *
 * There is no merge. Merging two diverged registers silently is how you get a
 * register that is half of each, and the only way to be sure which one is
 * right is to be told which one won. The confirmation names the counts.
 */
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { __mock, resetLocalMirror, storageNote } from '../../api'
import { Button, Card, cn } from '../../components/ui'
import { Archive, TriangleAlert } from '../../components/icons'

export function BackupPanel() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<string | null>(null)
  const [pending, setPending] = useState<{ name: string; counts: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const download = () => {
    const state = __mock.exportState()
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    // The date is in the filename because a school keeps these in a folder by
    // term, and four files called "backup" is four files nobody can choose
    // between.
    a.href = url
    a.download = `library-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    // Revoked immediately: a blob URL left alive holds a term's records in memory
    // for as long as the tab is open.
    URL.revokeObjectURL(url)
    setStatus('Backup saved to your downloads.')
  }

  const inspect = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown[]>
      setPending({
        name: file.name,
        counts: `${parsed.students?.length ?? 0} students, ${parsed.books?.length ?? 0} books, ${parsed.loans?.length ?? 0} loans`,
      })
      setStatus(null)
    } catch {
      setPending(null)
      setStatus('That file is not a library backup.')
    }
  }

  const restore = () => {
    if (!pending) return
    const input = fileInput.current?.files?.[0]
    if (!input) return
    void (async () => {
      try {
        __mock.importState(JSON.parse(await input.text()))
        setStatus('Restored. Reloading…')
        await queryClient.invalidateQueries()
        // A full reload rather than a query invalidation: the in-memory domain
        // has been replaced wholesale, and anything still holding a reference to
        // the old records would render a mixture of the two.
        setTimeout(() => location.reload(), 600)
      } catch (e) {
        setPending(null)
        setStatus(e instanceof Error ? e.message : 'That backup could not be read.')
      }
    })()
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Backup</h1>
        <p className="text-sm text-muted-foreground">Take a copy, or put one back.</p>
      </header>

      <Card className="grid gap-5 p-6">
        <div className="flex items-start gap-3 rounded-lg border border-accent bg-accent/40 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>{storageNote}</p>
        </div>

        <section className="grid gap-3">
          <h2 className="font-medium">Save a copy</h2>
          <p className="text-sm text-muted-foreground">
            Everything in this browser — students, books, loans and fines — as one file.
          </p>
          <div>
            <Button type="button" variant="outline" onClick={download}>
              <Archive /> Download a backup
            </Button>
          </div>
        </section>

        <section className="grid gap-3 border-t border-border pt-5">
          <h2 className="font-medium">Put a copy back</h2>
          <p className="text-sm text-muted-foreground">
            This replaces everything currently here. It does not merge, because two
            registers merged without anybody choosing is a register nobody can trust.
          </p>

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void inspect(f)
            }}
          />

          {pending ? (
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm">
                <strong className="font-medium">{pending.name}</strong> — {pending.counts}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Everything currently here will be replaced.
              </p>
              <div className="mt-3 flex gap-2">
                <Button type="button" variant="danger" onClick={restore}>
                  Replace everything
                </Button>
                <Button type="button" variant="ghost" onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
                Choose a backup file
              </Button>
            </div>
          )}
        </section>

        <section className="grid gap-3 border-t border-border pt-5">
          <h2 className="font-medium">Start over</h2>
          <p className="text-sm text-muted-foreground">
            Clears everything in this browser. Download a backup first if you might
            want any of it.
          </p>
          <div>
            <Button type="button" variant="ghost" className={cn('text-destructive')} onClick={resetLocalMirror}>
              Clear this browser's records
            </Button>
          </div>
        </section>
      </Card>

      {status ? (
        <p role="status" className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
          {status}
        </p>
      ) : null}
    </div>
  )
}