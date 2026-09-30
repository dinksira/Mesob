import { describe, expect, it } from 'vitest'
import { Map as YMap, Doc } from 'yjs'
import { after, between, first } from './fractional-index.js'
import {
  SHAPE_TYPES,
  boundsFor,
  createEllipseShape,
  createLineShape,
  createNoteShape,
  createPenShape,
  createRectShape,
  deleteShape,
  hitTest,
  isBoxedShape,
  readBoard,
  readShape,
  shapesMap,
  translateShape,
} from './shapes.js'
import type { EllipseShape, LineShape, NoteShape, PenShape, Shape, ShapeType } from './shapes.js'

const doc = () => new Doc()

/**
 * A shape map holding exactly `fields`, attached to a document.
 *
 * Attachment is not incidental. A `Y.Map` that has never been added to a document cannot
 * be read: `set` is silently discarded, `get` returns `undefined`, and Yjs logs
 * "Invalid access: Add Yjs type to a document before reading data." Fields set before
 * attachment do land, and become readable once the map is inserted. So this fills the map
 * and then inserts it, which is also the only way a real partial shape comes into being.
 */
function attachedShape(
  fields: Record<string, unknown>,
  id = 'shp_partial',
  d: Doc = doc(),
): YMap<unknown> {
  const map = new YMap()
  for (const [key, value] of Object.entries(fields)) map.set(key, value)
  shapesMap(d).set(id, map)
  return map
}

describe('createRectShape', () => {
  it('writes every field the reader depends on', () => {
    const d = doc()
    const map = createRectShape(d, {
      id: 'shp_a',
      z: first(),
      rect: { x: 1, y: 2, w: 3, h: 4 },
      style: { fill: '#111111', stroke: '#222222', strokeWidth: 5, rotation: 45 },
    })

    const shape = readShape(map)
    expect(shape).toEqual({
      id: 'shp_a',
      type: 'rect',
      z: first(),
      lastDeleted: false,
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      fill: '#111111',
      stroke: '#222222',
      strokeWidth: 5,
      rotation: 45,
    })
  })

  it('defaults every optional field', () => {
    const shape = readShape(createRectShape(doc(), { id: 'shp_a' }))
    expect(shape).not.toBeNull()
    expect(shape).toMatchObject({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      rotation: 0,
      strokeWidth: 1,
      lastDeleted: false,
    })
    expect(shape!.z).toBe(first())
  })

  it('refuses to create a duplicate id', () => {
    const d = doc()
    createRectShape(d, { id: 'shp_a' })
    expect(() => createRectShape(d, { id: 'shp_a' })).toThrow(/already exists/)
  })

  it('lands in the parent map', () => {
    const d = doc()
    createRectShape(d, { id: 'shp_a' })
    expect(shapesMap(d).get('shp_a')).toBeDefined()
  })
})

describe('readShape', () => {
  it('returns null for a map with no type', () => {
    expect(readShape(attachedShape({ id: 'shp_a' }))).toBeNull()
  })

  it('returns null for an unrecognised type', () => {
    expect(readShape(attachedShape({ id: 'shp_a', type: 'hologram' }))).toBeNull()
  })

  it('returns null rather than throwing for a map not yet in a document', () => {
    // Yjs reports an unattached map by returning undefined for every field, which the
    // type dispatch reads as "no type". Pinned so the totality promise covers this too.
    expect(readShape(new YMap())).toBeNull()
  })

  it('does not throw on a partially populated map', () => {
    // The state a remote peer can legally observe mid-create. A throw here is a
    // render-loop crash on a concurrent creation, so totality is the requirement.
    const map = attachedShape({ type: 'rect', id: 'shp_a' })
    expect(() => readShape(map)).not.toThrow()
    expect(readShape(map)).toMatchObject({ id: 'shp_a', x: 0, fill: '#ffffff' })
  })

  it('falls back for every property corrupted to a non-number', () => {
    const map = attachedShape({ type: 'rect', id: 'shp_a' })
    for (const key of ['x', 'y', 'w', 'h', 'strokeWidth', 'rotation']) map.set(key, 'nope')
    const shape = readShape(map)
    expect(shape).toMatchObject({ x: 0, y: 0, w: 0, h: 0, strokeWidth: 1, rotation: 0 })
  })

  it('rejects NaN and Infinity, which would poison every later render', () => {
    const d = doc()
    const map = createRectShape(d, { id: 'shp_a' })
    map.set('x', Number.NaN)
    map.set('w', Number.POSITIVE_INFINITY)
    expect(readShape(map)).toMatchObject({ x: 0, w: 0 })
  })

  it('treats a non-boolean lastDeleted as not deleted', () => {
    const map = attachedShape({ type: 'rect', id: 'shp_a', lastDeleted: 'yes' })
    expect(readShape(map)!.lastDeleted).toBe(false)
  })
})

describe('deleteShape', () => {
  it('writes a tombstone rather than removing the map', () => {
    const d = doc()
    createRectShape(d, { id: 'shp_a' })
    deleteShape(d, 'shp_a')
    // The entry must survive, or a concurrent edit could resurrect the shape.
    expect(shapesMap(d).get('shp_a')).toBeDefined()
    expect(readShape(shapesMap(d).get('shp_a')!)!.lastDeleted).toBe(true)
  })

  it('throws on an unknown id', () => {
    expect(() => deleteShape(doc(), 'shp_missing')).toThrow(/no shape/)
  })
})

describe('readBoard', () => {
  it('sorts by id and omits tombstones', () => {
    const d = doc()
    createRectShape(d, { id: 'shp_c' })
    createRectShape(d, { id: 'shp_a' })
    createRectShape(d, { id: 'shp_b' })
    deleteShape(d, 'shp_b')

    expect(readBoard(d).map(([id]) => id)).toEqual(['shp_a', 'shp_c'])
  })

  it('is empty for a fresh document', () => {
    expect(readBoard(doc())).toEqual([])
  })

  it('skips a map that is not a shape at all', () => {
    const d = doc()
    createRectShape(d, { id: 'shp_a' })
    attachedShape({ note: 'not a shape' }, 'junk', d)
    expect(readBoard(d).map(([id]) => id)).toEqual(['shp_a'])
  })
})

describe('geometry helpers', () => {
  const rect = (r: Partial<{ x: number; y: number; w: number; h: number }> = {}): Shape =>
    readShape(createRectShape(doc(), { id: 'shp_a', rect: { x: 10, y: 20, w: 100, h: 50, ...r } }))!

  it('reports axis-aligned bounds', () => {
    expect(boundsFor(rect())).toEqual({ x: 10, y: 20, w: 100, h: 50 })
  })

  it('hits inside and misses outside', () => {
    const s = rect()
    expect(hitTest(s, { x: 50, y: 40 })).toBe(true)
    expect(hitTest(s, { x: 9, y: 40 })).toBe(false)
    expect(hitTest(s, { x: 50, y: 71 })).toBe(false)
  })

  it('counts the edge as a hit, so a 1px line is selectable', () => {
    const s = rect()
    expect(hitTest(s, { x: 10, y: 20 })).toBe(true)
    expect(hitTest(s, { x: 110, y: 70 })).toBe(true)
  })

  it('hit-tests a shape with negative width or height', () => {
    // Dragging past the origin flips the sign; the shape is still where it looks.
    const s = rect({ x: 100, y: 100, w: -100, h: -50 })
    expect(hitTest(s, { x: 50, y: 80 })).toBe(true)
    expect(hitTest(s, { x: 150, y: 80 })).toBe(false)
  })
})

describe('z-order integration', () => {
  it('keeps keys that sort in insertion order', () => {
    const d = doc()
    const keys: string[] = []
    let z = first()
    for (let i = 0; i < 50; i++) {
      const map = createRectShape(d, { id: `shp_${String(i)}`, z })
      const shape = readShape(map)
      if (shape) keys.push(shape.z)
      z = after(z)
    }
    expect(keys).toHaveLength(50)
    expect([...keys].sort()).toEqual(keys)
  })

  it('reads back a key written by between', () => {
    const d = doc()
    const map = createRectShape(d, { id: 'shp_a', z: between(first(), after(first())) })
    const z = readShape(map)!.z
    expect(z > first()).toBe(true)
    expect(z < after(first())).toBe(true)
  })
})

describe('ellipse', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 }

  const ellipse = (over: Partial<EllipseShape> = {}): EllipseShape => ({
    id: 'e1',
    type: 'ellipse',
    z: first(),
    lastDeleted: false,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    rotation: 0,
    ...box,
    ...over,
  })

  it('round-trips through the document', () => {
    const d = doc()
    createEllipseShape(d, { id: 'e1', rect: box })
    const shape = readShape(shapesMap(d).get('e1')!)
    expect(shape?.type).toBe('ellipse')
    if (shape?.type !== 'ellipse') throw new Error('expected an ellipse')
    expect(shape.x).toBe(0)
    expect(shape.w).toBe(200)
    expect(shape.h).toBe(100)
  })

  it('is framed by the same box as a rect of the same extent', () => {
    // This is the load-bearing claim: an ellipse is described by a box, so everything
    // that frames shapes (culling, selection chrome, the eight handles) needs no new case.
    expect(boundsFor(ellipse())).toEqual({ x: 0, y: 0, w: 200, h: 100 })
  })

  it('ignores a stored type it does not know', () => {
    const d = doc()
    const map = createEllipseShape(d, { id: 'e1', rect: box })
    map.set('type', 'hexagon')
    expect(readShape(map)).toBeNull()
  })

  describe('hit testing', () => {
    it('accepts the centre', () => {
      expect(hitTest(ellipse(), { x: 100, y: 50 })).toBe(true)
    })

    it('accepts the extreme points on each axis', () => {
      expect(hitTest(ellipse(), { x: 200, y: 50 })).toBe(true)
      expect(hitTest(ellipse(), { x: 0, y: 50 })).toBe(true)
      expect(hitTest(ellipse(), { x: 100, y: 0 })).toBe(true)
      expect(hitTest(ellipse(), { x: 100, y: 100 })).toBe(true)
    })

    // The whole reason an ellipse is not tested as a box. A box test would pass all four
    // of these, which is how a user ends up dragging a shape they did not click.
    it('rejects the corners of its own bounding box', () => {
      expect(hitTest(ellipse(), { x: 0, y: 0 })).toBe(false)
      expect(hitTest(ellipse(), { x: 200, y: 0 })).toBe(false)
      expect(hitTest(ellipse(), { x: 0, y: 100 })).toBe(false)
      expect(hitTest(ellipse(), { x: 200, y: 100 })).toBe(false)
    })

    it('rejects points just outside the axes', () => {
      expect(hitTest(ellipse(), { x: 201, y: 50 })).toBe(false)
      expect(hitTest(ellipse(), { x: 100, y: 101 })).toBe(false)
      expect(hitTest(ellipse(), { x: -1, y: 50 })).toBe(false)
    })

    // On the box diagonal, the ellipse's own boundary is where the normalised coordinates
    // reach a squared length of 1. (185, 20) is comfortably inside the 200x100 box but
    // normalises to 0.85 and -0.6, and 0.85^2 + 0.6^2 is 1.0825 — outside.
    it('rejects a point on the box diagonal but outside the ellipse', () => {
      expect(hitTest(ellipse(), { x: 185, y: 20 })).toBe(false)
      expect(hitTest(ellipse(), { x: 150, y: 25 })).toBe(true)
    })

    it('agrees with the ellipse equation rather than the box, sampled densely', () => {
      const s = ellipse()
      for (let px = -20; px <= 220; px += 4) {
        for (let py = -20; py <= 120; py += 4) {
          const dx = (px - 100) / 100
          const dy = (py - 50) / 50
          const expected = dx * dx + dy * dy <= 1
          expect(hitTest(s, { x: px, y: py })).toBe(expected)
        }
      }
    })

    it('hit-tests a negative extent, because a drag can produce one', () => {
      const s = ellipse({ x: 200, y: 100, w: -200, h: -100 })
      expect(hitTest(s, { x: 100, y: 50 })).toBe(true)
      expect(hitTest(s, { x: 200, y: 100 })).toBe(false)
    })

    it('treats a zero extent as a point, matching the rect', () => {
      const s = ellipse({ x: 10, y: 10, w: 0, h: 0 })
      expect(hitTest(s, { x: 10, y: 10 })).toBe(true)
      expect(hitTest(s, { x: 11, y: 10 })).toBe(false)
    })

    it('hit-tests a zero width as a vertical line, not a point', () => {
      // A zero-width ellipse is the limit of a thin one: a vertical segment. Treating it
      // as a single point would make a shape the user drew by accident undeletable.
      const s = ellipse({ x: 10, y: 10, w: 0, h: 100 })
      expect(hitTest(s, { x: 10, y: 60 })).toBe(true)
      expect(hitTest(s, { x: 11, y: 60 })).toBe(false)
    })

    it('hit-tests a zero height as a horizontal line', () => {
      const s = ellipse({ x: 10, y: 10, w: 100, h: 0 })
      expect(hitTest(s, { x: 60, y: 10 })).toBe(true)
      expect(hitTest(s, { x: 60, y: 11 })).toBe(false)
    })

    it('reports a rect as its box, so the two types are distinguishable', () => {
      const r: Shape = { ...ellipse(), type: 'rect' }
      expect(hitTest(r, { x: 1, y: 1 })).toBe(true)
      expect(hitTest(ellipse(), { x: 1, y: 1 })).toBe(false)
    })
  })
})

describe('isBoxedShape', () => {
  /**
   * A minimal valid shape of `type`.
   *
   * Per-type rather than one object cast to the union, because that cast stops type-checking
   * the moment a member carries a field the others do not — which is exactly what happened
   * when the pen and the line landed, and it is the behaviour worth having. A helper that
   * cannot build a pen is a helper that cannot quietly let a test assert on a shape no
   * document could ever contain.
   */
  function shape(type: ShapeType): Shape {
    const base = {
      id: 's1',
      z: first(),
      lastDeleted: false,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      fill: '#fff',
      stroke: '#000',
      strokeWidth: 1,
      rotation: 0,
    }
    switch (type) {
      case 'rect':
        return { ...base, type: 'rect' }
      case 'ellipse':
        return { ...base, type: 'ellipse' }
      case 'note':
        return { ...base, type: 'note', text: '' }
      case 'line':
        return { ...base, type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, head: false }
      case 'pen':
        return { ...base, type: 'pen', points: [0, 0, 1, 1] }
    }
  }

  it('accepts every type that is described by a box', () => {
    expect(isBoxedShape(shape('rect'))).toBe(true)
    expect(isBoxedShape(shape('ellipse'))).toBe(true)
    // A note is a box with text in it, so it moves and resizes through the existing eight
    // handles with no new code. Leaving it out would silently make notes unresizable.
    expect(isBoxedShape(shape('note'))).toBe(true)
  })

  it('rejects the types whose box is derived, so a resize has to say so', () => {
    // A line's box is the box of its endpoints and a pen's is the box of its points, so
    // dragging a corner of either has no meaning. The guard is what stops the eight handles
    // appearing on a shape they would lie about.
    expect(isBoxedShape(shape('line'))).toBe(false)
    expect(isBoxedShape(shape('pen'))).toBe(false)
  })

  it('covers every declared type, so a new member cannot be forgotten here', () => {
    for (const type of SHAPE_TYPES) {
      expect(isBoxedShape(shape(type))).toBeTypeOf('boolean')
    }
    expect(SHAPE_TYPES).toHaveLength(5)
  })

  it('rejects a missing shape rather than throwing', () => {
    // A caller asking this question about a shape that is not there is asking whether it
    // may be resized, and the answer has to be no without an exception in the way.
    expect(isBoxedShape(null)).toBe(false)
    expect(isBoxedShape(undefined)).toBe(false)
  })

  it('narrows the type, so a caller is not left re-testing it', () => {
    const s: Shape = shape('ellipse')
    if (!isBoxedShape(s)) throw new Error('expected a boxed shape')
    // The point of the guard: `x`, `w` and `h` are reachable because the type says so.
    expect(s.x + s.w).toBe(1)
  })
})

describe('createLineShape', () => {
  it('stores the endpoints it was given, and derives the box from them', () => {
    // The box is derived, not supplied. A line created with a box that disagreed with its
    // endpoints would cull and hit-test in one place and draw in another, and there is no
    // second argument here that could even disagree.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 30, y1: 40, x2: 10, y2: 5 })
    const shape = readShape(shapesMap(d).get('l1')!) as LineShape
    expect(shape.type).toBe('line')
    expect([shape.x1, shape.y1, shape.x2, shape.y2]).toEqual([30, 40, 10, 5])
    expect([shape.x, shape.y, shape.w, shape.h]).toEqual([10, 5, 20, 35])
  })

  it('is readable back with every field, and the box agrees with the endpoints', () => {
    const d = doc()
    createLineShape(d, { id: 'l1', x1: -5, y1: 12.5, x2: 100, y2: 0, head: true })
    const shape = readShape(shapesMap(d).get('l1')!) as LineShape
    expect(shape.head).toBe(true)
    expect(shape.lastDeleted).toBe(false)
    expect(boundsFor(shape)).toEqual({ x: -5, y: 0, w: 105, h: 12.5 })
  })

  it('defaults to no arrowhead, and says so rather than leaving the field unset', () => {
    // `undefined` and `false` would both render as no head, but only one of them survives a
    // round trip through a peer that writes nothing. A field a reader has to interpret is a
    // field a peer can change the meaning of.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 0, y1: 0, x2: 10, y2: 0 })
    const map = shapesMap(d).get('l1')
    expect(map?.get('head')).toBe(false)
    expect((readShape(shapesMap(d).get('l1')!) as LineShape).head).toBe(false)
  })

  it('is stroke-only, so a new line has no fill to fight the board with', () => {
    // Every line drawn on a white board with a white fill is a white line. This is the
    // default that makes the tool work on the first try rather than after a trip to the
    // inspector.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 0, y1: 0, x2: 10, y2: 0 })
    const shape = readShape(shapesMap(d).get('l1')!) as LineShape
    expect(shape.strokeWidth).toBeGreaterThan(0)
    expect(shape.fill).toBe('transparent')
  })
})

describe('createPenShape', () => {
  it('stores the points verbatim and derives the box from them', () => {
    const d = doc()
    createPenShape(d, { id: 'p1', points: [10, 20, 30, 5, 15, 40] })
    const shape = readShape(shapesMap(d).get('p1')!) as PenShape
    expect(shape.points).toEqual([10, 20, 30, 5, 15, 40])
    expect([shape.x, shape.y, shape.w, shape.h]).toEqual([10, 5, 20, 35])
  })

  it('accepts a run of a single point, which is what a tap commits', () => {
    // A one-point run is the dot a pen makes when the pointer does not travel. It has no
    // extent, and the reader has to keep it rather than drop it: dropping it would make a
    // tap create nothing, and the shape would not round-trip.
    const d = doc()
    createPenShape(d, { id: 'p1', points: [7, 8] })
    expect((readShape(shapesMap(d).get('p1')!) as PenShape).points).toEqual([7, 8])
  })

  it('accepts an empty run without producing NaN bounds', () => {
    // An empty run is legal input from a remote peer, and `Infinity - Infinity` is NaN �
    // which propagates into a cull test, where `NaN < x` is false, so the shape is never
    // culled and never drawn.
    const d = doc()
    createPenShape(d, { id: 'p1', points: [] })
    const shape = readShape(shapesMap(d).get('p1')!) as PenShape
    expect(boundsFor(shape)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('drops a trailing odd coordinate rather than reading it as a point', () => {
    // A peer running an older build, or a hand-written update, can leave an odd-length
    // array. Reading `points[2]` as an x and pairing it with `undefined` would put NaN in
    // the renderer, and one NaN coordinate blanks the whole canvas in some browsers.
    const d = doc()
    attachedShape({ id: 'p1', type: 'pen', points: [1, 2, 3] }, 'p1', d)
    expect((readShape(shapesMap(d).get('p1')!) as PenShape).points).toEqual([1, 2])
  })

  it('is stroke-only', () => {
    const d = doc()
    createPenShape(d, { id: 'p1', points: [0, 0, 1, 1] })
    expect((readShape(shapesMap(d).get('p1')!) as PenShape).fill).toBe('transparent')
  })
})

describe('createNoteShape', () => {
  it('starts empty and takes a per-type fill that has an edge against the board', () => {
    // `DEFAULT_STYLE`'s white on a cream board has no edge, so the note would be a region
    // of nothing. The fill is the reason a note reads as paper.
    const d = doc()
    createNoteShape(d, { id: 'n1', rect: { x: 4, y: 6, w: 100, h: 50 } })
    const shape = readShape(shapesMap(d).get('n1')!) as NoteShape
    expect(shape.text).toBe('')
    expect(shape.fill).not.toBe('transparent')
    expect(shape.fill).not.toBe('#ffffff')
    expect([shape.x, shape.y, shape.w, shape.h]).toEqual([4, 6, 100, 50])
  })

  it('takes a caller fill over the default, because a note colour is the users', () => {
    const d = doc()
    createNoteShape(d, {
      id: 'n1',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      style: { fill: '#ffeeaa' },
    })
    expect((readShape(shapesMap(d).get('n1')!) as NoteShape).fill).toBe('#ffeeaa')
  })

  it('accepts no box, so a click with no drag can still make a note', () => {
    const d = doc()
    createNoteShape(d, { id: 'n1' })
    const shape = readShape(shapesMap(d).get('n1')!) as NoteShape
    expect(shape.w).toBeGreaterThan(0)
    expect(shape.h).toBeGreaterThan(0)
  })
})

describe('translateShape', () => {
  it('moves a box by its own x and y', () => {
    const d = doc()
    createRectShape(d, { id: 'r1', rect: { x: 10, y: 20, w: 30, h: 40 } })
    translateShape(shapesMap(d).get('r1')!, 5, -7)
    expect(boundsFor(readShape(shapesMap(d).get('r1')!)!)).toEqual({ x: 15, y: 13, w: 30, h: 40 })
  })

  it('moves a line by its endpoints, because its box is derived', () => {
    // The case that motivated the function. Writing x and y on a line would move a number
    // the reader ignores: the shape would be selected, dragged, and stay exactly where it
    // was, which is the bug a type-specific move hides behind a passing "x changed" check.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 0, y1: 0, x2: 10, y2: 0 })
    translateShape(shapesMap(d).get('l1')!, 3, 4)
    const shape = readShape(shapesMap(d).get('l1')!) as LineShape
    expect([shape.x1, shape.y1, shape.x2, shape.y2]).toEqual([3, 4, 13, 4])
    expect([shape.x, shape.y, shape.w, shape.h]).toEqual([3, 4, 10, 0])
  })

  it('rewrites a lines derived box, so the document never holds one that disagrees', () => {
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 0, y1: 0, x2: 10, y2: 10 })
    translateShape(shapesMap(d).get('l1')!, 100, 0)
    const map = shapesMap(d).get('l1')!
    expect([map.get('x'), map.get('y'), map.get('w'), map.get('h')]).toEqual([100, 0, 10, 10])
  })

  it('moves every point of a pen, and rewrites its box', () => {
    const d = doc()
    createPenShape(d, { id: 'p1', points: [0, 0, 5, 0, 5, 5] })
    translateShape(shapesMap(d).get('p1')!, 1, 2)
    const shape = readShape(shapesMap(d).get('p1')!) as PenShape
    expect(shape.points).toEqual([1, 2, 6, 2, 6, 7])
    expect([shape.x, shape.y, shape.w, shape.h]).toEqual([1, 2, 5, 5])
  })

  it('replaces the point array rather than mutating the one a reader holds', () => {
    // A Yjs array is shared. Mutating it in place would change what an already-read local
    // value says, with no transaction recorded � the change would exist on this replica and
    // never travel, which is a divergence that only a reconnect would surface.
    const d = doc()
    createPenShape(d, { id: 'p1', points: [0, 0, 1, 1] })
    const before = (readShape(shapesMap(d).get('p1')!) as PenShape).points
    translateShape(shapesMap(d).get('p1')!, 1, 1)
    expect(before).toEqual([0, 0, 1, 1])
    expect((readShape(shapesMap(d).get('p1')!) as PenShape).points).toEqual([1, 1, 2, 2])
  })

  it('leaves a pen with no readable points alone instead of throwing', () => {
    const d = doc()
    attachedShape({ id: 'p1', type: 'pen' }, 'p1', d)
    expect(() => {
      translateShape(shapesMap(d).get('p1')!, 1, 1)
    }).not.toThrow()
  })

  it('is a no-op for a type it does not know, rather than writing fields onto it', () => {
    // A shape from a newer build. Writing x and y on it would mean a peer on the old build
    // moves a field the new build does not use, and the two would disagree about where the
    // shape is.
    const d = doc()
    const map = attachedShape({ id: 'x1', type: 'video', x: 1, y: 2 }, 'x1', d)
    translateShape(map, 5, 5)
    expect(map.get('x')).toBe(1)
    expect(map.get('y')).toBe(2)
  })
})

describe('hitTest on the derived types', () => {
  /** Read a shape and ask whether a point is on it. */
  function on(d: Doc, id: string, x: number, y: number, tolerance?: number): boolean {
    const shape = readShape(shapesMap(d).get(id) ?? new YMap())
    if (!shape) throw new Error(`no shape ${id}`)
    return tolerance === undefined ? hitTest(shape, { x, y }) : hitTest(shape, { x, y }, tolerance)
  }

  it('finds a line along its segment and not along its box', () => {
    // The segment is the shape. A hit test that answered from the box would let the user
    // grab the line from anywhere in a 100x40 region that is 98% empty board, and the
    // handles and the selection ring would then claim a box the line does not fill.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 0, y1: 0, x2: 100, y2: 0 })
    expect(on(d, 'l1', 50, 0)).toBe(true)
    expect(on(d, 'l1', 0, 0)).toBe(true)
    expect(on(d, 'l1', 100, 0)).toBe(true)
    expect(on(d, 'l1', 50, 40)).toBe(false)
  })

  it('misses a line past the tolerance, and finds it within it', () => {
    // The default tolerance is a few world units, which is what makes a 2px line grabbable
    // across its own width. The point of the test is that it is a *distance to the segment*
    // and not a box test: 5 units off the middle of a 100-unit line is a miss even though
    // the line's box is 100 wide.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 0, y1: 0, x2: 100, y2: 0 })
    expect(on(d, 'l1', 50, 3)).toBe(true)
    expect(on(d, 'l1', 50, 40)).toBe(false)
    expect(on(d, 'l1', 50, 3, 4)).toBe(true)
    // Past the end as well as off the side, so the tolerance does not hang off the ends of
    // the segment indefinitely.
    expect(on(d, 'l1', 120, 0)).toBe(false)
  })

  it('finds a line by its own nearest point, not by a corner of its box', () => {
    // A diagonal from (0,0) to (100,100). Its box is the whole square, and its two unused
    // corners are the strongest possible evidence that the box is not the shape: a user
    // clicking the corner of the selection ring expects to miss.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 0, y1: 0, x2: 100, y2: 100 })
    expect(on(d, 'l1', 50, 50)).toBe(true)
    expect(on(d, 'l1', 90, 10)).toBe(false)
  })

  it('finds a pen anywhere along its run, including the middle of a curve', () => {
    // The interior point of a polyline is on no segment's interior and is the point a
    // distance-to-endpoints test would miss, so this is the case that separates a real
    // polyline distance from a cheap one.
    const d = doc()
    createPenShape(d, { id: 'p1', points: [0, 0, 50, 50, 100, 0] })
    expect(on(d, 'p1', 50, 50)).toBe(true)
    expect(on(d, 'p1', 25, 25)).toBe(true)
    expect(on(d, 'p1', 75, 25)).toBe(true)
    expect(on(d, 'p1', 50, 80)).toBe(false)
  })

  it('finds a note by its box, like any other boxed shape', () => {
    const d = doc()
    createNoteShape(d, { id: 'n1', rect: { x: 10, y: 10, w: 60, h: 40 } })
    expect(on(d, 'n1', 40, 30)).toBe(true)
    expect(on(d, 'n1', 5, 30)).toBe(false)
  })

  it('finds a zero-length line at its point, and nowhere near it', () => {
    // The dot a pen tap makes, written as a degenerate segment. A real shape, and the one
    // shape that must still be grabbable: a user cannot move or delete what they cannot
    // select. A zero-length segment has to measure distance to the point, and a formula
    // that divides by the segment's own length returns NaN for it — and `NaN <= tolerance`
    // is false, which would make the dot permanently unselectable.
    const d = doc()
    createLineShape(d, { id: 'l1', x1: 20, y1: 20, x2: 20, y2: 20 })
    expect(on(d, 'l1', 20, 20)).toBe(true)
    expect(on(d, 'l1', 24, 20, 4)).toBe(true)
    expect(on(d, 'l1', 40, 20)).toBe(false)
  })

  it('misses an empty pen rather than matching at the origin', () => {
    // The empty run's box is the origin, and a hit test that answered from the box would
    // make every empty pen in a document grabbable from the top-left corner of the board.
    const d = doc()
    createPenShape(d, { id: 'p1', points: [] })
    expect(on(d, 'p1', 0, 0)).toBe(false)
  })

  it('finds a pen of a single repeated point, which is how a tap is stored', () => {
    // Two identical points make a zero-length segment. If the polyline test mishandled it
    // the dot would be the one pen shape that could not be selected.
    const d = doc()
    createPenShape(d, { id: 'p1', points: [12, 12, 12, 12] })
    expect(on(d, 'p1', 12, 12)).toBe(true)
    expect(on(d, 'p1', 30, 12)).toBe(false)
  })
})
