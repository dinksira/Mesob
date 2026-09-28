/**
 * Message transports for the simulation.
 *
 * The transport carries **opaque bytes** and knows nothing about Yjs, replication, or
 * document structure. That is deliberate. An earlier shape for this interface forwarded
 * the `update` events straight off each `Y.Doc`, which quietly assumes every replica has
 * been connected since the beginning of time: a replica that joins late has no history
 * to forward, and a partition that heals has no way to catch up, because both need a
 * state-vector exchange that an incremental-update channel cannot express. Fixing that
 * after the fact is a rewrite of SimWorld. So `Transport` stays dumb, and joining and
 * healing are `SimWorld`'s problem, solved with `syncAll()`.
 *
 * Every implementation counts what it actually did. That is not instrumentation for its
 * own sake: the convergence tests are only meaningful if the transport under test
 * perturbs delivery, and a `PermutedTransport` that quietly degrades to in-order turns
 * the interesting property back into the trivial one while still reporting green. The
 * tests assert on these counters so that failure is loud.
 *
 * See [13 §4](../docs/13-testing.md#3-property-and-fuzz-testing).
 */

/** A client in the simulation, identified by its `Y.Doc.clientID`. */
export type ClientId = number

export type Handler = (from: ClientId, message: Uint8Array) => void

export interface TransportStats {
  /** Messages handed to `send`, before fan-out to recipients. */
  sent: number
  /** Messages actually handed to a handler. */
  delivered: number
  /** Deliveries that repeated a message already delivered. */
  duplicated: number
  /** Messages discarded before delivery: partitioned recipient, or a lossy link. */
  dropped: number
  /** Deliveries that arrived in send order relative to the previous delivery. */
  inOrder: number
  /** Deliveries that arrived earlier in send order than the previous delivery. */
  outOfOrder: number
  /** Clients currently disconnected. */
  disconnected: number
}

export interface Transport {
  /** Deliver `message` to every other client, in send order. */
  send(from: ClientId, message: Uint8Array): void
  /** Subscribe a client's inbound messages. Returns an unsubscribe function. */
  onReceive(client: ClientId, handler: Handler): () => void
  connect(client: ClientId): void
  disconnect(client: ClientId): void
  isConnected(client: ClientId): boolean
  /** Deliver everything buffered. Called at the end of a run. */
  flush(): void
  readonly stats: TransportStats
}
interface Entry {
  seq: number
  from: ClientId
  to: ClientId
  payload: Uint8Array
}

function freshStats(): TransportStats {
  return {
    sent: 0,
    delivered: 0,
    duplicated: 0,
    dropped: 0,
    inOrder: 0,
    outOfOrder: 0,
    disconnected: 0,
  }
}

/**
 * Shared delivery machinery. A subclass decides only the order entries leave in; the
 * bookkeeping of delivered/dropped/repeated/reordered lives here so every transport
 * measures the same thing and none of them can quietly skip a counter.
 *
 * Delivery is addressed. Each message carries its recipient and is handed to that
 * recipient's handler alone.
 */
export class BaseTransport implements Transport {
  private readonly handlers = new Map<ClientId, Handler>()
  /** Every client that has ever connected, connected or not. */
  private readonly clients = new Set<ClientId>()
  private readonly disconnected = new Set<ClientId>()
  protected log: Entry[] = []
  private seq = 0
  readonly stats: TransportStats = freshStats()
  /** Seeded PRNG, used only by the permuting subclasses. */
  protected readonly random: () => number

  constructor(random: () => number = Math.random) {
    this.random = random
  }

  send(from: ClientId, message: Uint8Array): void {
    this.stats.sent++
    for (const to of this.clients) {
      if (to === from) continue
      if (this.disconnected.has(to)) {
        // The send happened while the recipient was partitioned away. It is discarded
        // rather than buffered, so healing is left to SimWorld's state-vector sync.
        this.stats.dropped++
        continue
      }
      this.log.push({ seq: this.seq++, from, to, payload: message })
    }
  }

  onReceive(client: ClientId, handler: Handler): () => void {
    this.handlers.set(client, handler)
    return () => {
      if (this.handlers.get(client) === handler) this.handlers.delete(client)
    }
  }

  connect(client: ClientId): void {
    this.clients.add(client)
    this.disconnected.delete(client)
    this.stats.disconnected = this.disconnected.size
  }

  disconnect(client: ClientId): void {
    if (!this.clients.has(client) || this.disconnected.has(client)) return
    this.disconnected.add(client)
    this.stats.disconnected = this.disconnected.size
  }

  isConnected(client: ClientId): boolean {
    return this.clients.has(client) && !this.disconnected.has(client)
  }

  /** The order in which buffered entries are delivered. Overridden by subclasses. */
  protected order(entries: Entry[]): Entry[] {
    return entries
  }

  flush(): void {
    const entries = this.order(this.log)
    this.log = []

    let previous = -1
    for (const entry of entries) {
      const handler = this.handlers.get(entry.to)
      if (!handler) {
        this.stats.dropped++
        continue
      }
      handler(entry.from, entry.payload)
      this.stats.delivered++

      if (previous >= 0) {
        if (entry.seq === previous) this.stats.duplicated++
        else if (entry.seq < previous) this.stats.outOfOrder++
        else this.stats.inOrder++
      }
      previous = entry.seq
    }
  }
}

/**
 * In send order, once each.
 *
 * A control rather than a test in its own right: running a convergence test against this
 * establishes the baseline the perturbed transports are compared against, and is how you
 * notice a perturbation is doing nothing.
 */
export class DirectTransport extends BaseTransport {}

/** Shuffles the buffer before delivering, so recipients see different random orders. */
export class PermutedTransport extends BaseTransport {
  protected override order(entries: Entry[]): Entry[] {
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1))
      const a = entries[i]
      const b = entries[j]
      if (a === undefined || b === undefined) continue
      entries[i] = b
      entries[j] = a
    }
    return entries
  }
}

/**
 * Delivers every message twice, which is what a retry whose success the sender never
 * saw looks like on the wire. [P3](../docs/13-testing.md#3-property-and-fuzz-testing)
 * asserts that Yjs absorbs it.
 */
export class DuplicatingTransport extends BaseTransport {
  protected override order(entries: Entry[]): Entry[] {
    return entries.flatMap((entry) => [entry, entry])
  }
}

/**
 * Delivers each message and then discards it, modelling a lossy link.
 *
 * The counting matters more than the discarding. An earlier version filtered the buffer
 * inside `order()`, which removed the entries before `flush()` could see them, so
 * `stats.dropped` stayed at zero while a lossy link was quietly in force. A perturbation
 * that does not report itself is indistinguishable from no perturbation at all.
 */
export class DroppingTransport extends BaseTransport {
  /** Probability in [0, 1] that a given buffered message is discarded. */
  private readonly dropProbability: number

  constructor(dropProbability: number, random: () => number = Math.random) {
    super(random)
    this.dropProbability = dropProbability
  }

  protected override order(entries: Entry[]): Entry[] {
    const kept: Entry[] = []
    for (const entry of entries) {
      if (this.random() < this.dropProbability) this.stats.dropped++
      else kept.push(entry)
    }
    return kept
  }
}
