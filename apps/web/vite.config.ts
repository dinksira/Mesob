import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2023',
  },
  test: {
    // `perf.test.ts` drives a real Chromium over a real dev server. Run here it would be a
    // test with no browser and no server, so it is excluded from the unit run and run by
    // `pnpm test:perf` under its own config. `configDefaults.exclude` has to be spread in
    // or setting `exclude` at all drops vitest's own node_modules and dist exclusions.
    exclude: [...configDefaults.exclude, 'src/perf.test.ts'],
  },
})
