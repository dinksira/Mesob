import { useCallback, useEffect, useRef, useState } from 'react'
import { Doc } from 'yjs'
import { Board } from './Board.js'
import { Toolbar } from './Toolbar.js'
import { EmptyState, SyncIndicator } from './Chrome.js'
import { persistLocally } from './persistence.js'
import { useBoardStore } from './store.js'
import type { CanvasController } from './canvas-controller.js'

const TOOL_LABELS = {
  select: 'Select',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  pen: 'Pen',
  note: 'Note',
} as const

/**
 * The application shell.
 *
 * Owns the document and nothing else. The document is the single shared state, so it is
 * created once and passed down; everything else is local state in the Zustand store, read
 * by the chrome through a selector. That is the split the design calls for, and it is
 * what keeps a 60fps camera from re-rendering a tree that does not draw it.
 */
export function App() {
  const [doc] = useState(() => new Doc())
  const tool = useBoardStore((s) => s.tool)
  const setTool = useBoardStore((s) => s.setTool)
  const shapeCount = useBoardStore((s) => s.shapeCount)
  const selection = useBoardStore((s) => s.selection)
  const zoom = useBoardStore((s) => s.zoom)
  const sync = useBoardStore((s) => s.sync)
  const canUndo = useBoardStore((s) => s.canUndo)
  const canRedo = useBoardStore((s) => s.canRedo)
  const controllerRef = useRef<CanvasController | null>(null)

  // Persistence starts with the document and is torn down with the app. IndexedDB keeps
  // the copy; the sync indicator says whether it actually managed to.
  useEffect(() => {
    const persistence = persistLocally(doc)
    return () => {
      void persistence.destroy()
    }
  }, [doc])

  const onUndo = useCallback(() => {
    const controller = controllerRef.current
    if (!controller) return
    controller.undoStep()
    const state = useBoardStore.getState()
    state.setHistory(controller.canUndo, controller.canRedo)
  }, [])

  const onRedo = useCallback(() => {
    const controller = controllerRef.current
    if (!controller) return
    controller.redoStep()
    const state = useBoardStore.getState()
    state.setHistory(controller.canUndo, controller.canRedo)
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
          onReady={(controller) => {
            controllerRef.current = controller
          }}
        />
        {shapeCount === 0 && <EmptyState toolLabel={TOOL_LABELS[tool]} />}
        <div className="cluster">
          <span className="board-name">Untitled board</span>
          <SyncIndicator state={sync} shapeCount={shapeCount} />
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
