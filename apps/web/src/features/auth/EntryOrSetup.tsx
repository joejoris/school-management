import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { RecordIssue } from '../issues/RecordIssue'
import { SetupPanel } from './SetupPanel'

/**
 * The gate: who is using this, and if nobody, the first account.
 *
 * ── Why there is a sign-in at all ───────────────────────────────────
 *
 * Students never log in — they have no accounts and never will. But a record of
 * who issued a book is worth having, and that means somebody has to say who they
 * are. Without a session there is no author on a loan, and a register that cannot
 * say who voided a mistake is a register nobody can defend.
 *
 * ── Why it lives at `/` and not at `/login` ─────────────────────────
 *
 * There is no login page in this app. `/` decides what to show: the entry form
 * for a signed-in librarian, the sign-in panel for anyone else, and a one-field
 * setup when the school has no accounts yet.
 *
 * A separate `/login` route means every signed-out visit goes through a redirect,
 * and every redirect is a chance to loop, to lose the path somebody was trying to
 * reach, or to leave a blank screen with no error — which is how this went wrong
 * once already.
 *
 * ── Three states, not two ───────────────────────────────────────────
 *
 * An empty system and a used one are different screens, not the same screen with a
 * message. "No account has been created yet" is an instruction; "sign in" is a
 * dead end for the first person to use the app.
 */

/**
 * How long to wait before deciding nobody is signed in.
 *
 * `hasAccounts()` is a network call, and without a deadline a phone on a weak
 * connection leaves this screen blank indefinitely — which looks like a broken app
 * rather than a slow one.
 */
const DEADLINE_MS = 15_000

export function EntryOrSetup() {
  const queryClient = useQueryClient()
  const [timedOut, setTimedOut] = useState(false)

  const accounts = useQuery({
    queryKey: ['has-accounts'],
    queryFn: () => api.hasAccounts(),
    staleTime: 60_000,
    retry: false,
  })

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.currentUser(),
    staleTime: 30_000,
    retry: false,
  })

  /*
   * Arm a deadline, and clear it the moment the check answers.
   *
   * `isPending` alone is not enough: on a dropped request it stays true and the
   * screen says "Checking…" forever.
   *
   * The failure is to the *setup* screen, deliberately. Setup is recoverable — you
   * can read it and you can leave it — whereas falling through to the sign-in
   * panel because a check timed out tells somebody their account does not exist,
   * which is both alarming and untrue.
   */
  useEffect(() => {
    if (!accounts.isPending) {
      setTimedOut(false)
      return
    }
    const t = setTimeout(() => setTimedOut(true), DEADLINE_MS)
    return () => clearTimeout(t)
  }, [accounts.isPending])

  const onSignedIn = async () => {
    await queryClient.invalidateQueries({ queryKey: ['has-accounts'] })
    await queryClient.invalidateQueries({ queryKey: ['session'] })
  }

  const deciding = !timedOut && (accounts.isPending || session.isPending)

  if (deciding) {
    return (
      <p role="status" className="py-20 text-center text-sm text-muted-foreground">
        Checking…
      </p>
    )
  }

  if (session.data) return <RecordIssue />

  // On a timeout `accounts.data` is undefined, which is neither true nor false.
  // Treating that as "there are accounts" would show the sign-in panel to the first
  // person to open a brand-new app, and they would have no way in.
  return <SetupPanel firstRun={accounts.data !== true} onSignedIn={onSignedIn} />
}