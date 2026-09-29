import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * The G1 performance gates, which are not unit tests and must not be run as one.
 *
 * These drive a real Chromium against a real dev server, because every number they produce
 * is a number about a real canvas rasteriser, a real IndexedDB and a real compositor. Under
 * happy-dom there is no rasteriser, no storage and no frame loop, and a test that ran
 * there would be measuring the absence of the thing it claims to measure.
 *
 * The environment is `node` and there is no `// @vitest-environment` comment, which is what
 * keeps this out of the DOM suite. The suite timeout is generous because a cold Chromium
 * start plus a Vite transform of the whole app is a real cost, not a slow test.
 */
export default defineConfig({
  // The app root, so `include` and vite's resolution are relative to `apps/web` rather than
  // to `apps/web/perf`. `fileURLToPath` rather than `URL.pathname` for the Windows drive
  // letter, which the latter turns into `/D:/...`.
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [react()],
  test: {
    include: ['src/perf.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One worker. Two browsers competing for four cores would make the frame times a
    // measurement of the harness rather than of the renderer.
    fileParallelism: false,
    pool: 'forks',
  },
})
