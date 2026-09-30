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

describe('ellipses converge like rects do', () => {
  it('converges when every shape added is an ellipse', () => {
    // Driven by explicit ops rather than the random generator, because a generator that
    // mixed both types could pass this suite while never once producing an ellipse — the
    // type roll would just have to land the same way every run. Typing the ops here makes
    // the ellipse path the only one exercised.
    const world = new SimWorld({
      replicas: 3,
      transport: new PermutedTransport(makeRandom(20260928)),
      seed: 20260928,
    })
    const [a, b, c] = world.replicas as [Replica, Replica, Replica]
    world.apply({ kind: 'add', id: 'e0', type: 'ellipse', x: 10, y: 10, w: 80, h: 40 }, a)
    world.apply({ kind: 'add', id: 'e1', type: 'ellipse', x: 200, y: 20, w: 120, h: 90 }, b)
    world.apply({ kind: 'add', id: 'e2', type: 'ellipse', x: 40, y: 300, w: 200, h: 60 }, c)
    // Sync before mutating. A delete issued against a replica that has not yet received
    // the shape is a no-op by design — ops are generated without global knowledge — so
    // without this the delete would quietly do nothing and the test would still pass on
    // convergence while asserting nothing about a delete.
    world.syncAll()
    // Then mutate them from all three replicas at once, which is where a type-dependent
    // path would diverge if one existed.
    world.apply({ kind: 'move', id: 'e0', x: 11, y: 12 }, b)
    world.apply({ kind: 'set', id: 'e1', property: 'fill', value: '#ff0000' }, c)
    world.apply({ kind: 'set', id: 'e2', property: 'strokeWidth', value: 4 }, a)
    world.apply({ kind: 'delete', id: 'e1' }, a)

    world.syncAll()
    expect(converged(world)).toBe(true)
    // Not vacuously true: the board has to actually hold ellipses, and the delete has to
    // have been a delete of an ellipse rather than a shape that never arrived.
    const board = world.boards()[0] ?? []
    expect(board.map(([id]) => id).sort()).toEqual(['e0', 'e2'])
    expect(board.map(([, s]) => s.type)).toEqual(['ellipse', 'ellipse'])
    world.destroy()
  })

  it('produces every type from the random generator, and they converge', () => {
    // The complement of the test above: the generator is not biased so hard toward one type
    // that any of the others is only ever covered by the hand-written ops.
    const world = new SimWorld({
      replicas: 3,
      transport: new DuplicatingTransport(makeRandom(7)),
      seed: 7,
    })
    // 200 rather than the usual 40, because this test is asserting on the generator's
    // distribution and not on a particular run: at 40 ops a type with a 15% share is missed
    // most of the time, and a test that fails for that reason is a test about the seed. The
    // extra ops cost nothing — the run is milliseconds and nothing here is a wall clock.
    const ops = world.runOps(200)
    const added = ops.filter((op) => op.kind === 'add')
    const types = new Set(added.map((op) => op.type))
    // Every type, not "more than one". A generator that produced only rects and ellipses
    // would pass a test that asked for a mix, and would leave the three types whose geometry
    // is not a box converging entirely untested.
    expect(types).toEqual(new Set(['rect', 'ellipse', 'line', 'pen', 'note']))

    world.syncAll()
    expect(converged(world)).toBe(true)
    // Convergence compares whole boards, so a type dropped on one replica and kept on
    // another would show as a difference — unless the comparison ignored the discriminant.
    const perReplica = world.boards().map((b) => b.map(([, s]) => s.type).join(','))
    expect(perReplica[0]).toBe(perReplica[1])
    expect(perReplica[1]).toBe(perReplica[2])
    world.destroy()
  })
})

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
    world.apply({ kind: 'add', id: 'shp_partition', type: 'rect', x: 1, y: 1, w: 10, h: 10 }, a)
    world.apply({ kind: 'add', id: 'shp_partition2', type: 'ellipse', x: 2, y: 2, w: 10, h: 10 }, b)
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
