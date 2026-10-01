/**
 * The sign-in screen, and the first-account setup.
 *
 * ── The layout ──────────────────────────────────────────────────────
 *
 * One card, two panels: the school's brand on the left, the form on the right.
 * Side by side on a screen, stacked on a phone.
 *
 * The split is doing real work rather than being decoration. The left panel is
 * the only strongly coloured thing on the page and carries no instructions, so the
 * eye goes to the school first and the form second. On a narrow screen the left
 * panel shrinks to a header strip rather than disappearing — the school name is
 * how somebody confirms they are on the right system before typing a password.
 *
 * ── Two screens, one component ──────────────────────────────────────
 *
 * On a brand-new app there are no accounts, so a sign-in form is a dead end: the
 * first person to open the system has nothing to sign in with. `firstRun` swaps in
 * "set up the library" instead.
 *
 * The distinction matters because the very first account is always an
 * administrator, whoever it turns out to be. Somebody has to be able to create the
 * others, and letting the first sign-up pick its own role would let the school lock
 * itself out of its own register.
 *
 * ── Creating an account does not sign you in ────────────────────────
 *
 * It goes through sign-in, with the address carried across and the same password,
 * and signs in. Creating an account and signing in are different acts; conflating
 * them meant the sign-in form was only ever seen by somebody who already knew the
 * app existed, and it gave the domain two doors that open a session instead of one.
 *
 * ── What this screen deliberately does not do ───────────────────────
 *
 * No "forgot password" link. There is no mail server behind this yet, and a link
 * that says "email yourself a reset" and then does nothing is worse than no link —
 * it teaches a librarian that this system has features it does not have.
 *
 * No local password strength rule either. Strength rules belong on a server where
 * they can be enforced; a rule that only exists in the browser is a suggestion, and
 * a suggestion styled like a rule is worse than none.
 */
import { useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../api'
import { Button, Field, Input, cn } from '../../components/ui'
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
  const [error, setError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  /*
   * Set while the account exists but the sign-in has not finished.
   *
   * A short status rather than a form filling itself in: the person who just pressed
   * the button is not asking to sign in, they are waiting to get in.
   */
  const [pendingSignIn, setPendingSignIn] = useState(false)

  const go = useMutation({
    mutationFn: async () => {
      const address = email.trim()
      if (tab === 'signup') {
        await api.createUser({ email: address, name: name.trim(), password, role: 'assistant' })
        // A real sign-in through the same path every other sign-in takes — not a back
        // door. `createUser` opens no session.
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
    // A <main> landmark: signed out there is no sidebar around this page, so without
    // one the whole document would be unlabelled sections.
    <main className="signin-bg relative min-h-dvh overflow-x-hidden">
      {/*
        The drifting glows. Two of them, positioned off the corners so only part of
        each is ever on screen — a circle centred in the viewport reads as a shape,
        and one cut off by the edge reads as light.
      */}
      <div aria-hidden className="signin-blob signin-blob-1" />
      <div aria-hidden className="signin-blob signin-blob-2" />

      <div className="relative z-10 grid min-h-dvh place-items-center p-6">
        <div
          className={cn(
            'w-full overflow-hidden border border-white/8',
            // 1060px is the design's width. `min()` rather than a fixed value so it
            // never exceeds the viewport, which on a 360px phone would otherwise
            // push the form off the screen sideways.
            'max-w-[1060px]',
            'grid grid-cols-1 lg:grid-cols-[1.05fr_1fr]',
            // 26px: large enough to read as a card rather than a panel.
            'rounded-[26px]',
            // The design's shadow, near-black on near-black. Without it the card is
            // the same value as the page behind it and has no edge.
            'shadow-[0_40px_90px_-25px_rgba(0,0,0,0.85)]',
            'shadow-[0_0_0_1px_rgba(255,255,255,0.03)_inset]',
          )}
        >
          {/* ── Brand panel ─────────────────────────────────────── */}
          <section
            className={cn(
              'relative flex flex-col justify-between overflow-hidden',
              // Gradient stops and angle exactly as designed. On a phone the panel
              // becomes a header strip, so its padding collapses with it.
              'bg-[linear-gradient(155deg,#4f46e5_0%,#7c3aed_42%,#2e1065_100%)]',
              'gap-6 px-6 py-7 sm:px-9 sm:py-9 lg:px-11 lg:py-12',
            )}
          >
            {/*
              A soft highlight in the corner.

              A gradient across the whole panel reads as flat at large sizes; the
              light source is what makes it look like a surface. Two of them, so the
              panel has a near corner and a far one.
            */}
            <div
              aria-hidden
              className="pointer-events-none absolute -top-24 -left-16 size-72 rounded-full bg-white/12 blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -right-20 -bottom-24 size-72 rounded-full bg-fuchsia-300/10 blur-3xl"
            />

            <div className="relative flex flex-col items-center gap-3 lg:items-start">
              <SchoolLogo size={56} />
              {/* "Libra" is the product; the school is who it is for. */}
              <p
                className="text-3xl font-extrabold tracking-tight text-white"
                style={{ fontFamily: '"Plus Jakarta Sans", Inter, system-ui, sans-serif' }}
              >
                Libra
              </p>
              <p className="text-sm text-white/70">Library Management System</p>
            </div>

            <div className="relative flex flex-col gap-5 text-center lg:text-left">
              <div className="flex flex-col gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
                  Welcome to Dandora Secondary School
                </h1>
                <p className="text-sm text-white/70">
                  Record book issues, deadlines and returns from any phone at the desk.
                </p>
              </div>

              {/*
                What the thing does, as three lines rather than a paragraph.

                A librarian deciding whether to trust a system they have not used yet
                wants to know what it will do for them. This is that, and it is on the
                coloured side where there is room for it without crowding the form.

                Hidden on a phone: the panel is a header strip there, and three lines
                of feature copy under the school name pushes the form below the fold.
              */}
              <ul className="hidden flex-col gap-2.5 lg:flex">
                {[
                  'Record a book issue in seconds',
                  'The register, on any phone',
                  'Deadlines, returns and fines',
                ].map((line) => (
                  <li key={line} className="flex items-center gap-2.5 text-sm text-white/80">
                    <Check />
                    {line}
                  </li>
                ))}
              </ul>

              <Marquee />
            </div>
          </section>

          {/* ── Form panel ──────────────────────────────────────── */}
          <section className="flex flex-col bg-[#0d1326]/80 px-6 py-7 sm:px-9 lg:px-11 lg:py-12">
            {/*
              Tabs only when there is a choice to make.

              On a brand-new app the school has no accounts, so offering "sign in" as
              an equal alternative is offering a dead end.
            */}
            {!firstRun ? (
              <div
                role="tablist"
                aria-label="Sign in or create an account"
                className="-mx-2 mb-7 grid grid-cols-2 border-b border-white/10"
              >
                <Tab
                  active={tab === 'signin'}
                  onClick={() => {
                    setTab('signin')
                    setError(null)
                    setPendingSignIn(false)
                  }}
                >
                  Sign in
                </Tab>
                <Tab
                  active={tab === 'signup'}
                  onClick={() => {
                    setTab('signup')
                    setError(null)
                    setPendingSignIn(false)
                  }}
                >
                  Create account
                </Tab>
              </div>
            ) : (
              <div className="mb-7">
                <h2 className="text-lg font-semibold tracking-tight">Set up the library</h2>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  No accounts exist yet. Create one to look after the library, then sign
                  in with it.
                </p>
              </div>
            )}

            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                setError(null)
                if (tab === 'signup') setPendingSignIn(true)
                go.mutate()
              }}
            >
              {pendingSignIn ? (
                <p role="status" className="py-8 text-center text-sm text-muted-foreground">
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
                        className="signin-field"
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
                      className="signin-field"
                    />
                  </Field>

                  <Field label="Password" htmlFor="password">
                    <div className="relative">
                      <Input
                        id="password"
                        /*
                         * `type` is switched rather than the value being toggled, so
                         * the browser's password manager still recognises the field — a
                         * show/hide that replaces the value breaks autofill silently.
                         */
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete={needsName ? 'new-password' : 'current-password'}
                        className="signin-field pr-11"
                      />
                      {/*
                        `type="button"`, and this is not decoration.

                        A bare <button> inside a form submits it. A reveal with no type
                        therefore submits the sign-in form, which reads as "the app
                        signed me in when I pressed the eye".
                      */}
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                        aria-pressed={showPassword}
                        className="absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
                      >
                        <LockKeyhole />
                      </button>
                    </div>
                  </Field>

                  {error ? (
                    <p
                      role="alert"
                      className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
                    >
                      {error}
                    </p>
                  ) : null}

                  <Button
                    type="submit"
                    disabled={!canSubmit || go.isPending || pendingSignIn}
                    size="lg"
                    className={cn(
                      'signin-submit mt-1 w-full font-semibold',
                      // Amber, and only here: the one thing on the page that matters.
                    )}
                  >
                    {needsName ? <UserPlus /> : <LockKeyhole />}
                    {go.isPending ? 'Working…' : needsName ? 'Create the account' : 'Sign in'}
                  </Button>
                </>
              )}
            </form>

            <p className="mt-6 text-center text-xs text-muted-foreground lg:text-left">
              Students do not need accounts. Only the staff who run the library sign in.
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}

/**
 * A tick, in a ring.
 *
 * Drawn rather than an icon font: the design already loads Inter, and a checkmark
 * drawn in the accent colour is the one place the brand's amber appears outside the
 * button — which keeps it meaning "this is done" rather than "click me".
 */
function Check() {
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-full bg-white/12 ring-1 ring-white/20"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-3"
        fill="none"
        stroke="#fbbf24"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m5 13 4 4L19 7" />
      </svg>
    </span>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative h-11 text-sm font-medium transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      {/*
        The underline is a sibling, not a border.

        A `border-b` sits inside the tab and shifts the text by a pixel when it
        appears, which reads as a jump. Absolutely positioned, it overlays the same
        space whether or not it is there.
      */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-4 -bottom-px h-0.5 rounded-full transition-opacity duration-200',
          // Animated from the centre, so switching tabs reads as one object moving
          // rather than two separate underlines blinking in and out.
          active ? 'signin-tab-underline bg-accent opacity-100' : 'opacity-0',
        )}
      />
    </button>
  )
}

/**
 * A slowly moving line of what the library does.
 *
 * The markup holds two identical copies so the translate has somewhere to go; the
 * animation ends at exactly -50%, or a seam appears where one copy ends.
 *
 * Hidden under `motion-reduce` — a permanent animation at a shared desk is a
 * distraction, and for somebody with a vestibular disorder it is a reason to close
 * the tab.
 */
function Marquee() {
  const messages = [
    'Record a book issue in seconds',
    'The register, on any phone',
    'Deadlines, returns and fines',
    'Built for the school library desk',
  ]
  return (
    <div aria-hidden className="w-full overflow-hidden text-xs text-white/50 motion-reduce:hidden">
      <div className="animate-[marquee_32s_linear_infinite] whitespace-nowrap">
        {[0, 1].map((copy) => (
          <span key={copy} className="pr-10">
            {messages.join('  ·  ')}  ·{'\u00a0'}
          </span>
        ))}
      </div>
    </div>
  )
}