# 12 — Monitoring and Alerts

> **Status: draft** · Related: [11 Errors and Logs](./11-error-tracking-and-logs.md), [14 Scaling](./14-scaling.md), [05 Storage](./05-database-and-storage.md)

## Context

Instrumentation for a portfolio demo has a different job than instrumentation for a product. It is
not "keep the pager quiet". It is three things:

1. **Keep the demo alive.** A public URL that is down when a reviewer visits is the worst outcome.
2. **Produce evidence.** The published benchmarks come from these pipelines, not from a laptop.
3. **Catch the failure modes unique to this architecture** — compaction lag, convergence, awareness
   fan-out — before a user has to describe them.

The dashboards here are the source of the numbers in
[01 §8](./01-system-design.md#8-success-metrics). If a metric is not on a dashboard, it is not being
managed.

---

## 1. Stack

| Concern | Choice | Notes |
|---|---|---|
| Metrics format | Prometheus exposition text, `/metrics` | In-process registry, no agent |
| Metrics server | A tiny HTTP server on a **separate port**, bound to `127.0.0.1` | Never public. The platform's metrics endpoint scrapes it, or a tunnel forwards to Grafana |
| Dashboards + alerting | **Grafana Cloud Free** | Metrics, dashboards, and alerting without running anything. Retention is the constraint |
| Uptime | **UptimeRobot**, 5-minute interval | Also drives the README badge |
| Logs | Platform log stream, queried in the platform UI | [11](./11-error-tracking-and-logs.md) |
| Errors | Sentry | [11](./11-error-tracking-and-logs.md) |
| Long-run storage of benchmark data | A JSON file committed under `docs/benchmarks/` | The published numbers are version-controlled, not a screenshot |

`prom-client` with a custom registry. No OpenTelemetry: it would be a second dependency for metrics
that a 12-line registry already handles, and the OTel story is a stretch if the realtime port to
Durable Objects ever happens ([07](./07-hosting-and-cloud.md#option-b-the-edge-native-port)).

---

## 2. Metrics

### Definitions

| Metric | Type | Labels | Why |
|---|---|---|---|
| `mesob_ws_connections_active` | gauge | `board` (bounded), `env` | Live socket count |
| `mesob_ws_connections_total` | counter | `env`, `outcome` | Connect attempts and results |
| `mesob_rooms_active` | gauge | `env` | Rooms hydrated in memory |
| `mesob_room_open_duration_seconds` | histogram | `env` | Time to hydrate. Leading indicator of DB or compaction trouble |
| `mesob_room_size` | gauge | `board` | Clients per room |
| `mesob_updates_received_total` | counter | `env`, `origin` | Inbound frames, by origin |
| `mesob_updates_applied_total` | counter | `env`, `result` | `applied` / `rejected` / `failed` |
| `mesob_update_bytes_total` | counter | `env`, `dir` | Network volume, in and out |
| `mesob_update_latency_seconds` | histogram | `env`, `stage` | `broadcast`, `apply`, `flush`. The p95 from the metrics table |
| `mesob_sync_messages_total` | counter | `env`, `type` | step1 / step2 / update |
| `mesob_awareness_messages_total` | counter | `env`, `action` | `sent`, `dropped_throttled`, `dropped_stale` |
| `mesob_awareness_bytes_per_second` | gauge | `env` | The P5 bandwidth budget |
| `mesob_backpressure_drops_total` | counter | `env`, `kind` | Slow clients. The capacity signal |
| `mesob_guard_rejections_total` | counter | `role`, `capability` | **Security signal.** A Viewer writing is a real event |
| `mesob_persist_flush_duration_seconds` | histogram | `env` | DB write health |
| `mesob_persist_flush_failures_total` | counter | `env` | **Pages** |
| `mesob_pending_update_bytes` | gauge | `board` | Unflushed data. A rising value means the DB is unhappy |
| `mesob_compaction_duration_seconds` | histogram | `env` | |
| `mesob_compaction_lag_updates` | gauge | — | Updates not yet compacted. Rising means the schedule is not keeping up |
| `mesob_document_bytes` | gauge | `board`, `kind` | Doc size over time. The chart in the metrics table |
| `mesob_snapshots_total` | counter | `kind` | auto / named / compaction |
| `mesob_http_requests_total` | counter | `route`, `method`, `status` | |
| `mesob_http_duration_seconds` | histogram | `route` | |
| `mesob_ratelimit_hits_total` | counter | `route` | |
| `mesob_memory_bytes` | gauge | `type` | `rss`, `heap`. The free-tier constraint |
| `mesob_process_uptime_seconds` | gauge | — | Detects restarts and cold starts |
| `mesob_convergence_checks_total` | counter | `result` | From the client: `match` / `mismatch`. **Mismatch pages** |

### Label discipline

Cardinality is the classic way to take down a Prometheus-compatible backend. Rules:

- **Never label by `boardId` on a counter.** A counter labelled per board is a time series per board,
  and 1,000 boards is 1,000 series per metric. Board labels exist only on **gauges** that are
  actively cleaned up on room close, and even there only for boards with more than 2 clients.
- **Never label by `clientId`, `userId`, `ip`, `shapeId`, or `requestId`.**
- Every label set is enumerated in a `labelValues` allowlist and asserted in a unit test. An
  undeclared label value throws in development.
- `route` is the Fastify route pattern (`/boards/:id`), never the concrete path.

This is a real discipline and the test is what keeps it: `metrics.test.ts` asserts that no label
value exceeds a cardinality cap and that no forbidden label name appears in the registry.

---

## 3. SLOs

Honest ones. These are the numbers the case study quotes.

| SLO | Target | Measurement | Window |
|---|---|---|---|
| **Realtime availability** | 99% of connections established successfully | 1 − (`ws_connections_total{outcome="error"}` / total) | 30 d rolling |
| **Update propagation latency** | p95 < 150 ms, p99 < 400 ms | `mesob_update_latency_seconds{stage="broadcast"}` | 7 d |
| **Room open** | p95 < 2 s | `mesob_room_open_duration_seconds` | 7 d |
| **Durability** | 100% of acknowledged updates persisted | Flush success + `E_DATA_LOSS` count == 0 | Since launch |
| **Convergence** | 100% of post-sync checks match | `mesob_convergence_checks_total{result="match"}` / total | Since launch |
| **Cold start to editable** | p95 < 3 s (includes instance wake) | Client TTI metric, bucketed by whether the socket connected on the first attempt | 30 d |
| **Error-free sessions** | > 99% | Sentry sessions without an error / total sessions | 7 d |
| **Restore correctness** | 100% of restores leave history intact | Restore invariant test + `board_updates` monotonic check | Since launch |

Two of these are SLOs in the strict sense (availability, latency); the rest are **invariants with
alerts**, which is the more appropriate framing for a property that must never be violated.

**The error budget is not spent.** There is no release cadence to gate on it at this scale, so the
budget exists only to inform judgement: if convergence checks have mismatched even once, something
is wrong enough to investigate regardless of how few users there are.

---

## 4. Dashboards

Five dashboards. Each answers one question a reader is likely to ask.

### 1 — Overview

The README in graph form. Panels:
- Uptime and connection success rate, 30 d
- p50 / p95 / p99 update propagation latency, with a 150 ms threshold line
- Active connections and active rooms
- Error rate (HTTP 5xx, WS errors, Sentry events)
- Cold starts per day
- Frame time p95 from the client
- Current release, with a marker line on each deploy

### 2 — Realtime deep dive

- Connections over time, split by outcome
- Room open duration percentiles, and a breakdown by `updatesReplayed`
- Fan-out cost: `update_bytes_total` ÷ `connections`, which is the O(n²) term made visible
- Backpressure drops and slow-client kicks
- Awareness bytes/second per client, with the 2 KB/s budget line
- Socket lifetime distribution
- Per-room size, top 10

### 3 — Persistence and storage

- Pending update bytes per board (a rising line is a problem before anything breaks)
- Flush duration and failure count
- Compaction lag and compaction duration
- **`document_bytes` over time, per board, split by kind** — the chart that becomes the published
  doc-growth graph, with and without compaction
- `board_updates` row count and total bytes (from the DB, scraped on a 1-minute job)
- Snapshots per board by kind
- Retention sweep: rows and bytes deleted, cumulative reclaimed

### 4 — Clients

- Sessions, errors per session, TTI
- Frame time percentiles by shape count (scatter: 1k / 5k / 20k)
- Reconnect attempts and reasons
- Merge summaries: offline duration distribution, remote vs local op counts, conflicts
- **Convergence check results** — a single large number. It should always read 100%
- Service worker install success, cache hit ratio, storage quota used
- Browser and OS breakdown

### 5 — Security

- Guard rejections by role and capability
- Auth failures by reason, share exchanges, revocations
- Rate-limit hits by route
- Upload rejections (type, size, magic-byte failures)
- Error-budget status against the SLOs

---

## 5. Alerts

Every alert has: a query, a threshold, a for-duration, a severity, a route, and a one-line runbook
link. An alert without a runbook is a notification, and notifications get ignored.

| # | Alert | Condition | For | Severity | Route | First action |
|---|---|---|---|---|---|---|
| A1 | Site down | UptimeRobot failing, 2 consecutive | 3 min | Page | Push + email | Check the deploy, roll back if the last deploy is suspect |
| A2 | Readiness failing | `/ready` 500 for 60% of probes | 5 min | Page | Push | Check DB reachability and migration state |
| A3 | **Convergence mismatch** | `rate(convergence_checks{result="mismatch"}[15m]) > 0` | 1 min | **Page** | Push + SMS | Freeze deploys. Capture a snapshot, reproduce with the op log |
| A4 | **Data loss detected** | any `E_DATA_LOSS` event | 1 min | **Page** | Push + SMS | Stop accepting writes on the board, investigate the flush path |
| A5 | Persist flush failures | `rate(flush_failures[5m]) > 0` | 2 min | Page | Push | Check the DB, check the pool, check the connection ceiling |
| A6 | Pending bytes growing | `pending_update_bytes` > 2 MB for one board, 10 min | 10 min | Warn | Slack | Check flush health; consider throttling that room |
| A7 | Update latency | p95 `update_latency{broadcast}` > 400 ms, 10 min | 10 min | Warn | Slack | Check fan-out cost and backpressure drops |
| A8 | Memory pressure | `rss` > 85% of the instance limit, 5 min | 5 min | Warn | Slack | Check room count; lower `MAX_ROOMS_PER_INSTANCE` |
| A9 | Room cap hit | `evictions_total` > 0, 5 min | 5 min | Warn | Slack | Confirm the instance is at capacity; see [14](./14-scaling.md) |
| A10 | Storage ceiling | DB size > 80% of the free tier | 1 h | Warn | Slack | Force a compaction pass, tighten retention |
| A11 | Doc size anomaly | `document_bytes` for one board > 8 MB | 30 min | Warn | Slack | Inspect for an update loop or a pathological board |
| A12 | Compaction lag | `compaction_lag_updates` > 2,000, 30 min | 30 min | Warn | Slack | Run a manual compaction, check the worker is alive |
| A13 | Backpressure drops | `rate(backpressure_drops[5m]) > 1/s` | 5 min | Warn | Slack | A client is saturating; check for a pathological update pattern |
| A14 | Guard rejection spike | `rate(guard_rejections[10m]) > 10` | 10 min | Warn | Slack | Someone is probing, or a client is buggy. Check the role distribution |
| A15 | Error rate | Sentry events > 20/hour | 10 min | Warn | Slack | Triage by fingerprint |
| A16 | Cold starts | `process_uptime` resets > 3 in an hour | 15 min | Info | Slack | Expected on free tiers; investigate if it is every few minutes |
| A17 | Rate-limit spike | `rate(ratelimit_hits[10m]) > 100` | 10 min | Info | Slack | Abuse or a client bug |
| A18 | Sentry dropping events | `sentry.events.dropped` > 0 | 15 min | Warn | Slack | Quota exhausted. Reduce sampling |
| A19 | SSL expiry | < 14 days | daily | Warn | Email | Renew |
| A20 | Storage quota on R2 | > 80% of 10 GB | 1 h | Warn | Slack | Run the orphan sweep, review the export lifecycle |

### Routing

| Severity | Channel | Rationale |
|---|---|---|
| Page | Push notification + SMS | A3, A4, A5, A1, A2. These mean data is at risk or the demo is down |
| Warn | Slack (or a Telegram channel) | Degradation worth knowing about during working hours |
| Info | Slack, digested | Expected on a free tier; a notification per cold start would train me to ignore alerts |

**Deliberate: no alert on frame time.** It is a budget, tracked on a dashboard, and enforced in CI
([13](./13-testing.md#9-performance-testing)). A page for a slightly slow frame on someone's laptop is
noise.

### Anti-fatigue rules

- Every alert has a `for` duration. No instantaneous pages.
- A3 and A4 have a `runbook:` annotation in the alert, so the notification itself says what to do.
- Alerts that fire more than three times a week get fixed or deleted. An alert nobody acts on is
  worse than no alert, because it makes the ones that matter invisible.
- A weekly review of what fired, what was actionable, and what should be deleted.

---

## 6. Health and readiness

| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /api/v1/health` | The process is running. No dependency checks. Always fast, never throws | UptimeRobot, the platform's liveness probe |
| `GET /api/v1/ready` | Config valid, migrations applied, DB reachable, R2 reachable, worker alive | The platform's readiness gate before routing traffic |
| `GET /api/v1/health/deep` | Plus: DB latency, pool saturation, room count, memory, compaction lag | A dashboard, not an uptime monitor |

Liveness and readiness are separate on purpose. A liveness check that touches the database will kill
the process when the database is briefly slow, which turns a dependency blip into an outage.

---

## 7. Client metrics

The client reports the same kinds of numbers, because half of what matters is only visible there.

| Metric | Reported | Notes |
|---|---|---|
| TTI from IndexedDB | every session | Bucketed by whether the socket connected first try, which separates cold-start cost from client cost |
| Frame time p95 | per session, **only when over budget** | Keeps the free-tier quota healthy |
| Visible / total shape count | with the frame metric | Makes a frame-time regression diagnosable |
| Reconnect attempt and reason | every reconnect | |
| Merge summary | every merge | offline duration, remote ops, local ops, conflicts |
| **Convergence check** | every sync | The highest-value client metric in the system |
| WebSocket round-trip time | sampled every 30 s | Cheap RTT probe independent of actual updates |
| Service worker state | on change | `installed`, `activated`, `updatefound` |
| Storage estimate | every 5 min | Quota pressure before eviction |

The client metrics pipeline is Sentry breadcrumbs plus a small `POST /api/v1/telemetry` endpoint
that accepts a batch and turns it into metrics. It is the one endpoint that accepts unauthenticated
writes, so it is aggressively rate-limited, size-capped, and validates against a Zod schema with a
strict allowlist of event kinds. An open ingest endpoint on a free tier is a denial-of-service
target, and pretending otherwise would be careless.

---

## 8. Maintenance jobs

Hourly, in one scheduled job, all idempotent:

| Job | Work | Logs |
|---|---|---|
| Retention sweep | [05 §6](./05-database-and-storage.md#6-retention) | Rows and bytes deleted |
| Session cleanup | Expired sessions and used share tokens | Count |
| Storage report | Row counts, table sizes, doc sizes | Emitted as metrics |
| Connection reaper | `pg_terminate_backend` for idle connections over 5 min | Count |
| Orphan sweep | R2 objects unreferenced after 24 h | Count and bytes |
| Quota check | Sentry event usage, log volume | Warning if > 80% |
| Vacuum analyse | `VACUUM (ANALYZE)` on `board_updates` and `board_snapshots` | Duration |

The hourly job takes a Postgres advisory lock so two instances cannot run it concurrently. Same
pattern as compaction, for the same reason.

## Acceptance

- [ ] `/metrics` is Prometheus-format, bound to localhost, and not publicly reachable
- [ ] Every metric in §2 is emitted, and a unit test enforces the label allowlist and cardinality cap
- [ ] Five dashboards exist with the panels in §4
- [ ] All 20 alerts are configured with a `for` duration, a severity, a route, and a runbook link
- [ ] A3 (convergence) and A4 (data loss) actually page, and the page has been tested
- [ ] Liveness does not touch the database; readiness does
- [ ] Client convergence checks are recorded after every sync and reported
- [ ] The telemetry ingest endpoint is rate-limited, size-capped, and schema-validated
- [ ] The hourly maintenance job is idempotent and advisory-locked
- [ ] The published benchmarks in `docs/benchmarks.md` are generated from these pipelines
