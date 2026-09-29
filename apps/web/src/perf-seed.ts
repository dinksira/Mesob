import { after, createEllipseShape, createRectShape, first, type Doc } from '@mesob/schema'
import type { CanvasController } from './canvas-controller.js'

/**
 * Seeding and instrumentation for the G1 performance gates.
 *
 * This module is reached only from inside an `import.meta.env.DEV` branch in `App.tsx`,
 * so the bundler drops it and everything it pulls in from a production build. That is the
 * whole reason it is a separate module rather than code in `App`: a 5,000-shape seeder is
 * test scaffolding, and scaffolding that ships is scaffolding nobody can trust.
 */

/**
 * Fills, chosen so a run of them is longer than a typical z-ordered sequence, which is
 * what makes the renderer's colour interning do something on the way past a run and
 * something else at every transition.
 */
const FILLS = ['#b8463a', '#2a2622', '#c8912f', '#3f6b52', '#4a5b8c'] as const

/**
 * Seed `count` shapes into `doc`, arranged to fill a `width` x `height` viewport.
 *
 * Arranged to *fill* the viewport rather than to spread across a large board, and that is
 * the load-bearing decision in this file. A 5,000-shape board is easy to draw at 60fps if
 * 4,900 of them are off screen: the cull drops them and the frame is nearly free. That
 * number would pass the gate while measuring nothing. Fitting all of them in view is what
 * makes the measurement the worst case the gate is about — and it is also the realistic
 * case, because a board with 5,000 shapes on it has them on screen.
 *
 * Rects and ellipses alternate, so the store's per-type hit-test dispatch and the
 * renderer's per-type path primitive are both on the hot path rather than one of them
 * being dead weight.
 */
export function seedShapes(doc: Doc, count: number, width: number, height: number): void {
  // A grid with the viewport's own aspect ratio, so the cells stay square and the whole
  // grid is exactly the viewport rather than overflowing it.
  const cols = Math.max(1, Math.round(Math.sqrt((count * width) / Math.max(1, height))))
  const rows = Math.max(1, Math.ceil(count / cols))
  const cellW = width / cols
  const cellH = height / rows

  let z = first()
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      // A gap between cells, so neighbouring shapes do not merge into one blob and the
      // stroke of each is actually rasterised rather than overdrawn by its neighbour.
      const rect = {
        x: col * cellW + cellW * 0.1,
        y: row * cellH + cellH * 0.1,
        w: cellW * 0.8,
        h: cellH * 0.8,
      }
      const params = {
        id: `seed_${String(i)}`,
        z,
        rect,
        style: { fill: FILLS[i % FILLS.length] ?? FILLS[0], strokeWidth: 1 },
      }
      if (i % 2 === 0) createRectShape(doc, params)
      else createEllipseShape(doc, params)
      z = after(z)
    }
  })
}

export interface PerfHook {
  /** Number of live (non-tombstoned) shapes in the document. */
  shapeCount(): number
  /**
   * True once the controller holds a non-empty store, which is what makes the board
   * interactive: the pointer handlers and the hit test both read that store, so a populated
   * store is the application's own answer to "is the canvas editable yet".
   */
  editable(): boolean
  seed(count: number, width: number, height: number): void
  /** The document, for tests that want to drive the schema directly. */
  doc: Doc
}

declare global {
  interface Window {
    __mesobPerf?: PerfHook
  }
}

/**
 * Publish the hook. Idempotent, so a second mount does not leave a stale document behind.
 *
 * `controller` is a thunk rather than a controller because the board creates its controller
 * after this runs, and handing over the value at construction time would publish `null` for
 * the entire life of the app.
 */
export function exposePerfHook(doc: Doc, controller: () => CanvasController | null): void {
  window.__mesobPerf = {
    doc,
    seed: (count, width, height) => {
      seedShapes(doc, count, width, height)
    },
    editable: () => (controller()?.store.size ?? 0) > 0,
    shapeCount: () => {
      let n = 0
      doc.getMap('shapes').forEach((value) => {
        const map = value as { get(key: string): unknown }
        if (map.get('lastDeleted') !== true) n++
      })
      return n
    },
  }
}
