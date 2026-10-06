/**
 * Backup and restore.
 *
 * ── Why the download goes through the seam ────────────────────────────
 *
 * It used to call `__mock.exportState()` directly, which meant that with the live
 * system connected it quietly downloaded the empty in-memory practice store — a
 * file with everything a term of work would have had in it, all zero. A backup
 * that produces an empty file when pointed at a real database is worse than no
 * backup, because it looks like it worked.
 *
 * So both actions are `api.exportBackup()` and `api.importBackup()`: the screen
 * asks the connected backend for its records and never reaches past the seam.
 *
 * ── Restore replaces, and says so ───────────────────────────────────
 *
 * There is no merge. Merging two diverged registers silently is how you get a
 * register that is half of each, and the only way to be sure which one is
 * right is to be told which one won. The confirmation names the counts.
 *
 * On the live system there is no restore at all, and the panel says that rather
 * than offering a file picker that always refuses: the database has no deletes
 * and only its own functions may write loans and fines, so "replace everything"
 * from a browser is not something it can honestly promise. Putting records back
 * is done from the system itself.
 */
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, __mode, resetLocalMirror, storageNote } from '../../api'
import { Button, Card, cn } from '../../components/ui'
import { Archive, TriangleAlert } from '../../components/icons'

export function BackupPanel() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<string | null>(null)
  const [pending, setPending] = useState<{ name: string; counts: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const download = async () => {
    try {
      const state = await api.exportBackup()
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
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not download backup.')
    }
  }

  const inspect = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      // The keys the snapshot actually carries. It used to read `students` and
      // `books`, which have never been the keys — so every preview promised
      // "0 students, 0 books" for a file full of both, and a librarian choosing
      // between two backups saw no reason to prefer either.
      const count = (key: string): number => {
        const value = parsed[key]
        return Array.isArray(value) ? value.length : 0
      }
      setPending({
        name: file.name,
        counts: `${count('members')} students, ${count('copies')} books, ${count('loans')} loans`,
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
        const parsed = JSON.parse(await input.text())
        const result = await api.importBackup(parsed)
        if (!result.ok) {
          setPending(null)
          setStatus(result.message)
          return
        }
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
        <p className="text-sm text-muted-foreground">
          {__mode === 'mock' ? 'Take a copy, or put one back.' : 'Take a copy of the school’s records.'}
        </p>
      </header>

      <Card className="grid gap-5 p-6">
        <div className="flex items-start gap-3 rounded-lg border border-accent bg-accent/40 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>{storageNote}</p>
        </div>

        <section className="grid gap-3">
          <h2 className="font-medium">Save a copy</h2>
          <p className="text-sm text-muted-foreground">
            {__mode === 'mock'
              ? 'Everything in this browser — students, books, loans and fines — as one file.'
              : 'Every student, book, loan and fine on the school’s system — as one file you keep.'}
          </p>
          <div>
            <Button type="button" variant="outline" onClick={() => void download()}>
              <Archive /> Download a backup
            </Button>
          </div>
        </section>

        {__mode === 'mock' ? (
          <>
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
          </>
        ) : (
          <section className="grid gap-3 border-t border-border pt-5">
            <h2 className="font-medium">A copy, not something to put back</h2>
            <p className="text-sm text-muted-foreground">
              The records live on the school’s system, not in this browser. A backup file is a copy
              you keep for safekeeping; the system cannot rewrite the register from a file.
            </p>
          </section>
        )}
      </Card>

      {status ? (
        <p role="status" className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
          {status}
        </p>
      ) : null}
    </div>
  )
}