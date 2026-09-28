# ADR-0003: Restore is a forward update, never a rollback

- **Status:** Accepted
- **Date:** 2026-09-28
- **Covers:** D12 (restore semantics)
- **References:** [02 §9](../02-system-architecture.md#9-restore-semantics),
  [05 §2](../05-database-and-storage.md#5-compaction),
  [13 §3](../13-testing.md#5-integration-tests),
  [13 §4](../13-testing.md#3-property-and-fuzz-testing)

## Context

A board is an append-only log of CRDT updates plus periodic snapshots
([02 §8](../02-system-architecture.md#8-persistence-flow)). Users can name a point in that history
and restore it. Restore is the operation most likely to corrupt a CRDT if implemented naively,
because it is the only operation that appears to go backwards in time.

The naive implementation is tempting and wrong. Load the old snapshot over the live document: clear
the shape map, insert the old shapes, broadcast. Two things go wrong.

**Other clients' UndoManager.** Yjs undo is scoped to the operations of a single client
([ADR-0002](./0002-shape-representation-and-z-order.md), D6). UndoManager tracks the document state
it has seen and computes an inverse. If a document is mutated by rewriting history, the inverse is
computed against a state that no longer exists, and the next undo a teammate presses can either
silently do nothing or resurrect content the restore was meant to remove. This is not a subtle
regression; it is the undo button becoming unpredictable.

**Concurrent writes lose to the restore.** A `Y.Map` delete is itself a CRDT operation that has to
win or lose against concurrent writes using the same machinery as any other operation. Producing a
delete for a shape that someone else just moved means arbitrating a tombstone against a live write.
That arbitration is the exact place CRDT-based restore implementations lose data, and the loss is
permanent because the operation is already merged.

There is also a question of what restore even *means* when it is genuinely forward. If it is a
forward update, then after restoring, the document contains both the restore and everything that
came before it, and a subsequent incremental update log grows to include the whole detour. That is
accepted, not worked around: it is the price of not corrupting anything.

## Decision

**Restoring a version is a new forward update attributed to the restoring user. The update log is
never truncated, and no document state is ever rewritten.**

The algorithm, from [02 §9](../02-system-architecture.md#9-restore-semantics):

1. Load `snapshot(vid)` into a temporary `Y.Doc` — `oldDoc`.
2. Load the current live document — `curDoc`.
3. Compute the delta that moves `curDoc` to `oldDoc`:
   - shape ids present now but absent then → set a tombstone/`lastDeleted` flag. **Do not remove the
     map key.**
   - changed properties → set the historical value.
   - shapes present then but missing now → insert the historical `Y.Map`.
   - text differences → apply as a `Y.XmlFragment` transaction.
4. Wrap step 3 in **one** transaction, attributed to the restoring user.
5. Broadcast as a normal update.
6. Write a `board_snapshots` row of `kind='named'`, `label='Restored from <vid> by <user>'`.

Step 3's refusal to delete keys is the heart of it. The safe formulation is *set every property to
its historical value and mark the shape deleted*, which converges exactly the way any other write
converges — through the machinery that is already tested. It is not a special case in the merge
logic, so it cannot be a source of special-case bugs.

Two invariants make this checkable rather than aspirational:

- `board_updates` row count is **monotonically non-decreasing** across a restore. P7 asserts a
  restore never removes entries from the update log.
- `doc → compact → reload` is byte-identical, and every historical snapshot still loads after a
  restore (P6, and PT6/PT12 in [13 §3](../13-testing.md#5-integration-tests)).

Restore requires the `owner` role ([04 §3](../04-api-and-backend.md#1-rest-api), 10/h per board), and
`canRestore` is a capability the server computes and the client only displays
([06 §4](../06-auth-and-permissions.md#4-role-matrix)).

## Consequences

**What this makes easy:**

- The restore path reuses the merge path. There is no second implementation, so it inherits the
  convergence property tests rather than needing its own.
- The version scrubber is honest. After a restore, scrolling to an earlier point in history shows
  that point exactly, because history was not rewritten.
- Undo stays predictable, because the document only ever receives forward operations.
- The user-visible story is comprehensible: "Restored from v3 by Dinksira, 2 minutes ago" appears in
  the same timeline as every other edit.

**What this makes expensive:**

- **A restore never shrinks anything.** The document keeps every shape it ever had, plus tombstones
  plus the restore transaction. Undo of a restore is itself a forward update. This is the accepted
  cost and it is unbounded in principle, bounded in practice by the 5,000-shape ceiling in
  [05 §5](../05-database-and-storage.md#8-capacity-math).
- **Tombstones accumulate.** Deleted-by-restore shapes stay in the map, which means the renderer's
  culling has to skip them on every frame rather than benefiting from their absence. The shape
  factory filters them, and the cost is measured in [14 §3.1](../14-scaling.md#31-room-memory).
- **A restore is not a shortcut back.** Users who assume "restore" means "discard everything after
  this point" will be surprised. The UI states that a restore is a new edit, not an undo of history.
  This is a product problem created by the correctness decision, and it is worth revisiting in Phase 3
  with real usage, not by weakening the invariant.
- **Delta computation is nontrivial**, and it is the part most likely to contain a bug. It is
  deliberately written as pure functions over two `Y.Doc`s, so it is testable without a server, a
  socket, or a database.

## Alternatives considered

**Truncate the update log and rewrite history.** Rejected outright. It is the intuitive
implementation, it is roughly ten lines, and it breaks teammate undo in a way that is not obviously
connected to the change that caused it. It also makes snapshots and the log disagree, so every
subsequent read has to pick a winner.

**Delete keys rather than tombstone.** Rejected because it converts a normal write into a
tombstone-vs-live-write arbitration, which is the specific operation that loses data. The tombstone
is one more property, and a property write is the one thing this system is good at.

**Restore as a new empty board, with a redirect.** Rejected because it discards shared history: the
link every teammate already has would point at a different document, and comments and share links
would need migrating. It also sidesteps the CRDT question instead of answering it, which is not
useful for a project whose purpose includes answering it.

**Defer restore to a later phase.** Rejected. Restore semantics constrain the schema, so deferring
the decision defers the schema. The `lastDeleted` property has to exist in v1 or v1 data needs a
migration later.
