/**
 * Who is at the desk, and what they get to see.
 *
 * ── The sidebar is not part of the signed-out page ──────────────────
 *
 * This is a layout decision, and it is the difference between a sign-in screen
 * and a web page with a sign-in form in the corner of it.
 *
 * The sidebar used to wrap everything. That put four navigation links — Record
 * issue, Register, Import, Backup — beside a form that could not use any of them,
 * because signed out, the domain refuses every one of those actions. Every link
 * was a promise the app could not keep. Worse, the app's first impression became
 * a navigation menu rather than "you are not signed in, here is how to sign in".
 *
 * So the gate is above the sidebar, not inside it: nobody gets the chrome until
 * they have earned it.
 *
 * ── There is no /login route ────────────────────────────────────────
 *
 * Signed out, this layout renders the panel instead of the router's outlet. There
 * is nothing to navigate to while signed out, so there is nothing for a URL to
 * point at. Adding `/login` would mean a redirect to get here, and every redirect
 * is a chance to loop or to lose the path somebody was trying to reach.
 */
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { Shell } from '../../shell'
import { SetupPanel } from './SetupPanel'

/**
 * How long to wait before deciding nobody is signed in.
 *
 * `currentUser()` is a network call, and without a deadline a phone on a weak
 * connection leaves this blank indefinitely — which looks like a broken app rather
 * than a slow one.
 *
 * It fails to "signed out", deliberately. That is the recoverable direction:
 * somebody can read the panel and act on it. Treating a timeout as "signed in"
 * would show an app whose every action is about to be refused.
 */
const DEADLINE_MS = 15_000

export function AuthLayout() {
  const queryClient = useQueryClient()
  const [timedOut, setTimedOut] = useState(false)

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.currentUser(),
    staleTime: 30_000,
    retry: false,
  })

  const accounts = useQuery({
    queryKey: ['has-accounts'],
    queryFn: () => api.hasAccounts(),
    staleTime: 60_000,
    retry: false,
    // Only worth asking while nobody is signed in; a signed-in librarian does not
    // need it, and it is a round trip saved on every load.
    enabled: !session.data,
  })

  /*
   * Arm a deadline, and clear it the moment the check answers.
   *
   * `isPending` alone is not enough: on a dropped request it stays true and the
   * screen says "Checking…" forever, which reads as a broken app rather than a slow
   * network.
   */
  useEffect(() => {
    if (!session.isPending) {
      setTimedOut(false)
      return
    }
    const t = setTimeout(() => setTimedOut(true), DEADLINE_MS)
    return () => clearTimeout(t)
  }, [session.isPending])

  const onSignedIn = async () => {
    await queryClient.invalidateQueries({ queryKey: ['session'] })
    await queryClient.invalidateQueries({ queryKey: ['has-accounts'] })
  }

  // No chrome is shown while undecided — a sidebar that appears and then vanishes
  // is worse than a moment's wait.
  if (session.isPending && !timedOut) {
    return (
      <p role="status" className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        Checking…
      </p>
    )
  }

  if (!session.data) {
    // Signed out, or still deciding. Either way: the panel, and nothing else.
    //
    // `firstRun` is `accounts.data !== true` rather than `=== false`, because a
    // timed-out check leaves it `undefined` — which is neither. Reading that as
    // "there are accounts" would show the sign-in form to the first person to open
    // a brand-new app, and they would have no way in.
    return <SetupPanel firstRun={accounts.data !== true} onSignedIn={onSignedIn} />
  }

  return <Shell />
}