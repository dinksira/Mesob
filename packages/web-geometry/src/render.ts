/**
 * Canvas drawing.
 *
 * 03 §2 is a list of things that are easy to get wrong and expensive to notice, so each
 * one is written to be visible here: the cull, the cached style, the fill batching, the
 * coordinate flip, and the rule that nothing here allocates per frame.
 *
 * ## The one rule
 *
 * Every per-frame value is either a number already in a typed array, or a value this
 * module recomputes from the viewport. There is no `Point`, no `Rect`, no matrix, and no
 * array of handles. Anything that would need one of those is a shape in the store instead,
 * which is the whole reason the store exists.
 *
 * ## The one thing that is not obvious
 *
 * Styles are set by *comparison*, not unconditionally. `ctx.fillStyle = '#b8463a'` is a
 * string parse inside the browser even when nothing changed, and a board of 5,000 rects
 * pays it 5,000 times. The cached-value comparisons below turn that into once per run, and
 * they reset at the top of every frame so a value left over from the previous frame can
 * never be mistaken for a current one.
 */

import type { ViewportTransform } from '@mesob/schema'
import { visibleBounds } from '@mesob/schema'
import { Field, type ShapeStore } from './shape-store.js'

/**
 * The slice of `CanvasRenderingContext2D` this module uses.
 *
 * Narrower than the real context on purpose: it names exactly the operations the renderer
 * performs, and it lets a test pass a recorder that counts style writes instead of a real
 * canvas. A `CanvasRenderingContext2D` satisfies it, so nothing is lost at the call site.
 */
export interface RenderContext {
  save(): void
  restore(): void
  clearRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  rect(x: number, y: number, w: number, h: number): void
  /**
   * Radii are absolute by contract.
   *
   * `ctx.rect` accepts a negative width and quietly draws the same rect, so a shape
   * dragged to negative extents has worked so far. `ctx.ellipse` throws
   * `IndexSizeError` on a negative radius, so a renderer that passed the stored width
   * straight through would work in tests and throw on the first leftward drag in a
   * browser. Taking the absolute value here keeps the degenerate case out of the call
   * site and matches what `rect` was already doing implicitly.
   */
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    a0: number,
    a1: number,
  ): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  /**
   * The real context's own union, not `string`.
   *
   * A real `CanvasRenderingContext2D` widens these to `string | CanvasGradient |
   * CanvasPattern`, and a property of that type is not assignable to one declared `string`.
   * Narrowing here would mean a cast at every call site of the renderer, which is exactly
   * the sort of thing a cast at a boundary is supposed to avoid. This renderer only ever
   * writes strings; the union is here so a real context satisfies the interface without
   * one being asserted into it.
   */
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
}

export interface BoardStyle {
  background: string
  /** Drawn under the shapes, e.g. a grid or a watermark. */
  pattern?: (ctx: RenderContext, t: ViewportTransform) => void
}

/** Handle size and outline width, in screen pixels, so they do not scale with zoom. */
export const HANDLE_SIZE = 8

/** A full turn. `ctx.ellipse` takes start and end angles, and 2*PI closes the curve. */
const TAU = Math.PI * 2
export const SELECTION_STROKE = 1.5
export const MARQUEE_STROKE = 1

/**
 * Scratch buffer for culled indices, owned by the caller.
 *
 * Sized once and reused. If the board outgrows it the cull truncates rather than
 * allocating, so the worst case is a shape not drawn this frame — visibly wrong for one
 * frame and free, rather than a garbage collection at the moment the board gets busy.
 */
const DEFAULT_SCRATCH = 4096

export class BoardRenderer {
  private scratch = new Int32Array(DEFAULT_SCRATCH)
  private store: ShapeStore
  private fillStyle = ''
  private strokeStyle = ''
  private lineWidth = -1
  /** View rectangle in world coordinates, for the cull. Recomputed per frame. */
  private view = { x: 0, y: 0, w: 0, h: 0 }

  constructor(store: ShapeStore) {
    this.store = store
  }

  /** Swap the store without dropping the scratch buffer or the renderer. */
  setStore(store: ShapeStore): void {
    this.store = store
  }

  private resetStyles(): void {
    // Reset to impossible values so the first shape of a frame always writes its style.
    // Carrying the previous frame's values would skip the write and inherit stale paint.
    this.fillStyle = ''
    this.strokeStyle = ''
    this.lineWidth = -1
  }

  /**
   * Draw every shape in the store.
   *
   * Shapes are drawn in store order, which `refill` has already put into z order, and
   * painter's algorithm does the rest: no depth buffer, no sort at draw time.
   */
  drawBoard(ctx: RenderContext, t: ViewportTransform, style: BoardStyle): void {
    ctx.clearRect(0, 0, t.width, t.height)
    ctx.fillStyle = style.background
    ctx.fillRect(0, 0, t.width, t.height)
    if (style.pattern) {
      ctx.save()
      style.pattern(ctx, t)
      ctx.restore()
    }

    this.resetStyles()
    // `visibleBounds` is the schema's own answer to "where is the view", so the cull and
    // the transform cannot drift apart the way a second copy of the arithmetic would.
    visibleBounds(t, this.view)

    const n = this.store.cull(this.view.x, this.view.y, this.view.w, this.view.h, this.scratch)
    for (let k = 0; k < n; k++) {
      const i = this.scratch[k]
      // `cull` wrote `k` entries, so this is in range; the check keeps the compiler from
      // widening every field read below to `number | undefined`.
      if (i !== undefined) this.drawShape(ctx, t, i)
    }
  }

  private drawShape(ctx: RenderContext, t: ViewportTransform, i: number): void {
    const fill = this.store.fillColorAt(i)
    if (fill !== this.fillStyle) {
      ctx.fillStyle = fill
      this.fillStyle = fill
    }
    const stroke = this.store.strokeColorAt(i)
    if (stroke !== this.strokeStyle) {
      ctx.strokeStyle = stroke
      this.strokeStyle = stroke
    }

    // The shape's own width, scaled to screen, floored at one device pixel. Zooming in on
    // a hairline and letting it vanish is a rendering bug that reads as a rendering bug.
    const width = Math.max(1, this.store.strokeWidth(i) * t.zoom)
    if (width !== this.lineWidth) {
      ctx.lineWidth = width
      this.lineWidth = width
    }

    const w = this.store.w(i) * t.zoom
    const h = this.store.h(i) * t.zoom
    // Rotation is about the centre, so the box is drawn about its centre too.
    const cx = (this.store.x(i) + this.store.w(i) / 2 - t.cameraX) * t.zoom + t.width / 2
    const cy = (this.store.y(i) + this.store.h(i) / 2 - t.cameraY) * t.zoom + t.height / 2
    const rotation = this.store.get(i, Field.Rotation)

    ctx.save()
    ctx.translate(cx, cy)
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180)
    ctx.beginPath()
    // The transform above is already about the centre and the shape's own rotation, so
    // the path is built centred on the origin and unrotated. The only type-specific
    // decision is which primitive spans the box; the fill, stroke, and width above it
    // are already shared, and the selection chrome below draws the same box for both.
    switch (this.store.shapeAt(i)?.type) {
      case 'rect':
        ctx.rect(-w / 2, -h / 2, w, h)
        break
      case 'ellipse':
        ctx.ellipse(0, 0, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, TAU)
        break
    }
    ctx.fill()
    if (this.store.strokeWidth(i) > 0) ctx.stroke()
    ctx.restore()
  }

  /**
   * Draw selection chrome: one rotated box per selected shape, or a combined box for
   * several.
   *
   * On the overlay canvas, which is transparent, because selection is not part of the
   * document and must not be saved with it.
   *
   * `dx`/`dy` are a live drag offset in world units. A drag is not written to the
   * document until the pointer comes up, so the preview has to come from somewhere and
   * this is somewhere.
   */
  drawSelection(
    ctx: RenderContext,
    t: ViewportTransform,
    selected: readonly number[],
    color: string,
    dx = 0,
    dy = 0,
  ): void {
    if (selected.length === 0) return
    ctx.clearRect(0, 0, t.width, t.height)

    ctx.strokeStyle = color
    ctx.lineWidth = SELECTION_STROKE

    for (const i of selected) {
      if (i < 0 || i >= this.store.size) continue
      const w = this.store.w(i) * t.zoom
      const h = this.store.h(i) * t.zoom
      const cx = (this.store.x(i) + dx + this.store.w(i) / 2 - t.cameraX) * t.zoom + t.width / 2
      const cy = (this.store.y(i) + dy + this.store.h(i) / 2 - t.cameraY) * t.zoom + t.height / 2
      const rotation = this.store.get(i, Field.Rotation)

      ctx.save()
      ctx.translate(cx, cy)
      if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180)
      ctx.beginPath()
      ctx.rect(-w / 2, -h / 2, w, h)
      ctx.stroke()
      ctx.restore()
    }
  }

  /**
   * Draw the eight handles of a single selected shape.
   *
   * Only ever called for a one-shape selection. Eight handles on a box around four shapes
   * would move four shapes in ways the user did not ask for, and Phase 1 has no group
   * transform to make that honest.
   */
  drawHandles(
    ctx: RenderContext,
    t: ViewportTransform,
    i: number,
    fill: string,
    dx = 0,
    dy = 0,
  ): void {
    if (i < 0 || i >= this.store.size) return
    const w = this.store.w(i) * t.zoom
    const h = this.store.h(i) * t.zoom
    const cx = (this.store.x(i) + dx + this.store.w(i) / 2 - t.cameraX) * t.zoom + t.width / 2
    const cy = (this.store.y(i) + dy + this.store.h(i) / 2 - t.cameraY) * t.zoom + t.height / 2
    const rotation = this.store.get(i, Field.Rotation)

    ctx.save()
    ctx.translate(cx, cy)
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180)
    ctx.fillStyle = fill
    for (let k = 0; k < 8; k++) {
      const hx = handleOffsetX(k, w)
      const hy = handleOffsetY(k, h)
      ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
    }
    ctx.restore()
  }

  /**
   * Draw the in-progress marquee.
   *
   * In world units, because a marquee is a region of the document rather than a piece of
   * chrome; the transform does the rest.
   */
  drawMarquee(
    ctx: RenderContext,
    t: ViewportTransform,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
  ): void {
    ctx.clearRect(0, 0, t.width, t.height)
    ctx.strokeStyle = color
    ctx.lineWidth = MARQUEE_STROKE
    const minX = x + Math.min(0, w)
    const minY = y + Math.min(0, h)
    const maxX = x + Math.max(0, w)
    const maxY = y + Math.max(0, h)
    ctx.strokeRect(
      (minX - t.cameraX) * t.zoom + t.width / 2,
      (minY - t.cameraY) * t.zoom + t.height / 2,
      (maxX - minX) * t.zoom,
      (maxY - minY) * t.zoom,
    )
  }
}

/**
 * Handle positions as fractions of the shape's own box, centred on it.
 *
 * Order is fixed and clockwise from the north-west corner: the four corners, then the four
 * edge midpoints. Corners first because that is the order a user reads the box in, and
 * the order the tests assert on. A lookup table rather than arithmetic per handle, because
 * "which handle is this" is asked on every pointer move and a switch is not clearer than
 * a table here.
 */
const HANDLE_FRACTIONS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

export function handleOffsetX(k: number, w: number): number {
  return (HANDLE_FRACTIONS[k]?.[0] ?? 0) * (w / 2)
}

export function handleOffsetY(k: number, h: number): number {
  return (HANDLE_FRACTIONS[k]?.[1] ?? 0) * (h / 2)
}

/**
 * The world position of one handle, in the same centre-rotated frame the draw uses.
 *
 * Returns two numbers through a caller-owned pair rather than an object, because this is
 * called from the pointer-move handler and an object per move is a per-frame allocation.
 */
export function handleWorld(
  store: ShapeStore,
  i: number,
  k: number,
  out: { x: number; y: number },
): void {
  const w = store.w(i)
  const h = store.h(i)
  const cx = store.x(i) + w / 2
  const cy = store.y(i) + h / 2
  const lx = handleOffsetX(k, w)
  const ly = handleOffsetY(k, h)
  const rotation = store.get(i, Field.Rotation)
  if (rotation === 0) {
    out.x = cx + lx
    out.y = cy + ly
    return
  }
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  out.x = cx + lx * cos - ly * sin
  out.y = cy + lx * sin + ly * cos
}

/**
 * Which handle, if any, is under a world point. -1 for none.
 *
 * The radius is in *screen* pixels converted to world units, so a handle is the same size
 * to grab at any zoom. Testing in world units at 0.05x would make handles impossible to
 * hit; testing in screen units is the whole reason the hit radius is divided by zoom.
 */
export function hitHandle(
  store: ShapeStore,
  i: number,
  worldX: number,
  worldY: number,
  zoom: number,
  out: { x: number; y: number },
): number {
  const radius = (HANDLE_SIZE / 2 + 2) / zoom
  for (let k = 0; k < 8; k++) {
    handleWorld(store, i, k, out)
    const dx = out.x - worldX
    const dy = out.y - worldY
    if (dx * dx + dy * dy <= radius * radius) return k
  }
  return -1
}

/** Combined world bounds of a selection, for the marquee and the status line. */
export function selectionBounds(
  store: ShapeStore,
  selected: readonly number[],
  out: { x: number; y: number; w: number; h: number },
): boolean {
  if (selected.length === 0) return false
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const i of selected) {
    if (i < 0 || i >= store.size) continue
    if (store.minX(i) < minX) minX = store.minX(i)
    if (store.minY(i) < minY) minY = store.minY(i)
    if (store.maxX(i) > maxX) maxX = store.maxX(i)
    if (store.maxY(i) > maxY) maxY = store.maxY(i)
  }
  if (minX === Infinity) return false
  out.x = minX
  out.y = minY
  out.w = maxX - minX
  out.h = maxY - minY
  return true
}
