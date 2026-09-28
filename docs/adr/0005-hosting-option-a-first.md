# ADR-0005: Option A ships; Option B is written up, not dismissed

- **Status:** Accepted
- **Date:** 2026-09-28
- **Covers:** D17 (hosting)
- **References:** [07](../07-hosting-and-cloud.md), [02 §1](../02-system-architecture.md#1-runtime-topology-option-a-the-shipping-deployment),
  [02 §10](../02-system-architecture.md#10-the-option-b-port),
  [14 §3.2](../14-scaling.md#32-awareness-fan-out-the-on-term)

## Context

Mesob runs on free tiers end to end: Cloudflare Pages for the frontend, a free Node web service for
the realtime server, Neon for Postgres, R2 for objects. That is a hard constraint from the start, not
an accident of early progress.

The constraint is uncomfortable in a specific way. Free-tier instances **sleep**. A Render free
instance goes idle after 15 minutes and the next request pays a cold start measured in seconds to
tens of seconds ([07](../07-hosting-and-cloud.md#option-a-the-shipping-plan)). For a demo, that reads
as broken.

There is a second architecture available and it is genuinely better on paper: **Option B** —
Cloudflare Workers with Durable Objects, one object per board. Durable Objects give per-board
single-threaded isolation and free persistence, which is precisely the concurrency and storage work
this project would otherwise demonstrate by hand. Horizontal scaling is free, not designed.

So the real decision is what the project is *for*. If the goal is a working collaborative canvas, the
free-tier Node option is lower risk and will ship. If the goal is a portfolio piece that shows
systems thinking, Option B hides the parts worth showing: the platform hands over the isolation and
the persistence, and the interesting loop is gone.

## Decision

**Option A is the shipping deployment. Option B is documented properly in
[02 §10](../02-system-architecture.md#10-the-option-b-port), with what changes and what does not.**

Option A's shape:

| Layer | Choice |
|---|---|
| Frontend | Cloudflare Pages, CDN in front, service worker for offline |
| Realtime | Node + `ws` on a free web service, hand-rolled ([ADR-0004](./0004-authorization-before-apply.md), D16) |
| Persistence | Neon Postgres: append-only update log + snapshots |
| Objects | R2, presigned uploads so large files never touch the Node instance |
| Auth | Bespoke JWT, guests in v1 ([index Q7](../README.md#questions-pending-sign-off)) |

Isolation is an in-process room map. Horizontal scale means adding instances behind sticky routing,
and the rate limiter becomes best-effort per instance ([04 §9](../04-api-and-backend.md#9-rate-limiting)).

The sleeping instance is **treated as a feature, not a bug**: a cold instance is a demonstration of
offline-first, and the landing page links to a board with a note explaining the cold start. The
handoff is to UptimeRobot every 5 minutes ([12 §4](../12-monitoring-and-alerts.md#5-alerts)),
because a project that cannot be reached for an hour cannot be reviewed.

## Consequences

**What this makes easy:**

- The auth and persistence loop is visible in the repository. Every element is code someone wrote,
  which is the point.
- Local development matches production. Postgres and the server run locally
  ([index Q8](../README.md#questions-pending-sign-off)), and load tests run against a local target so
  the numbers measure the app rather than the free tier's wake-up latency.
- The whole thing is legible in an afternoon. No Durable Object bindings, no isolate lifecycle to
  reason about, no unfamiliar tooling during a debugging session.
- It will exist. A perfect architecture that is not running demonstrates nothing.

**What this makes expensive:**

- **Cold starts are user-visible.** Acceptable for a demo with a warm-up ping; not acceptable for a
  product. This is the single strongest argument against Option A and it is stated in
  [07](../07-hosting-and-cloud.md) rather than discovered later.
- **No free per-board isolation.** Concurrency control is an in-process room map plus a single
  WebSocket server. Correctness depends on that process being the only writer, which is a real
  constraint rather than a platform guarantee.
- **Room memory is bounded by the instance**, so horizontal scale requires sticky routing to keep a
  board on one instance. [14 §3.1](../14-scaling.md#31-room-memory) covers the ceiling.
- **Awareness fan-out is O(n²) within one process**, which is why it gets its own bottleneck
  analysis in [14 §3.2](../14-scaling.md#32-awareness-fan-out-the-on-term) rather than being assumed
  away. A Durable Object would have inherited a per-board single-threaded model for free, and giving
  that up is the actual price paid here.
- **The rate limiter is per instance.** Stated plainly in [04 §9](../04-api-and-backend.md#9-rate-limiting)
  rather than implied to be global.

## Alternatives considered

**Option B first (Workers + Durable Objects).** Rejected on shipping risk. The parts worth
explaining would be handed to the platform, and if it does not work there is no fallback that
preserves the case study. The trade is: better concurrency model, no demonstration of how that model
works. For a portfolio project that is a bad exchange, and it is also the option most likely to
stall before Phase 2.

**A self-hosted server (VPS, Fly.io paid tier).** Rejected. It contradicts the free-tier constraint
that shapes the observability and alerting design, and it introduces a cost and an operational burden
that add nothing to the case study.

**Supabase for Postgres, auth, and storage together.** Rejected ([index Q1](../README.md#questions-pending-sign-off)):
fewer moving parts, but the auth and storage loop is exactly the part worth writing down. Neon plus R2
plus bespoke JWT keeps those in the repository where they can be read.

**Hocuspocus instead of hand-rolled `ws`.** Rejected ([index Q2](../README.md#questions-pending-sign-off)):
Hocuspocus ships auth and persistence hooks, which is genuinely less code. It is also the enforcement
point from [ADR-0004](./0004-authorization-before-apply.md), and a framework that abstracts over
`Y.applyUpdate` makes the single-guard architecture test unenforceable — the guard would be
configuring someone else's callback, not owning the apply path.

**Document Option A only, and treat Option B as a footnote.** Rejected. "Here is the same system on
an edge runtime, and here is what changed and what did not" is a stronger artifact than a Node app
with a paragraph about workers. The comparison needs the isolation and persistence discussion to be
real, which means writing it up.
