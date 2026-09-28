import { useCallback, useEffect, useRef, useState } from 'react'
import { Doc } from 'yjs'
import { Board } from './Board.js'
import { Toolbar } from './Toolbar.js'
import { EmptyState, SyncIndicator } from './Chrome.js'
import type { CanvasController, Tool } from './canvas-controller.js'

const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  pen: 'Pen',
  note: 'Note',
}

/**
 * The application shell.
 *
 * Holds the document, the tool, and the little state the chrome needs to render. The
 * design calls for Zustand to own local state; that is not installed and the registry is
 * unreachable from this environment, so this is `useState` for now. It is a deliberate
 * stand-in, not a decision that React state is the right home for it: the tool and
 * selection are UI state and never touch the document, which is the property the store
 * has to preserve whichever library ends up holding them.
 */
export function App() {
  const [doc] = useState(() => new Doc())
  const [tool, setTool] = useState<Tool>('rect')
  const [shapeCount, setShapeCount] = useState(0)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [selection, setSelection] = useState<string[]>([])
  const controllerRef = useRef<CanvasController | null>(null)

  // Nothing persists yet. y-indexeddb is not installed, so the honest state is
  // 'unavailable' rather than a green dot that lies: a dot saying 'saved to this device'
  // when the device has no copy is worse than no dot.
  const syncState = 'unavailable' as const

  const onUndo = useCallback(() => {
    const controller = controllerRef.current
    if (!controller) return
    controller.undoStep()
    setCanUndo(controller.canUndo)
    setCanRedo(controller.canRedo)
  }, [])

  const onRedo = useCallback(() => {
    const controller = controllerRef.current
    if (!controller) return
    controller.redoStep()
    setCanUndo(controller.canUndo)
    setCanRedo(controller.canRedo)
  }, [])

  // Tool shortcuts. Bound at the window because the toolbar buttons are not focused when a
  // user reaches for the keyboard, and a shortcut that needs a click first is not one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT'))
        return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'v') setTool('select')
      if (key === 'r') setTool('rect')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div className="app">
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
      />
      <div className="stage">
        <Board
          doc={doc}
          tool={tool}
          onSelectionChange={setSelection}
          onShapeCountChange={setShapeCount}
          onHistoryChange={(u, r) => {
            setCanUndo(u)
            setCanRedo(r)
          }}
          onZoomChange={setZoom}
          onReady={(controller) => {
            controllerRef.current = controller
          }}
        />
        {shapeCount === 0 && <EmptyState toolLabel={TOOL_LABELS[tool]} />}
        <div className="cluster">
          <span className="board-name">Untitled board</span>
          <SyncIndicator state={syncState} shapeCount={shapeCount} />
        </div>
        <p className="status" role="status" aria-live="polite">
          {selection.length > 0
            ? `${String(selection.length)} selected`
            : `${String(shapeCount)} shapes · ${String(Math.round(zoom * 100))}%`}
        </p>
      </div>
    </div>
  )
}
