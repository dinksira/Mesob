# 09 — Security

> **Status: draft** · Related: [06 Auth and Permissions](./06-auth-and-permissions.md), [11 Error Tracking and Logs](./11-error-tracking-and-logs.md)
> **Threat-modelling an app with a public write surface and no accounts is mostly about one thing:
> not letting an unauthorised write reach the CRDT.** Everything else is ordinary hygiene, and
> ordinary hygiene is what most projects get wrong anyway.

## Context

The asset that matters is **the integrity of the document**. Availability and confidentiality are
secondary: an unavailable demo is embarrassing, and a leaked board is a link someone already had. But
an integrity failure in a CRDT is unrecoverable, permanent, and visible. So the threat model is
weighted hard toward that, and the controls follow.

---

## 1. Threat model

Scope: the deployed system. The client is **not** a trust boundary — anything running in the user's
browser is fully under the user's control, so the client's checks are UX and the server's checks are
security.

### Assets

| # | Asset | Impact of compromise |
|---|---|---|
| A1 | Document content and history | Catastrophic. Undoable only by a full restore, which is itself a visible event |
| A2 | Write capability for a board | Catastrophic. Same as A1 |
| A3 | Board existence and titles | Low |
| A4 | Availability of the realtime tier | Medium. The demo depends on it |
| A5 | Database credentials | Catastrophic, and the database holds every board |
| A6 | Share tokens | Medium. Grants a role on one board |
| A7 | The app's own reputation as a portfolio piece | High, and not a joke |

### Trust boundaries

```
  ┌─ TB1 ──────────────────┐   untrusted until proven otherwise
  │  The browser           │  anything in it can be modified by the user
  │  → therefore: the      │  the client is a *display* of state, never a
  │  client is NOT a       │  source of authorization truth
  └────────────────────────┘
          │  HTTPS, WSS
  ┌─ TB2 ──────────────────┐   the network
  └────────────────────────┘
  ┌─ TB3 ──────────────────┐   authenticated but untrusted
  │  Any share-token holder│  a Viewer is a real, authenticated principal
  │  at role X             │  and is the primary attacker
  └────────────────────────┘
  ┌─ TB4 ──────────────────┐   internal
  │  The Node process      │  trusted, but a bug here is a total compromise
  └────────────────────────┘
  ┌─ TB5 ──────────────────┐   third-party
  │  Cloudflare, Neon, R2, │  trusted vendors; the risk is account compromise
  │  Sentry, GitHub        │
  └────────────────────────┘
```

The boundary that gets forgotten is **TB3**. Most attack surface thinking stops at "unauthenticated
user", and then a Viewer — who has a legitimate, valid token and a real WebSocket — is not modelled at
all. That is exactly where this project's risk lives.

### STRIDE walkthrough

| Threat | Example | Control | Test |
|---|---|---|---|
| **Spoofing** | Forging a Viewer token to get Editor rights | Token is 256 bits of CSPRNG entropy, stored hashed, signed, expiring, revocable ([06 §2](./06-auth-and-permissions.md#2-token-model)) | E2E: tampered token is rejected |
| **Spoofing (impersonation)** | A guest names themselves "Owner" | Guests are flagged as guests in the UI; no privilege derives from a name | Manual |
| **Tampering** | A Viewer sends a crafted binary update | Single `applyUpdate` behind the guard; arch test enforces it ([06 §3](./06-auth-and-permissions.md#enforcement-point)) | Adversarial E2E |
| **Tampering** | Editing an update in flight | WSS with a valid cert; TLS. A MITM cannot alter a frame | n/a |
| **Repudiation** | "I did not draw that" | Every update records `client_id` and `author_id`; named versions record the author; a restore is a new attributed change | Attribution shown in the version list |
| **Information disclosure** | A token leaking via `Referer` or logs | Exchanged and stripped from the URL; `Referrer-Policy: no-referrer`; redaction everywhere ([11](./11-error-tracking-and-logs.md#redaction)) | Grep the logs for a known token after a scripted run |
| **Information disclosure** | Board A's content served to a holder of board B's token | Every read is scoped by `(boardId, role)`; the WS resolves a role from the token's own board | Integration test: cross-board read returns 404 |
| **Denial of service** | 10,000 concurrent WS connections | Per-IP upgrade rate limit, 256 KB frame cap, backpressure, `MAX_ROOMS_PER_INSTANCE`, idle eviction | k6 with 100 clients |
| **Denial of service** | A 2 GB text paste | 256 KB frame cap, 10 MB upload cap, doc size alert | Unit test on the guard |
| **Denial of service** | A malformed binary frame crashing the server | `y-protocols` decoding is wrapped; a decode failure is caught per message and the socket is dropped, not the process | Fuzz the frame parser |
| **Elevation of privilege** | A Commenter writing to the document | Comments are a table, not doc content (D20); the `write` capability is absent for Commenter | E2E: Commenter's crafted update is rejected |
| **Elevation of privilege** | A share link with a forged `role` claim | The role comes from the `shares` row, never from the client. The client cannot assert a role | E2E: a token with an injected role is rejected |

### Accepted risks

Restated from [06 §7](./06-auth-and-permissions.md#7-what-is-explicitly-not-protected), because a threat
model that claims zero accepted risk has not been done.

| Accepted risk | Justification | Mitigation today | Planned mitigation |
|---|---|---|---|
| No encryption at rest beyond provider disk encryption | E2E would break presence, the timeline, and server-side authorization | Provider encryption, access limited to the app's DB credentials | Honest documentation |
| Guest display names are unverified | No accounts in v1 | `guest` flag in the UI | GitHub sign-in (Q7) |
| Awareness fan-out is O(n²) per room | Nothing in the design needs a broker | Throttle, batch, drop stale clients, cap bytes | k6 evidence at 50/100 |
| Per-instance rate limits | One instance | Documented in [14](./14-scaling.md) | A shared store when instance 2 exists |
| An XSS in a dependency reaches document data | This is a web app | CSP, no `dangerouslySetInnerHTML`, Sentry, Dependabot, minimal deps | See §3 |

---

## 2. Controls

### Transport

| Control | Value |
|---|---|
| HSTS | `max-age=63072000; includeSubDomains; preload` |
| TLS | 1.2 minimum, TLS 1.3 preferred, managed at the edge (Cloudflare) |
| WS | `wss://` only. The server rejects `ws://` upgrades except from `localhost` in dev |
| CORS | Exact `PUBLIC_ORIGIN` allowlist. No `*` with credentials. `Vary: Origin` |
| `Referrer-Policy` | `no-referrer` on all responses |
| `X-Content-Type-Options` | `nosniff` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | Deny camera, mic, geolocation. These are not used |
| `X-Frame-Options` | `DENY` — the app must not be framed. Clickjacking a canvas is a real attack |

### Content Security Policy

The strictest policy the app can actually run under, because a canvas app wants `blob:` for
exports and `data:` for image fallbacks.

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  connect-src 'self' https://*.sentry.io wss://*.onrender.com wss://*.koyeb.app;
  img-src 'self' data: blob: https://*.r2.dev;
  style-src 'self' 'unsafe-inline';            # only for the inline styles Tiptap writes
  font-src 'self';
  worker-src 'self' blob:;
  frame-ancestors 'none';
  base-uri 'none';
  form-action 'self';
  object-src 'none';
  upgrade-insecure-requests
```

Rules for keeping it strict:

- **No `unsafe-eval`.** That rules out some build tooling; the Vite build is configured to work
  without it. If a dependency demands `eval`, that dependency does not ship.
- `style-src 'unsafe-inline'` is a known concession, granted narrowly because ProseMirror sets inline
  styles. It is a comment on the first line of the policy file explaining exactly why.
- `'unsafe-inline'` in `script-src` is never granted. Sentry is loaded from the bundled SDK, not a
  CDN `<script>` tag, precisely so this stays true.
- A report-only rollout first, with violations in Sentry, then enforcement. A CSP that breaks the app
  in production is worse than a slightly loose one that is measured.

### Secrets

| Rule | Enforcement |
|---|---|
| No secret in the repo | `gitleaks` on the full history in CI and as a local pre-commit hook |
| No secret in `VITE_*` | A lint rule fails the build if a `VITE_` var matches `SECRET\|TOKEN\|KEY\|PASSWORD\|DATABASE\|URL` |
| No secret in a URL | A grep for `token=` in `src/` outside the one exchange call; a code review rule |
| No secret in a log | Redaction is on by default in the logger ([11](./11-error-tracking-and-logs.md#redaction)); a unit test feeds a known token through the logger and asserts it does not appear |
| No secret in an error report | Sentry `beforeSend` scrubs query strings, `Authorization`, and cookies |
| No secret in a client error boundary | The error boundary shows a request id, never a stack |
| Rotation | `JWT_SECRET` rotation is a scripted operation, not an improvisation, and the script is written before it is needed |

`.env.example` lists every variable with a placeholder and a comment. It is the documentation, and it
is reviewed whenever a variable is added.

### Input validation

| Input | Validation |
|---|---|
| Every REST body and query | Zod, from `packages/shared`, applied in a Fastify hook so no route can forget |
| Every WS control message | Zod, same schemas; a failure is a `ctl:error`, never a crash |
| Binary frames | Size cap, wrapped decode, `y-protocols` handles the rest |
| Shape geometry | Clamped and coerced to finite numbers; `NaN` and `Infinity` are rejected. A `NaN` in a `Y.Map` propagates to every replica and never converges — this is a real class of bug, not a hypothetical |
| Board and shape IDs | Pattern-validated (`brd_` + CUID2, `shp_` + CUID2). Never interpolated into SQL or a filesystem path |
| Document text | Tiptap's schema validates structure; plain text is bounded to 100 KB per block |
| Image uploads | Content-type allowlist **plus** magic-byte verification. Dimensions capped at 8,000 px to stop decompression bombs |
| Export format | Enum, never a caller-supplied string |
| Comment bodies | Length-capped in the DB `CHECK` and in Zod |

**NaN deserves emphasis.** It is a genuine convergence hazard: `Y.Map.set('x', NaN)` merges cleanly
as a value, and then every client renders nothing, and the state hashes differently depending on
which operations touched it. The shape factory coerces and asserts finiteness at the boundary, and a
fuzz case specifically injects `NaN` and `Infinity` into every numeric field.

### SQL

- **Parameterised queries only.** No string interpolation into SQL, anywhere. Enforced by
  `eslint-plugin-sql` style rules and reviewed.
- Identifiers come from a closed set of constants, never from user input.
- The database role for the app has no `CREATE`, no `DROP`, and no `ALTER`. Migrations run under a
  different role.
- `board_updates` grants the app role `INSERT` and `SELECT` only — no `UPDATE`, no `DELETE`
  ([05](./05-database-and-storage.md#2-schema)). Compaction runs under the migration role, which
  enforces invariant A3 at the database rather than in code.

### Resource exhaustion

| Resource | Cap | Where |
|---|---|---|
| WS frame | 256 KB | Handshake and every message |
| Concurrent WS per IP | 20 / 5 min | Upgrade handler |
| Awareness field size | 4 KB per client | Sanitised before broadcast |
| Awareness clients per room | 200; beyond that the oldest are dropped | Room manager |
| Rooms per instance | 50, LRU idle eviction | Room manager |
| Image upload | 10 MB, dimensions ≤ 8,000 px | Presigned policy + server check |
| Text per block | 100 KB | Schema validation |
| Shapes per board | Soft limit 50,000, with an alert | Schema validation + metric |
| Document size per board | Alert at 8 MB | Compaction worker metric |
| HTTP body | 256 KB (uploads go direct to R2) | Fastify config |
| Rate limits | Per [04 §9](./04-api-and-backend.md#9-rate-limiting) | Token bucket |

### Client-side

- **No `dangerouslySetInnerHTML`** anywhere. Grep-enforced in CI. Tiptap renders through ProseMirror,
  which builds DOM nodes, not strings.
- Tiptap is configured with a **closed schema**: only the extensions listed in
  [03 §4](./03-frontend.md#4-document-blocks). No arbitrary HTML, no pasted markup, no `iframe`.
- Pasted content is **sanitised on paste**, stripping everything outside the schema, then inserted
  through a ProseMirror transaction. A paste is the easiest XSS vector in a rich-text app.
- Markdown export goes through a **serialiser**, not a regex over HTML, and the output is served as
  `text/markdown`, never `text/html`.
- The SVG export is served as an attachment with a fixed content type and
  `Content-Disposition: attachment`. An SVG opened from the same origin can execute script; serving
  exports from a separate origin, or as an attachment, closes that.
- Images from R2 get `Content-Disposition: inline` with a strict content type and
  `X-Content-Type-Options: nosniff`.

---

## 3. Dependency and supply chain

The dependency list is a security control. Every package is a package that can execute code in the
browser and on the server.

| Control | Detail |
|---|---|
| Lockfile committed | `pnpm-lock.yaml`, and CI uses `--frozen-lockfile`. A resolved version cannot change under you |
| `pnpm audit` | Fails the build on `high` or `critical`. Dependabot opens the PRs |
| Minimal surface | Runtime deps are close to: `yjs`, `y-protocols`, `y-indexeddb`, `y-prosemirror`, `prosemirror-*`, `@tiptap/*`, `zustand`, `ws`, `fastify`, `zod`, `pino`, `@sentry/*`, `pg`, `react`. Anything else needs a PR note justifying it |
| No transitive bloat from a convenience package | A "utils" package that pulls 200 dependencies is a supply-chain surface and a bundle-size problem. Prefer three lines of local code |
| `scripts` allowlist | `pnpm.onlyBuiltDependencies` in `package.json` limits which packages may run install scripts. A dependency cannot execute code at install time without being listed |
| License check | CI asserts MIT/Apache-2.0/BSD. Anything else needs a note |
| Audit history | The full dependency tree diff is a nightly job, so a new transitive dep is visible |
| Provenance | Dependabot PRs are labelled and require the same checks as any other PR |

---

## 4. Pre-launch security checklist

Run through this before the demo goes public. It is a gate, not a suggestion.

**Authorization and integrity**
- [ ] A Viewer cannot write via the UI, REST, a crafted WS frame, or a replayed token
- [ ] A Commenter cannot write to the document; comments do not touch the CRDT
- [ ] `Y.applyUpdate` appears in exactly one module in `apps/realtime`, enforced by CI
- [ ] A role downgrade takes effect on a live socket within 5 s
- [ ] A cross-board read returns 404, not 403
- [ ] The app's DB role cannot `UPDATE` or `DELETE` `board_updates`

**Secrets and tokens**
- [ ] `gitleaks` clean on the **full git history**
- [ ] No secret in any `VITE_*` variable (lint rule active)
- [ ] A known share token appears in **zero** log lines after a scripted run
- [ ] The share token is stripped from the URL after load
- [ ] `JWT_SECRET` and R2 secrets are platform secrets, absent from the repo and from GitHub
- [ ] `.env` is gitignored and `.env.example` is current

**Injection**
- [ ] No string interpolation into SQL (grep + review)
- [ ] No `dangerouslySetInnerHTML` (grep-enforced in CI)
- [ ] Tiptap schema is closed; pasted HTML is sanitised
- [ ] Uploaded files are checked by magic bytes, not content type
- [ ] `NaN` and `Infinity` are rejected at the shape boundary (fuzz-covered)

**Transport and headers**
- [ ] HSTS, CSP (enforcing, not report-only), `no-referrer`, `nosniff`, `X-Frame-Options: DENY`,
      `Permissions-Policy` on every response
- [ ] WSS only; the `ws://` rejection works
- [ ] CORS is an exact allowlist, and the WS origin check is active
- [ ] Cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, host-only

**Resource limits**
- [ ] Frame cap, upload cap, rate limits, room cap, and awareness cap all enforced and observable
- [ ] A 2 GB paste is rejected without taking the process down
- [ ] A malformed binary frame drops one socket, not the server

**Third party**
- [ ] Sentry scrubs URLs, cookies, and `Authorization` in `beforeSend`
- [ ] Dependabot is enabled and green
- [ ] `pnpm audit` is clean at `high`

**Residual risk**
- [ ] The accepted-risk table in §1 is in the case study, in plain language, unhedged

## Acceptance

- [ ] The threat model is written up as `docs/threat-model.md` with all five boundaries and the
      STRIDE table, including accepted risks
- [ ] Every control above has a named test, and the test is in CI
- [ ] The pre-launch checklist is complete and the evidence is in the PR that deploys to production
- [ ] `pnpm audit` clean at `high`, `gitleaks` clean on full history
- [ ] CSP is enforcing in production with violations reported to Sentry
- [ ] At least one vulnerability was found and fixed by this process, and it is written up. A
      security section with no findings usually means it was not actually done
