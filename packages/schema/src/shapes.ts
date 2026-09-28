/**
 * Shape types, their Yjs representation, and the reads over them.
 *
 * Two things about this file are load-bearing and easy to undo by accident.
 *
 * **The union is the API.** Every geometry helper below is written against `Shape`,
 * not against `RectShape`. `RectShape` is the only member today, so it is tempting to
 * type `boundsFor(shape: RectShape)` and add the union when there is a second member.
 * That is backwards: the second shape lands in the next commit, and by then the
 * rect-shaped signature is in three call sites. Ellipse shares no geometry with rect
 * (arc math, a different hit test), so it is the first real test of whether the
 * abstraction was honest. See [ADR-0002](../docs/adr/0002-shape-representation-and-z-order.md).
 *
 * **Reads are total.** A shape's `Y.Map` is legally observable before it is fully
 * populated, because a remote peer can receive and apply the creating update while the
 * local map is still being filled in. `readShape` therefore returns validated defaults
 * for absent fields and never throws. The alternative is a render-loop crash on a
 * perfectly legal concurrent creation, which is the single most likely way this layer
 * breaks in production. The exception is a map with no `type`, which is not a shape
 * at all and is reported as `null` rather than guessed at.
 *
 * Defaulting cannot mask a convergence failure, which is the obvious objection: this
 * model has LWW per property, so there is no per-property delete to converge, and the
 * only deletion is the whole-shape `lastDeleted` tombstone, which either converges
 * everywhere or nowhere. The canonical read the convergence tests use is built from
 * this same function on purpose, so a new shape type extends that oracle automatically
 * instead of needing a second list of property names maintained in the tests.
 */

import { Map as YMap, type Doc } from 'yjs'
import { first, type Key } from './fractional-index.js'

/** Discriminants. Adding a member means adding a case to every function below. */
export const SHAPE_TYPES = ['rect'] as const
export type ShapeType = (typeof SHAPE_TYPES)[number]

/** A shape's position and size in board coordinates. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Paint, shared by every shape type. */
export interface Style {
  fill: string
  stroke: string
  strokeWidth: number
  /** Degrees, clockwise. */
  rotation: number
}

/**
 * A rectangle.
 *
 * The discriminant is the literal `'rect'`, not `ShapeType`. That is what makes the
 * union narrow, so `switch (shape.type)` gives real exhaustiveness checking instead of
 * a default branch that quietly swallows new types.
 */
export interface RectShape extends Rect, Style {
  type: 'rect'
  id: string
  /** Fractional z-order key. Opaque: see `fractional-index.ts`. */
  z: Key
  /**
   * Deletion tombstone. A delete is a write of `true` rather than a map removal so
   * that a concurrent edit to a deleted shape loses to the tombstone instead of
   * resurrecting it. See [ADR-0002](../docs/adr/0002-shape-representation-and-z-order.md).
   */
  lastDeleted: boolean
}

/** Every shape. One member today; the union is the point. */
export type Shape = RectShape

export const DEFAULT_STYLE: Style = {
  fill: '#ffffff',
  stroke: '#2a2622',
  strokeWidth: 1,
  rotation: 0,
}

const DEFAULT_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 }

/** A shape as stored in a `Y.Map`, before validation. */
export type ShapeMap = YMap<unknown>

/**
 * Where shapes live on a document: a parent `Y.Map` keyed by shape id, each value a
 * `Y.Map` of properties. Flat rather than segmented by type, per ADR-0002, because a
 * reorder must be a key write and segmentation buys nothing at 5,000 shapes.
 */
export const SHAPES_KEY = 'shapes'

export function shapesMap(doc: Doc): YMap<ShapeMap> {
  return doc.getMap<ShapeMap>(SHAPES_KEY)
}

/** Parameters for creating a shape. `z` and `id` are the caller's to choose. */
export interface CreateShapeParams {
  id: string
  z?: Key
  rect?: Partial<Rect>
  style?: Partial<Style>
}

/**
 * Create a rect and insert it into the document.
 *
 * Writes into a pre-built `Y.Map` and then inserts it, rather than inserting an empty
 * map and setting properties afterwards. Yjs only batches a transaction's writes into
 * one update if they happen in one transaction *and* the map is not observed
 * mid-construction; a peer that can see the map before it is full is exactly the
 * partially-populated state the read side is built to tolerate, so this avoids creating
 * that state deliberately as well.
 */
export function createRectShape(doc: Doc, params: CreateShapeParams): ShapeMap {
  const shapes = shapesMap(doc)
  if (shapes.has(params.id)) {
    throw new Error(`shape ${params.id} already exists`)
  }

  const shape: ShapeMap = new YMap()
  shape.set('id', params.id)
  shape.set('type', 'rect' satisfies ShapeType)
  shape.set('z', params.z ?? first())
  shape.set('lastDeleted', false)
  shape.set('x', params.rect?.x ?? DEFAULT_RECT.x)
  shape.set('y', params.rect?.y ?? DEFAULT_RECT.y)
  shape.set('w', params.rect?.w ?? DEFAULT_RECT.w)
  shape.set('h', params.rect?.h ?? DEFAULT_RECT.h)
  shape.set('fill', params.style?.fill ?? DEFAULT_STYLE.fill)
  shape.set('stroke', params.style?.stroke ?? DEFAULT_STYLE.stroke)
  shape.set('strokeWidth', params.style?.strokeWidth ?? DEFAULT_STYLE.strokeWidth)
  shape.set('rotation', params.style?.rotation ?? DEFAULT_STYLE.rotation)

  doc.transact(() => {
    shapes.set(params.id, shape)
  })
  return shape
}

/** Mark a shape deleted. A write of a tombstone, not a map removal. */
export function deleteShape(doc: Doc, id: string): void {
  const shape = shapesMap(doc).get(id)
  if (!shape) throw new Error(`no shape ${id}`)
  doc.transact(() => {
    shape.set('lastDeleted', true)
  })
}

/** Read a finite number, falling back when absent, non-numeric, NaN, or infinite. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function readRect(map: ShapeMap): RectShape {
  return {
    id: str(map.get('id'), ''),
    type: 'rect',
    z: str(map.get('z'), first()),
    lastDeleted: map.get('lastDeleted') === true,
    x: num(map.get('x'), DEFAULT_RECT.x),
    y: num(map.get('y'), DEFAULT_RECT.y),
    w: num(map.get('w'), DEFAULT_RECT.w),
    h: num(map.get('h'), DEFAULT_RECT.h),
    fill: str(map.get('fill'), DEFAULT_STYLE.fill),
    stroke: str(map.get('stroke'), DEFAULT_STYLE.stroke),
    strokeWidth: num(map.get('strokeWidth'), DEFAULT_STYLE.strokeWidth),
    rotation: num(map.get('rotation'), DEFAULT_STYLE.rotation),
  }
}

/**
 * Whether a value in the shapes collection is a shape map.
 *
 * A value there is whatever a peer put there, and a peer may be running a version that
 * stores something else — or may simply be corrupt. `readShape` is documented to return
 * null for a value that is not a shape, and it cannot keep that promise by calling
 * `map.get` on something that has no `get`.
 */
function isShapeMap(value: unknown): value is ShapeMap {
  return (
    typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function'
  )
}

/**
 * Read a stored map into a validated shape, or null if it is not one.
 *
 * Returns null for a missing or unrecognised `type`, which is the honest answer: a map
 * with no discriminant cannot be dispatched, and guessing a default type would invent a
 * shape that no peer created. Every other absent field is defaulted, because those are
 * the ones a concurrent create can legitimately be missing.
 */
export function readShape(map: ShapeMap): Shape | null {
  if (!isShapeMap(map)) return null
  switch (map.get('type')) {
    case 'rect':
      return readRect(map)
    default:
      return null
  }
}

/**
 * The board's shapes, in a canonical order, excluding tombstones.
 *
 * This is the canonical read the convergence tests compare, and it is built from
 * `readShape` on purpose. A test oracle maintained separately would need its own list of
 * every shape's properties, and adding a shape type would leave that list stale: the
 * test would keep passing while no longer covering the new fields. Deriving it means
 * the oracle is correct by construction.
 *
 * Sorted by id rather than left in `Y.Map` insertion order, so that two replicas which
 * converged produce the same array. Returned as an array of entries so the caller can
 * compare structurally and get a diff that names the offending shape.
 */
export function readBoard(doc: Doc): [string, Shape][] {
  const out: [string, Shape][] = []
  for (const [id, map] of shapesMap(doc)) {
    const shape = readShape(map)
    if (shape && !shape.lastDeleted) out.push([id, shape])
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** Axis-aligned bounds in board coordinates, before rotation. */
export function boundsFor(shape: Shape): Rect {
  switch (shape.type) {
    case 'rect':
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
  }
}

export interface Point {
  x: number
  y: number
}

/** Whether a board-space point is inside the shape. */
export function hitTest(shape: Shape, point: Point): boolean {
  const b = boundsFor(shape)
  // Normalise the sign so a shape dragged to negative width or height still hit-tests.
  const left = Math.min(b.x, b.x + b.w)
  const right = Math.max(b.x, b.x + b.w)
  const top = Math.min(b.y, b.y + b.h)
  const bottom = Math.max(b.y, b.y + b.h)
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
}
