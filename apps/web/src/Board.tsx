import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { Doc } from 'yjs'
import { ShapeStore } from '@mesob/web-geometry'
import { CanvasController } from './canvas-controller.js'
import { NoteEditor } from './NoteEditor.js'
import { boardState, useBoardStore } from './store.js'

/**
 * The three-canvas stack.
 *
 * Three canvases, one job each, and the reason is not tidiness. Selection and presence
 * change on every pointer move while the board does not, so putting them on the board
 * canvas means repainting every shape at 60fps to move a selection box. Three layers mean
 * the expensive one is only repainted when the document or the camera changes.
 *
 * This component owns no drawing code and no application state. It creates the
 * controller, hands it the canvases and the document, forwards DOM events, and reports
 * what the controller did into the store.
 *
 * The controller is created once and kept in a ref: rebuilding it on a React render would
 * drop the selection, the undo manager and the frame loop, and React re-renders on every
 * selection change.
 */
export function Board({
  doc,
  onReady,
}: {
  doc: Doc
  onReady: (controller: CanvasController | null) => void
}) {
  const boardRef = useRef<HTMLCanvasElement | null>(null)
  const presenceRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const controllerRef = useRef<CanvasController | null>(null)

  // `onReady` is a prop and therefore a new function on every parent render. Held in a
  // ref so it can be called from the mount effect without making that effect depend on
  // the parent re-rendering, which would tear the controller down and build it again.
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    const board = boardRef.current
    const presence = presenceRef.current
    const overlay = overlayRef.current
    if (!board || !presence || !overlay) return

    const state = boardState()
    const store = new ShapeStore()

    // A holder rather than a `const controller`, because the callbacks below are invoked
    // from inside the constructor: it fills the store on the way in, which reports the
    // shape count, which calls back in here. A `const controller = new CanvasController(`
    // would have that callback read a binding still in its temporal dead zone, and the
    // app would white-screen on the very first frame.
    const handle = { controller: null as CanvasController | null }
    const reportHistory = () => {
      state.setHistory(handle.controller?.canUndo ?? false, handle.controller?.canRedo ?? false)
    }

    const controller = new CanvasController(board, presence, overlay, doc, store, {
      onSelectionChange: (ids) => {
        state.setSelection(ids)
        reportHistory()
      },
      onShapeCountChange: (count) => {
        state.setShapeCount(count)
        reportHistory()
      },
      onNoteEditChange: (id) => {
        state.setNoteEditId(id)
      },
    })
    handle.controller = controller
    controllerRef.current = controller
    setController(controller)
    controller.setTool(state.tool)
    controller.start()
    readyRef.current(controller)

    const resize = () => {
      const parent = board.parentElement
      if (!parent) return
      controller.resize(parent.clientWidth, parent.clientHeight, window.devicePixelRatio)
      boardState().setZoom(controller.zoom)
    }
    resize()

    // A ResizeObserver rather than a window resize listener: the board's box changes when
    // the toolbar or a panel changes, not only when the window does.
    const observer = new ResizeObserver(resize)
    if (board.parentElement) observer.observe(board.parentElement)
    window.addEventListener('resize', resize)

    // The document can change underneath us — undo, a restore from storage, a second tab.
    // The controller's refresh re-projects the store and remaps the selection by id, so an
    // undo that changes the shape set cannot leave the selection pointing at another shape.
    const onUpdate = () => {
      controller.refresh()
      state.setHistory(controller.canUndo, controller.canRedo)
    }
    doc.on('update', onUpdate)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      doc.off('update', onUpdate)
      controller.stop()
      controllerRef.current = null
      readyRef.current(null)
    }
  }, [doc])

  // The tool is a subscription, not a prop. The controller is told about it rather than
  // reading the store itself so the dependency is visible here, and so a test can drive a
  // controller without a store in scope.
  const tool = useBoardStore((s) => s.tool)
  useEffect(() => {
    controllerRef.current?.setTool(tool)
  }, [tool])

  // The note editor. The id is a subscription because the controller opens and closes the
  // session from inside pointer handlers; the controller is state rather than a ref because
  // it has to reach the rendered editor, and a ref read during render would be reading
  // something React cannot see change.
  const noteEditId = useBoardStore((s) => s.noteEditId)
  const [controller, setController] = useState<CanvasController | null>(null)

  const point = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }, [])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      const p = point(event)
      controllerRef.current?.pointerDown(p.x, p.y, event.button)
    },
    [point],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const p = point(event)
      controllerRef.current?.pointerMove(p.x, p.y)
    },
    [point],
  )

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    controllerRef.current?.pointerUp()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const onWheel = useCallback((event: ReactWheelEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const controller = controllerRef.current
    if (!controller) return
    controller.wheel(event.deltaY, event.clientX - rect.left, event.clientY - rect.top)
    boardState().setZoom(controller.zoom)
  }, [])

  // Keyboard lives on the canvas, not the window: the canvas is a focusable application
  // surface and the shortcuts belong to it once it has focus.
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const controller = controllerRef.current
    if (!controller) return
    if (controller.key(event.key, event.shiftKey)) event.preventDefault()
  }, [])

  // The pointer handlers are on the *bottom* layer. The overlay is above it and is
  // focusable and transparent, so a canvas that is not `pointer-events: none` would take
  // every event and the board would feel dead. The overlay keeps its tab stop and its
  // role; it just does not intercept the mouse.
  return (
    <div className="board">
      <canvas
        ref={boardRef}
        className="layer"
        data-layer="board"
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      />
      <canvas ref={presenceRef} className="layer" data-layer="presence" aria-hidden="true" />
      <canvas
        ref={overlayRef}
        className="layer"
        data-layer="overlay"
        role="application"
        tabIndex={0}
        aria-label="Board canvas. Arrow keys move the selection, Delete removes it, Z undoes."
        onKeyDown={onKeyDown}
      />
      {controller !== null && noteEditId !== null ? (
        <NoteEditor controller={controller} noteId={noteEditId} />
      ) : null}
    </div>
  )
}
