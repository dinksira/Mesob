# 04 — API and Backend Logic

> **Status: draft** · Depends on: [02](./02-system-architecture.md) · Related: [05](./05-database-and-storage.md), [06](./06-auth-and-permissions.md), [09](./09-security.md)

## Context

Two servers' worth of logic: a long-lived WebSocket tier that owns rooms, and a request/response API
for everything that is *not* the document. The split is by nature of the data, not by convenience —
the document is a live shared state, everything else is a query.

---

## 1. REST API

### Conventions

- Base path `/api/v1`. Versioned from day one; a breaking change means a new prefix, and both run
  during migration.
- All bodies are JSON. All responses are JSON except binary export and image GETs.
- All requests and responses are validated with Zod schemas that live in `packages/shared` and are
  imported by both the client and the server. A type that only the server knows about is a bug
  waiting to be discovered by a user.
- Request IDs: the client may send `X-Request-Id`; the server generates one otherwise. It is echoed
  in the response, attached to every log line, and included in error envelopes. This is the thread
  that ties a user report to a log query.
- Idempotency: `POST` endpoints that create something accept `Idempotency-Key`. Replaying the key
  returns the original response instead of creating a second board or share link.

### Endpoints

| Method | Path | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| `POST` | `/api/v1/boards` | session | 20/h per user | Create a board; returns `{ boardId, role: 'owner' }` |
| `GET` | `/api/v1/boards/:id` | session + board role | 120/min | Metadata, role, capabilities, latest snapshot key |
| `PATCH` | `/api/v1/boards/:id` | owner | 30/min | Rename, archive |
| `DELETE` | `/api/v1/boards/:id` | owner | 5/h | Soft delete (tombstone row, retention sweep finishes it) |
| `GET` | `/api/v1/boards/:id/versions` | any role | 60/min | Snapshot index, newest first, paginated |
| `POST` | `/api/v1/boards/:id/versions` | editor+ | 30/h | Create a **named** version (flush + snapshot with a label) |
| `GET` | `/api/v1/boards/:id/versions/:vid/state` | any role | 60/min | Binary Yjs state for the scrubber, `ETag`-cacheable |
| `POST` | `/api/v1/boards/:id/versions/:vid/restore` | owner | 10/h | Restore as a new forward revision |
| `POST` | `/api/v1/boards/:id/shares` | owner | 50/day | Create a share link: `{ role, expiresIn }` |
| `GET` | `/api/v1/boards/:id/shares` | owner | 60/min | List shares (never the raw token) |
| `DELETE` | `/api/v1/shares/:id` | owner | 60/min | Revoke immediately |
| `GET` | `/api/v1/share/:token/exchange` | none (that *is* the auth) | 30/min | Exchange a share token for a session cookie, then burn the token |
| `POST` | `/api/v1/boards/:id/exports` | any role | 20/h | Queue an export; returns a job id |
| `GET` | `/api/v1/exports/:jobId` | session | 60/min | Export job status and download URL |
| `POST` | `/api/v1/uploads` | editor+ | 200/h | Presigned R2 upload, then `PUT` directly from the browser |
| `POST` | `/api/v1/boards/:id/comments` | commenter+ | 100/h | Create a comment anchored to a shape or text range |
| `GET` | `/api/v1/health` | none | none | Liveness: process is up |
| `GET` | `/api/v1/ready` | none | 10/min | Readiness: DB reachable, migrations applied, config valid |
| `GET` | `/api/v1/health/deep` | none | 10/min | Diagnostics for dashboards: DB latency, pool saturation, room count, memory, compaction lag ([12 §6](./12-monitoring-and-alerts.md#6-health-and-readiness)) |
| `POST` | `/api/v1/telemetry` | none | 60/min | Batched client metrics. The only unauthenticated write path, so it is aggressively rate-limited, size-capped and schema-validated ([12 §7](./12-monitoring-and-alerts.md#7-client-metrics)) |

### Response envelope

Success returns the resource directly. Errors are uniform:

```json
{
  "error": {
    "code": "SHARE_EXPIRED",
    "message": "This share link expired on 2026-03-01.",
    "details": { "expiredAt": "2026-03-01T00:00:00Z" },
    "requestId": "req_01HQ…"
  }
}
```

`code` is a stable enum from `packages/shared/src/error-codes.ts` and is what the client switches on.
`message` is for humans and may be localised or improved at any time; **no client behaviour may
depend on `message`**. This distinction is worth stating because it is the usual reason a client ends
up with a brittle string comparison.

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Schema validation failed; `details` lists the issues |
| `UNAUTHENTICATED` | 401 | No or unusable credentials |
| `FORBIDDEN` | 403 | Authenticated, but the role does not permit this |
| `NOT_FOUND` | 404 | Missing, or hidden because the caller cannot see it |
| `CONFLICT` | 409 | Idempotency key reuse with a different body, or a state conflict |
| `PAYLOAD_TOO_LARGE` | 413 | Over a declared size cap |
| `RATE_LIMITED` | 429 | Includes `Retry-After` |
| `UNSUPPORTED_SCHEMA_VERSION` | 422 | Client cannot read this board's document schema |
| `INTERNAL` | 500 | Never leak a message; `requestId` is the only handle |

A `403` on a resource the caller cannot even see is deliberately a `404`, so the API does not
enumerate private boards.

### Pagination

Cursor-based, never offset. `?cursor=<opaque>&limit=50`, response `{ items, nextCursor }`. Versions
are the main paginated resource and they are append-only, so a keyset cursor on `(created_at, id)`
is stable while new versions are being written.

### Caching

`ETag` on `GET /boards/:id` and version state endpoints. The client sends `If-None-Match` and gets a
`304`. Full matrix in [10](./10-caching-and-cdn.md).

---

## 2. Realtime server

### Startup and lifecycle

```ts
const server = http.createServer(healthHandler)
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

server.on('upgrade', (req, socket, head) => {
  // 1. parse URL: /rooms/:boardId?token=…
  // 2. origin allowlist check            → 403 if not our Pages domain
  // 3. rate limit by IP                  → 429 + close if over
  // 4. verify token, load role           → close 4401 if invalid/expired
  // 5. check board schema version        → ctl:error UNSUPPORTED_SCHEMA_VERSION
  // 6. wss.handleUpgrade
})

// graceful shutdown, in order:
SIGTERM →
  1. stop accepting new connections (503 on upgrade)
  2. send ctl:kick reason='server-restart' to every client
  3. flush every room's pending updates to Postgres  (with a hard 8s deadline)
  4. close sockets, close wss, drain HTTP, close the pg pool
  5. exit 0
```

Step 3 is the one that matters. Render and Koyeb both send `SIGTERM` and then kill the process after
a grace period, so a flush that respects an 8-second deadline either commits or is cleanly lost with
no partial write. A half-written batch is worse than a lost batch, because a lost batch means the
client re-sends on reconnect and a half-written batch means nothing does.

### The room

```ts
class Room {
  boardId: string
  doc: Y.Doc
  snapshotVersion: number        // which snapshot this doc was hydrated from
  pending: Uint8Array[]          // unflushed updates
  pendingBytes: number
  pendingSince: number
  lastFlushAt: number
  clients: Map<ConnId, Conn>
  awareness: Map<clientId, AwarenessState>
  idleSince: number | null
  stateVectorCache: Uint8Array   // invalidated on applyUpdate
}
```

Two implementation details that are easy to get wrong and expensive to debug:

1. **`stateVectorCache` must be invalidated on every `applyUpdate`.** A stale state vector makes the
   server believe the client already has updates it does not, and the divergence is silent. Caching
   it correctly saves recomputing a state vector on every connect, which matters for reconnect
   storms.
2. **Updates are buffered per room, not per client.** Batching is what turns 60 updates/second into
   one multi-row `INSERT` every 2 seconds. Without it, a busy board generates thousands of round
   trips and the database, not the app, becomes the bottleneck.

### Per-message handling

```ts
onMessage(conn, raw) {
  if (raw.byteLength > MAX_FRAME_BYTES) → close 1009

  switch (raw[0]) {
    case MESSAGE_SYNC:
      // guard BEFORE any read or write of the doc
      const canWrite = guard.canWrite(conn.role)
      readSyncMessage(raw, encoder, decoder, conn, doc)
      if (appliedSomething) {
        room.markDirty()
        room.broadcastToOthers(conn, raw)
        room.invalidateStateVector()
      }

    case MESSAGE_AWARENESS:
      if (!guard.canRead(conn.role)) return
      room.applyAwareness(conn, decodeAwareness(raw))
      room.broadcastAwareness(raw)     // throttled batch

    case CONTROL:
      handleControl(conn, decodeCtl(raw))   // hello, ping, stats, devtools

    default:
      conn.sendCtl('error', { code: 'UNKNOWN_MESSAGE_TYPE' })   // do not close
  }
}
```

`MAX_FRAME_BYTES` is 256 KB. A legitimate update is tens of bytes; a large text paste is a few
kilobytes. 256 KB is generous and stops a single client from streaming a memory exhaustion attack
through the socket.

### Fan-out

- Binary `Buffer` reuse: the room keeps a scratch buffer and calls `socket.send(buffer, { binary: true })`.
  Node's `ws` supports `SharedArrayBuffer` views; using them avoids one copy per recipient, which
  matters at 50 clients × 20 updates/second.
- One `send` per client per batch, coalescing multiple updates in the same tick.
- Backpressure: if `socket.bufferedAmount > 1 MB`, skip awareness for that socket; if it stays above
  for 5 s, `ctl:kick reason='too-slow'` and let the client re-sync from its state vector.
- Cursors are never broadcast to clients that cannot see the board, obviously, and are dropped
  entirely for sockets whose role has changed.

### Connection and role lifecycle

```
connect → ctl:hello → (server validates boardVersion) → ctl:role → sync → awareness
                                    │
                                    ├─ share revoked  → ctl:kick 'revoked' + close 4403
                                    ├─ token expired  → ctl:kick 'expired'  + close 4401
                                    └─ owner demoted  → ctl:role with the new, lower role
                                                                (downgrade, never upgrade)
```

Role changes are pushed. A user whose access is revoked mid-session is disconnected within seconds
rather than holding a write-capable socket until they happen to reconnect. The E2E test for this is
in [13](./13-testing.md#7-security-tests) and it is not optional.

---

## 3. Persistence loop

| Concern | Implementation |
|---|---|
| Flush trigger | Debounce 2 s, or 256 KB buffered, or 500 updates, or room idle-eviction, or shutdown |
| Flush query | One `INSERT INTO board_updates (board_id, client_id, update, seq) SELECT … FROM unnest($1::bytea[])` — a single statement, a single round trip |
| Ordering | A per-room monotonic `seq` in the same transaction as the insert, so retries are detectable and ordering is provable |
| Transaction | Flushed batches are transactional; a partial batch is impossible |
| Retry | 3 attempts, exponential backoff with jitter. On exhaustion, mark the room `degraded`, keep buffering, emit an alert, and refuse new write connections to that board rather than silently losing edits |
| Snapshot on open | First client to open a room triggers a snapshot of the current state so the log has a checkpoint, then replay |
| Compaction | Every 60 s, per board where `updates since last compaction > 500`. Details in [05](./05-database-and-storage.md#5-compaction) |

---

## 4. Versions

| Operation | Path | Notes |
|---|---|---|
| Auto snapshot | Background, every 5 min for boards with active rooms | `kind='auto'`, no label |
| Activity snapshot | On room open, and on a named-version request | `kind='auto'`, acts as a checkpoint |
| Named version | `POST /versions` with `{ label }` | `kind='named'`, author attributed |
| Compaction | Background | `kind='compaction'`, plus the `board_updates` it absorbed |
| Retention | 7 days for `auto`, forever for `named` and `compaction` | Sweep in [05](./05-database-and-storage.md#6-retention) |

**Diff summary** is computed at snapshot time and stored in the row:

```sql
ALTER TABLE board_snapshots ADD COLUMN diff_summary jsonb;
-- { "shapesAdded": 5, "shapesRemoved": 0, "propsChanged": 12, "textEdits": 2, "bytesDelta": 4096 }
```

Computing it during the flush (when both the old and new states are in memory) is nearly free.
Computing it on read would require decoding two snapshots per version row in the list endpoint,
which is exactly the kind of accidental O(n²) that makes a list endpoint slow.

**Restore** implements the forward-update algorithm in [02 §9](./02-system-architecture.md#9-restore-semantics).
The route is owner-only because it rewrites the visible state of the board for everyone. The
response returns the new version id, and the client shows: "Restored. 5 shapes were changed, 2 text
edits. This is a new version — nothing was deleted."

---

## 5. Export

Three formats, three very different implementations, and the Markdown one is the honest one.

| Format | Implementation | Notes |
|---|---|---|
| **SVG** | Walk the shape array, emit real SVG nodes | Vector, text stays text, deterministic output, no headless browser. The default |
| **PNG** | Render to `OffscreenCanvas` in Node (`@napi-rs/canvas`) at a chosen scale, `toBlob` → R2 | Requires a Node canvas binding; it is a native dep, so it lives in a separate workspace package and is optional |
| **Markdown** | Walk shapes and blocks: block content → Markdown via Tiptap/ProseMirror's serializer, sticky notes → headings or list items, grouped by spatial clustering | Genuinely useful, and it falls out of the semantic document model |

- Exports are **jobs**, not synchronous requests. `POST /exports` enqueues, a worker processes, and
  the client polls or uses SSE-free polling at 1 Hz. A 5,000-shape PNG takes seconds, which would
  time out a free-tier HTTP request.
- R2 keys: `exports/{boardId}/{exportId}.{ext}`. Signed GET URLs, 1 hour expiry, `Content-Disposition:
  attachment`.
- Export reads a **snapshot**, not the live doc, so the output is deterministic and an export in
  progress is not affected by a user drawing while it runs.

---

## 6. Uploads

- Client requests a presigned `PUT` with `{ contentType, bytes }` after the server has checked the
  role and the size cap (10 MB).
- The server enforces the cap by issuing a presigned policy with `content-length-range`; the browser
  `PUT`s directly to R2, so 10 MB never passes through the free-tier Node instance. This matters:
  a free instance has limited memory and limited request duration.
- On `PUT` success, the client writes only `imageKey` into the shape. The data URL is discarded
  ([index Q6](./README.md#questions-pending-sign-off)).
- Content-type is validated against an allowlist (`png`, `jpeg`, `gif`, `webp`) and the magic bytes
  are checked server-side before the key is trusted. Never trust a client-declared content type.
- Orphans (uploaded but never referenced) are swept after 24 h by a lifecycle rule.

---

## 7. Comments

A separate table, deliberately (D20). A Commenter must not have write access to the CRDT, so a
comment cannot be a doc structure.

```sql
comments (
  id, board_id,
  anchor_shape_id  text null,
  anchor_text      jsonb null,   -- { blockId, from, to, quotedText }
  author_id, author_name, author_color,
  body             text,
  resolved         boolean default false,
  resolved_by, resolved_at,
  created_at, updated_at
)
```

Anchors resolve **at read time**: if `anchor_shape_id` no longer exists, the comment is returned with
`anchorState: 'orphaned'` and shown in a "3 comments on deleted items" tray rather than hidden. The
same question as connectors in [03 §3](./03-frontend.md#3-interaction-and-tools): a dangling reference
gets an honest presentation, not a silent delete.

---

## 8. Configuration

All env vars validated at boot with Zod. **Invalid config crashes the process immediately** with a
clear message. A server that boots with a broken config and fails on the first request is a much
worse incident than a server that is plainly down.

| Var | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | — | `production` in deployed envs |
| `PORT` | yes | — | Render/Koyeb inject this; never hardcode |
| `DATABASE_URL` | yes | — | Pooled URL in production, direct for migrations |
| `DATABASE_POOL_MAX` | no | 5 | Must fit the free tier's connection limit; see [05](./05-database-and-storage.md#9-connection-budget) |
| `JWT_SECRET` | yes | — | 32+ bytes, from platform secrets, never in the repo |
| `PUBLIC_ORIGIN` | yes | — | Exact frontend origin; drives CORS and the WS origin check |
| `ALLOWED_ORIGINS` | no | `PUBLIC_ORIGIN` | Comma-separated, for preview deploys |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | for uploads/exports | — | |
| `SENTRY_DSN` | prod only | — | Absent locally; the SDK is a no-op without it |
| `LOG_LEVEL` | no | `info` | `debug` locally, `warn`/`error` in prod to save quota |
| `METRICS_ENABLED` | no | `true` | `/metrics` on a separate port, bound to localhost in prod |
| `MAX_ROOMS_PER_INSTANCE` | no | 50 | Evicts LRU idle rooms; see [14](./14-scaling.md) |
| `AWARENESS_THROTTLE_MS` | no | 50 | Presence send interval |
| `COMPACTION_INTERVAL_MS` | no | 60000 | |
| `EXPORT_ENABLED` | no | `true` | Off on instances without a canvas binding |

Two config rules worth writing down:

- **Config is read once at boot and frozen.** Reading `process.env` deep in the code is how a
  variable ends up different in two places.
- **`LOG_LEVEL` defaults to `info` and prod uses `warn`.** Log volume on a free tier costs money and
  fills log storage. Detail is in [11](./11-error-tracking-and-logs.md).

---

## 9. Rate limiting

Token bucket in memory, per instance. Redis is not in the stack because the entire rate limit budget
is "a handful of demo users", and the honest thing is to say so rather than to build a distributed
limiter for traffic that will never arrive. If a second instance ever appears, the limiter becomes
best-effort per instance and the note in [14](./14-scaling.md) says so.

| Scope | Limit | Rationale |
|---|---|---|
| WS upgrade per IP | 20 / 5 min | Stops connection floods |
| `POST /boards` per user | 20 / h | Stops board-spam |
| `POST /shares` per owner | 50 / day | Prevents link-spam on a public board |
| `POST /versions` per board | 30 / h | Prevents snapshot-table bloat |
| `POST /exports` per user | 20 / h | Export is CPU and storage |
| `POST /uploads` per user | 200 / h | R2 cost |
| **`POST /telemetry` per IP** | **60 / min** | Unauthenticated ingest, so the strictest write limit in the system. Also size-capped and schema-validated |
| `GET /health/deep` per IP | 10 / min | Diagnostics are not a public API and must not be scrapeable |
| All other reads | 120 / min | Abuse ceiling, generous on purpose |

Responses include `Retry-After` and `X-RateLimit-Remaining`. A `429` from a share-link visitor is
normal and must not look like an error in the UI.

## Acceptance

- [ ] Every endpoint has a Zod schema shared with the client, and an integration test
- [ ] A Viewer cannot write through any of: REST, a forged WS frame, or a replayed token
- [ ] A revoked token kills a live session within 5 s
- [ ] `SIGTERM` flushes pending updates and exits 0, verified by killing the process under load and
      asserting zero acknowledged-but-lost updates
- [ ] Flushing 10,000 updates produces 10,000 rows in `board_updates` and no partial batches
- [ ] 50 simulated clients in one room with p95 latency and memory measured
- [ ] Exports of all three formats work and are deterministic for a given snapshot
- [ ] Invalid env vars crash at boot with an actionable message
- [ ] Rate limits are enforced and observable in metrics
