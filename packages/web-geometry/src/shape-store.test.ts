import { describe, expect, it } from 'vitest'
import { Doc } from 'yjs'
import { createRectShape, deleteShape, shapesMap } from '@mesob/schema'
import { Field, STRIDE, ShapeStore, colorAt, containsPoint, internColor } from './shape-store.js'

const filled = (id: string, rect: { x: number; y: number; w: number; h: number }) => ({
  id,
  rect,
})

/** A store over a document built from `specs`, already refilled. */
const build = (specs: { id: string; rect: { x: number; y: number; w: number; h: number } }[]) => {
  const doc = new Doc()
  for (const s of specs) createRectShape(doc, filled(s.id, s.rect))
  const store = new ShapeStore()
  store.refill(doc)
  return { doc, store }
}

describe('containsPoint', () => {
  it('is inclusive of the edge, so a 1px rect is still clickable', () => {
    // Off by one here and a 1px shape becomes impossible to select.
    expect(containsPoint(10, 20, 100, 50, 10, 20, 0)).toBe(true)
    expect(containsPoint(10, 20, 100, 50, 110, 70, 0)).toBe(true)
    expect(containsPoint(10, 20, 100, 50, 9.9, 20, 0)).toBe(false)
  })

  it('handles a negative extent, which the schema permits', () => {
    // `num()` accepts any finite w/h, so a rect dragged up and to the left is stored with
    // both negative. It is still where it looks, so the test has to be too.
    expect(containsPoint(100, 100, -100, -50, 50, 80, 0)).toBe(true)
    expect(containsPoint(100, 100, -100, -50, 150, 80, 0)).toBe(false)
  })

  it('rotates about the shape centre, not its corner', () => {
    // 100x10 at the origin: centre (50,5), long axis running along x.
    // At 0 degrees the right end is inside; at 90 degrees that same point is above the
    // box, because the shape has turned through where the long axis used to be.
    expect(containsPoint(0, 0, 100, 10, 75, 5, 0)).toBe(true)
    expect(containsPoint(0, 0, 100, 10, 75, 5, 90)).toBe(false)
  })

  it('finds the point the rotation actually moves to', () => {
    // Local (75,5) sits 25 right of centre, on the long axis. Turned 90 degrees
    // counter-clockwise, "25 right" points down the screen, so it lands at (50,30).
    expect(containsPoint(0, 0, 100, 10, 50, 30, 90)).toBe(true)
    // The far end of the long axis swings up off the top.
    expect(containsPoint(0, 0, 100, 10, 50, -20, 90)).toBe(true)
  })

  it('keeps the short axis short when it is the one pointing sideways', () => {
    // The shape is now 100 tall and 10 wide, so a point either side of the centre is
    // outside, and one just inside the old top edge is in.
    expect(containsPoint(0, 0, 100, 10, 47, 5, 90)).toBe(true)
    expect(containsPoint(0, 0, 100, 10, 43, 5, 90)).toBe(false)
  })
})

describe('colour interning', () => {
  it('gives the same index to the same colour, so style runs are detectable', () => {
    expect(internColor('#b8463a')).toBe(internColor('#b8463a'))
    expect(internColor('#b8463a')).not.toBe(internColor('#2a2622'))
  })

  it('resolves an index back to its colour', () => {
    expect(colorAt(internColor('#123456'))).toBe('#123456')
  })

  it('returns something drawable for an index it has never seen', () => {
    // A stale index from a cleared store must not paint `undefined`.
    expect(colorAt(9999)).toBe('transparent')
  })
})

describe('ShapeStore', () => {
  it('projects the document into dense geometry', () => {
    const { store } = build([filled('a', { x: 1, y: 2, w: 3, h: 4 })])
    expect(store.size).toBe(1)
    expect(store.x(0)).toBe(1)
    expect(store.y(0)).toBe(2)
    expect(store.w(0)).toBe(3)
    expect(store.h(0)).toBe(4)
    expect(store.idAt(0)).toBe('a')
    expect(store.indexOf('a')).toBe(0)
    expect(store.indexOf('missing')).toBe(-1)
  })

  it('drops tombstones and compacts, so the draw loop sees no holes', () => {
    const { doc, store } = build([
      filled('a', { x: 0, y: 0, w: 1, h: 1 }),
      filled('b', { x: 5, y: 5, w: 1, h: 1 }),
      filled('c', { x: 9, y: 9, w: 1, h: 1 }),
    ])
    deleteShape(doc, 'b')
    store.refill(doc)

    expect(store.size).toBe(2)
    expect(store.indexOf('b')).toBe(-1)
    expect(store.idAt(0)).toBe('a')
    expect(store.idAt(1)).toBe('c')
  })

  it('grows past its initial capacity without losing shapes', () => {
    // Doubling is easy to get wrong at the boundary, so the spec goes well past several
    // growth steps rather than just one.
    const { store } = build(
      Array.from({ length: 200 }, (_, i) => filled(`s${String(i)}`, { x: i, y: i, w: 1, h: 1 })),
    )
    expect(store.size).toBe(200)
    expect(store.idAt(199)).toBe('s199')
    expect(store.x(199)).toBe(199)
  })

  it('keeps the index map consistent with the dense arrays after growth', () => {
    // An id -> index map that disagrees with the arrays is silent data corruption: the
    // shape draws in one place and drags in another.
    const { store } = build(
      Array.from({ length: 40 }, (_, i) => filled(`s${String(i)}`, { x: i, y: 0, w: 1, h: 1 })),
    )
    for (let i = 0; i < 40; i++) {
      expect(store.idAt(store.indexOf(`s${String(i)}`))).toBe(`s${String(i)}`)
      expect(store.x(store.indexOf(`s${String(i)}`))).toBe(i)
    }
  })

  it('re-reading an unchanged document changes nothing', () => {
    const { doc, store } = build([filled('a', { x: 1, y: 1, w: 1, h: 1 })])
    const before = store.get(0, Field.X)
    store.refill(doc)
    expect(store.get(0, Field.X)).toBe(before)
    expect(store.size).toBe(1)
  })

  it('trims ids it no longer needs, so a shrunken board releases its strings', () => {
    const doc = new Doc()
    for (let i = 0; i < 10; i++)
      createRectShape(doc, filled(`s${String(i)}`, { x: i, y: 0, w: 1, h: 1 }))
    const store = new ShapeStore()
    store.refill(doc)
    for (let i = 0; i < 9; i++) deleteShape(doc, `s${String(i)}`)
    store.refill(doc)

    expect(store.size).toBe(1)
    expect(store.idAt(0)).toBe('s9')
    expect(store.indexOf('s0')).toBe(-1)
  })

  it('notifies subscribers on refill and stops after unsubscribe', () => {
    const { doc, store } = build([filled('a', { x: 0, y: 0, w: 1, h: 1 })])
    let calls = 0
    const off = store.observe(() => {
      calls++
    })
    store.refill(doc)
    expect(calls).toBe(1)
    off()
    store.refill(doc)
    expect(calls).toBe(1)
  })

  it('ignores a value in the shapes collection that is not a map', () => {
    // Junk in the document must not take out the draw loop with it, and `readShape`
    // promises null rather than a throw for exactly this.
    const doc = new Doc()
    createRectShape(doc, filled('a', { x: 0, y: 0, w: 1, h: 1 }))
    // The point of the test is a value that is not a map at all, so the cast is the
    // subject matter rather than a way around the checker.
    shapesMap(doc).set('junk', { not: 'a map' } as never)
    const store = new ShapeStore()
    store.refill(doc)
    expect(store.size).toBe(1)
    expect(store.idAt(0)).toBe('a')
  })
})

describe('rotated bounds', () => {
  it('caches the bounds of the rotated shape, not of its unrotated box', () => {
    // A 100x10 bar turned 90 degrees occupies a box 10 wide by 100 tall. Culling on the
    // stored w/h would drop it from a view it is plainly inside of.
    const doc = new Doc()
    createRectShape(doc, {
      id: 'bar',
      rect: { x: 0, y: 0, w: 100, h: 10 },
      style: { rotation: 90 },
    })
    const store = new ShapeStore()
    store.refill(doc)

    expect(store.minX(0)).toBeCloseTo(45)
    expect(store.maxX(0)).toBeCloseTo(55)
    expect(store.minY(0)).toBeCloseTo(-45)
    expect(store.maxY(0)).toBeCloseTo(55)
  })

  it('leaves the bounds alone for an unrotated shape', () => {
    const { store } = build([filled('a', { x: 10, y: 20, w: 30, h: 40 })])
    expect(store.minX(0)).toBe(10)
    expect(store.minY(0)).toBe(20)
    expect(store.maxX(0)).toBe(40)
    expect(store.maxY(0)).toBe(60)
  })

  it('normalises negative extents in the cached bounds', () => {
    const { store } = build([filled('a', { x: 100, y: 100, w: -40, h: -20 })])
    expect(store.minX(0)).toBe(60)
    expect(store.minY(0)).toBe(80)
    expect(store.maxX(0)).toBe(100)
    expect(store.maxY(0)).toBe(100)
  })

  it('keeps a rotated shape that only its rotated bounds overlap', () => {
    // The bar's stored box is y in [0,10], but turned 90 degrees it reaches down to y=55.
    // Culling on the stored numbers would lose it here.
    const doc = new Doc()
    createRectShape(doc, {
      id: 'bar',
      rect: { x: 0, y: 0, w: 100, h: 10 },
      style: { rotation: 90 },
    })
    const store = new ShapeStore()
    store.refill(doc)

    const out = new Int32Array(4)
    expect(store.cull(0, 30, 200, 20, out)).toBe(1)
    // Below its rotated bounds there is nothing, even though the stored box is nowhere
    // near this view either.
    expect(store.cull(0, 60, 200, 10, out)).toBe(0)
  })
})

describe('cull', () => {
  it('keeps only shapes overlapping the view, writing into the caller buffer', () => {
    const { store } = build([
      filled('near', { x: 10, y: 10, w: 10, h: 10 }),
      filled('far', { x: 5000, y: 5000, w: 10, h: 10 }),
    ])
    const out = new Int32Array(16)
    expect(store.cull(0, 0, 100, 100, out)).toBe(1)
    expect(store.idAt(out[0] ?? -1)).toBe('near')
  })

  it('reuses the same buffer without clearing it, which is the no-allocation contract', () => {
    const { store } = build(
      Array.from({ length: 5 }, (_, i) => filled(`s${String(i)}`, { x: i, y: 0, w: 1, h: 1 })),
    )
    const out = new Int32Array(5)
    const first = store.cull(-1, -1, 100, 100, out)
    const second = store.cull(-1, -1, 100, 100, out)
    expect(first).toBe(5)
    expect(second).toBe(first)
  })

  it('stops at the buffer size rather than overflowing it', () => {
    const { store } = build(
      Array.from({ length: 20 }, (_, i) => filled(`s${String(i)}`, { x: i, y: 0, w: 1, h: 1 })),
    )
    expect(store.cull(-1, -1, 100, 100, new Int32Array(3))).toBe(3)
  })
})

describe('hit testing', () => {
  it('returns the topmost shape, not the first', () => {
    // Two overlapping rects. Whichever ends up on top must win, or a shape can be
    // impossible to select once something is drawn over it.
    const { store } = build([
      filled('under', { x: 0, y: 0, w: 100, h: 100 }),
      filled('over', { x: 50, y: 50, w: 100, h: 100 }),
    ])
    const i = store.hitTest(75, 75)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(store.idAt(i)).toBe('over')
  })

  it('hits a rotated shape where it was drawn', () => {
    const doc = new Doc()
    createRectShape(doc, {
      id: 'bar',
      rect: { x: 0, y: 0, w: 100, h: 10 },
      style: { rotation: 90 },
    })
    const store = new ShapeStore()
    store.refill(doc)

    // Inside the rotated bar's tall body, well clear of the unrotated box.
    expect(store.hitTest(50, 30)).toBe(0)
    // The corner the unrotated box would have claimed is now empty space.
    expect(store.hitTest(75, 2)).toBe(-1)
  })

  it('misses cleanly and reports -1', () => {
    const { store } = build([filled('a', { x: 0, y: 0, w: 10, h: 10 })])
    expect(store.hitTest(1000, 1000)).toBe(-1)
  })

  it('collects a marquee selection topmost first', () => {
    const { store } = build([
      filled('a', { x: 0, y: 0, w: 10, h: 10 }),
      filled('b', { x: 5, y: 5, w: 10, h: 10 }),
    ])
    const out: number[] = []
    expect(store.hitTestRect(0, 0, 100, 100, out)).toBe(2)
    expect(store.idAt(out[0] ?? -1)).toBe('b')
  })

  it('selects nothing for an empty marquee', () => {
    const { store } = build([filled('a', { x: 0, y: 0, w: 10, h: 10 })])
    const out: number[] = []
    expect(store.hitTestRect(1000, 1000, 10, 10, out)).toBe(0)
    expect(out).toEqual([])
  })
})

describe('layout invariants', () => {
  it('keeps every rect field in one row, so the next shape type needs no refactor', () => {
    const { store } = build([filled('a', { x: 1, y: 2, w: 3, h: 4 })])
    expect(STRIDE).toBe(12)
    expect(store.get(0, Field.X)).toBe(1)
    expect(store.get(0, Field.H)).toBe(4)
  })

  it('keeps the style fields that the draw loop needs in the row', () => {
    // These are the fields the run-length fill batching compares between shapes. A new
    // shape type that drops one of them belongs behind a `get`, not a shorter stride.
    expect([
      Field.X,
      Field.Y,
      Field.W,
      Field.H,
      Field.Rotation,
      Field.FillIndex,
      Field.StrokeIndex,
      Field.StrokeWidth,
      Field.MinX,
      Field.MinY,
      Field.MaxX,
      Field.MaxY,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})
