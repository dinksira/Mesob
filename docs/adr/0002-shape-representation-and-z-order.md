# ADR-0002: Shape representation and z-order

- **Status:** Accepted
- **Date:** 2026-09-28
- **Covers:** D3 (shape representation), D5 (z-order)
- **References:** [01 §6](../01-system-design.md#6-the-document-schema-system-design-view),
  [05 §3](../05-database-and-storage.md#3-document-schema-versioning),
  [13 §4](../13-testing.md#3-property-and-fuzz-testing)

## Context

[ADR-0001](./0001-crdt-merge-model-and-granularity.md) settled that a board is a Yjs document. It
did not settle how a shape is stored inside it, and the choice determines what happens when two
people edit the same shape at the same time.

The common case is not exotic. Two people select the same rectangle; one drags it, the other changes
its fill. Both actions must survive. This is the specific scenario that rules out the obvious
implementation.

A shape could be stored as:

- a **plain JSON value** in a `Y.Map` keyed by shape id;
- a **`Y.Map`** per shape, with each property as its own key;
- a **single serialized blob per shape** with an internal LWW timestamp.

The last two are really the same thing, and the third is the same failure as the first with extra
steps.

Z-order is a separate problem with a separate failure mode. Drawing order is naturally a list, and
"bring to front" is naturally a list mutation — but concurrent list mutations in a CRDT are where
data disappears. CRDT sequences handle concurrent inserts well and concurrent *removals and
reindexing* badly, because two clients removing index 3 each believe they preserved the relative
order of a list that has since shifted underneath them.

## Decision

**Every shape and every text block is a `Y.Map` in a parent `Y.Map`, with per-property last-write-wins.**

- `shapes : Y.Map<shapeId, Y.Map>` and `blocks : Y.Map<blockId, Y.Map>`.
- A plain object is never stored as a shape value. This is invariant 1 in
  [01 §6](../01-system-design.md#6-the-document-schema-system-design-view) and is asserted in code.
- Nested mutable structures that must merge independently — `style`, arrow `src` — are `Y.Map`s too.
- Text content inside a block is a `Y.XmlFragment` (D4), because a `Y.Map` string key is LWW and
  would destroy concurrent typing.

**Z-order is a fractional-index string per shape**, the `z` property. Reordering is a key write.
There is no shared array, therefore no index-shift race.

Two supporting rules:

- **Unknown keys are preserved, never stripped.** A newer client's extra properties survive a round
  trip through an older server. Stripping unknown keys would make a mixed-version deployment
  lossy, which is a far worse failure than the extra bytes.
- **`boardVersion` gates migrations.** A client that does not understand the board's version refuses
  to connect rather than guessing. See [05 §3](../05-database-and-storage.md#3-document-schema-versioning).

The fractional indexer is hand-rolled, roughly 60 lines ([index Q5](../README.md#questions-pending-sign-off)),
rather than pulled from a library, because a maintained library for this already exists and a
60-line implementation with a property test is a smaller liability than a dependency that stops
being maintained. It is a pure function of `(a, b)`, so it is directly fuzzable.

## Consequences

**What this makes easy:**

- Concurrent edits to different properties of the same shape both survive, because they are writes to
  different keys. The drag-plus-recolor case is the canonical example and it works with no special
  code.
- Reordering is O(1) on the client and one key write on the wire. "Send to back" is the same
  operation as "move".
- The shape schema is introspectable at runtime, which is what makes
  [13 §4](../13-testing.md#3-property-and-fuzz-testing) able to assert "every acknowledged operation is
  reflected in every replica" by comparing shape and text-content hashes.
- A single property's history is meaningful. Per-key clocks make "who changed the fill" answerable,
  which a blob cannot do.

**What this makes expensive:**

- **Property-level last-write-wins has no conflict UI.** If two people set the same property offline,
  one wins silently by clock. For most properties that is correct behavior and needs no UI. For a
  small set — notably `text` on a note, and anything with a comment attached — the design routes
  around it (via `Y.XmlFragment` or a separate table) rather than building a conflict resolver. This
  is a deliberate scope limit, and it is the honest answer: a general merge-conflict UI is a project
  in itself.
- **Many small updates instead of one large one.** Dragging a shape across the canvas produces a
  stream of `x`/`y` writes rather than a single final write. Throttling is required
  ([03 §3](../03-frontend.md#2-the-render-loop)) or the update log fills with sub-pixel changes.
  This is a real cost of the model, and it is a bandwidth cost, not a correctness one.
- **Y.Map iteration order is not z-order.** The renderer must sort by `z` on every frame, and cannot
  rely on any map's iteration order. A sorted view over the shape map is maintained in
  [03](../03-frontend.md#1-the-state-ownership-rule), and it is derived state — never written back.
- **Schema drift is possible by construction.** Because unknown keys are preserved, a client and
  server can disagree about a board's shape without either erroring loudly. `boardVersion` is the
  mitigation, and it is a coarse instrument: it catches version skew, not a rogue key.

## Alternatives considered

**Plain JSON object per shape.** Rejected, and this is the one that would have shipped by accident
because it is the most convenient to write. It looks correct until two people touch one shape:
Yjs replaces the whole value, so the drag and the recolour are one write, the loser's edit is
unrecoverable, and neither user is shown anything. The failure is silent and the data is already
merged. This is the same reasoning that makes
[ADR-0004](./0004-authorization-before-apply.md) reject post-hoc filtering.

**Array order for z-order.** Rejected because concurrent reorders are exactly the case CRDT
sequences handle worst, and because index maintenance means every other client's array shifts. A
"bring to front" that renumbers 400 shapes turns one user action into 400 writes. `z` strings make
it one.

**A single timestamp per shape with internal diffing.** Rejected: it re-implements LWW at a coarser
granularity and throws away per-property merge. Worse, it means the server must diff to detect what
changed, which is the same work the CRDT already does correctly.

**Numeric z with gap-and-refill.** Rejected in favour of strings because a numeric scheme eventually
needs a renumbering pass, and that pass is a distributed operation. Fractional strings never need
one; the cost is key length, which is bounded and tested (10,000 sequential appends staying ordered
and short is in the [13 §4](../13-testing.md#3-property-and-fuzz-testing) property list).

**A library for fractional indexing.** Rejected as a supply-chain preference, not a quality claim.
If the hand-rolled version needs a rewrite, this is the cheapest possible rewrite.
