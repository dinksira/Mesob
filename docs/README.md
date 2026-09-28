# Mesob — Engineering Plan Index

This folder is the **build plan** for Mesob. The root [`README.md`](../README.md) is the product
pitch and portfolio narrative; these documents are the engineering contract: what we build, how it
fits together, and what "done" means for each concern.

Read in order the first time. After that, jump to the document you need.

---

## Document map

| # | Document | What it settles | Primary phase |
|---|---|---|---|
| 1 | [System Design](./01-system-design.md) | Goals, non-goals, non-functional requirements, key decisions, risks, success metrics | Pre-work |
| 2 | [System Architecture](./02-system-architecture.md) | Runtime topology, component boundaries, data flow, sync protocol, package graph | Pre-work |
| 3 | [Frontend](./03-frontend.md) | State ownership, canvas renderer, tools, document blocks, presence rendering, PWA/offline | 1–4 |
| 4 | [API and Backend Logic](./04-api-and-backend.md) | REST contracts, realtime server internals, persistence loop, export pipeline | 2–6 |
| 5 | [Database and Storage](./05-database-and-storage.md) | Postgres schema, migrations, compaction, retention, object storage, capacity math | 2, 5 |
| 6 | [Auth and Permissions](./06-auth-and-permissions.md) | Token model, role matrix, handshake + per-message authorization, revocation | 5 |
| 7 | [Hosting and Cloud](./07-hosting-and-cloud.md) | Option A deployment (ship), Option B migration path, env matrix, cold starts | 6 |
| 8 | [CI/CD and Version Control](./08-cicd-and-version-control.md) | Branching, PR gates, workflows, releases, changelog | Pre-work, ongoing |
| 9 | [Security](./09-security.md) | Threat model, trust boundaries, controls, launch checklist | Ongoing |
| 10 | [Caching and CDN](./10-caching-and-cdn.md) | Cache-Control policy per resource, service worker strategy, invalidation | 1, 6 |
| 11 | [Error Tracking and Logs](./11-error-tracking-and-logs.md) | Structured logging, redaction, Sentry, error taxonomy | 2–6 |
| 12 | [Monitoring and Alerts](./12-monitoring-and-alerts.md) | KPIs, SLOs, dashboards, alert rules, notification routing | 6 |
| 13 | [Testing](./13-testing.md) | Unit/property/partition/E2E/load/perf suites, CI gating, flaky policy | 1–6 |
| 14 | [Scaling](./14-scaling.md) | Bottleneck map, headroom, capacity table, breakout triggers to Option B | 6, post-launch |

---

## How these documents are used

Each document carries a status marker in its header:

- `Status: draft` — scaffolding, not yet agreed.
- `Status: accepted` — agreed, code should follow it. Deviations require an ADR.
- `Status: superseded by <link>` — kept for history, do not implement.

Anything marked **Decision** in a table is a candidate for a formal ADR in `docs/adr/`. An ADR is
written **when the decision is made and before the code that depends on it lands**. The
"Key design decisions" table in the root README is the seed list; these docs flesh out the
"why" so an ADR can be written in minutes rather than hours.

Anything that changes a decision already marked **Decision** in these docs must be accompanied by an
ADR that supersedes it. No silent drift.

---

## Cross-cutting conventions

These apply to every document in this folder and to the codebase.

| Concern | Convention |
|---|---|
| IDs | Prefixed, sortable, never reused: `brd_`, `shp_`, `vrs_`, `shr_`, `cli_`, `req_`, `prj_`, `blb_` (see [05](./05-database-and-storage.md#id-format)) |
| Time | UTC everywhere in storage and logs; ISO-8601 with `Z`. Display layer converts to local |
| Money/cost | Not applicable (free tiers only) — instead, every resource has a documented free-tier ceiling |
| Configuration | Env vars, validated at boot with Zod. Missing/invalid config = crash on boot, never a runtime surprise ([04](./04-api-and-backend.md#8-configuration)) |
| Errors | One envelope, machine-readable `code`, human-readable `message`, optional `details` ([04](./04-api-and-backend.md#response-envelope)) |
| Logging | Structured JSON only, one logger per process, no `console.log` in shipped code ([11](./11-error-tracking-and-logs.md)) |
| Secrets | Never in the repo, never in logs, never in URLs. Env only ([09](./09-security.md#secrets)) |
| Authz | Server-side, per message, deny by default. UI checks are cosmetic only ([06](./06-auth-and-permissions.md#enforcement-point)) |
| Schema changes | Additive, backwards compatible, migrated before code that needs them |
| Feature flags | `packages/shared/src/flags.ts`, off by default, removable without a data migration |
| Testing | Every bug fix ships with a regression test in the layer where the bug lived ([13](./13-testing.md#regression-tests)) |
| Docs | Update the doc in the same PR that changes behaviour it describes |

### Naming

- Packages and apps: kebab-case (`apps/realtime`, `packages/doc-schema`).
- Files: `kebab-case.ts` for modules, `PascalCase.tsx` for React components, `SCREAMING_SNAKE.ts` for
  constants.
- Yjs document keys: `snake_case` in the doc schema, mirroring the Postgres columns, so a Postgres row
  and a Y.Map key are trivially comparable during debugging.

---

## Milestone gates

The plan is only useful if it has teeth. Each phase ends with a gate that must pass to continue.

| Gate | After | Passes when |
|---|---|---|
| **G1** | Phase 1 — local-first canvas | Canvas is smooth with 5,000 shapes, edits work with the network cable pulled, `y-indexeddb` survives a reload, `Y.UndoManager` only undoes your own edits |
| **G2** | Phase 2 — realtime sync | Two browser contexts converge over a real WebSocket, a server restart loses nothing, partition + reconnect loses no edits |
| **G3** | Phase 3 — presence | 50 simulated clients, awareness bandwidth and p95 latency measured and published |
| **G4** | Phase 4 — documents on canvas | Concurrent typing in one paragraph converges, remote text cursors land correctly, Amharic renders and edits |
| **G5** | Phase 5 — versions and sharing | Restore is a forward change (history intact), a Viewer's writes are rejected by the server, revoked tokens die mid-session |
| **G6** | Phase 6 — proof | 10,000 fuzz runs green, k6 numbers published, demo video recorded, deployed on free tiers with a green uptime badge |

A gate is passed by *evidence* (a test run, a benchmark output, a screenshot in the PR), not by
assertion. Evidence lands in `docs/benchmarks.md` and the root README's metrics table.

---

## Open questions

Tracked here so they are answered deliberately rather than accidentally during implementation.

| # | Question | Owner | Blocks | Answer |
|---|---|---|---|---|
| Q1 | Neon or Supabase for Postgres? (Neon: better branch-for-PR previews. Supabase: bundled auth + storage.) | — | 05, 07 | Neon + R2, auth stays bespoke JWT |
| Q2 | `ws` or Hocuspocus for the realtime tier? (Hocuspocus ships auth + persistence hooks, less code, less to explain.) | — | 04 | Hand-rolled `ws`; the auth and persistence loop are the case study |
| Q3 | Do renderers and doc blocks share one coordinate space, or do doc blocks live in a DOM overlay? | — | 03 | Overlay, transform-synced. One space would force ProseMirror through canvas |
| Q4 | Can a Commenter post a CRDT update that only encodes presence/annotation? | — | 04, 06 | No. Commenter writes go to a separate `comments` table, not the doc |
| Q5 | Fractional indexing library, or hand-rolled? | — | 03 | Hand-rolled, ~60 lines, no dependency on an unmaintained package |
| Q6 | Image storage: inline data URL (simple, big doc) or immediate upload to R2 (fast doc, needs auth)? | — | 03, 05 | Immediate upload to R2, doc stores only the blob key + a data URL while in flight |
| Q7 | Do we ship autosave-to-`users` accounts at all, or guests-only for v1? | — | 06, 07 | Guests-only + GitHub OAuth as a stretch. Keeps the auth surface small |
| Q8 | k6 needs a stateful target; a free-tier sleeping server distorts latency numbers | — | 13 | Run load tests against a local Postgres + local server, report free-tier numbers separately as "includes cold start" |

---

## Document conventions

Every document in this folder contains, where relevant:

- **Context** — one paragraph on why the topic matters here.
- **Decisions** — a table of `Decision | Choice | Why`, mirroring the root README.
- **Details** — the actual design, with real schemas, types, endpoints, and config.
- **Failure modes** — what breaks, what it looks like, and the mitigation or the accepted cost.
- **Acceptance** — the concrete check that this topic is finished.
