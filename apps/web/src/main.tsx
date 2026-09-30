/**
 * The entry point.
 *
 * Three things happen here and nothing else: the stylesheet loads, React mounts,
 * and a thrown error shows something a person can read.
 *
 * ── The error boundary is not optional ───────────────────────────────
 *
 * Without one, any error during render unmounts the tree and leaves a white
 * page. In development that is an inconvenience; for a librarian at a desk in
 * front of a queue it is an app that appears broken with no way to report what
 * happened. So the fallback shows the message and offers a reload, rather than
 * swallowing it — an error nobody can see is an error nobody can fix.
 */
import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './routes'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Long enough that moving between the register and the entry form does not
      // re-read the whole library on every tap, short enough that a record made
      // on another tab is picked up within a session.
      staleTime: 30_000,
      retry: 1,
      // No refetch on focus. A phone switching apps on a weak connection fires
      // this constantly, and each one is a request the school pays for.
      refetchOnWindowFocus: false,
    },
  },
})

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  // noImplicitOverride is on deliberately: forgetting to mark an override is how a
  // refactor quietly changes behaviour.
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="page-wash flex min-h-dvh items-center justify-center p-6">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6">
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The page could not be shown. Your records are not affected.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => location.reload()}
              className="mt-4 h-11 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const container = document.getElementById('root')
if (!container) {
  // The one case a boundary cannot catch: the script ran and its own host is
  // missing, which means the deployed HTML and this bundle disagree.
  throw new Error('No #root element to mount into. index.html and the build are out of step.')
}

createRoot(container).render(
  <StrictMode>
    <Boundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Boundary>
  </StrictMode>,
)