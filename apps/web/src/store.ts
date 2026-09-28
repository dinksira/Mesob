import { create } from 'zustand'
import type { Viewport } from '@mesob/schema'
import type { Tool } from './canvas-controller.js'
import type { SyncState } from './Chrome.js'

/**
 * Local state. Never the document.
 *
 * The rule this store exists to keep is the one the design states: shared state
 * lives in the Y.Doc, local state lives here. The line is drawn by ownership, not by
 * kind — a camera is local and a shape is shared, and neither belongs in the other's
 * place. Putting the camera in the document would make every pan a network event, and
 * putting shapes in this store would make them unfreeable by anything but this tab.
 *
 * Zustand rather than context because a context value is a new object on every render
 * and every consumer re-renders with it. The camera here changes on every wheel event,
 * so a context would re-render the whole tree on scroll.
 *
 * This store deliberately does not hold the selection *indices*. Those are a property of
 * the controller's interaction state and are meaningless to anything that has not
 * rebuilt the store's z order, so what crosses this boundary is the shape ids, which are
 * stable.
 */
export interface BoardStore {
  tool: Tool
  viewport: Viewport
  selection: string[]
  shapeCount: number
  zoom: number
  sync: SyncState
  canUndo: boolean
  canRedo: boolean

  setTool: (tool: Tool) => void
  setViewport: (viewport: Viewport) => void
  setSelection: (ids: string[]) => void
  setShapeCount: (count: number) => void
  setZoom: (zoom: number) => void
  setSync: (sync: SyncState) => void
  setHistory: (canUndo: boolean, canRedo: boolean) => void
}

export const useBoardStore = create<BoardStore>((set) => ({
  tool: 'rect',
  viewport: { cameraX: 0, cameraY: 0, zoom: 1 },
  selection: [],
  shapeCount: 0,
  zoom: 1,
  sync: 'unavailable',
  canUndo: false,
  canRedo: false,

  setTool: (tool) => {
    set({ tool })
  },
  setViewport: (viewport) => {
    set({ viewport })
  },
  setSelection: (selection) => {
    set({ selection })
  },
  setShapeCount: (shapeCount) => {
    set({ shapeCount })
  },
  setZoom: (zoom) => {
    set({ zoom })
  },
  setSync: (sync) => {
    set({ sync })
  },
  // Compared before writing, because the controller reports history after every
  // document update. Two boolean flags are not worth a render, and an update that
  // changed neither would otherwise re-render both toolbar buttons for nothing.
  setHistory: (canUndo, canRedo) => {
    set((state) =>
      state.canUndo === canUndo && state.canRedo === canRedo ? state : { canUndo, canRedo },
    )
  },
}))

/**
 * A non-reactive read, for the frame loop and event handlers.
 *
 * `getState` instead of the hook so a pointer handler can read the current tool without
 * subscribing, and without taking a dependency that would make the controller rebuild
 * whenever the tool changed.
 */
export const boardState = (): BoardStore => useBoardStore.getState()
