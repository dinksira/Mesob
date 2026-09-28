/**
 * Shared fast-check configuration for the property tests.
 *
 * Both knobs exist for the same reason: a property test that cannot be reproduced is a
 * property test you end up rewriting instead of debugging.
 *
 * - `FAST_CHECK_SEED` pins the seed, so a failure in the 10,000-run nightly from doc 13
 *   can be replayed exactly.
 * - `FAST_CHECK_RUNS` raises the run count for a longer local or nightly pass, while the
 *   default stays small enough to hold a PR gate to a ten-second budget. The default is
 *   deliberately a small number: these are CRDT convergence checks, and a run that is
 *   slow enough to be ignored is a run nobody runs.
 *
 * `seed` is omitted rather than passed as `undefined`, because `exactOptionalPropertyTypes`
 * forbids that, and because passing an explicit `undefined` would be asking fast-check to
 * override its own default with nothing.
 */

/**
 * Default runs per property. See the note above before raising this.
 *
 * 50 is a sample, not the coverage. What catches a rare reordering is the number of
 * independent seeds, and the nightly in doc 13 runs 10,000 of them; the PR gate exists to
 * catch a regression that shows up in most seeds, which 50 does. Measured at 40 ops and
 * three replicas, this puts the whole `packages/sim` suite comfortably inside the
 * ten-second budget from doc 13 rather than sitting on top of it.
 */
export const DEFAULT_RUNS = 50

/**
 * Per-test timeout for the property tests.
 *
 * These need an explicit one. Vitest's 5s default is sized for a unit test, and a property
 * test doing 100 runs of a three-replica board crosses it on any machine that is doing
 * something else at the same time. Raising the limit is the right response; the alternative
 * is a test that fails in CI and passes on a quiet laptop.
 *
 * This is a ceiling that catches a wedged run, not a target. The suite is meant to finish
 * in a few seconds, which is what `DEFAULT_RUNS` controls.
 */
export const PROPERTY_TIMEOUT_MS = 60_000

export const RUNS = process.env['FAST_CHECK_RUNS']
  ? Number(process.env['FAST_CHECK_RUNS'])
  : DEFAULT_RUNS

export const SEED = process.env['FAST_CHECK_SEED']
  ? Number(process.env['FAST_CHECK_SEED'])
  : undefined

export interface PropertyParams {
  numRuns: number
  endOnFailure: true
  seed?: number
}

export function propertyParams(overrides: Partial<PropertyParams> = {}): PropertyParams {
  return {
    numRuns: RUNS,
    endOnFailure: true,
    ...(SEED === undefined ? {} : { seed: SEED }),
    ...overrides,
  }
}

/** The PR budget, asserted in a test so it cannot silently regress into minutes. */
export const PR_BUDGET_MS = 10_000
