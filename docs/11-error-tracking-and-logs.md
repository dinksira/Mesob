# 11 — Error Tracking and Logs

> **Status: draft** · Related: [09 Security](./09-security.md), [12 Monitoring](./12-monitoring-and-alerts.md)

## Context

This app's most likely production incident is not a crash. It is a **silent divergence**: two users
whose boards quietly stopped agreeing, a compaction that skipped an update, or a client stuck in a
reconnect loop. Those do not throw. They need to be *visible*, which means instrumentation has to be
designed around the failure modes of a CRDT system rather than around stack traces.

Two audiences: a human debugging something now (logs, Sentry), and a reviewer judging the work
later (structured, greppable, versioned). Design for both.

---

## 1. Error taxonomy

One enum, shared by `packages/shared`, used by the client, the API, and the realtime server. An
error's category drives whether it alerts, whether it is sampled, and where it goes.

| Code | Category | Examples | Alert? |
|---|---|---|---|
| `E_CONVERGENCE` | **Critical** | Replica state hash mismatch after sync; state vector mismatch post-compaction | Page immediately |
| `E_DATA_LOSS` | **Critical** | Acknowledged update missing from the log; `seq` gap detected on load | Page immediately |
| `E_PERMISSION` | Security | Guard rejected a write; role changed unexpectedly; token used after revocation | Page on a spike, log always |
| `E_SCHEMA` | Critical | Unknown `schema_version`; a migration failed; a required key is missing | Page |
| `E_SYNC_PROTOCOL` | High | Malformed frame; state vector mismatch; unexpected message type | Log, alert on rate |
| `E_PERSIST` | High | Flush failed; compaction rolled back; DB unreachable | Page |
| `E_RESOURCE` | Medium | Frame cap hit; room cap hit; memory pressure; slow client dropped | Log, alert on rate |
| `E_NETWORK` | Medium | WS disconnect, reconnect storm, provider timeout | Log only, alert on rate |
| `E_RENDER` | Low | Frame time over budget, draw-loop exception | Log, alert on rate |
| `E_USER_INPUT` | Low | Schema validation failure, bad upload, export failure | Log only |
| `E_UNKNOWN` | — | Anything unclassified | Log; a rising count is a signal that the taxonomy is incomplete |

The first two are the reason this document exists. A `E_CONVERGENCE` event carries the state hashes
of every replica, the state vectors, and the client's `clientID`, which is enough to reconstruct the
divergence offline. It is the single most valuable event the system can emit.

---

## 2. Logging

### Rules

1. **Structured JSON, always.** One logger per process, configured once in `packages/shared/src/logger.ts`.
2. **No `console.*` in shipped code.** Enforced by `eslint-plugin-no-console` with `allow: ['warn','error']`
   only in dev, and a CI grep for `console.log` outside test and script files.
3. **No string concatenation.** `log.info({ boardId, shapeId }, 'shape moved')`, not
   `log.info('shape ' + id + ' moved')`. Fields are queryable; strings are not.
4. **Every line carries its context automatically** via a child logger: `requestId`, `boardId`,
   `clientId`, `release`, `env`. Handlers pass the context down, so no line is orphaned.
5. **Levels are meaningful.** `debug` is development only, `info` is a state change worth recording,
   `warn` is recoverable and unexpected, `error` needs a human, `fatal` is shutting down.
6. **Log volume is a cost.** Free tiers charge for logs and cap retention. Production runs at
   `warn`; the interesting `info` events (room open, room close, flush, compaction) are promoted to
   Sentry breadcrumbs or metrics instead.

### The logger

```ts
// packages/shared/src/logger.ts — used by apps/realtime, apps/api, and scripts
import pino from 'pino'

export function createLogger(opts: {
  service: 'realtime' | 'api' | 'worker'
  env: string
  release: string
  level?: Level
}) {
  return pino({
    name: opts.service,
    level: opts.level ?? (opts.env === 'production' ? 'warn' : 'debug'),
    base: { service: opts.service, env: opts.env, release: opts.release },
    redact: {
      paths: [
        'token', '*.token', 'req.headers.authorization', 'req.headers.cookie',
        'password', '*.password', 'secret', '*.secret', 'jwt', '*.jwt',
        'url', 'req.url',                        // the WS path carries a share token
        'headers["x-request-id"]',               // kept as a field, removed from the raw path
      ],
      censor: '[redacted]',
    },
    formatters: { level: (l) => ({ level: l }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() { return { requestId: currentRequestId() } },
  })
}
```

`url` and `req.url` are redacted **because the WebSocket path is `/rooms/:id?token=…`**. That is the
single highest-value redaction rule in the project: without it, every connection logs a live share
token. The logger redacts by default so a new call site cannot leak by omission.

There is a unit test that pushes a known token through the logger at every level and asserts it
appears in zero output lines. It is in the security test set
([13](./13-testing.md#7-security-tests)).

### Redaction

Three rules make the redaction trustworthy rather than decorative:

1. **Deny by default, not by list.** The paths above cover the known-sensitive fields. Where a field
   could contain arbitrary user data, log a derived value instead — a length, a hash prefix, an id —
   rather than trying to redact inside a string. Redaction of a string you do not control is not
   possible; refusing to log the string is.
2. **Tested, not assumed.** The unit test above writes a canary token into every field and every
   level and asserts the canary appears zero times (`ST14`).
3. **Verified against the real system, not only a unit.** The E2E security run performs a full
   session — connect, edit, disconnect, revoke — and then greps the deployed log stream and the
   Sentry project for the token. A unit test proves the logger redacts; only the E2E run proves
   nothing *else* logs it.

Client-side the equivalent rules are the Sentry `beforeSend` scrub (query string, cookies, headers)
and the rule that document content never enters an event
([§1](#1-error-taxonomy), [§4](#4-client-side-instrumentation)).

### What gets logged, and what does not

**Logged (at `info` in dev, as metrics/breadcrumbs in prod):**

| Event | Fields | Why |
|---|---|---|
| Room open / close | `boardId`, `clientCount`, `openMs`, `updatesReplayed`, `snapshotId` | The core lifecycle. A slow `openMs` is the leading indicator of trouble |
| Room evicted | `boardId`, `idleMs`, `memoryAtEvict` | Memory pressure evidence |
| Flush | `boardId`, `count`, `bytes`, `durationMs` | Write health and volume |
| Flush failure | `boardId`, `attempt`, `error` | **Alerts** |
| Compaction | `boardId`, `updatesAbsorbed`, `beforeBytes`, `afterBytes`, `durationMs` | The doc-growth chart's data source |
| Compaction rollback | `boardId`, `error` | **Alerts** |
| Auth decision | `shareId`, `role`, `decision`, `reason` | The security audit trail. Not the token |
| Guard rejection | `boardId`, `clientId`, `role`, `capability` | Only for Viewer/Commenter write attempts — these are the interesting ones |
| Share lifecycle | `shareId`, `action: created\|revoked\|expired\|exchanged`, `role` | |
| Rate limit hit | `ip`, `route`, `bucket` | Abuse signals |
| Backpressure drop | `boardId`, `clientId`, `bufferedAmount` | Capacity evidence |
| Version created / restored | `boardId`, `versionId`, `kind`, `authorId`, `diffSummary` | |
| Export | `boardId`, `format`, `durationMs`, `bytes` | |
| Reconnect | `boardId`, `clientId`, `attempt`, `delayMs` | From the client, as a Sentry breadcrumb |

**Never logged, at any level:**

| Data | Why |
|---|---|
| Share tokens, session cookies, `Authorization` headers | [09](./09-security.md#secrets) |
| Full query strings | The token lives there |
| Document content, shape text, block text | It is user data and it is large |
| Binary update payloads | Log a length and a hash prefix: `updateBytes: 214, updateHash: "3f2a…"` |
| Awareness payloads | They contain cursor positions, i.e. behavioural data |
| Email addresses, names | Only `userId` and a display colour |
| Full stack traces in a client error boundary | A request id is the handle; the trace goes to Sentry |
| `DATABASE_URL`, `JWT_SECRET`, R2 keys | — |

A useful discipline for the last two: **the log is for diagnosis, the dashboard is for numbers.**
Pushing a metric as a log line is what fills a free log quota and makes a log search useless.

---

## 3. Sentry

Free tier, 5k events/month, which is plenty if sampling is disciplined.

### Client SDK

```ts
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: __RELEASE__,                       // the git SHA, injected at build time
  environment: import.meta.env.MODE,
  tracesSampleRate: 0.05,                     // 5% performance tracing; a canvas app generates
                                               // a LOT of spans and 100% tracing is a quota bug
  replaysSessionSampleRate: 0,                // off: session replay would record user content
  replaysOnErrorSampleRate: 0,
  integrations: [Sentry.browserTracingIntegration()],
  beforeSend(event) {
    // 1. never the query string: a share token may be in it before the exchange completes
    if (event.request?.url) {
      const u = new URL(event.request.url)
      u.search = ''
      event.request.url = u.toString()
    }
    // 2. never the hash: the viewport coordinates are harmless, but habits are cheap
    delete event.request?.query_string
    delete event.request?.cookies
    delete event.request?.headers
    return scrub(event)
  },
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',     // benign, and it pollutes the quota
    /^ResizeObserver/, 'NetworkError when attempting to fetch resource',
  ],
})
})
```

**Session replay is off, permanently.** It records the DOM, which means document text. For an app
whose entire content is a canvas of user text, replay would be a data-exfiltration incident waiting
for a screenshot. This is a one-line decision with a big consequence, and it is worth stating in the
case study.

### Server SDK

```ts
Sentry.setupNestErrorHandler  // n/a — Fastify, so:
fastify.setErrorHandler((err, req, reply) => {
  Sentry.withScope((scope) => {
    scope.setTag('boardId', req.boardId)
    scope.setTag('role', req.role)
    scope.setUser({ id: req.userId })        // id only, never a name
    scope.setExtra('requestId', req.id)
    Sentry.captureException(err)
  })(err)
  reply.send(errorEnvelope(err, req.id))     // the user never sees the internal message
})
```

Server-side, additionally:
- `tracesSampleRate: 0.1`, and WS connections are **not** traced (a long-lived connection is one
  never-ending transaction, which will blow the quota and tell you nothing).
- Profiling off.
- The realtime server reports a scope per room, so a `E_CONVERGENCE` event names the board.

### Source maps

| Target | Handling |
|---|---|
| Browser | `sentry-cli` uploads maps on release, `sourcemaps: 'hidden'`, `debug-id` injected so maps are matched even on a cached bundle |
| API / realtime | `pnpm build` with `sourcemap: true`, maps uploaded in the deploy job |
| Local | Sentry disabled entirely when `SENTRY_DSN` is unset. No dev noise |

`debug-id` injection matters here specifically: the service worker caches hashed bundles across
deploys, so without it a stack frame from a cached bundle cannot be matched to its map. That is a
cache-plus-observability interaction that only shows up in production.

### Release tracking

`release: __RELEASE__` is the commit SHA, injected by the Vite config from `GITHUB_SHA`. A deploy
posts a Sentry release with the changelog, and every event carries the release. "Which version was
this user on when the canvas went blank?" is answerable in one query.

---

## 4. Client-side instrumentation

Beyond Sentry, the client records structured events that are genuinely useful for a CRDT app and
that no crash reporter would surface.

```ts
// packages/shared/src/telemetry.ts
interface ClientEvent {
  kind: 'sync' | 'reconnect' | 'merge' | 'frame' | 'awareness' | 'offline'
  boardId: string
  clientId: string
  sessionId: string
  // kind === 'merge': what actually happened after a partition
  remoteOps?: number
  localOps?: number
  conflicts?: number
  offlineMs?: number
  // kind === 'frame'
  frameMs?: number
  visibleShapes?: number
  totalShapes?: number
  // kind === 'reconnect'
  attempt?: number
  reason?: string
  converged?: boolean       // state vector compared with the server after sync
}
```

These go to Sentry as **breadcrumbs** (cheap, sampled, kept per-session) and drive the metrics in
[12](./12-monitoring-and-alerts.md). The `converged` flag is the interesting one: after every
reconnect the client compares its state vector with the server's, and a mismatch is an `E_CONVERGENCE`
event. **That check is a free, continuous convergence assertion running on every real user session,
and it is worth more than any amount of fuzzing** for catching a real-world divergence.

Frame metrics are aggregated per session (p50/p95/max, not every frame) and only reported when they
cross the budget, so a healthy session costs nothing.

---

## 5. Error reporting in the UI

| Situation | What the user sees | What it must never show |
|---|---|---|
| Board failed to load | "This board could not be loaded. Try again." + a request id + Retry | A stack trace, a SQL error, a board id |
| A shape operation failed | Undo the local change, toast "Could not move that shape", log the error | A silent failure |
| WS disconnected | A status chip, not a modal. Editing continues | Anything that blocks editing |
| Merge produced conflicts | "3 of your changes were merged with changes from someone else. Review?" with a highlighted list | "Merge failed" — the merge did not fail, that is the point |
| Rate limited | "Slow down a moment" with a countdown | A 500 |
| Share token invalid | "This link is no longer valid." + who to ask | Whether the board exists |
| Unsupported schema version | "This board was made with a newer version of Mesob. Update to open it." | A parse error |
| Unhandled React error | An error boundary with a request id and a Reload button | The error's message if it may contain internals |

The `requestId` is the bridge: the user reads it off the screen, pastes it into a message, and
[Sentry and the logs](#2-logging) both answer to it. That single affordance determines whether a
bug report is actionable, and it costs one field.

---

## 6. Retention and cost control

| Sink | Free tier | Sampling | Retention |
|---|---|---|---|
| Sentry errors | 5k events/mo | 100% for `E_*`, 10% for `E_NETWORK`/`E_RENDER` | 30 d |
| Sentry performance | Small quota | 5% traces | 7 d |
| Sentry sessions | Small quota | 1% | 7 d |
| Sentry breadcrumbs | Included per session | Always, capped at 100 | With the session |
| App logs (platform) | Provider-dependent | `warn` in prod | 7 d, 1 GB rotating |
| Grafana metrics | Free tier retention | Aggregated, 15 s | 7 d at 15 s, 90 d at 1 m |

Controls that keep the free tiers healthy:
- `ignoreErrors` for the known-benign browser errors that would otherwise dominate the quota.
- `tracesSampleRate` low, and no WS tracing.
- Frame metrics reported only when over budget.
- Log level `warn` in production.
- A weekly job that prints quota usage per service, so exhaustion is discovered before it silently
  starts dropping data.

---

## 7. Failure modes

| Failure | What it looks like | Response |
|---|---|---|
| Sentry is down | No client events | Local buffering, and the app is unaffected. Never a hard dependency |
| The log pipe blocks the event loop | Latency spikes under load | `pino` writes synchronously to stdout; the platform handles the pipe. Never log to a network sink in-process |
| Log volume explodes | Free-tier quota burned in an hour | Log level, sampling, and a rate limiter on repeated identical errors (`fingerprint`-based suppression in Sentry) |
| A hot error loop | Thousands of identical events | Suppress by fingerprint after 10 events/min, report once with a count |
| A secret leaks into a log | Token in a line | The redaction is by default and unit-tested; the incident-response path is: rotate the share's `token_hash` (issue a new link), rotate `JWT_SECRET` if needed, then scrub the log provider |
| Sentry fills up mid-demo | Errors silently dropped | The weekly quota check, plus the alert on `sentry.events.dropped` |

## Acceptance

- [ ] Zero `console.log` in `apps/` and `packages/` outside tests, enforced in CI
- [ ] Every log line is JSON with `service`, `env`, `release`, and `requestId`
- [ ] A known token fed through the logger at every level appears in **zero** output lines (unit test)
- [ ] Sentry `beforeSend` strips query strings, cookies, and headers (unit test)
- [ ] Session replay is off, and there is a comment saying why
- [ ] `converged` is recorded after every reconnect, and a mismatch pages
- [ ] Source maps resolve for a bundle served from the service-worker cache
- [ ] Every user-facing error shows a request id and no internal detail
- [ ] The error taxonomy is a shared enum, and an unclassified error increments a visible counter
- [ ] Quota usage is checked weekly and alerting exists on dropped events
