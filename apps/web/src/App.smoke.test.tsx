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
        onNoteEditChange: () => {
          // The note editor is exercised through the DOM; this is not under test.
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

  /**
   * The three tools added after the first cut, driven through the real pointer path.
   *
   * `mountController` is the existing helper: real canvases, a real document, and the pointer
   * numbers the app receives. The numbers are screen coordinates, so a test that asserts world
   * values is also asserting the screen-to-world transform ran � the class of bug that a test
   * written in world units would pass straight over.
   */
  describe('line, pen and note tools', () => {
    /** Drag from one screen point to another, sampling the way a real pointer does. */
    function drag(
      controller: CanvasController,
      from: [number, number],
      to: [number, number],
      steps = 8,
    ): void {
      controller.pointerDown(from[0], from[1], 0)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        controller.pointerMove(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t)
      }
      controller.pointerUp()
    }

    /** The only shape on the board, or a thrown error naming what was expected. */
    function only(doc: Doc) {
      const shapes = readBoard(doc)
      if (shapes.length !== 1) throw new Error(`expected one shape, got ${String(shapes.length)}`)
      const shape = shapes[0]?.[1]
      if (!shape) throw new Error('no shape')
      return shape
    }

    it('draws a line whose endpoints are where the drag went', () => {
      const { controller, doc } = mountController('line')

      drag(controller, [100, 100], [300, 200])

      const shape = only(doc)
      expect(shape.type).toBe('line')
      if (shape.type !== 'line') throw new Error('expected a line')
      // Screen (100,100) on an 800x600 canvas at zoom 1 is world (-300,-200), and screen x
      // 300 is world x -100 — 100 is not the answer, it is the screen number.
      expect([shape.x1, shape.y1, shape.x2, shape.y2]).toEqual([-300, -200, -100, -100])
    })

    it('draws a line with no arrowhead, because the line tool is not the arrow tool', () => {
      // The design makes the head a property of the one primitive. A line that arrived with a
      // head would mean the flag defaults to true, and the arrow tool would then have nothing
      // to turn on.
      const { controller, doc } = mountController('line')
      drag(controller, [100, 100], [300, 200])
      const shape = only(doc)
      if (shape.type !== 'line') throw new Error('expected a line')
      expect(shape.head).toBe(false)
    })

    it('normalises a line dragged up and to the left, rather than storing negative extents', () => {
      const { controller, doc } = mountController('line')
      drag(controller, [300, 200], [100, 100])
      const shape = only(doc)
      if (shape.type !== 'line') throw new Error('expected a line')
      // The endpoints are stored as dragged, not reordered � a segment from A to B is the same
      // segment as B to A, and the arrowhead test is what depends on the order being kept.
      expect([shape.x1, shape.y1]).toEqual([-100, -100])
      expect([shape.x2, shape.y2]).toEqual([-300, -200])
      expect(shape.w).toBeGreaterThan(0)
      expect(shape.h).toBeGreaterThan(0)
    })

    it('makes no line from a click, because a zero-length line is not a line', () => {
      const { controller, doc } = mountController('line')
      controller.pointerDown(200, 200, 0)
      controller.pointerUp()
      expect(readBoard(doc)).toHaveLength(0)
    })

    it('selects the line it just drew, so it can be moved without a second click', () => {
      const { controller, doc, selectedIds } = mountController('line')
      drag(controller, [100, 100], [300, 200])
      expect(selectedIds()).toHaveLength(1)
      expect(selectedIds()[0]).toBe(readBoard(doc)[0]?.[0])
    })

    it('draws a pen stroke as one shape from the drag path', () => {
      const { controller, doc } = mountController('pen')

      // A curve, so the simplifier cannot collapse it to two points and the test would notice
      // if it did.
      controller.pointerDown(100, 300, 0)
      for (let i = 0; i <= 10; i++) {
        controller.pointerMove(100 + i * 20, 300 - Math.sin(i) * 60)
      }
      controller.pointerUp()

      const shape = only(doc)
      expect(shape.type).toBe('pen')
      if (shape.type !== 'pen') throw new Error('expected a pen')
      expect(shape.points.length).toBeGreaterThanOrEqual(4)
      expect(shape.points.length % 2).toBe(0)
    })

    it('writes a pen stroke once, on pointer-up, and not on every move', () => {
      // The design's exception to the live-drag rule is the pen, and the exception is paid for
      // by previewing on the overlay instead. If this were wrong the update log would carry
      // one entry per sample, and every peer would repaint the board per sample.
      const { controller, doc } = mountController('pen')
      const updates: number[] = []
      doc.on('update', () => updates.push(1))

      controller.pointerDown(100, 300, 0)
      for (let i = 0; i <= 10; i++) controller.pointerMove(100 + i * 20, 300)
      expect(updates).toHaveLength(0)

      controller.pointerUp()
      expect(updates).toHaveLength(1)
    })

    it('coalesces a pen stroke to far fewer points than it was sampled with', () => {
      // Eleven moves along a straight line: a real pen path. The stored stroke must be the two
      // endpoints, because eleven points describing a line is eleven points of document for a
      // shape with no detail in it.
      const { controller, doc } = mountController('pen')
      controller.pointerDown(100, 300, 0)
      for (let i = 0; i <= 10; i++) controller.pointerMove(100 + i * 20, 300)
      controller.pointerUp()
      const shape = only(doc)
      if (shape.type !== 'pen') throw new Error('expected a pen')
      expect(shape.points).toEqual([-300, 0, -100, 0])
    })

    it('commits a tap as a dot rather than nothing', () => {
      // A pen's one-point run has no extent, so it is committed as a duplicated point. The
      // alternative � ignoring a tap � loses the gesture a user makes when they want a point
      // on a map.
      const { controller, doc } = mountController('pen')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      const shape = only(doc)
      if (shape.type !== 'pen') throw new Error('expected a pen')
      expect(shape.points).toEqual([0, 0, 0, 0])
    })

    it('draws a note from a drag, with the dragged size', () => {
      const { controller, doc } = mountController('note')
      drag(controller, [100, 100], [300, 260])
      const shape = only(doc)
      expect(shape.type).toBe('note')
      if (shape.type !== 'note') throw new Error('expected a note')
      expect([shape.x, shape.y, shape.w, shape.h]).toEqual([-300, -200, 200, 160])
      expect(shape.text).toBe('')
    })

    it('draws a default-sized note from a click, anchored at the pointer', () => {
      // A note is made by clicking more often than by dragging, so this is the common case and
      // the one that has to work. Anchored rather than at the origin: a note the user cannot
      // see is a note they will make again.
      const { controller, doc } = mountController('note')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      const shape = only(doc)
      if (shape.type !== 'note') throw new Error('expected a note')
      expect(shape.x).toBe(0)
      expect(shape.y).toBe(0)
      expect(shape.w).toBeGreaterThan(0)
      expect(shape.h).toBeGreaterThan(0)
    })

    it('opens the note it just created for editing', () => {
      const { controller } = mountController('note')
      let editing: string | null = null
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      // The controller reports the session through the callback the app renders from.
      const reported = controller.noteEditId
      expect(reported).not.toBeNull()
      editing = reported
      expect(editing).not.toBeNull()
    })

    it('writes note text into the document, one write per change', () => {
      const { controller, doc } = mountController('note')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      const updates: number[] = []
      doc.on('update', () => updates.push(1))

      controller.setNoteText('Hello')

      expect(updates).toHaveLength(1)
      const shape = only(doc)
      if (shape.type !== 'note') throw new Error('expected a note')
      expect(shape.text).toBe('Hello')
    })

    it('refuses to edit something that is not a note', () => {
      // The id comes from a selection or a previous creation, and between the two a shape can
      // be undone away. Putting a caret in a rectangle would be a text field with nothing to
      // write to.
      const { controller, doc } = mountController('rect')
      drag(controller, [100, 100], [200, 200])
      const id = readBoard(doc)[0]?.[0] ?? ''
      expect(controller.beginNoteEdit(id)).toBe(false)
      expect(controller.noteEditId).toBeNull()
    })

    it('refuses to edit a note that is not there', () => {
      const { controller } = mountController('note')
      expect(controller.beginNoteEdit('shp_nothing')).toBe(false)
    })

    it('closes the editor when the note is deleted, rather than typing into nothing', () => {
      const { controller, doc } = mountController('note')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      expect(controller.noteEditId).not.toBeNull()

      controller.key('Delete', false)

      expect(controller.noteEditId).toBeNull()
      expect(readBoard(doc)).toHaveLength(0)
    })

    it('closes the editor when a note is undone away', () => {
      // Same hazard, a different path: the note is still in the document and still has its
      // text, but it is no longer the shape the user was editing.
      const { controller, doc } = mountController('note')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      expect(controller.noteEditId).not.toBeNull()

      controller.undoStep()
      controller.refresh()

      expect(controller.noteEditId).toBeNull()
      expect(readBoard(doc)).toHaveLength(0)
    })

    it('closes the editor when the tool changes, so a stray keystroke has nowhere to go', () => {
      const { controller } = mountController('note')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      expect(controller.noteEditId).not.toBeNull()

      controller.setTool('select')

      expect(controller.noteEditId).toBeNull()
    })

    it('closes the editor on a pointer-down on the board', () => {
      // The editor is a DOM element above the canvas, so a click inside the note never gets
      // here. A click anywhere else is the user saying they are done.
      const { controller } = mountController('note')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      controller.setTool('select')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()

      controller.setTool('note')
      controller.pointerDown(200, 200, 0)
      controller.pointerUp()
      expect(controller.noteEditId).not.toBeNull()

      controller.setTool('select')
      controller.pointerDown(700, 500, 0)
      expect(controller.noteEditId).toBeNull()
    })

    it('edits a selected note on Enter, and Escape closes it before the selection', () => {
      // Enter is the only keyboard route to a note's text, and it has to work without a mouse
      // � a note that can only be typed into by clicking is a note some users cannot use.
      const { controller, doc, selectedIds } = mountController('note')
      controller.pointerDown(400, 300, 0)
      controller.pointerUp()
      controller.setTool('select')
      const id = readBoard(doc)[0]?.[0] ?? ''
      expect(selectedIds()).toEqual([id])

      expect(controller.key('Enter', false)).toBe(true)
      expect(controller.noteEditId).toBe(id)

      expect(controller.key('Escape', false)).toBe(true)
      expect(controller.noteEditId).toBeNull()
      // Escape stopped at the editor: the selection is still there, so a second Escape is what
      // clears it. A user pressing Escape twice should not lose their work in between.
      expect(selectedIds()).toEqual([id])
    })

    it('does not edit on Enter when several shapes are selected', () => {
      // With more than one shape there is no single note to put a caret in, and picking the
      // first would be a guess. Two notes, not one: a single shape is the case above, and
      // reusing it here would assert nothing.
      const { controller, doc } = mountController('note')
      controller.pointerDown(200, 200, 0)
      controller.pointerUp()
      controller.pointerDown(600, 400, 0)
      controller.pointerUp()
      expect(readBoard(doc)).toHaveLength(2)

      // A click selects one shape and replaces the selection, so two notes are selected with
      // a marquee rather than a second click. Dragged from empty canvas across both.
      controller.setTool('select')
      controller.pointerDown(100, 100, 0)
      controller.pointerMove(500, 300)
      controller.pointerMove(800, 600)
      controller.pointerUp()
      expect(controller.selectedIds).toHaveLength(2)

      expect(controller.key('Enter', false)).toBe(false)
      expect(controller.noteEditId).toBeNull()
    })

    it('moves a line by its endpoints, because a derived box is not a position', () => {
      // The case a `set x` / `set y` move gets wrong: the shape is selected, dragged, and stays
      // exactly where it was, because its box is derived from the geometry nothing read.
      const { controller, doc } = mountController('line')
      drag(controller, [100, 100], [300, 200])
      const line = only(doc)
      if (line.type !== 'line') throw new Error('expected a line')

      controller.setTool('select')
      controller.pointerDown(200, 150, 0)
      controller.pointerMove(250, 200)
      controller.pointerUp()

      const moved = only(doc)
      if (moved.type !== 'line') throw new Error('expected a line')
      expect(moved.x1).toBe(line.x1 + 50)
      expect(moved.y1).toBe(line.y1 + 50)
      expect(moved.x2).toBe(line.x2 + 50)
      expect(moved.y2).toBe(line.y2 + 50)
    })

    it('moves a pen by its points', () => {
      const { controller, doc } = mountController('pen')
      controller.pointerDown(100, 300, 0)
      controller.pointerMove(300, 300)
      controller.pointerUp()
      const pen = only(doc)
      if (pen.type !== 'pen') throw new Error('expected a pen')

      controller.setTool('select')
      controller.pointerDown(200, 300, 0)
      controller.pointerMove(200, 350)
      controller.pointerUp()

      const moved = only(doc)
      if (moved.type !== 'pen') throw new Error('expected a pen')
      expect(moved.points).toEqual(pen.points.map((v, k) => (k % 2 === 1 ? v + 50 : v)))
    })

    it('selects a note under the pointer, and a line by its own path', () => {
      // Hit testing is the thing that decides whether a click reaches the shape or falls
      // through to the board, and it is different per type. A note is a box and is hit inside
      // it; a line is only hit near the line itself, so clicking the middle of a line's
      // bounding box must not select it — that is a box the user cannot see being clicked.
      const note = mountController('note')
      note.controller.pointerDown(400, 300, 0)
      note.controller.pointerUp()
      note.controller.setTool('select')
      note.controller.pointerDown(450, 350, 0)
      expect(note.selectedIds()).toHaveLength(1)
      expect(note.selectedIds()[0]).toBe(readBoard(note.doc)[0]?.[0])

      const line = mountController('line')
      line.controller.pointerDown(100, 300, 0)
      line.controller.pointerMove(500, 300)
      line.controller.pointerUp()
      line.controller.setTool('select')
      // On the line itself: the drag ran along y=300, so (300,300) is on it.
      line.controller.pointerDown(300, 300, 0)
      expect(line.selectedIds()).toHaveLength(1)
      // Inside the line's bounding box but 100px above the line. The hit test forgives a few
      // pixels, not a hundred — clicking a line's empty box would select a shape the user
      // cannot see the edge of.
      line.controller.pointerDown(300, 200, 0)
      expect(line.selectedIds()).toHaveLength(0)
    })

    it('deletes a line, a pen and a note with the same keystroke as any other shape', () => {
      for (const tool of ['line', 'pen', 'note'] as const) {
        const { controller, doc } = mountController(tool)
        controller.pointerDown(100, 100, 0)
        controller.pointerMove(300, 200)
        controller.pointerUp()
        expect(readBoard(doc)).toHaveLength(1)
        controller.key('Delete', false)
        expect(readBoard(doc)).toHaveLength(0)
      }
    })
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

  it('renders every tool enabled, with the rectangle tool pressed', () => {
    const { container } = render(<App />)

    const pressed = [...container.querySelectorAll('button[aria-pressed="true"]')]
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.getAttribute('title')).toContain('Rectangle')

    // Phase 1's six tools are all built, so none may be disabled. This is the assertion that
    // would have caught a tool being left in the table's `available: false` from when it was
    // a placeholder: a button that looks like a tool and is not one is a lie in the
    // affordance, and this is where it is cheapest to notice.
    //
    // `aria-pressed` rather than `class="tool"` for the set, because undo and redo share the
    // `tool` class for their chrome and are not tools. They are the two buttons that can be
    // legitimately disabled, which is exactly why this query has to exclude them.
    const tools = [...container.querySelectorAll('button.tool[aria-pressed]')].map(
      (b) => b.getAttribute('title') ?? '',
    )
    expect(tools).toHaveLength(6)
    const disabled = [...container.querySelectorAll('button.tool[aria-pressed]:disabled')]
    expect(disabled).toHaveLength(0)
    for (const label of ['Select', 'Rectangle', 'Ellipse', 'Line', 'Pen', 'Note']) {
      expect(tools.some((t) => t.startsWith(label))).toBe(true)
    }

    // The letter in the title is the letter that selects it, from one table. A tool with no
    // shortcut would be reachable only by a pointer.
    for (const [label, key] of [
      ['Select', 'V'],
      ['Rectangle', 'R'],
      ['Ellipse', 'O'],
      ['Line', 'L'],
      ['Pen', 'P'],
      ['Note', 'N'],
    ] as const) {
      expect(tools.some((t) => t.startsWith(label) && t.includes(`(${key})`))).toBe(true)
    }
  })

  it('docks the toolbar over the board, inside the stage that positions it', () => {
    const { container } = render(<App />)

    // The pill is absolutely positioned against `.stage`, so a toolbar hoisted back out to a
    // sibling of the stage — where it used to live, as a 44px flex column — would resolve
    // against nothing and drop to the top-left of the viewport. Structure is all happy-dom
    // can see, so this asserts the hook the stylesheet depends on rather than the geometry.
    const stage = container.querySelector('.stage')
    const toolbar = container.querySelector('.toolbar')
    expect(stage?.contains(toolbar)).toBe(true)

    // The strip is what makes a hidden pill hoverable. Without it there is no hover target
    // at all, and the toolbar is unreachable by pointer as well as by keyboard.
    const dock = container.querySelector('.toolbar-dock')
    expect(dock?.contains(container.querySelector('.toolbar-dock-strip'))).toBe(true)

    // The handle is the discoverability affordance, and it must be a sibling that comes after
    // the pill: the stylesheet widens it from `.toolbar:focus-within + .toolbar-handle`, which
    // is an adjacent-sibling selector and silently stops matching if the order ever flips.
    const handle = container.querySelector('.toolbar-handle')
    expect(handle).not.toBeNull()
    expect(handle?.previousElementSibling?.className).toBe('toolbar')
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
