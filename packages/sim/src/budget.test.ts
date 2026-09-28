/**
 * Guards the two budgets doc 13 commits to, so neither can rot silently.
 *
 * The property run count and the PR wall-clock are the same decision: a convergence suite
 * that gets slow enough to be ignored is a suite that stops protecting anything. These
 * tests do not measure anything interesting on their own, they just fail the build when
 * the default configuration drifts out of policy.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNS, PR_BUDGET_MS, PROPERTY_TIMEOUT_MS, RUNS } from './fc-config.js'

describe('the property-test budget', () => {
  it('keeps the default run count below the nightly count it stands in for', () => {
    // The PR run is a sample of the 10,000-run nightly, not a replacement for it.
    expect(DEFAULT_RUNS).toBeLessThan(10_000)
    expect(RUNS).toBe(DEFAULT_RUNS)
  })

  it('allows a timeout that a loaded machine can still meet', () => {
    // A ceiling well above the PR budget: enough headroom that a busy CI box does not turn
    // a slow run into a red build, still low enough to catch a genuinely wedged run.
    expect(PROPERTY_TIMEOUT_MS).toBeGreaterThan(PR_BUDGET_MS)
  })

  it('honours the environment overrides', () => {
    // Only meaningful when FAST_CHECK_RUNS is actually set, which is the nightly case.
    if (process.env['FAST_CHECK_RUNS'] === undefined) return
    expect(RUNS).toBe(Number(process.env['FAST_CHECK_RUNS']))
  })
})
