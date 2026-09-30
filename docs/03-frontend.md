# 03 — Frontend

> **Status: draft** · Depends on: [01](./01-system-design.md), [02](./02-system-architecture.md) · Feeds gates G1, G3, G4

## Context

The frontend carries the two hardest things in the product: a canvas that stays smooth with
thousands of shapes, and a rich-text editor whose characters merge correctly with someone else's.
Everything in this document exists to keep those two concerns from fighting over state.

---

## 1. The state ownership rule

The single most important rule in the frontend, and the one most likely to be violated by accident.

```
┌─────────────────────────────────────────────────────────────┐
│  Y.Doc                          Zustand                      │
│  ─────────────────────────     ────────────────────────────  │
│  shapes, blocks, text, z        activeTool, openPanel,       │
│  (shared, CRDT, persisted)      viewport, selectionIds,     │
│                                 localDrag, panelSizes,     │
│                                 connectionStatus,          │
│                                 timelinePosition,          │
│                                 devtools open/closed       │
│                                                             │
│  Owner: the document          Owner: this browser only      │
│  Source of truth              Never synced                 │
└─────────────────────────────────────────────────────────────┘
```

**No Zustand slice may hold a copy of anything in the Y.Doc.** If a component needs a shape's
position, it subscribes to the Y.Doc. A mirrored copy is a bug with a delay: the two disagree the
moment a remote update lands, and the symptom is a shape that flickers between two positions.

The distinction that makes this workable: `selectionIds` is Zustand (who is selected is private),
but the selected shape's geometry is Yjs (it is shared truth).

### Zustand slices

| Slice | Contents | Notes |
|---|---|---|
| `tool` | `activeTool`, `toolOptions` (stroke colour, fill, width) | Tool state is per-user by nature |
| `viewport` | `{ x, y, zoom }` | Mirrored to the URL hash so a link can open at a view; see §9 |
| `selection` | `selectedIds: Set<shapeId>`, `marqueeRect`, `transformOrigin` | Not synced. Follow mode overwrites it programmatically |
| `interaction` | `dragging`, `resizing`, `rotating`, `panning`, `lasso` | Ephemeral, high-frequency, must not touch Yjs per event |
| `connection` | `status`, `lastSyncedAt`, `offlineSince`, `pendingLocalChanges` | Drives the status chip and the reconnect summary |
| `history` | `timelinePosition`, `scrubbing`, `versions`, `diffPreview` | A read view; see §8 |
| `ui` | panel visibility, palette open, theme, toasts | |
| `devtools` | visualizer open, partition controls, op log ring buffer | Behind a dev flag |

### React subscription model

React does not re-render on canvas changes. That is not a performance trick, it is a correctness
requirement — 60 position updates per second during a drag would thrash React's reconciler.

```ts
// One hook, one rule: use it everywhere you need a Yjs-backed value in React.
function useShape(shapeId: string): Shape | null {
  return useSyncExternalStore(
    (cb) => observeShape(doc, shapeId, cb),   // subscribe: deep-observe the Y.Map
    () => readShape(doc, shapeId),            // getSnapshot: must return a cached object
    () => null,                               // SSR
  )
}
```

`getSnapshot` must return a **referentially stable** value. Reading a `Y.Map` into a fresh object
on every call makes `useSyncExternalStore` re-render forever. The implementation caches the derived
plain object and invalidates it on the Yjs observer callback. This is a genuine footgun and gets its
own test.

Components that need many shapes subscribe to the whole `shapes` map but re-render on a **structural
digest** (id + z + a hash of geometry), not on every value change, so a drag of one shape does not
re-render a sidebar listing 5,000.

---

## 2. The render loop

### Layers

Three stacked canvases plus one DOM overlay. Separating them means dragging a shape does not repaint
a thousand static rectangles, and a live cursor does not repaint the board.

| Layer | Canvas | Contents | Repaint trigger |
|---|---|---|---|
| **0 — board** | `<canvas id="board">` | Shapes, grid, snap guides, selection outlines, marquee | Dirty rects from Yjs observers |
| **1 — presence** | `<canvas id="presence">` | Remote cursors, remote selection boxes, laser trails | rAF, interpolation only |
| **2 — overlay** | `<canvas id="overlay">` | Multi-selection bounding box, rotate handles, marquee, measurement | Interaction state changes |
| **3 — DOM** | absolutely positioned divs | **Tiptap doc block editors**, image fallbacks | React, rarely |

Layer 3 is a DOM overlay because ProseMirror needs real DOM: text selection, IME composition
(essential for Amharic), native spellcheck, and accessibility. Fighting that with canvas text would
be a multi-month mistake. The canvas and the overlay are kept in sync by a single
`screenToWorld`/`worldToScreen` transform, so a doc block behaves like any other shape: it can be
selected, moved, and scaled from the same code path as a rectangle.

### The frame

```ts
function frame(t: number) {
  const dirty = dirtyTracker.consume()          // Set<shapeId> changed since last frame

  if (dirty.size) {
    // 1. expand each dirty shape to a screen-space bounding box
    // 2. union them into one dirty rect (or a small list if far apart)
    // 3. clear + redraw only those rects, plus any intersecting shapes
  }
  if (overlayDirty || interacting) drawOverlay()
  if (presenceDirty)   drawPresence(t)          // interpolation, see §7

  instrument.record(frameTime)
  requestAnimationFrame(frame)
}
```

Budget at 5,000 shapes, p95 < 16 ms:

| Stage | Budget | Technique |
|---|---|---|
| Culling query | 0.5 ms | Flat-array spatial index, see below |
| Geometry | 1.5 ms | Typed arrays, no per-frame allocation, no `getBoundingClientRect` |
| Draw calls | 6 ms | Path batching by style; `ctx.save/restore` hoisted out of loops |
| Presence | 1 ms | Separate canvas, so it does not compete with board clears |
| Slack | 7 ms | Headroom for GC and main-thread work from React |

### The non-negotiable: no per-frame allocation

A single `new` per shape per frame at 5,000 shapes is 5,000 allocations per frame, 300,000 per
second. That is a GC-driven frame-time sawtooth. So:

- Shape transforms live in a `Float32Array` in **world** coordinates, keyed by a dense index
  (`shapeId → index` map maintained by the schema layer). Canvas transform state is a scratch
  `Float32Array` of size 6 × visibleCount, refilled per frame by applying the viewport matrix.
- Colours are interned strings resolved to `CanvasRenderingContext2D.fillStyle` only when they
  change; a style run of 500 identical rects sets `fillStyle` once.
- No `ctx.measureText` in the draw path. Text metrics are measured on change and cached on the shape
  record.
- No closures created inside draw loops; all per-shape code is a top-level function taking
  `(ctx, shapes, base, i)`.
- The draw loop is instrumented and the allocation rate is asserted in the perf harness
  ([13](./13-testing.md#9-performance-testing)).

### Spatial index

A flat array of AABBs, scan-tested during culling, plus a **rebuilt-every-N-frames** loose grid.
Deliberately not an R-tree: R-trees allocate on insert, which fights the no-allocation rule, and
boards change in bursts during a drag.

```ts
// Grid: cell = 512 world units. Buckets are flat Int32Array-backed lists.
class SpatialIndex {
  build(shapes: ShapeArray): void        // full rebuild, O(n), 1-2 ms for 5,000 shapes
  update(id: ShapeId): void             // move an id between buckets on change
  query(viewport: AABB, out: ShapeId[]): void
}
```

Rebuild cost at 5,000 shapes is ~1.5 ms; running it every 30 frames amortises it to ~0.05 ms and
tolerates up to 5,000 position changes between rebuilds without visible error, because the query is
conservative (it returns extra candidates, and the draw pass re-tests exact bounds).

### Viewport maths

- `zoom ∈ [0.05, 8]`, `screen = (world - camera) * zoom + canvasOrigin`, exactly one source of truth
  in `packages/schema/src/transform.ts`, used by hit-testing, drawing, doc-block positioning, and
  export alike.
- `devicePixelRatio` is respected and clamped to 3. Below 0.5, hide the grid and presence labels.
- Pinch-zoom is computed from two pointer positions and the midpoint, so the content under the
  fingers stays under the fingers.
- Zoom is eased toward a target with a 0.18 lerp; pinch and wheel commit immediately (latency during
  a gesture is worse than a slightly abrupt transition).
- `worldMin`/`worldMax` are inferred from shape bounds. There is no board size — the canvas is
  infinite by construction, and the grid fades out below 0.3 zoom.

### Hit-testing

```
1. Transform the pointer to world space.
2. Topmost-first: iterate the z-sorted visible set in reverse.
3. Per shape: reject if the AABB test fails (cheap), then the precise test:
     rect   → point-in-rect
     ellipse→ normalised radius ≤ 1
     note   → point-in-rect (it is boxed)
     line   → min distance to the segment ≤ tolerance / zoom
     pen    → min distance to any segment ≤ tolerance / zoom
4. Respect handles: if a resize/rotate handle is under the pointer, it wins over the shape.
```

The AABB is a rejection test, never the answer. A line and a pen both derive a box from their
geometry, and hitting that box would mean selecting a line by clicking the empty space inside its
bounding rectangle — a shape the user cannot see the edge of, selected by a region they would
describe as "not on the line". Derived boxes are for culling and for handles; hit testing always
falls through to the geometry.

Every precise test takes `tolerance / zoom` so hit targets feel identical at every zoom level — a
small detail that users notice immediately and reviewers notice on close inspection.

### Redraw invalidation

```
Yjs observer on shapes map
  → mark id dirty
  → for a delete: mark the union of the last known bounds + new neighbours dirty
  → coalesce all dirty ids into a minimal set of screen rects (merge if they overlap)
```

Coalescing matters: a 5,000-shape clear followed by a full redraw is the difference between 4 ms and
11 ms. Overlapping dirty rects are merged with a simple sweep, capped at 8 rects; past that cap,
fall back to a full clear. A cap keeps the worst case bounded.

---

## 3. Interaction and tools

Tools are a state machine, not a pile of booleans. One `activeTool` plus a discriminated union of
tool parameters.

```ts
type Tool = 'select' | 'rect' | 'ellipse' | 'note' | 'line' | 'pen'
```

Interaction is dispatched on a `TOOL_KIND` map — one value per tool saying whether it is a
select, a box, a segment or a freehand stroke. The interaction itself is a discriminated union,
so the pointer handler switches rather than carrying booleans, and adding a tool means adding one
map entry rather than a branch in four places.

| Tool | Interaction | Commit to Yjs |
|---|---|---|
| `select` | Click, shift-click to extend, drag to move, 8 resize handles + rotate handle, marquee on empty space | On pointer-up. Live drag is a local transform applied at draw time |
| `pan` | Drag, space-drag from any tool, middle-mouse, trackpad two-finger | Nothing. Camera is Zustand |
| `rect`/`ellipse` | Drag or click for default size | On pointer-up: create the `Y.Map` |
| `note` | Drag for a sized note, or click for a default 180×120 one; then a DOM `<textarea>` over the note | Note on pointer-up, then one write per keystroke |
| `line` | Drag between two points | On pointer-up: one segment, `head: false` |
| `pen` | Freehand drag; samples coalesced at 1.5 px and simplified | On pointer-up (Ramer–Douglas–Peucker, 0.6 px tolerance) |

**`line` covers arrows.** There is one line tool and one primitive: `x1/y1/x2/y2` plus an
optional `head` flag that draws an arrowhead at the far end, arms behind the tip and reversed
when the line is drawn right-to-left. A separate `arrow` tool that could snap to shape anchors
is Phase 2 — see below.

**Notes are boxed, text is not the shape.** A note stores its geometry as `x/y/w/h` and its text
as a string under last-writer-wins. That is why a note resizes from the same handles as a
rectangle, and why a note on a peer's board is editable at the same moment it is on yours. Text
lives in a DOM `<textarea>` over the canvas rather than drawn into it, because a caret and an IME
composition are not something a canvas can host.

**Not in Phase 1.** The design below also describes `text` as a separate rich-text tool,
`image` placement, and `arrow` connectors that snap to shape anchors and orphan rather than
delete when their target is deleted. None of those are built; the table above is the whole of
what exists.

**Live drag is a pure render transform.** During a drag, the shape's Yjs position is *not* touched
until pointer-up. Two reasons: 60 writes/second of `Y.Map.set` would flood the network and the
update log, and CRDT updates during a drag make remote conflict visualisation meaningless. The
dragged shape is drawn with an override transform, and one authoritative write lands at the end.

The pen is the deliberate exception: a stroke is previewed on the overlay as it is sampled and
written once, on pointer-up, because there is no transform that makes an unsimplified path look
like the final one, and a document holding a thousand points per second of dragging is a document
nobody can undo through.

### Transform maths

- Resize keeps the anchor opposite the dragged handle fixed. `rotation ≠ 0` requires transforming
  the pointer into the shape's local space before solving, or handles drift.
- Minimum size is 4×4 world units, enforced as a clamp, not an error.
- Snapping (grid 8 units, and alignment guides within 6 screen px / zoom): candidates are computed
  from the *selection's* bounding box, tested against the visible set only, and the winning snaps
  are collected from a single pass to avoid fighting between two candidates.
- Rotation snaps to 15° with `Shift`.
- Arrow connectors track their source and target shapes. When a target is deleted concurrently, the
  arrow is **orphaned, not deleted** — it is a pending ref, resolved by id on every render, and an
  unresolved ref renders as a dangling endpoint at the last known position. This is the honest
  answer to the question in [01 §8](./01-system-design.md#7-risk-register) risk K-style concerns and
  the "connector consistency" hard problem in the root README.

### Z-order

Fractional index strings (D5). `bringForward` computes a key strictly between the target and its
successor; `sendBackward` mirrors it. `packages/schema/src/fractional-index.ts` wraps the
`fractional-indexing` package (CC0, zero dependencies, ~60 lines of algorithm) behind a four-function
API — `first`, `after`, `before`, `between` — and is the only file in the codebase that imports it,
so the rest of the app sees a four-function contract rather than a package name. Fully unit-tested
against the boundary cases (list of one, list of two, first, last, empty, repeated calls), plus the
property that matters most: native `Array.sort` with no comparator reproduces insertion order, which
is what lets the renderer sort 5,000 keys without a comparison function. See
[ADR-0002](./adr/0002-shape-representation-and-z-order.md) for why this was not hand-rolled.

### Keyboard

`Ctrl/Cmd+K` opens the command palette. All commands are registered in one table with an id, label,
shortcut, and predicate, so the palette, the menus, and the shortcut handler are all generated from
one list. `?` opens the shortcut sheet. A command whose predicate fails is shown disabled, not
hidden, so the muscle memory is learnable.

Core bindings: `V` select, `H` pan, `R`/`O`/`N`/`T`/`A`/`P` shapes, `Delete`, `Ctrl+D` duplicate,
`Ctrl+G` group, `Ctrl+Shift+G` ungroup, `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Ctrl+A`, arrows nudge 1
unit (`Shift` = 10), `Ctrl+0` reset zoom, `Ctrl+1` fit to content, `Space` temporary pan.

**Undo is `Y.UndoManager`, never a custom stack** (D6). It is scoped to the local client's
transaction origins, tracked over the `shapes` and `blocks` roots, with a 300 ms capture merge
window and a cap of 200 stack entries. `captureTimeout` matters: without it, typing a word produces
one undo entry per character, which is the single most common complaint about canvas undo.

---

## 4. Document blocks

A block is a shape whose payload is a `Y.XmlFragment` bound to a Tiptap editor.

```ts
<BlockEditor blockId>
  ├─ ProseMirror DOM, absolutely positioned
  ├─ transform: translate(x, y) scale(w / measuredWidth, 1)
  └─ collaboration: Tiptap Collaboration + CollaborationCursor bound to the fragment
```

- Tiptap extensions: StarterKit (minus the history extension, since `Y.UndoManager` owns undo),
  TaskList, TaskItem, CodeBlockLowlight, Placeholder, Collaboration, CollaborationCursor.
- The editor is **mounted lazily** when a block scrolls into the viewport, and **unmounted** when it
  leaves it with a 400 px margin, keeping at most a handful of ProseMirror instances alive. Fifty
  live ProseMirror instances is a performance cliff.
- An unmounted block must not lose focus or selection. The store keeps the last selection, and the
  remount restores it through the Collaboration extension's own awareness field.
- A block that is not being edited renders as plain text via `generateHTML` on a throttled timer.
  This is what makes 200 text blocks affordable.
- Width is owned by the shape; the editor grows in height. Vertical-only resizing. Justified in
  [index Q3](./README.md#questions-pending-sign-off): horizontal scaling of an editor produces unreadable text
  at small widths, so block width is snapped to a minimum and height is content-driven.
- Font stack: `Inter, "Noto Sans Ethiopic", "Nyala", system-ui, sans-serif`. The Ethiopic fallbacks
  are required or Amharic renders as tofu on Windows, which is the platform risk K11 names. Verified
  with a Playwright screenshot test on Windows and on Linux with a minimal font set.

### Remote text cursors

`CollaborationCursor` handles the rendering; the interesting part is throttling. Cursor positions
are sent at most every 50 ms and only on change, and remote cursors are **interpolated** between
updates so they glide rather than teleport. The cursor's own selection rects are drawn in the DOM
(they belong to ProseMirror) while the board-level cursor arrow is drawn on the presence canvas.

---

## 5. Offline and persistence

- `y-indexeddb` is instantiated synchronously at app start, before the network provider. Local
  writes always land in IndexedDB.
- The app never waits for the socket. `connection.status` is derived state; the UI is fully
  functional in `offline`, `connecting`, and `reconnecting`.
- Reconnect: exponential backoff with full jitter, base 500 ms, factor 1.8, cap 30 s, with a
  visible "retrying in Ns" indicator. A **jittered** backoff is what prevents the reconnect storm in
  the root README's hard problems: a server restart with 50 clients all retrying at 2 s makes it
  never recover.
- After a reconnect that merged remote changes, the app shows a **merge summary**: offline duration,
  count of remote operations applied, count of local operations kept. If any local change was in
  conflict, the affected shapes are briefly outlined so the user can see what happened. This is the
  honest UX for a CRDT: not "merged successfully", but "here is what changed and here is what
  survived".

### PWA

- `vite-plugin-pwa` with `injectManifest` strategy (a hand-written SW, because the precache manifest
  and the runtime caching rules are the interesting part).
- Precached: app shell, JS/CSS chunks, fonts. Everything content-hashed, `CacheFirst`.
- Never precached: `/api/**`, `/rooms/**`, anything carrying a token.
- See [10 Caching and CDN](./10-caching-and-cdn.md) for the full matrix.

---

## 6. Rendering performance engineering

| Technique | What it buys | Where |
|---|---|---|
| Viewport culling | Draw only visible shapes | §2 |
| Dirty-rect redraw | Repaint only what changed | §2 |
| 3 canvas layers | Presence churn does not touch the board | §2 |
| Typed arrays, zero allocation in the loop | No GC sawtooth | §2 |
| `Path2D` batching by style | One `fill()` for 500 same-style rects | renderer |
| Lazy Tiptap mounting | Bounded ProseMirror instance count | §4 |
| Structural digests for list components | Sidebars do not re-render on drags | §1 |
| Worker for spatial index rebuild | Removes 1.5 ms from the frame | §2 |
| `will-change` used sparingly, only on the drag layer | Avoids layer explosion | CSS |
| React `startTransition` for non-urgent UI | Keeps the canvas out of the scheduler's critical path | app |

---

## 7. Presence rendering

Separate canvas, rAF-driven, interpolation-based.

- Local cursor is drawn on the OS cursor, not on the canvas. Only remote cursors are rendered.
- Remote cursor positions are lerped at `0.25` per frame toward the last received target. At 20 Hz
  send and 60 Hz render this is smooth without flooding the network (the P5 bandwidth budget).
- A remote cursor that has not been updated for 10 s fades to 50% opacity, and disappears at 45 s.
  Stale ghost cursors are worse than no cursors.
- Selection outlines are dashed, 1.5 px, in the collaborator's colour, with their name label at the
  top-left of the bounding box.
- **Follow mode** writes the local viewport to match the followed peer's viewport, with a 0.15 lerp
  so it is not nauseating, and a clear "following Selam — press Esc to stop" banner. Any manual
  pan exits follow mode immediately.
- **Laser pointer:** a short-lived point stream (own awareness field, ~15 s TTL) rendered as a fading
  polyline. The fading is time-based, not frame-count-based, so it looks the same at 30 or 144 fps.

---

## 8. History and the timeline scrubber

Reading history must never disturb the live document. The implementation is explicit about this
because it is the easiest thing in the product to get wrong.

```
Timeline open
  → fetch snapshot index for the board (id, kind, label, author, created_at, byte size)
  → the live Y.Doc is untouched

Scrub to position p
  → load snapshot(p) into a SEPARATE Y.Doc (viewerDoc)
  → render viewerDoc read-only
  → the live Y.Doc keeps receiving remote updates; the client sees both

Exit scrub
  → drop viewerDoc, return to the live doc, re-render
```

- A full-board redraw from a snapshot must complete in < 100 ms. Snapshots are compact Yjs states,
  so `applyUpdate` is fast; the expensive part is the first paint of a large board, which the same
  culling path handles.
- Between snapshots, the scrubber can step through updates in order, applying them to `viewerDoc`
  with a time budget per frame and yielding. This is how a time-lapse replay works
  (root README §2.5) and it reuses the same code.
- Diff summary ("+5 shapes, 2 text edits") is computed server-side at snapshot time and stored, not
  computed in the browser.
- Restore is a POST that appends a forward update ([02 §9](./02-system-architecture.md#9-restore-semantics)).
  The UI states plainly: "This creates a new version. Nothing is deleted."
- While scrubbing, the UI is visibly in a read-only "viewing history" mode, with an obvious exit.
  A user who thinks they are editing the live board while looking at the past is a data-loss
  incident waiting to happen.

---

## 9. Routing, state in the URL, and deep links

| Route | Purpose |
|---|---|
| `/` | Landing: create a board, or open a recent one |
| `/b/:boardId` | The board. Accepts `?t=<shareToken>` and `#x,y,z` viewport |
| `/b/:boardId/v/:versionId` | Read-only view of a version |
| `/b/:boardId/versions` | Version list and restore UI |

- The **share token lives in the query string** because share links are the distribution mechanism.
  Its risks (browser history, `Referer`, screenshots) are handled in
  [06](./06-auth-and-permissions.md#token-transport-risks-and-mitigations) and [09](./09-security.md#secrets): on load the
  token is exchanged for a short-lived `HttpOnly` session cookie, then stripped from the URL with
  `history.replaceState`. The token is never in a path, never in a header we log, and never in
  localStorage.
- Viewport goes in the hash, throttled at 500 ms, so a link can open at a specific view without a
  round trip.
- The last 10 visited boards are kept in `localStorage` for the landing page. No document content is
  stored there — IndexedDB is the only place document state lives.

---

## 10. Accessibility

Not a checkbox, and not a lie on the accessibility page. Canvas applications have a real accessibility
story only if the underlying document is exposed as DOM.

| Concern | Approach |
|---|---|
| Screen readers | The shape list panel is a real, focusable, ARIA listbox of shapes with names derived from type, text content, and position. It is the accessible mirror of the canvas |
| Keyboard operation | Every action has a binding. Arrow keys nudge, `Enter` opens a shape's editor, `Tab` moves through the shape list |
| Focus visibility | 2 px focus ring, never removed, on every interactive element including the shape list |
| Contrast | All UI chrome meets 4.5:1. Canvas content is user-authored, so contrast is offered as a *guide*, not enforced |
| Reduced motion | `prefers-reduced-motion` disables cursor lerp, laser fade, and camera easing |
| Colour independence | Collaborator colours come from a colourblind-safe 8-colour set, and every collaborator has a **name label** as well as a colour |
| Editor semantics | ProseMirror output is semantic HTML. Export to Markdown inherits this |
| Live regions | Connection changes and merge summaries announce via `aria-live="polite"` |

---

## 11. Frontend testing seams

The design exists to make this possible. `packages/sim` drives all of it.

| Seam | Interface | Used by |
|---|---|---|
| Deterministic input | `sim` produces a `PointerEvent[]` timeline; a `useSimulatedPointer` hook replays it | E2E, perf harness |
| Time control | `now()` is injectable; the render loop and presence lerp read it | Frame-time tests, no flakiness |
| Geometry | All transform maths in `packages/schema` is pure, no DOM | Unit tests, 100% branch coverage expected |
| Renderer | The draw loop is a pure function of `(shapeArray, viewport, styleTable)` writing to a mock `CanvasRenderingContext2D` | Snapshot tests of draw order and counts |
| Provider | `CollabProvider` is an interface with `y-websocket` and a `SimulatedProvider` (in-memory, lossy, reorderable) implementation | Partition tests, Conflict Visualizer |

The `SimulatedProvider` is the important one: it lets a browser tab pretend the network is
partitioned, delayed, duplicated, or reordered, which is what powers both the automated partition
tests and the Conflict Visualizer.

## Acceptance

- [ ] p95 frame time < 16 ms with 5,000 shapes, measured in CI, not on a laptop
- [ ] Allocation rate in the draw loop is effectively zero (harness assertion)
- [ ] Pan, zoom, marquee-select, move, resize, and rotate are correct at 0.1× and 8× zoom
- [ ] Undo undoes only the local user's edits, and merges a word into one entry
- [ ] Editing works with the network blackholed, survives a reload, and merges on reconnect
      (**G2.** The G1 criterion is TTI from IndexedDB with no network in the path, since Phase 1 has
      no server. See [phase 1 design](./phase-1-design.md#g1-acceptance))
- [ ] 200 doc blocks on one board scroll and edit smoothly
- [ ] Concurrent typing in one paragraph converges (Phase 4 gate)
- [ ] Amharic input, rendering, and IME composition work on Windows and Linux
- [ ] The shape list panel is operable by keyboard and screen reader
      (**G2.** G1 covers full keyboard operation of the canvas instead. See
      [phase 1 design § G1 acceptance](./phase-1-design.md#g1-acceptance), and
      [§ Accessibility](./phase-1-design.md#accessibility) for why it is deferred)
- [ ] Time to first paint from IndexedDB < 1 s with the WS endpoint unreachable
      (**G2.** G1 is TTI from IndexedDB with no network in the path. See
      [phase 1 design § G1 acceptance](./phase-1-design.md#g1-acceptance))
