# 3D Product Renderer — Planning & Implementation Docs

A **generic product customizer**: pick a 3D product, place vector artwork on it in a 2D face view,
preview live in 3D, export a photorealistic render. First product pack is plastic caps with
embossed/debossed logos; the platform is product-agnostic by design (see `F-GEN-*`).

## Part 1 — Product definition

| # | Doc | Purpose |
|---|-----|---------|
| 00 | [overview.md](00-overview.md) | Vision, genericity directive, users, scope by release, domain objects |
| 01 | [features.md](01-features.md) | Feature inventory with IDs + P0/P1/P2 (= v1/v2/v3) |
| 02 | [workflows.md](02-workflows.md) | W-01…W-17 end-to-end paths, including standalone artwork management/editing |
| 03 | [gui.md](03-gui.md) | Screens, editor anatomy (Place/Viewer), interaction model, budgets, a11y |
| 04 | [tech-stack.md](04-tech-stack.md) | Technology choices + extensibility architecture |
| 05 | [security.md](05-security.md) | Threat model, auth design, upload/worker isolation, checklist |
| 06 | [conventions.md](06-conventions.md) | Engineering practices, testing strategy, definition of done |
| 07 | [roadmap.md](07-roadmap.md) | M0–M5 phasing, risks, open decisions |

## Part 2 — Implementation plan

| # | Doc | Purpose |
|---|-----|---------|
| 10 | [architecture.md](10-architecture.md) | Services, module boundaries, data flow, adapters, deployment |
| 11 | [data-model.md](11-data-model.md) | Postgres schema, RLS, indexes, storage key layout |
| 12 | [schemas.md](12-schemas.md) | Design Document, Product Pack manifest, materials, render spec + versioning |
| 13 | [api.md](13-api.md) | Endpoint surface, auth, SSE, errors, idempotency, rate limits |
| 14 | [artwork-pipeline.md](14-artwork-pipeline.md) | Sanitize → normalize → SDF → height/normal, pseudocode |
| 15 | [placement-math.md](15-placement-math.md) | Zone space, projections, snapping, scaling — pseudocode |
| 16 | [preview-engine.md](16-preview-engine.md) | three.js scene, zone compositing, emboss shader, parity |
| 17 | [render-service.md](17-render-service.md) | Job lifecycle, worker protocol, Blender scene build pseudocode |
| 18 | [auth-impl.md](18-auth-impl.md) | Invite/verify/password/session/reset pseudocode, rate limits |
| 19 | [frontend.md](19-frontend.md) | App structure, state, undo/redo, 2D/3D sync, data fetching |
| 20 | [testing-ci.md](20-testing-ci.md) | Test matrix, parity harness, two-pack conformance, CI |
| 21 | [build-order.md](21-build-order.md) | Epics, tickets, dependencies, sequencing |
| 22 | [pentest-brief.md](22-pentest-brief.md) | Trust boundaries, attack surface, what is already tested, accepted risks |
| 23 | [cad-ingestion.md](23-cad-ingestion.md) | STEP → pack: architecture, formats, determinism, hardware, security, risks |
| 24 | [displaced-preview.md](24-displaced-preview.md) | Real relief geometry in the browser: zone patch, mesh sampler, shading split, height-field AO |
| 25 | [org-admin.md](25-org-admin.md) | Owner-facing `/org` area: implemented members, per-user product access, audit; original design rationale |
| 26 | [curved-relief.md](26-curved-relief.md) | **Proposal.** Emboss/deboss on non-flat surfaces: what cylinders already do, cone zones, finishing `conformal`, decoration UVs |
| 27 | [deployment.md](27-deployment.md) | Getting it onto one server and keeping it there: images, compose, TLS, backups, and the single-node ceiling |
| 28 | [enterprise-access.md](28-enterprise-access.md) | **Proposal.** How people get accounts and how the app mails them: a real transport, access requests, bulk invitations, render-ready mail |
| 29 | [artwork-preparation.md](29-artwork-preparation.md) | **Implemented; review pending.** Click to retain SVG objects; separate Repair paths mode, unhappy scenarios, processing/storage contracts and unresolved carton parity acceptance |
| 30 | [workspace-reskin.md](30-workspace-reskin.md) | Wrap identity, visual coverage and verification record |
| 31 | [organization-workspace.md](31-organization-workspace.md) | Staff organization header sections, scoped people management, email lookup and verification |
| 32 | [catalog-thumbnails.md](32-catalog-thumbnails.md) | Staff thumbnail generation, backfill, safety and verification |
| 36 | [self-host-readiness.md](36-self-host-readiness.md) | **Draft for review.** Independent self-hosted application: scope, readiness requirements, CAD support gate, upgrade/recovery checks and release decisions |

## Asset planning

- [Cap and container library](packaging-library-spec.md) — the approved five-pair lineup and its CAD-generation requirements. All five pairs are generated; the files live in the untracked `output/packaging-library/`.

## Design system

- [Application style guide](design-system/DESIGN.md) — Wrap identity and shared interface rules.
- [Loading-state review](design-system/LOADING-REVIEW.md) — approved quiet ring and proposed adoption points.
- [Original UI review](design-system/UI-REVIEW.md) — historical baseline and recommendations.

## Conventions

Features carry stable IDs (`F-<AREA>-<NN>`), workflows `W-<NN>`. Tickets, tests, and PRs reference
those IDs instead of restating requirements. ADRs live in `docs/adr/`.

[33 — Product orientation](33-product-orientation.md) details the guided CAD setup/reorientation controls, workflows, contracts and review boundaries.

[34 — Artwork archive](34-artwork-archive.md): shared archive/restore, read-only designs and preserved viewing workflows.

[35 — Render current viewer lighting](35-render-current-lighting.md): implementation plan, immutable lighting snapshot, compatibility and verification.

[37 — Viewer snapshot](37-viewer-snapshot.md): instant PNG download of the current 3D viewer, toolbar design and verification.

[38 — First work after the initial release](38-first-work-after-release.md): **start here.** Production setup, email and a clean-server run-through, in order, with what counts as done.

For operators, at the repository root: [QUICKSTART.md](../QUICKSTART.md), [KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md) and [RELEASE-NOTES.md](../RELEASE-NOTES.md).
