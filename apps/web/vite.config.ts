import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

/**
 * Two things worth reading.
 *
 * `@source` is declared rather than left to autodetection, because the default
 * scans the working tree and would happily pick up `test/`. A class that appears
 * only in a test would then be generated in the production stylesheet, and a test
 * asserting "every class used is generated" would pass on a build that includes
 * classes nothing renders.
 *
 * `alias` maps `@/` to `src/`. Imports in the code are `@/components/...`, so a
 * file moving does not touch every file that referenced it.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
})