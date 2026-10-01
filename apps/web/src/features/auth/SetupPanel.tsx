/**
 * The sign-in screen, and the first-account setup.
 *
 * ── Two screens, one component ──────────────────────────────────────
 *
 * On a brand-new app there are no accounts, so a sign-in form is a dead end: the
 * first person to open the system has nothing to sign in with. `firstRun` swaps
 * in "create the librarian account" instead, which needs a name and a password
 * and nothing else.
 *
 * The distinction matters because the very first account is always an
 * administrator, whoever it turns out to be. Somebody has to be able to create
 * the others, and letting the first sign-up pick its own role would let the
 * school lock itself out of its own register.
 *
 * ── Creating an account does not sign you in ───────────────────────
 *
 * It goes to the sign-in form instead, with the address already filled in and the
 * same password, and signs in.
 *
 * Creating an account and signing in are different acts, and conflating them had
 * two costs. The setup screen went straight into the application, so the sign-in
 * form was only ever seen by somebody who already knew the app existed — it was
 * decoration rather than a working path. And it gave the domain two doors that
 * open a session instead of one, which is how a session ends up existing that was
 * never signed in through.
 *
 * The address carries across so it is not retyped. The password is used, not
 * shown: a field prefilled with a password is a password on a shoulder.
 *
 * ── What this screen deliberately does not do ───────────────────────
 *
 * It does not offer a "forgot password" link. There is no mail server behind
 * this yet, and a link that says "email yourself a reset" and then does nothing
 * is worse than no link — it teaches a librarian that this system has features
 * it does not have. The honest thing is to leave it out and say so in the README.
 *
 * It also does not validate a password locally beyond "not empty". Real strength
 * rules belong on a server, where they can be enforced; a rule that only exists
 * in the browser is a suggestion.
 */
import { useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../api'
import { Button, Card, Field, Input, cn } from '../../components/ui'
import { LockKeyhole, SchoolLogo, UserPlus } from '../../components/icons'

export function SetupPanel({
  firstRun,
  onSignedIn,
}: {
  firstRun: boolean
  onSignedIn: () => void | Promise<void>
}) {
  const [tab, setTab] = useState<'signin' | 'signup'>(firstRun ? 'signup' : 'signin')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  /*
   * Set when an account has just been created and the sign-in is pending.
   *
   * Rendered as a short "Signing you in…" state rather than as a form with
   * disabled fields, because the person who just pressed the button is not asking
   * to sign in — they are waiting to get in. Making them watch a form fill in
   * before it works turns one action into two.
   */
  const [pendingSignIn, setPendingSignIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  const go = useMutation({
    mutationFn: async () => {
      const address = email.trim()
      if (tab === 'signup') {
        await api.createUser({ email: address, name: name.trim(), password, role: 'assistant' })
        // Then sign in, with exactly what was just typed. `createUser` opens no
        // session, so this is a real sign-in through the same path every other
        // sign-in takes - not a back door.
        await api.signIn(address, password)
        return
      }
      await api.signIn(address, password)
    },
    onSuccess: () => void onSignedIn(),
    onError: (e: unknown) => {
      setPendingSignIn(false)
      setError(e instanceof Error ? e.message : 'That did not work.')
    },
  })

  const canSubmit = email.trim().length > 2 && password.length > 0
  const needsName = tab === 'signup'

  return (
  // A <main> landmark, so this page is reachable by landmark navigation and a
  // screen reader can skip the crest and the heading to reach the form. Signed
  // out this page has no sidebar around it, so without one there is no main region
  // at all - the whole document would be unlabelled sections.
  <main className="page-wash mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <SchoolLogo size={72} />
        <h1 className="text-xl font-semibold tracking-tight">Welcome to Dandora Secondary School</h1>
        <Marquee />
      </div>

      <Card className="mt-6">
        {/*
          Tabs only when there is a choice to make.

          On a brand-new app the school has no accounts, so offering "sign in" as
          an equal alternative is offering a dead end. The tab bar is hidden until
          somebody has been created.
        */}
        {!firstRun ? (
          <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 border-b border-border">
            <Tab active={tab === 'signin'} onClick={() => { setTab('signin'); setError(null) }}>
              Sign in
            </Tab>
            <Tab active={tab === 'signup'} onClick={() => { setTab('signup'); setError(null) }}>
              Create account
            </Tab>
          </div>
        ) : (
          <div className="border-b border-border px-6 py-4">
            <h2 className="font-medium">Set up the library</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              No accounts exist yet. Create one to look after the library, then sign in
              with it.
            </p>
          </div>
        )}

        <form
          className="grid gap-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            // Signing in straight after creating the account, rather than showing
            // the form for a moment and filling it in visibly.
            if (tab === 'signup') setPendingSignIn(true)
            go.mutate()
          }}
        >
          {pendingSignIn ? (
            <p role="status" className="py-4 text-center text-sm text-muted-foreground">
              Account created. Signing you in…
            </p>
          ) : (
            <>
          {needsName ? (
            <Field label="Your name" htmlFor="name">
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Wanjiru"
                autoComplete="name"
              />
            </Field>
          ) : null}

          <Field label="Email address" htmlFor="email">
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@dandorasecondary.go.ke"
              autoComplete="username"
            />
          </Field>

          <Field label="Password" htmlFor="password">
            <div className="relative">
              <Input
                id="password"
                /*
                 * `type` is switched rather than the value being toggled, so the
                 * browser's own password manager still recognises the field — a
                 * show/hide that replaces the value breaks autofill silently.
                 */
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={needsName ? 'new-password' : 'current-password'}
                className="pr-11"
              />
              {/*
                `type="button"`, and this is not decoration.

                A bare <button> inside a form submits it. A reveal button with no
                type therefore submits the sign-in form, which is a bug that reads
                as "the app signed me in when I pressed the eye".
              */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                aria-pressed={showPassword}
                className="absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
              >
                <LockKeyhole />
              </button>
            </div>
          </Field>

          {error ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={!canSubmit || go.isPending || pendingSignIn}
            size="lg"
            className={cn('w-full')}
          >
            {needsName ? <UserPlus /> : <LockKeyhole />}
            {go.isPending ? 'Working…' : needsName ? 'Create the account' : 'Sign in'}
          </Button>
            </>
          )}
        </form>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Students do not need accounts. Only the staff who run the library sign in.
      </p>
    </main>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'h-12 text-sm font-medium transition-colors',
        active ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * A slowly moving line of what the library does.
 *
 * Present because this screen is what somebody sees while they decide whether to
 * trust a system that is not yet theirs. `motion-reduce` stops it, because a
 * permanent animation on a shared desk is a distraction and on a vestibular
 * disorder it is a reason to close the tab.
 */
function Marquee() {
  const messages = [
    'Record a book issue in seconds',
    'The register, on any phone',
    'Deadlines, returns and fines',
    'Built for the school library desk',
  ]
  return (
    <div
      aria-hidden
      className="overflow-hidden text-sm text-muted-foreground motion-reduce:hidden"
    >
      <div className="animate-[marquee_28s_linear_infinite] whitespace-nowrap">
        {[0, 1].map((copy) => (
          <span key={copy} className="pr-12">
            {messages.join('  ·  ')}  ·{'\u00a0'}
          </span>
        ))}
      </div>
    </div>
  )
}

