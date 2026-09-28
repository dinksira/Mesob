# 10 — Caching and CDN

> **Status: draft** · Related: [03 Frontend](./03-frontend.md), [07 Hosting](./07-hosting-and-cloud.md), [01 NFRs](./01-system-design.md#4-non-functional-requirements)

## Context

Caching in this app is unusually important and unusually dangerous, for the same reason: **the
document is local-first and the network is optional.** A cache that serves a stale app shell is an
annoyance. A cache that serves a stale document is a data-corruption bug wearing a performance
costume.

The rule that resolves every case below: **cache aggressively for the *app*, never for the
*document*.** The document is served to exactly one client from exactly one place, and it is
already cached locally by IndexedDB, which is the cache that matters.

---

## 1. Cache policy matrix

The single reference table. Every `Cache-Control` header in the project comes from here, and the
headers are set in one module (`apps/web/src/lib/http-headers.ts` and the Fastify hook on the API) so
there is no per-route guessing.

| Resource | `Cache-Control` | CDN | Browser | SW strategy | Notes |
|---|---|---|---|---|---|
| `index.html` | `public, max-age=0, must-revalidate` | yes, short TTL | revalidate every load | **Network-first**, fall back to cache | The deploy pointer. Must never be stale, must work offline |
| Hashed JS/CSS chunks | `public, max-age=31536000, immutable` | 1 year | 1 year | **Cache-first** | Content-hashed, so immutable is true |
| Fonts, static images in the bundle | `public, max-age=31536000, immutable` | 1 year | 1 year | Cache-first | |
| `sw.js` | `no-cache` | revalidate | revalidate | never cached by itself | The SW must always be checked, or updates never ship |
| `manifest.webmanifest` | `public, max-age=3600` | 1 h | 1 h | Cache-first | |
| Sentry SDK bundle | `public, max-age=3600` | 1 h | 1 h | none | |
| **`/api/v1/boards/:id`** | `private, max-age=0, must-revalidate` + `ETag` | **no-store** | revalidate (`304`) | **never** | Metadata changes; a shared cache must not hold it |
| **`/api/v1/boards/:id/versions`** | `private, max-age=30` | no | 30 s | never | Short TTL; a stale version list is confusing but harmless |
| **`/api/v1/boards/:id/versions/:vid/state`** | `private, max-age=0, must-revalidate` + `ETag` | no | revalidate | never | Historical state is immutable, so a long TTL would be safe — but a `304` is cheaper and the risk of getting it wrong is high |
| **`/api/v1/boards/:id/shares`** | `private, no-store` | no | none | never | Contains security state |
| `POST` everything | `no-store` | no | none | never | |
| `GET /api/v1/health`, `/ready` | `no-store` | no | none | never | Health must be live |
| **`/rooms/:id` (WebSocket)** | n/a | n/a | n/a | never | A WS upgrade is not cacheable; the CDN must not buffer it |
| **R2 images** | `public, max-age=31536000, immutable` | 1 year | 1 year | Cache-first, capped | Immutable and content-addressed ([05 §7](./05-database-and-storage.md#7-object-storage-r2)) |
| **R2 exports** | `private, max-age=0` + signed URL (1 h) | no | session | never | Attachments expire |
| Sentry `envelope` endpoint | `no-store` | no | none | never | |
| `/metrics` | `no-store` + bind to localhost | no | none | never | Never publicly reachable |

Two lines deserve emphasis because they are the ones people get wrong:

- **`index.html` is `max-age=0, must-revalidate`.** A long TTL on the HTML is the single most common
  cause of "my users are running last week's app". The HTML is tiny; revalidating it costs nothing.
- **Everything board-specific is `private` or `no-store`.** A CDN in front of the API is a
  correctness liability for a document app, and the CDN saves nothing because the API traffic is
  small and the document does not come from the API at all.

---

## 2. The service worker

`injectManifest` strategy, so the caching logic is written rather than generated. The generated
`generateSW` strategy cannot express "network-first for the shell, never for the API", which is
exactly the requirement.

### Precache manifest

Precache: `index.html`, all hashed chunks, fonts, the manifest, and the offline fallback page.
**Never** precache: anything under `/api/`, anything under `/rooms/`, anything with `?token=`.

Precaching a tokenised URL would bake a share token into the SW cache where it survives logout, and
precaching the API would mean serving a stale permission to a revoked user. Both are non-negotiable
`never`s, and both are asserted by a test that reads the generated precache list.

### Runtime strategies

| Match | Strategy | Rationale |
|---|---|---|
| Hashed static assets | Cache-first, then network, then cache | Immutable by construction |
| `index.html`, navigations | Network-first, 3 s timeout, then cache, then `/offline` | Always get the new deploy if the network allows; always work if it does not |
| Fonts from a third party | Cache-first, 30-day cap | Currently self-hosted; kept for safety |
| **Any `/api/` GET** | **Network-only** | Never cached. `fetch` fails offline and the app falls back to IndexedDB |
| **Any `/rooms/`** | **Never intercepted** | `fetch` does not see WebSocket frames; the SW must not even attempt to pass through, and any `connect` handler must be a no-op |
| R2 images | Cache-first, 200 entries, 50 MB cap | Makes a previously-seen board render instantly, and bounds the quota |
| Everything else | Network, no cache | The default must be the safe one |

### Quota management

```ts
navigator.storage.estimate()          // show remaining quota in the UI
// image cache: LRU eviction at 200 entries or 50 MB
// if navigator.storage.persist() is grantable, request it: without it, the browser
// may evict IndexedDB under pressure, and that is silent data loss for an offline-first app
```

Requesting persistent storage is easy to forget and its absence is a real correctness risk: a
browser under disk pressure will evict the origin's IndexedDB, and the user's offline edits go with
it. A one-line permission request at first board open, with a fallback notice if it is denied.

### Update handling

```ts
registration.addEventListener('updatefound', () => {
  const sw = registration.installing
  sw.addEventListener('statechange', () => {
    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
      // A new version is ready. Do NOT skipWaiting automatically while a board is open:
      // swapping the SW mid-session means a half-old, half-new bundle against a live Y.Doc.
      showToast('A new version is available', { action: 'Reload', onClick: () => location.reload() })
    }
  })
})
```

**No automatic `skipWaiting`.** Activating a new bundle while a user is mid-edit on a live document
is a real way to corrupt state, and the correct behaviour — a toast with a reload button — costs one
line. This is a case where the obvious "just reload the user" convenience is wrong, and saying so in
a comment is worth it.

---

## 3. HTTP caching in the app

### ETag

Board metadata and version state are `ETag`-based. The client holds a small in-memory cache and
sends `If-None-Match`, so re-opening a board costs a `304` with no body.

```ts
// ETag for a bytea column: a hash of the content, computed in Postgres with md5() (fast, and this
// is a cache validator, not a security primitive)
SELECT id, md5(state) AS etag FROM board_snapshots WHERE id = $1
// → ETag: "W/\"a1b2c3\"", Cache-Control: private, max-age=0, must-revalidate
```

Snapshots are immutable, so a `304` here is essentially free bandwidth, and the `md5` in the database
means the server does not need to read the blob to answer.

### The app's own caches

| Cache | Where | Invalidated by |
|---|---|---|
| Board metadata | `Map<boardId, {data, etag}>` in memory, LRU 50 | `If-None-Match` on next read; cleared on `DELETE` |
| Version index | In-memory per board | On a new version, or 30 s TTL |
| Rendered board snapshots | Not cached — a version state is read once into a `viewerDoc` and dropped | n/a |
| Awareness | Yjs awareness, in memory only | Never cached. Presence is not data |
| Command palette commands | Static, built at compile time | Build time |

There is deliberately **no document cache in the client beyond IndexedDB**. The Y.Doc in memory *is*
the document; a second copy in a hand-rolled cache would be a third source of truth and would
desynchronise.

---

## 4. CDN configuration (Cloudflare)

| Setting | Value | Why |
|---|---|---|
| Pages | Automatic, atomic, global | No configuration needed |
| Brotli | on | ~20% smaller JS |
| HTTP/3 | on | Better on lossy mobile connections |
| Early Hints | on | Fonts and the shell preconnect |
| Tiered caching | on, if available on the plan | Cuts origin hits for the shell |
| Cache Rules | Hashed assets → 1 year immutable; HTML → revalidate; `/api/*` → bypass | Mirrors §1 exactly |
| `Cache-Control: no-store` on `/api` | enforced at the edge as well as the origin | Defence in depth against a misconfigured route |
| Brotli for `application/wasm` | on, if added later | Future stretch |
| Early purge on deploy | Pages handles it | Atomic, so no purge is needed |
| Always Use HTTPS | on | |
| Bot Fight Mode | on | Cheap, and this is a public URL |
| Rate limiting rules | 60 req/min per IP on `/api/*` | Coarse edge limit; the app's own limiter is finer |
| WAF managed rules | on, free tier | |
| Origin certificate | Full, strict | No `flexible` |
| `Cache-Control` for R2 custom domain | 1 year immutable, matching the object headers | Images are content-addressed |

**What is deliberately not enabled:** no service-worker-side API caching, no HTML minification at the
edge, no "optimise JavaScript" toggle (it breaks source maps, which Sentry needs),
no `Rocket Loader` (it rewrites module loading).

---

## 5. Caching anti-patterns to avoid

Named explicitly, because each of these is a bug someone will otherwise write.

| Anti-pattern | Why it is wrong here |
|---|---|
| Cache the board document in a CDN or a service worker | The document comes from a WebSocket, not HTTP. Even the version-state endpoints are per-viewer |
| Long `max-age` on `index.html` | Users stuck on an old bundle, against a new server. Stale clients with a new protocol is a data-loss path |
| `Cache-Control: public` on anything board-scoped | A shared cache could serve board A's metadata to board B's viewer |
| `skipWaiting` + `clients.claim` on update | Swaps code mid-session against a live Y.Doc |
| SW caching `POST` or WS traffic | A cached permission or a mangled update stream |
| Caching by URL while ignoring the `Vary: Origin` header | CORS-correct response served to the wrong origin |
| Precache entries containing a token | A share token baked into a cache that outlives the session |
| A hand-rolled document cache in React state | A third source of truth, guaranteed to drift |
| Relying on the CDN for correctness | The app must be correct with a cold CDN, because offline-first means the CDN is often absent |

---

## 6. Measuring it

| Metric | Target | Where |
|---|---|---|
| Cache hit ratio, hashed assets | > 95% | Cloudflare analytics |
| LCP, board open, warm cache | < 1.2 s | Lighthouse CI on the PR preview |
| LCP, cold cache | < 2.5 s | Lighthouse CI |
| TTI from IndexedDB, network blocked | < 1 s | Perf harness ([13](./13-testing.md#9-performance-testing)) |
| HTML revalidations per session | 1–2 | Cloudflare analytics |
| SW install success rate | > 95% | Sentry breadcrumb + a metric |
| Storage quota used vs available | < 50% | Reported in settings UI |
| Stale-bundle incidents | 0 | Support; would show as a client/server version mismatch |

`lighthouse-ci` runs on the preview deploy with a budget config committed to the repo, so a
regression in bundle size or LCP fails the build rather than being noticed later:

```json
{ "budgets": [
    { "path": "/assets/*.js", "resourceSizes": [{ "limit": "350 kB", "gzip": true }] },
    { "path": "/*", "resourceCounts": [{ "threshold": 25 }] },
    { "resourceType": "total", "resourceSizes": [{ "limit": "600 kB", "gzip": true }] }
]}
```

## Acceptance

- [ ] Every response's `Cache-Control` matches §1, verified by a test that walks the real routes
- [ ] The precache manifest contains no `/api/`, no `/rooms/`, and no tokenised URL (asserted in CI)
- [ ] The app is fully functional with the network blackholed, including the first load after install
- [ ] A new deploy is picked up on the next navigation, and mid-session swaps never happen silently
- [ ] LCP meets the budget on the preview deploy, and `lighthouse-ci` fails the build on regression
- [ ] Hashed-asset cache hit ratio > 95%
- [ ] Persistent storage is requested, and quota exhaustion is handled without losing the document
- [ ] The CDP cache and the IndexedDB contents are unaffected by a deploy
