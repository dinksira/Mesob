# 08 — CI/CD and Version Control

> **Status: draft** · Related: [07 Hosting](./07-hosting-and-cloud.md), [13 Testing](./13-testing.md), [09 Security](./09-security.md)

## Context

A solo project with a monorepo, three deployable units, a database, and a portfolio that has to
look like it was built by someone who knows what they are doing. The pipeline is where that
impression is earned or lost — it is also the first thing a reviewer opens.

Two principles:

1. **Fast feedback on the common case, deep verification on a schedule.** A push must not wait 20
   minutes for a k6 run, but a weekly run must not be skippable either.
2. **CI is the enforcement point for the invariants.** The architectural rules in
   [02 §11](./02-system-architecture.md#11-architectural-invariants) and the security checks in
   [09](./09-security.md) are not conventions. They are jobs that fail the build.

---

## 1. Version control

### Branching

Trunk-based. Short-lived branches, merged fast, long-lived `main`.

| Branch | Lifetime | Rules |
|---|---|---|
| `main` | forever | Always deployable. Protected: no direct push, all checks green, no force-push, linear history |
| `feat/<slug>` | 1–3 days | Branch from `main`, rebase or merge from `main` daily if it lives longer |
| `fix/<slug>` | < 24 h | Same rules. Prefix distinguishes hotfixes in the log |
| `release/v1.x` | Only if needed | Cut from `main`; fixes forward, never cherry-picked backwards |

No `develop` branch. A `develop` branch is a second source of truth that goes stale, and on a solo
project it is pure overhead.

- `main` is force-push protected and branch-protected on GitHub.
- Tags: `v0.1.0` … `v1.0.0`, signed (`git tag -s`), annotated.
- History is not rewritten after a tag is pushed. A reviewer who follows a link to a commit that no
  longer exists loses trust in everything else.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced by `commitlint` on a local
`commit-msg` hook and again in CI.

```
<type>(<scope>): <imperative summary under 72 chars>

<blank line>

<body: why, not what. Reference the ADR or the issue when relevant.>

<blank line>

BREAKING CHANGE: <what breaks and the migration path>
```

| Type | Use for |
|---|---|
| `feat` | A new capability |
| `fix` | A bug fix |
| `refactor` | Behaviour-preserving change |
| `perf` | A measured performance change — the body must include before/after numbers |
| `test` | Tests only |
| `docs` | Documentation only |
| `build` | Dependencies, tooling, config |
| `ci` | Pipeline changes |
| `chore` | Everything else |

Scopes mirror the repo: `web`, `realtime`, `api`, `schema`, `shared`, `sim`, `db`, `docs`.

Two conventions worth their own entries, because they make the git log a genuine design record:

- `perf` commits **must** contain measurements. A perf commit without numbers is a guess with good
  PR hygiene.
- `docs(adr):` commits add ADRs. The ADR directory is the argument for a decision, and the argument
  should be in version control before the code, not reconstructed afterwards.

### Pull requests

Template (`.github/pull_request_template.md`) requires:

```markdown
## What
One paragraph. The user-visible change.

## Why
The problem, or the issue link. If this is a design change, link the ADR.

## How it was verified
- [ ] Unit / property tests
- [ ] Integration (real Postgres)
- [ ] E2E (if UI or realtime)
- [ ] Manual check steps, with what you actually observed
- [ ] Perf numbers, if `perf` or if it touches the render loop

## Risk
What could break, and how would we notice? Which dashboard or alert covers it?

## Checklist
- [ ] No `console.log` in shipped code
- [ ] No secrets, no tokens in URLs, no new deps without a note in the PR
- [ ] Errors use the shared envelope
- [ ] Anything in this repo's docs that this changes has been updated in the same PR
```

Review rules on a solo project, to keep the standard honest:

- **Two passes minimum, always, on anything in the render loop, the sync protocol, auth, or
  persistence.** Open the PR, walk it, close it, reopen it. Reading something once does not count.
- **The "Risk" section is read before the diff.** A PR that touches compaction needs a plan for how
  a bug would be detected.
- A PR over ~400 lines of diff asks for a split, or at least a note on why it is one change.

### Repository hygiene

- `LICENSE` (MIT), `CODE_OF_CONDUCT`, `CONTRIBUTING.md`, `SECURITY.md` — a public portfolio repo with
  a `SECURITY.md` reads as professional and costs twenty minutes.
- `.gitignore` covers `node_modules`, `dist`, `.env*` (with `!.env.example`), `*.log`, `.wrangler`,
  `playwright-report`, `test-results`, coverage output, and the local Postgres volume.
- `CODEOWNERS`: `apps/realtime @me`, `packages/schema @me`, `docs/adr @me`. On a solo repo this is
  mostly a signal of intent.
- No committed lockfile churn. `pnpm-lock.yaml` is committed and CI fails if it changes without a
  `build`/`deps` commit type.

---

## 2. CI pipeline

GitHub Actions. Three workflows: `pr.yml` (fast gate), `main.yml` (deploy), `nightly.yml` (deep).

### Required status checks

These are the branch-protection requirements. Nothing merges without all of them green.

| Check | Target | Why it is required |
|---|---|---|
| `lint` | < 90 s | The cheapest possible feedback |
| `typecheck` | < 2 min | A type error is a build error; catching it here is free |
| `test:unit` | < 2 min | Fast, no I/O |
| `test:property` (200 runs) | < 3 min | A fast slice of the fuzz suite, enough to catch a real convergence bug |
| `test:integration` | < 5 min | Real Postgres, from a Neon branch |
| `test:e2e` | < 8 min | Playwright, Chromium only on PR, all browsers on `main` |
| `build` | < 3 min | All three apps build |
| `arch:test` | < 30 s | The invariant tests from [02 §11](./02-system-architecture.md#11-architectural-invariants) |
| `security:audit` | < 1 min | `pnpm audit --audit-level=high`, `gitleaks`, secret-pattern lint |
| `deps:check` | < 1 min | No unexpected new runtime dependency |
| `db:drift` | < 2 min | Migrations reproduce the schema from empty and from the previous version |

### Job graph

```yaml
# .github/workflows/pr.yml — the fast gate
jobs:
  install:      # pnpm install --frozen-lockfile, shared pnpm store via actions/cache
  lint:         # eslint + prettier --check + stylelint
  typecheck:    # tsc -b across the workspace, noEmit
  arch:         # dependency-cruiser + invariant greps + no-unguarded-apply
  unit:         # vitest --project unit
  property:     # vitest --project property (fast-check, 200 runs/case)
  integration:  # services: postgres:16  (or a Neon branch from CI secrets)
  build:        # web → dist, realtime + api → tsc + bundle
  e2e:          # playwright: install chromium, run against the built web + local server + pg
  security:     # pnpm audit, gitleaks, VITE_-secret lint, license check
  coverage:     # uploads to a service, posts a summary comment with a diff vs main
  preview:      # if all green: deploy web to a Cloudflare Pages preview URL
```

Parallelism and caching, because a slow pipeline gets ignored and then bypassed:

- `pnpm` store cached by `pnpm-lock.yaml` hash. Playwright browsers cached too — downloading them
  every run is the most common CI waste.
- `lint`, `typecheck`, `arch`, `unit`, `security` all run in parallel from one `install` job.
- `e2e` needs `build`, so it depends on it. Nothing else does.
- Concurrency group per branch: a new push cancels the previous run. Waiting for a stale run is
  worse than losing it.
- `timeout-minutes` on every job. A hung test must not hold a PR open for an hour.

### Coverage and quality gates

| Metric | PR gate | `main` gate |
|---|---|---|
| Line coverage, `packages/schema` + `packages/shared` | 90% | 95% |
| Line coverage, `apps/realtime` | 75% | 85% |
| Line coverage, `apps/web` canvas + collab | 60% | 70% |
| Line coverage, `apps/api` | 80% | 90% |
| **Render-loop allocation rate** | **0 bytes/frame** | 0 |
| Convergence fuzz runs | 200 | 10,000 |
| a11y (axe on the main routes) | 0 serious | 0 serious |

Coverage is a floor, not a target. The interesting assertion is the **allocation rate in the draw
loop**, which is a behavioural property rather than a line count and cannot be gamed by writing tests
that call functions.

### `main.yml` — deploy

Triggered by a push to `main`, after `main` is green.

```
1.  build all artifacts once, upload as an artifact
2.  create a Neon branch for this commit, run migrations against it,
    run the full test suite against the branch database
3.  merge the branch into main, apply migrations to the production database (advisory-locked)
4.  deploy realtime + api to Render  → wait for /ready
5.  deploy web to Cloudflare Pages (production)
6.  smoke test against production: create board → WS write → verify row → restore version
7.  post a summary to the Actions run: SHA, migration list, deploy URLs, smoke test result,
    and a link to the dashboards
8.  tag if this is a release commit (`release: v1.2.0`)
```

The Neon-branch step is the reason to pick Neon in Q1: a full integration suite against a real
database, per commit, for free, with no risk to production.

### `nightly.yml` — deep verification

Scheduled at 03:00 UTC, and dispatchable by hand. This is where the slow confidence lives.

| Job | What |
|---|---|
| `fuzz:full` | 10,000 runs per property, all concurrency models ([13](./13-testing.md#3-property-and-fuzz-testing)) |
| `fuzz:matrix` | 2–16 clients × up to 5,000 ops × reordering, duplication, and drop rates, output as a JSON matrix that trends in the repo |
| `e2e:all-browsers` | Chromium, Firefox, WebKit |
| `load:k6` | 50 and 100 clients, 10 min, publish p50/p95/p99 and bandwidth |
| `perf:canvas` | Frame time at 1k/5k/20k shapes; fail if p95 regresses > 10% against `main` |
| `dep:audit` | Deep `pnpm audit`, license conformance, and a diff of the dependency tree |
| `backup:drill` | Restore last week's branch to a scratch DB and verify a board's state vector matches |
| `storage:report` | Sizes, row counts, compaction lag, and the doc-growth chart inputs |
| `fuzz:update` | `renovate`/`dependabot` PRs, batched weekly rather than daily |

Nightly failures post to a dedicated channel and **do not** block anything. A nightly that blocks
delivery trains you to ignore it.

### Deploy environments

| Environment | Trigger | Data | Purpose |
|---|---|---|---|
| `preview` | Every PR | A Neon branch, seeded | Review a real board with real migrations |
| `staging` | Manual, or a `release/*` push | A separate Neon database | Rehearse a deploy and a rollback |
| `production` | Push to `main` | Production | The demo and the portfolio URL |

`staging` exists so that "rehearse a rollback" is a real answer rather than a claim. The
environment variables are separate, the database is separate, and the smoke test runs against both.

### Secrets

- GitHub **Actions** secrets for `main`/`nightly`; **Environments** with required reviewers for
  production deploys.
- Pull requests from forks get **no** secrets, and the workflows that need secrets are guarded so a
  fork PR cannot exfiltrate them. Dependabot PRs are treated as forks.
- `DATABASE_URL` for CI comes from a **Neon branch** created by the workflow, not from a long-lived
  credential.
- `JWT_SECRET` and `R2_SECRET_ACCESS_KEY` exist only in the deploy platform's secret store, never in
  GitHub, unless a deploy genuinely needs them.
- `gitleaks` scans the **full history** on the security job, because a secret deleted in a later
  commit is still in the history and still on GitHub.

### Release process

Semantic versioning, with the CRDT document schema versioned **separately and explicitly**:

| Change | Version bump | Schema version |
|---|---|---|
| New shape type, new doc-block feature | minor | **minor bump** (older clients refuse to connect) |
| New toolbar button, new presence colour | minor | no |
| Performance fix, no behaviour change | patch | no |
| Any change to existing Yjs keys or their meaning | **major** | **major bump + migration** |

The schema version is the contract with already-stored documents. Bumping the package version
without thinking about the schema is how a deploy corrupts existing boards, so the release script
refuses to proceed if `schema_version` changed without a migration file in `packages/schema/src/migrations/`.

Release steps: bump version → `CHANGELOG.md` from commit messages → run the full suite → tag
`v1.x.y` signed → deploy → smoke test → publish the changelog section to the repo. No release
branch and no cherry-picking; `main` is the release.

## Acceptance

- [ ] `main` is protected and nothing merges without all 12 required checks
- [ ] A PR runs the fast gate in under 12 minutes, in parallel where possible
- [ ] Every PR gets a working preview URL with a real migrated database behind it
- [ ] A deploy to production is a single merge and produces a smoke-test result in the run summary
- [ ] A rollback has been rehearsed against `staging`
- [ ] Nightly runs 10,000 fuzz iterations and publishes a trending matrix
- [ ] `gitleaks` passes on the full history, and fork PRs cannot reach secrets
- [ ] The release script refuses a schema change without a migration
- [ ] `CHANGELOG.md` is generated from commits, not written by hand
