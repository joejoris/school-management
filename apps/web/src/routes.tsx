/**
 * Routes.
 *
 * ── `/` is the entry form. That is the whole point of it ────────────
 *
 * The app opens on the thing a librarian does forty times a day, not on a
 * dashboard summarising things already recorded. There is no `/login` and no
 * `/dashboard`: a librarian who has to navigate before they can record a book
 * will find another way to write it down.
 *
 * `path: '/'` has no `beforeLoad` that navigates. That was tried and it loops:
 * the router resolves `/`, the loader redirects to `/`, the loader runs again.
 * It presents as a blank screen, which is the most expensive symptom a router
 * bug can have and the least informative.
 *
 * ── The catch-all ──────────────────────────────────────────────────
 *
 * Old links and a mistyped path land on a screen that says so and offers the way
 * back, rather than on the entry form. Silently redirecting an unknown path to
 * `/` would mean a stale bookmark looks like it worked, and the librarian
 * discovers the difference later when the thing they clicked did not happen.
 */
import { createRootRoute, createRoute, createRouter, Link } from '@tanstack/react-router'
import { Shell } from './shell'
import { EntryOrSetup } from './features/auth/EntryOrSetup'
import { IssueRegister } from './features/issues/IssueRegister'
import { ImportStudents } from './features/issues/ImportStudents'
import { BackupPanel } from './features/issues/BackupPanel'
import { Button } from './components/ui'

const rootRoute = createRootRoute({ component: Shell })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: EntryOrSetup,
})

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: IssueRegister,
})

const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/import',
  component: ImportStudents,
})

const backupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/backup',
  component: BackupPanel,
})

/**
 * Anything else.
 *
 * A real screen rather than a redirect, for the reason above: a stale link that
 * quietly lands somewhere else is a bug reported a week later by somebody who
 * cannot connect it to the link they clicked.
 */
const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$',
  component: () => (
    <div className="mx-auto flex w-full max-w-md flex-col items-start gap-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">That page is not here</h1>
      <p className="text-sm text-muted-foreground">
        The address does not match anything in this app. It may be an old link.
      </p>
      <Button asChild>
        <Link to="/">Go to the entry form</Link>
      </Button>
    </div>
  ),
})

/**
 * Exported so a test can build a router against the real tree.
 *
 * A test that mounts its own copy of the routes is testing a copy. The routes
 * array being asserted on has to be the one the app ships.
 */
export const routeTree = rootRoute.addChildren([
  indexRoute,
  registerRoute,
  importRoute,
  backupRoute,
  notFoundRoute,
])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: () => (
    <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
  ),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}