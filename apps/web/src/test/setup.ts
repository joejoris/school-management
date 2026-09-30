/**
 * Test setup.
 *
 * `matchMedia` and `localStorage` are stubbed here rather than in each test,
 * because jsdom provides neither and every suite that touches them needs them.
 *
 * `localStorage` in particular is not a convenience: the seam writes the mock's
 * state there on every call, so without it the app throws on the first write and
 * every test fails for a reason that has nothing to do with the code under test.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom has no matchMedia; nothing in the app reads it today, and a stub is
// cheaper than discovering that later.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(() => {
  // Cleared between tests so a mirrored register from one test cannot make the
  // next one see rows it never created. This class of leak produces a test that
  // passes alone and fails in a file, which is the hardest kind to diagnose.
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})