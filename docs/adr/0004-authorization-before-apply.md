# ADR-0004: Authorization happens before apply, on every message

- **Status:** Accepted
- **Date:** 2026-09-28
- **Covers:** D10 (authorization point), D11 (server authority for permissions)
- **References:** [06 §3](../06-auth-and-permissions.md#3-enforcement-point),
  [09 §1](../09-security.md#1-threat-model),
  [13 §3](../13-testing.md#5-integration-tests),
  [13 §5](../13-testing.md#5-integration-tests)

## Context

The threat model in [09 §1](../09-security.md#1-threat-model) is anchored on **TB3: the
authenticated but untrusted Viewer**. A Viewer holds a real, valid session token for a real board
and an open WebSocket. They are not an anonymous attacker, so TLS, session cookies, and token
expiry all pass. They are authorized to read. They are not authorized to write, and they will try.

Anyone with devtools can send arbitrary bytes down an open WebSocket. The question is what the
server does with them.

The alternative to authorizing inbound CRDT updates is to apply them and filter afterwards. This is
worth spelling out because it is genuinely tempting: the shapes are already in the doc, so "just
remove the ones this user isn't allowed to touch" sounds equivalent.

It is not. By the time a CRDT update has been applied, its content is merged into the shared
document and the other clients' state. Removing it afterwards means:

- The write already propagated to every connected replica, including the ones the Viewer cannot see.
- Removal is itself a CRDT operation, so a race exists between the Viewer's write and the cleanup.
  Anything written in that window survives.
- Awareness and presence are already correct, so the cleanup has to be selective per property, which
  means re-implementing a diff on data that has already been transformed by the merge.
- The result is a document that other clients' `UndoManager` instances have already recorded. The
  teardown produces undo entries that undo the *cleanup*, not the intrusion.

**A merged CRDT update is nearly impossible to un-merge.** Once content is in, "removing" it is
itself a CRDT write that other replicas converge on, and the original bytes are still in the
append-only log. Repair is not available.

## Decision

**The server validates every inbound message before it is applied to the room document, and the
enforcement point is a single module.**

- **One file, one guard.** A single `applyUpdate` wrapper in
  `apps/server/src/sync/apply.ts` is the *only* place `Y.applyUpdate` is called in the codebase.
  The capability check runs there, before the update reaches the document.
- **Every message.** Not on connect, not periodically. Every update, every awareness frame, every
  control message. A check that runs only at handshake is a check that fails on a role change.
- **The server holds the room document and is authoritative.** Viewers cannot write even with a
  patched client, because the client is not trusted to enforce anything it is not sent. `canWrite`
  in [06 §4](../06-auth-and-permissions.md#4-role-matrix) is data the server computes; the client
  only uses it to disable UI.
- **Role changes take effect on the next message.** A revoked socket keeps its read access until it
  reconnects, and its next write is rejected at the guard. This is PT10 in
  [13 §3](../13-testing.md#5-integration-tests), and the assertion is precise: *every write rejected
  at the guard, with a metric and no document change.*
- **The guard is enforced by CI, not by review.** An architecture test (`no-unguarded-apply.test.ts`)
  greps the source for `Y.applyUpdate` and fails the build if it appears outside the guard module.
  This is in [13 §5](../13-testing.md#5-integration-tests), and it exists because "remember to call
  the guard" is not a mechanism.

Capabilities are derived from a single `CAPABILITIES` matrix that also generates the [06 §4](../06-auth-and-permissions.md#4-role-matrix)
documentation table, so a role change cannot drift between the code and its documentation — drift is
a test failure.

Commenter writes are a second, separate path: they go to a `comments` table, not the document
([index Q4](../README.md#questions-pending-sign-off), D20). A Commenter never has document write
access to authorize in the first place.

## Consequences

**What this makes easy:**

- The security property is a single code path, so it can be reviewed once and tested once.
- Rejections are observable: a guard rejection logs `boardId`, `clientId`, `role`, `capability`
  ([11 §4](../11-error-tracking-and-logs.md#2-logging)) and increments a metric.
  An attempt to write without permission is a detectable event, not a silent no-op.
- The architecture test makes the guard self-enforcing. A new contributor cannot introduce a second
  unguarded write path without a red build, which is the only way a rule like this survives contact
  with a real codebase.
- The threat model stays honest. TB3 has a specific detection signal and a specific test, rather than
  a general claim that permissions are enforced.

**What this makes expensive:**

- **A check runs on every message.** That is the cost of the guarantee. It is small — a capability
  lookup and a boolean — but it is on the hot path, so the matrix is a frozen object rather than
  something recomputed per message.
- **The server must be a full participant in the merge, not a relay.** It holds the document,
  applies updates, and broadcasts. This is why the realtime tier is hand-rolled
  ([ADR-0005](./0005-hosting-option-a-first.md), D16): a framework that hid the apply path would hide
  the one place the security property lives.
- **Revocation is not instant.** A socket with a revoked role keeps reading until reconnect. Closing
  it proactively is possible and is deliberately not done in v1, because a push to a specific socket
  is a per-instance operation that does not survive horizontal scaling. This is a real, named gap,
  not an oversight, and it is the cost of Option A's in-process room map.
- **A rejected write has to be invisible to the CRDT.** This constrains [ADR-0002](./0002-shape-representation-and-z-order.md)
  and [ADR-0003](./0003-restore-is-a-forward-update.md): nothing may be written and then undone, even
  internally, because an undo is an operation other replicas see.

## Alternatives considered

**Filter after merge.** Rejected, for the reasons above, and because it is not a mitigation with a
known weakness — it is a design that cannot be made safe, only made rarer. A single enforcement
point that runs before the merge is the only version of this that is provably correct.

**Rely on the client to enforce.** Rejected. The client is the attacker's console. Everything the
client hides is a permission, and nothing the client hides is a control.

**Check permissions on a timer or on connect only.** Rejected because a role revoked after the
handshake would be enforced never. PT10 is the test that catches this, and the test name says what
it is for: *a Viewer's socket is fed an offline-then-online transition*.

**One Y.Doc per role, or a separate write document.** Rejected. It would make the CRDT the
authorization boundary, and a CRDT cannot enforce anything — it merges whatever it is given.

**Obfuscate the document for readers.** Rejected. Serialized binary updates cannot be filtered by a
reader without the key material, which would mean the document is unreadable to the server, and the
server is the component that must persist and compact it.
