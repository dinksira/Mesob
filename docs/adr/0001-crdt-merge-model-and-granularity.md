# ADR-0001: CRDT merge model and document granularity

- **Status:** Accepted
- **Date:** 2026-09-28
- **Covers:** D1 (merge model), D2 (granularity)
- **References:** [01 §5](../01-system-design.md#5-key-design-decisions),
  [02 §6](../02-system-architecture.md#6-the-sync-protocol),
  [02 §3](../02-system-architecture.md#3-state-ownership),
  [13 §4](../13-testing.md#3-property-and-fuzz-testing)

## Context

Mesob is a canvas where two or more people edit the same board at the same time, and where either
of them can lose their connection at any moment. That second property is the one that constrains
everything. A board edited by a user on a train with intermittent signal will be rejoined
mid-intent, and the merge that happens on reconnection is the entire product.

So the question is not "how do we make concurrent edits rare." They are not rare; they are the normal
case. The question is what happens when two clients have both acted and neither has seen the other.

There are two well-trodden answers:

- **Operational transformation.** Every server and client can apply OT if they see operations in the
  same order. This needs a central authority to assign that order, and it needs every participant to
  receive every intermediate operation. Transform functions themselves are famously subtle, and the
  standard algorithms for text assume a single continuous session that reconnects cleanly.

- **A CRDT.** Operations commute and are idempotent, so any delivery order converges to the same
  state. There is no central referee, no total order to assign, and reconnection is just "send me
  what I missed."

A third option, storing one blob and resolving conflicts last-write-wins, was never seriously in
contention: it silently destroys a user's edit whenever two people touch the same object, and on a
shared canvas two people touching the same object is the normal interaction, not the edge case.

Once CRDT is chosen, a second decision follows from it and is recorded here because it is equally
expensive to reverse: **what is the unit of merging?** One document per board, or one per shape.

## Decision

**One CRDT document per board, using Yjs.**

The root is a `Y.Map` with three keys — `meta`, `shapes`, `blocks` — as specified in
[01 §6](../01-system-design.md#6-the-document-schema-system-design-view). Every shape inside is
itself a `Y.Map`, never a plain object (this is D3, recorded separately in
[ADR-0002](./0002-shape-representation-and-z-order.md), but it is a consequence of this decision).

Three properties of this choice are load-bearing and are treated as invariants:

1. **A board is the unit of sync, the unit of persistence, and the unit of authorization.** One
   room, one `board_updates` log, one permission check per socket.
2. **Reconnection requires no reconciliation logic.** An offline client replays its IndexedDB log
   and the CRDT converges. There is no diff-to-apply phase, which is where offline-first systems
   usually accumulate bugs.
3. **Text is a `Y.XmlFragment`, not a string.** A plain string in a `Y.Map` is last-write-wins per
   key, which means two people typing in the same paragraph lose one of the two edits. This is the
   specific failure that makes a CRDT choice matter for a document, rather than merely for shapes.

Delivery is WebSocket with binary frames (D8), and presence rides on Yjs Awareness and is never
persisted (D7), so cursor traffic cannot enter the update log.

## Consequences

**What this makes easy:**

- Offline editing is the same code path as online editing. There is no separate "sync" mode.
- Horizontal scaling of the realtime tier is a routing problem, not a merge problem. Two instances
  can hold two boards, or the same board, and the result is the same.
- The correctness argument is testable rather than rhetorical. Convergence is a property that
  [13 §4](../13-testing.md#3-property-and-fuzz-testing) can assert directly: apply the same operations
  in 50 delivery orders, compare encoded states byte for byte. That is P1 and P2.
- Conflicts are inspectable. Because the state is a set of CRDT operations, the Conflict Visualizer
  can show what actually happened rather than a diff invented after the fact.

**What this makes expensive:**

- **Document growth is monotonic.** Updates accumulate and never shrink. Compaction
  ([02 §8](../02-system-architecture.md#8-persistence-flow)) reduces the *stored* representation, but
  the append-only log only grows. P11 asserts this so the cost is a known quantity rather than a
  production surprise.
- **The client holds the whole board.** Memory and load time scale with document size, which is the
  direct cause of the cold-start and time-to-first-shape numbers in
  [12 §6](../12-monitoring-and-alerts.md#6-health-and-readiness). Culling and virtualization
  ([03 §3](../03-frontend.md#2-the-render-loop)) are not premature optimization; they are
  required.
- **Awareness fan-out is O(n²).** Every client broadcasts presence to every other client. At 40
  users that is 1,600 messages per update cycle. This is the dominant bandwidth term and gets its
  own analysis in [14 §3.2](../14-scaling.md#32-awareness-fan-out-the-on-term).
- **A Yjs document is opaque to SQL.** It cannot be queried for "shapes created last week," so
  anything that genuinely needs a relational query lives in a normal table instead. Comments are in
  a table for exactly this reason (D20).
- **Bundle cost.** Yjs plus `y-prosemirror` plus ProseMirror is a meaningful share of the client
  bundle, on a project whose only frontend is one page. This was accepted, not overlooked.

## Alternatives considered

**Operational transformation.** Rejected because the central ordering authority it requires is in
direct tension with the offline requirement, and because transform-function correctness is hard to
fuzz in the way CRDT convergence is. P2 (50 random delivery orders) is a test that essentially
cannot be written for a well-behaved OT implementation, because OT's correctness depends on the
transformation functions *and* on every client having the same history in the same order. The
convergence property is also the more valuable artifact: it is what a reader can verify.

**One CRDT document per shape.** Rejected for three reasons. Ordering bugs appear the moment two
shapes interact — an arrow anchored to an ellipse is a cross-shape dependency, and there is no
natural total order across independently merging documents. A single shape move, the most common
edit, would sync as a whole-document update. And authorization granularity gets worse, not better:
a per-shape document has no natural place to enforce "this Viewer may not write to this board."

**A plain object per shape inside a single document.** Rejected, and recorded as
[ADR-0002](./0002-shape-representation-and-z-order.md) because it is a different decision with a
different failure mode.

**Automerge.** Genuinely viable, and the closest alternative. Rejected on bundle size and on
ecosystem fit: Yjs has the better-maintained ProseMirror binding (`y-prosemirror`) and a mature
awareness implementation, and Mesob needs rich text more than it needs Automerge's history model.
If `y-prosemirror` were abandoned, this should be reopened — the reasoning is about ecosystem, not
about CRDTs.

**A hand-rolled CRDT.** Rejected. The convergence property is the one thing that must be right, and
it is the one thing that is extremely hard to get right. `packages/sim`
([D18](../01-system-design.md#5-key-design-decisions)) is the answer to "how do we demonstrate CRDT
understanding" — it is a test harness and visualizer built *around* a library, not a reimplementation
of the algorithm.
