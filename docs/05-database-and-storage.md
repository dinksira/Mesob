# 05 — Database and Storage

> **Status: draft** · Depends on: [02](./02-system-architecture.md), [04](./04-api-and-backend.md) · Related: [14 Scaling](./14-scaling.md)

## Context

The durable side of the system. Postgres holds an append-only log of CRDT updates plus compacted
snapshots; object storage holds images and exports. The design goal is that **a board can always be
reconstructed**, and that the reconstruction is fast. Everything else is secondary.

---

## 1. Choosing the store

| Store | Role | Why |
|---|---|---|
| **Neon Postgres** (Option A) | Everything durable: boards, update log, snapshots, shares, comments, users | Serverless Postgres, branching for PR previews, a free tier that fits. Chosen over Supabase because we want branching and no vendor auth coupling (Q1) |
| **R2** (Option A) | Images and exports | Zero egress fees, S3-compatible, free tier |
| **IndexedDB** (browser) | Local replica | Offline-first requirement |
| **Redis** | Not used | Nothing in the design needs shared ephemeral state at this scale. Stated explicitly so its absence is a decision ([01 D-list](./01-system-design.md#5-key-design-decisions)) |

Durable Objects storage is the Option B equivalent of the last two rows; see
[07 §Option B](./07-hosting-and-cloud.md#option-b-the-edge-native-port).

---

## 2. Schema

Full DDL. This is the authoritative version; `packages/db/migrations/*.sql` is generated from it.

```sql
-- ── boards ────────────────────────────────────────────────────────────────
CREATE TABLE boards (
  id            text PRIMARY KEY,                    -- brd_<cuid>
  title         text        NOT NULL DEFAULT 'Untitled board',
  owner_id      text,                                -- nullable: guest boards
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz,
  schema_version integer     NOT NULL DEFAULT 1,
  status        text        NOT NULL DEFAULT 'active',  -- active | deleted
  deleted_at    timestamptz,
  CONSTRAINT boards_status_check CHECK (status IN ('active','deleted'))
);
CREATE INDEX boards_owner_idx    ON boards (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX boards_recent_idx   ON boards (updated_at DESC) WHERE status = 'active';

-- ── board_updates: append-only log ───────────────────────────────────────
CREATE TABLE board_updates (
  id         bigserial PRIMARY KEY,
  board_id   text        NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  update     bytea       NOT NULL,
  client_id  text        NOT NULL,
  seq        bigint      NOT NULL,                  -- per-board monotonic, set by the server
  kind       text        NOT NULL DEFAULT 'update', -- update | restore | named-version
  author_id  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_updates_kind_check CHECK (kind IN ('update','restore','named-version'))
);
CREATE UNIQUE INDEX board_updates_seq_idx ON board_updates (board_id, seq);
CREATE INDEX board_updates_replay_idx ON board_updates (board_id, id);

-- ── board_snapshots: compacted state + history checkpoints ────────────────
CREATE TABLE board_snapshots (
  id             bigserial PRIMARY KEY,
  board_id       text        NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  state          bytea       NOT NULL,               -- full Yjs state (Y.mergeUpdates of the log)
  state_vector   bytea       NOT NULL,               -- Y.encodeStateVector of `state`
  kind           text        NOT NULL,               -- auto | named | compaction
  label          text,
  author_id      text,
  author_name    text,
  diff_summary   jsonb,
  bytes          integer     NOT NULL,
  updates_absorbed bigint    NOT NULL DEFAULT 0,
  covered_seq    bigint      NOT NULL,               -- all updates with seq <= this are absorbed
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_snapshots_kind_check CHECK (kind IN ('auto','named','compaction'))
);
-- Exactly one compaction snapshot is the live head per board.
CREATE UNIQUE INDEX board_snapshots_head_idx
  ON board_snapshots (board_id) WHERE kind = 'compaction';
CREATE INDEX board_snapshots_list_idx ON board_snapshots (board_id, created_at DESC);
CREATE INDEX board_snapshots_created_idx ON board_snapshots (created_at DESC);

-- ── shares ────────────────────────────────────────────────────────────────
CREATE TABLE shares (
  id          text PRIMARY KEY,                       -- shr_<cuid>
  board_id    text        NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  role        text        NOT NULL,                   -- owner | editor | commenter | viewer
  token_hash  bytea       NOT NULL,                   -- scrypt/argon2 of the token, never the token
  label       text,                                   -- "Selam's link", for the owner's own tracking
  created_by  text,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count   integer     NOT NULL DEFAULT 0,
  CONSTRAINT shares_role_check CHECK (role IN ('owner','editor','commenter','viewer'))
);
CREATE UNIQUE INDEX shares_token_idx ON shares (token_hash);
CREATE INDEX shares_board_idx ON shares (board_id) WHERE revoked_at IS NULL;

-- ── users (optional / stretch) ───────────────────────────────────────────
CREATE TABLE users (
  id           text PRIMARY KEY,
  github_id    text UNIQUE,
  name         text NOT NULL,
  email        text UNIQUE,
  avatar_color text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── comments (stretch) ────────────────────────────────────────────────────
CREATE TABLE comments (
  id             text PRIMARY KEY,
  board_id       text        NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  anchor_shape_id text,
  anchor_text    jsonb,
  author_id      text,
  author_name    text        NOT NULL,
  author_color   text        NOT NULL,
  body           text        NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  resolved       boolean     NOT NULL DEFAULT false,
  resolved_by    text,
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_board_idx   ON comments (board_id, created_at);
CREATE INDEX comments_anchor_idx  ON comments (board_id, anchor_shape_id) WHERE anchor_shape_id IS NOT NULL;
```

### ID format

`prefix_cuid2`. Prefixed so an ID is self-describing in a log line, a URL, and a stack trace. CUID2
because it is short, collision-free, sortable, and URL-safe. Never reuse an ID, and never derive one
from user input.

### Why `board_updates` has both `id` and `seq`

`id` is the append order the database assigned; `seq` is the order the server buffered them. They
are normally identical. They diverge when a flush retries, and `seq` is what makes a retry detectable
and ordering provable. The unique index on `(board_id, seq)` is what enforces it.

### Why `covered_seq` on snapshots

Because it makes "which updates do I still need to apply?" a single indexed comparison:

```sql
SELECT update FROM board_updates
 WHERE board_id = $1 AND seq > $2
 ORDER BY seq
```

No `id >` gymnastics, no ambiguity after a compaction deletes rows, and a compaction and a concurrent
insert cannot interleave into a gap. This column is the difference between a correct and a subtly
wrong room load.

---

## 3. Document schema versioning

`boards.schema_version` and `meta.boardVersion` in the Y.Doc track the same number.

| Version | Change | Migration |
|---|---|---|
| 1 | Initial: shapes, blocks, meta | — |

Rules:

- **A client that does not understand a board's version refuses to connect** and says so. It never
  attempts a partial read, because silently ignoring keys a client does not know is how data gets
  lost on the next write.
- **Migrations are pure functions** `Y.Doc → Y.Doc`, in `packages/schema/src/migrations/`, run on
  the server before hydration is broadcast and on the client before applying a snapshot. The same
  code runs in both places, which is the only way they cannot disagree.
- **Migrations never delete information.** They add keys with defaults and transform values. A
  migration that would lose data is a design error, not a migration.
- A migration is applied to a board **once**, lazily, on the next room open, and recorded by bumping
  `schema_version` in the same transaction that writes the migrated state.

---

## 4. Room load

```sql
-- singleflighted per board, in the realtime server
WITH head AS (
  SELECT id, state, state_vector, covered_seq
    FROM board_snapshots
   WHERE board_id = $1 AND kind = 'compaction'
)
SELECT s.state,
       COALESCE(h.state, '\x'::bytea)  AS snapshot,
       COALESCE(h.covered_seq, 0)      AS covered_seq
  FROM head h
  FULL JOIN (SELECT 1) s ON true
 LIMIT 1;

SELECT update, seq
  FROM board_updates
 WHERE board_id = $1 AND seq > $2
 ORDER BY seq;
```

Then in memory:

```ts
const doc = new Y.Doc()
if (snapshot) Y.applyUpdate(doc, snapshot, 'snapshot')
for (const u of updates) Y.applyUpdate(doc, u.update, 'log')
if (boards.schema_version < CURRENT) migrate(doc, …)   // and persist the migrated state
room.snapshotVersion = headId
room.stateVectorCache = Y.encodeStateVector(doc)
```

**Target: < 500 ms for a board with 1,000 updates, < 2 s for 100,000.** If room load becomes the
bottleneck, the fix is more frequent compaction, never a different storage strategy. Compaction runs
every 60 s, so the realistic worst case is a minute of updates.

---

## 5. Compaction

The operation that keeps the log from growing without bound and keeps room load fast.

```sql
BEGIN;

-- 5.1 advisory lock: only one compactor per board, across all instances
SELECT pg_advisory_xact_lock(hashtext('compact:' || $1));

-- 5.2 take a consistent cut. The lock plus a REPEATABLE READ snapshot means a concurrent
--     flush either commits before this read (and is included) or after (and is not).
--     Losing a concurrent flush here would be a data-loss bug, so this is the critical step.
SELECT update, seq
  FROM board_updates
 WHERE board_id = $1 AND seq > $2
 ORDER BY seq;

-- 5.3 in Node: Y.mergeUpdates(buffered) → one encoded state
--     Y.encodeStateVector(merged)  → the covered state vector
--     bytes = length(merged)

-- 5.4 write the new head, retire the old, and delete the absorbed rows, all in ONE transaction
INSERT INTO board_snapshots
  (board_id, state, state_vector, kind, bytes, updates_absorbed, covered_seq)
VALUES ($1, $2, $3, 'compaction', $4, $5, $6)
ON CONFLICT (board_id) WHERE kind = 'compaction'
DO UPDATE SET state = EXCLUDED.state,
              state_vector = EXCLUDED.state_vector,
              bytes = EXCLUDED.bytes,
              updates_absorbed = board_snapshots.updates_absorbed + EXCLUDED.updates_absorbed,
              covered_seq = EXCLUDED.covered_seq,
              created_at = now();

DELETE FROM board_updates WHERE board_id = $1 AND seq <= $6;

COMMIT;
```

Invariants, asserted by tests:

1. **Compaction is a pure optimisation.** If the process dies at any point, the transaction rolls
   back, the log is intact, and the board loads exactly as before. A partial compaction is
   indistinguishable from no compaction.
2. **`board_updates` only ever grows by insert, and shrinks only by compaction.** Enforced with
   database privileges, not discipline: the API role has `INSERT, SELECT` and no `UPDATE, DELETE` on
   this table (see §9).
3. **State after compaction equals state before it.** The property test in
   [13](./13-testing.md#3-property-and-fuzz-testing) builds a doc, compacts it, reloads it, and asserts
   the encoded states are byte-identical.
4. **`covered_seq` is monotonic per board.** A snapshot never claims to cover less than its
   predecessor.

### Compaction schedule

| Trigger | Threshold |
|---|---|
| Time | Every 60 s, scan boards with pending updates |
| Volume | > 500 updates since the last compaction |
| Size | Log bytes for a board > 8 MB |
| Room open | Snapshot on open if the log is non-empty, so a board always has a checkpoint |

### Durability policy

R1 in [01](./01-system-design.md#4-non-functional-requirements) promises that an update acknowledged
to a user is never silently dropped. Three mechanisms, in order of cost:

| Layer | Guarantee | Cost |
|---|---|---|
| **Client (IndexedDB)** | The edit is durable in the user's browser the moment it is applied | Nothing. This is the real safety net and it is free |
| **Server (debounced flush)** | Durable within 2 s of the update, or immediately if the room idles, is evicted, or shuts down | One multi-row `INSERT` per flush, batched |
| **Database (`synchronous_commit`)** | Neon is configured with `synchronous_commit = on`. A committed flush survives a database crash | Slower commits. Measured; acceptable at the flush rate |

Rules that follow from this:

- **The acknowledgement is not sent until the flush commits.** A client that receives no ack keeps
  buffering and retries, and a client that reconnects re-sends via the state-vector exchange. So
  there is no code path where the client believes an update is safe and the server disagrees.
- **Shutdown flush has an 8-second hard deadline** ([04 §2](./04-api-and-backend.md#startup-and-lifecycle)).
  A flush that cannot complete in time is abandoned, and the clients re-sync on reconnect — which is
  the correct outcome, because a partial batch is worse than a lost one.
- **Compaction never reduces durability**, only storage. It reads a log, writes a snapshot, and
  deletes the log rows in one transaction. If it dies, the transaction rolls back and the log is
  intact.
- **`E_DATA_LOSS` is an alert with no exceptions** ([12 §5](./12-monitoring-and-alerts.md#5-alerts) A4).
  It means an acknowledged update is missing, which is the one promise this project makes.

---

## 6. Retention

Unbounded growth is the failure mode of a CRDT app on a free tier, so retention is not optional.

| Data | Policy | Reason |
|---|---|---|
| `board_updates`, `kind='update'` | Delete 7 days after `created_at`, and always delete rows with `seq <= covered_seq` | The log is a transport, not history. History lives in snapshots |
| `board_snapshots`, `kind='auto'` | Keep the newest 20 per board, and delete autos older than 30 days | The scrubber does not need every 5-minute checkpoint forever |
| `board_snapshots`, `kind='named'` | **Keep forever** | The user named it. That is the whole point |
| `board_snapshots`, `kind='compaction'` | Keep the newest 3 per board | Older compaction snapshots are redundant with newer ones |
| `boards`, `status='deleted'` | Hard delete 30 days after `deleted_at`, cascading everything | The right to erasure, and it keeps the "storage at 80%" alert honest |
| `shares`, expired > 90 days | Delete | Nothing to revoke any more |
| `comments` | Cascade with the board | |
| R2 images not referenced by any shape after 24 h | Lifecycle rule | Orphaned uploads from abandoned drops |
| R2 exports after 7 days | Lifecycle rule | Exports are a convenience, not an archive |

The sweep runs hourly, is idempotent, is safe to run concurrently with itself (advisory lock per
board), and logs what it deleted in bytes. That log line is the most useful storage number in the
system.

---

## 7. Object storage (R2)

### Layout

```
mesob-media/
├── boards/{boardId}/
│   ├── images/{imageId}.{ext}          content: image/*, immutable, 1 year
│   ├── exports/{exportId}.{ext}        content: attachment, 7 days (lifecycle)
│   └── snapshots/{snapshotId}.bin      optional mirror of large compaction states
└── avatars/{userId}.png                public, 1 year
```

Images are **immutable and content-addressed by `imageId`**: uploading a new image creates a new key
and repoints the shape. There is no in-place overwrite, so a CDN cache is correct forever and a
failed upload cannot corrupt a referenced image.

### Access

| Object | Who can read | How |
|---|---|---|
| Board images | Anyone with a valid share token for that board | Signed GET, 1 h, `Content-Disposition: inline` |
| Exports | The requesting user | Signed GET, 1 h, `attachment` |
| Avatars | Public | Public bucket, separate bucket name |

Uploads are presigned `PUT` with a `content-length-range` condition, so the byte cap is enforced by
the storage layer and not by trusting the client.

Caching headers and the CDN story are in [10](./10-caching-and-cdn.md).

---

## 8. Capacity math

The free tier is the binding constraint, so the budget is written down and monitored.

### Assumptions

- 20 demo boards active, 1,000 boards total
- 500 shapes per board average
- 200 bytes per update, 15 updates per user per minute at active editing

### Postgres

| Quantity | Formula | Estimate |
|---|---|---|
| Update bytes/day | 20 boards × 8 users × 900 updates/h × 0.2 KB | ~29 MB/day raw |
| After compaction (realistic) | snapshots dominate; log is reset hourly | ~2–5 MB/day |
| Snapshot bytes | 500 shapes × ~120 B encoded | ~60 KB per snapshot |
| Snapshots/day | 20 boards × (24 autos + 24 compactions) | ~1,000 × 60 KB = 60 MB/day |
| Autos pruned to 20/board | steady state | ~20 boards × 20 × 60 KB = **24 MB** |
| Compaction snapshots, 3/board | 20 × 3 × 60 KB | **3.6 MB** |
| Comments, metadata, shares | negligible | **< 1 MB** |
| **Steady-state total** | | **~30–50 MB** |

Well inside a 500 MB–1 GB free tier. A runaway board (a week of continuous editing at 5,000 shapes)
is ~1–2 MB, so the real risk is one pathological board, not aggregate growth. The 80%-of-ceiling
alert in [12](./12-monitoring-and-alerts.md#5-alerts) exists for exactly that case.

### R2

| Object | Estimate |
|---|---|
| Images (20 boards × 30 images × 400 KB) | 240 MB |
| Exports (rolling 7 days) | ~50 MB |
| **Total** | **~300 MB** (free tier is 10 GB; not a constraint) |

### The number that actually matters: doc growth

CRDT documents grow monotonically because tombstones and superseded values are retained. This is a
**correctness feature** (it is what makes concurrent merge safe) and a **storage cost**. We measure
and publish both, with and without compaction, per the metrics table in
[01](./01-system-design.md#8-success-metrics) and the root README. That chart is one of the more
interesting artifacts in the case study: it shows a real property of CRDTs rather than a feature
list.

---

## 9. Connection budget

This is where free tiers bite, and it needs a number rather than a hope.

```
DATABASE_POOL_MAX = 5   per Node instance
  realtime: 1 pool
  api:      1 pool
  worker:   1 pool
  ─────────────────────
  total:   15 connections

  + migrations (CI / deploy): 2
  + Neon pooler (Neon's transaction pooler, if used): shared, effectively unlimited
  ─────────────────────
  worst case: 17 direct connections
```

- Use Neon's **pooled** connection string in production so surplus connections queue in the pooler
  rather than exhausting the database's `max_connections`.
- `apps/realtime` and `apps/api` do **not** share a pool, because they have different lifetimes: the
  realtime server holds connections for hours, the API for milliseconds. A shared pool lets 200 idle
  WebSockets starve an API request, which is a spectacular and entirely avoidable failure.
- `statement_timeout = 5000` and `idle_in_transaction_session_timeout = 10000` are set on every
  connection. A hung query on a free instance costs the whole service.
- `pg_terminate_backend` sweeps any connection idle over 5 minutes, run by the hourly maintenance job.

---

## 10. Migrations

- Plain SQL in `packages/db/migrations/NNNN_name.sql`, applied in order, tracked in
  `schema_migrations(name, checksum, applied_at)`.
- **Forward only.** No down migrations; a rollback is a forward migration that undoes the change.
  This is a deliberate trade: down migrations are usually untested and the "safe" ones are never the
  ones you need.
- Each migration runs in a transaction and must be **concurrently safe**: adding a column, creating an
  index with `CONCURRENTLY`, adding a table. Never a rename or a type change in one step — expand,
  backfill, dual-write, contract, across separate deploys.
- `pnpm db:migrate` runs on deploy, before the new code serves traffic. It takes an advisory lock, so
  two concurrent deploys cannot both migrate.
- A migration that takes a long lock gets an explicit `lock_timeout` and is scheduled deliberately.
  `CREATE INDEX CONCURRENTLY` on `board_updates` is the one to watch.
- CI runs migrations against a fresh database on every PR, and also runs them against a database that
  already has the previous version applied. Both must succeed.

---

## 11. Backup and recovery

| Layer | Approach | RPO | RTO |
|---|---|---|---|
| Neon | Point-in-time recovery + branch | 0 for a Postgres-level failure | Minutes |
| R2 | Versioning on the media bucket | Last write wins is fine; images are immutable anyway | N/A |
| Exports | Users can export Markdown; a board's history lives in snapshots | — | — |

- Weekly: a Neon branch snapshot retained for 7 days, so a catastrophic mistake is recoverable even
  beyond the PITR window.
- A **restore drill** is part of the release checklist: restore last week's branch to a scratch
  database, replay a board's log into it, and confirm the state vector matches. A backup that has
  never been restored is a hypothesis.
- Client-side durability is the real safety net: because every client holds the full document in
  IndexedDB, a client that has been online can re-upload. This is not a backup strategy, it is a
  reason not to panic, and it is worth saying in the case study.

## Acceptance

- [ ] All migrations apply cleanly to an empty database and to a database at the previous version
- [ ] A board with 100,000 updates loads in < 2 s
- [ ] Compaction is atomic: killing the process mid-compaction leaves a loadable board
- [ ] Compaction preserves state exactly (property test)
- [ ] Retention sweep is idempotent, concurrent-safe, and logs bytes reclaimed
- [ ] Steady-state storage for 20 active boards is measured and under 100 MB
- [ ] Doc size over 1 hour of heavy editing is charted, with and without compaction
- [ ] Total connection count stays under 20 with all three pools active
- [ ] A restore drill is performed and the result recorded
