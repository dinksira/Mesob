/**
 * A seeded PRNG, so every simulated run is reproducible from its seed.
 *
 * `Math.random` is unusable here for the obvious reason: a convergence failure at 10,000
 * nightly runs has to be replayable, and a test that cannot name the run that broke it
 * is a test you end up rewriting. This is mulberry32, which is small, has no dependencies,
 * and is good enough for shuffling a message buffer.
 */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
