/**
 * Routes.
 *
 * ── `/` is the entry form ────────────────────────────────────────────
 *
 * The librarian opens this at 7am and their job is to record that a student took
 * a book. Everything else — the register, import, backup — is something they do
 * less often, so the app opens on the thing that needs doing rather than on a
 * summary of things already done.
 *
 * There is no dashboard and no `/login`.
 *
 * The dashboard because a panel of counts pushes the admission number off a phone
 * screen, and a librarian serving a queue does not need to be told how many books
 * are out. The `/login` because signed out there is nothing to navigate to — the
 * gate in `AuthLayout` renders the panel instead of this outlet, so a login route
 * could only ever be reached by a redirect, and every redirect is a chance to loop,
 * to lose the intended path, or to leave a blank screen with no error.
 *
 * ── The catch-all ──────────────────────────────────────────────────
 *
 * Old links and a mistyped path land on a screen that says so and offers the way
 * back. Silently redirecting to `/` would make a stale bookmark look like it
 * worked, and the difference surfaces a week later when the thing they clicked did
 * not happen.
 */
import { createRootRoute, createRoute, createRouter, Link } from '@tanstack/react-router'
import { AuthLayout } from './features/auth/AuthLayout'
import { RecordIssue } from './features/issues/RecordIssue'
import { Catalogue } from './features/issues/Catalogue'
import { Fines } from './features/issues/Fines'
import { Policy } from './features/issues/Policy'
import { Staff } from './features/issues/Staff'
import { IssueRegister } from './features/issues/IssueRegister'
import { Students } from './features/issues/Students'
import { Dashboard } from './features/issues/Dashboard'
import { Reports } from './features/issues/Reports'
import { ImportStudents } from './features/issues/ImportStudents'
import { BackupPanel } from './features/issues/BackupPanel'
import { AuditLog } from './features/issues/AuditLog'
import { Button } from './components/ui'

/*
 * The gate, not the chrome.
 *
 * `AuthLayout` renders the sidebar and the outlet only for somebody signed in.
 * That ordering is the whole reason signed-out looks like a sign-in screen rather
 * than an application with a sign-in form in it.
 */
const rootRoute = createRootRoute({ component: AuthLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: RecordIssue,
})

const catalogueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/catalogue',
  component: Catalogue,
})

const studentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/students',
  component: Students,
})

const finesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fines',
  component: Fines,
})

const staffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/staff',
  component: Staff,
})

const policyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/policy',
  component: Policy,
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

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditLog,
})

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: Dashboard,
})

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  component: Reports,
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
 * A test that mounts its own copy of the routes is testing a copy. The array
 * being asserted on has to be the one the app ships.
 */
export const routeTree = rootRoute.addChildren([
  indexRoute,
  catalogueRoute,
  staffRoute,
  policyRoute,
  studentsRoute,
  finesRoute,
  registerRoute,
  importRoute,
  backupRoute,
  auditRoute,
  dashboardRoute,
  reportsRoute,
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