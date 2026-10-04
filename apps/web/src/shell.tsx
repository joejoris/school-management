/**
 * The app shell: a sidebar and whatever the route says goes in the middle.
 *
 * ── Why a sidebar and not a bottom bar ─────────────────────────────
 *
 * Four destinations. A bottom bar on a phone gets four items into the width a
 * thumb can reach, and the labels stop being words and start being
 * abbreviations — which is how a register screen ends up labelled "RGSTR".
 *
 * The rail is a narrow always-visible strip that expands to an overlay. On a
 * tablet that keeps the navigation reachable with a thumb without spending
 * 15rem of a 768px screen on links while a student is being served.
 *
 * ── `dvh` again ────────────────────────────────────────────────────
 *
 * The shell is a full viewport height. `100vh` is taller than what a phone can
 * show, because the browser's own toolbars are inside that height, so a form
 * sized to `100vh` puts its submit button under them.
 */
import { useState } from 'react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { cn } from './components/ui'
import {
  Archive,
  BookPlus,
  Library,
  LogOut,
  PanelLeft,
  Receipt,
  SchoolLogo,
  Sliders,
  TableIcon,
  Upload,
  Users,
} from './components/icons'

const LINKS = [
  { to: '/', label: 'Record issue', icon: BookPlus, end: true },
  { to: '/register', label: 'Register', icon: TableIcon, end: false },
  // Catalogue sits second, not last: without a book on the shelf nothing else in
  // this app can be tried, so it is the next thing anybody needs.
  { to: '/catalogue', label: 'Catalogue', icon: Library, end: false },
  { to: '/students', label: 'Students', icon: Users, end: false },
  { to: '/fines', label: 'Fines', icon: Receipt, end: false },
  { to: '/policy', label: 'Rules', icon: Sliders, end: false },
  { to: '/staff', label: 'Staff', icon: Users, end: false },
  { to: '/import', label: 'Import', icon: Upload, end: false },
  { to: '/backup', label: 'Backup', icon: Archive, end: false },
] as const

function Rail() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const queryClient = useQueryClient()

  /*
   * Sign out, then invalidate the session.
   *
   * The invalidate is the part that matters. The session query is cached for 30s, so
   * without it the gate would keep rendering the sidebar for another half minute
   * after signing out — every link on it pointing at actions the domain now refuses.
   */
  const signOut = async () => {
    await api.signOut()
    await queryClient.invalidateQueries({ queryKey: ['session'] })
  }
  /*
   * Open or shut, and nothing else.
   *
   * No hover. See the note above this component: a rail that opens because the
   * cursor drifted over it cannot tell a click on "expand" from a click on
   * "collapse", and every version of that ambiguity that was tried produced the
   * opposite bug in the other direction.
   */
  const [open, setOpen] = useState(false)

  const toggle = () => setOpen((o) => !o)

  return (
    <>
      {/*
        The scrim, on every screen, only while open.

        It used to be desktop-hidden, because on a desktop the rail was permanently
        open and an overlay over a permanent panel is just a way to dim the content
        for no reason. Now that the rail opens, the scrim is what tells you the
        panel is temporary — and tapping it closes the panel, which is what
        somebody who opened the wrong thing expects to happen.

        Deliberately dim rather than hide: the content underneath is still the
        librarian's, and they should be able to see where they are.
      */}
      {open ? (
        <button
          type="button"
          onClick={toggle}
          aria-label="Close the menu"
          className="fixed inset-0 z-30 cursor-default bg-ink/40 backdrop-blur-[1px] motion-reduce:backdrop-blur-none"
        />
      ) : null}

      <nav
        aria-label="Main"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-card shadow-xl shadow-black/10',
          'transition-[width] duration-200 ease-out motion-reduce:transition-none',
          // Narrow until asked, on every screen. There is no width at which this
          // earns 240px of permanent space: the form it would be crowding is two
          // fields wide.
          'w-[4rem]',
          open && 'w-60',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center gap-3 px-3 py-4">
          <button
            type="button"
            onClick={toggle}
            aria-label={open ? 'Collapse the menu' : 'Expand the menu'}
            aria-expanded={open}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
          >
            <PanelLeft />
          </button>
          {/*
            The name is hidden rather than clipped when collapsed. A half-shown word
            reads as a rendering fault; nothing reads better than nothing.

            Opacity rather than `hidden`, because a link or heading that stops being
            exposed when it stops being visible is invisible to a screen reader — and
            this is the app's only navigation. The rail's links carry `aria-label`
            for the same reason: the name must not depend on the drawer's state.
          */}
          <span
            aria-hidden
            className={cn(
              'min-w-0 truncate text-sm font-semibold tracking-tight transition-opacity',
              open ? 'opacity-100' : 'opacity-0',
            )}
          >
            Library
          </span>
        </div>

        <ul className="flex flex-1 flex-col gap-1 px-2">
          {LINKS.map(({ to, label, icon: Icon, end }) => {
            const active = end ? path === to : path.startsWith(to)
            return (
              <li key={to}>
                <Link
                  to={to}
                  onClick={() => setOpen(false)}
                  // Always named, open or shut. A collapsed rail shows icons, and an
                  // icon-only link with no name is four unlabelled links to anyone
                  // navigating by keyboard or listening rather than looking.
                  aria-label={label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium',
                    'transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )}
                >
                  <Icon className="size-5 shrink-0" />
                  {/* `aria-hidden`: the anchor already carries this name, so announcing
                  it twice would read "Register, Register". */}
              <span aria-hidden className={cn('truncate', !open && 'hidden')}>
                {label}
              </span>
                </Link>
              </li>
            )
          })}
        </ul>

        {/*
          The footer, and the only way out.

          Signing out is not a nicety on a shared desk. This app will be used at a
          counter where the next person is already standing there, and without this
          the librarian who finishes a shift leaves their session open — and the
          next person records borrowings under their name.

          The button lives here rather than on the entry form because the entry form
          is for one task: recording a book. Anything else on it competes with the
          admission number field for a librarian's attention.
        */}
        <div className="border-t border-border p-2">
          <div className="mb-1 flex items-center gap-3 px-2 py-1">
            <SchoolLogo size={28} className="shrink-0" />
            <span
              aria-hidden
              className={cn('min-w-0 text-xs leading-tight', !open && 'hidden')}
            >
              Dandora Secondary
              <br />
              School Library
            </span>
          </div>

          <button
            type="button"
            onClick={() => void signOut()}
            /*
             * `aria-label` on the button, because the visible word is `aria-hidden` and
             * hidden when the rail is shut — and without this the button has *no*
             * accessible name at all in the collapsed state. A test looking for
             * "Sign out" found nothing, which is the same thing a screen reader
             * would have found.
             */
            aria-label="Sign out"
            className={cn(
              'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium',
              'text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
            )}
          >
            <LogOut className="size-4 shrink-0" />
            <span aria-hidden className={cn('truncate', !open && 'hidden')}>
              Sign out
            </span>
          </button>
        </div>
      </nav>
    </>
  )
}

export function Shell() {
  const { data: user } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.currentUser(),
    staleTime: 30_000,
  })

  return (
    <div className="page-wash flex min-h-dvh flex-col lg:flex-row">
      <Rail />
      <main
        className={cn(
          'min-w-0 flex-1 px-4 py-6 sm:px-6 lg:py-10',
          // Room for the home-indicator gesture bar and for iOS Safari's own
          // bottom toolbar when it collapses. Without it the last row of a long
          // register sits under both.
          'pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6 lg:pb-10',
          // Exactly the rail's collapsed width, at EVERY screen size.
          //
          // This was `lg:pl-[4rem]`, which reserved the space only at 1024px and up,
          // while the rail itself is `fixed` at every breakpoint. The consequence was
          // that on every phone and every tablet in portrait — the two sizes this app is
          // mostly used at — a 64px strip down the left sat permanently on top of the
          // content, covering the start of every field, every heading and every button.
          // The layout still looked deliberate, which is what made it worth checking
          // rather than noticing.
          //
          // Not the rail's open width, either: it is `fixed`, so when it opens it covers
          // this column rather than pushing it. Reserving 240px for a panel that is
          // covering the content would leave a dead strip down the side.
          'pl-[4rem]',
        )}
      >
        <Outlet />
        {user ? null : (
          <p className="mt-8 text-center text-xs text-muted-foreground">
            Practice copy — records are kept in this browser only.
          </p>
        )}
      </main>
    </div>
  )
}