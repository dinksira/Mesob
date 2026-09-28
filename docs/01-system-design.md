# 01 — System Design

> **Status: draft** · Owners: solo · Last updated: project kickoff

## Context

Mesob is a portfolio flagship, not a product with a paying user base. That single fact changes almost
every engineering decision downstream: the system must be **provably correct** rather than merely
useful, **cheap to run** rather than merely scalable, and **explainable in a case study** rather than
merely fast. This document fixes what we are building, what we are explicitly not building, and the
thresholds that decide whether the design is working.

Everything here is a *design contract*. Implementation details belong in
[02](./02-system-architecture.md) and later documents.

---

## 1. Product definition

**One sentence:** a shared infinite canvas where shapes and full rich-text document blocks live in a
single CRDT, so multiple people can draw, write, and merge offline with no lost edits and no central
referee.

**The one-sentence test for any feature:** does it make the board more obviously a *shared* surface?
If a feature works identically with one person, it is a lower priority than presence, sync, and
history, no matter how polished it is.

### Core loop

1. Open a shared link → board renders from IndexedDB in under a second, before the socket connects.
2. Draw, type, move, delete. Edits apply locally, always.
3. See other people: cursors, selections, follow mode.
4. Lose the network. Keep working. See "you were offline for 12 min".
5. Reconnect → the merge is automatic, and the Conflict Visualizer can replay exactly how it resolved.
6. Scrub back through history, restore an earlier board *as a new revision*. History is never rewritten.

---

## 2. Goals

Ordered. When two goals conflict, the lower number wins.

| # | Goal | How it is measured |
|---|---|---|
| G1 | **Convergence.** Every replica reaches byte-identical state regardless of operation order, duplication, or delay. | 10,000+ fuzz runs green; all replicas' encoded states hash equal ([13](./13-testing.md#3-property-and-fuzz-testing)) |
| G2 | **No lost edits.** An edit acknowledged to a user is never silently dropped, including across partitions, reloads, and server restarts. | Partition test suite green; no data-loss bug escapes to production (Sentry + user reports) |
| G3 | **Offline-first, genuinely.** The app is fully usable with the network unavailable, and merges correctly on return. | Manual test: airplane mode for 15 min, edit, reconnect, all changes present and attributed |
| G4 | **60fps interaction at realistic board size.** Pan, zoom, select, and drag stay smooth with 5,000 shapes. | Frame time p95 < 16ms with culling, measured in a perf harness ([13](./13-testing.md#9-performance-testing)) |
| G5 | **Correctness in permissions.** A Viewer physically cannot write to a document, even by crafting binary frames. | Security test: Viewer sends a write update, server rejects and does not apply ([06](./06-auth-and-permissions.md#enforcement-point)) |
| G6 | **Explainable.** Every hard decision has an ADR; the hardest bug has a written post-mortem. | 4–5 ADRs, a threat model, a benchmarks page, one case study |
| G7 | **Runs at zero cost.** The whole system lives on free tiers. | Deployment documented in [07](./07-hosting-and-cloud.md) with measured ceilings |

### Non-goals for v1

Explicitly out. Each is a deliberate omission, not an oversight.

| Non-goal | Why |
|---|---|
| Server-side rendering of the canvas | The canvas is client-owned. SSR buys nothing and would fight the CRDT. |
| Multi-region active/active | One region. Latency is a real limitation we document, not solve. |
| Voice / video / WebRTC | Stretch only ([root README §14](../README.md#14-stretch-ideas)) |
| Comments and mentions | Stretch. Schema is designed to allow it, UI is not built. |
| Public template gallery | Stretch. |
| Full-text search across boards | Stretch. Requires an index outside the CRDT. |
| Drawing with perfect pressure/ink fidelity | Freehand ink is a polyline, not a full ink engine. |
| Mobile-first design | The canvas is pointer-and-keyboard shaped. Tablet is a stretch. |
| Automerge support | Comparison is a written essay, not a second implementation. |
| Enterprise identity (SSO, SCIM, SAML) | Contradicts the free-tier and small-surface goals. |

---

## 3. Users and roles

Three personas, and they are what the whole permission model is built around.

| Persona | Needs | Role they get |
|---|---|---|
| **Facilitator** | Runs a workshop, controls the board, protects the structure | Owner |
| **Participant** | Adds ideas fast, sees others working, can't break the board | Editor or Commenter |
| **Observer** | Watches, maybe leaves a note, cannot alter the artifact | Viewer or Commenter |

Roles are defined in [06](./06-auth-and-permissions.md). At the system-design level, the rule is:
**a role is a capability bundle, and capabilities are checked at exactly one place — the server, per
message.** UI gating is a courtesy, never a control.

### Identity

v1 is **guest-first**: a display name and a colour are enough to collaborate. Sign-in (GitHub OAuth)
is a stretch that upgrades a guest to a durable identity so boards can be listed under an owner.
Rationale in [06](./06-auth-and-permissions.md#1-identity-model).

---

## 4. Non-functional requirements

Targets, not aspirations. Every row has a test in [13](./13-testing.md) or a dashboard in
[12](./12-monitoring-and-alerts.md).

### Performance

| ID | Requirement | Target | Notes |
|---|---|---|---|
| P1 | Update propagation latency, same region, p95 | < 150 ms | Client-timestamped, measured over WS round trip |
| P2 | Interaction frame time, 5,000 shapes | p95 < 16 ms | Canvas 2D, viewport culling, dirty-rect redraw |
| P3 | Time to interactive from a cold start | < 1 s | From IndexedDB; does not wait on the network |
| P4 | Memory per room at 20 clients | < 200 MB | Tracked in [12](./12-monitoring-and-alerts.md) |
| P5 | Awareness bandwidth | < 2 KB/s per client at rest | Throttled to 30 Hz send, interpolated render |
| P6 | Board load API (metadata + snapshot) | < 100 ms | Excludes update replay, which is separately budgeted |

### Reliability

| ID | Requirement | Target | Notes |
|---|---|---|---|
| R1 | Update durability | Zero acknowledged-then-lost updates | Server fsync policy in [05](./05-database-and-storage.md#durability-policy) |
| R2 | Room recovery after server restart | < 5 s, zero data loss | Snapshot + update replay |
| R3 | Availability | 99% monthly is acceptable | Honest free-tier target; a sleeping instance is a *documented* outage mode, not a hidden one |
| R4 | Reconnect | Exponential backoff with jitter, gives up and tells the user | Never an infinite silent retry loop |

### Security

| ID | Requirement | Target | Notes |
|---|---|---|---|
| S1 | Write authorization | Enforced server-side on every message type | [06](./06-auth-and-permissions.md#enforcement-point) |
| S2 | Token lifetime | Share tokens expire; default 30 days, max 90 | [06](./06-auth-and-permissions.md#2-token-model) |
| S3 | Secret exposure | Zero secrets in repo, logs, or URLs | [09](./09-security.md#secrets) |
| S4 | Input size limits | Hard caps on WS frame size, image size, document size | [09](./09-security.md#resource-exhaustion) |

### Scale (see [14](./14-scaling.md) for the full table)

| ID | Requirement | Target | Notes |
|---|---|---|---|
| C1 | Concurrent editors per room | 50 tested, 100 tolerated | k6 evidence published |
| C2 | Total concurrent connections | ~200 across all rooms | Comfortably inside a free tier |
| C3 | Shapes per board | 5,000 smooth, 20,000 functional | Degrades in frame time, not correctness |
| C4 | Boards | 1,000+ | Storage, not traffic, is the limit |

### Portability

| ID | Requirement | Target | Notes |
|---|---|---|---|
| T1 | The realtime tier is swappable | Node `ws` and Cloudflare Durable Objects behind one interface | [07](./07-hosting-and-cloud.md#option-b-the-edge-native-port) is a port, not a rewrite |
| T2 | The document schema is portable | One schema package, versioned, with migrations | [05](./05-database-and-storage.md#3-document-schema-versioning) |
| T3 | No service is a single point of knowledge | Run the whole stack locally with `pnpm dev` and Docker Compose | Test suite depends on it |

---

## 5. Key design decisions

The seed list from the root README, expanded. Each of these becomes an ADR before its code lands.

| # | Decision | Choice | Why | Rejected alternatives |
|---|---|---|---|---|
| D1 | Merge model | **CRDT (Yjs)** | Convergence without a central referee is the product. Offline merge is free. | OT (needs a central ordering authority, breaks offline); last-write-wins on a blob (loses character-level text merges) |
| D2 | Granularity | **One CRDT document per board** | One room, one truth, one sync protocol. Simple mental model. | One doc per shape (N sync channels, ordering bugs across shapes) |
| D3 | Shape representation | **`Y.Map<shapeId, Y.Map>`**, per-property LWW | Concurrent move + recolor of the same shape both survive. | Single serialized JSON value (one user's change silently destroys the other's) |
| D4 | Text representation | **`Y.XmlFragment`** via `y-prosemirror` | Character-level merge; per-user undo | Plain string in a Y.Map (last-write-wins destroys concurrent typing) |
| D5 | Z-order | **Fractional indexing string** per shape | Reordering becomes a key write, not an array splice; no index conflicts | Array order (concurrent reorders corrupt the array) |
| D6 | Undo | **`Y.UndoManager` scoped to local clientID** | You only undo your own edits. Non-negotiable for a shared canvas. | Global undo stack (undoing a teammate's work feels broken) |
| D7 | Presence | **Yjs Awareness, ephemeral, never persisted** | Cursors must not enter the document or they become permanent cruft | Storing cursors in the doc (pollutes history, bloats snapshots) |
| D8 | Transport | **WebSocket, binary frames** | Small frequent updates; a WebSocket carries both sync and awareness | Polling (latency and bandwidth), SSE (client→server is the wrong direction) |
| D9 | Persistence | **Append-only update log + periodic compaction to a snapshot** | Replay is trivial, history falls out for free, simple to reason about | Store only snapshots (loses history and gets slow to reconstruct); store only updates (unbounded growth) |
| D10 | Authorization point | **Before applying the update, on every message** | A merged CRDT update is nearly impossible to un-merge. Prevent, don't repair. | Post-hoc filtering of shapes (races, gaps, and it already polluted the doc) |
| D11 | Server authority for permissions | **Server holds the room doc and validates inbound updates** | Viewers cannot write even with a patched client | Trust the client (any single user can corrupt a board) |
| D12 | Restore semantics | **Restore is a forward update, never a rollback** | History is append-only; a rollback would fork causality and break other clients' UndoManager | Rewriting history, deleting future updates |
| D13 | UI state | **Zustand for ephemeral UI; document state lives only in Yjs** | One source of truth per concern. No mirrored doc state to go stale. | Redux/MobX mirror of the doc (guaranteed drift bugs) |
| D14 | Rendering | **HTML Canvas 2D, hand-written renderer** | Full control of culling and the draw loop; shows real systems skill | Konva/Fabric (fast to start, hides exactly the parts worth demonstrating); WebGL (stretch only) |
| D15 | Rich text engine | **Tiptap** | Best-maintained ProseMirror binding for Yjs; batteries included | Lexical (good, weaker Yjs story); contenteditable (writing a text editor is not the point) |
| D16 | Realtime server | **Hand-rolled Node + `ws`**, not Hocuspocus | The auth and persistence loop *are* the case study; a framework would hide them | Hocuspocus (sensible, but it hides the interesting part) |
| D17 | Hosting | **Option A** (Pages + Render/Koyeb + Neon + R2), Option B documented | Ship first. Free tiers sleep, and that constraint is itself material for the case study. | Option B first (more impressive on paper, higher risk of not shipping) |
| D18 | Testing core | **`packages/sim` shared by fuzz tests and the Conflict Visualizer** | One investment, two deliverables. The visualizer is a *real* consumer of the simulator, so it cannot rot. | Separate toy visualizer (drifts from the tested code) |
| D19 | Schema location | **One `packages/schema` owning the Yjs doc shape and the Postgres shape** | Prevents the "server and client disagree about the document" class of bug | Schemas duplicated per app (guaranteed drift) |
| D20 | Comments | **Separate table, not CRDT content** | A Commenter must not be able to write to the doc. Anchors are references into the doc, resolved at read time. | Comments as doc content (requires write access, pollutes history) |

---

## 6. The document schema (system-design view)

One Y.Doc per board. The root is a `Y.Map` keyed `meta`, `shapes`, and `blocks`.

```
Y.Doc
└── root : Y.Map
    ├── meta : Y.Map
    │     ├── title : string
    │     ├── createdAt : number
    │     └── boardVersion : number          (schema version, see 05)
    ├── shapes : Y.Map<shapeId, Y.Map>
    │     └── shape : Y.Map
    │           ├── type : 'rect' | 'ellipse' | 'note' | 'text' | 'arrow' | 'pen' | 'image'
    │           ├── x, y : number
    │           ├── w, h : number
    │           ├── rotation : number
    │           ├── z : string                (fractional index)
    │           ├── style : Y.Map             (fill, stroke, strokeWidth, opacity)
    │           ├── text : string             (for note/text)
    │           ├── points : Array<number>    (for pen)
    │           ├── src : Y.Map               (for arrow: shapeId anchors)
    │           ├── imageKey : string          (for image: object-storage key)
    │           └── createdBy : clientID
    └── blocks : Y.Map<blockId, Y.Map>
          └── block : Y.Map
                ├── x, y, w : number
                ├── z : string
                ├── content : Y.XmlFragment   (ProseMirror content, shared)
                └── createdBy : clientID
```

Invariants (asserted in code and in tests):

1. Every `shapes` and `blocks` value is a `Y.Map`, never a plain object. Plain objects are replaced
   wholesale on write and break D3.
2. `z` is always a valid fractional index and unique within its sibling map.
3. `imageKey` is never a raw data URL in persisted state (Q6 in [index](./README.md#open-questions)).
4. Unknown keys are preserved, never stripped, so a newer client is not broken by an older server.
5. `boardVersion` gates migrations. A client that does not understand the board's version refuses
   to connect rather than corrupting it.

---

## 7. Risk register

Risks with real mitigations, not "be careful" entries. Reviewed at every phase gate.

| ID | Risk | Likelihood | Impact | Mitigation | Owner of the mitigation |
|---|---|---|---|---|---|
| K1 | Free-tier instance sleeps mid-demo, killing the WebSocket | High | High | Documented cold-start design ([07](./07-hosting-and-cloud.md#cold-start-mitigation)); UptimeRobot keep-warm; demo video is the fallback artifact; never demo live-only | 07 |
| K2 | Realtime server outgrows one instance (memory, connections) | Medium | High | Provider-agnostic room interface (T1); a second instance is a config change, not a rewrite | 14 |
| K3 | Postgres free-tier storage cap hit by update logs | Medium | High | Compaction from day one; aggressive retention on `board_updates`; a board size dashboard with an alert at 80% | 05 |
| K4 | Canvas performance collapses on a big board | Medium | Medium | Culling, spatial index, dirty rects from Phase 1; perf harness in CI so regressions are caught early | 03 |
| K5 | An authorization hole lets a Viewer write | Low | Critical | Single enforcement point, deny by default, plus an adversarial test that forges a Viewer write frame | 06, 09 |
| K6 | Yjs doc grows unboundedly, snapshots get slow | Medium | Medium | Measure and publish doc-size-over-time with/without compaction; threshold alerts | 05, 12 |
| K7 | Scope creep into a Miro clone | High | High | The one-sentence test in §2; non-goals list is binding; features that fail it are deferred | solo |
| K8 | Time-travel scrubber is a performance trap (replaying thousands of updates per frame) | Medium | Medium | Scrub reads snapshots, not updates; budget 100ms per scrub frame; precompute a version index | 03, 04 |
| K9 | Awareness fan-out is O(n²) and kills the server at 50 clients | Medium | High | Throttle, batch, drop stale clients, cap per-room awareness bytes; k6 evidence at 50 and 100 | 12, 13 |
| K10 | A dependency goes unmaintained (this ecosystem churns) | Medium | Medium | Minimal dependency surface; the doc layer depends only on Yjs and y-prosemirror; Dependabot on | 08 |
| K11 | Amharic (Ethiopic) text metrics are wrong, breaking layout in doc blocks | Medium | Low | Font stack with a real Ethiopic family; explicit input testing on Windows and Linux; measure with Playwright screenshots | 03 |
| K12 | The project is not finished in 8 weeks | Medium | High | Phase gates; each phase independently demoable; the demo script degrades gracefully if a late feature is missing | solo |
| K13 | Sentry/logs leak a share token via a URL | Low | Critical | Tokens never in URLs at rest, redacted in logs, `Referrer-Policy` set, short TTL | 09, 11 |
| K14 | Restore semantics confuse users or corrupt the doc | Medium | High | Restore is a forward update (D12); property test asserting history is append-only across a restore | 05, 13 |

---

## 8. Success metrics

These land in the root README's metrics table. Baselines are recorded at G1 so later numbers mean
something.

| Metric | Target | Baseline recorded at |
|---|---|---|
| p95 update propagation, same region | < 150 ms | G2 |
| Concurrent editors per room, tested | 50+ | G3 |
| Convergence fuzz runs passing | 10,000+ | G6 |
| Frame time at 5,000 shapes | p95 < 16 ms with culling | G1 |
| Doc size after 1h of heavy editing, with/without compaction | measured and charted | G6 |
| Time to interactive from IndexedDB | < 1 s | G1 |
| Awareness bandwidth per client at rest | < 2 KB/s | G3 |
| Peak memory per room at 20 clients | < 200 MB | G3 |
| Total monthly cost | $0 | G6 |

A metric without a published number is not a metric. If a target is missed, publish the real number
and explain it. A missed target with an honest explanation is senior; a missed target presented as a
success is not.

---

## 9. Design process

1. **Week 0, before code:** write ADRs for D1, D2, D3, D12, D10. These are the ones that are expensive
   to reverse.
2. **Every phase gate:** re-read the risk register, update likelihood and impact, note what changed.
3. **Every bug that costs more than 4 hours:** write it up. That write-up becomes the case study
   ([root README §13](../README.md#13-portfolio-deliverables-checklist)).
4. **Every "we will handle that later":** if it survives two phase gates, it becomes a non-goal or a
   stretch item, not a debt.

## Acceptance

System design is done when:

- [ ] Goals and non-goals are agreed and no new feature in the roadmap fails the one-sentence test
- [ ] Every "Decision" row has an ADR in `docs/adr/` before the dependent code lands
- [ ] All 14 risks have a named mitigation with a location in these docs
- [ ] Every NFR has a measurement method and a home dashboard
- [ ] The 8 open questions in the [index](./README.md#open-questions) are answered
