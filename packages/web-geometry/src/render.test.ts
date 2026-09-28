import { describe, expect, it } from 'vitest'
import { Doc } from 'yjs'
import { createRectShape, createViewport, toTransform } from '@mesob/schema'
import { ShapeStore } from './shape-store.js'
import {
  BoardRenderer,
  HANDLE_SIZE,
  handleOffsetX,
  handleOffsetY,
  handleWorld,
  hitHandle,
  selectionBounds,
  type RenderContext,
} from './render.js'

/**
 * A recording context.
 *
 * It exists to make the batching claim falsifiable. `fillStyle` on a real canvas is a
 * string parse inside the browser and nothing here can see it, so a test that only
 * asserted "the rect was drawn" would pass whether the renderer set the style once or five
 * thousand times — which is the exact bug 03 §2 warns about. Counting assignments instead
 * makes the claim checkable.
 *
 * `rects` and `fillRects` are kept apart because `fillRect` is both the background wipe
 * and the handle paint. Merged into one list, "the first rect drawn" is the background and
 * every assertion about a shape silently reads the wrong numbers.
 */
class Recorder implements RenderContext {
  fills = 0
  strokes = 0
  clears = 0
  paths = 0
  rotations: number[] = []
  fillStyleWrites = 0
  strokeStyleWrites = 0
  lineWidthWrites = 0
  /** Rects built into the current path. Shapes and selection boxes. */
  rects: [number, number, number, number][] = []
  /** Solid rects. The background wipe and the handles. */
  fillRects: [number, number, number, number][] = []
  backgroundWrites = 0
  private depth = 0
  maxDepth = 0
  private tx = 0
  private ty = 0
  private txStack: number[] = []
  private tyStack: number[] = []
  private _fillStyle = ''
  private _strokeStyle = ''
  private _lineWidth = 1

  get fillStyle(): string {
    return this._fillStyle
  }
  set fillStyle(value: string) {
    this.fillStyleWrites++
    this._fillStyle = value
  }
  get strokeStyle(): string {
    return this._strokeStyle
  }
  set strokeStyle(value: string) {
    this.strokeStyleWrites++
    this._strokeStyle = value
  }
  get lineWidth(): number {
    return this._lineWidth
  }
  set lineWidth(value: number) {
    this.lineWidthWrites++
    this._lineWidth = value
  }

  save(): void {
    this.depth++
    if (this.depth > this.maxDepth) this.maxDepth = this.depth
    this.txStack.push(this.tx)
    this.tyStack.push(this.ty)
  }
  restore(): void {
    this.depth--
    this.tx = this.txStack.pop() ?? 0
    this.ty = this.tyStack.pop() ?? 0
  }
  clearRect(): void {
    this.clears++
  }
  beginPath(): void {
    this.paths++
  }
  rect(x: number, y: number, w: number, h: number): void {
    // The renderer draws a shape by translating to its centre and then recting from the
    // negative half-extent. A recorder that ignored `translate` would report every shape
    // at the origin, and an assertion about where a shape lands on screen would pass for
    // the wrong reason.
    this.rects.push([x + this.tx, y + this.ty, w, h])
  }
  moveTo(): void {
    this.paths++
  }
  lineTo(): void {
    this.paths++
  }
  closePath(): void {
    this.paths++
  }
  fill(): void {
    this.fills++
  }
  stroke(): void {
    this.strokes++
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    // The background wipe is the full canvas, so it is the one that is recognisable.
    if (x === 0 && y === 0 && w === 800 && h === 600 && this.tx === 0 && this.ty === 0) {
      this.backgroundWrites++
      return
    }
    this.fillRects.push([x + this.tx, y + this.ty, w, h])
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    // `strokeRect` is already given absolute screen coordinates by the renderer.
    this.rects.push([x, y, w, h])
  }
  translate(x: number, y: number): void {
    this.tx += x
    this.ty += y
  }
  rotate(angle: number): void {
    this.rotations.push(angle)
  }
}

const size = { width: 800, height: 600 }
const style = { background: '#faf7f2' }
const transform = (options: { cameraX?: number; cameraY?: number; zoom?: number } = {}) =>
  toTransform(createViewport(options), size, 1)

const storeOf = (
  specs: {
    id: string
    rect: { x: number; y: number; w: number; h: number }
    style?: { fill?: string; strokeWidth?: number; rotation?: number }
  }[],
) => {
  const doc = new Doc()
  for (const s of specs) {
    createRectShape(
      doc,
      s.style ? { id: s.id, rect: s.rect, style: s.style } : { id: s.id, rect: s.rect },
    )
  }
  const store = new ShapeStore()
  store.refill(doc)
  return store
}

/** `n` identical rects laid out to all fall inside the default 800x600 view. */
const grid = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${String(i)}`,
    rect: { x: -300 + (i % 25) * 20, y: -250 + Math.floor(i / 25) * 20, w: 10, h: 10 },
  }))

describe('BoardRenderer', () => {
  it('sets fillStyle once for a run of identical shapes', () => {
    // 03 §2: 500 identical rects must set `fillStyle` once for the run, not 500 times.
    // The background counts as one write, hence two.
    const store = storeOf(grid(500))
    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform(), style)

    expect(ctx.fills).toBe(500)
    expect(ctx.fillStyleWrites).toBe(2)
    expect(ctx.lineWidthWrites).toBe(1)
  })

  it('writes the style again when the colour actually changes', () => {
    // The batching must not decay into a cache that never invalidates.
    const doc = new Doc()
    createRectShape(doc, {
      id: 'a',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      style: { fill: '#b8463a' },
    })
    createRectShape(doc, {
      id: 'b',
      rect: { x: 20, y: 0, w: 10, h: 10 },
      style: { fill: '#2a2622' },
    })
    createRectShape(doc, {
      id: 'c',
      rect: { x: 40, y: 0, w: 10, h: 10 },
      style: { fill: '#b8463a' },
    })
    const store = new ShapeStore()
    store.refill(doc)

    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform(), style)
    expect(ctx.fillStyleWrites).toBe(4)
  })

  it('does not carry a style over from the previous frame', () => {
    // If frame two began with frame one's cached fill, the first shape would keep the old
    // colour. Only a second frame can catch this, so the first draw is not the test.
    const store = storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }])
    const ctx = new Recorder()
    const renderer = new BoardRenderer(store)

    renderer.drawBoard(ctx, transform(), style)
    const afterFirst = ctx.fillStyleWrites
    renderer.drawBoard(ctx, transform(), style)
    // Two more per frame: the background wipe and the single shape.
    expect(ctx.fillStyleWrites).toBe(afterFirst + 2)
  })

  it('culls shapes outside the view', () => {
    const store = storeOf([
      { id: 'in', rect: { x: 10, y: 10, w: 10, h: 10 } },
      { id: 'out', rect: { x: 9000, y: 9000, w: 10, h: 10 } },
    ])
    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform(), style)
    expect(ctx.fills).toBe(1)
  })

  it('culls against the view the camera actually has', () => {
    // Panned to 5000,5000: the shapes at the origin are off screen and the one at 5000 is
    // on it. A cull that ignored the camera would get this exactly backwards.
    const store = storeOf([
      { id: 'origin', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'far', rect: { x: 5000, y: 5000, w: 10, h: 10 } },
    ])
    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform({ cameraX: 5000, cameraY: 5000 }), style)

    expect(ctx.fills).toBe(1)
    // The camera sits on world 5000,5000, which is the middle of the canvas, and the
    // shape starts at world 5000,5000 and runs to 5010. So it covers (400,300) to
    // (410,310): its top-left corner is exactly the canvas centre.
    const rect = ctx.rects[0]
    expect(rect?.[0]).toBeCloseTo(400)
    expect(rect?.[1]).toBeCloseTo(300)
    expect(rect?.[2]).toBeCloseTo(10)
  })

  it('scales the shape by zoom and centres it on the camera', () => {
    const store = storeOf([{ id: 'a', rect: { x: 100, y: 100, w: 40, h: 20 } }])
    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform({ zoom: 2 }), style)

    // At zoom 2 the 40x20 rect is 80x40, drawn about its world centre (120,110), which
    // with the camera at the origin lands at screen (640,520).
    const rect = ctx.rects[0]
    expect(rect?.[0]).toBeCloseTo(600)
    expect(rect?.[1]).toBeCloseTo(500)
    expect(rect?.[2]).toBeCloseTo(80)
    expect(rect?.[3]).toBeCloseTo(40)
  })

  it('balances save and restore, so the transform stack cannot leak', () => {
    // An unbalanced save is invisible in a still frame and corrupts every frame after it.
    const store = storeOf(grid(20))
    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform(), style)
    expect(ctx.maxDepth).toBe(1)
  })

  it('never scales the stroke below a device pixel', () => {
    // Zoomed out to 0.05, a 1px stroke would round away to nothing.
    const store = storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }])
    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform({ zoom: 0.05 }), style)
    expect(ctx.lineWidth).toBe(1)
  })

  it('skips the stroke for a shape with no outline', () => {
    const store = storeOf([
      { id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 }, style: { strokeWidth: 0 } },
    ])
    const ctx = new Recorder()
    new BoardRenderer(store).drawBoard(ctx, transform(), style)
    expect(ctx.fills).toBe(1)
    expect(ctx.strokes).toBe(0)
  })
})

describe('handles', () => {
  const w = 100
  const h = 40

  it('places the four corners and four edge midpoints of the box', () => {
    // Clockwise from the top left, corners first: that is the order the tests read.
    expect([handleOffsetX(0, w), handleOffsetY(0, h)]).toEqual([-50, -20])
    expect([handleOffsetX(1, w), handleOffsetY(1, h)]).toEqual([50, -20])
    expect([handleOffsetX(2, w), handleOffsetY(2, h)]).toEqual([50, 20])
    expect([handleOffsetX(3, w), handleOffsetY(3, h)]).toEqual([-50, 20])
    expect([handleOffsetX(4, w), handleOffsetY(4, h)]).toEqual([0, -20])
    expect([handleOffsetX(5, w), handleOffsetY(5, h)]).toEqual([50, 0])
    expect([handleOffsetX(6, w), handleOffsetY(6, h)]).toEqual([0, 20])
    expect([handleOffsetX(7, w), handleOffsetY(7, h)]).toEqual([-50, 0])
  })

  it('puts each handle on the corner or edge it is named for', () => {
    // A handle that floats off the box resizes the wrong edge, and it is invisible until
    // someone drags it. Asserting the eight world positions catches it.
    const store = storeOf([{ id: 'a', rect: { x: 200, y: 100, w, h } }])
    const out = { x: 0, y: 0 }
    const seen: [number, number][] = []
    for (let k = 0; k < 8; k++) {
      handleWorld(store, 0, k, out)
      seen.push([out.x, out.y])
    }
    expect(seen).toEqual([
      [200, 100],
      [300, 100],
      [300, 140],
      [200, 140],
      [250, 100],
      [300, 120],
      [250, 140],
      [200, 120],
    ])
  })

  it('turns the handles with a rotated shape', () => {
    // Turned 90 degrees about its centre, the shape's centre is (250,120) and its
    // half-extents swap, so the north-west corner moves to where the top edge was.
    const store = storeOf([
      { id: 'a', rect: { x: 200, y: 100, w: 100, h: 40 }, style: { rotation: 90 } },
    ])
    const out = { x: 0, y: 0 }
    handleWorld(store, 0, 0, out)
    expect(out.x).toBeCloseTo(250 + 20)
    expect(out.y).toBeCloseTo(120 - 50)

    // And the shape it was sitting on is now tall and thin.
    handleWorld(store, 0, 2, out)
    expect(out.x).toBeCloseTo(250 - 20)
    expect(out.y).toBeCloseTo(120 + 50)
  })

  it('finds the handle under the pointer and misses between them', () => {
    const store = storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 100, h: 40 } }])
    const out = { x: 0, y: 0 }
    expect(hitHandle(store, 0, 0, 0, 1, out)).toBe(0)
    expect(hitHandle(store, 0, 100, 40, 1, out)).toBe(2)
    expect(hitHandle(store, 0, 50, 0, 1, out)).toBe(4)
    // The middle of the shape is not a handle.
    expect(hitHandle(store, 0, 50, 20, 1, out)).toBe(-1)
  })

  it('keeps a handle grabbable at any zoom', () => {
    // A handle is HANDLE_SIZE screen pixels at every zoom, so its world radius grows as
    // the camera pulls back. Measured in world units at 0.05x, it would be unclickable.
    const store = storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 100, h: 40 } }])
    const out = { x: 0, y: 0 }
    const nudge = 1 / 0.05
    expect(hitHandle(store, 0, 0 + nudge, 0, 0.05, out)).toBe(0)
    // At zoom 1 the radius is 6 world units, and 20 is comfortably past it.
    expect(hitHandle(store, 0, 20, 0, 1, out)).toBe(-1)
  })
})

describe('selectionBounds', () => {
  it('covers every selected shape, using rotated bounds', () => {
    const store = storeOf([
      { id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'b', rect: { x: 50, y: 50, w: 100, h: 10 }, style: { rotation: 90 } },
    ])
    const out = { x: 0, y: 0, w: 0, h: 0 }
    expect(selectionBounds(store, [0, 1], out)).toBe(true)
    // The bar's centre is (100,55) and its rotated half-extents are 5 and 50, so the
    // combined box has to reach x=105 and y=105.
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
    expect(out.w).toBeGreaterThanOrEqual(105)
    expect(out.h).toBeGreaterThanOrEqual(105)
  })

  it('reports nothing for an empty selection or a stale index', () => {
    const store = storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }])
    const out = { x: 0, y: 0, w: 0, h: 0 }
    expect(selectionBounds(store, [], out)).toBe(false)
    expect(selectionBounds(store, [99], out)).toBe(false)
  })
})

describe('overlay', () => {
  it('draws nothing for an empty selection', () => {
    const ctx = new Recorder()
    new BoardRenderer(storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }])).drawSelection(
      ctx,
      transform(),
      [],
      '#5b3a52',
    )
    expect(ctx.strokes).toBe(0)
  })

  it('skips a stale index rather than drawing nonsense', () => {
    // A selection can outlive the shape it names for one frame, when a delete lands.
    const ctx = new Recorder()
    new BoardRenderer(storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }])).drawSelection(
      ctx,
      transform(),
      [0, 42],
      '#5b3a52',
    )
    expect(ctx.strokes).toBe(1)
  })

  it('draws eight handle squares for a single selection', () => {
    const ctx = new Recorder()
    new BoardRenderer(storeOf([{ id: 'a', rect: { x: 0, y: 0, w: 100, h: 40 } }])).drawHandles(
      ctx,
      transform(),
      0,
      '#faf7f2',
    )
    expect(ctx.fillRects.length).toBe(8)
    for (const rect of ctx.fillRects) {
      expect(rect[2]).toBe(HANDLE_SIZE)
      expect(rect[3]).toBe(HANDLE_SIZE)
    }
  })

  it('normalises a marquee dragged up and to the left', () => {
    // A negative extent has to come out as a positive box, or the marquee is drawn up and
    // to the left of where the user actually dragged.
    const ctx = new Recorder()
    new BoardRenderer(storeOf([])).drawMarquee(ctx, transform(), 100, 100, -50, -30, '#5b3a52')

    const rect = ctx.rects[0]
    expect(rect?.[0]).toBeCloseTo((50 - 0) * 1 + 400)
    expect(rect?.[1]).toBeCloseTo((70 - 0) * 1 + 300)
    expect(rect?.[2]).toBeCloseTo(50)
    expect(rect?.[3]).toBeCloseTo(30)
  })
})
