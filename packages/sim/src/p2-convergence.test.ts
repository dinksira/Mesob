/**
 * P2: convergence under permuted delivery.
 *
 * The oracle is equal state vectors plus an equal canonical board read, not
 * byte-identity.
 *
 * The reason is not that bytes differ under permutation. An earlier measurement said
 * they did, in 49 runs out of 300, and that number was wrong: it came from a transport
 * that fanned every message out to every client instead of to its recipient, so replicas
 * discovered each other's clients in different orders. With delivery actually addressed,
 * byte-identity held in 60 of 60 permuted runs, at every batch size tried. The claim in
 * doc 13 has been corrected to match.
 *
 * Byte-identity is still the wrong oracle, for two reasons that survive the correction.
 * It is an artifact of Yjs's struct encoder rather than a convergence contract, so a Yjs
 * upgrade could change the bytes while convergence is unaffected and fail this test for a
 * non-bug. And it cannot express the property actually worth protecting: that two replicas
 * agree on what is *on the board*. That is what `readBoard` says, it is the same function
 * the renderer uses, and adding a shape type extends it instead of leaving a stale list of
 * property names in the test.
 *
 * See [13 §4](../../docs/13-testing.md#3-property-and-fuzz-testing).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DuplicatingTransport, PermutedTransport } from './transport.js'
import { SimWorld, converged, type Replica } from './sim-world.js'
import { makeRandom } from './rng.js'
import { propertyParams, PROPERTY_TIMEOUT_MS } from './fc-config.js'

const OP_COUNT = 40

describe('P2 convergence under permuted delivery', () => {
  it(
    'converges for every random delivery order',
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
          const world = new SimWorld({
            replicas: 3,
            transport: new PermutedTransport(makeRandom(seed)),
            seed,
          })
          world.step(OP_COUNT)

          expect(world.transport.stats.outOfOrder).toBeGreaterThan(0)
          expect(converged(world)).toBe(true)
          world.destroy()
        }),
        propertyParams(),
      )
    },
    PROPERTY_TIMEOUT_MS,
  )

  it('reports that it genuinely permuted, on every seed tried', () => {
    // Asserted per run rather than once for the suite, so a transport that stops
    // shuffling fails here instead of quietly turning P2 back into P1.
    for (let seed = 1; seed <= 10; seed++) {
      const world = new SimWorld({
        replicas: 3,
        transport: new PermutedTransport(makeRandom(seed)),
        seed,
      })
      world.step(OP_COUNT)
      expect(world.transport.stats.outOfOrder).toBeGreaterThan(0)
      // Three replicas, so every send has two recipients. Every send must have landed
      // somewhere: nothing is partitioned in this test.
      expect(world.transport.stats.delivered).toBe(world.transport.stats.sent * 2)
      expect(world.transport.stats.dropped).toBe(0)
      world.destroy()
    }
  })

  it(
    'converges when every message is delivered twice',
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
          const world = new SimWorld({
            replicas: 3,
            transport: new DuplicatingTransport(makeRandom(seed)),
            seed,
          })
          world.step(OP_COUNT)

          expect(world.transport.stats.duplicated).toBeGreaterThan(0)
          expect(converged(world)).toBe(true)
          world.destroy()
        }),
        propertyParams({ numRuns: 25 }),
      )
    },
    PROPERTY_TIMEOUT_MS,
  )
})

describe('syncAll closes gaps the transport left', () => {
  it('does not converge while partitioned, and does after healing', () => {
    const world = new SimWorld({
      replicas: 3,
      transport: new PermutedTransport(makeRandom(2)),
      seed: 2,
    })
    world.step(20)
    expect(converged(world)).toBe(true)

    // Isolate one replica, keep editing on the others, and confirm the isolation is real.
    const [a, b, c] = world.replicas as [Replica, Replica, Replica]
    world.transport.disconnect(c.id)
    world.apply({ kind: 'add', id: 'shp_partition', x: 1, y: 1, w: 10, h: 10 }, a)
    world.apply({ kind: 'add', id: 'shp_partition2', x: 2, y: 2, w: 10, h: 10 }, b)
    world.transport.flush()

    expect(world.transport.stats.dropped).toBe(2)
    expect(converged(world)).toBe(false)
    expect(world.boards()[2]?.map(([id]) => id)).not.toContain('shp_partition')

    // Reconnecting alone is not enough: the transport discarded those messages rather
    // than holding them, so the state-vector exchange is what closes the gap.
    world.transport.connect(c.id)
    world.transport.flush()
    expect(converged(world)).toBe(false)

    world.syncAll()
    expect(converged(world)).toBe(true)
    expect(world.boards()[2]?.map(([id]) => id)).toContain('shp_partition')
  })
})
