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

import type { LineShape, NoteShape, PenShape, ViewportTransform } from '@mesob/schema'
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

  /* Text, for notes. The one place this renderer is allowed to be expensive: shaping a
   * line of text and measuring the next one is a browser call, and there is no way to draw
   * a note's text without it. Notes are few and short, so the cost lands where a user is
   * typing rather than across 5,000 shapes. Everything above stays allocation-free. */
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
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
  font: string
  textAlign: string
  textBaseline: string
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

/** Arrowhead length, as a fraction of zoom so it grows with the shape it labels. */
const ARROW_HEAD_SIZE = 12
/** Half-angle of each arm, in radians. A little under 30° is a filled-looking V. */
const ARROW_HEAD_SPREAD = (25 * Math.PI) / 180

/** Note text metrics, in world units at zoom 1. */
const NOTE_FONT_SIZE = 14
const NOTE_PADDING = 8
const NOTE_LINE_HEIGHT = 1.4
const NOTE_TEXT_COLOR = '#2a2622'

/**
 * The font stack for note text.
 *
 * The Ethiopic families are the whole point of listing them rather than naming one generic
 * sans. G1's acceptance criterion is that Amharic renders without tofu, and a browser given
 * only `system-ui` will happily fall back to a face with no Ethiopic coverage and draw a row
 * of boxes — on a machine that passes every automated check, because the text is not
 * measured, only present. `Nyala` is the family Windows ships, `Noto Sans Ethiopic` is the
 * cross-platform one, and the generic `sans-serif` at the end is the last resort rather than
 * the first.
 */
const NOTE_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", "Noto Sans Ethiopic", "Nyala", "Abyssinica SIL", sans-serif'

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
    const shape = this.store.shapeAt(i)
    // A dense index with no shape behind it cannot be drawn. Returning rather than falling
    // through keeps the switch below free of a default branch, which is what makes adding a
    // shape type a compile error here instead of a shape that silently stops rendering.
    if (!shape) return

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
    // are already shared, and the selection chrome below draws the same box for all.
    switch (shape.type) {
      case 'rect':
      case 'note':
        ctx.rect(-w / 2, -h / 2, w, h)
        break
      case 'ellipse':
        ctx.ellipse(0, 0, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, TAU)
        break
      case 'line':
        this.linePath(
          ctx,
          shape,
          this.store.x(i) + this.store.w(i) / 2,
          this.store.y(i) + this.store.h(i) / 2,
          t.zoom,
        )
        break
      case 'pen':
        this.strokePath(
          ctx,
          shape,
          this.store.x(i) + this.store.w(i) / 2,
          this.store.y(i) + this.store.h(i) / 2,
          t.zoom,
        )
        break
    }

    // Only the types with an interior are filled. A line and a stroke are open paths, and
    // filling one either paints nothing or paints the region the implicit closing edge
    // happens to enclose — for a freehand loop, a shape the user never drew. The default
    // style for both is already `transparent`, so this is belt and braces against a peer
    // that set a fill on a stroke.
    if (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'note') ctx.fill()
    if (this.store.strokeWidth(i) > 0) ctx.stroke()

    if (shape.type === 'line' && shape.head) {
      this.arrowHead(
        ctx,
        shape,
        this.store.x(i) + this.store.w(i) / 2,
        this.store.y(i) + this.store.h(i) / 2,
        t.zoom,
      )
    }
    if (shape.type === 'note') this.noteText(ctx, t, shape, w, h)
    ctx.restore()
  }

  /**
   * A segment, positioned by its endpoints rather than by its box.
   *
   * The box of a line is the box of its endpoints, so the two describe the same segment and
   * the box diagonal would do. Reading the endpoints anyway is one subtraction each and means
   * the drawn line cannot disagree with the stored geometry if the two ever drift — which
   * is the same reason the box is recomputed in `boundsFor` rather than trusted.
   *
   * The offsets are in *world* units and are multiplied by the zoom here, because the
   * context is already translated to the shape's centre in screen space. Subtracting a
   * screen coordinate from a world one — which is what this did at first — yields a path
   * that moves with the camera and is off-screen by half the viewport at the world origin:
   * every line drew from the centre of the screen to somewhere over on the left.
   */
  private linePath(
    ctx: RenderContext,
    shape: LineShape,
    worldCx: number,
    worldCy: number,
    zoom: number,
  ): void {
    ctx.moveTo((shape.x1 - worldCx) * zoom, (shape.y1 - worldCy) * zoom)
    ctx.lineTo((shape.x2 - worldCx) * zoom, (shape.y2 - worldCy) * zoom)
  }

  /** A freehand run, as a polyline. One point is a dot, which a single tap of the pen is. */
  private strokePath(
    ctx: RenderContext,
    shape: PenShape,
    worldCx: number,
    worldCy: number,
    zoom: number,
  ): void {
    const points = shape.points
    if (points.length < 2) return
    ctx.moveTo(((points[0] ?? 0) - worldCx) * zoom, ((points[1] ?? 0) - worldCy) * zoom)
    for (let i = 2; i + 1 < points.length; i += 2) {
      ctx.lineTo(((points[i] ?? 0) - worldCx) * zoom, ((points[i + 1] ?? 0) - worldCy) * zoom)
    }
  }

  /**
   * The arrowhead, which is the only difference between a line and an arrow.
   *
   * Two arms at a fixed spread from the direction of travel, drawn as their own sub-path so
   * the shaft's round join does not bulge at the tip. Scaled by zoom like everything else,
   * so a head at 8x is visibly bigger rather than the same 12 pixels as at 1x.
   *
   * Built in the same local space as the shaft, from the same world centre: the tip is the
   * far endpoint in local coordinates, not the endpoint in world coordinates, or the head
   * lands at a screen position that has nothing to do with the line it belongs to.
   */
  private arrowHead(
    ctx: RenderContext,
    shape: LineShape,
    worldCx: number,
    worldCy: number,
    zoom: number,
  ): void {
    const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1)
    const size = ARROW_HEAD_SIZE * zoom
    const spread = ARROW_HEAD_SPREAD
    const tipX = (shape.x2 - worldCx) * zoom
    const tipY = (shape.y2 - worldCy) * zoom
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(tipX - size * Math.cos(angle - spread), tipY - size * Math.sin(angle - spread))
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(tipX - size * Math.cos(angle + spread), tipY - size * Math.sin(angle + spread))
    ctx.stroke()
  }

  /**
   * A note's text, wrapped to the note's box.
   *
   * Greedy on spaces, and a hard newline ends a line rather than becoming a space — which
   * is the difference between a note that reads the way it was typed and one where every
   * paragraph runs together.
   *
   * `textBaseline` is `top` and the first line starts one padding below the note's own top
   * edge, which is exactly where the DOM `<textarea>` over this note puts its first line for
   * the same padding and line height. That agreement is the reason those two constants exist
   * in both files: a canvas caret and a DOM caret that disagree by a line height is an editor
   * the user cannot read what they are typing over.
   *
   * `fillStyle` is reassigned *and* the cached value updated, because the next shape's
   * style batching compares against that cache. Setting the context without updating the
   * cache would make every following shape re-set its fill, which is correct-looking and
   * throws away exactly the optimisation this file exists for.
   */
  private noteText(
    ctx: RenderContext,
    t: ViewportTransform,
    shape: NoteShape,
    w: number,
    h: number,
  ): void {
    if (shape.text === '') return

    const fontSize = Math.max(4, NOTE_FONT_SIZE * t.zoom)
    const padding = NOTE_PADDING * t.zoom
    const lineHeight = fontSize * NOTE_LINE_HEIGHT
    const maxWidth = w - padding * 2
    if (maxWidth <= 0) return

    ctx.font = `${String(fontSize)}px ${NOTE_FONT_FAMILY}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const text = NOTE_TEXT_COLOR
    if (text !== this.fillStyle) {
      ctx.fillStyle = text
      this.fillStyle = text
    }

    const left = -w / 2 + padding
    // The clip is checked before every draw rather than after the paragraph, because the
    // last line of a paragraph is drawn after the loop and a check that only ran at the end
    // of the paragraph would let that one line land outside the note.
    const floor = h / 2 - padding
    let y = -h / 2 + padding

    const emit = (line: string): boolean => {
      if (y > floor) return false
      ctx.fillText(line, left, y)
      y += lineHeight
      return true
    }

    for (const paragraph of shape.text.split('\n')) {
      let line = ''
      for (const word of paragraph.split(' ')) {
        const candidate = line === '' ? word : `${line} ${word}`
        if (line !== '' && ctx.measureText(candidate).width > maxWidth) {
          if (!emit(line)) return
          line = word
        } else {
          line = candidate
        }
      }
      if (!emit(line)) return
    }
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

  /**
   * A line in progress, in world coordinates.
   *
   * Separate from `drawShape` because this has no shape: the line being dragged does not
   * exist in the document until the pointer comes up, and the overlay is where a thing that
   * does not exist yet belongs. It is also the one draw that cannot use the store, which is
   * why it takes endpoints directly.
   */
  drawSegment(
    ctx: RenderContext,
    t: ViewportTransform,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
  ): void {
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo((x1 - t.cameraX) * t.zoom + t.width / 2, (y1 - t.cameraY) * t.zoom + t.height / 2)
    ctx.lineTo((x2 - t.cameraX) * t.zoom + t.width / 2, (y2 - t.cameraY) * t.zoom + t.height / 2)
    ctx.stroke()
  }

  /**
   * A freehand stroke in progress, from the caller's own buffer.
   *
   * Takes the buffer rather than a `number[]` because the caller holds a `Float32Array` that
   * it reuses for every stroke and must not hand to a draw call that would allocate. Counted
   * in points, so the buffer's spare capacity is not drawn.
   *
   * A single point draws nothing: `moveTo` with no `lineTo` followed by `stroke` is a
   * zero-length subpath, which the canvas spec says a line cap may render as a dot and
   * nothing promises it will. A real pen commits a tap as a dot by duplicating its one
   * point, so the dot appears on pointer-up rather than flickering in and out during the
   * tap.
   */
  drawStroke(
    ctx: RenderContext,
    t: ViewportTransform,
    points: ArrayLike<number>,
    count: number,
    color: string,
  ): void {
    if (count < 2) return
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    const halfW = t.width / 2
    const halfH = t.height / 2
    ctx.moveTo(
      ((points[0] ?? 0) - t.cameraX) * t.zoom + halfW,
      ((points[1] ?? 0) - t.cameraY) * t.zoom + halfH,
    )
    for (let i = 1; i < count; i++) {
      ctx.lineTo(
        ((points[i * 2] ?? 0) - t.cameraX) * t.zoom + halfW,
        ((points[i * 2 + 1] ?? 0) - t.cameraY) * t.zoom + halfH,
      )
    }
    ctx.stroke()
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
