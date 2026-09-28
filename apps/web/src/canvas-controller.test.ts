import { describe, expect, it } from 'vitest'
import { normalize, resizeRect } from './canvas-controller.js'

/**
 * The two pure geometry helpers in the controller.
 *
 * These are the only parts of the controller that can be tested without a canvas, and they
 * are the parts where a mistake is invisible: a wrong edge mapping does not throw, it just
 * resizes from the wrong corner, which looks like the app is not listening to the mouse.
 */

// Base rect for the resize cases: x=10 y=20 w=100 h=50, so left=10 top=20 right=110
// bottom=70. Every expectation below is written against those edges.
const X = 10
const Y = 20
const W = 100
const H = 50

describe('normalize', () => {
  it('leaves a positive extent alone', () => {
    expect(normalize(5, 5, 10, 10)).toEqual({ x: 5, y: 5, w: 10, h: 10 })
  })

  it('moves the origin when the drag goes up and to the left', () => {
    expect(normalize(10, 10, -4, -6)).toEqual({ x: 6, y: 4, w: 4, h: 6 })
  })

  it('moves only the x origin when the drag is leftwards', () => {
    expect(normalize(10, 10, -4, 6)).toEqual({ x: 6, y: 10, w: 4, h: 6 })
  })

  it('moves only the y origin when the drag is upwards', () => {
    expect(normalize(10, 10, 4, -6)).toEqual({ x: 10, y: 4, w: 4, h: 6 })
  })

  it('keeps a zero extent at zero', () => {
    expect(normalize(7, 8, 0, 0)).toEqual({ x: 7, y: 8, w: 0, h: 0 })
  })

  it('produces a zero width for a click with no drag', () => {
    const r = normalize(3, 4, 0, 9)
    expect(r.x).toBe(3)
    expect(r.w).toBe(0)
  })
})

describe('resizeRect', () => {
  // Handle order is the renderer's: 0..3 corners clockwise from north-west, 4..7 the edge
  // midpoints. Each case drags that handle and asserts which edges followed it.
  it('handle 0 drags the left and top edges', () => {
    expect(resizeRect(X, Y, W, H, 0, 0, 0)).toEqual({ x: 0, y: 0, w: 110, h: 70 })
  })

  it('handle 1 drags the right and top edges', () => {
    expect(resizeRect(X, Y, W, H, 1, 150, 0)).toEqual({ x: 10, y: 0, w: 140, h: 70 })
  })

  it('handle 2 drags the right and bottom edges', () => {
    expect(resizeRect(X, Y, W, H, 2, 150, 100)).toEqual({ x: 10, y: 20, w: 140, h: 80 })
  })

  it('handle 3 drags the left and bottom edges', () => {
    expect(resizeRect(X, Y, W, H, 3, 0, 100)).toEqual({ x: 0, y: 20, w: 110, h: 80 })
  })

  it('handle 4 drags only the top edge', () => {
    expect(resizeRect(X, Y, W, H, 4, 60, 5)).toEqual({ x: 10, y: 5, w: 100, h: 65 })
  })

  it('handle 5 drags only the right edge', () => {
    expect(resizeRect(X, Y, W, H, 5, 150, 45)).toEqual({ x: 10, y: 20, w: 140, h: 50 })
  })

  it('handle 6 drags only the bottom edge', () => {
    expect(resizeRect(X, Y, W, H, 6, 60, 90)).toEqual({ x: 10, y: 20, w: 100, h: 70 })
  })

  it('handle 7 drags only the left edge', () => {
    expect(resizeRect(X, Y, W, H, 7, 0, 45)).toEqual({ x: 0, y: 20, w: 110, h: 50 })
  })

  it('keeps the other edges pinned when a handle is dragged back to its own position', () => {
    const untouched = resizeRect(X, Y, W, H, 5, 110, 45)
    expect(untouched).toEqual({ x: X, y: Y, w: W, h: H })
  })

  // A drag past the opposite edge inverts the rect instead of clamping. The store's
  // min/max normalisation is what turns the negative extent back into a usable box, so
  // clamping here would throw away the user's drag rather than honour it.
  it('negates the extent when the left handle is dragged past the right edge', () => {
    expect(resizeRect(X, Y, W, H, 7, 200, 45)).toEqual({ x: 200, y: 20, w: -90, h: 50 })
  })

  it('negates both extents when the north-west handle is dragged past the south-east', () => {
    expect(resizeRect(X, Y, W, H, 0, 300, 300)).toEqual({ x: 300, y: 300, w: -190, h: -230 })
  })

  it('round-trips a resize back to the original when the handle returns', () => {
    const once = resizeRect(X, Y, W, H, 2, 150, 100)
    const back = resizeRect(once.x, once.y, once.w, once.h, 2, X + W, Y + H)
    expect(back).toEqual({ x: X, y: Y, w: W, h: H })
  })
})
