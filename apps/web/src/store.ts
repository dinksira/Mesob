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
  /**
   * The note being typed into, by id, or null.
   *
   * Local, like the selection, and for the same reason plus one more: a note editor open
   * in this tab is a fact about this tab. Two people on one board must not be able to put
   * each other into text editing — a shared caret is not a thing the design has, and
   * making it one would be inventing a feature rather than building the one asked for.
   *
   * The id crosses this boundary rather than a store index for the reason the selection
   * does, and one more: the editor is opened by a shape that a remote update can delete,
   * and an index would by then be pointing at something else.
   */
  noteEditId: string | null

  setTool: (tool: Tool) => void
  setViewport: (viewport: Viewport) => void
  setSelection: (ids: string[]) => void
  setShapeCount: (count: number) => void
  setZoom: (zoom: number) => void
  setSync: (sync: SyncState) => void
  setHistory: (canUndo: boolean, canRedo: boolean) => void
  setNoteEditId: (id: string | null) => void
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
  noteEditId: null,

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
  setNoteEditId: (noteEditId) => {
    // Same reasoning as `setHistory`: the controller reports this on every pointer-down that
    // closes an editor, which is most of them.
    set((state) => (state.noteEditId === noteEditId ? state : { noteEditId }))
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
