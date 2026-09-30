/**
 * The render-side mirror of the document: a dense, typed-array view of every shape.
 *
 * 03 §1 and §2 are the reason this file exists. The document holds the truth, and it
 * holds it as a `Y.Map` of `Y.Map`, which is a fine shape for merging and a poor one for
 * drawing: every read walks a proxy and hands back a fresh object, so drawing 5,000
 * shapes would allocate 5,000 objects per frame. That is the GC-driven frame-time
 * sawtooth the doc warns about, arriving through the back door of a convenient API.
 *
 * So geometry lives here, in parallel arrays in world coordinates, refilled only when the
 * document actually changes:
 *
 *     x, y, w, h, rotation, fillIndex, strokeIndex, strokeWidth   Float32Array
 *     axis-aligned bounds of the rotated shape                     Float32Array
 *     id -> dense index                                           Map
 *
 * The draw loop reads these and allocates nothing. A change to the document triggers a
 * refill; a pan does not, because a pan moves the camera and not the shapes.
 *
 * What this is *not* is a second source of truth. Every value here is derived, `refill`
 * is the only writer, and `refill` reads through the schema's own `readShape` — the same
 * function the convergence tests assert on. A mirrored copy that drifts is the bug the doc
 * warns about, and the only defence is having exactly one path from Yjs into it.
 *
 * ## Rotation
 *
 * `rotation` is in degrees, counter-clockwise, about the shape's *centre*. `x`/`y`/`w`/`h`
 * describe the unrotated box; the rotated box is what gets drawn, hit-tested and framed by
 * handles. Rotating about the centre is what makes the eight overlay handles line up with
 * what the user sees, and it is the convention the renderer assumes throughout — so if it
 * ever changes, it changes here and in `containsPoint` together.
 *
 * ## Negative extents
 *
 * The schema accepts any finite `w`/`h`, including negative ones, because a concurrent
 * write can land before the one that finishes the rectangle. Nothing here assumes
 * non-negative extents: bounds are computed as min/max, so a rect dragged up and to the
 * left is hit-tested and culled by where it actually appears rather than by the direction
 * the drag happened to go.
 */

import type { Doc } from 'yjs'
import {
  HIT_TOLERANCE,
  distanceToPolyline,
  distanceToSegment,
  readShape,
  shapesMap,
  type Shape,
} from '@mesob/schema'

/** Floats per shape. Kept in one place because the stride is used by every accessor. */
export const STRIDE = 12

/** Field offsets within a shape's row. */
export const Field = {
  X: 0,
  Y: 1,
  W: 2,
  H: 3,
  Rotation: 4,
  FillIndex: 5,
  StrokeIndex: 6,
  StrokeWidth: 7,
  MinX: 8,
  MinY: 9,
  MaxX: 10,
  MaxY: 11,
} as const

export type Field = (typeof Field)[keyof typeof Field]

export interface ShapeStoreOptions {
  /** Initial capacity. Grown by doubling, because a 5,000-shape board is not a surprise. */
  capacity?: number
}

/**
 * The render-side mirror of the document: geometry in typed arrays, keyed by a dense
 * index.
 *
 * Deliberately not a Yjs observer. It exposes `observe`, and the caller wires that to the
 * document, which keeps the store testable without a document and lets a test drive a
 * refill deterministically.
 */
export class ShapeStore {
  /**
   * Geometry, `STRIDE` floats per shape, world coordinates.
   *
   * Reads are written as plain indexed accesses. This package's tsconfig relaxes
   * `noUncheckedIndexedAccess` for exactly this reason: every index here is either a
   * dense index the store itself bounds or a `base + field` built from one, so the check
   * adds `| undefined` to values that cannot be undefined. Honouring it would mean either
   * a cast or a branch at every coordinate of every shape — in a file whose only job is
   * to keep per-shape cost at zero. The relaxation is scoped to this package, and every
   * `Map` and array lookup in it is still checked by hand.
   */
  private data = new Float32Array(0)
  /** Shape id per dense index, so a draw or a hit can report a real id. */
  private ids: string[] = []
  /** id -> dense index. */
  private index = new Map<string, number>()
  /** The full shape behind each index, for z ordering and anything the floats drop. */
  private shapes: Shape[] = []
  /** Live, non-tombstoned count. Less than capacity when shapes have been deleted. */
  private count = 0
  private listeners = new Set<() => void>()

  constructor(options: ShapeStoreOptions = {}) {
    this.allocate(Math.max(16, options.capacity ?? 256))
  }

  private allocate(capacity: number): void {
    const next = new Float32Array(capacity * STRIDE)
    // Copy the live rows, not the whole old buffer: a board that shrank should not pay
    // to move the slack it no longer uses.
    next.set(this.data.subarray(0, this.count * STRIDE))
    this.data = next
  }

  get size(): number {
    return this.count
  }

  get capacity(): number {
    return this.data.length / STRIDE
  }

  shapeAt(i: number): Shape | undefined {
    return this.shapes[i]
  }

  idAt(i: number): string | undefined {
    return this.ids[i]
  }

  indexOf(id: string): number {
    return this.index.get(id) ?? -1
  }

  /**
   * One geometry field of one shape.
   *
   * `noUncheckedIndexedAccess` widens every typed-array read to `number | undefined`, and
   * these indices are dense indices the store itself bounds, so it cannot actually be
   * undefined. Paying for that with a cast at each of the forty reads below, or with a
   * branch at each, would put the cost exactly where the file exists to keep it out of.
   *
   * So the check happens once, here. One comparison the branch predictor will never get
   * wrong beats forty scattered ones. The alternative was a per-package tsconfig relaxing
   * the flag, which does not work in this repo: packages are consumed as raw TypeScript
   * source, so a consumer recompiles these files under its own settings and the relaxation
   * would pass locally while failing on use. That is worse than no relaxation at all.
   */
  private f(i: number, field: Field): number {
    const value = this.data[i * STRIDE + field]
    return value ?? 0
  }

  /** One geometry field, by stride offset. */
  get(i: number, field: Field): number {
    return this.f(i, field)
  }

  x(i: number): number {
    return this.f(i, Field.X)
  }

  y(i: number): number {
    return this.f(i, Field.Y)
  }

  w(i: number): number {
    return this.f(i, Field.W)
  }

  h(i: number): number {
    return this.f(i, Field.H)
  }

  rotation(i: number): number {
    return this.f(i, Field.Rotation)
  }

  strokeWidth(i: number): number {
    return this.f(i, Field.StrokeWidth)
  }

  fillColorAt(i: number): string {
    return colorAt(this.f(i, Field.FillIndex))
  }

  strokeColorAt(i: number): string {
    return colorAt(this.f(i, Field.StrokeIndex))
  }

  /** Left edge of the shape's rotated bounds. */
  minX(i: number): number {
    return this.f(i, Field.MinX)
  }

  minY(i: number): number {
    return this.f(i, Field.MinY)
  }

  maxX(i: number): number {
    return this.f(i, Field.MaxX)
  }

  maxY(i: number): number {
    return this.f(i, Field.MaxY)
  }

  /**
   * Rebuild from the document. The only writer.
   *
   * @param doc the document to read.
   */
  refill(doc: Doc): void {
    // A tombstone has to leave the dense array, and compaction is the honest way to do
    // that. The alternative is a free list, which trades a rare O(n) pass for permanent
    // fragmentation and a draw loop that checks for a hole on every shape, every frame.
    this.count = 0
    this.index.clear()

    for (const [id, map] of shapesMap(doc)) {
      const shape = readShape(map)
      if (!shape || shape.lastDeleted) continue

      if (this.count >= this.capacity) this.allocate(this.capacity * 2)

      const i = this.count
      this.write(i, shape)
      this.ids[i] = id
      this.shapes[i] = shape
      this.index.set(id, i)
      this.count++
    }

    this.orderByZ()

    // Trim the id and shape arrays so a shrunken board releases the strings it no longer
    // needs. The Float32Array keeps its capacity on purpose: capacity is cheap, and
    // regrowing on every delete/add cycle is how a board starts hitching.
    this.ids.length = this.count
    this.shapes.length = this.count

    for (const listener of this.listeners) listener()
  }

  private write(i: number, shape: Shape): void {
    const base = i * STRIDE
    this.data[base + Field.X] = shape.x
    this.data[base + Field.Y] = shape.y
    this.data[base + Field.W] = shape.w
    this.data[base + Field.H] = shape.h
    this.data[base + Field.Rotation] = shape.rotation
    this.data[base + Field.StrokeWidth] = shape.strokeWidth
    // Colours are interned rather than stored per shape. 03 §2 requires a run of 500
    // identical rects to set `fillStyle` once, and that comparison is only possible if
    // two shapes of the same colour hold the same value.
    this.data[base + Field.FillIndex] = internColor(shape.fill)
    this.data[base + Field.StrokeIndex] = internColor(shape.stroke)
    this.writeBounds(i, shape.x, shape.y, shape.w, shape.h, shape.rotation)
  }

  /**
   * Cache the shape's rotated axis-aligned bounds.
   *
   * Culling on the stored `x`/`y`/`w`/`h` would be wrong for any rotated shape: a bar
   * 100 wide by 10 tall, turned 90 degrees, occupies a box that is 10 wide by 100 tall,
   * and culling on the unrotated numbers drops it from a view it is plainly inside of.
   *
   * The bounds are cached at refill rather than derived per frame because they only
   * change when the shape does, and two `Math.cos`/`Math.sin` calls per shape per frame
   * is exactly the kind of cost that is invisible in a profiler and obvious at 60fps.
   */
  private writeBounds(
    i: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation: number,
  ): void {
    const base = i * STRIDE
    const minX = x + Math.min(0, w)
    const minY = y + Math.min(0, h)
    const maxX = x + Math.max(0, w)
    const maxY = y + Math.max(0, h)

    if (rotation === 0) {
      this.data[base + Field.MinX] = minX
      this.data[base + Field.MinY] = minY
      this.data[base + Field.MaxX] = maxX
      this.data[base + Field.MaxY] = maxY
      return
    }

    const radians = (rotation * Math.PI) / 180
    const cos = Math.abs(Math.cos(radians))
    const sin = Math.abs(Math.sin(radians))
    const halfW = Math.abs(w) / 2
    const halfH = Math.abs(h) / 2
    // Half-extents of the unrotated box about its own centre, then rotated.
    const rx = halfW * cos + halfH * sin
    const ry = halfW * sin + halfH * cos
    const cx = minX + halfW
    const cy = minY + halfH

    this.data[base + Field.MinX] = cx - rx
    this.data[base + Field.MinY] = cy - ry
    this.data[base + Field.MaxX] = cx + rx
    this.data[base + Field.MaxY] = cy + ry
  }

  /** Subscribe to refills. Returns an unsubscribe function. */
  observe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Indices of shapes overlapping the view rectangle, in draw order.
   *
   * Writes into `out` and returns the count. The caller owns the buffer, so culling a
   * 5,000-shape board allocates nothing per frame. This is a broad phase: a rotated shape
   * is kept whenever its bounds are touched, and the narrow phase is the caller's precise
   * test, so the answer errs towards drawing rather than towards holes.
   */
  cull(viewX: number, viewY: number, viewW: number, viewH: number, out: Int32Array): number {
    let n = 0
    const limit = Math.min(this.count, out.length)
    const right = viewX + viewW
    const bottom = viewY + viewH
    for (let i = 0; i < this.count && n < limit; i++) {
      if (
        this.f(i, Field.MaxX) >= viewX &&
        this.f(i, Field.MinX) <= right &&
        this.f(i, Field.MaxY) >= viewY &&
        this.f(i, Field.MinY) <= bottom
      ) {
        out[n] = i
        n++
      }
    }
    return n
  }

  /**
   * Sort the dense arrays into z order.
   *
   * Geometry rows are copied alongside the ids, and the index map is rebuilt, so
   * `cull` and `hitTest` both see one consistent order. Runs on refill, not per frame:
   * copying `STRIDE` floats per swap is not something to do 60 times a second.
   */
  orderByZ(): void {
    if (this.count < 2) return

    const order: number[] = new Array<number>(this.count)
    for (let i = 0; i < this.count; i++) order[i] = i
    order.sort((a, b) => {
      const za = this.shapes[a]?.z ?? ''
      const zb = this.shapes[b]?.z ?? ''
      return za < zb ? -1 : za > zb ? 1 : 0
    })

    let alreadyOrdered = true
    for (let i = 0; i < order.length; i++) {
      if (order[i] !== i) {
        alreadyOrdered = false
        break
      }
    }
    if (alreadyOrdered) return

    const nextData = new Float32Array(this.data.length)
    const nextIds: string[] = new Array<string>(this.count)
    const nextShapes: Shape[] = new Array<Shape>(this.count)

    for (let target = 0; target < order.length; target++) {
      const source = order[target]
      if (source === undefined) continue
      nextData.set(this.data.subarray(source * STRIDE, source * STRIDE + STRIDE), target * STRIDE)
      nextIds[target] = this.ids[source] ?? ''
      const shape = this.shapes[source]
      if (shape) nextShapes[target] = shape
    }

    this.data = nextData
    this.ids = nextIds
    this.shapes = nextShapes
    this.index.clear()
    for (let i = 0; i < this.count; i++) {
      const id = nextIds[i]
      if (id !== undefined) this.index.set(id, i)
    }
  }

  /**
   * The topmost shape containing a world point, or -1.
   *
   * 03 §2 prescribes iterating the z-sorted set in reverse and testing precisely after
   * the cheap rejection. For a rect the precise test refines the same question rather
   * than asking a different one; the separation earns its keep for ellipse and pen,
   * which is why the bounds are checked separately from the exact test rather than
   * folded into it.
   *
   * The rejection above is the stored rotated bounding box, which for an ellipse is a
   * strict superset of the curve — the box of a 4:1 ellipse is 28% larger in area than the
   * curve it contains. That is the correct direction for a cull: it may keep a shape it
   * could have dropped, and it must never drop one it should keep. Tightening it would
   * mean storing a second set of floats per shape, for a bound that only matters for
   * ellipses and only as an optimisation.
   *
   * `tolerance` is the grab radius for the types with no interior — a line and a pen are
   * strokes, so "contains" means "close to". It is in world units and the caller divides
   * the zoom out of a screen-pixel radius, exactly as `hitHandle` does; a stroke hit-tested
   * at a fixed world radius is ungrabbable at 0.05x and impossible to hit at 8x.
   */
  hitTest(worldX: number, worldY: number, tolerance = HIT_TOLERANCE): number {
    for (let i = this.count - 1; i >= 0; i--) {
      if (
        this.f(i, Field.MaxX) < worldX ||
        this.f(i, Field.MinX) > worldX ||
        this.f(i, Field.MaxY) < worldY ||
        this.f(i, Field.MinY) > worldY
      ) {
        continue
      }
      if (this.containsPoint(i, worldX, worldY, tolerance)) return i
    }
    return -1
  }

  /**
   * The precise test for one shape, dispatched on its discriminant.
   *
   * A switch with no default branch, so a type that reaches the store without a case here
   * is a compile error rather than a shape the cull keeps and the click never finds. The
   * only non-exhaustive case is the `!shape` one, and that returns false: a dense index
   * with no shape behind it cannot be drawn, and a hit test that could find it would
   * select something invisible.
   */
  private containsPoint(i: number, worldX: number, worldY: number, tolerance: number): boolean {
    const shape = this.shapeAt(i)
    if (!shape) return false
    switch (shape.type) {
      case 'rect':
      case 'note':
        return containsPoint(shape.x, shape.y, shape.w, shape.h, worldX, worldY, shape.rotation)
      case 'ellipse':
        return containsEllipsePoint(
          shape.x,
          shape.y,
          shape.w,
          shape.h,
          worldX,
          worldY,
          shape.rotation,
        )
      case 'line':
        return (
          distanceToSegment(worldX, worldY, shape.x1, shape.y1, shape.x2, shape.y2) <= tolerance
        )
      case 'pen':
        return distanceToPolyline(shape.points, worldX, worldY) <= tolerance
    }
  }

  /** Indices of shapes overlapping a world rectangle, topmost first. Writes into `out`. */
  hitTestRect(
    worldX: number,
    worldY: number,
    worldW: number,
    worldH: number,
    out: number[],
  ): number {
    out.length = 0
    const right = worldX + worldW
    const bottom = worldY + worldH
    for (let i = this.count - 1; i >= 0; i--) {
      if (
        this.f(i, Field.MaxX) >= worldX &&
        this.f(i, Field.MinX) <= right &&
        this.f(i, Field.MaxY) >= worldY &&
        this.f(i, Field.MinY) <= bottom
      ) {
        out.push(i)
      }
    }
    return out.length
  }
}

/**
 * A point in a shape's own frame: origin at the top-left of its unrotated box, axes along
 * its own edges.
 *
 * Returns a shared object rather than a fresh one. The alternative is an allocation per
 * candidate shape inside the hit-test loop, and the store holds twelve floats per shape
 * precisely to avoid that. Safe because the caller reads it before the next call and
 * nothing re-enters in between; it is module-private so no caller can hold it across a
 * second call.
 */
const localFrame = { x: 0, y: 0 }

function toLocalFrame(
  x: number,
  y: number,
  w: number,
  h: number,
  px: number,
  py: number,
  rotationDegrees: number,
): { x: number; y: number } {
  const halfW = Math.abs(w) / 2
  const halfH = Math.abs(h) / 2
  const cx = x + Math.min(0, w) + halfW
  const cy = y + Math.min(0, h) + halfH
  const radians = (rotationDegrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = px - cx
  const dy = py - cy
  // Rotating the point by the negated angle about the shape's centre avoids allocating a
  // matrix, which is the reason the shape is twelve floats and not something with a
  // `getTransform()` on it.
  localFrame.x = dx * cos + dy * sin + halfW
  localFrame.y = -dx * sin + dy * cos + halfH
  return localFrame
}

/**
 * Point in a rotated rectangle, tested in that rectangle's own space.
 */
export function containsPoint(
  x: number,
  y: number,
  w: number,
  h: number,
  px: number,
  py: number,
  rotationDegrees: number,
): boolean {
  const minX = x + Math.min(0, w)
  const minY = y + Math.min(0, h)
  const maxX = x + Math.max(0, w)
  const maxY = y + Math.max(0, h)

  // An unrotated box is the common case by a wide margin, and it needs no trig at all.
  if (rotationDegrees === 0) {
    return px >= minX && px <= maxX && py >= minY && py <= maxY
  }

  const l = toLocalFrame(x, y, w, h, px, py, rotationDegrees)
  return l.x >= 0 && l.x <= Math.abs(w) && l.y >= 0 && l.y <= Math.abs(h)
}

/**
 * Point in a rotated ellipse, tested as an ellipse and not as its box.
 *
 * The box test is right for a rect and wrong for this, in the way a user notices: it
 * makes the four corners of every ellipse clickable, so a shape gets dragged that was
 * never clicked. Normalising by the semi-axes and comparing a squared length against 1 is
 * the curve's own definition, so the answer is a property of the shape rather than of its
 * container.
 */
export function containsEllipsePoint(
  x: number,
  y: number,
  w: number,
  h: number,
  px: number,
  py: number,
  rotationDegrees: number,
): boolean {
  const halfW = Math.abs(w) / 2
  const halfH = Math.abs(h) / 2

  // A zero radius collapses the ellipse to a line or a point, which is exactly the
  // degenerate rect `containsPoint` already tests correctly. Handing it back is both
  // correct and cheaper than re-deriving, and it keeps a shape the user drew by accident
  // selectable, and so deletable, instead of dividing by zero — which would give NaN, and
  // NaN <= 1 is false, silently missing a click that landed exactly on it.
  if (halfW === 0 || halfH === 0) return containsPoint(x, y, w, h, px, py, rotationDegrees)

  const cx = x + Math.min(0, w) + halfW
  const cy = y + Math.min(0, h) + halfH

  if (rotationDegrees === 0) {
    const dx = (px - cx) / halfW
    const dy = (py - cy) / halfH
    return dx * dx + dy * dy <= 1
  }

  const l = toLocalFrame(x, y, w, h, px, py, rotationDegrees)
  const nx = (l.x - halfW) / halfW
  const ny = (l.y - halfH) / halfH
  return nx * nx + ny * ny <= 1
}

/**
 * Colour interning.
 *
 * Two shapes of the same colour must map to the same index, so the draw loop can
 * compare and set `fillStyle` once per run instead of once per shape. `Map` lookup beats
 * a string comparison per shape, and growth is bounded: a board has tens of distinct
 * colours, not thousands.
 */
const colors = new Map<string, number>()
const colorList: string[] = []

export function internColor(color: string): number {
  const existing = colors.get(color)
  if (existing !== undefined) return existing
  const i = colorList.length
  colorList.push(color)
  colors.set(color, i)
  return i
}

export function colorAt(index: number): string {
  return colorList[index] ?? 'transparent'
}
