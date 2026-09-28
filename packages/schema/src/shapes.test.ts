import { describe, expect, it } from 'vitest'
import { Map as YMap, Doc } from 'yjs'
import { after, between, first } from './fractional-index.js'
import {
  boundsFor,
  createRectShape,
  deleteShape,
  hitTest,
  readBoard,
  readShape,
  shapesMap,
} from './shapes.js'
import type { Shape } from './shapes.js'

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
