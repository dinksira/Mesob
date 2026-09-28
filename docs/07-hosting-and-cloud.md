# 07 — Hosting and Cloud

> **Status: draft** · Depends on: [02](./02-system-architecture.md), [05](./05-database-and-storage.md)
> **Verify every limit before deploying.** Free tiers change without notice. The numbers below were
> checked at planning time and each one carries a "re-verify" note in the deployment checklist.

## Context

The whole system must run for $0. That is not a detail — it is a design constraint that shapes
architecture, and it produces one of the more interesting parts of the case study: *sleeping servers,
connection caps, and storage ceilings as first-class design inputs.*

Two options were considered. **Option A ships. Option B is documented as a port with a trade-off
analysis.**

| | **Option A** (ship) | **Option B** (document, port later) |
|---|---|---|
| Realtime | Node + `ws` on a free web service | Cloudflare Workers + Durable Objects, one object per board |
| Persistence | Neon Postgres (update log + snapshots) | DO storage + snapshot to R2/D1 |
| Frontend | Cloudflare Pages | Cloudflare Pages |
| Isolation | In-process room map | Per-board single-threaded isolate |
| Horizontal scale | Add instances, needs sticky routing | Free, per-board |
| Cold start | Yes, seconds to tens of seconds | Fast, but cold on first hit per object |
| Complexity | Low, familiar, easy to debug | Higher, less familiar tooling, harder to load-test |
| Cost of the interesting idea | The auth and persistence loop is visible in your code | Handed to the platform |

Option A is chosen because **the parts worth explaining are hand-written**. A Durable Object would
give free concurrency control and free persistence, and in doing so would hide exactly the two things
the project is meant to demonstrate. Option B is written up properly rather than dismissed, because
"here is the same system on an edge runtime, and here is what changed and what did not" is a stronger
case study than "here is a Node app".

---

## Option A: the shipping plan

### Service inventory

| Layer | Provider | Plan | Why this one | Re-verify |
|---|---|---|---|---|
| Frontend + CDN | **Cloudflare Pages** | Free | Global CDN, atomic deploys, preview branches, free bandwidth. `pages.dev` or a custom domain | Bandwidth cap, build minutes |
| App server (realtime + API) | **Render**, fallback **Koyeb** | Free web service | WebSocket support, `SIGTERM` with a grace period, managed `DATABASE_URL` env, easy rollback to a previous deploy | Sleep behaviour, monthly hours, WebSocket timeout |
| Postgres | **Neon** | Free | Serverless, pooled connections, **branching** (a branch per PR is a genuinely great fit for migration tests), PITR | Storage cap, compute hours, branch count |
| Object storage | **Cloudflare R2** | Free (10 GB, no egress) | S3-compatible, zero egress fees, same account as Pages so the IAM story is one place | Storage cap, operation count |
| Uptime monitoring | **UptimeRobot** | Free (50 monitors) | Also drives the README status badge | Monitor interval on the free tier |
| Error tracking | **Sentry** | Free (5k events/mo) | Both browser and Node SDKs, sourcemap support | Event quota |
| Metrics | **Grafana Cloud** Free, or **Better Stack** | Free | Metrics + dashboards + alerting without running anything | Retention |
| Email (optional) | none | — | Share links are copied by hand. No email dependency in v1 | — |

**Why not Supabase for Postgres:** branching and PITR on Neon are the deciding features for a
migration-tested CI setup, and keeping auth bespoke avoids coupling the document's permission model to
a vendor's user table (Q1 in the [index](./README.md#open-questions)). Supabase remains a
one-connection-string swap.

**Why Render over Koyeb:** Render's free tier sleeps after 15 minutes of inactivity and its
`SIGTERM` handling is well documented, which is what the cold-start design is built around. Koyeb
offers more generous free hours. Pick one, write down which, and do not run both — a second
always-on-ish instance changes the room-routing assumptions in [14](./14-scaling.md).

### The instance shape

The free tier is small. The app must fit in it, which is a real design input:

| Resource | Free tier | Our budget | How we stay inside it |
|---|---|---|---|
| RAM | 512 MB–1 GB | < 700 MB steady | Room idle-eviction at 10 min, `MAX_ROOMS_PER_INSTANCE=50`, awareness throttling, no per-connection leak |
| CPU | shared, bursty | < 60% average | Debounced writes, single rAF-free server loop, no CPU work on the request path |
| Disk | ephemeral | n/a | Nothing on local disk. No file uploads, no temp files. Postgres and R2 only |
| Connections | ~1-2 GB | < 17 DB connections | `DATABASE_POOL_MAX=5`, pooled Neon URL |
| Sleep | after ~15 min idle | — | UptimeRobot every 5 min; cold-start mitigation below |

**A note on ephemeral disk, because it is a real trap:** a Render free instance is recreated on
deploy. Anything written to local disk is gone, including on a crash. The design has no local disk
dependency at all, which is not an accident — it is a requirement of this hosting tier.

### Environment configuration

| Var | Where it is set | Notes |
|---|---|---|
| `NODE_ENV` | platform | `production` |
| `PORT` | platform | Injected; **never hardcoded** |
| `DATABASE_URL` | platform secret | **Pooled** Neon URL in production, direct URL for migrations |
| `JWT_SECRET` | platform secret | 32+ random bytes, generated at first deploy and never rotated casually |
| `PUBLIC_ORIGIN` | build + runtime | The Pages URL, used for CORS and the WS origin check |
| `ALLOWED_ORIGINS` | platform secret | Comma-separated; preview deploys append themselves |
| `R2_*` | platform secret | Account id, key id, secret, bucket |
| `SENTRY_DSN` | build + runtime | |
| `METRICS_ENABLED` | platform | `true`, metrics on a second port bound to localhost, scraped through a tunnel or exported to Grafana |
| `LOG_LEVEL` | platform | `warn` in production to stay inside the free log quota |
| `EXPORT_ENABLED` | platform | `false` if the canvas binding will not install |

Frontend build-time variables are prefixed `VITE_` and are **public by definition**. Nothing secret
ever gets a `VITE_` prefix. This is worth a lint rule: fail the build if a `VITE_*` var matches
`SECRET|TOKEN|KEY|PASSWORD|DATABASE`.

### Deploy sequence

```
1. CI: typecheck, lint, unit, integration (real Postgres from a Neon branch), build all three apps
2. CI: apply migrations to the target database (a separate job, gated on green tests)
3. Deploy the API/realtime image to Render; Render runs a health gate against /ready
4. Deploy the frontend to Cloudflare Pages; Pages is atomic, the old version serves until the new one
   is fully live
5. Smoke test: create a board over REST, open a WS, write, read back, verify the row in Postgres
6. Post the deploy to the CI summary with the commit SHA and a link to the dashboards
```

**Migrations before code, always.** A migration that is incompatible with the currently running code
is an outage, so every migration follows expand/backfill/contract across separate deploys
([05 §10](./05-database-and-storage.md#10-migrations)). `CREATE INDEX CONCURRENTLY` is the one to watch.

### Cold-start mitigation

This is a genuine design feature, not a workaround. A sleeping instance is a perfect demonstration of
offline-first, so the constraint is turned into a demo.

```
t=0     User opens the share link from a cold CDN/browser cache
t=0.1s  Service worker serves the app shell from cache          ← no network needed
t=0.4s  IndexedDB yields the last-known board state
t=0.5s  First paint of the board. The user can DRAW.             ← TTI target < 1s (P3)
t=0.6s  WS connect starts, in parallel with continued local editing
t=8s    Instance wakes (Render cold start)
t=8.2s  Handshake, role, state-vector sync, awareness
t=8.4s  Merge summary appears if anything changed while we were asleep
```

Three design requirements make this work:

1. **The app must never block on the socket.** No screen shows a spinner because the server is
   unreachable. `connection.status` is a chip in the corner, not a gate.
2. **The app shell must be cache-first.** Precached by the service worker, so a cold *server* does
   not mean a cold *client* ([10](./10-caching-and-cdn.md)).
3. **The client must reconnect without ceremony.** Jittered exponential backoff, so the wake-up
   naturally finds the client already trying ([03 §5](./03-frontend.md#5-offline-and-persistence)).

UptimeRobot pings `/api/v1/health` every 5 minutes, which keeps the instance awake most of the time
— and when it does not, the demo still works, which is the point.

**What we accept and publish:** the first WebSocket connect after a cold start can take 5–15 seconds.
Documented in the README, mitigated by UptimeRobot, and demonstrated as an offline-first property
rather than hidden.

---

## Option B: the edge-native port

### Shape

```
Cloudflare Pages            static frontend, same as Option A
        │
        ▼
Cloudflare Worker (router)   validates the token (needs a read to D1 or a KV binding),
        │                    resolves the role, routes to the Durable Object
        ▼
Durable Object per board     one DO = one room
        │                    · single-threaded: no locks, no races
        │                    · in-memory Y.Doc
        │                    · DO storage: automatic, transactional
        │                    · hibernatable: idle rooms cost nothing
        ▼
R2 / D1                     compaction snapshots and metadata
```

### What the port gives us

| Property | Why it is better here |
|---|---|
| **Single-threaded per board** | No room mutex, no per-room locking, no lost-update class of bug. The platform removes the concurrency problem entirely |
| **Automatic per-object persistence** | DO storage is transactional and local to the object. The whole debounced-write design in [04 §3](./04-api-and-backend.md#3-persistence-loop) becomes "write to storage" |
| **Hibernation** | Idle rooms cost zero. The idle-eviction and `MAX_ROOMS_PER_INSTANCE` machinery in [02 §7](./02-system-architecture.md#7-room-lifecycle) disappears |
| **Global routing** | A user in Addis and a user in Berlin hit the same DO from the nearest edge. Option A has one region and admits it |
| **Free horizontal scale** | New rooms are new objects. No instance to add, no sticky routing, no load balancer |
| **WebSocket reconnection** | Cloudflare handles it, and DO hibernation-aware WebSockets let an idle room drop its connections and still keep state |

### What the port costs

| Cost | Detail |
|---|---|
| **Cold starts per object** | The first request to a board after a long idle pays a DO instantiation. Better than a server cold start, still real |
| **The interesting code disappears** | Auth at handshake, backpressure, debounced persistence, and the room lifecycle are exactly what the platform would do. That is a real loss of case-study value |
| **No arbitrary libraries** | Only the Workers runtime. A Node canvas binding for PNG export does not exist; the export path must change (Wasm, or client-side rendering) |
| **Harder to load test** | k6 against DO is awkward; the honest load numbers in [13](./13-testing.md#8-load-testing) would come from a local harness plus a smaller production measurement |
| **Free-plan limits are murkier** | DO free-tier request and duration limits have changed repeatedly. Must be re-verified, and the answer may be "not free enough" |
| **Observability is different** | No Pino, no `process.memoryUsage`. Workers Analytics Engine or `cf-analytics` instead, and a different mental model for the dashboards in [12](./12-monitoring-and-alerts.md) |
| **Migration is real work** | Not a redeploy. Roughly 3–5 days: the `RoomTransport` interface absorbs most of it, but the persistence, metrics, and export paths all change |

### Migration plan

The port is bounded because the realtime server already sits behind an interface
([02 §10](./02-system-architecture.md#10-the-option-b-port)):

| Step | Work | Risk |
|---|---|---|
| 1 | Extract `RoomTransport` from the in-process room map, with the Node implementation as the reference | Low. Refactor only, no behaviour change. Covered by the existing tests |
| 2 | Write the DO implementation against the same interface, run it locally with `wrangler dev` | Low |
| 3 | Move the auth check to a shared module usable from both runtimes (Workers has no `pg`; the share lookup becomes a KV or D1 read, or a signed assertion verified in the Worker) | Medium. The auth story is the most security-sensitive code in the repo |
| 4 | Replace debounced Postgres persistence with DO storage; snapshot to R2 on a size or time trigger | Medium. This is where data-loss bugs would live, so the compaction property tests must pass against DO storage too |
| 5 | Port the compaction worker; it becomes a scheduled Worker reading a compaction queue | Medium |
| 6 | Swap the metrics implementation | Low |
| 7 | Resolve export (client-side render, or Wasm) | Medium |
| 8 | Dual-write period: run both, compare state vectors for a board, then cut over | The only way this is safe |

**Recommendation: do not migrate unless a trigger in [14](./14-scaling.md#6-breakout-triggers-to-option-b)
fires.** Write the Option B analysis, keep the interface honest, and ship Option A. The comparison is
the deliverable; the migration is optional.

---

## Deployment checklist

Run through this before every public deploy. It is short on purpose.

- [ ] Free-tier limits for every provider re-verified against the pricing page (they change silently)
- [ ] `pnpm db:migrate` succeeded and the schema version matches what the code expects
- [ ] `JWT_SECRET` is present in the platform and is not the local dev value
- [ ] No `VITE_` variable contains a secret (the lint rule passes)
- [ ] `PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` include the exact deployed origin; the WS origin check passes
- [ ] `LOG_LEVEL=warn`, `METRICS_ENABLED=true`, `SENTRY_DSN` set
- [ ] `EXPORT_ENABLED` matches reality (is the canvas binding actually installed?)
- [ ] Health check green on the new deploy; `/ready` confirms migrations are applied
- [ ] UptimeRobot monitor is pointing at the new URL and reporting
- [ ] Rollback is one click: the previous Render deploy and the previous Pages deployment are both retained
- [ ] Smoke test: create board → open WS → write → verify the row in Postgres → restore a version
- [ ] Dashboards show the new deploy's version tag
- [ ] README uptime badge updated if the domain changed

## Acceptance

- [ ] The full system runs on free tiers at $0/month, with the measured ceilings recorded
- [ ] A board is fully usable while the server instance is asleep, and merges on wake
- [ ] Cold start is measured and published
- [ ] `pnpm dev` reproduces the production topology locally with a Postgres container
- [ ] A rollback is rehearsed before launch, not after an incident
- [ ] The Option B analysis is written up with the trade-off table above, and the `RoomTransport`
      interface actually exists in the code so the claim is verifiable
