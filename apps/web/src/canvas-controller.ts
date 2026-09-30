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
  createLineShape,
  createNoteShape,
  createPenShape,
  createRectShape,
  createViewport,
  isBoxedShape,
  screenToWorld,
  shapesMap,
  toTransform,
  translateShape,
  zoomAt,
  clampDevicePixelRatio,
  DEFAULT_NOTE_RECT,
  type ShapeMap,
  type Viewport,
  type ViewportTransform,
} from '@mesob/schema'
import type { Doc } from 'yjs'
import { UndoManager } from 'yjs'

export type Tool = 'select' | 'rect' | 'ellipse' | 'line' | 'pen' | 'note'

/**
 * What kind of thing a tool produces.
 *
 * A `Record` over `Tool` rather than a table of creator functions, because the three
 * drawable tools do not share a creation signature: a box tool takes a rectangle, a line
 * takes two endpoints, and a pen takes a run of points. The old table of creators could
 * only hold the boxed ones, and its own comment already admitted that `line` and `pen` "do
 * not fit this signature" — a table whose type says two of its five tools cannot appear is
 * a table that will be extended by a cast.
 *
 * The important property is preserved rather than lost: pointer-down and pointer-up both
 * read *this* table, so "is this a draw, and what kind" has one answer. If they disagreed, a
 * drag would either do nothing or create a shape nobody asked for, and only one of the two
 * would be covered by a test.
 */
const TOOL_KIND: Record<Tool, 'box' | 'line' | 'stroke' | 'none'> = {
  select: 'none',
  rect: 'box',
  ellipse: 'box',
  note: 'box',
  line: 'line',
  pen: 'stroke',
}

/** A click with a box or line tool makes no shape. One screen pixel, not one world unit. */
const MIN_DRAG_PX = 1
/** Points closer together than this on screen are the same point. Freehand input is dense. */
const STROKE_SAMPLE_PX = 1.5
/** Ramer-Douglas-Peucker tolerance, in screen pixels. Below this, a point is not a shape. */
const STROKE_SIMPLIFY_PX = 0.6
/** A pen's one-point run, duplicated on commit so a tap leaves a dot rather than nothing. */

export type Interaction =
  | { kind: 'idle' }
  | { kind: 'draw'; originX: number; originY: number; x: number; y: number; w: number; h: number }
  | { kind: 'line'; originX: number; originY: number; x: number; y: number }
  | { kind: 'stroke'; count: number }
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
  /** An in-progress line or stroke. The stroke colour, at the opacity of a draft. */
  preview: '#2a2622',
}

export interface BoardCallbacks {
  onSelectionChange(ids: string[]): void
  onShapeCountChange(count: number): void
  /**
   * The note being edited changed, or stopped being edited.
   *
   * The id, not a store index: a dense index is a position in z order and the note can be
   * reordered or deleted underneath the editor, at which point the index silently points at
   * something else and the user is typing into it.
   */
  onNoteEditChange(id: string | null): void
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

  /**
   * The pen's point buffer, preallocated and reused across strokes.
   *
   * The design is explicit that this may not be allocated per pointer-move, because a fresh
   * array per sample is exactly the garbage collection the zero-allocation draw loop exists
   * to avoid. It grows by doubling and is never released: a second stroke reuses whatever
   * the first one left, which is why there is no `Float32Array` anywhere in the move path.
   */
  private strokeBuffer = new Float32Array(512)
  /** Points in `strokeBuffer`, counted in points rather than floats. */
  private strokeCount = 0
  /** The note currently being typed into, by id. */
  private editingId: string | null = null

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
    // Switching tools is an implicit "I am done with that note". Leaving the editor open
    // over a shape the user has moved on from is how a stray keystroke ends up in a note
    // that is no longer under the cursor.
    if (tool !== 'note') this.endNoteEdit()
  }

  /** The note being typed into, by id, or null. */
  get noteEditId(): string | null {
    return this.editingId
  }

  /**
   * A note's current text, for the editor's initial value.
   *
   * Read through the store rather than the document so a peer that has already changed the
   * text is the value the field opens on. The store is the projection the renderer is
   * drawing, and an editor that opened on a different version of the note than the one on
   * screen would be a second source of truth.
   */
  noteText(id: string): string {
    const i = this.store.indexOf(id)
    if (i < 0) return ''
    const shape = this.store.shapeAt(i)
    return shape?.type === 'note' ? shape.text : ''
  }

  /**
   * Begin editing a note. False if the id is not a note in the store.
   *
   * Checked rather than assumed: the id comes from a keyboard selection or a previous
   * creation, and between the two the shape can be deleted, undone away, or — from a peer —
   * have been something else entirely.
   */
  beginNoteEdit(id: string): boolean {
    const i = this.store.indexOf(id)
    if (i < 0 || this.store.shapeAt(i)?.type !== 'note') return false
    this.editingId = id
    this.callbacks.onNoteEditChange(id)
    return true
  }

  endNoteEdit(): void {
    if (this.editingId === null) return
    this.editingId = null
    this.callbacks.onNoteEditChange(null)
  }

  /**
   * Write text into the note being edited.
   *
   * One document write per keystroke, which looks like it contradicts the drag rule and is
   * not the same rule: a drag can be previewed as a transform because the shape already
   * exists, whereas text has to be written to be seen, and the peer is not waiting for a
   * more polite moment. The UndoManager's 300ms capture window is what keeps it from
   * becoming a hundred undo steps.
   */
  setNoteText(text: string): void {
    const id = this.editingId
    if (id === null) return
    const map = shapesMap(this.doc).get(id)
    if (!map) {
      this.endNoteEdit()
      return
    }
    this.doc.transact(() => {
      map.set('text', text)
    }, LOCAL_ORIGIN)
    this.refresh()
  }

  /** The note's box in screen pixels, for the editor to sit over. False if there is none. */
  noteScreenRect(id: string, out: { x: number; y: number; w: number; h: number }): boolean {
    const i = this.store.indexOf(id)
    if (i < 0) return false
    const t = this.transform
    out.x = (this.store.minX(i) - t.cameraX) * t.zoom + t.width / 2
    out.y = (this.store.minY(i) - t.cameraY) * t.zoom + t.height / 2
    out.w = this.store.w(i) * t.zoom
    out.h = this.store.h(i) * t.zoom
    return true
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
    } else if (this.interaction.kind === 'line') {
      const l = this.interaction
      this.renderer.drawSegment(
        overlay,
        this.transform,
        l.originX,
        l.originY,
        l.x,
        l.y,
        COLORS.preview,
      )
    } else if (this.interaction.kind === 'stroke' && this.strokeCount > 0) {
      // Previewed from the buffer rather than from a shape, because the shape does not
      // exist yet and creating it would mean a document write per pointer-move — the exact
      // flooding of the update log the drag rule exists to prevent. The pen is the design's
      // stated exception to live drag, and this is what that exception looks like.
      this.renderer.drawStroke(
        overlay,
        this.transform,
        this.strokeBuffer,
        this.strokeCount,
        COLORS.preview,
      )
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

    // A pointer on the canvas is a pointer that has left the note. The editor itself is a
    // DOM element above the canvas, so clicking inside the note never reaches this line.
    this.endNoteEdit()

    switch (TOOL_KIND[this.activeTool]) {
      case 'box':
        this.interaction = { kind: 'draw', originX: wx, originY: wy, x: wx, y: wy, w: 0, h: 0 }
        this.select([])
        return
      case 'line':
        this.interaction = { kind: 'line', originX: wx, originY: wy, x: wx, y: wy }
        this.select([])
        return
      case 'stroke':
        this.interaction = { kind: 'stroke', count: 0 }
        this.pushStrokePoint(wx, wy)
        this.select([])
        return
      case 'none':
        break
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
      case 'line': {
        this.interaction.x = p.x
        this.interaction.y = p.y
        return
      }
      case 'stroke': {
        // Coalesced: a pointer that has not travelled a screen pixel has not said anything
        // new, and every point kept is a segment the simplifier and the renderer both pay
        // for. The first point is pushed on pointer-down, so this is not where the stroke
        // starts — it is where it is still moving.
        this.pushStrokePoint(p.x, p.y)
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
        // A click rather than a drag makes a default-sized note, and nothing at all for the
        // other two. Committing a zero-size rect would put something on the board the user
        // cannot see, select or delete; a note with no click behaviour would be the one
        // drawable tool in the set that cannot be made with a click, which is the opposite
        // of how a note is used.
        const min = MIN_DRAG_PX / this.viewport.zoom
        const dragged = Math.abs(interaction.w) > min || Math.abs(interaction.h) > min
        const isNote = this.activeTool === 'note'
        if (!dragged && !isNote) break

        const id = this.commitBox(
          dragged
            ? normalize(interaction.x, interaction.y, interaction.w, interaction.h)
            : {
                // A click anchors the note at the pointer. The size comes from the schema's
                // default, referenced rather than copied, so "how big is a note" has one
                // answer and the controller only knows where the user clicked.
                x: interaction.originX,
                y: interaction.originY,
                w: DEFAULT_NOTE_RECT.w,
                h: DEFAULT_NOTE_RECT.h,
              },
        )
        if (isNote && id !== null) this.beginNoteEdit(id)
        break
      }
      case 'line': {
        const length = Math.hypot(
          interaction.x - interaction.originX,
          interaction.y - interaction.originY,
        )
        if (length <= MIN_DRAG_PX / this.viewport.zoom) break
        const id = nextId()
        this.doc.transact(() => {
          createLineShape(this.doc, {
            id,
            x1: round(interaction.originX),
            y1: round(interaction.originY),
            x2: round(interaction.x),
            y2: round(interaction.y),
            // The Line tool draws a line. The arrowhead is a property of the same primitive
            // per the design's rule, and the arrow tool is the same code path with this
            // flag set — the shape type does not change.
            head: false,
          })
        }, LOCAL_ORIGIN)
        this.refresh()
        const i = this.store.indexOf(id)
        if (i >= 0) this.select([i])
        break
      }
      case 'stroke': {
        if (this.strokeCount === 0) break
        // Simplified before it is stored, not after: the document should never hold a
        // thousand points describing a straight line, and the tolerance is in the units the
        // user was looking at, which is where the judgement about what is a straight line
        // belongs.
        const tolerance = STROKE_SIMPLIFY_PX / this.viewport.zoom
        const points = simplifyStroke(this.strokeBuffer, this.strokeCount, tolerance)
        if (points.length < 4) {
          // A tap, not a stroke. A pen's one-point run is a dot, and duplicating the point is
          // how it is written: a pen with a single point has no extent to draw, and the
          // alternative - ignoring the tap - loses the one gesture a user makes when they
          // want to place a point on a map.
          //
          // The bound is 4 rather than 2 because this is a flat array of coordinates, so one
          // point is already two numbers. Testing `length < 2` here would never be true for
          // a tap, and the stroke would be committed with a single point — which the
          // renderer draws as nothing at all, leaving a shape on the board that cannot be
          // seen, only selected.
          if (points.length < 2) break
          points.push(points[0] ?? 0, points[1] ?? 0)
        }
        const id = nextId()
        this.doc.transact(() => {
          createPenShape(this.doc, { id, points })
        }, LOCAL_ORIGIN)
        this.refresh()
        const i = this.store.indexOf(id)
        if (i >= 0) this.select([i])
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

  /**
   * Create the shape the current box tool describes, and select it.
   *
   * The tool is read again here rather than captured when the drag began, so the shape made
   * is the one the tool says now. A tool switched mid-drag is not possible through the
   * toolbar, and guessing the other way would be wrong.
   *
   * A switch with no default branch, over the three boxed tools. `TOOL_KIND` has already
   * established that this tool is one of them, so the remaining question is which, and an
   * exhaustive switch is what makes a fourth boxed tool a compile error here rather than a
   * shape that is silently created as a rect.
   */
  private commitBox(rect: Rect): string | null {
    const id = nextId()
    this.doc.transact(() => {
      switch (this.activeTool as 'rect' | 'ellipse' | 'note') {
        case 'rect':
          createRectShape(this.doc, { id, rect })
          break
        case 'ellipse':
          createEllipseShape(this.doc, { id, rect })
          break
        case 'note':
          createNoteShape(this.doc, { id, rect })
          break
      }
    }, LOCAL_ORIGIN)
    this.refresh()
    const i = this.store.indexOf(id)
    if (i >= 0) this.select([i])
    return id
  }

  /**
   * Append a point to the stroke buffer, growing it by doubling.
   *
   * Skips the sample when it is closer than a screen pixel to the previous one, which is
   * what "coalesced" means here: a trackpad reports far more positions than a stroke has
   * shape, and the ones that add nothing are the ones that make simplification do more work
   * rather than less.
   */
  private pushStrokePoint(x: number, y: number): void {
    const min = STROKE_SAMPLE_PX / this.viewport.zoom
    if (this.strokeCount > 0) {
      const last = (this.strokeCount - 1) * 2
      const dx = x - (this.strokeBuffer[last] ?? 0)
      const dy = y - (this.strokeBuffer[last + 1] ?? 0)
      if (dx * dx + dy * dy < min * min) return
    }
    const needed = (this.strokeCount + 1) * 2
    if (needed > this.strokeBuffer.length) {
      // Doubling, not a fixed increment: a long stroke should not reallocate on every
      // sample, and the buffer is never given back because the next stroke reuses it.
      const grown = new Float32Array(this.strokeBuffer.length * 2)
      grown.set(this.strokeBuffer)
      this.strokeBuffer = grown
    }
    this.strokeBuffer[this.strokeCount * 2] = x
    this.strokeBuffer[this.strokeCount * 2 + 1] = y
    this.strokeCount++
  }

  private commitMove(dx: number, dy: number): void {
    this.doc.transact(() => {
      for (const i of this.selected) {
        const map = this.shapeMapAt(i)
        if (!map) continue
        // `translateShape`, not `set x` and `set y`: a line and a pen are described by their
        // geometry, and writing their box would move a number nothing reads. The rounding
        // lives there too, so a nudge of 1 and a drag of 1.005 both land on the same grid
        // and a peer is not sent a difference it will round differently.
        translateShape(map, round(dx), round(dy))
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
    // A note that was being edited may have just been deleted, or undone away. Leaving the
    // editor open over a shape that is no longer there means typing into nothing, and
    // `setNoteText` would write to whatever took its place. `indexOf` answers this because
    // the store excludes tombstones, which a lookup in the document's own map would not.
    if (this.editingId !== null && this.store.indexOf(this.editingId) < 0) {
      this.endNoteEdit()
    }
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
      // Escape leaves the note before it leaves the selection. A user pressing Escape is
      // asking to stop what they are doing, and if the editor is open the only thing they
      // can be doing is typing.
      if (this.editingId !== null) {
        this.endNoteEdit()
        return true
      }
      this.interaction = { kind: 'idle' }
      this.select([])
      return true
    }
    if (key === 'Enter' && !shift && this.selected.length === 1) {
      // Enter edits the selected note. The only way to reach a note's text without a mouse
      // is the one keyboard path the app has, and a note that can only be typed into by
      // clicking is a note that cannot be typed into at all for some users.
      const i = this.selected[0] ?? -1
      if (i >= 0 && this.store.shapeAt(i)?.type === 'note') {
        this.beginNoteEdit(this.selectedIds[0] ?? '')
        return true
      }
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

/**
 * Ramer-Douglas-Peucker, over a caller-owned buffer.
 *
 * The tolerance is in *world* units, and the caller derives it from a screen-pixel figure
 * and the current zoom. That is the whole reason this lives here rather than in the shape
 * store: 0.6px means something about what the user was looking at, and the zoom is the only
 * thing that knows what a pixel was at the time.
 *
 * The tolerance is a distance, so it has to be compared against one. Perpendicular distance
 * would need a division per point and buys nothing for a 0.6px budget; a stroke simplified
 * at 0.6px looks identical either way, and this is the one place in the drawing path where
 * a fraction of a pixel of slack is free.
 *
 * An explicit stack rather than recursion. A long stroke is thousands of points, and the
 * recursive form's depth is bounded by the number of splits it makes — which is the number
 * of points the tolerance is too coarse to remove. A scribble can produce a few thousand,
 * and a few thousand frames of stack is a range error on a drawing tool.
 *
 * Returns a fresh array rather than compacting the buffer, because the buffer is reused by
 * the next stroke and this result is about to be written into the document, where it is
 * copied anyway.
 */
export function simplifyStroke(points: Float32Array, count: number, tolerance: number): number[] {
  const n = Math.max(0, Math.floor(count))
  if (n < 3) return Array.from(points.subarray(0, n * 2))

  // `keep` marks a point by index, packed into a Uint8Array so the hot loop reads a byte
  // rather than a Set. The first and last points always survive: a stroke that lost its
  // endpoints would not start or stop where the user did.
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1

  const toleranceSquared = tolerance * tolerance
  const stack: number[] = [0, n - 1]

  while (stack.length > 0) {
    const last = stack.pop() ?? 0
    const first = stack.pop() ?? 0
    if (last - first < 2) continue

    const ax = points[first * 2] ?? 0
    const ay = points[first * 2 + 1] ?? 0
    const bx = points[last * 2] ?? 0
    const by = points[last * 2 + 1] ?? 0
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy

    let worst = -1
    let worstDistance = toleranceSquared
    for (let i = first + 1; i < last; i++) {
      const px = points[i * 2] ?? 0
      const py = points[i * 2 + 1] ?? 0
      let distance: number
      if (lengthSquared === 0) {
        // A zero-length span is a dot, so the distance to it is the distance to the point.
        // Dividing by zero here would give NaN, and `NaN > tolerance` is false, which would
        // keep every point of a stroke the user drew in one spot.
        distance = (px - ax) * (px - ax) + (py - ay) * (py - ay)
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = px - (ax + t * dx)
        const ey = py - (ay + t * dy)
        distance = ex * ex + ey * ey
      }
      if (distance > worstDistance) {
        worstDistance = distance
        worst = i
      }
    }

    if (worst >= 0) {
      keep[worst] = 1
      stack.push(first, worst, worst, last)
    }
  }

  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (keep[i] !== 1) continue
    out.push(points[i * 2] ?? 0, points[i * 2 + 1] ?? 0)
  }
  return out
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
