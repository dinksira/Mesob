// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Doc } from 'yjs'
import { readBoard } from '@mesob/schema'
import { ShapeStore } from '@mesob/web-geometry'
import { useBoardStore } from './store.js'
import { CanvasController, type Tool } from './canvas-controller.js'
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

describe('CanvasController', () => {
  /**
   * The interaction path, driven the way a pointer drives it.
   *
   * This exists because every earlier test in this app left a real hole: nothing here ever
   * called `refresh`, and `refresh` calling itself is not a type error, not a lint error and
   * not a build error. It typechecks, it bundles, and it only detonates on the first
   * pointer-up — the one moment a user is guaranteed to try within seconds of opening the
   * page. A passing suite and a white screen are entirely compatible.
   */
  function mountController(tool: Tool = 'rect'): {
    controller: CanvasController
    doc: Doc
    /** The last selection the controller reported, as shape IDs. */
    selectedIds: () => string[]
  } {
    const doc = new Doc()
    const canvases = [
      document.createElement('canvas'),
      document.createElement('canvas'),
      document.createElement('canvas'),
    ]
    let ids: string[] = []
    const controller = new CanvasController(
      canvases[0]!,
      canvases[1]!,
      canvases[2]!,
      doc,
      new ShapeStore(),
      {
        onSelectionChange: (next) => {
          // The controller keeps its selection private, and a test that could only assert
          // on it by reaching past the class could not see a bug where the class and the
          // callback disagree. Reading what it actually reported is also the only way to
          // catch a click that selected a shape without announcing it.
          ids = next
        },
        onShapeCountChange: () => {
          // The store's size is asserted directly; this is not under test.
        },
      },
    )
    controller.resize(800, 600, 1)
    controller.setTool(tool)
    return { controller, doc, selectedIds: () => ids }
  }

  it('refresh terminates instead of recursing into itself', () => {
    const { controller } = mountController()
    // A stack overflow surfaces as a RangeError, so simply reaching the assertion is the
    // test. The value check afterwards is there to make the intent obvious to a reader.
    expect(() => {
      controller.refresh()
    }).not.toThrow()
  })

  it('draws a rectangle into the document on a drag', () => {
    const { controller, doc } = mountController()

    controller.pointerDown(100, 100, 0)
    controller.pointerMove(200, 160)
    controller.pointerUp()

    // One shape, and it is the one the drag described. Read back through the schema rather
    // than the store, so this fails if the write itself is wrong and not only if the
    // projection is. readBoard returns [id, shape] tuples and already drops tombstones.
    //
    // The numbers are world coordinates, not the screen points that were dragged: at
    // zoom 1 with the camera at the origin, screen (100, 100) on an 800x600 canvas is
    // world (-300, -200). Asserting the world values is also an assertion that the
    // screen-to-world transform ran, which a test that dragged in world units would skip.
    const shapes = readBoard(doc)
    expect(shapes).toHaveLength(1)
    const shape = shapes[0]?.[1]
    expect(shape?.type).toBe('rect')
    if (shape?.type !== 'rect') throw new Error('expected a rect')
    expect(shape.x).toBe(-300)
    expect(shape.y).toBe(-200)
    expect(shape.w).toBe(100)
    expect(shape.h).toBe(60)
  })

  it('reflects a drag into the store after the commit', () => {
    const { controller } = mountController()

    controller.pointerDown(100, 100, 0)
    controller.pointerMove(200, 160)
    controller.pointerUp()

    // The commit path ends in refresh, so this covers the same recursion from the other
    // direction: the first pointer-up after a drag to draw.
    expect(() => controller.refresh()).not.toThrow()
    expect(controller.store.size).toBe(1)
  })

  it('undoes a drawn rectangle without recursing', () => {
    const { controller, doc } = mountController()

    controller.pointerDown(100, 100, 0)
    controller.pointerMove(200, 160)
    controller.pointerUp()
    expect(controller.store.size).toBe(1)

    expect(() => controller.undoStep()).not.toThrow()
    controller.refresh()
    expect(readBoard(doc)).toHaveLength(0)
  })

  it('draws an ellipse when the ellipse tool is active', () => {
    const { controller, doc } = mountController('ellipse')

    controller.pointerDown(100, 100, 0)
    controller.pointerMove(200, 160)
    controller.pointerUp()

    const shapes = readBoard(doc)
    expect(shapes).toHaveLength(1)
    const shape = shapes[0]?.[1]
    expect(shape?.type).toBe('ellipse')
    if (shape?.type !== 'ellipse') throw new Error('expected an ellipse')
    // The same world box a rect drag of the same two points would produce: the ellipse is
    // described by the drag, not by a separate creation path.
    expect(shape.x).toBe(-300)
    expect(shape.y).toBe(-200)
    expect(shape.w).toBe(100)
    expect(shape.h).toBe(60)
  })

  it('leaves the tool alone after a drag, so the next shape keeps its type', () => {
    // A controller that reset to select on commit would make the second shape a marquee
    // rather than an ellipse, and only a second drag would notice.
    const { controller, doc } = mountController('ellipse')

    for (const x of [100, 300]) {
      controller.pointerDown(x, 100, 0)
      controller.pointerMove(x + 80, 160)
      controller.pointerUp()
    }

    expect(readBoard(doc).map(([, s]) => s.type)).toEqual(['ellipse', 'ellipse'])
  })

  it('normalises a leftward ellipse drag into a positive extent', () => {
    // The renderer takes absolute radii and would throw on a negative one, so the sign
    // must never survive this far. Screen (300,100) to (100,160) drags left and down, so
    // the world box comes out with a negative width before normalisation.
    const { controller, doc } = mountController('ellipse')

    controller.pointerDown(300, 100, 0)
    controller.pointerMove(100, 160)
    controller.pointerUp()

    const shape = readBoard(doc)[0]?.[1]
    expect(shape?.type).toBe('ellipse')
    if (shape?.type !== 'ellipse') throw new Error('expected an ellipse')
    // 200 screen px across, 60 down, starting from world (-100, -200) going left.
    expect(shape.w).toBe(200)
    expect(shape.h).toBe(60)
    expect(shape.x).toBe(-300)
    expect(shape.y).toBe(-200)
  })

  it('selects a drawn ellipse by clicking its centre, not by clicking its box corner', () => {
    // The end-to-end consequence of hit-testing the curve. A store that dispatched on the
    // box would select nothing by the off-curve click below, and a user would read that as
    // the shape being stuck.
    const { controller, doc, selectedIds } = mountController('ellipse')
    // A large ellipse, so the region inside the box but off the curve is comfortably
    // larger than the handle grab radius and the two cannot be confused.
    controller.pointerDown(100, 100, 0)
    controller.pointerMove(400, 400)
    controller.pointerUp()

    const shape = readBoard(doc)[0]?.[1]
    if (shape?.type !== 'ellipse') throw new Error('expected an ellipse')
    // At zoom 1 with the camera at the origin, screen (x, y) is world (x - 400, y - 300).
    const cx = shape.x + shape.w / 2
    const cy = shape.y + shape.h / 2

    controller.setTool('select')
    controller.pointerDown(cx + 400, cy + 300, 0)
    controller.pointerUp()
    expect(selectedIds()).toHaveLength(1)

    // Well inside the box, well outside the curve, and far from all eight handles. For
    // this box it normalises to about -0.67 and -0.9, a squared length of 1.25.
    controller.pointerDown(-250 + 400, -180 + 300, 0)
    controller.pointerUp()
    expect(selectedIds()).toEqual([])
  })

  it('moves a drawn ellipse and keeps it an ellipse', () => {
    const { controller, doc } = mountController('ellipse')
    controller.pointerDown(100, 100, 0)
    controller.pointerMove(200, 160)
    controller.pointerUp()

    const before = readBoard(doc)[0]?.[1]
    if (before?.type !== 'ellipse') throw new Error('expected an ellipse')

    controller.setTool('select')
    const screenX = before.x + before.w / 2 + 400
    const screenY = before.y + before.h / 2 + 300
    controller.pointerDown(screenX, screenY, 0)
    controller.pointerMove(screenX + 60, screenY)
    controller.pointerUp()

    const after = readBoard(doc)[0]?.[1]
    expect(after?.type).toBe('ellipse')
    if (after?.type !== 'ellipse') throw new Error('expected an ellipse')
    expect(after.x).toBe(before.x + 60)
    expect(after.y).toBe(before.y)
    expect(after.w).toBe(before.w)
  })

  it('resizes a drawn ellipse through a handle and keeps it an ellipse', () => {
    const { controller, doc } = mountController('ellipse')
    controller.pointerDown(100, 100, 0)
    controller.pointerMove(200, 160)
    controller.pointerUp()

    const before = readBoard(doc)[0]?.[1]
    if (before?.type !== 'ellipse') throw new Error('expected an ellipse')
    const screenX = before.x + before.w / 2 + 400
    const screenY = before.y + before.h / 2 + 300

    // The east handle sits on the right edge of the box, at its vertical centre.
    controller.setTool('select')
    controller.pointerDown(screenX + before.w / 2, screenY, 0)
    controller.pointerMove(screenX + before.w / 2 + 40, screenY)
    controller.pointerUp()

    const after = readBoard(doc)[0]?.[1]
    expect(after?.type).toBe('ellipse')
    if (after?.type !== 'ellipse') throw new Error('expected an ellipse')
    expect(after.w).toBe(before.w + 40)
  })

  it('undoes a drawn ellipse', () => {
    const { controller, doc } = mountController('ellipse')
    controller.pointerDown(100, 100, 0)
    controller.pointerMove(200, 160)
    controller.pointerUp()
    expect(controller.store.size).toBe(1)

    controller.undoStep()
    controller.refresh()
    expect(readBoard(doc)).toHaveLength(0)
  })
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

  it('renders the toolbar with the rectangle tool pressed and only built tools enabled', () => {
    const { container } = render(<App />)

    const pressed = [...container.querySelectorAll('button[aria-pressed="true"]')]
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.getAttribute('title')).toContain('Rectangle')

    // Tools Phase 1 has not built must be genuinely disabled, not just inert. Ellipse is
    // built, so it belongs on the enabled side now.
    const disabled = [...container.querySelectorAll('button.tool:disabled')].map(
      (b) => b.getAttribute('title') ?? '',
    )
    expect(disabled.some((t) => t.startsWith('Pen'))).toBe(true)
    expect(disabled.some((t) => t.startsWith('Line'))).toBe(true)
    expect(disabled.some((t) => t.startsWith('Note'))).toBe(true)
    expect(disabled.some((t) => t.startsWith('Ellipse'))).toBe(false)

    const enabled = [...container.querySelectorAll('button.tool:not(:disabled)')].map(
      (b) => b.getAttribute('title') ?? '',
    )
    expect(enabled.some((t) => t.startsWith('Ellipse'))).toBe(true)
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
