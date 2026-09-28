// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useBoardStore } from './store.js'
import { App } from './App.js'

/**
 * A mount smoke test.
 *
 * Every other test in this app checks logic that never ran in a browser. This one exists
 * because the failure mode it covers is invisible until someone opens the page: a white
 * screen, from a context that could not be acquired, a store that was never created, or a
 * ref read before the effect that fills it. None of that throws in a unit test that only
 * imports the functions, and all of it looks like a working build.
 *
 * It has already paid for itself: it caught the canvas stack reading the controller
 * binding while that binding was still initialising.
 */

// Persistence is exercised on its own. Here it is replaced so that a mount test cannot
// fail because the environment has no IndexedDB, which is a fact about the test runner
// and not about the app.
vi.mock('./persistence.js', () => ({
  persistLocally: () => ({ whenSynced: Promise.resolve(null), destroy: () => Promise.resolve() }),
}))

/**
 * A 2D context that records nothing and does nothing.
 *
 * The real thing needs a GPU and a real canvas, and what the renderer writes is already
 * covered by the geometry package's own tests. What is being checked here is that the
 * calls are made and nothing throws, so the stub only has to be complete enough to walk.
 */
function stubContext(): CanvasRenderingContext2D {
  const noop = (): void => {
    // The renderer writes to a context; what it writes is covered by the geometry
    // package's own tests. Here the call only has to not throw.
  }
  const gradient = { addColorStop: noop } as unknown as CanvasGradient
  return {
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    resetTransform: noop,
    transform: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    setLineDash: noop,
    fillText: noop,
    measureText: () => ({ width: 0 }) as TextMetrics,
    createLinearGradient: () => gradient,
  } as unknown as CanvasRenderingContext2D
}

let contextRequests = 0

beforeEach(() => {
  useBoardStore.getState().setSelection([])
  useBoardStore.getState().setShapeCount(0)
  useBoardStore.getState().setTool('rect')
  contextRequests = 0

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    contextRequests++
    const ctx = stubContext()
    ;(ctx as { canvas: HTMLCanvasElement | null }).canvas = this
    return ctx
  })

  // happy-dom has no ResizeObserver, and the board subscribes to one. Nothing is
  // expected to resize in a test, so the methods only have to exist.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        // No layout in this environment, so there is nothing to observe.
      }
      unobserve(): void {
        // Nothing was registered.
      }
      disconnect(): void {
        // Nothing to release.
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App', () => {
  it('mounts without throwing and paints all three layers', async () => {
    const { container } = render(<App />)

    const layers = container.querySelectorAll('canvas.layer')
    expect(layers).toHaveLength(3)
    expect([...layers].map((l) => l.getAttribute('data-layer'))).toEqual([
      'board',
      'presence',
      'overlay',
    ])

    // The contexts are taken on the first animation frame, not at construction, so this
    // waits for a frame rather than asserting immediately. Three of them means the loop
    // actually got what it needed to draw with, which a canvas returning null would not.
    await vi.waitFor(() => {
      expect(contextRequests).toBeGreaterThanOrEqual(3)
    })
  })

  it('shows the empty state until something is drawn', () => {
    const { container } = render(<App />)
    expect(container.querySelector('.empty')).not.toBeNull()
  })

  it('renders the toolbar with the rectangle tool pressed and the rest disabled', () => {
    const { container } = render(<App />)

    const pressed = [...container.querySelectorAll('button[aria-pressed="true"]')]
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.getAttribute('title')).toContain('Rectangle')

    // Tools Phase 1 has not built must be genuinely disabled, not just inert.
    const disabled = [...container.querySelectorAll('button.tool:disabled')]
    const labels = disabled.map((b) => b.getAttribute('title') ?? '')
    expect(labels.some((t) => t.startsWith('Ellipse'))).toBe(true)
    expect(labels.some((t) => t.startsWith('Pen'))).toBe(true)
  })

  it('gives the overlay canvas a focus stop and a role', () => {
    const { container } = render(<App />)
    const overlay = container.querySelector('canvas[data-layer="overlay"]')
    expect(overlay?.getAttribute('tabindex')).toBe('0')
    expect(overlay?.getAttribute('role')).toBe('application')
  })

  it('reports the storage state rather than claiming a save it cannot make', () => {
    const { container } = render(<App />)
    // Nothing is wired up in this environment, so the indicator must say so rather than
    // reporting a copy that does not exist.
    const sync = container.querySelector('.sync')
    expect(sync?.getAttribute('data-state')).toBe(useBoardStore.getState().sync)
  })

  it('does not report a saved copy when nothing is being persisted', () => {
    const { container } = render(<App />)
    expect(container.textContent).not.toContain('saved to this device')
  })
})
