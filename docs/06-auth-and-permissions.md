# 06 — Auth and Permissions

> **Status: draft** · Depends on: [04](./04-api-and-backend.md) · Related: [09 Security](./09-security.md)
> **This is the highest-risk document in the folder.** Read §3 carefully.

## Context

Mesob's permission model has one unusual property that drives every design decision here: **a CRDT
update, once merged, is nearly impossible to remove.** Ordinary CRUD permissions can be enforced on
write and repaired afterwards. A CRDT cannot. So the rule is not "check permissions on write", it is
"never allow an unauthorized write to reach the document in the first place."

---

## 1. Identity model

Guest-first. The design goal is that the friction between "I have a link" and "I am drawing on this
board" is one click.

| Tier | Identity | Persistence | Use case |
|---|---|---|---|
| **Anonymous visitor** | none | none | Reads the landing page |
| **Guest** | A display name and a colour, chosen in the client and kept in `localStorage` | Name and colour, not identity | Joins via a share link, collaborates, cannot be re-identified |
| **Signed-in user** | GitHub OAuth → a `users` row | Durable | Owns boards, can list them, survives clearing local storage |

A guest's `userId` is `gst_<random>` generated client-side. It is **not** an account and confers no
privileges. Guests are named in awareness with a `guest` flag, and the UI says "Selam (guest)" so no
one mistakes an unverified name for an identity.

- GitHub OAuth is a **stretch** ([index Q7](./README.md#open-questions)). v1 is guest-only, which
  keeps the auth surface to one signed token type and one cookie.
- No passwords, ever. There is nothing to phish, nothing to hash badly, nothing to reset.

---

## 2. Token model

Three credentials, with different lifetimes and different uses. Keeping these distinct is what makes
revocation tractable.

| Credential | Format | Lifetime | Where it lives | Purpose |
|---|---|---|---|---|
| **Share token** | `shr_<id>.<32 random bytes base64url>` | Default 30 d, max 90 d | Query string once, then exchanged | The link a human pastes into Slack |
| **Session cookie** | Opaque, 32 bytes, `HttpOnly Secure SameSite=Lax` | 12 h, sliding | Cookie | The credential used afterwards |
| **Signed assertion** | JWT, HS256, 2 min | 2 min | `localStorage`, in-memory | Proves a session to a sub-request without a cookie round trip |

Only the **hash** of the share token is stored (`shares.token_hash`, see
[05 §2](./05-database-and-storage.md#2-schema)). A database dump does not yield usable share links.

### Share token anatomy

```
shr_01HQ8K3M….7f2a
└┬──┘ └─────┬────┘
 │         └─ 256 bits of CSPRNG entropy, base64url, ~43 chars
 └─ the shares.id, so lookup is a primary-key hit, not a scan of hashes
```

The `id` prefix is not a secret. The random part is. This makes the hot path in the WebSocket
handshake a single indexed lookup instead of a hashing operation per connection, which matters when
50 clients reconnect at once.

### Exchange flow

```
GET /b/brd_x?token=shr_01HQ….7f2a
  │
  ├─ client: fetch /api/v1/share/<token>/exchange
  │     server: SELECT shares WHERE id = ?
  │             verify scrypt(token secret) == token_hash
  │             check revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
  │             → set session cookie, HttpOnly, Secure, SameSite=Lax, 12 h
  │             → increment use_count, set last_used_at
  │             → return { boardId, role, capabilities, sessionExpiry }
  │
  └─ client: history.replaceState(null, '', '/b/brd_x')     ← token leaves the URL
```

The token is **burned** from the URL on the first load. After that it lives only in an `HttpOnly`
cookie that JavaScript cannot read, which removes it from browser history, from `Referer` headers,
from the crash reporter's breadcrumbs, and from a screenshot of the address bar. This is the single
highest-leverage security decision in the auth model and it costs one line.

### Token transport risks and mitigations

| Risk | Mitigation |
|---|---|
| Token in browser history | Exchanged and `replaceState`d away immediately |
| Token leaked via `Referer` to a third party | `Referrer-Policy: no-referrer`; no third-party scripts on board routes beyond Sentry, and Sentry is configured to not capture the URL query ([11](./11-error-tracking-and-logs.md#redaction)) |
| Token in a screenshot or a Slack preview | Short default expiry, named and revocable links, `use_count` so an owner can see a link that has been used suspiciously |
| Token in a log line | Never logged. The handshake logs `shareId` and `role`, never the token. Log redaction in [11](./11-error-tracking-and-logs.md#redaction) |
| Token in a proxy access log | Query strings are the default target. The WS path uses the token, so the WS access log is configured to strip the query, and the REST exchange path is a POST body, which proxies do not log by default |
| Stolen token used indefinitely | Expiry + single-use exchange + per-board revocation list |
| Guest escalating to Owner | A guest's capabilities are derived from the share's role on every request. There is no client-side flag to tamper with because the server never reads one ([§3](./06-auth-and-permissions.md#enforcement-point)) |

---

## 3. Enforcement point

**The single most important section in this document.**

```
  There is exactly ONE place in the server that applies a document update,
  and it is behind the authorization guard.

  apps/realtime/src/protocol/sync.ts   ← the only Y.applyUpdate on an inbound frame
  apps/realtime/src/guards/canWrite.ts ← the only thing allowed to call it

  Enforced by an architecture test in tests/architecture/no-unguarded-apply.test.ts
  which fails CI if Y.applyUpdate appears in apps/realtime outside that module.
```

### Enforcement point

| Surface | Checked | When | Result of a failed check |
|---|---|---|---|
| REST API | yes | every request, per route, per role | `403` |
| WebSocket **upgrade** | yes | before the handshake completes | connection refused, `4401` |
| WebSocket **sync: read** | yes | every sync message | `4403` close |
| WebSocket **sync: write** | yes | **before `applyUpdate`** | message dropped, `ctl:error`, metric incremented |
| WebSocket **awareness** | yes (read-level) | every awareness message | dropped if the role lost read access |
| Version restore | yes | route, owner only | `403` |
| Upload / export | yes | route, role-based | `403` |
| Comments | yes | route, commenter+ | `403` |
| Client UI | **no** | — | Cosmetic. The buttons are hidden, and a patched client changes nothing |

The asymmetry in the last two rows is the point. Hiding a button is a UX courtesy. The server does
not care what the client believes.

### Why not filter after the merge

Three reasons, and the first is decisive:

1. **It is not reliable.** A malicious client can send a legal-looking binary frame containing an
   update for any shape. Once `applyUpdate` runs, the damage is in the CRDT. Detecting "this shape
   was not in your write set" is a heuristic, and heuristics on binary CRDT payloads are how you get
   a security incident.
2. **It is not undoable.** To remove merged content you must issue new operations, which become part
   of history, which every client then has to be told about, which is a second update. Restore-as-a-
   forward-change ([02 §9](./02-system-architecture.md#9-restore-semantics)) is the honest tool and it
   is an owner action, not a security mechanism.
3. **It leaks the data.** A read filter that denies a shape after it was merged still sent the shape
   over the wire.

---

## 4. Role matrix

| Capability | Owner | Editor | Commenter | Viewer |
|---|:--:|:--:|:--:|:--:|
| Read the document | ✅ | ✅ | ✅ | ✅ |
| See presence of others | ✅ | ✅ | ✅ | ✅ |
| See own presence broadcast to others | ✅ | ✅ | ✅ | ✅ |
| Create / move / resize / delete shapes | ✅ | ✅ | ❌ | ❌ |
| Edit document block text | ✅ | ✅ | ❌ | ❌ |
| **Send any document update** | ✅ | ✅ | ❌ | ❌ |
| Undo own edits | ✅ | ✅ | ❌ | ❌ |
| Upload images | ✅ | ✅ | ❌ | ❌ |
| Restore a version | ✅ | ❌ | ❌ | ❌ |
| Create a named version | ✅ | ✅ | ❌ | ❌ |
| Add and resolve comments | ✅ | ✅ | ✅ | ❌ |
| Create / revoke share links | ✅ | ❌ | ❌ | ❌ |
| Rename / archive the board | ✅ | ❌ | ❌ | ❌ |
| Delete the board | ✅ | ❌ | ❌ | ❌ |
| See the version history | ✅ | ✅ | ✅ | ✅ |
| Export (PNG / SVG / MD) | ✅ | ✅ | ✅ | ✅ |
| Read the conflict visualizer | ✅ | ✅ | ✅ | ✅ |

Three notes on the edges:

- **Restore is Owner-only**, even though Editors can create named versions. Restoring rewrites the
  visible state for everyone including other Editors' work, so it is a board-level decision. A
  reasonable alternative is to let Editors restore only to a version they created; the simpler rule
  wins for v1 and the code path is the same either way.
- **Commenter writes comments, not the document.** This is the whole reason comments are a table and
  not doc content (D20). If comments were doc content, Commenter would be Editor.
- **Viewer can export.** Exports are read operations, and a read-only user being unable to save a
  copy of what they can see is a surprising restriction. If that feels wrong in testing, the fix is a
  one-line capability change, which is exactly why capabilities are data rather than `if (role === …)`
  scattered through the code.

### Capabilities as data

```ts
// packages/shared/src/capabilities.ts
export const CAPABILITIES = {
  owner:     ['read','presence','write','undo','upload','version.create','version.restore',
              'share.manage','board.write','board.delete','comment.write','comment.resolve','export'],
  editor:    ['read','presence','write','undo','upload','version.create',
              'comment.write','comment.resolve','export'],
  commenter: ['read','presence','version.read','comment.write','export'],
  viewer:    ['read','presence','version.read','export'],
} as const satisfies Record<Role, readonly Capability[]>

export function can(role: Role, cap: Capability): boolean {
  return (CAPABILITIES[role] as readonly string[]).includes(cap)
}
```

One table, one function, imported by both the client (to render the UI) and the server (to enforce).
The client and server cannot drift, and the role matrix above is a rendering of this constant rather
than a second, hand-maintained source of truth. Adding a capability is a one-line change that is
visible in one place.

The server sends its own `can()` result to the client via `ctl:role` at connect time, and the client
uses **that**, not its local computation, for anything that matters. The local computation exists only
to avoid a flash of enabled buttons before the socket opens.

---

## 5. Session handling

| Property | Value | Reason |
|---|---|---|
| `SameSite` | `Lax` | `Strict` would break the share-link landing. `Lax` still blocks cross-site POST |
| `Secure` | always in production | — |
| `HttpOnly` | yes | The session cannot be read by XSS |
| `Domain` | host-only | No subdomain exposure |
| `Path` | `/` | The WS handshake is on the same host path |
| Lifetime | 12 h, sliding on use | Long enough for a workshop, short enough to matter |
| Rotation | On every privilege change and every 6 h | Limits the value of a stolen cookie |

A session cookie is opaque and random; there is nothing in it to tamper with. The server looks it up
in an in-memory map with the DB as the durable backing (`sessions` is a Postgres table, hashed keys
only). Revoking a session is a row delete, which takes effect on the next request.

**Why not a JWT session cookie?** Statelessness is not worth anything here — one instance, a database
round trip is already required for the role, and a JWT cannot be revoked before expiry. The share
token *is* a JWT-shaped signed assertion, but it is exchanged and burned, so its statelessness
matters only for the duration of one handshake.

---

## 6. Revocation

| Trigger | Detection | Effect | Latency |
|---|---|---|---|
| Share deleted | `revoked_at` set | Sockets holding that share get `ctl:kick 'revoked'` and close `4403` | < 5 s |
| Share expired | checked at handshake and on a 60 s timer per connection | Same, reason `'expired'` | ≤ 60 s |
| Role downgraded | role changed on the `shares` row | `ctl:role` with the lower role; the socket keeps working at reduced rights, write attempts start failing | < 5 s |
| Board deleted | `status='deleted'` | All sockets closed, reason `'revoked'` | < 5 s |
| Session revoked | `sessions` row deleted | Next HTTP request `401`; the WS is closed on the next role check | ≤ 60 s |

The implementation is a periodic re-check plus a direct push for the explicit cases:

```
setInterval(60s):
  for each conn: re-verify share validity (cheap: a query on the share id, memoised per share per minute)
  if invalid → ctl:kick + close
```

The memoisation matters: 50 clients on one board must not become 50 identical queries per minute.
Cache the share row for 60 s keyed by `shareId`, and only a changed `revoked_at`/`expires_at`/role
triggers a push. There is also a direct push on the `DELETE /shares/:id` path so the common case is
instant, with the sweep as the backstop.

Revocation **within 5 seconds** is an E2E test, not an aspiration
([13](./13-testing.md#7-security-tests)).

---

## 7. What is explicitly not protected

Stating this is part of the threat model.

| Not protected | Why | Accepted because |
|---|---|---|
| Reading a board you have a valid link to | That is the product | Links are the distribution mechanism; owners revoke them |
| Board titles and shape content being stored unencrypted at rest | Full-disk encryption from the provider | E2E would break presence, the timeline, and server-side authorization, which are the product |
| A guest choosing a display name that impersonates someone | No verification in v1 | The UI shows the `guest` flag; GitHub sign-in is the fix |
| Rate limiting across instances | Per-instance token bucket | One instance ([14](./14-scaling.md)) |
| Anonymous abuse beyond rate limits | — | Bounded by the rate limits and the absence of accounts |
| The conflict visualizer's op log | It shows CRDT internals, not secrets | Only reachable with board read access; it is a feature |

The honest version of this table is what goes in the case study. A threat model that claims to
protect everything is a threat model nobody believes.

## Acceptance

- [ ] A Viewer cannot write through the UI, the REST API, a hand-crafted WS frame, or a replayed token
- [ ] A revoked or expired share token is rejected at the handshake **and** mid-session, within 5 s
- [ ] The share token is absent from the URL after load, and absent from every log line and Sentry event
- [ ] `Y.applyUpdate` appears in exactly one module in `apps/realtime`, enforced by a CI test
- [ ] The role matrix in this document is generated from `CAPABILITIES`, not maintained by hand
- [ ] A role downgrade takes effect on a live socket without a reconnect
- [ ] Rate limits hold under a 10× burst and return `Retry-After`
- [ ] `pnpm audit` is clean, there are no plaintext secrets, and `gitleaks` passes on the full history
