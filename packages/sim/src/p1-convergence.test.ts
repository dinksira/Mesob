/**
 * P1: convergence under in-order delivery.
 *
 * Byte-identity is the oracle here, and only here. Every replica sees the same delivery
 * order, so the byte encoding of a converged document is well-defined, and asserting it
 * is a stronger check than comparing logical content. P2 uses a different oracle for a
 * different reason; see [13 §4](../../docs/13-testing.md#3-property-and-fuzz-testing).
 *
 * This test is close to a control: Yjs converges on in-order delivery, so it mostly
 * proves the harness and the schema are wired up. The property that earns its runtime is
 * P2.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DirectTransport } from './transport.js'
import { SimWorld, byteIdentical, converged } from './sim-world.js'
import { makeRandom } from './rng.js'
import { propertyParams, PROPERTY_TIMEOUT_MS } from './fc-config.js'

const OP_COUNT = 40

describe('P1 convergence, in-order delivery', () => {
  it(
    'leaves every replica byte-identical and logically equal',
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
          const world = new SimWorld({
            replicas: 3,
            transport: new DirectTransport(makeRandom(seed)),
            seed,
          })
          world.step(OP_COUNT)

          expect(world.transport.stats.outOfOrder).toBe(0)
          expect(converged(world)).toBe(true)
          expect(byteIdentical(world)).toBe(true)
          world.destroy()
        }),
        propertyParams(),
      )
    },
    PROPERTY_TIMEOUT_MS,
  )

  it('delivered a nonzero number of messages, so the harness is not a no-op', () => {
    const world = new SimWorld({
      replicas: 3,
      transport: new DirectTransport(makeRandom(1)),
      seed: 1,
    })
    world.step(OP_COUNT)
    expect(world.transport.stats.sent).toBeGreaterThan(0)
    expect(world.transport.stats.delivered).toBeGreaterThan(0)
    world.destroy()
  })

  it('converges when the same ops are replayed a second time', () => {
    // Idempotence of the harness itself: a second pass must change nothing.
    const world = new SimWorld({
      replicas: 3,
      transport: new DirectTransport(makeRandom(5)),
      seed: 5,
    })
    world.step(OP_COUNT)
    const before = world.boards()
    world.step(0)
    expect(world.boards()).toEqual(before)
    world.destroy()
  })
})
