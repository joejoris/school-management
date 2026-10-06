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

/*
 * jsdom's File and Blob have no `text()`.
 *
 * The backup panel reads the chosen file before it offers to replace everything
 * with it, and `await undefined.file.text()` throws in a way that would surface as
 * "That file is not a library backup" — a test that passes for the wrong reason,
 * or fails for the right code and the wrong environment. FileReader is jsdom's own,
 * so this is the same read through the API jsdom does have.
 */
if (typeof Blob.prototype.text !== 'function') {
  Object.defineProperty(Blob.prototype, 'text', {
    configurable: true,
    value(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(this)
      })
    },
  })
}

/*
 * jsdom has no object URLs, and every "download a file" button goes through one.
 *
 * Without this the download path throws before it can report anything, so the
 * screens' own confirmation ("Backup saved to your downloads.") is untestable.
 * The stub returns a fixed string; nothing here follows the URL.
 */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:jsdom'
  URL.revokeObjectURL = () => {}
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