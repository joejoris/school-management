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
import { Archive, BookPlus, LogOut, PanelLeft, SchoolLogo, TableIcon, Upload } from './components/icons'

const LINKS = [
  { to: '/', label: 'Record issue', icon: BookPlus, end: true },
  { to: '/register', label: 'Register', icon: TableIcon, end: false },
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
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const open = pinned || hovered

  return (
    <>
      {/*
        The overlay. Only on small screens, and only while open — on a tablet or
        desktop the rail is a rail and an overlay over it would hide the content
        behind a scrim the user did not ask for.
      */}
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-ink/40 lg:hidden"
          onClick={() => setPinned(false)}
          aria-hidden
        />
      ) : null}

      <nav
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label="Main"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-card',
          'transition-[width] duration-200 ease-out',
          'w-[4rem] lg:w-60',
          open && 'w-60',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center gap-3 px-3 py-4">
          <button
            type="button"
            onClick={() => setPinned((p) => !p)}
            aria-label={open ? 'Collapse the menu' : 'Expand the menu'}
            aria-expanded={open}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
          >
            <PanelLeft />
          </button>
          {/*
            The name is hidden rather than clipped when collapsed. A half-shown
            word reads as a rendering fault; nothing reads better than nothing.
          */}
          <span
            className={cn(
              'min-w-0 truncate text-sm font-semibold tracking-tight transition-opacity',
              open ? 'opacity-100' : 'opacity-0 lg:opacity-100',
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
                  onClick={() => setPinned(false)}
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
                  <span className={cn('truncate', !open && 'hidden lg:inline')}>{label}</span>
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
            <span className={cn('min-w-0 text-xs leading-tight', !open && 'hidden lg:inline')}>
              Dandora Secondary
              <br />
              School Library
            </span>
          </div>

          <button
            type="button"
            onClick={() => void signOut()}
            className={cn(
              'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium',
              'text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
            )}
          >
            <LogOut className="size-4 shrink-0" />
            <span className={cn('truncate', !open && 'hidden lg:inline')}>Sign out</span>
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
          // Matches the rail's width so the column clears the panel when it is
          // pinned, and centres in what is actually visible when it is not.
          'lg:pl-[4rem]',
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