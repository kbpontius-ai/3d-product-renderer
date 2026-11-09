# 06 — Engineering Conventions

House rules for this repo. This file is the "best practices" carry-over: correct anything that
doesn't match how you like to work, and it becomes the standing contract.

---

## Repo layout (monorepo, pnpm + Turborepo)

```
apps/
  web/            Next.js app (UI + BFF route handlers)
  worker/         TS job consumer; invokes Blender render scripts
  cad-pipeline/   Python (OCCT + bpy) admin ingestion tooling
packages/
  design-schema/  Zod schemas + types for Design Document / RenderJob spec (shared, versioned)
  materials/      Neutral material definitions + three.js and Cycles mappings
  artwork/        SVG sanitize / normalize / derive-maps (server-side)
  ui/             Design system components
  config/         eslint, tsconfig, tailwind, prettier presets
infra/            Terraform
docs/             These documents + ADRs
```

Rule: anything consumed by **both** the preview and the renderer lives in `packages/`, never
duplicated. Duplication there is how WYSIWYG dies.

## Language & typing

- TypeScript `strict` everywhere; `noUncheckedIndexedAccess` on. No `any` in committed code —
  `unknown` + narrowing instead. `// @ts-expect-error` requires a comment explaining why.
- Validate at boundaries with Zod (HTTP in/out, queue payloads, env vars); infer types from schemas
  rather than declaring them twice.
- Python (cad-pipeline) is typed and formatted with `ruff` + `mypy`; it is tooling, not a second
  application layer.

## Code style

- Prettier + ESLint (typescript-eslint, react-hooks, jsx-a11y, import ordering) — CI-enforced.
- Files under ~300 lines and functions under ~50 as a smell threshold, not a hard rule.
- Naming: descriptive over clever. Units in names when physical (`depthMm`, `widthPx`, `uvOffset`).
- **Units convention: millimetres for anything physical, pixels only inside raster code, UV in 0–1.**
  Conversions happen in one place per direction and are unit-tested.
- Comments explain *why*; the code already says what. No commented-out code in commits.
- Errors: typed error classes with codes; never swallow; user-facing messages separated from
  diagnostic detail (the user sees "text isn't outlined", the log sees the parser trace).

## Data & migrations

- Every schema change is a reviewed, reversible migration; no destructive change without a
  documented expand→migrate→contract sequence.
- Design documents are versioned JSON with an explicit `schemaVersion` and forward migrations —
  old designs must keep opening and re-rendering identically.
- IDs: UUIDv7/ULID. Timestamps: UTC, `timestamptz`. Money/cost: integer minor units.
- RLS policies ship with the migration that creates the table.

## API conventions

- REST-ish route handlers, resource-oriented, plural nouns; server actions only for simple form
  mutations.
- Consistent envelope for errors (`code`, `message`, `details?`, `requestId`).
- Idempotency keys on job submission and any endpoint that can spend money.
- Pagination: cursor-based. Long operations return a job resource, never a held-open request.
- Every response carries a `requestId` that appears in logs and traces.

## Testing strategy

The table and the CI/CD list below are the intended practice. What is built: Vitest unit and
integration tests against a real, isolated PostgreSQL and storage directory (no Redis, no
Testcontainers), Playwright end-to-end tests, a preview-versus-Cycles parity suite, and the CI
workflow described in [20-testing-ci.md](20-testing-ci.md). There are no preview deployments and
no staging environment, and migrations are forward-only rather than reversible.

| Level | What | Gate |
|---|---|---|
| Unit | Pure logic: transforms, unit conversions, SDF/bevel math, policy checks | Required |
| Integration | API + Postgres + Redis via Testcontainers; queue round-trips | Required |
| E2E | Playwright: invite→password→design→upload→place→render (mocked GPU) | Required on main |
| Visual (UI) | Screenshot diffs of key screens | Required |
| **3D/preview** | Headless WebGL screenshots of fixed scenes, SSIM ≥ threshold | Required |
| **Parity** | Preview vs low-sample path trace for the same design; SSIM budget per product | Required — this protects the core promise |
| Security | Cross-tenant access tests, SVG fuzz corpus, authz matrix | Required |
| Load | k6 on API + queue saturation behavior | Per phase |

Tests are deterministic: fixed seeds, pinned renderer version, frozen clock, no network in unit
tests. Golden images are reviewed like code — a diff that changes them must be justified in the PR.

## CI/CD

- PR pipeline: typecheck → lint → unit → integration → build → E2E (sharded) → visual/parity.
- No merge on red. No "skip CI" on main.
- Preview deployment per PR with a seeded database and a stubbed render backend.
- Staging mirrors prod including a real (small) GPU worker; production deploys are promotions of a
  tested staging build.
- Migrations run as a separate, reversible step before the app rollout.

## Git & review

- Trunk-based: short-lived branches off `main`, one pull request per change, always. Nothing lands
  on `main` except through a PR, including changes that are already tested and green.
- **Merge with a merge commit (`--no-ff`). Do not squash, do not rebase-merge.** Both of those
  rewrite the branch's commits into new ones, and the cost is real:
  - a branch built on another branch stops sharing history with `main` the moment the first one
    lands, so it conflicts against content that is already there — the failure is in the *docs and
    code the two PRs both touched*, not in anything either author got wrong;
  - a SHA quoted in a review, an issue, or a commit message stops resolving;
  - the detail of how a change was reached is destroyed, which is exactly what you want back when
    something turns out to be wrong six months later.
- The thing squashing was bought for — a trunk you can read one-change-at-a-time — does not require
  squashing. `git log --first-parent main` gives that view, one line per merged PR, and
  `git bisect --first-parent` gives the matching bisect. Keep the detail; take the view when you
  want it.
- In exchange, the branch's own commits are permanent, so tidy them *before* opening the PR.
  Rebasing, amending and reordering your own unshared branch is encouraged; doing it to a branch
  someone else has pulled, or to anything already on `main`, is not.
- Conventional Commits; PR description states what changed, why, and how it was verified.
- Every PR: tests for new behavior, docs updated when a documented behavior changes.
- Security-sensitive paths (auth, upload, signed URLs, worker spec) need a second reviewer.

## Observability

- Structured JSON logs with `requestId`, `orgId`, `userId`, `jobId`; no secrets, no PII beyond IDs.
- OpenTelemetry traces spanning web → queue → worker, with spans per render stage (fetch assets,
  build scene, subdivide, trace, denoise, upload).
- Metrics: queue depth, job duration by preset, failure reason histogram, GPU-minutes by org,
  upload rejection reasons, preview FPS telemetry (sampled, opt-out).
- Alerts on: queue age > SLA, failure rate > 2%, spend velocity, auth failure spikes, error budget burn.

**What exists today** (the list above is the target): structured JSON logs via `@pr/observability`,
request ids carried from web into the worker, per-stage timings in each render's provenance, and a
**service event log**. Every `log.warn` and `log.error` in the web app and both workers also goes
through the logger's reporter seam (`setErrorReporter`) to the `service_events` table — batched,
redacted by the logger first, kept 14 days / 20 000 rows — which the System Status page
(`/admin/status`, `F-ADM-15`) shows. A 4xx is the client being told no and is left out. Alerts,
OpenTelemetry export and an external error tracker are not built; the seam is where one would plug in.

## Performance discipline

- Budgets from [gui.md](03-gui.md) are enforced: Lighthouse CI for the shell, a scripted FPS
  benchmark for the editor on a reference scene, and asset-size budgets for GLB/textures.
- 3D assets are optimized at ingestion, not at runtime; no client-side mesh processing on load.
- Regressions block merge the same way test failures do.

## Documentation

- ADRs in `docs/adr/NNNN-title.md` for consequential choices (renderer, emboss approach, auth
  model, hosting). Format: context → decision → consequences → status.
- Feature/workflow IDs (`F-*`, `W-*`) referenced in tickets, tests, and PRs.
- `README` per package: purpose, how to run, how to test.
- Docs live with the code and change in the same PR as the behavior.

## Definition of Done

- [ ] Meets the acceptance line in `01-features.md`
- [ ] Tests at the right level, including a parity/golden test if it can affect rendered output
- [ ] Authorization checked and covered by a cross-tenant test if it touches org data
- [ ] Errors are handled and user-legible; failure path exercised at least once
- [ ] Telemetry: logs/metrics/traces for the new path
- [ ] Docs/ADR updated; feature ID referenced
- [ ] No new lint/type/security warnings; budgets still green
- [ ] Works keyboard-only and at 1280px width (non-canvas UI)
