import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * Test config, separate from `vite.config.ts`.
 *
 * The reason it is separate rather than a `test` key in one config: `vite build`
 * would then need to know about jsdom and the testing library, and every build
 * would pay for them. A test runner setting is not a build setting.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    /*
     * The suite runs against the in-memory domain, always, and says so here rather
     * than inheriting whatever the developer has locally.
     *
     * Vite loads `.env.local` into `import.meta.env`, and `api/index.ts` reads
     * `VITE_API_MODE` from exactly there. So a developer who had connected a real
     * Supabase project would find 69 tests failing against a live database — or
     * worse, a suite that quietly passed while testing production data.
     *
     * It is not a hypothetical: writing a `.env.local` for a real project turned
     * 69 of 106 tests red in one line. The suite is about the domain rules, and the
     * domain rules are the thing that runs with no infrastructure at all.
     *
     * `test.env` is applied after the `.env` files, so this wins.
     */
    env: { VITE_API_MODE: 'mock' },
  },
})