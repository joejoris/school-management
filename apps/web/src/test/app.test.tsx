/**
 * The app, mounted.
 *
 * These are the tests that stand in for opening the app in a browser. A build
 * succeeding proves the code compiles; it does not prove `/` renders anything, and
 * the failure this guards against — a route that resolves to nothing — shows up
 * as a blank page with no error anywhere, which is the most expensive kind of bug
 * to chase from a stack trace.
 *
 * Every test here mounts the real router, the real seam and the real domain. No
 * mocked API, because the whole point is to check that those three fit together.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { api } from '../api'
import { csvField, toCsv } from '../lib/csv'
import { routeTree } from '../routes'
import { __mock } from '../api'

/**
 * A client with retries off.
 *
 * The app's real client retries once. A test that inherits that waits twice as
 * long on every negative case and, worse, reports a timeout rather than the
 * refusal that actually happened.
 */
function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
}

function mount(path = '/') {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  const ui: ReactNode = (
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return { router, user: userEvent.setup(), ...render(ui) }
}

/**
 * The seam's backend is a module-level singleton, so records created by one test
 * are still there for the next one.
 *
 * `beforeEach` clears localStorage, which covers the mirror but not the object
 * itself. Without this, the first test that created an account would leave it
 * behind and every later test would sign itself in by accident — the same
 * leak-shaped failure as a mock that is not reset, but quieter, because nothing
 * reports it.
 */
beforeEach(() => {
  __mock.reset()
})

/**
 * Mount as somebody already at the desk.
 *
 * Two calls, because creating an account and signing in are two different acts.
 * They used to be one — `createUser` opened a session — and collapsing them meant
 * the sign-in path was only ever exercised by the first person to open a
 * brand-new app. Every test below now says plainly which act it is performing.
 *
 * Arranged `before` the render rather than through the form, because the form's own
 * behaviour is what the entry-form tests are about.
 */
async function mountSignedIn(path = '/', arrange?: () => Promise<unknown>) {
  /*
   * Create the account only if it is not already there.
   *
   * This helper used to call `createUser` unconditionally, which is fine for one
   * mount per test and fails on the second — "There is already an account with that
   * email address" — so a test that wanted to walk several destinations could not.
   * Signing in when the account exists is the same arrangement from the screen's
   * point of view and makes the helper safe to call twice.
   */
  if (!(await api.hasAccounts())) {
    await api.createUser({
      email: 'head@dandorasecondary.go.ke',
      name: 'Head Librarian',
      password: 'x',
      role: 'admin',
    })
  }
  await api.signIn('head@dandorasecondary.go.ke', 'x')
  // `arrange` runs after signing in and before the first render, so a test that
  // needs a student on file gets a component whose very first paint already knows
  // about them. Asserting on the second render of a form proves less than it looks
  // like it proves.
  if (arrange) await arrange()
  return mount(path)
}

describe('the landing screen', () => {
  test('/ is the entry form, and it is rendered there directly', async () => {
    await mountSignedIn('/')

    // The assertion that matters: the heading is present on first render. If a
    // loader ever redirects `/` to `/` this fails, which is the loop that was
    // tried once and presented as a blank screen.
    expect(await screen.findByRole('heading', { name: /record a book issue/i })).toBeInTheDocument()
  })

  test('there is no dashboard in front of the entry form', async () => {
    await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    // A librarian's job is recording a book, not reading counts. A summary panel
    // above the form pushes the admission number off a phone screen.
    expect(screen.queryByText(/books on loan/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/total titles/i)).not.toBeInTheDocument()
  })

  test('no route asks for a separate login page', async () => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/login'] }) })
    await router.load()

    // Not a redirect to `/` and not a redirect to a dashboard: the path simply
    // does not exist, and the catch-all says so.
    expect(router.state.location.pathname).toBe('/login')
    expect(router.matchRoutes(router.state.location.pathname).length).toBeGreaterThan(0)
  })

  test('an unknown path says so rather than silently landing on the entry form', async () => {
    await mountSignedIn('/nope')
    // A stale bookmark that quietly lands on the entry form looks like it worked,
    // and the difference is discovered a week later by the person who clicked it.
    expect(await screen.findByRole('heading', { name: /that page is not here/i })).toBeInTheDocument()
  })

  test('every destination in the rail exists', async () => {
    await mountSignedIn('/')
    const rail = await screen.findByRole('navigation', { name: /main/i })
    for (const label of ['Record issue', 'Register', 'Import', 'Backup']) {
      const link = within(rail).getByRole('link', { name: new RegExp(label, 'i') })
      expect(link).toHaveAttribute('href', expect.stringMatching(/^\//))
    }
  })
})

describe('the entry form, filled in', () => {
  test('the submit button is unavailable until there is something to record', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    const submit = screen.getByRole('button', { name: /record issue/i })
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText(/admission number/i), 'S001')
    // One field is still not enough: a book number is the other half of the record.
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText(/book number/i), 'BK-0001')
    await waitFor(() => expect(submit).toBeEnabled())
  })

  test('an admission number nobody has does not silently invent a student', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    await user.type(screen.getByLabelText(/admission number/i), 'S999')

    // The register must never contain a person who does not exist, so the form
    // says so and asks for a name rather than accepting one.
    expect(await screen.findByText(/no student with that number is on file/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/student's name/i)).toBeInTheDocument()
  })

  test('stream is free text, and the hint says so', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })
    await user.type(screen.getByLabelText(/admission number/i), 'S999')

    const stream = await screen.findByLabelText(/^stream/i)
    expect(stream).toHaveAttribute('placeholder', 'Red Stream')
    // Free text: no datalist, because a suggestion that guesses wrong is worse
    // than an empty field, and this school names its own streams.
    expect(document.querySelector('datalist#stream-suggestions')).toBeNull()
  })

  test('form and grade suggest, stream does not', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })
    await user.type(screen.getByLabelText(/admission number/i), 'S999')
    await screen.findByLabelText(/^stream/i)

    // Form and grade draw from what the school has actually recorded.
    expect(document.querySelector('datalist#form-suggestions')).not.toBeNull()
    expect(document.querySelector('datalist#stream-suggestions')).toBeNull()
  })

  test('a failed record keeps what was typed', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    await user.type(screen.getByLabelText(/admission number/i), 'S001')
    await user.type(screen.getByLabelText(/book number/i), 'BK-0001')
    await user.click(screen.getByRole('button', { name: /record issue/i }))

    // Nothing on file, so this is refused — and the refusal must be visible
    // rather than leaving the librarian wondering whether it saved.
    expect(await screen.findByRole('alert')).toHaveTextContent(/no student on file/i)
    // A form that empties when it complains is a form people stop trusting.
    expect(screen.getByLabelText(/admission number/i)).toHaveValue('S001')
    expect(screen.getByLabelText(/book number/i)).toHaveValue('BK-0001')
  })
})

describe('the register', () => {
  test('lists what is out and says when there is nothing', async () => {
    await mountSignedIn('/register')
    expect(await screen.findByRole('heading', { name: /issue register/i })).toBeInTheDocument()
    // An empty register is the normal state on a Monday morning, not an error.
    expect(await screen.findByText(/no books are out/i)).toBeInTheDocument()
  })

  test('a select is not used for the filter', async () => {
    await mountSignedIn('/register')
    await screen.findByRole('heading', { name: /issue register/i })
    // Five options in a row fit any screen. A select on a phone is a full-screen
    // overlay that hides the register being filtered.
    expect(screen.queryByRole('combobox', { name: /show|filter/i })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /on loan/i })).toBeChecked()
  })
})

/*
 * The gate.
 *
 * `/` shows three different things depending on who is using it: setup when the
 * school has no accounts, sign-in when it does and nobody is signed in, and the
 * entry form once somebody is. Each is asserted here because the alternative is a
 * blank screen with no error — the router resolved, the component rendered, and
 * there was nothing in it.
 */
describe('the gate at /', () => {
  test('a brand-new app asks for the first account rather than offering a sign-in', async () => {
    mount('/')
    // Sign-in with no accounts is a dead end for the first person to use the app.
    // The tab bar only appears once there is something to sign in to.
    expect(await screen.findByText(/no accounts exist yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create the account/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /sign in/i })).not.toBeInTheDocument()
  })

  test('the first account created becomes able to run the library', async () => {
    const { user } = mount('/')
    await screen.findByText(/no accounts exist yet/i)

    await user.type(screen.getByLabelText(/your name/i), 'Head Librarian')
    await user.type(screen.getByLabelText(/email address/i), 'head@dandorasecondary.go.ke')
    await user.type(screen.getByLabelText(/^password$/i), 'a-long-enough-password')
    await user.click(screen.getByRole('button', { name: /create the account/i }))

    // Not the entry form yet. Creating an account and signing in are two acts,
    // and the second is a press of a button on the screen every subsequent sign-in
    // will use.
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument()
    expect(await api.currentUser()).toBeNull()

    // Press it, and the entry form appears — no navigation, because there is nowhere
    // to navigate to.
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByRole('heading', { name: /record a book issue/i })).toBeInTheDocument()
    // The first account runs the library, whatever role it asked for.
    expect(await api.currentUser()).toMatchObject({ role: 'admin' })
  })

  test('once an account exists, / offers sign-in and account creation', async () => {
    await api.createUser({ email: 'head@librarian', name: 'H', password: 'x', role: 'admin' })
    // Deliberately not signed in: the point is what a signed-out visitor sees when
    // accounts already exist.
    mount('/')

    expect(await screen.findByRole('tab', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /create account/i })).toBeInTheDocument()
  })

  test('the school is the identity, and no product name competes with it', async () => {
    mount('/')
    await screen.findByText(/no accounts exist yet/i)

    expect(await screen.findByRole('heading', { name: /welcome to the school library/i })).toBeInTheDocument()

    // The school name is on the screen, and it is the largest text there is.
    const wordmark = screen.getByText('Dandora Secondary School')
    expect(wordmark).toBeInTheDocument()

    // An earlier version of this screen put a product name above a generic
    // subtitle. A librarian at a school counter is opening their school's
    // register, not logging in to a product — and a brand they have never heard of,
    // on the one screen where they decide whether to trust this, is a bad thing to
    // put in front of them.
    expect(screen.queryByText('Libra')).not.toBeInTheDocument()
    expect(screen.queryByText(/library management system/i)).not.toBeInTheDocument()
  })

  test('the crest is labelled, so it is not read as a decorative blob', async () => {
    mount('/')
    await screen.findByRole('heading', { name: /welcome/i })
    // Two crests are on screen — the panel's and the rail's — so the query is
    // scoped to the panel rather than matching whichever came first.
    const panel = within(screen.getByRole('main'))
    expect(panel.getByRole('img', { name: /dandora secondary school/i })).toBeInTheDocument()
  })

  test('it says students do not need accounts', async () => {
    mount('/')
    // Worth saying out loud: the most likely confusion is a parent or a student
    // being told they need to log in.
    expect(await screen.findByText(/students do not need accounts/i)).toBeInTheDocument()
  })

  test('revealing the password does not submit the form', async () => {
    const { user } = mount('/')
    await screen.findByText(/no accounts exist yet/i)

    await user.type(screen.getByLabelText(/your name/i), 'Head')
    await user.type(screen.getByLabelText(/email address/i), 'head@librarian')
    await user.type(screen.getByLabelText(/^password$/i), 'secret-password')
    await user.click(screen.getByRole('button', { name: /show the password/i }))

    // A bare <button> inside a form submits it. A reveal that submits is a bug
    // that reads as "the app created my account when I pressed the eye".
    await waitFor(() => expect(screen.getByRole('button', { name: /create the account/i })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /record a book issue/i })).not.toBeInTheDocument()

    const field = screen.getByLabelText(/^password$/i)
    expect(field).toHaveAttribute('type', 'text')
    expect(field).toHaveValue('secret-password')
  })

  test('the create button stays unavailable until there is something to create', async () => {
    const { user } = mount('/')
    await screen.findByText(/no accounts exist yet/i)
    expect(screen.getByRole('button', { name: /create the account/i })).toBeDisabled()

    // Both halves, not one: an email with no password is not an account.
    const email = screen.getByLabelText(/email address/i)
    const password = screen.getByLabelText(/^password$/i)
    await user.type(email, 'head@librarian')
    expect(screen.getByRole('button', { name: /create the account/i })).toBeDisabled()
    await user.type(password, 'x')
    expect(screen.getByRole('button', { name: /create the account/i })).toBeEnabled()
  })
})

/*
 * The sidebar is not decoration around the sign-in screen.
 *
 * It used to wrap everything, which put four navigation links beside a form that
 * could not use any of them: signed out, the domain refuses every one of those
 * actions. Every link was a promise the app could not keep.
 */
describe('the sidebar belongs to a session, not to the page', () => {
  test('signed out, there is no navigation at all', async () => {
    mount('/')
    await screen.findByText(/no accounts exist yet/i)

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    // Every one of those links would have been a dead end.
    for (const label of ['Record issue', 'Register', 'Import', 'Backup']) {
      expect(screen.queryByRole('link', { name: new RegExp(label, 'i') })).not.toBeInTheDocument()
    }
  })

  test('signed out, the only way forward is the form', async () => {
    mount('/')
    await screen.findByText(/no accounts exist yet/i)
    // Nothing on the page is a link at all.
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  test('signed in, the navigation appears', async () => {
    await mountSignedIn('/')
    expect(await screen.findByRole('navigation', { name: /main/i })).toBeInTheDocument()
  })

  test('signing out takes the navigation away again', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('navigation', { name: /main/i })

    // Through the button, not by calling the API. Calling \`signOut\` directly left
    // the cached session in place, so the sidebar stayed on screen offering links
    // the domain would now refuse — which is the exact state this test exists to
    // prevent, and it is why the button has to invalidate.
    await user.click(screen.getByRole('button', { name: /sign out/i }))

    await waitFor(() => expect(screen.queryByRole('navigation')).not.toBeInTheDocument())
    // And the session really is gone, not merely hidden.
    expect(await api.currentUser()).toBeNull()
  })
})

/*
 * Creating an account and signing in are two acts.
 *
 * Collapsing them gave the domain two doors that open a session instead of one,
 * and meant the sign-in form was only ever seen by somebody who already knew the
 * app existed.
 */
describe('creating an account leads to sign-in', () => {
  test('an account is created and then signed in with the same details', async () => {
    const { user } = mount('/')
    await screen.findByText(/no accounts exist yet/i)

    await user.type(screen.getByLabelText(/your name/i), 'Head Librarian')
    await user.type(screen.getByLabelText(/email address/i), 'head@dandorasecondary.go.ke')
    await user.type(screen.getByLabelText(/^password$/i), 'a-long-enough-password')
    await user.click(screen.getByRole('button', { name: /create the account/i }))

    // The sign-in form, already holding what was just typed. Then one press.
    await user.click(await screen.findByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByRole('heading', { name: /record a book issue/i })).toBeInTheDocument()
    expect(await api.currentUser()).toMatchObject({ email: 'head@dandorasecondary.go.ke' })
  })

  test('creating an account on its own does not sign you in', async () => {
    // The domain-level half of the rule. If this regresses, the UI above would
    // still work and the separation would be gone.
    await api.createUser({ email: 'a@librarian', name: 'A', password: 'x', role: 'admin' })
    expect(await api.currentUser()).toBeNull()
    await api.signIn('a@librarian', 'x')
    expect(await api.currentUser()).not.toBeNull()
  })
})

/*
 * Enrolment: Form, Grade and Stream.
 *
 * These three used to appear only when the admission number was not on file, which
 * left nowhere to record a correction for a student who *was* on file. They are now
 * always visible, and read-only once the student is recognised.
 */
describe('enrolment: form, grade and stream', () => {
  const optionsOf = (listId: string) =>
    Array.from(document.querySelectorAll(`datalist#${listId} option`)).map((o) =>
      o.getAttribute('value'),
    )

  test('all three are on the form before anything is typed', async () => {
    await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    // Always visible, not hidden behind "no student on file". A librarian
    // correcting a stream after a transfer needs somewhere to put it.
    expect(screen.getByLabelText(/^form$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^grade$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^stream$/i)).toBeInTheDocument()
  })

  test('there is no Class field', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    // Checked in the state where the enrolment block is actually rendered.
    //
    // An earlier version of this test asserted on an empty form, where the block is
    // hidden — so a Class field sitting in the source passed, because it never made
    // it onto the screen. The guard was checking an unrelated branch.
    await user.type(screen.getByLabelText(/admission number/i), 'S999')
    await screen.findByText(/no student with that number is on file/i)

    // The school identifies a student by admission number, form, grade and stream.
    // A class field is a fifth way to say something the others already say, and two
    // of them disagreeing is a register nobody can query.
    expect(screen.queryByLabelText(/^class$/i)).not.toBeInTheDocument()
    // ...and the fields it would have sat beside really are on screen, so a passing
    // result means the block rendered and the field was absent.
    expect(screen.getByLabelText(/^form$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^stream$/i)).toBeInTheDocument()
  })

  test('form suggests Form 3 and Form 4, and nothing else', async () => {
    await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })
    expect(optionsOf('form-suggestions')).toEqual(['Form 3', 'Form 4'])
    expect(screen.getByLabelText(/^form$/i)).toHaveAttribute('list', 'form-suggestions')
  })

  test('grade suggests 10, 11 and 12, and nothing else', async () => {
    await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })
    expect(optionsOf('grade-suggestions')).toEqual(['10', '11', '12'])
    expect(screen.getByLabelText(/^grade$/i)).toHaveAttribute('list', 'grade-suggestions')
  })

  test('stream is free text with no suggestions at all', async () => {
    await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    const stream = screen.getByLabelText(/^stream$/i)
    // No `list`, and no datalist element either. An empty datalist still makes the
    // browser show a dropdown, so "no suggestions" has to mean the attribute is
    // absent — a test for `toBeNull()` on the element alone would pass on an empty
    // list and miss the whole point.
    expect(stream).not.toHaveAttribute('list')
    expect(document.querySelector('datalist#stream-suggestions')).toBeNull()
  })

  test('a known student has their details shown, and locked', async () => {
    const { user } = await mountSignedIn('/', () =>
      api.createMember({
        memberCode: 'S001',
        firstName: 'Kept',
        lastName: 'Student',
        type: 'student',
        form: 'Form 4',
        grade: '11',
        stream: 'Red Stream',
      }),
    )
    await screen.findByRole('heading', { name: /record a book issue/i })

    await user.type(screen.getByLabelText(/admission number/i), 'S001')

    const form = screen.getByLabelText(/^form$/i)
    const grade = screen.getByLabelText(/^grade$/i)
    const stream = screen.getByLabelText(/^stream$/i)

    // Wait on the form field, not on the name.
    //
    // The name renders as two text nodes — \`{firstName} {lastName}\` — so there is
    // no element whose *display value* is "Kept Student", and a test looking for one
    // waits for something that can never appear.
    await waitFor(() => expect(form).toHaveValue('Form 4'))
    expect(grade).toHaveValue('11')
    expect(stream).toHaveValue('Red Stream')

    // Shown, not blank: an empty box beside a known name reads as "no information"
    // when it actually means "look it up". Read-only, and saying why. Issuing a book must not rewrite an enrolment: a
    // mistyped number could otherwise put four years of borrowing against the wrong
    // child, with no confirmation and no undo.
    expect(form).toHaveAttribute('readonly')
    expect(grade).toHaveAttribute('readonly')
    expect(stream).toHaveAttribute('readonly')
    expect(screen.getByText(/issuing a book should never rewrite an enrolment/i)).toBeInTheDocument()
  })

  test('an unknown student gets empty, editable boxes', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('heading', { name: /record a book issue/i })

    await user.type(screen.getByLabelText(/admission number/i), 'S999')
    await screen.findByText(/no student with that number is on file/i)

    const form = screen.getByLabelText(/^form$/i)
    expect(form).not.toHaveAttribute('readonly')
    await user.type(form, 'Form 3')
    await user.type(screen.getByLabelText(/^grade$/i), '10')
    await user.type(screen.getByLabelText(/^stream$/i), 'Red Stream')

    expect(form).toHaveValue('Form 3')
    expect(screen.getByLabelText(/^grade$/i)).toHaveValue('10')
    expect(screen.getByLabelText(/^stream$/i)).toHaveValue('Red Stream')
  })
})

describe('after creating an account', () => {
  test('the sign-in screen appears, holding the same details', async () => {
    const { user } = mount('/')
    await screen.findByText(/no accounts exist yet/i)

    await user.type(screen.getByLabelText(/your name/i), 'Head Librarian')
    await user.type(screen.getByLabelText(/email address/i), 'head@dandorasecondary.go.ke')
    await user.type(screen.getByLabelText(/^password$/i), 'a-long-enough-password')
    await user.click(screen.getByRole('button', { name: /create the account/i }))

    // The sign-in step is visible, and it holds the same details.
    //
    // Three earlier versions failed this in different ways: it signed in directly so
    // the form was never seen; it replaced the form with a status line and signed in
    // behind that; and it flipped to the sign-in tab and submitted immediately, fast
    // enough that the screen had already changed back. The last one is the reason
    // this test now *waits* for the button rather than assuming it.
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument()
    expect(screen.getByText(/account created/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email address/i)).toHaveValue('head@dandorasecondary.go.ke')
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('a-long-enough-password')

    // Nobody is signed in until the button is pressed.
    expect(await api.currentUser()).toBeNull()

    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByRole('heading', { name: /record a book issue/i })).toBeInTheDocument()
    expect(await api.currentUser()).toMatchObject({ email: 'head@dandorasecondary.go.ke' })
  })

  test('a signed-out visitor can clear a leftover account', async () => {
    // The state this exists for: a record left in the browser by an earlier session,
    // whose owner cannot remember it and cannot sign in — and cannot reach the
    // Backup screen either, because that is behind the sidebar.
    await api.createUser({ email: 'someone@old', name: 'Old', password: 'x', role: 'admin' })
    mount('/')

    const clear = await screen.findByRole('button', { name: /clear them and start again/i })
    expect(clear).toBeInTheDocument()
    expect(screen.getByText(/records are kept in this browser only/i)).toBeInTheDocument()
  })
})

/*
 * The rail is a rail, and it opens.
 *
 * It used to be a permanent 240px column on any screen wide enough. That column
 * earned nothing: the entry form it crowded is two fields wide, and 240px is a
 * fifth of a tablet.
 */

describe('the sidebar pops up', () => {
  const isExpanded = () =>
    screen.getByRole('button', { name: /expand the menu|collapse the menu/i }).getAttribute('aria-expanded')

  test('it starts collapsed, with no permanent wide column', async () => {
    await mountSignedIn('/')
    const nav = await screen.findByRole('navigation', { name: /main/i })

    expect(nav.className).toContain('w-[4rem]')
    // The rule this change removed, and the reason for it: a permanent 240px column
    // on any screen wide enough, crowding a form that is two fields wide.
    expect(nav.className).not.toContain('lg:w-60')
  })

  /*
   * This test found a real bug.
   *
   * The rail used to open on hover: `open = pinned || hovered`. With a mouse the
   * pointer is always over the rail when you click it, so `hovered` was already true
   * and the click read as "collapse" — the expand button did nothing. On a phone
   * there is no hover, so it worked there, which is why it passed every check run on
   * the machine that ran the tests.
   *
   * Hover is gone. There is one input, and it means one thing.
   */
  test('the toggle opens it, and closes it again', async () => {
    const { user } = await mountSignedIn('/')
    const nav = await screen.findByRole('navigation', { name: /main/i })

    expect(isExpanded()).toBe('false')

    await user.click(screen.getByRole('button', { name: /expand the menu/i }))
    expect(isExpanded()).toBe('true')
    expect(nav.className).toContain('w-60')

    await user.click(screen.getByRole('button', { name: /collapse the menu/i }))
    expect(isExpanded()).toBe('false')
    expect(nav.className).toContain('w-[4rem]')
  })

  test('it stays open while the pointer is still over it', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('navigation', { name: /main/i })

    await user.click(screen.getByRole('button', { name: /expand the menu/i }))
    // Moving the mouse over the rail must not close it. It did, in the version this
    // replaced, because the toggle's meaning was derived from a hover flag.
    await user.hover(screen.getByRole('navigation', { name: /main/i }))
    expect(isExpanded()).toBe('true')
  })

  /*
   * Every destination is named whether or not the drawer is open.
   *
   * The visible word is hidden with Tailwind's `hidden`, and jsdom has no stylesheet
   * — so "is this word visible" is not a question this environment can answer. What
   * *is* answerable, and what actually matters, is that the links have names: a
   * collapsed rail shows icons, and an icon-only link with no name is four
   * unlabelled links to anyone navigating by keyboard or listening rather than
   * looking.
   */
  test('every destination is named while collapsed, and again when open', async () => {
    const { user } = await mountSignedIn('/')
    const nav = await screen.findByRole('navigation', { name: /main/i })
    const labels = ['Record issue', 'Register', 'Import', 'Backup']

    for (const label of labels) {
      expect(within(nav).getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: /expand the menu/i }))

    for (const label of labels) {
      expect(within(nav).getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument()
    }
  })

  test('sign out is reachable from the collapsed rail too', async () => {
    const { user } = await mountSignedIn('/')
    const nav = await screen.findByRole('navigation', { name: /main/i })

    // Otherwise the only way out is to open a drawer first, which is a poor thing to
    // demand of somebody who just wants to lock the screen.
    expect(within(nav).getByRole('button', { name: /sign out/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /expand the menu/i }))
    await user.click(within(nav).getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(screen.queryByRole('navigation')).not.toBeInTheDocument())
  })

  test('the scrim appears while open, and closing by it works', async () => {
    const { user } = await mountSignedIn('/')
    await screen.findByRole('navigation', { name: /main/i })

    // Previously `lg:hidden`, because on a desktop the rail was permanently open and
    // a scrim over a permanent panel is just dimming the content for no reason. Now
    // that the rail opens, the scrim is what says the panel is temporary.
    expect(screen.queryByRole('button', { name: /close the menu/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /expand the menu/i }))
    expect(screen.getByRole('button', { name: /close the menu/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /close the menu/i }))
    expect(isExpanded()).toBe('false')
  })

  test('choosing a destination closes it, so it does not cover the page asked for', async () => {
    const { user } = await mountSignedIn('/')
    const nav = await screen.findByRole('navigation', { name: /main/i })

    await user.click(screen.getByRole('button', { name: /expand the menu/i }))
    await user.click(within(nav).getByRole('link', { name: /register/i }))

    // Left open, it would sit over the register somebody just asked for.
    await waitFor(() => expect(isExpanded()).toBe('false'))
    expect(await screen.findByRole('heading', { name: /issue register/i })).toBeInTheDocument()
  })
})

/*
 * The catalogue.
 *
 * It exists because without it the app cannot do its one job: issuing a book means
 * typing a barcode, a barcode has to already be on file, and nothing could put one
 * there. Everything downstream — the register, returns, fines — was implemented,
 * tested and unreachable.
 */
describe('the catalogue', () => {
  test('it says so plainly when there are no books', async () => {
    await mountSignedIn('/catalogue')
    // Not an error. A new library has no books, and that is the normal state on the
    // first day rather than something that has gone wrong.
    expect(await screen.findByText(/the catalogue is empty/i)).toBeInTheDocument()
  })

  test('a book can be added, with its copies', async () => {
    const { user } = await mountSignedIn('/catalogue')
    await screen.findByRole('heading', { name: /^catalogue$/i })

    await user.click(screen.getByRole('button', { name: /add a book/i }))
    await user.type(screen.getByLabelText(/^title$/i), 'Things We Carry')
    await user.type(screen.getByLabelText(/^author$/i), 'Tim O’Brien')
    await user.clear(screen.getByLabelText(/^copies$/i))
    await user.type(screen.getByLabelText(/^copies$/i), '3')
    await user.click(screen.getByRole('button', { name: /add the book/i }))

    expect(await screen.findByText('Things We Carry')).toBeInTheDocument()
    expect(screen.getByText(/3 of 3 available/i)).toBeInTheDocument()
  })

  test('the button stays unavailable until there is a title and an author', async () => {
    const { user } = await mountSignedIn('/catalogue')
    await screen.findByRole('heading', { name: /^catalogue$/i })

    await user.click(screen.getByRole('button', { name: /add a book/i }))
    const add = screen.getByRole('button', { name: /add the book/i })
    expect(add).toBeDisabled()

    await user.type(screen.getByLabelText(/^title$/i), 'Things We Carry')
    // A title with no author is a shelf nobody can find things on.
    expect(add).toBeDisabled()

    await user.type(screen.getByLabelText(/^author$/i), 'Tim O’Brien')
    expect(add).toBeEnabled()
  })

  test('a copy count of zero is not accepted', async () => {
    const { user } = await mountSignedIn('/catalogue')
    await screen.findByRole('heading', { name: /^catalogue$/i })

    await user.click(screen.getByRole('button', { name: /add a book/i }))
    await user.type(screen.getByLabelText(/^title$/i), 'A Title')
    await user.type(screen.getByLabelText(/^author$/i), 'An Author')
    await user.clear(screen.getByLabelText(/^copies$/i))

    const add = screen.getByRole('button', { name: /add the book/i })
    // A title with no copies can never be issued, so accepting it produces a book
    // that exists and cannot be lent — the exact state this screen exists to avoid.
    expect(add).toBeDisabled()
    await user.type(screen.getByLabelText(/^copies$/i), '0')
    expect(add).toBeDisabled()
  })

  test('the individual copies are listed, not just a count', async () => {
    // The copy is what gets issued and its number is on the spine, so a count alone
    // does not tell a librarian which book to walk to.
    const { user } = await mountSignedIn('/catalogue', () =>
      api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 2 }),
    )
    await screen.findByText('Things We Carry')

    await user.click(screen.getByRole('button', { name: /things we carry/i }))

    const barcodes = await screen.findAllByText(/^BK-\d{4}-\d{4}$/)
    expect(barcodes).toHaveLength(2)
  })

  test('more copies can be added to a title that already has some', async () => {
    const { user } = await mountSignedIn('/catalogue', () =>
      api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 1 }),
    )
    await screen.findByText('Things We Carry')

    await user.click(screen.getByRole('button', { name: /things we carry/i }))

    // Cleared first: the field starts at "1", and typing into it appends. This
    // produced "12", added twelve copies, and failed an assertion about three.
    const field = screen.getByLabelText(/copies to add/i)
    await waitFor(() => expect(field).toHaveValue('1'))
    await user.clear(field)
    await user.type(field, '2')

    await user.click(screen.getByRole('button', { name: /^add$/i }))

    expect(await screen.findByText(/3 of 3 available/i)).toBeInTheDocument()
  })

  test('availability is in words, not just a fraction to divide', async () => {
    await mountSignedIn('/catalogue', () =>
      api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 3 }),
    )
    // "0/3" needs doing arithmetic to interpret, and the arithmetic decides whether
    // the librarian looks for another copy or checks the shelf.
    expect(await screen.findByText(/3 of 3 available/i)).toBeInTheDocument()
  })

  test('search finds a book by author as well as by title', async () => {
    const { user } = await mountSignedIn('/catalogue', () =>
      api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 1 }),
    )
    await screen.findByText('Things We Carry')

    await user.type(screen.getByLabelText(/^search$/i), 'O’Brien')
    expect(await screen.findByText('Things We Carry')).toBeInTheDocument()

    await user.clear(screen.getByLabelText(/^search$/i))
    await user.type(screen.getByLabelText(/^search$/i), 'nothing like this')
    expect(await screen.findByText(/nothing matches that search/i)).toBeInTheDocument()
  })
})

describe('circulation at the desk', () => {
  /*
   * Scoped to the table.
   *
   * The register renders two layouts — stacked cards for a phone, a table for a wide
   * screen — and picks between them with a CSS media query. jsdom has no media
   * queries, so both are in the document at once and "the Return button" matches
   * two of them.
   *
   * Rendering both and letting CSS decide is the right shape for a layout that
   * differs structurally rather than just visually. So the tests pick one, and say
   * which.
   */
  const desk = () => within(screen.getByRole('table'))

  /**
   * A library with a student and a book, arranged before the first render so every
   * screen's first paint already knows about them.
   */
  async function stocked(path = '/') {
    return mountSignedIn(path, async () => {
      await api.createMember({
        memberCode: 'S001',
        firstName: 'Kept',
        lastName: 'Student',
        type: 'student',
        form: 'Form 4',
        grade: '11',
      })
      await api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 1 })
    })
  }

  const firstBarcode = async () => {
    const page = await api.searchTitles({ limit: 10, offset: 0 })
    const detail = await api.getTitle(page.items[0]!.id)
    return detail.copies[0]!.barcode
  }

  /** Issues the one book to the one student, through the entry form. */
  async function lend(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole('heading', { name: /record a book issue/i })
    await user.type(screen.getByLabelText(/admission number/i), 'S001')
    await user.type(screen.getByLabelText(/book number/i), await firstBarcode())
    await user.click(screen.getByRole('button', { name: /record issue/i }))
    await screen.findByText(/^recorded\./i)
  }

  /*
   * The test that would have caught the thing the catalogue and these actions exist
   * to fix. Before them the app could record an issue for a brand-new student and do
   * nothing else: no book existed to issue, and no screen could bring one back.
   * Every part had tests; the app had none of the thing anybody actually needs.
   *
   * The explicit timeout is because this test is genuinely the heaviest in the file:
   * it mounts the application, stocks a library, issues through the entry form, walks to
   * the register, opens a return dialog, chooses a condition, records it, switches to
   * the returned filter and reads the row back. That is a little under three seconds of
   * jsdom on an idle machine, against a default budget of five.
   *
   * It timed out at 10s once, on a machine sitting at 99% CPU from an unrelated runaway
   * process, and passed at 2.9s immediately afterwards. So this is not masking a
   * regression -- it is removing a margin that was too thin to survive a busy machine.
   *
   * Raised on this one test rather than globally, because a global bump would let every
   * slower test hide behind it, and a suite that passes by taking longer is worse than
   * one that occasionally says so.
   */
  test('a book goes out and comes back, through the screens', { timeout: 20_000 }, async () => {
    const { user } = await stocked('/')
    await lend(user)

    await user.click(screen.getByRole('link', { name: /register/i }))
    await screen.findByRole('heading', { name: /issue register/i })

    await user.click(desk().getByRole('button', { name: /^return$/i }))
    await user.selectOptions(screen.getByLabelText(/condition/i), 'fair')
    await user.click(screen.getByRole('button', { name: /record the return/i }))

    /*
     * The book leaves the "on loan" view, so the table goes with it.
     *
     * The register opens on what is out now — somebody who has just returned a book
     * is history, and history has its own filter. So there is nothing left to show
     * and the empty state is the correct outcome, not a failure to find the row.
     */
    expect(await screen.findByText(/no books are out/i)).toBeInTheDocument()

    // And the loan is still there, under "returned", with its return date.
    await user.click(screen.getByRole('radio', { name: /^returned$/i }))
    expect(await desk().findByText('Kept Student')).toBeInTheDocument()

    const loans = await api.listLoans({ limit: 10, offset: 0, status: 'returned' })
    expect(loans.items).toHaveLength(1)
    expect(loans.items[0]!.returnedAt).not.toBeNull()
  })

  test('a book on loan is unavailable, and a returned one is available again', async () => {
    const { user } = await stocked('/catalogue')
    // Nothing is out yet, so the copy is on the shelf.
    expect(await screen.findByText(/1 of 1 available/i)).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /record issue/i }))
    await lend(user)

    await user.click(screen.getByRole('link', { name: /catalogue/i }))
    expect(await screen.findByText(/0 of 1 available/i)).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /register/i }))
    await screen.findByRole('heading', { name: /issue register/i })
    await user.click(desk().getByRole('button', { name: /^return$/i }))
    await user.click(screen.getByRole('button', { name: /record the return/i }))
    await screen.findByText(/no books are out/i)

    await user.click(screen.getByRole('link', { name: /catalogue/i }))
    expect(await screen.findByText(/1 of 1 available/i)).toBeInTheDocument()
  })

  test('a void needs a reason, and keeps it in the register', async () => {
    const { user } = await stocked('/')
    await lend(user)

    await user.click(screen.getByRole('link', { name: /register/i }))
    await screen.findByRole('heading', { name: /issue register/i })

    await user.click(desk().getByRole('button', { name: /^void$/i }))
    // An unexplained void is indistinguishable from a deletion, which is the thing
    // voiding exists to prevent.
    expect(screen.getByRole('button', { name: /void it/i })).toBeDisabled()

    await user.type(screen.getByLabelText(/reason/i), 'wrong admission number')
    await user.click(screen.getByRole('button', { name: /void it/i }))

    /*
     * The loan leaves the open view too — a voided loan is not one that is out — so
     * the reason is checked under the Void filter, which is where an auditor would
     * look for it. The point of keeping a void is the reason attached to it; a
     * reason nobody can find is the same as no reason.
     */
    await user.click(screen.getByRole('radio', { name: /^void$/i }))
    expect(await desk().findByText(/wrong admission number/i)).toBeInTheDocument()
    expect(await desk().findByText(/voided/i)).toBeInTheDocument()

    // The book went back on the shelf, which is the whole point of voiding.
    const loans = await api.listLoans({ limit: 10, offset: 0, status: 'void' })
    expect(loans.items).toHaveLength(1)
    const copy = await api.findCopyByBarcode(loans.items[0]!.barcode)
    expect(copy?.status).toBe('on_shelf')
  })

  test('the actions are absent once a loan is closed', async () => {
    const { user } = await stocked('/')
    await lend(user)

    // Four buttons the domain would refuse every time is worse than none.
    await user.click(screen.getByRole('link', { name: /register/i }))
    await screen.findByRole('heading', { name: /issue register/i })
    expect(desk().getByRole('button', { name: /^return$/i })).toBeInTheDocument()

    await user.click(desk().getByRole('button', { name: /^return$/i }))
    await user.click(screen.getByRole('button', { name: /record the return/i }))

    // Gone from the open view, because it is no longer out.
    expect(await screen.findByText(/no books are out/i)).toBeInTheDocument()

    // And absent from history too, which is the part worth checking: a closed loan
    // is a record, not something still offering four buttons the domain refuses.
    await user.click(screen.getByRole('radio', { name: /^returned$/i }))
    await desk().findByText('Kept Student')
    expect(desk().queryByRole('button', { name: /^return$/i })).not.toBeInTheDocument()
    expect(desk().queryByRole('button', { name: /^void$/i })).not.toBeInTheDocument()
    expect(desk().queryByRole('button', { name: /^renew$/i })).not.toBeInTheDocument()
  })

  test('a renewal limit is reported as a sentence, not a silent failure', async () => {
    const { user } = await stocked('/')
    await lend(user)

    await user.click(screen.getByRole('link', { name: /register/i }))
    await screen.findByRole('heading', { name: /issue register/i })

    // A student may renew twice, so the third press is the one that must be refused
    // — in words the librarian reads, because "renewal_limit_reached" tells nobody
    // anything.
    for (let i = 0; i < 2; i++) {
      await user.click(desk().getByRole('button', { name: /^renew$/i }))
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    }

    await user.click(desk().getByRole('button', { name: /^renew$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/renewed as many times/i)
  })
})

/*
 * Fines, and the student behind them.
 *
 * Until now a refusal said "that student owes more than they are allowed to owe" and
 * there was nowhere to go. The sentence is right; being unable to act on it is not.
 */
describe('fines at the desk', () => {
  /**
   * A student with one overdue book, lent far enough in the past that the grace
   * period has passed.
   */
  async function overdue() {
    await api.createMember({
      memberCode: 'S001',
      firstName: 'Kept',
      lastName: 'Student',
      type: 'student',
      form: 'Form 4',
    })
    const title = await api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 1 })
    const detail = await api.getTitle(title.id)
    await api.checkout({
      memberCode: 'S001',
      barcode: detail.copies[0]!.barcode,
      checkedOutAt: '2026-07-01T08:00:00.000Z',
      dueAt: '2026-07-15T08:00:00.000Z',
    })
    await api.runAccrual('2026-09-20T08:00:00.000Z')
  }

  test('nothing owing is said plainly, not shown as an empty table', async () => {
    await mountSignedIn('/fines')
    // The normal state on most days. An empty grid of rows would read as a failure
    // to load rather than as an answer.
    expect(await screen.findByText(/nobody owes anything/i)).toBeInTheDocument()
  })

  test('charging twice on the same day says it charged nothing the second time', async () => {
    await mountSignedIn('/fines', overdue)
    await screen.findByRole('heading', { name: /^fines$/i })

    await userEvent.setup().click(screen.getByRole('button', { name: /charge overdue fines/i }))
    expect(await screen.findByText(/charged 1 loan/i)).toBeInTheDocument()

    // Idempotent per loan per day, and the screen says so rather than hiding it.
    await userEvent.setup().click(screen.getByRole('button', { name: /charge overdue fines/i }))
    expect(await screen.findByText(/nothing was charged/i)).toBeInTheDocument()
  })

  test('a fine shows against the student, in shillings', async () => {
    const { container } = await mountSignedIn('/fines', overdue)
    // Stored as integer cents, shown as money. 25 cents is KSh 0.25, and showing
    // "25" would be wrong by two orders of magnitude.
    //
    // Asserted against the container rather than with getByText: the amount appears
    // twice on the card — in the detail line and as the figure — and the name spans
    // three text nodes. `toHaveTextContent` matches across element boundaries,
    // which is what "does this screen say this" actually means.
    await waitFor(() => expect(container).toHaveTextContent('Kept Student'))
    expect(container).toHaveTextContent('0.25')
  })

  test('the balance is visible on the student list, before opening anybody', async () => {
    await mountSignedIn('/students', overdue)
    // Because "at their limit" and "owes money" are different refusals, and being
    // able to tell them apart from the list is the difference between knowing and
    // going to look.
    expect(await screen.findByText(/0\.25 owing/i)).toBeInTheDocument()
  })

  test('a student can be found by name as well as by number', async () => {
    const { user, container } = await mountSignedIn('/students', overdue)
    await waitFor(() => expect(container).toHaveTextContent('0.25 owing'))
    // "0.25 owing" rather than the raw cents, because that is what is on screen.

    await user.type(screen.getByLabelText(/^search$/i), 'Kept')
    await waitFor(() => expect(container).toHaveTextContent('Kept Student'))

    await user.clear(screen.getByLabelText(/^search$/i))
    await user.type(screen.getByLabelText(/^search$/i), 'S001')
    await waitFor(() => expect(container).toHaveTextContent('S001'))
  })

  test('money can be taken, and the balance falls', async () => {
    const { user, container } = await mountSignedIn('/students', overdue)
    await screen.findByText(/0\.25 owing/i)

    await user.click(screen.getByRole('button', { name: /s001/i }))
    const pay = await screen.findByLabelText(/take payment/i)

    // The button stays shut until there is an amount, and the amount has to be a
    // number — otherwise "KSh 0" is one press away.
    const take = screen.getByRole('button', { name: /take the money/i })
    expect(take).toBeDisabled()

    await user.type(pay, '0.10')
    expect(take).toBeEnabled()

    // `container` comes from the render, not from `screen` — `screen` is a query
    // helper and has no node on it.
    await user.click(take)

    // 25c - 10c. The number is in a node of its own and the word beside it in
    // another, so this is matched across the boundary rather than by element.
    await waitFor(() => expect(container).toHaveTextContent('0.15 outstanding'))
  })

  test('a waiver needs a reason and refuses without one', async () => {
    const { user } = await mountSignedIn('/students', overdue)
    await screen.findByText(/0\.25 owing/i)

    await user.click(screen.getByRole('button', { name: /s001/i }))
    await screen.findByText(/outstanding/i)

    const waive = screen.getByRole('button', { name: /waive the balance/i })
    // A fine that vanishes with no explanation is the thing auditors look for, and
    // the reason it vanished is the whole reason the ledger is append-only.
    expect(waive).toBeDisabled()

    await user.type(screen.getByLabelText(/or waive it/i), 'school responsibility')
    expect(waive).toBeEnabled()
    await user.click(waive)

    /*
     * Two of them, and that is right: the search result on the left and the open
     * record on the right both say it. `getByText` would call that a failure, which
     * is the right instinct for a name that should appear once and the wrong one
     * here — so the assertion is that both agree.
     */
    await waitFor(() => expect(screen.getAllByText(/nothing owing/i).length).toBeGreaterThanOrEqual(1))
    expect(screen.getAllByText(/nothing owing/i)).toHaveLength(2)
  })

  test('a suspended student can be allowed back, without an administrator', async () => {
    const { user } = await mountSignedIn('/students', async () => {
      await api.createMember({
        memberCode: 'S001',
        firstName: 'Kept',
        lastName: 'Student',
        type: 'student',
        status: 'suspended',
      })
    })
    await screen.findByText(/suspended/i)

    await user.click(screen.getByRole('button', { name: /s001/i }))
    await user.click(screen.getByRole('button', { name: /allow borrowing again/i }))

    // One step and reversible: this is a school, records get entered wrongly, and a
    // rule that needs an administrator to undo is a rule that does not get used.
    await waitFor(() => expect(screen.queryByText(/suspended/i)).not.toBeInTheDocument())
  })

  test('every destination in the rail has a screen behind it', async () => {
    for (const [path, heading] of [
      ['/', /record a book issue/i],
      ['/register', /issue register/i],
      ['/catalogue', /^catalogue$/i],
      ['/students', /^students$/i],
      ['/fines', /^fines$/i],
      ['/import', /^import students$/i],
      ['/backup', /^backup$/i],
    ] as const) {
      await mountSignedIn(path)
      expect(
        await screen.findByRole('heading', { name: heading }),
      ).toBeInTheDocument()
      cleanup()
    }
  })
})

/*
 * Staff accounts, and the borrowing rules.
 *
 * Both of these were unreachable until now, and both were blockers rather than
 * improvements:
 *
 * - `createUser` had no screen, so a school with two members of staff could not give
 *   the second one access — and would have ended up sharing one login, putting every
 *   book issued that term under a single name.
 * - The borrowing rules could not be changed by anybody, ever. A school that wants
 *   two books per student simply could not have it.
 */
describe('staff and rules', () => {
  test('a second librarian can be added', async () => {
    const { user } = await mountSignedIn('/staff')
    // The heading renders at once; the accounts arrive after their query. Waiting on
    // the heading and then asserting on the list is a race, and it lost.
    expect(await screen.findByText(/head librarian/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /add someone/i }))
    await user.type(screen.getByLabelText(/^name$/i), 'Jane Wanjiru')
    await user.type(screen.getByLabelText(/email address/i), 'jane@dandorasecondary.go.ke')
    await user.type(screen.getByLabelText(/^password$/i), 'a-long-password')
    await user.click(screen.getByRole('button', { name: /add the account/i }))

    // Two people, two sets of books. A shared login would put every loan that term
    // under one name, which is the whole reason the record of who issued what is
    // worth keeping at all.
    expect(await screen.findByText(/jane wanjiru/i)).toBeInTheDocument()
    expect(await api.listUsers()).toHaveLength(2)
  })

  test('nobody can switch off their own account', async () => {
    const { user } = await mountSignedIn('/staff')
    await screen.findByText(/head librarian/i)

    // The control is disabled rather than hidden: a missing button invites the
    // question "can I switch myself off?", and a disabled one beside the reason
    // answers it.
    expect(screen.getByRole('button', { name: /switch off/i })).toBeDisabled()
    void user

    // And the domain refuses it, so it is not merely out of reach in this screen.
    const me = await api.currentUser()
    await expect(api.setUserStatus(me!.id, 'disabled')).rejects.toThrow(/your own account/i)
  })

  test('a second account can be switched off, and back on', async () => {
    const { user } = await mountSignedIn('/staff', async () => {
      await api.createUser({ name: 'Jane', email: 'jane@librarian', password: 'x', role: 'assistant' })
    })
    await screen.findByText('Jane')

    // The second button: the first belongs to the account this test is signed in as,
    // and that one cannot be switched off. Selected by its row rather than by index
    // so this keeps working when the list grows.
    await user.click(screen.getAllByRole('button', { name: /switch off/i })[1] as HTMLElement)
    expect(await screen.findByText(/switched off/i)).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /switch on/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.queryByText(/switched off/i)).not.toBeInTheDocument())
  })

  test('the borrowing rules can be changed, and take effect', async () => {
    const { user } = await mountSignedIn('/policy')
    await screen.findByRole('heading', { name: /borrowing rules/i })

    // A school that wants two books per student, rather than the five the seed data
    // happened to carry.
    // The first row is the student's, which is the one a school is most likely to be
    // changing. The wait above is what makes the index safe.
    const limit = (await screen.findAllByLabelText(/books at once/i))[0]!
    await user.clear(limit)
    await user.type(limit, '2')
    await user.click(screen.getAllByRole('button', { name: /^save$/i })[0] as HTMLElement)

    await waitFor(async () => {
      const types = await api.listMemberTypes()
      expect(types.find((t) => t.key === 'student')?.borrowLimit).toBe(2)
    })
  })

  test('the loan period can be changed', async () => {
    const { user } = await mountSignedIn('/policy')
    await screen.findByRole('heading', { name: /borrowing rules/i })

    const days = (await screen.findAllByLabelText(/loan period/i))[0]!
    await user.clear(days)
    await user.type(days, '7')
    await user.click(screen.getAllByRole('button', { name: /^save$/i })[0] as HTMLElement)

    await waitFor(async () => {
      const types = await api.listMemberTypes()
      expect(types.find((t) => t.key === 'student')?.loanPeriodDays).toBe(7)
    })
  })

  test('the fine rate is entered in shillings and stored in cents', async () => {
    const { user } = await mountSignedIn('/policy')
    await screen.findByRole('heading', { name: /borrowing rules/i })

    const daily = await screen.findByLabelText(/each day after/i)
    // One rates card, so this one is unique.
    expect(daily).toHaveValue('0.25')

    await user.clear(daily)
    await user.type(daily, '0.5')
    await user.click(screen.getByRole('button', { name: /save the rates/i }))

    await waitFor(async () => {
      const settings = await api.getSettings()
      // 50 cents, not 0.5 and not 50. Every other part of the system deals in
      // integer cents and this is the only place the conversion happens.
      expect(settings.find((s) => s.key === 'fine.defaultDailyRateCents')?.value).toBe(50)
    })
  })

  test('the rates card will not save a change that was not made', async () => {
    await mountSignedIn('/policy')
    // Waits for the loaded rate. Before it loads the form is trivially 'unchanged',
    // so asserting on that would pass without ever checking anything.
    await waitFor(() => expect(screen.getByLabelText(/each day after/i)).toHaveValue('0.25'))
    // Saving on every keystroke would charge somebody at "20" on the way to "200";
    // an unchanged form is not a save.
    expect(screen.getByRole('button', { name: /save the rates/i })).toBeDisabled()
  })

  test('an assistant can run the desk but cannot reach these two things', async () => {
    // Not a UI concern: the domain refuses it, so there is nothing to reach.
    //
    // The administrator is created and signed in first, deliberately. Without that,
    // "Desk" becomes the *first* account — and the first account is always made an
    // administrator whatever it asks for — so this would have been checking an
    // administrator and passing for the wrong reason.
    await api.createUser({ name: 'Head', email: 'head@librarian', password: 'x', role: 'admin' })
    await api.signIn('head@librarian', 'x')

    const assistant = await api.createUser({
      name: 'Desk',
      email: 'desk@librarian',
      password: 'x',
      role: 'assistant',
    })
    expect(assistant.role).toBe('assistant')

    await expect(__mock.asUser(assistant.id, () => api.listUsers())).rejects.toThrow(/cannot/i)
    await expect(
      __mock.asUser(assistant.id, () => api.updateMemberType('student', { borrowLimit: 99 })),
    ).rejects.toThrow(/cannot/i)
  })

  test('every destination in the rail has a screen behind it', async () => {
    for (const [path, heading] of [
      ['/', /record a book issue/i],
      ['/register', /issue register/i],
      ['/catalogue', /^catalogue$/i],
      ['/students', /^students$/i],
      ['/fines', /^fines$/i],
      ['/policy', /borrowing rules/i],
      ['/staff', /^staff$/i],
      ['/import', /^import students$/i],
      ['/backup', /^backup$/i],
    ] as const) {
      await mountSignedIn(path)
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
      cleanup()
    }
  })
})

/*
 * A damaged book, and the register as a file.
 *
 * Two holes closed here. There was no way to take a copy out of circulation, so a
 * torn cover found on the shelf stayed "available" and was issued to the next
 * student — and there was no way to get the register out of the screen, so the
 * version in the head teacher's report was retyped by hand and drifted.
 */
describe('taking a book out of circulation', () => {
  const openCatalogue = async () => {
    const { user } = await mountSignedIn('/catalogue', () =>
      api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 2 }),
    )
    await screen.findByText('Things We Carry')
    await user.click(screen.getByRole('button', { name: /things we carry/i }))
    return user
  }

  test('a damaged copy is marked, and stays lendable', async () => {
    const user = await openCatalogue()
    await user.click(screen.getAllByRole('button', { name: /mark damaged/i })[0]!)

    await user.click(screen.getByRole('button', { name: /mark it damaged/i }))

    // Damaged is not withdrawn. A scuffed cover is still lent; taking it off the
    // shelf behind a button labelled "Damaged" would be unrecoverable from here.
    const detail = await api.getTitle((await api.searchTitles({ limit: 5, offset: 0 })).items[0]!.id)
    const marked = detail.copies.filter((c) => c.condition === 'damaged')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.status).toBe('on_shelf')
  })

  test('withdrawing needs a reason, and the copy stops being lendable', async () => {
    const user = await openCatalogue()
    await user.click(screen.getAllByRole('button', { name: /^withdraw$/i })[0]!)

    const withdraw = screen.getByRole('button', { name: /withdraw it/i })
    // A book that vanished with no explanation cannot be chased — the same reason a
    // void needs one.
    expect(withdraw).toBeDisabled()

    await user.type(screen.getByLabelText(/reason/i), 'water damage')
    expect(withdraw).toBeEnabled()
    await user.click(withdraw)

    const detail = await api.getTitle((await api.searchTitles({ limit: 5, offset: 0 })).items[0]!.id)
    const gone = detail.copies.filter((c) => c.status === 'withdrawn')
    expect(gone).toHaveLength(1)
    expect(gone[0]!.notes).toBe('water damage')

    // And it no longer counts as available.
    const titles = await api.searchTitles({ limit: 5, offset: 0 })
    expect(titles.items[0]!.availableCount).toBe(1)
    expect(titles.items[0]!.copyCount).toBe(2)
  })

  test('a withdrawn copy can be put back, and comes back undamaged', async () => {
    const user = await openCatalogue()
    await user.click(screen.getAllByRole('button', { name: /^withdraw$/i })[0]!)
    await user.type(screen.getByLabelText(/reason/i), 'repaired')
    await user.click(screen.getByRole('button', { name: /withdraw it/i }))
    await screen.findByText(/withdrawn/i)

    await user.click(screen.getAllByRole('button', { name: /put back on the shelf/i })[0]!)

    const detail = await api.getTitle((await api.searchTitles({ limit: 5, offset: 0 })).items[0]!.id)
    // The condition goes back with it. A copy restored to the shelf while still
    // marked damaged would show as available and be issued damaged all over again.
    expect(detail.copies.filter((c) => c.status === 'on_shelf')).toHaveLength(2)
    expect(detail.copies.every((c) => c.condition === 'good')).toBe(true)
  })
})

describe('the register as a file', () => {
  test('a field is quoted only when it has to be', () => {
    // Quoting a number makes it arrive in Excel as text, which then refuses to sum.
    expect(csvField('S001')).toBe('S001')
    expect(csvField(1500)).toBe('1500')
    expect(csvField(null)).toBe('')
    expect(csvField('Things We Carry, Revised')).toBe('"Things We Carry, Revised"')
    // A quote inside a quoted field is doubled, or it ends the field early.
    expect(csvField('O"Brien')).toBe('"O""Brien"')
    expect(csvField('line one\nline two')).toBe('"line one\nline two"')
  })

  test('rows come out in the order the columns name', () => {
    const csv = toCsv(['A', 'B'], [['1', '2'], ['3', null]])
    expect(csv).toBe('A,B\r\n1,2\r\n3,\r\n')
  })

  test('the export carries the rows on screen, and says how many', async () => {
    // Mounted once, with the loan arranged beforehand. Mounting twice rendered two
    // registers, and `getByText` reported the duplicate as a failure rather than as
    // the mistake it was.
    const { container } = await mountSignedIn('/register', async () => {
      await api.createMember({
        memberCode: 'S001',
        firstName: 'Kept',
        lastName: 'Student',
        type: 'student',
        form: 'Form 4',
      })
      const t = await api.createTitle({ title: 'Things We Carry', author: 'Tim O’Brien', copyCount: 1 })
      const detail = await api.getTitle(t.id)
      await api.checkout({ memberCode: 'S001', barcode: detail.copies[0]!.barcode })
    })
    await screen.findByRole('heading', { name: /issue register/i })
    await waitFor(() => expect(container).toHaveTextContent('Kept Student'))

    // The count, because "what am I about to download" is the question. An export
    // that quietly fetched a different slice would look like the one on screen.
    expect(screen.getByText(/1 row — the ones on screen/i)).toBeInTheDocument()
  })

  test('there is nothing to download from an empty view', async () => {
    await mountSignedIn('/register')
    await screen.findByRole('heading', { name: /issue register/i })
    expect(screen.getByRole('button', { name: /download these rows/i })).toBeDisabled()
    expect(screen.getByText(/nothing to download/i)).toBeInTheDocument()
  })
})
