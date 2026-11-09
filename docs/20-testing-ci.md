# 20 — Testing & CI

Two things here are unusual and load-bearing: the **parity harness** (preview vs path trace) and
the **two-pack conformance suite** (genericity). Everything else is standard.

---

## Test matrix

The cadence below is local verification guidance. GitHub CI runs on every pull request and must
pass on the PR head before merge unless the maintainer explicitly waives it for that PR. It does not
replace the local checks. Redis/MinIO/Testcontainers/Semgrep/ZAP entries describe
intended coverage; the built suite uses Vitest, Playwright and real isolated PostgreSQL/storage.

| Level | Scope | Tooling | Runs |
|---|---|---|---|
| Unit | `packages/*` pure logic: profile math, zone mappers, snapping, validation, schema migrations | Vitest | every PR |
| Shader | GLSL `heightMm`/`dHeightdD` vs TS across a parameter sweep | headless WebGL (Playwright) | every PR |
| Integration | API + Postgres + Redis + MinIO | Vitest + Testcontainers | every PR |
| Contract | Adapter conformance (Storage, Queue, RenderBackend, Mailer, Rasterizer) | Vitest suites re-run per implementation | every PR |
| E2E | W-01…W-08 with a stubbed render backend | Playwright | every PR (sharded) |
| Visual (UI) | Key screens, light/dark, 1280/1920 | Playwright + pixelmatch | every PR |
| Preview regression | Fixed 3D scenes screenshotted headlessly | Playwright WebGL + SSIM | every PR |
| **Parity** | Preview vs low-sample Cycles render for the same design | custom harness | nightly + on render/material/shader changes |
| **Two-pack conformance** | Entire E2E suite against cap + box fixture packs | Playwright matrix | every PR |
| Security | Cross-tenant authz matrix, SVG fuzz corpus, header assertions | Vitest + Semgrep + ZAP | every PR / nightly |
| Load | API + queue saturation, 100 concurrent renders | k6 | per milestone |

## Determinism rules

Fixed seeds, frozen clock, pinned Blender + pipeline versions, no network in unit tests, sorted
iteration everywhere, and `deterministic=1` in the editor (disables damping/animation) for
screenshots. A test that fails once in fifty is treated as a broken test, not a flake — quarantine
is a bug ticket, not a resolution.

## Parity harness (protects the core promise)

```ts
// tests/parity/run.ts — the guardrail behind "what you see is what you get"
const CASES = [
  { pack: 'cap-basic',  variant: '38mm', zone: 'top',    finish: 'deboss', depthMm: 0.35, artwork: 'wordmark' },
  { pack: 'cap-basic',  variant: '38mm', zone: 'skirt',  finish: 'emboss', depthMm: 0.5,  artwork: 'monogram' },
  { pack: 'box-basic',  variant: 'std',  zone: 'front',  finish: 'print',  artwork: 'logo-color' },
  { pack: 'cap-basic',  variant: '38mm', zone: 'top',    finish: 'emboss', ink: 'ink-black' },  // filled
  // extremes matter: min/max depth, max bevel, thin strokes, high wrap angle, metallic + foil
];

for (const c of CASES) {
  const doc = buildDesign(c);
  const preview = await screenshotPreview(doc, { camera: 'three-quarter', size: 1024 });   // headless WebGL
  const traced  = await renderWithBackend(doc, { preset: 'draft', samples: 96, size: 1024 });

  const score = ssim(align(preview), align(traced));
  expect(score).toBeGreaterThan(BUDGET[c.finish]);        // e.g. 0.92 emboss, 0.94 print
  writeReport({ case: c, score, diff: heatmap(preview, traced) });   // artifact on every run
}
```

**What this harness cannot measure, and why it is not a gap to close by lowering a budget.** Local
SSIM needs local variance. Two subjects have neither:

- **A metallic mark.** A mirror is where a rasteriser and a path tracer legitimately part company —
  three.js reflects a prefiltered environment map, Cycles traces the rays. A gold foil emboss on the
  fixture cap scores 0.31 against the 0.35 local floor while a flat ink through the identical code
  path scores 0.55.
- **A clear coating.** A spot varnish changes nothing but the specular term, so the windows over it
  are nearly flat and SSIM swings hard for an absolute error of 1.6%. It scores 0.40 alone and 0.34
  under load — a margin too thin to gate on.

Both are exercised where they *can* be checked exactly: `packages/materials/src/ink.test.ts` for the
numbers each material resolves to, and `packages/blender/src/scene.test.ts` for the blend nodes
existing on both the printed and the filled-relief branch. The floor stays where it is; it has
caught real bugs that a budget bent to admit a mirror would have missed.

- Budgets are per finish/material class and are **ratcheted**: a change may raise a budget only with
  an explicit justification in the PR.
- The report (side-by-side + difference heatmap) is a CI artifact, so regressions are legible
  without rerunning locally.
- Triggers: changes to the preview shader, material mappings, the profile function, Blender version,
  HDRI/tone-mapping settings, or any pack's zone definitions.

Failure of this suite blocks release, not just merge — a silently diverging preview is worse than
an outage because it produces wrong deliverables.

## Two-pack conformance (`F-GEN-09`)

```ts
// playwright.config.ts
projects: FIXTURE_PACKS.flatMap((pack) => [
  { name: `e2e-${pack}`, use: { pack }, testMatch: /e2e\/.*\.spec\.ts/ },
]);
```

`fixtures/packs/cap-basic` (small, curved, cylindrical + planar zones) and
`fixtures/packs/box-basic` (large, flat panels, print-only zones) are deliberately
dissimilar. Any feature that passes on one and fails on the other has product-specific logic in it,
which is the thing this project is not allowed to have. The packs double as the open-source example
content and as the onboarding material for new operators. Both use the approved Matte and Glossy
material palette; their geometry and zone capabilities provide the conformance contrast.

Migration-upgrade tests initialize a private database directly at the intended legacy schema using
`createTestDatabase(prefix, migrationDir)`, then apply current migrations to populated data. Do not
fully migrate and reset the public schema first: pooled sessions can retain temporary objects from
the initial migration pass.

## Golden images

- Stored in `tests/__golden__/` via Git LFS, reviewed like code.
- A diff that changes a golden must state why in the PR ("bevel fillet corrected", "HDRI rotated").
- Regenerate with `pnpm test:golden --update`; CI refuses updates on `main` without a linked ADR
  for renderer/shader changes.

## Security testing

```
tests/security/
  authz-matrix.spec.ts      every (role × route × resource-owner) combination, incl. RLS-only mode
  tenancy.spec.ts           direct-ID access across orgs must 404, with the app filter disabled
  svg-corpus/               ~300 files: XXE, billion laughs, JS handlers, huge paths, malformed XML,
                            gzip bombs, external refs, CSS @import, <use> loops — all must be rejected
                            or neutralized, none may crash or hang the sandbox
  headers.spec.ts           CSP/HSTS/COOP assertions on every route
  signed-urls.spec.ts       quarantine + source-CAD prefixes are never signable
```

The SVG corpus is grown from real rejections in production (sanitized), so the pipeline gets
strictly harder to break over time.

## CI pipeline (GitHub Actions)

```yaml
pr:
  - setup: pnpm install --frozen-lockfile; turbo prune per changed package
  - static:  typecheck | eslint (incl. boundaries) | prettier | knip (dead code)
  - unit:    vitest --coverage (fail under 85% on packages/*)
  - shader:  playwright glsl-vs-ts sweep
  - integration: testcontainers (postgres, redis, minio)
  - build:   next build + worker images
  - e2e:     playwright matrix [cap-basic, box-basic] × 4 shards, stubbed render backend
  - visual:  screenshots + pixelmatch
  - security: semgrep, npm audit --audit-level=high, gitleaks, svg corpus
  - preview-deploy: ephemeral env with seeded DB and stub renderer

nightly:
  - parity: real GPU runner, low-sample Cycles, SSIM report artifact
  - zap-baseline against staging
  - restore drill: PITR restore into a scratch database, run integration suite against it

release:
  - promote the staging-tested image; run migrations (expand step) before rollout
  - post-deploy smoke: login, open design, submit draft render, download output
```

Merge gates: static, unit, shader, integration, e2e (both packs), visual, security.
Release gates: the above **plus** parity, load (per milestone), and a green restore drill.

**When the built workflow runs.** The pipeline above is the intended one; `.github/workflows/ci.yml`
is what exists (`secrets`, `verify`, `e2e`, `parity`, `images`). It runs on every pull request
(`pull_request`, never `pull_request_target`, so fork code gets no repository secrets) and can be
dispatched by hand for any ref. A commit message containing `[skip ci]` skips it, which is meant for
documentation-only changes. `secrets` runs Gitleaks and TruffleHog over the whole history
(`F-HARD-09`). Local tests are still required before offering a change as done; add tests for new
behaviour, investigate failures, and fix their causes.

The `verify` job installs OCCT and Blender and enables unprivileged user namespaces on its disposable
Ubuntu runner. Missing PostgreSQL, OCCT, Blender or sandbox capability fails CI; it cannot turn into
silent skips. macOS still skips the seven Linux-only namespace tests locally.

The `e2e` job starts the reference CAD worker for synthetic CAD inputs and runs browser tests except
`parity.spec.ts` and `render.spec.ts`, on one worker because two software-WebGL browsers overload
the two-core runner. The `parity` job installs Blender, starts a real render worker,
imports both cap and carton packs, and runs those two files sequentially. Render lifecycle tests
therefore run alongside parity, including downloads, notifications and gallery output. Missing
workers fail the corresponding CI tests. No browser spec is excluded from both jobs.

Independent design/render/parity tests run in default groups rather than serial failure chains.
Tests needing the 2D canvas explicitly select Place; Viewer remains the product default. Queued
lighting assertions inspect immutable specs and cancel their own jobs rather than waiting for an
unrelated path-trace completion. Each render test cancels or deletes only the jobs it submitted;
submission-only cases cannot leave a backlog ahead of lifecycle cases or cancel another test’s work.

The browser SVG geometry comparison supersamples both source and prepared coverage before comparing
the requested image size, so stroke versus outline antialiasing does not dominate at coarse pixel
edges. Its error limits are unchanged, and a deliberately shifted mark must fail the same limit.
Relief parity uses the supported independent Matte finish with the cap’s color. Renders use the
exact captured drawing-buffer dimensions rather than rounding an independently scaled aspect ratio;
visual budgets and the moved-mark failure control are unchanged.

CAD fixture exports are canonical on the pinned Ubuntu 24.04 x86-64 / OCCT 7.9.3.1.1 writer used by
CI. The loft interpolation/export calculations differ in low-order bits on macOS/ARM, even for
identical input coordinates. Regeneration on macOS remains useful for geometry review but can
produce numeric-only STEP diffs; refresh the committed byte baseline with the Linux writer. CI
still requires byte-for-byte regeneration, and independent volume/import checks remain unchanged.
User CAD and generated application models are not normalized or rewritten.

Actions minutes are metered while the repository is private; a full run costs about 60.

**The database role in CI must not be a superuser.** `force row level security` forces policies on
the table *owner*; it does nothing about a superuser, who bypasses every policy silently. The
postgres image's `POSTGRES_USER` names the cluster's *bootstrap superuser*, so setting it to the
application role — which the workflow did, from the first run until it was caught — meant every
tenancy test in CI ran against a database that was not enforcing the thing under test. The workflow
now bootstraps as `postgres` and creates `product_renderer` as an ordinary role with `createdb`, and
`createTestDatabase` refuses to run as a superuser rather than letting it happen quietly again.

The failure mode is worth recognising, because it does not look like what it is: the handful of
tests that expect a *rejection* fail with `promise resolved "undefined" instead of rejecting`, and
every test that expects to *see* nothing sees everything. Anything that reads like "isolation is
not happening at all" should have this checked first.

## Test data

- `fixtures/artwork/`: clean wordmark, thin-stroke monogram, gradient logo, text-not-outlined (must
  reject), 8 000-path monster (must reject), non-UTF8, zero-area — each asserted to a specific code.
- `fixtures/packs/`: the two conformance packs, plus a deliberately broken pack (bad UVs, zone
  outside geometry, missing asset) that ingestion must reject with precise errors.
- Seeded orgs: `acme` (normal), `overquota` (quota exhausted), `suspended` — so the unhappy paths
  are always one login away in dev and staging.

## Running the e2e suite locally

`scripts/e2e.sh` builds the app and runs the suite against it. Three things about it are worth
knowing before you wonder why your development environment looks different afterwards.

**It uses a database and an object store of its own.** `global-setup` provisions an organisation
and accounts on every run, `packs.spec` imports packs, and nothing tears any of it down. The suite
used to take whatever `DATABASE_URL` and `STORAGE_ROOT` were set to, which on a development machine
is the pair you are using — one afternoon of runs left 51 accounts, 20 deprecated packs cluttering
`/admin/packs`, and 56MB of orphaned objects. It now uses `E2E_DATABASE`
(default `product_renderer_e2e`) and `E2E_STORAGE_ROOT` (default `.tmp/e2e-storage`) regardless of
what is in the environment.

Every run drops that database and object store first, as CI starts clean, because the specs assume
it: a preview, pack version or fixed upload left by the last run fails the next one.
`E2E_KEEP_DATA=1` keeps them. Where the database cannot be found, as in a git worktree, the run
skips the tests that need one rather than falling back to `DATABASE_URL`.

This is isolation rather than a cleanup step on purpose. A cleanup step can be forgotten, and its
delete-by-pattern is one typo from taking real data with it — undoing the mess above by hand needed
six ordered statements to satisfy the foreign keys, including a genuine cycle between
`product_packs.created_by` and `users`.

**It stops the workers it starts, and leaves the server up.** The workers hold the e2e database, so
one left polling claims nothing submitted from the development app: the job sits in the queue, the
bell never rings, and nothing on screen explains why. They are stopped by process group when the
suite exits. The server on `E2E_PORT` is deliberately left running — `preview:probe` and
`scripts/screenshot.ts` both expect to find it there.

**It will stop your `next dev` server.** The script clears any leftover server with
`pkill -f next-server`, which matches `next dev` on port 3000 as well as its own on 3100. Restart
your development server after a run.

## What we deliberately do not test

- Exact pixel equality between renderer versions (SSIM budgets instead — noise is inherent).
- Third-party GPU driver behavior (pinned container image is the control).
- Visual appeal. Parity says the preview predicts the render; whether the render is *beautiful* is a
  human judgement made in QA on each pack.

## Artwork gallery/editor verification (`F-ART-11`)

- `packages/raster/src/edit.test.ts`: visible-bound dimensions, centre rotation, canvas fitting,
  symmetric flips, curves and proportional/non-proportional stroke resizing; edit input limits.
- `packages/artworks/src/artworks.integration.test.ts`: real PostgreSQL with a non-superuser role;
  new immutable versions, unchanged old source/mask, current-pointer updates, rename-only saves,
  concurrent/stale-save rejection and cleanup, tenant isolation and invalid inputs.
- `packages/svg/src/normalize.test.ts`: decoded paint values remain escaped XML attributes when
  normalized SVGs are serialized for storage and viewing.
- `apps/web/lib/artwork-edit-state.test.ts`: undo/redo, clean-state detection and branching history.
- `apps/web/e2e/artwork.spec.ts`: the real built application’s gallery/navigation, upload/rejection,
  expansion, hidden upload button, bottom strip, editing/reopening, zoom, undo/redo, unsaved-change
  guards, management actions, input/conflict errors and signed-out redirect.
- Run the full unit/integration suite, recursive typecheck, lint and env check locally. Run the
  browser suite through `scripts/e2e.sh` so the build and isolated database/store are current, and
  inspect actual gallery/editor frames. Shared artwork changes also warrant the preview/parity
  browser checks and `pnpm preview:probe`.


## SVG preparation checks (F-ART-12)

Only generic synthetic fixtures in `fixtures/artwork/preparation/` are retained. Unit checks cover
computed CSS, inheritance/currentColor, namespaces, formal open flags, per-instance reuse/clips,
visible occlusion/counters, caps/joins/dashes, explicit repair compatibility and enlarged-arc
precision. Draft tests cover frozen inclusion, stale preview rejection, Apply/exit guards and Undo.
File reading tests preserve valid UTF-8/BOM bytes and reject invalid encodings/size.

Real PostgreSQL/storage tests verify authoritative source-bound compilation, private retention,
all-or-none metadata, populated legacy migration, tenant/version checks, idempotent concurrent
retries, transform composition, old version bytes and failed-save cleanup. Browser checks cover
selection, overlap picking, coincident endpoints, empty-path width repair, explicit closure,
review/confirmation, cancellation, stale responses, meaningful unsupported-feature errors,
streaming request limits, original attachment headers and denied private assets. Browser source
and selected-region conformance runs at 256/1024; canonical SVG coverage is compared with the
actual stored mask, including counter holes. Design/demo placement, preview frames and both-pack
renderer/parity checks remain required. Report unsupported environment checks explicitly.

## Orientation regression coverage

Local coverage includes normalized/orthogonal frames, flip/quarter-turn symmetry, source-axis equivalence, semantic cameras, light power/scale preservation, absent legacy fields/hash identity, immutable frame capture, draft concurrency/publish/access guards and physical geometry invariants. Database tests use disposable PostgreSQL databases. CAD diagnostic lookup also verifies tenant isolation.

Playwright covers the shared wizard, live previews, cancellation, temporary inspection, saved design override/application/default restoration, stage resume, staff publication and direct member authorization. The existing CAD workflow now continues through orientation. Actual Blender/Cycles coverage includes a Detail render with a confirmed +Y product frame.

Run unit/type/lint/env checks, production build, full browser regressions and actual frame inspection locally. GitHub CI runs on the pull request and must pass before merging unless explicitly waived for that PR. When another agent owns a local server, use an isolated test port/database/storage and stop only owned process groups; the shell E2E setup script's broad process cleanup must not run against that shared session.
