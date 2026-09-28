import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampDevicePixelRatio,
  clampZoom,
  createViewport,
  isVisible,
  screenToWorld,
  toTransform,
  visibleBounds,
  worldToScreen,
  zoomAt,
  zoomToFit,
} from './transform.js'

const point = () => ({ x: 0, y: 0 })

describe('clampZoom', () => {
  it('holds the documented range', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(-4)).toBe(MIN_ZOOM)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
  })

  it('falls back to 1 for values that are not numbers', () => {
    // A NaN zoom from a divided-by-zero pinch would otherwise propagate into every
    // coordinate and blank the canvas with no error.
    expect(clampZoom(Number.NaN)).toBe(1)
    // An infinite zoom is a limit rather than a bug, so it clamps to the bound.
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_ZOOM)
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(MIN_ZOOM)
  })
})

describe('clampDevicePixelRatio', () => {
  it('caps a phone at 3 and survives nonsense', () => {
    expect(clampDevicePixelRatio(1)).toBe(1)
    expect(clampDevicePixelRatio(2)).toBe(2)
    expect(clampDevicePixelRatio(4)).toBe(3)
    expect(clampDevicePixelRatio(0)).toBe(1)
    expect(clampDevicePixelRatio(Number.NaN)).toBe(1)
  })
})

describe('screen and world', () => {
  const size = { width: 800, height: 600 }
  const viewport = createViewport({ cameraX: 100, cameraY: -50, zoom: 2 })

  it('round-trips a point', () => {
    const t = toTransform(viewport, size, 1)
    const world = point()
    const screen = point()
    // Typed as pairs, not `number[][]`: a tuple keeps both coordinates `number` instead
    // of quietly making them `number | undefined` on the way out of the array.
    const cases: [number, number][] = [
      [0, 0],
      [100, -50],
      [-1234.5, 987.25],
    ]
    for (const [wx, wy] of cases) {
      worldToScreen(t, wx, wy, screen)
      screenToWorld(t, screen.x, screen.y, world)
      expect(world.x).toBeCloseTo(wx, 6)
      expect(world.y).toBeCloseTo(wy, 6)
    }
  })

  it('puts the camera at the centre of the canvas', () => {
    const t = toTransform(viewport, size, 1)
    const out = point()
    worldToScreen(t, viewport.cameraX, viewport.cameraY, out)
    expect(out.x).toBe(400)
    expect(out.y).toBe(300)
  })

  it('scales by zoom exactly', () => {
    // One world unit is `zoom` screen units, everywhere. A mismatch here is what makes a
    // shape clickable in one place and visible in another.
    const t = toTransform(viewport, size, 1)
    const a = point()
    const b = point()
    worldToScreen(t, 0, 0, a)
    worldToScreen(t, 1, 0, b)
    expect(b.x - a.x).toBeCloseTo(2, 6)
  })
})

describe('visibleBounds', () => {
  it('agrees with isVisible at the edges, inclusive', () => {
    const t = toTransform(createViewport({ zoom: 1 }), { width: 400, height: 400 }, 1)
    const bounds = { x: 0, y: 0, w: 0, h: 0 }
    visibleBounds(t, bounds)
    expect(bounds).toEqual({ x: -200, y: -200, w: 400, h: 400 })

    // Exactly touching counts as visible: a shape at the very edge must still be hit.
    expect(isVisible(t, 200, 0, 1, 1)).toBe(true)
    expect(isVisible(t, 201, 0, 1, 1)).toBe(false)
  })

  it('grows the visible area as zoom goes out', () => {
    const size = { width: 400, height: 400 }
    const near = { x: 0, y: 0, w: 0, h: 0 }
    const far = { x: 0, y: 0, w: 0, h: 0 }
    visibleBounds(toTransform(createViewport({ zoom: 1 }), size, 1), near)
    visibleBounds(toTransform(createViewport({ zoom: 0.5 }), size, 1), far)
    expect(far.w).toBeCloseTo(near.w * 2, 6)
  })
})

describe('zoomAt', () => {
  const size = { width: 800, height: 600 }

  it('keeps the world point under the cursor exactly where it was', () => {
    // The property that matters, stated once. If this fails, pinch-zoom slides content
    // out from under the fingers, which is the whole complaint about pinch-zoom.
    const start = createViewport({ cameraX: 30, cameraY: 70, zoom: 1.3 })
    const screen = { x: 613, y: 214 }
    const before = toTransform(start, size, 1)
    const anchor = point()
    screenToWorld(before, screen.x, screen.y, anchor)

    for (const factor of [1.2, 0.5, 2, 0.9, 1.05]) {
      const next = zoomAt(start, screen.x, screen.y, size, factor)
      const after = toTransform(next, size, 1)
      const now = point()
      screenToWorld(after, screen.x, screen.y, now)
      expect(now.x).toBeCloseTo(anchor.x, 6)
      expect(now.y).toBeCloseTo(anchor.y, 6)
    }
  })

  it('clamps instead of running away', () => {
    const start = createViewport({ zoom: 1 })
    expect(zoomAt(start, 0, 0, size, 1000).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(start, 0, 0, size, 0.0001).zoom).toBe(MIN_ZOOM)
  })

  it('is a no-op when the clamped zoom is unchanged', () => {
    const start = createViewport({ zoom: MAX_ZOOM })
    expect(zoomAt(start, 0, 0, size, 4)).toBe(start)
  })
})

describe('zoomToFit', () => {
  it('fits content with padding and stays clamped', () => {
    const size = { width: 800, height: 600 }
    // Usable area is 704 x 504 after 48px of padding, so height is the limiting side:
    // 504/300 = 1.68 against 704/400 = 1.76.
    expect(zoomToFit({ x: 0, y: 0, w: 400, h: 300 }, size)).toBeCloseTo(1.68, 5)
    expect(zoomToFit({ x: 0, y: 0, w: 1, h: 1 }, size)).toBe(MAX_ZOOM)
    expect(zoomToFit({ x: 0, y: 0, w: 0, h: 0 }, size)).toBe(1)
  })
})
