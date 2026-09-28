import { describe, expect, it } from 'vitest'
import {
  DirectTransport,
  DuplicatingTransport,
  PermutedTransport,
  DroppingTransport,
  type ClientId,
  type Transport,
} from './transport.js'
import { makeRandom } from './rng.js'

const msg = (byte: number) => new Uint8Array([byte])

/**
 * Wire up clients, each with its own record of what it received.
 *
 * The per-client split is the point, not tidiness. An earlier `wire` helper registered a
 * single handler for every client and the transport fanned every message out to it, so a
 * partition could not isolate anything: the "disconnected" replica received the messages
 * it was supposed to miss, and the test that partitioned passed. Anything asserting about
 * delivery has to be able to tell recipients apart.
 */
function wire(transport: Transport, clientIds: ClientId[] = [1, 2]) {
  const received = new Map<ClientId, number[]>()
  for (const id of clientIds) {
    transport.connect(id)
    received.set(id, [])
    transport.onReceive(id, (_from, message) => received.get(id)!.push(message[0]!))
  }
  return {
    a: clientIds[0]!,
    b: clientIds[1]!,
    received,
    /** What one client received. */
    got: (id: ClientId) => received.get(id)!,
  }
}

describe('DirectTransport', () => {
  it('delivers every message once, in send order', () => {
    const t = new DirectTransport(makeRandom(1))
    const { a, got } = wire(t)
    t.send(a, msg(1))
    t.send(a, msg(2))
    t.send(a, msg(3))
    t.flush()
    expect(got(2)).toEqual([1, 2, 3])
    expect(t.stats.delivered).toBe(3)
    expect(t.stats.outOfOrder).toBe(0)
    expect(t.stats.duplicated).toBe(0)
  })

  it('delivers only to the recipient, not to every client', () => {
    // Regression: the transport used to invoke every handler for every message, so each
    // client saw the other's traffic. Convergence tests cannot see a partition, and
    // duplicate suppression cannot be tested, if messages land everywhere.
    const t = new DirectTransport(makeRandom(1))
    const { a, got } = wire(t, [1, 2, 3])
    t.send(a, msg(9))
    t.flush()
    expect(got(1)).toEqual([])
    expect(got(2)).toEqual([9])
    expect(got(3)).toEqual([9])
  })

  it('never echoes a message back to its sender', () => {
    const t = new DirectTransport(makeRandom(1))
    const { a, b, got } = wire(t)
    t.send(a, msg(9))
    t.send(b, msg(8))
    t.flush()
    expect(got(1)).toEqual([8])
    expect(got(2)).toEqual([9])
  })
})

describe('PermutedTransport', () => {
  it('actually reorders, rather than passing messages through', () => {
    // The whole point of P2. A shuffle that no-ops would leave the interesting property
    // untested while still reporting green.
    let everReordered = false
    for (let seed = 1; seed <= 20 && !everReordered; seed++) {
      const t = new PermutedTransport(makeRandom(seed))
      const { a, received } = wire(t)
      for (let i = 0; i < 30; i++) t.send(a, msg(i))
      t.flush()
      expect(received.get(2)).toHaveLength(30)
      if (t.stats.outOfOrder > 0) everReordered = true
    }
    expect(everReordered).toBe(true)
  })

  it('gives each recipient a different order of the same messages', () => {
    // A single global shuffle is still enough to make replicas disagree on ordering,
    // because each receives a different subsequence of the shared buffer.
    let everDifferent = false
    for (let seed = 1; seed <= 20 && !everDifferent; seed++) {
      const t = new PermutedTransport(makeRandom(seed))
      const { a, got } = wire(t, [1, 2, 3])
      for (let i = 0; i < 30; i++) t.send(a, msg(i))
      t.flush()
      if (String(got(2)) !== String(got(3))) everDifferent = true
    }
    expect(everDifferent).toBe(true)
  })

  it('preserves the multiset of messages', () => {
    const t = new PermutedTransport(makeRandom(7))
    const { a, got } = wire(t)
    for (let i = 0; i < 50; i++) t.send(a, msg(i % 10))
    t.flush()
    expect([...got(2)].sort((x, y) => x - y)).toEqual(
      [...Array(50).keys()].map((i) => i % 10).sort((x, y) => x - y),
    )
  })

  it('is deterministic for a given seed, and differs between seeds', () => {
    // Determinism is what makes a failure replayable, so this has to be the same seed
    // twice. An earlier version compared seeds 1 and 2 and asserted the results matched,
    // which only passed by accident of the shuffle size.
    const run = (seed: number) => {
      const t = new PermutedTransport(makeRandom(seed))
      const { a, got } = wire(t)
      for (let i = 0; i < 20; i++) t.send(a, msg(i))
      t.flush()
      return got(2)
    }
    expect(run(4)).toEqual(run(4))
    expect(run(4)).not.toEqual(run(5))
  })
})

describe('DuplicatingTransport', () => {
  it('delivers every message twice', () => {
    const t = new DuplicatingTransport(makeRandom(1))
    const { a, got } = wire(t)
    t.send(a, msg(1))
    t.send(a, msg(2))
    t.flush()
    expect(got(2)).toEqual([1, 1, 2, 2])
    expect(t.stats.duplicated).toBe(2)
  })
})

describe('DroppingTransport', () => {
  it('drops the configured fraction and says so', () => {
    const t = new DroppingTransport(0.5, makeRandom(3))
    const { a, got } = wire(t)
    for (let i = 0; i < 200; i++) t.send(a, msg(i % 100))
    t.flush()
    expect(got(2).length).toBeLessThan(200)
    expect(t.stats.dropped).toBeGreaterThan(0)
  })

  it('drops nothing at probability zero', () => {
    const t = new DroppingTransport(0, makeRandom(3))
    const { a, got } = wire(t)
    for (let i = 0; i < 20; i++) t.send(a, msg(i))
    t.flush()
    expect(got(2)).toHaveLength(20)
    expect(t.stats.dropped).toBe(0)
  })
})

describe('partitions', () => {
  it('discards messages for a disconnected client and counts them', () => {
    // Discarded, not buffered. Holding them would be a join concern, and joining is
    // SimWorld's state-vector sync, not the transport's job.
    const t = new DirectTransport(makeRandom(1))
    const { a, got } = wire(t)
    t.send(a, msg(1))
    t.disconnect(2)
    t.send(a, msg(2))
    t.flush()
    expect(got(2)).toEqual([1])
    expect(t.stats.dropped).toBe(1)
  })

  it('resumes delivery after a reconnect', () => {
    const t = new DirectTransport(makeRandom(1))
    const { a, got } = wire(t)
    t.disconnect(2)
    t.send(a, msg(1))
    t.flush()
    expect(got(2)).toEqual([])

    t.connect(2)
    t.send(a, msg(2))
    t.flush()
    expect(got(2)).toEqual([2])
  })

  it('reports how many clients are currently partitioned', () => {
    const t = new DirectTransport(makeRandom(1))
    const { a, b } = wire(t, [1, 2, 3])
    t.disconnect(2)
    expect(t.stats.disconnected).toBe(1)
    t.disconnect(3)
    expect(t.stats.disconnected).toBe(2)
    t.connect(b)
    expect(t.stats.disconnected).toBe(1)
    expect(t.isConnected(a)).toBe(true)
  })

  it('counts nothing as dropped while every client is connected', () => {
    const t = new DirectTransport(makeRandom(1))
    const { a } = wire(t)
    t.send(a, msg(1))
    t.flush()
    expect(t.stats.dropped).toBe(0)
  })
})

describe('flush', () => {
  it('empties the buffer, so a second flush delivers nothing more', () => {
    const t = new DirectTransport(makeRandom(1))
    const { a, got } = wire(t)
    t.send(a, msg(1))
    t.flush()
    t.flush()
    expect(got(2)).toEqual([1])
  })
})
