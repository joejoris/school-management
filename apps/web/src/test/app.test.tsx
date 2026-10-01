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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { api } from '../api'
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
async function mountSignedIn(path = '/') {
  await api.createUser({
    email: 'head@dandorasecondary.go.ke',
    name: 'Head Librarian',
    password: 'x',
    role: 'admin',
  })
  await api.signIn('head@dandorasecondary.go.ke', 'x')
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

    // And the entry form appears — no navigation, because there is nowhere to
    // navigate to.
    expect(await screen.findByRole('heading', { name: /record a book issue/i })).toBeInTheDocument()
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

    // Straight in, using what was just typed — no second round of typing, and no
    // navigation.
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
