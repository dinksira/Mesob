/**
 * A simulated board: N replicas, each a real `Y.Doc`, synchronised through a `Transport`.
 *
 * Real documents, not a mock. A convergence test against a stub proves that the stub
 * converges, and the whole class of bug this exists to catch is a disagreement between
 * the document and what we think a document is. So every replica here is a `Y.Doc`, and
 * every op goes through the schema's own factory functions rather than a shortcut.
 *
 * Two channels, on purpose. Ops made during the run travel as incremental updates
 * through the transport, because that is the interesting path. `syncAll()` then
 * reconciles by state vector, which is the path a late joiner or a healed partition
 * needs. Keeping them separate is what stops the transport from having to grow a
 * handshake it has no business knowing about.
 */

import { applyUpdate, encodeStateAsUpdate, encodeStateVector, Doc } from 'yjs'
import { after, first, type Key } from '@mesob/schema'
import { createRectShape, deleteShape, readBoard, shapesMap, type Shape } from '@mesob/schema'
import { makeRandom } from './rng.js'
import { BaseTransport, type Transport } from './transport.js'

/** The ops a replica can perform. Deliberately small; richer ops come with the shapes. */
export type Op =
  | { kind: 'add'; id: string; x: number; y: number; w: number; h: number }
  | { kind: 'move'; id: string; x: number; y: number }
  | { kind: 'set'; id: string; property: 'fill' | 'stroke' | 'strokeWidth'; value: string | number }
  | { kind: 'delete'; id: string }

export interface Replica {
  id: number
  doc: Doc
}

const SETTABLE_PROPERTIES = ['fill', 'stroke', 'strokeWidth'] as const

export interface SimWorldOptions {
  /** Replica count, including the one that applies ops. */
  replicas?: number
  /** Transport to synchronise through. Defaults to in-order. */
  transport?: Transport
  seed?: number
}

/**
 * A board plus its replicas.
 *
 * The PRNG is instance state rather than a parameter so that a failure reports a seed
 * that reproduces the whole run, transport permutation included.
 */
export class SimWorld {
  readonly replicas: Replica[]
  readonly transport: Transport
  readonly seed: number
  private readonly random: () => number
  private topZ: Key = first()
  private nextId = 0
  private nextProp = 0

  constructor(options: SimWorldOptions = {}) {
    const count = options.replicas ?? 3
    this.seed = options.seed ?? 1
    this.random = makeRandom(this.seed)
    this.transport = options.transport ?? new BaseTransport(this.random)

    this.replicas = Array.from({ length: count }, () => {
      const doc = new Doc()
      const id = doc.clientID
      this.transport.connect(id)
      this.transport.onReceive(id, (from, message) => {
        // Ignore anything from ourselves; the transport should not echo, but if it
        // ever does, applying our own update is a no-op rather than a corruption.
        if (from === id) return
        applyUpdate(doc, message, 'remote')
      })
      return { id, doc }
    })
  }

  /** The replica ops are applied to. Round-robin by op index, so all replicas edit. */
  private get editor(): Replica {
    const replica = this.replicas[this.nextProp % this.replicas.length]
    if (!replica) throw new Error('SimWorld was constructed with no replicas')
    return replica
  }

  /**
   * Apply one op to one replica, capturing the resulting update for the transport.
   *
   * The op runs inside a transaction so that it produces exactly one update event. An
   * earlier version captured a single event and moved a shape's `x` and `y` with two
   * separate writes, which emitted two updates and sent only the second. Convergence
   * still held, because `syncAll()` quietly supplied the missing half, so the incremental
   * path — the one that actually needs testing — was never exercised.
   */
  apply(op: Op, replica: Replica = this.editor): void {
    const updates: Uint8Array[] = []
    const capture = (u: Uint8Array) => {
      updates.push(u)
    }
    replica.doc.on('update', capture)
    try {
      replica.doc.transact(() => {
        switch (op.kind) {
          case 'add':
            createRectShape(replica.doc, {
              id: op.id,
              z: this.topZ,
              rect: { x: op.x, y: op.y, w: op.w, h: op.h },
            })
            this.topZ = after(this.topZ)
            break
          case 'move': {
            const shape = shapesMap(replica.doc).get(op.id)
            if (shape) {
              shape.set('x', op.x)
              shape.set('y', op.y)
            }
            break
          }
          case 'set': {
            const shape = shapesMap(replica.doc).get(op.id)
            if (shape) shape.set(op.property, op.value)
            break
          }
          case 'delete':
            try {
              deleteShape(replica.doc, op.id)
            } catch {
              // Already gone on this replica. A delete of a missing shape is a no-op,
              // not a failure, because ops are generated without global knowledge.
            }
            break
        }
      })
    } finally {
      replica.doc.off('update', capture)
    }
    for (const update of updates) this.transport.send(replica.id, update)
  }

  /** A known id, for an op that has to target something. */
  private pickId(ids: string[]): string {
    const id = ids[Math.floor(this.random() * ids.length)]
    if (id === undefined) throw new Error('pickId called with no ids')
    return id
  }

  /** Round-robin rather than random, so every property gets corrupted eventually. */
  private pickProperty(): 'fill' | 'stroke' | 'strokeWidth' {
    const property = SETTABLE_PROPERTIES[this.nextProp++ % SETTABLE_PROPERTIES.length]
    if (property === undefined) throw new Error('pickProperty found no properties')
    return property
  }

  /**
   * Generate and apply `count` random ops.
   *
   * Op selection is biased toward `add` early so that later `move`/`set`/`delete` have
   * something to act on; a uniform distribution spends most of its budget deleting a
   * board that never had any shapes.
   */ runOps(count: number): Op[] {
    const applied: Op[] = []
    const ids: string[] = []

    for (let i = 0; i < count; i++) {
      const roll = this.random()
      let op: Op

      if (ids.length === 0 || roll < 0.35) {
        const id = `shp_${String(this.nextId++)}`
        op = {
          kind: 'add',
          id,
          x: Math.floor(this.random() * 2000),
          y: Math.floor(this.random() * 2000),
          w: 10 + Math.floor(this.random() * 200),
          h: 10 + Math.floor(this.random() * 200),
        }
        ids.push(id)
      } else {
        const id = this.pickId(ids)
        const pick = this.random()
        if (pick < 0.5) {
          op = {
            kind: 'move',
            id,
            x: Math.floor(this.random() * 2000),
            y: Math.floor(this.random() * 2000),
          }
        } else if (pick < 0.85) {
          const property = this.pickProperty()
          op = {
            kind: 'set',
            id,
            property,
            value:
              property === 'strokeWidth'
                ? Math.floor(this.random() * 5)
                : `#${Math.floor(this.random() * 0xffffff)
                    .toString(16)
                    .padStart(6, '0')}`,
          }
        } else {
          op = { kind: 'delete', id }
        }
      }

      this.apply(op)
      applied.push(op)
    }
    return applied
  }

  /**
   * Reconcile every replica by state vector.
   *
   * This is the join and heal path, and it is why the transport does not have to know
   * about joining: whatever the transport dropped or reordered, this closes the gap.
   * Converged replicas become no-ops here, which is exactly what idempotence means.
   *
   * One round is sufficient. The loops visit every ordered pair, so each replica both
   * sends what the others are missing and receives what it is missing within a single
   * pass; a second round would only re-derive the same empty diffs.
   */
  syncAll(): void {
    for (const source of this.replicas) {
      for (const target of this.replicas) {
        if (source === target) continue
        const update = encodeStateAsUpdate(source.doc, encodeStateVector(target.doc))
        applyUpdate(target.doc, update, 'remote')
      }
    }
  }

  /**
   * Run `count` ops in batches, delivering after each, then reconcile once.
   *
   * The batch size is the interesting part. Delivering after every op would leave one
   * message in the buffer at a time, and a one-message buffer cannot be reordered — the
   * permuting transport would report zero reordering and P2 would silently degrade into
   * P1. Delivering only at the very end of the run has the opposite problem: replicas see
   * nothing until the run is over, so nearly every `move` and `delete` targets a shape the
   * editing replica has never heard of and does nothing. Batching keeps a few messages in
   * flight, which is enough to reorder and enough for later ops to have something to act
   * on.
   */
  step(count: number, options: { batch?: number } = {}): Op[] {
    const batch = Math.max(1, options.batch ?? 5)
    const applied: Op[] = []

    for (let start = 0; start < count; start += batch) {
      const size = Math.min(batch, count - start)
      applied.push(...this.runOps(size))
      this.transport.flush()
    }
    this.syncAll()
    return applied
  }

  /** The canonical read for every replica, in replica order. */
  boards(): [string, Shape][][] {
    return this.replicas.map((r) => readBoard(r.doc))
  }

  destroy(): void {
    for (const r of this.replicas) r.doc.destroy()
  }
}

/**
 * Whether every replica has converged.
 *
 * Two independent oracles, because they fail differently. Equal state vectors mean the
 * replicas have the same set of structs. Equal canonical reads mean the structs mean the
 * same thing. A replica pair can agree on one and not the other, and which one failed is
 * the difference between "delivery is incomplete" and "the document diverged".
 *
 * Byte comparison of `Y.encodeStateAsUpdate` is deliberately absent. It is only valid
 * when every replica saw the same delivery order; see [13 §4](../docs/13-testing.md#3-property-and-fuzz-testing).
 */
export function converged(world: SimWorld): boolean {
  const [first_, ...rest] = world.replicas
  if (!first_) return true

  const referenceVector = encodeStateVector(first_.doc)
  const referenceBoard = readBoard(first_.doc)

  return rest.every((r) => {
    const sameVector = sameBytes(encodeStateVector(r.doc), referenceVector)
    const sameBoard = deepEqual(readBoard(r.doc), referenceBoard)
    return sameVector && sameBoard
  })
}

/** Byte-identical encoded state. Only meaningful for in-order delivery; see above. */
export function byteIdentical(world: SimWorld): boolean {
  const [first_, ...rest] = world.replicas
  if (!first_) return true
  const reference = encodeStateAsUpdate(first_.doc)
  return rest.every((r) => sameBytes(encodeStateAsUpdate(r.doc), reference))
}

/**
 * Byte equality without `Buffer`.
 *
 * `Buffer` is Node-only, and this module is going to be imported by the browser app that
 * drives the real canvas. A test helper that cannot be imported by the thing it is testing
 * is a helper that quietly stops being used.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Structural equality over the plain values `readBoard` returns.
 *
 * Not `JSON.stringify`. Serialising to compare re-couples the oracle to key order and to
 * how a value happens to render, so a shape that is genuinely equal can fail the check
 * after an unrelated refactor of the reader. And an unkeyed `NaN` serialises to `null`,
 * which is a way for two different boards to compare equal.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

export { after, first }
export type { Key }
