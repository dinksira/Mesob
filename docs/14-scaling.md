# 14 — Scaling

> **Status: draft** · Related: [07 Hosting](./07-hosting-and-cloud.md), [12 Monitoring](./12-monitoring-and-alerts.md), [05 Storage](./05-database-and-storage.md)
> **The question this document answers: what breaks first, what do we do about it, and how much does
> it cost?** Scaling a CRDT app is mostly about three resources — room memory, awareness
> fan-out, and update-log growth — plus the free-tier ceilings that come before all of them.

---

## Context

At portfolio scale the honest answer is "nothing breaks, and here are the measured numbers proving
it". That is a legitimate and publishable answer, but only if it is **backed by measurement** and by a
**written plan for the limits**. This document provides both: a measured capacity table, a
bottleneck map with the trigger that fires for each, and a migration path that is a real interface
rather than a rewrite.

---

## 1. Where the limits actually are

Ranked by which limit binds first on the shipping deployment.

| # | Resource | Limit | Binds at | Evidence |
|---|---|---|---|---|
| 1 | **Free-tier monthly hours** | Render/Koyeb free instance hours | Any sustained usage | Provider dashboard |
| 2 | **Instance memory** | 512 MB–1 GB shared | ~50 clients in one room, or ~40 idle rooms | k6 `L2`/`L3`, `mesob_memory_bytes` |
| 3 | **Sleep / cold start** | 15 min idle | Every quiet period | `mesob_process_uptime_seconds` resets |
| 4 | **Awareness fan-out** | O(n²) bytes | ~100 clients in one room | k6 `L4` |
| 5 | **Postgres storage** | 500 MB–1 GB free | ~50–100 active boards at steady state | Storage report job |
| 6 | **DB connections** | ~20 configured | Instance count × 5 | `pg_stat_activity` |
| 7 | **Room open latency** | Hydration time | ~100,000 uncompacted updates per board | k6 `L1`, `mesob_room_open_duration_seconds` |
| 8 | **Sentry events** | 5,000 / month | Any error loop | Quota check job |
| 9 | **R2 storage** | 10 GB | ~25,000 images | Storage report |
| 10 | **Canvas frame time** | 16 ms | ~5,000 visible shapes | Perf harness |

The ordering matters: the first two limits are **hosting-tier limits, not architectural ones**. That
is the honest finding, and it is a better thing to write about than a scaling diagram that never had
to be used.

---

## 2. Capacity table

Measured targets, with the k6 scenario that produces each number. This table is the published
evidence; the numbers in [01 §8](./01-system-design.md#8-success-metrics) come from here.

| Dimension | Comfortable | Tolerable | Degrades | Fails | Scenario |
|---|---|---|---|---|---|
| Clients, one room | 50 | 100 | 200 | > 200 (awareness) | `L2`, `L4` |
| Clients, all rooms | 200 | 400 | 600 | > 600 (memory) | `L7` |
| Active rooms in memory | 40 | 50 (`MAX_ROOMS_PER_INSTANCE`) | LRU eviction | — | `L7` |
| Shapes per board | 5,000 | 20,000 | 50,000 (soft limit) | — | Perf harness |
| Visible shapes per frame | 5,000 | 12,000 | 20,000 | — | Perf harness |
| Doc blocks live in the DOM | 20 | 50 | 100 (mount thrash) | — | `E2E22` |
| Doc blocks per board | 200 | 500 | — | — | `E2E22` |
| Updates per second, one room | 500 | 1,500 | 3,000 (flush lag) | — | `L3` |
| Updates before compaction | 500 | 2,000 (A12) | 10,000 (slow room open) | — | k6 + metrics |
| Boards, steady state | 1,000 | 2,000 | — | Storage cap | Storage report |
| Named versions per board | 50 | 200 | — | Storage cap | Storage report |
| Image bytes per board | 30 MB | 100 MB | — | 500 MB (A11) | Storage report |
| Pending unflushed bytes | 1 MB | 2 MB (A6) | 8 MB (forced flush) | — | `L3` |
| Concurrent exports | 2 | 4 | Queued | — | Manual |

**Comfortable / tolerable / degrades / fails** means: works with headroom / works, some latency /
works, visibly slower / breaks. Every cell needs a number from a k6 run before it is published, and
cells without a measurement are marked "target" rather than presented as results.

---

## 3. Bottleneck playbook

For each limit: how you detect it, what you do about it, and what it costs. Detection maps to the
alerts in [12 §5](./12-monitoring-and-alerts.md#5-alerts).

### 3.1 Room memory

**Detection:** `mesob_memory_bytes{rss}` above 85% of the instance limit (A8), `mesob_rooms_active`
at the cap, or `evictions_total` non-zero (A9).

**Response ladder, cheapest first:**

1. **Tighten idle eviction.** Drop the idle grace from 60 s to 30 s and the eviction window from
   10 min to 3 min. Most rooms are dead weight. *Cost: a quick refresh reloads the room (~200 ms).*
2. **Lower `MAX_ROOMS_PER_INSTANCE`.** Forces eviction before the OOM killer decides for you. *Cost:
   churn on a busy multi-board instance.*
3. **Split realtime from API into two instances.** The API is stateless and light; the realtime
   instance gets the whole budget. *Cost: two free instances, two cold starts, and the sticky-routing
   problem in §4.*
4. **Move the realtime tier to Durable Objects.** *Cost: the §6 port.*

**Never:** an unbounded room map. The OOM killer is not a scaling strategy, and on Render a killed
process is a user-visible disconnect.

**What actually drives memory:** the in-memory `Y.Doc` (tombstones and superseded values are
retained — this is P11 in [13](./13-testing.md#3-property-and-fuzz-testing)), plus one `Client` object
and awareness state per socket. At 5,000 shapes the doc is a few MB; 50 clients is a few MB more.
The dominant cost is usually **many idle rooms**, not one big room. That is why eviction is the first
lever.

### 3.2 Awareness fan-out (the O(n²) term)

**Detection:** `mesob_awareness_bytes_per_second` above the 2 KB/s budget; `backpressure_drops`
(A13); `L4` showing a 4× bandwidth increase from 50 to 100 clients.

**Why it is quadratic:** every cursor move by one client is broadcast to all others, so total
bandwidth is n × (n−1) × move-rate. At 20 Hz and 100 clients with a 100-byte payload, that is
~20 MB/s. It is the first thing to break and the reason the throttling in
[03 §7](./03-frontend.md#7-presence-rendering) is not optional.

**Response ladder:**

1. **Throttle harder.** Send at most every 100 ms (from 50), and only on change. Awareness is
   decorative; a cursor at 10 Hz interpolated to 60 fps looks identical. *Cost: nothing perceptible.*
2. **Drop stale clients from the broadcast set.** A cursor silent for 45 s is removed from fan-out.
   *Cost: a returning user's cursor has no interpolation origin, so it appears at once.*
3. **Downsample by role.** Viewers and Commenters do not need to see every cursor; send them a
   5 Hz summary, send Editors the full stream. *Cost: an asymmetry in what roles see, which is a real
   design decision, not just a config flag.*
4. **Aggregate cursors at high n.** Above 60 clients, send a cluster centroid per spatial bucket
   instead of individual cursors. *Cost: you lose individual identity above 60 people in one room,
   which is a genuine experience change.*

Items 1 and 2 are already implemented and cost nothing. Items 3 and 4 exist as a written plan for a
scale this project will not reach, which is the right amount of preparation.

**Also worth doing:** awareness is a `Y.Doc`-adjacent channel, and a common CRDT-app mistake is to
route it through the same broadcast path as document updates. They are separate here, so a presence
storm can never back up the document stream — and A13 is a distinct alert for that reason.

### 3.3 Update-log growth and compaction

**Detection:** `mesob_compaction_lag_updates` (A12), `document_bytes` (A11), storage report.

**Response:** compaction every 60 s or 500 updates, whichever comes first, is the default. If lag
exceeds 2,000:

1. Run compaction on demand for the affected board.
2. Lower the interval to 30 s for boards above a size threshold. *Cost: more CPU and more snapshot
   churn; snapshots are cheap relative to a slow room open.*
3. Investigate whether one client is generating an update loop — a bug that presents as a storage
   problem, and worth the dashboard panel that makes it obvious.

**The asymptote:** compaction bounds the *log*, not the *document*. A document that has been heavily
edited keeps growing (P11), because CRDTs retain superseded values and tombstones. This is inherent
to the design, not a bug, and it is why the published doc-growth chart
([01 §8](./01-system-design.md#8-success-metrics)) is one of the more honest artefacts in the
project. Beyond roughly 8 MB per board, room open slows noticeably, and the answer is a fresh
document with a migration note — a decision that belongs in the case study, not in a config file.

### 3.4 Room open latency

**Detection:** `mesob_room_open_duration_seconds` p95 (SLO), `L1`, `IT7`.

Hydration is `applyUpdate(snapshot)` then `applyUpdate(updates)`. It is CPU-bound and linear in the
log length. At 100,000 updates it exceeds 2 s.

**Response:** compact more aggressively (which is §3.3), or stream the load to the client so the
board paints before hydration completes. The second option is a genuinely interesting piece of work
and is **not** on the roadmap, because compaction alone keeps the log under 500 updates in practice.

### 3.5 Storage ceilings

**Detection:** A10 (80% of the free tier), the hourly storage report.

**Response, in order of preference:**

1. Tighten retention: autos from 30 days to 7, compaction snapshots from 3 to 1.
2. Lower the automatic snapshot cadence on quiet boards.
3. Delete boards a user archived more than 30 days ago (already the policy).
4. Accept a lower board ceiling and say so in the README.

**Never:** silently deleting a user's named version to make space. Named versions are the one thing
the user explicitly asked to keep, and losing them to save 4 MB is a bad trade in a project whose
entire thesis is "never loses anyone's edits".

### 3.6 Postgres connections

**Detection:** the connection-reaper job, `pg_stat_activity`, and the pool's own wait metric.

**Response:** the pooled Neon URL absorbs bursts, so this only binds with multiple instances. Then:
lower `DATABASE_POOL_MAX` per instance, and note that realtime and API pools are deliberately
separate ([05 §9](./05-database-and-storage.md#9-connection-budget)).

### 3.7 Canvas frame time

**Detection:** the perf harness in CI, the `mesob_render_frame_seconds` client metric, the
client-reported frame-time dashboard.

**Response ladder:** reduce the dirty-rect count; move the spatial index to a worker; drop presence
labels below a zoom threshold; virtualise the shape list; simplify the pen points; finally, switch to
a WebGL renderer (a stretch in the root README, not a plan).

**Design consequence, not a response:** the perf budget is a CI gate from Phase 1
([13 §9](./13-testing.md#9-performance-testing)). A performance regression is caught at the PR, so
this bottleneck is largely designed out rather than handled.

---

## 4. Horizontal scaling: adding a second instance

The first real scaling decision, and it is not free.

### The problem

Rooms are held in process memory. Two instances means a room's clients must all be on the same
instance, or updates split across a boundary that does not exist.

### The answer: sticky routing by board

```
Client opens /b/brd_x
  → the load balancer must route the WS upgrade for brd_x to instance 1
  → and every subsequent reconnect for brd_x must also reach instance 1
```

Options, in order of preference:

| Approach | How | Cost | Correctness |
|---|---|---|---|
| **Consistent hashing on `boardId`** | Hash the board id to a bucket; the balancer routes by bucket | Needs a routing layer that can hash (Cloudflare Load Balancing paid, or an nginx `hash $arg_board_id consistent;`) | Must survive a backend change. A rolling deploy reshuffles buckets |
| **Room registry in shared storage** | A KV/DB row per live room → instance id. The client asks the API which instance holds its board | One extra lookup per connect; a stale row after a crash | Robust, and the row self-heals on connect failure |
| **A single writer per room, with a fallback** | Anyone can accept a connect, and a redirect tells the client to retry against the holder | Extra round trip, retry loop complexity | Needs a leader-election tiebreak |
| **One instance** | — | The ceiling is one instance's memory | Trivially correct |

**Recommendation: one instance, plus the room registry.** Adding a second instance only when
`L7` shows a single instance is genuinely at capacity, and at that point the registry approach is
the one that will not lose a room during a deploy.

### What does *not* need to change

- **Authorization.** It is per-message and stateless ([06 §3](./06-auth-and-permissions.md#enforcement-point)).
  Any instance can enforce any role.
- **The REST API.** Already stateless.
- **Document state.** The Y.Doc is a replica. Any instance can serve any board.
- **Persistence.** Debounced flushes are per-room, so a room's writes are inherently single-writer
  once routing is fixed. `seq` is per-board, allocated by the holding instance, which is correct under
  sticky routing.
- **Compaction.** Already advisory-locked in Postgres, so two instances cannot both compact a board.
  The one thing to add: a compactor must not compact past a live room's `covered_seq`. Handled by the
  `covered_seq` check in [05 §5](./05-database-and-storage.md#5-compaction).

### What does need to change

| Change | Why |
|---|---|
| A room registry with heartbeats | Routing and crash recovery |
| Health checks per instance | The balancer needs a real signal |
| `DATABASE_URL` per instance | Already separate per platform service |
| Rate limiting becomes per-instance | Documented as best-effort in [04 §9](./04-api-and-backend.md#9-rate-limiting) |
| Metrics get an `instance` label | Necessary and safe: a bounded label set |
| Cross-instance awareness | Not needed: presence is room-scoped, and rooms are single-instance |

### The honest cost

Two free instances is still $0, so cost is not the objection. The objections are: two cold starts, a
routing layer that has to be right, and **harder load testing**, because k6 against a balancer with
sticky hashing is a different test from k6 against one process. `L7` in the load plan is written to
cover this case specifically.

---

## 5. Vertical scaling first

Before adding instances, spend what is free:

| Lever | Effect | Cost |
|---|---|---|
| Tighten idle eviction | Fewer resident rooms | A refresh reloads a room |
| Lower `MAX_ROOMS_PER_INSTANCE` | Hard cap, graceful degradation | Churn |
| Split realtime from API | Doubles the memory available to rooms | A routing change, and a second free instance |
| Raise awareness throttling | Cuts the O(n²) term by 2–4× | Imperceptible |
| Compact more often | Shorter logs, faster room open | CPU |
| Reduce automatic snapshot cadence | Less storage, less write volume | A coarser timeline |
| **Move to a bigger instance** | More RAM, more CPU | **$0 stops being true** — and this is where the free-tier constraint bites |

Everything above is free. A bigger instance is not, so the free tier *is* the scaling ceiling, and
saying so plainly is more useful than a diagram implying otherwise.

---

## 6. Breakout triggers to Option B

Concrete, measured triggers. When one of these is hit, the port in
[07 §Option B](./07-hosting-and-cloud.md#option-b-the-edge-native-port) becomes worth its 3–5 days.

| Trigger | Threshold | Why Option B fixes it |
|---|---|---|
| **Instance memory exhausted** | `rss` > 85% with eviction already tightened, for 7 days | DO hibernation makes idle rooms free; the entire memory problem moves to the platform |
| **Connection ceiling** | > 200 concurrent connections sustained, and a second instance would need sticky routing | Every board is an object; the "routing" problem does not exist |
| **Multi-region latency** | p95 > 400 ms for users outside the region, sustained | Global routing to a per-board object |
| **Idle-room cost dominates** | > 80% of resident rooms are idle | Hibernation |
| **Persistence engineering is the bug source** | Two or more data-loss incidents traced to the debounced-write path | DO storage is transactional and local; the whole class disappears |
| **The free tier is exhausted anyway** | Free instance hours are the binding limit, and DO free limits are confirmed sufficient | A different free tier |

**The negative trigger, stated explicitly:** do not migrate because it is more impressive. The
Option B analysis is the deliverable; the migration is optional, and shipping Option A with honest
measurements is a stronger portfolio than a half-finished edge port. If the port happens, it happens
because a trigger fired, and the write-up says which one and what the numbers were.

---

## 7. Multi-region and global scale (not on the roadmap)

Written down so the reasoning is available, with a clear statement that none of it is planned.

- **Yjs is not natively multi-region.** Two regions with a single logical document means either a
  single writer region (and the latency that implies) or a partition-tolerant merge (which Yjs is,
  but which costs convergence latency everywhere and makes the conflict story much harder to
  demonstrate). A single region with an honest latency number is the better product for a portfolio.
- **The natural sharding key is the board.** Boards are already independent documents with independent
  histories, so horizontal sharding is nearly free. The only cross-board query is the owner's board
  list, which lives in Postgres and can be sharded by `owner_id`.
- **A sharded design** would be: `boardId → shard` by a stable hash, one writer per board per shard
  region, Postgres row-level or schema-level sharding, and awareness scoped per board. The document
  layer needs no change at all, which is the strongest argument for the CRDT choice.
- **What breaks first in a true global design** is not the data layer. It is the realtime fan-out
  (a round trip per cursor update crosses an ocean) and the update-log write path (cross-region
  writes to one `board_updates` table). Both need regional write paths, which is a different system.

None of this is on the roadmap. It is written down so that "we designed for sharding from day one"
is a defensible claim rather than an aspiration, and so the seam is visible if the project ever
outgrows one region.

---

## 8. The published scaling story

The section of the case study that this document feeds. Six charts, each from a k6 run or a CI job,
each with the command that produced it:

1. **Update latency vs clients** (10/25/50/100) — `L2`, `L3`. p50/p95/p99. Flat, or it is not.
2. **Awareness bandwidth vs clients** (10/50/100) — `L4`. Shows the O(n²) term and how throttling
   bends it. The most interesting chart in the project.
3. **Server memory vs resident rooms** — `L7`. Shows idle rooms dominating, and the eviction knee.
4. **Document size over one hour of heavy editing, with and without compaction** — the P11 growth
   curve, with the compaction markers. The chart that makes a CRDT's real cost visible.
5. **Frame time vs visible shapes** (500/1k/5k/20k) — the perf harness, with the 16 ms line.
6. **Reconnect storm recovery** — `L5`. Time to full recovery for 100 clients, and why jittered
   backoff is in the client.

Each chart states the hardware, the provider, the commit SHA, and the free-tier caveats. A benchmark
without its environment is a number, and a number without its environment is not evidence.

## Acceptance

- [ ] Every cell in the capacity table is either a measured number with a scenario reference, or
      explicitly marked "target"
- [ ] `L1`–`L8` run, results are committed under `docs/benchmarks/`, and the six charts in §8 exist
- [ ] `L4` demonstrates the awareness-scaling behaviour, with or without throttling
- [ ] Memory-per-room and memory-per-client are measured, so eviction defaults are evidence-based
- [ ] The second-instance plan exists in §4 with the room-registry approach chosen
- [ ] The breakout triggers in §6 are specific, measured, and written down **before** they are needed
- [ ] The negative trigger is stated: the port is not done for show
- [ ] Storage headroom is projected at 3× the current board count, and the projection is published
- [ ] Every published number states its environment and commit SHA
