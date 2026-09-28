import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { Doc } from 'yjs'
import { ShapeStore } from '@mesob/web-geometry'
import { CanvasController, type Tool } from './canvas-controller.js'

export interface BoardProps {
  doc: Doc
  tool: Tool
  // Declared as property signatures rather than method signatures. A method signature is
  // a declaration of something that can be called with a receiver, and these callbacks are
  // stored in a plain object and invoked detached, so the arrow type is the honest one:
  // it says there is no receiver to get wrong.
  onSelectionChange: (ids: string[]) => void
  onShapeCountChange: (count: number) => void
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void
  onZoomChange: (zoom: number) => void
  /**
   * Hand the controller up once it exists.
   *
   * The toolbar's undo and redo buttons live outside the canvas, but undo is a property of
   * the document's UndoManager, which the controller owns. Dispatching a synthetic keydown
   * at `window` to reach it is the kind of indirection that silently stops working the
   * moment the handler moves; passing the controller up is one line and cannot.
   */
  onReady: (controller: CanvasController | null) => void
}

/**
 * The three-canvas stack.
 *
 * Three canvases, one job each, and the reason is not tidiness. Selection and presence
 * change every pointer move while the board does not, so putting them on the board canvas
 * means repainting every shape at 60fps to move a selection box. Three layers mean the
 * expensive one is only repainted when the document or the camera changes.
 *
 * This component owns no drawing code. It creates the controller, hands it the canvases
 * and the document, and forwards DOM events. The controller is created once and kept in a
 * ref: rebuilding it on a React render would drop the selection, the undo manager and the
 * frame loop, and React re-renders on every selection change.
 */
export function Board({
  doc,
  tool,
  onSelectionChange,
  onShapeCountChange,
  onHistoryChange,
  onZoomChange,
  onReady,
}: BoardProps) {
  const boardRef = useRef<HTMLCanvasElement | null>(null)
  const presenceRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const controllerRef = useRef<CanvasController | null>(null)
  const storeRef = useRef<ShapeStore | null>(null)

  // Callbacks change identity every render. Holding them in a ref keeps the controller
  // from having to be rebuilt just because a parent re-rendered.
  const handlers = useRef({
    onSelectionChange,
    onShapeCountChange,
    onHistoryChange,
    onZoomChange,
    onReady,
  })
  handlers.current = {
    onSelectionChange,
    onShapeCountChange,
    onHistoryChange,
    onZoomChange,
    onReady,
  }

  useEffect(() => {
    const board = boardRef.current
    const presence = presenceRef.current
    const overlay = overlayRef.current
    if (!board || !presence || !overlay) return

    const store = new ShapeStore()
    storeRef.current = store

    const controller = new CanvasController(board, presence, overlay, doc, store, {
      onSelectionChange: (ids) => {
        handlers.current.onSelectionChange(ids)
        handlers.current.onHistoryChange(controller.canUndo, controller.canRedo)
      },
      onShapeCountChange: (count) => {
        handlers.current.onShapeCountChange(count)
        handlers.current.onHistoryChange(controller.canUndo, controller.canRedo)
      },
    })
    controllerRef.current = controller
    controller.start()
    handlers.current.onReady(controller)

    const resize = () => {
      const parent = board.parentElement
      if (!parent) return
      controller.resize(parent.clientWidth, parent.clientHeight, window.devicePixelRatio)
      handlers.current.onZoomChange(controller.zoom)
    }
    resize()

    // A ResizeObserver rather than a window resize listener: the board's box changes when
    // the toolbar or a panel changes, not only when the window does.
    const observer = new ResizeObserver(resize)
    if (board.parentElement) observer.observe(board.parentElement)
    window.addEventListener('resize', resize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      controller.stop()
      controllerRef.current = null
      handlers.current.onReady(null)
    }
  }, [doc])

  useEffect(() => {
    controllerRef.current?.setTool(tool)
  }, [tool])

  // The document can change underneath us — undo, a restore from storage, a second tab.
  // The controller's refresh re-projects the store and remaps the selection by id, so an
  // undo of a z-affecting change cannot leave the selection pointing at a different shape.
  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return
    const onUpdate = () => {
      controller.refresh()
      handlers.current.onHistoryChange(controller.canUndo, controller.canRedo)
    }
    doc.on('update', onUpdate)
    return () => {
      doc.off('update', onUpdate)
    }
  }, [doc])

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
    controllerRef.current?.wheel(event.deltaY, event.clientX - rect.left, event.clientY - rect.top)
    const controller = controllerRef.current
    if (controller) handlers.current.onZoomChange(controller.zoom)
  }, [])

  // Keyboard lives on the canvas, not the window: the canvas is a focusable application
  // surface and the shortcuts belong to it once it has focus.
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const controller = controllerRef.current
    if (!controller) return
    if (controller.key(event.key, event.shiftKey)) event.preventDefault()
  }, [])

  // The pointer handlers are on the *bottom* layer. The overlay is above it and is focusable
  // and transparent, so a canvas that is not `pointer-events: none` would take every event
  // and the board would feel dead. The overlay keeps its tab stop and its role; it just
  // does not intercept the mouse.
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
    </div>
  )
}
