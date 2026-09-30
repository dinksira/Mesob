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
export const SHAPE_TYPES = ['rect', 'ellipse', 'line', 'note', 'pen'] as const
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

/**
 * An ellipse, inscribed in the box `x`/`y`/`w`/`h`.
 *
 * Stored as its box rather than as a centre and two radii, because that is the geometry
 * every box operation already speaks: culling, framing, the selection box, the eight
 * handles, a drag to create. A shape that cannot be resized with the existing handles
 * would need a second interaction model, and this one gets none.
 */
export interface EllipseShape extends Rect, Style {
  type: 'ellipse'
  id: string
  /** Fractional z-order key. Opaque: see `fractional-index.ts`. */
  z: Key
  /** See [ADR-0002](../docs/adr/0002-shape-representation-and-z-order.md). */
  lastDeleted: boolean
}

/**
 * A straight segment from `x1`/`y1` to `x2`/`y2`.
 *
 * There is no separate arrow type. `head` is the whole difference, per the design's rule
 * that an arrow with no arrowhead is a line: a second type would double every dispatch in
 * this file to differ by one boolean, and the merge surface would grow for nothing.
 *
 * The box is stored alongside the endpoints rather than derived at read time, because every
 * consumer downstream — the cull, the store's twelve floats, the selection chrome — reads
 * `x`/`y`/`w`/`h` and nothing else. A shape whose bounds had to be recomputed per reader
 * would be the first shape that is not usable by the existing array layout, and that is a
 * much larger concession than a stored box that has to be kept in step with the endpoints.
 * `createLineShape` is the only writer, and it computes the box from the endpoints.
 */
export interface LineShape extends Style {
  type: 'line'
  id: string
  /** Fractional z-order key. Opaque: see `fractional-index.ts`. */
  z: Key
  /** See [ADR-0002](../docs/adr/0002-shape-representation-and-z-order.md). */
  lastDeleted: boolean
  x1: number
  y1: number
  x2: number
  y2: number
  /** Bounds of the two endpoints, kept in step by `createLineShape`. */
  x: number
  y: number
  w: number
  h: number
  /** An arrowhead at the `x2`/`y2` end. `false` is a plain line. */
  head: boolean
}

/**
 * A note: a boxed shape carrying text.
 *
 * The only text-bearing shape in Phase 1, and deliberately so — the empty state, the G1
 * Amharic criterion and the whole "you can write on this board" story rest on this one
 * primitive, and a second text shape would double that surface for a difference the design
 * already decided against.
 *
 * `text` is a plain string, last-writer-wins. That is a Phase 1 decision, not an oversight:
 * a stroke is committed once and two people editing the same note's characters is a Phase 4
 * problem, where the doc becomes a Yjs text type. Storing a string here is honest about what
 * it converges as, and swapping it for a `Y.Text` later is a change to this one reader.
 */
export interface NoteShape extends Rect, Style {
  type: 'note'
  id: string
  /** Fractional z-order key. Opaque: see `fractional-index.ts`. */
  z: Key
  /** See [ADR-0002](../docs/adr/0002-shape-representation-and-z-order.md). */
  lastDeleted: boolean
  text: string
}

/**
 * A freehand stroke.
 *
 * `points` is a flat `[x0, y0, x1, y1, ...]` run rather than an array of pairs, for the same
 * reason the store is a run of floats: a two-element object per sample is an allocation per
 * point, and the design requires the buffer to be preallocated and reused across strokes.
 *
 * A plain array stored as a value, not a `Y.Array`. Every point arrives in a single
 * committed write, so there is never a partial point list to merge character by character;
 * making it a `Y.Array` would buy merge semantics nothing here can use and cost the
 * flattening the renderer and the hit test both need.
 */
export interface PenShape extends Style {
  type: 'pen'
  id: string
  /** Fractional z-order key. Opaque: see `fractional-index.ts`. */
  z: Key
  /** See [ADR-0002](../docs/adr/0002-shape-representation-and-z-order.md). */
  lastDeleted: boolean
  /** Flat x,y pairs. The simplified run, not the raw pointer samples. */
  points: number[]
  /** Bounds of the points, kept in step by `createPenShape`. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * Every shape.
 *
 * The point of a union here is that the compiler knows when a new type has missed a
 * dispatch. `boundsFor` and `readShape` switch on `type` with no default branch, so
 * adding a member without handling it is a type error rather than a shape that silently
 * fails to draw.
 */
export type Shape = RectShape | EllipseShape | LineShape | NoteShape | PenShape

/**
 * The members that are described by a box.
 *
 * A note is here and a line is not. A note is a box with text in it, so it moves, resizes
 * and frames through the existing eight handles with no new code. A line is not: its box is
 * derived from its endpoints, and dragging a corner of that box has no meaning for a
 * segment, so it is rejected by `isBoxedShape` rather than given eight handles that lie.
 */
export type BoxedShape = RectShape | EllipseShape | NoteShape

export const DEFAULT_STYLE: Style = {
  fill: '#ffffff',
  stroke: '#2a2622',
  strokeWidth: 1,
  rotation: 0,
}

/**
 * Per-type style defaults, applied by the factories rather than by `DEFAULT_STYLE`.
 *
 * A filled shape and a stroked one want opposite things, and there is no single default
 * that is right for both: `DEFAULT_STYLE` fills white, which is right for a rect and wrong
 * for a pen stroke — a white fill on an open path fills nothing but still costs a paint,
 * and a note that filled white on a cream board would have no edge.
 *
 * These are shape data rather than palette tokens. A note is paper, and undyed straw is the
 * same reasoning that chose the substrate; a stroke is charcoal, which is the one ink colour
 * the tokens already name. The amber-tinted paper is deliberately outside the four brand
 * tokens: those govern chrome and accents, and a shape fill is neither.
 */
const DEFAULT_STROKE_ONLY: Style = { ...DEFAULT_STYLE, fill: 'transparent', strokeWidth: 2 }
const DEFAULT_NOTE: Style = { ...DEFAULT_STYLE, fill: '#f6efdc' }

/**
 * The size of a note made by a click.
 *
 * Here rather than in the controller, because it is a property of the shape — "how big is a
 * note before anyone has resized it" has one answer, and the controller holding a second copy
 * would let the two drift so that a note made by clicking and a note made by a peer with the
 * same code path came out different sizes.
 *
 * Roughly a screen's worth of text at the design's 14px, which is a note you can read a
 * sentence in and a note you can still drag away by its edge.
 */
export const DEFAULT_NOTE_RECT: Rect = { x: 0, y: 0, w: 180, h: 120 }

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

/** `createLineShape` parameters. The endpoints define the box, not the other way round. */
export interface CreateLineParams {
  id: string
  z?: Key
  x1: number
  y1: number
  x2: number
  y2: number
  /** Arrowhead at the second endpoint. Defaults to a plain line. */
  head?: boolean
  style?: Partial<Style>
}

/** `createPenShape` parameters. `points` is a flat `[x0, y0, x1, y1, ...]` run. */
export interface CreatePenParams {
  id: string
  z?: Key
  points: number[]
  style?: Partial<Style>
}

/**
 * Whether a shape is described entirely by the box it is stored with.
 *
 * This is the question every resize interaction has to ask, and the answer has to live in
 * one place. Asking it inline as `shape.type === 'rect'` is how a box-driven feature ends
 * up working for rects and silently doing nothing for the next type added — the branch is
 * not a type error, it is correct code for the only member of the union at the time. A
 * `line` is the first shape this rejects and rejecting it is the point: a line cannot be
 * resized by dragging its box's corners, so a caller reaching this guard has to say so
 * rather than getting a box that lies.
 */
export function isBoxedShape(shape: Shape | null | undefined): shape is BoxedShape {
  return shape?.type === 'rect' || shape?.type === 'ellipse' || shape?.type === 'note'
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
  return insertShape(doc, 'rect', params, { ...DEFAULT_STYLE, ...params.style })
}

/** Create an ellipse inscribed in `params.rect` and insert it. Same storage as a rect. */
export function createEllipseShape(doc: Doc, params: CreateShapeParams): ShapeMap {
  return insertShape(doc, 'ellipse', params, { ...DEFAULT_STYLE, ...params.style })
}

/**
 * Create a note and insert it.
 *
 * A note takes a per-type default fill rather than `DEFAULT_STYLE`'s white, because white
 * paper on a cream board has no edge. The box is optional: a click with no drag makes a
 * default-sized note, which is how the tool is meant to be used most of the time.
 */
export function createNoteShape(doc: Doc, params: CreateShapeParams): ShapeMap {
  // A caller with no box gets the default size rather than a zero-size note. A note is used
  // by clicking more often than by dragging, so "no box" is the common case and a note that
  // comes out invisible and unselectable would be the common failure.
  const box = params.rect ?? DEFAULT_NOTE_RECT
  return insertShape(
    doc,
    'note',
    { ...params, rect: box },
    { ...DEFAULT_NOTE, ...params.style },
    { text: '' },
  )
}

/**
 * Create a straight segment and insert it, deriving its box from the endpoints.
 *
 * The box is derived here rather than trusted from the caller, because a line is defined by
 * its endpoints and a box that disagreed with them would produce a cull and a selection ring
 * in the wrong place. `head` is a property of the one primitive, per the design's rule that
 * an arrow with no arrowhead is a line.
 */
export function createLineShape(doc: Doc, params: CreateLineParams): ShapeMap {
  const box = boundsOfPoints([params.x1, params.y1, params.x2, params.y2])
  const shape: ShapeMap = new YMap()
  shape.set('id', params.id)
  shape.set('type', 'line')
  shape.set('z', params.z ?? first())
  shape.set('lastDeleted', false)
  shape.set('x1', params.x1)
  shape.set('y1', params.y1)
  shape.set('x2', params.x2)
  shape.set('y2', params.y2)
  shape.set('x', box.x)
  shape.set('y', box.y)
  shape.set('w', box.w)
  shape.set('h', box.h)
  shape.set('head', params.head === true)
  writeStyle(shape, { ...DEFAULT_STROKE_ONLY, ...params.style })
  return insert(doc, params.id, shape)
}

/**
 * Create a freehand stroke and insert it, deriving its box from the simplified points.
 *
 * Takes the caller's already-simplified run. Simplification belongs to the drawing tool,
 * which is the only place that knows the zoom the tolerance was measured against, and
 * re-simplifying here would mean doing it twice and storing different answers.
 */
export function createPenShape(doc: Doc, params: CreatePenParams): ShapeMap {
  const box = boundsOfPoints(params.points)
  const shape: ShapeMap = new YMap()
  shape.set('id', params.id)
  shape.set('type', 'pen')
  shape.set('z', params.z ?? first())
  shape.set('lastDeleted', false)
  shape.set('points', params.points)
  shape.set('x', box.x)
  shape.set('y', box.y)
  shape.set('w', box.w)
  shape.set('h', box.h)
  writeStyle(shape, { ...DEFAULT_STROKE_ONLY, ...params.style })
  return insert(doc, params.id, shape)
}

function insertShape(
  doc: Doc,
  type: ShapeType,
  params: CreateShapeParams,
  style: Style,
  extra: Record<string, unknown> = {},
): ShapeMap {
  const shape: ShapeMap = new YMap()
  shape.set('id', params.id)
  shape.set('type', type)
  shape.set('z', params.z ?? first())
  shape.set('lastDeleted', false)
  shape.set('x', params.rect?.x ?? DEFAULT_RECT.x)
  shape.set('y', params.rect?.y ?? DEFAULT_RECT.y)
  shape.set('w', params.rect?.w ?? DEFAULT_RECT.w)
  shape.set('h', params.rect?.h ?? DEFAULT_RECT.h)
  writeStyle(shape, style)
  for (const [key, value] of Object.entries(extra)) shape.set(key, value)
  return insert(doc, params.id, shape)
}

function writeStyle(shape: ShapeMap, style: Style): void {
  shape.set('fill', style.fill)
  shape.set('stroke', style.stroke)
  shape.set('strokeWidth', style.strokeWidth)
  shape.set('rotation', style.rotation)
}

/** Insert a fully built map. The one place a shape becomes visible to peers. */
function insert(doc: Doc, id: string, shape: ShapeMap): ShapeMap {
  const shapes = shapesMap(doc)
  if (shapes.has(id)) {
    throw new Error(`shape ${id} already exists`)
  }
  doc.transact(() => {
    shapes.set(id, shape)
  })
  return shape
}

/**
 * The axis-aligned bounds of a flat point run.
 *
 * Exported because the drawing tools need the same answer before a shape exists — the pen
 * previews a stroke from its buffer, and the preview needs a box for the overlay. Computing
 * it twice from the same definition is cheaper than two definitions that can disagree.
 *
 * An empty run is a zero box at the origin rather than `NaN` bounds: the callers all have
 * something to draw, and a degenerate box is something they can draw, where `NaN` is not.
 */
export function boundsOfPoints(points: readonly number[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]
    const y = points[i + 1]
    if (x === undefined || y === undefined) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (minX === Number.POSITIVE_INFINITY) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Mark a shape deleted. A write of a tombstone, not a map removal. */
export function deleteShape(doc: Doc, id: string): void {
  const shape = shapesMap(doc).get(id)
  if (!shape) throw new Error(`no shape ${id}`)
  doc.transact(() => {
    shape.set('lastDeleted', true)
  })
}

/**
 * Move a shape by a delta, in whichever fields describe it.
 *
 * A rectangle moves by its `x`/`y`. A line and a pen do not: their box is derived, so
 * writing `x`/`y` on them would translate a number the reader ignores and leave the geometry
 * where it was — a shape that is selected, dragged, and does not move. Their geometry is
 * what has to move, and the derived box is rewritten alongside so the document never holds a
 * box that disagrees with the points it was derived from.
 *
 * One function rather than one per caller, because the two callers are the drag handler and
 * the convergence simulator, and a move that translates a rect but not a line in one of them
 * is a divergence that only appears under the fuzzer. The switch is exhaustive over the
 * shape types with no default, so a type added later is a compile error here rather than a
 * shape that quietly refuses to move.
 *
 * Call inside a transaction the caller owns: this is per-shape, and a move of a five-shape
 * selection is one undo step, not five.
 */
export function translateShape(shape: ShapeMap, dx: number, dy: number): void {
  switch (shape.get('type')) {
    case 'rect':
    case 'ellipse':
    case 'note': {
      shape.set('x', num(shape.get('x'), 0) + dx)
      shape.set('y', num(shape.get('y'), 0) + dy)
      return
    }
    case 'line': {
      const x1 = num(shape.get('x1'), 0) + dx
      const y1 = num(shape.get('y1'), 0) + dy
      const x2 = num(shape.get('x2'), 0) + dx
      const y2 = num(shape.get('y2'), 0) + dy
      shape.set('x1', x1)
      shape.set('y1', y1)
      shape.set('x2', x2)
      shape.set('y2', y2)
      writeBounds(shape, boundsOfPoints([x1, y1, x2, y2]))
      return
    }
    case 'pen': {
      // Through the reader, not a raw `get`. A point list from a peer can be odd-length or
      // hold a non-finite value, and translating it in place would write the same broken
      // list back and recompute the bounds from a coordinate with no partner.
      const { points } = readPen(shape)
      // Built by pushing rather than `new Array(points.length)`: that constructor is typed
      // `any[]`, so pre-sizing it would hand an untyped array to a typed variable. And
      // `points[i]` is `number | undefined` under noUncheckedIndexedAccess even though the
      // reader has already filtered the list, so each coordinate goes through `num`.
      const moved: number[] = []
      for (let i = 0; i + 1 < points.length; i += 2) {
        moved.push(num(points[i], 0) + dx, num(points[i + 1], 0) + dy)
      }
      // A whole new array rather than mutating in place: a Yjs array is a shared structure,
      // and the local value a reader already holds would change under it without a transaction
      // ever being recorded. Replacing it is what makes the move a network event.
      shape.set('points', moved)
      writeBounds(shape, boundsOfPoints(moved))
      return
    }
    default:
      return
  }
}

/** Write a derived box. The three fields, because they are written together. */
function writeBounds(shape: ShapeMap, box: Rect): void {
  shape.set('x', box.x)
  shape.set('y', box.y)
  shape.set('w', box.w)
  shape.set('h', box.h)
}

/** Read a finite number, falling back when absent, non-numeric, NaN, or infinite. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Read a stored map that describes a box.
 *
 * Rect and ellipse store identical fields and share every default, so they share a
 * reader and differ only in the discriminant. `line` and `pen` will not fit this shape,
 * and that is the signal to stop generalising — which is where they went.
 */
function readBoxed(map: ShapeMap, type: 'rect' | 'ellipse'): BoxedShape {
  return readFields(map, type, DEFAULT_STYLE)
}

/**
 * A note is a box plus one string.
 *
 * It gets its own reader rather than a flag on `readBoxed`, because the string is the whole
 * point of the type: folding it in would mean a `hasText` parameter, and the next type to
 * need one field would add a second, and the generalisation would be carrying data no reader
 * wants.
 */
function readNote(map: ShapeMap): NoteShape {
  return { ...readFields(map, 'note', DEFAULT_NOTE), text: str(map.get('text'), '') }
}

function readLine(map: ShapeMap): LineShape {
  return {
    ...readFields(map, 'line', DEFAULT_STROKE_ONLY),
    x1: num(map.get('x1'), 0),
    y1: num(map.get('y1'), 0),
    x2: num(map.get('x2'), 0),
    y2: num(map.get('y2'), 0),
    head: map.get('head') === true,
  }
}

/**
 * Read a stroke's points back out of storage.
 *
 * A value that is not an array of finite numbers reads as an empty stroke rather than as
 * the array it happens to be, for the same reason `readShape` refuses to guess a type: a
 * pen with a corrupt point list still has to be a shape the renderer can draw and the user
 * can select and delete, and an empty stroke is the one reading that cannot throw later.
 */
function readPen(map: ShapeMap): PenShape {
  const raw = map.get('points')
  const finite: number[] = Array.isArray(raw)
    ? raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : []
  // Truncated to whole points. A flat array with an odd length has a coordinate with no
  // partner, and every consumer that walks it in pairs — bounds, hit test, render — would
  // read the unpaired value as an x and pair it with `undefined`. `NaN` in a canvas
  // coordinate is not a missing point, it is a blank board, and one bad update from a peer
  // would take the canvas down rather than losing one point of one stroke.
  const points = finite.length % 2 === 0 ? finite : finite.slice(0, finite.length - 1)
  return { ...readFields(map, 'pen', DEFAULT_STROKE_ONLY), points }
}

/** The shape fields every type has. `fill`/`stroke` defaults are per type, not global. */
function readFields<T extends 'rect' | 'ellipse' | 'line' | 'note' | 'pen'>(
  map: ShapeMap,
  type: T,
  defaults: Style,
): Omit<RectShape, 'type'> & { type: T } {
  return {
    id: str(map.get('id'), ''),
    type,
    z: str(map.get('z'), first()),
    lastDeleted: map.get('lastDeleted') === true,
    x: num(map.get('x'), DEFAULT_RECT.x),
    y: num(map.get('y'), DEFAULT_RECT.y),
    w: num(map.get('w'), DEFAULT_RECT.w),
    h: num(map.get('h'), DEFAULT_RECT.h),
    fill: str(map.get('fill'), defaults.fill),
    stroke: str(map.get('stroke'), defaults.stroke),
    strokeWidth: num(map.get('strokeWidth'), defaults.strokeWidth),
    rotation: num(map.get('rotation'), defaults.rotation),
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
      return readBoxed(map, 'rect')
    case 'ellipse':
      return readBoxed(map, 'ellipse')
    case 'line':
      return readLine(map)
    case 'note':
      return readNote(map)
    case 'pen':
      return readPen(map)
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

/**
 * Axis-aligned bounds in board coordinates, before rotation.
 *
 * The ellipse case returns the same box the rect case does, and that is the point rather
 * than an oversight: everything that frames a shape — culling, the selection box, the
 * eight handles — speaks in boxes, and an ellipse inscribed in one is framed by it.
 *
 * `line` and `pen` are the first types whose bounds are not simply their stored box, and
 * they earn the switch: a segment is framed by the box of its endpoints, and a stroke by
 * the box of its points, so both are read back from the geometry rather than trusted from
 * storage. Recomputing rather than returning `x`/`y`/`w`/`h` is deliberate — a peer running
 * an older build, or a concurrent write that landed the endpoints without the box, would
 * otherwise produce a selection ring in the wrong place. Cheap next to a wrong frame.
 */
export function boundsFor(shape: Shape): Rect {
  switch (shape.type) {
    case 'rect':
    case 'ellipse':
    case 'note':
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
    case 'line':
      return boundsOfPoints([shape.x1, shape.y1, shape.x2, shape.y2])
    case 'pen':
      return boundsOfPoints(shape.points)
  }
}

export interface Point {
  x: number
  y: number
}

/**
 * Distance from a point to a line segment, and the thing a thin shape is really made of.
 *
 * A line has no interior, so "inside it" has to mean "close enough to it", and that is a
 * distance rather than a region. Exported because the store hit-tests from floats and would
 * otherwise carry a second copy of this arithmetic — the store's doc says every value there
 * is derived, and a second definition of a shape's own geometry is a second chance to
 * disagree about what the shape is.
 *
 * The projection is clamped to the segment, so a point beyond either end measures to that
 * end rather than to the infinite line through it. Without the clamp a click on empty
 * canvas past the tip of a line would select it.
 */
export function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * Distance from a point to a flat point run, measured to the nearest segment.
 *
 * Fewer than two points is a point, not a polyline, and a click near it still selects it —
 * a single tap of the pen is a dot the user drew and expects to be able to grab.
 */
export function distanceToPolyline(points: readonly number[], px: number, py: number): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY
  const x0 = points[0] ?? 0
  const y0 = points[1] ?? 0
  if (points.length < 4) return Math.hypot(px - x0, py - y0)
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i + 3 < points.length; i += 2) {
    const d = distanceToSegment(
      px,
      py,
      points[i] ?? 0,
      points[i + 1] ?? 0,
      points[i + 2] ?? 0,
      points[i + 3] ?? 0,
    )
    if (d < best) best = d
  }
  return best
}

/**
 * Default grab radius for a shape with no interior, in world units.
 *
 * A screen-pixel radius has to be converted with the zoom the caller holds and this
 * function does not, so this is a floor: generous enough to be forgiving at the default
 * zoom, and the store scales it by the viewport the same way `hitHandle` does.
 */
export const HIT_TOLERANCE = 4

/**
 * Whether a board-space point is inside the shape.
 *
 * Note what this does *not* do: an ellipse is not its bounding box, and a line is not a box
 * at all. Testing the box for either would make the four corners of every ellipse clickable
 * and every line clickable anywhere along its diagonal, which is the one way to tell a user
 * the shape they clicked is not the shape they meant.
 */
export function hitTest(shape: Shape, point: Point, tolerance = HIT_TOLERANCE): boolean {
  if (shape.type === 'line') {
    return distanceToSegment(point.x, point.y, shape.x1, shape.y1, shape.x2, shape.y2) <= tolerance
  }
  if (shape.type === 'pen') {
    return distanceToPolyline(shape.points, point.x, point.y) <= tolerance
  }

  const b = boundsFor(shape)
  // Normalise the sign so a shape dragged to negative width or height still hit-tests.
  const left = Math.min(b.x, b.x + b.w)
  const right = Math.max(b.x, b.x + b.w)
  const top = Math.min(b.y, b.y + b.h)
  const bottom = Math.max(b.y, b.y + b.h)
  if (point.x < left || point.x > right || point.y < top || point.y > bottom) return false

  if (shape.type === 'ellipse') {
    const rx = (right - left) / 2
    const ry = (bottom - top) / 2
    const cx = left + rx
    const cy = top + ry
    // A degenerate ellipse is a line or a point, not an invisible region, and which one
    // depends on which radius collapsed. Dividing by a zero radius would give NaN for a
    // click exactly on the centre, and NaN <= 1 is false, so that would silently make a
    // zero-width ellipse unselectable and therefore undeletable.
    if (rx === 0 && ry === 0) return point.x === cx && point.y === cy
    if (rx === 0) return point.x === cx
    if (ry === 0) return point.y === cy
    const dx = (point.x - cx) / rx
    const dy = (point.y - cy) / ry
    return dx * dx + dy * dy <= 1
  }

  return true
}
