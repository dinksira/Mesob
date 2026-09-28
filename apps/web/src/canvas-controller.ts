/**
 * The board's frame loop and pointer handling.
 *
 * Framework-free on purpose. React owns the elements and this owns the pixels, so the
 * parts with arithmetic in them can be exercised without a DOM and the components stay
 * declarations. 03 §4: canvas-drawing code is not React and is called from the render
 * loop, not from a component body.
 *
 * ## The one rule about writing to the document
 *
 * A drag writes nothing until the pointer comes up. Every move would otherwise be its own
 * transaction, and the UndoManager would step back through a hundred one-pixel nudges
 * instead of one move. So a drag keeps its offset here, the draw pass applies it, and the
 * document hears about it once, on pointer-up.
 */

import type { ShapeStore } from '@mesob/web-geometry'
import { BoardRenderer, hitHandle } from '@mesob/web-geometry'
import {
  createEllipseShape,
  createRectShape,
  createViewport,
  isBoxedShape,
  screenToWorld,
  shapesMap,
  toTransform,
  zoomAt,
  clampDevicePixelRatio,
  type CreateShapeParams,
  type ShapeMap,
  type Viewport,
  type ViewportTransform,
} from '@mesob/schema'
import type { Doc } from 'yjs'
import { UndoManager } from 'yjs'

export type Tool = 'select' | 'rect' | 'ellipse' | 'line' | 'pen' | 'note'

/**
 * The creator for each tool that draws a shape, and absent for the tools that do not.
 *
 * A keyed table rather than an `if` in each of the two places that need to know. Those
 * two are pointer-down, which decides whether a drag is a draw, and pointer-up, which
 * creates the shape; if they disagreed, a drag would either do nothing or create a shape
 * nobody asked for, and only one of the two would be covered by a test. A tool with no
 * entry here is a tool that cannot draw, which is what makes the next drawable type one
 * line rather than an edit in two branches.
 *
 * Only types described by a box can appear. `line` and `pen` are not, and adding them
 * means giving them an entry that does not fit this signature.
 */
const DRAWERS: Partial<Record<Tool, (doc: Doc, params: CreateShapeParams) => ShapeMap>> = {
  rect: createRectShape,
  ellipse: createEllipseShape,
}

export type Interaction =
  | { kind: 'idle' }
  | { kind: 'draw'; originX: number; originY: number; x: number; y: number; w: number; h: number }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; handle: number; shape: number; x: number; y: number; w: number; h: number }
  | { kind: 'marquee'; x: number; y: number; w: number; h: number }
  | { kind: 'pan'; dx: number; dy: number }

const HANDLE_CURSORS = [
  'nwse-resize',
  'nesw-resize',
  'nwse-resize',
  'nesw-resize',
  'ns-resize',
  'ew-resize',
  'ns-resize',
  'ew-resize',
]

/** Yjs origin for edits the user made, so undo ignores anything else. */
export const LOCAL_ORIGIN = 'local'

const COLORS = {
  substrate: '#faf7f2',
  selection: '#5b3a52',
  handleFill: '#faf7f2',
  presence: '#b8463a',
}

export interface BoardCallbacks {
  onSelectionChange(ids: string[]): void
  onShapeCountChange(count: number): void
}

export class CanvasController {
  readonly store: ShapeStore
  private renderer: BoardRenderer
  private viewport: Viewport
  private transform: ViewportTransform
  private interaction: Interaction = { kind: 'idle' }
  private selected: number[] = []
  /**
   * The one selected shape, or -1.
   *
   * Kept alongside the array because "the selection is exactly one shape" is asked on
   * every pointer move, and reaching into `selected[0]` under `noUncheckedIndexedAccess`
   * would mean a non-null assertion or a branch in the move path for a value that is
   * either -1 or a valid index by construction.
   */
  private primary = -1
  private undo: UndoManager
  private frame = 0
  private disposed = false
  private activeTool: Tool = 'rect'
  private handle = -1
  private cursor = 'crosshair'
  private scratch = { x: 0, y: 0 }
  private scratchRect: number[] = []
  private size = { width: 0, height: 0 }
  private dpr = 1
  /** Pointer-down position for a move, so the drag is measured from where it started. */
  private moveOriginX = 0
  private moveOriginY = 0

  private board: HTMLCanvasElement
  private presence: HTMLCanvasElement
  private overlay: HTMLCanvasElement
  private doc: Doc
  private callbacks: BoardCallbacks

  constructor(
    board: HTMLCanvasElement,
    presence: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    doc: Doc,
    store: ShapeStore,
    callbacks: BoardCallbacks,
  ) {
    this.board = board
    this.presence = presence
    this.overlay = overlay
    this.doc = doc
    this.callbacks = callbacks
    this.store = store
    this.renderer = new BoardRenderer(store)
    this.viewport = createViewport()
    this.transform = toTransform(this.viewport, this.size, 1)
    this.undo = new UndoManager(shapesMap(doc), {
      captureTimeout: 300,
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    })
    this.store.observe(() => {
      this.transform = toTransform(this.viewport, this.size, this.dpr)
      this.callbacks.onShapeCountChange(this.store.size)
    })
    this.store.refill(doc)
  }

  get tool(): Tool {
    return this.activeTool
  }

  get selectedIds(): string[] {
    return this.selected.map((i) => this.store.idAt(i) ?? '').filter((id) => id !== '')
  }

  get canUndo(): boolean {
    return this.undo.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.undo.redoStack.length > 0
  }

  get zoom(): number {
    return this.viewport.zoom
  }

  get cursorStyle(): string {
    return this.cursor
  }

  setTool(tool: Tool): void {
    this.activeTool = tool
    this.cursor = tool === 'select' ? 'default' : 'crosshair'
  }

  undoStep(): void {
    this.undo.undo()
  }

  redoStep(): void {
    this.undo.redo()
  }

  /** Size the backing stores and recompute the transform. */
  resize(width: number, height: number, dpr: number): void {
    this.size = { width, height }
    this.dpr = clampDevicePixelRatio(dpr)
    for (const canvas of [this.board, this.presence, this.overlay]) {
      canvas.width = Math.max(1, Math.round(width * this.dpr))
      canvas.height = Math.max(1, Math.round(height * this.dpr))
      canvas.style.width = `${String(width)}px`
      canvas.style.height = `${String(height)}px`
    }
    this.transform = toTransform(this.viewport, this.size, this.dpr)
    this.invalidate()
  }

  start(): void {
    if (this.frame !== 0) return
    const loop = () => {
      if (this.disposed) return
      this.draw()
      this.frame = requestAnimationFrame(loop)
    }
    this.frame = requestAnimationFrame(loop)
  }

  stop(): void {
    this.disposed = true
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  /** Ask for a redraw. The loop is already running, so this only marks it. */
  invalidate(): void {
    // Drawing happens on the next frame; nothing to do but let the loop notice.
  }

  private context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    return ctx
  }

  private draw(): void {
    const board = this.context(this.board)
    if (board) this.renderer.drawBoard(board, this.transform, { background: COLORS.substrate })

    const presence = this.context(this.presence)
    if (presence) presence.clearRect(0, 0, this.size.width, this.size.height)

    const overlay = this.context(this.overlay)
    if (!overlay) return
    overlay.clearRect(0, 0, this.size.width, this.size.height)

    const dx = this.interaction.kind === 'move' ? this.interaction.dx : 0
    const dy = this.interaction.kind === 'move' ? this.interaction.dy : 0
    this.renderer.drawSelection(overlay, this.transform, this.selected, COLORS.selection, dx, dy)
    if (this.primary >= 0) {
      this.renderer.drawHandles(overlay, this.transform, this.primary, COLORS.handleFill, dx, dy)
    }

    if (this.interaction.kind === 'marquee') {
      const m = this.interaction
      this.renderer.drawMarquee(overlay, this.transform, m.x, m.y, m.w, m.h, COLORS.selection)
    } else if (this.interaction.kind === 'draw') {
      const d = this.interaction
      this.renderer.drawMarquee(overlay, this.transform, d.x, d.y, d.w, d.h, COLORS.selection)
    }
  }

  /** Screen point to world, written into the controller's scratch object. */
  private toWorld(screenX: number, screenY: number): { x: number; y: number } {
    screenToWorld(this.transform, screenX, screenY, this.scratch)
    return this.scratch
  }

  pointerDown(screenX: number, screenY: number, button: number): void {
    const p = this.toWorld(screenX, screenY)
    const wx = p.x
    const wy = p.y

    if (button === 1) {
      this.interaction = { kind: 'pan', dx: wx, dy: wy }
      return
    }

    if (DRAWERS[this.activeTool]) {
      this.interaction = { kind: 'draw', originX: wx, originY: wy, x: wx, y: wy, w: 0, h: 0 }
      this.select([])
      return
    }

    // Select tool. A handle under the pointer beats a shape under the pointer, or a
    // handle drag would never start because the shape would be grabbed first.
    if (this.primary >= 0) {
      this.handle = hitHandle(this.store, this.primary, wx, wy, this.viewport.zoom, this.scratch)
      if (this.handle >= 0) {
        const i = this.primary
        const shape = this.store.shapeAt(i)
        // Ask whether the shape is described by its box, not whether it happens to be a
        // rect. The two are the same question until the first type that is not a box, and
        // until then the narrower one is correct code that would quietly refuse to resize
        // every type added after this one.
        if (isBoxedShape(shape)) {
          this.interaction = {
            kind: 'resize',
            handle: this.handle,
            shape: i,
            x: shape.x,
            y: shape.y,
            w: shape.w,
            h: shape.h,
          }
          return
        }
      }
    }

    const hit = this.store.hitTest(wx, wy)
    if (hit >= 0) {
      if (!this.selected.includes(hit)) this.select([hit])
      this.moveOriginX = wx
      this.moveOriginY = wy
      this.interaction = { kind: 'move', dx: 0, dy: 0 }
      return
    }

    this.interaction = { kind: 'marquee', x: wx, y: wy, w: 0, h: 0 }
    this.select([])
  }

  pointerMove(screenX: number, screenY: number): void {
    const p = this.toWorld(screenX, screenY)

    switch (this.interaction.kind) {
      case 'idle': {
        this.updateCursor(p.x, p.y)
        return
      }
      case 'draw': {
        const d = this.interaction
        d.x = d.originX
        d.y = d.originY
        d.w = p.x - d.originX
        d.h = p.y - d.originY
        return
      }
      case 'move': {
        this.interaction.dx = p.x - this.moveOriginX
        this.interaction.dy = p.y - this.moveOriginY
        return
      }
      case 'resize': {
        const r = this.interaction
        const next = resizeRect(r.x, r.y, r.w, r.h, r.handle, p.x, p.y)
        r.x = next.x
        r.y = next.y
        r.w = next.w
        r.h = next.h
        return
      }
      case 'marquee': {
        const m = this.interaction
        m.w = p.x - m.x
        m.h = p.y - m.y
        return
      }
      case 'pan': {
        const pan = this.interaction
        const dx = p.x - pan.dx
        const dy = p.y - pan.dy
        pan.dx = p.x
        pan.dy = p.y
        this.viewport = {
          ...this.viewport,
          cameraX: this.viewport.cameraX - dx,
          cameraY: this.viewport.cameraY - dy,
        }
        this.transform = toTransform(this.viewport, this.size, this.dpr)
        return
      }
    }
  }

  pointerUp(): void {
    const interaction = this.interaction

    switch (interaction.kind) {
      case 'draw': {
        // A click rather than a drag makes no shape. Committing a zero-size shape would
        // put something on the board the user cannot see, select or delete.
        if (Math.abs(interaction.w) > 1 || Math.abs(interaction.h) > 1) {
          const rect = normalize(interaction.x, interaction.y, interaction.w, interaction.h)
          const id = nextId()
          // The tool is read again here rather than captured when the drag began, so the
          // shape made is the one the tool says now. A tool switched mid-drag is not
          // possible through the toolbar, and guessing the other way would be wrong.
          const draw = DRAWERS[this.activeTool]
          if (draw) {
            this.doc.transact(() => {
              draw(this.doc, { id, rect })
            }, LOCAL_ORIGIN)
            this.refresh()
            const i = this.store.indexOf(id)
            if (i >= 0) this.select([i])
          }
        }
        break
      }
      case 'move': {
        if (interaction.dx !== 0 || interaction.dy !== 0) {
          this.commitMove(interaction.dx, interaction.dy)
        }
        break
      }
      case 'resize': {
        this.commitResize(interaction)
        break
      }
      case 'marquee': {
        if (Math.abs(interaction.w) > 2 || Math.abs(interaction.h) > 2) {
          const n = this.store.hitTestRect(
            interaction.x,
            interaction.y,
            interaction.w,
            interaction.h,
            this.scratchRect,
          )
          this.select(n > 0 ? this.scratchRect.slice() : [])
        }
        break
      }
      case 'pan':
      case 'idle':
        break
    }

    this.interaction = { kind: 'idle' }
    this.handle = -1
  }

  private commitMove(dx: number, dy: number): void {
    this.doc.transact(() => {
      for (const i of this.selected) {
        const map = this.shapeMapAt(i)
        if (!map) continue
        const x = this.store.x(i) + dx
        const y = this.store.y(i) + dy
        map.set('x', round(x))
        map.set('y', round(y))
      }
    }, LOCAL_ORIGIN)
    this.refresh()
  }

  private commitResize(r: {
    handle: number
    shape: number
    x: number
    y: number
    w: number
    h: number
  }): void {
    const map = this.shapeMapAt(r.shape)
    if (!map) return
    const rect = normalize(r.x, r.y, r.w, r.h)
    this.doc.transact(() => {
      map.set('x', round(rect.x))
      map.set('y', round(rect.y))
      map.set('w', round(rect.w))
      map.set('h', round(rect.h))
    }, LOCAL_ORIGIN)
    this.refresh()
  }

  private shapeMapAt(i: number): ShapeMap | undefined {
    const id = this.store.idAt(i)
    if (id === undefined) return undefined
    return shapesMap(this.doc).get(id)
  }

  private select(indices: number[]): void {
    const same =
      indices.length === this.selected.length &&
      indices.every((value, k) => value === this.selected[k])
    this.selected = indices
    this.primary = indices.length === 1 ? (indices[0] ?? -1) : -1
    // Notifying unconditionally would re-render React on every document update, because
    // every update goes through a refresh that reselects. Comparing first keeps the
    // selection a change-driven signal rather than a per-frame one.
    if (!same) this.callbacks.onSelectionChange(this.selectedIds)
  }

  /**
   * Re-project the document into the store, keeping the selection on the same shapes.
   *
   * A store index is a position in z order, not an identity. After anything that changes
   * the set or the order of shapes, the indices the selection holds can point at other
   * shapes entirely, and a drag would then move something the user never clicked. Remapping
   * by id is the only way to keep "I moved the rectangle I clicked" true, and it costs a
   * few map lookups over a selection that is nearly always one shape long.
   *
   * Every transaction this controller makes ends here, and the app calls it when the
   * document changes for a reason the controller did not cause, such as an undo.
   */
  refresh(): void {
    const ids = this.selectedIds
    this.store.refill(this.doc)
    const remapped: number[] = []
    for (const id of ids) {
      const i = this.store.indexOf(id)
      if (i >= 0) remapped.push(i)
    }
    this.select(remapped)
  }

  private updateCursor(worldX: number, worldY: number): void {
    if (this.tool !== 'select') {
      this.cursor = 'crosshair'
      return
    }
    if (this.primary >= 0) {
      const k = hitHandle(
        this.store,
        this.primary,
        worldX,
        worldY,
        this.viewport.zoom,
        this.scratch,
      )
      if (k >= 0) {
        this.cursor = HANDLE_CURSORS[k] ?? 'default'
        return
      }
    }
    this.cursor = this.store.hitTest(worldX, worldY) >= 0 ? 'move' : 'default'
  }

  wheel(deltaY: number, screenX: number, screenY: number): void {
    const factor = Math.exp(-deltaY * 0.0015)
    this.viewport = zoomAt(this.viewport, screenX, screenY, this.size, factor)
    this.transform = toTransform(this.viewport, this.size, this.dpr)
  }

  /** Keyboard commands. Returns true when it handled the key. */
  key(key: string, shift: boolean): boolean {
    if (key === 'Escape') {
      this.interaction = { kind: 'idle' }
      this.select([])
      return true
    }
    if ((key === 'z' || key === 'Z') && !shift) {
      this.undoStep()
      return true
    }
    if ((key === 'z' || key === 'Z') && shift) {
      this.redoStep()
      return true
    }
    if (key === 'Delete' || key === 'Backspace') {
      this.commitDelete()
      return true
    }
    const nudge = shift ? 10 : 1
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-nudge, 0],
      ArrowRight: [nudge, 0],
      ArrowUp: [0, -nudge],
      ArrowDown: [0, nudge],
    }
    const delta = step[key]
    if (delta && this.selected.length > 0) {
      this.commitMove(delta[0], delta[1])
      return true
    }
    return false
  }

  private commitDelete(): void {
    if (this.selected.length === 0) return
    const ids = this.selectedIds
    this.doc.transact(() => {
      for (const id of ids) {
        const map = shapesMap(this.doc).get(id)
        if (map) map.set('lastDeleted', true)
      }
    }, LOCAL_ORIGIN)
    this.refresh()
    this.select([])
  }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function normalize(x: number, y: number, w: number, h: number): Rect {
  return {
    x: x + Math.min(0, w),
    y: y + Math.min(0, h),
    w: Math.abs(w),
    h: Math.abs(h),
  }
}

/**
 * Resize a rect by dragging one of its eight handles.
 *
 * Edges and corners, clockwise, matching the handle order the renderer draws: 0..3 are the
 * corners and 4..7 the edge midpoints. A drag past the opposite edge negates the extent
 * rather than being clamped, so a shape can be turned inside out by dragging rather than
 * silently refusing to move.
 */
export function resizeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  handle: number,
  px: number,
  py: number,
): Rect {
  const left = x
  const top = y
  const right = x + w
  const bottom = y + h

  let nx = left
  let ny = top
  let nr = right
  let nb = bottom

  if (handle === 0 || handle === 3 || handle === 7) nx = px
  if (handle === 1 || handle === 2 || handle === 5) nr = px
  if (handle === 0 || handle === 1 || handle === 4) ny = py
  if (handle === 2 || handle === 3 || handle === 6) nb = py

  return { x: nx, y: ny, w: nr - nx, h: nb - ny }
}

/** Two decimal places. Enough for a pixel, and it keeps concurrent writes from fighting. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

let idCounter = 0

/**
 * A shape id.
 *
 * `crypto.randomUUID` where it exists, and a counter otherwise, so the id is unique
 * without pulling in a dependency. The counter is per-session, which is enough: a second
 * tab has its own and a collision would need the same counter value in two documents,
 * which the tab-scoped origin makes irrelevant.
 */
function nextId(): string {
  idCounter++
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `shape-${String(idCounter)}`
}
