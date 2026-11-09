# Workspace reskin — F-UI-08

The maintainer approved the three workspace mockups and Wrap logo (#7), and requested implementation across every page plus a tested PR. This document records the implementation scope before code changes.

## Plan

1. Reconstruct Wrap as clean scalable paths; ship a full-size SVG, app mark and favicon. Keep the current application name.
2. Replace the historical website-oriented reference with an application style guide. Consolidate shared tokens and apply one compact navigation/header, consistent titles, fields, tables, cards, dialogs and state styling.
3. Build the Designs image gallery and browsing controls; send New design through product selection. Keep rename, duplicate, delete and restore available. Add the shared shell to saved and demo editors, reserve viewport height, and expose render settings from the document toolbar without moving or resetting active render state.
4. Refine the Admin Organizations workspace and carry the system through every admin, organization, catalog, render, account and authentication screen. Preserve the approved Artwork grid/editor/filmstrip flow.
5. Run local unit/integration, typecheck, lint, environment check, production build, bundle budget and full browser suite. Inspect actual editor frames and representative desktop/narrow page screenshots. Fix failures before creating the PR.

## Coverage

All 26 page-route files and their shared components were audited in [UI-REVIEW](design-system/UI-REVIEW.md). Source review was used for all routes; earlier historical screenshots are not evidence of current appearance. Current screenshots will be captured from the built application.

Library: Designs, Artwork gallery/editor, Catalog, product detail, Renders. Editing: saved design and demo. Identity: Account, sign-in, invite, reset and configuration fallback. Owner console: overview, People, member access, Products and Activity. Staff console: Organizations, organization detail, People, Packs, zone authoring, CAD imports, Materials, Queue and Status. Root remains a redirect.

## Boundaries and risks

No database/schema, renderer/math, authorization, quota or infrastructure changes. No runtime dependencies. The SVG-preparation upload, selection and repair workflows are preserved alongside the reskin. Full multicolor SVG import, node editing, new permissions and accessibility backlog are outside this reskin.

Visual risks: a shared header can reduce canvas height; denser controls can clip labels; grid cards can obscure menus; responsive layouts can hide important actions. Keep explicit viewport sizing and scroll regions, long-text handling, role-gated navigation and stable existing test selectors. Validate at desktop and laptop widths and retain horizontal workspace scrolling on narrow screens rather than discarding controls.

Functional risks: menus and gallery filters may make existing actions unreachable; navigation must not interrupt autosave assumptions; opening render settings must not reset in-flight jobs. Existing persistence/restore/undo/render/permissions tests remain regression gates. New tests cover navigation, filtering and the reskin controls.

GitHub CI runs on the PR head; require a green run before merge unless explicitly waived. Build the PR from an isolated branch; preserve unrelated working-tree changes.

## Delivery record

Implementation and verification results are recorded in the PR. Style rules live in [DESIGN](design-system/DESIGN.md); user-facing workflows are documented with the code.

## Local verification

- [x] Native SVG identity, full-size master and favicon; inspected at large and navigation sizes.
- [x] Shared style guide and page coverage; original recommendations retained with their historical status.
- [x] Designs browsing, shared editor shell and Render settings shortcut.
- [x] Staff/owner/auth/library styles and admin filtering.
- [x] Unit/integration suite: 1,301 passed, seven Linux-only sandbox tests skipped on macOS.
- [x] Workspace typecheck, lint, environment documentation, production build and bundle guard.
- [x] Browser regression suite: all 129 scenarios verified using Chrome, isolated PostgreSQL/storage, real OCCT and Blender workers.
- [x] Preview probe and visual review of desktop library/editor/admin/auth screens, detail pages, laptop editor and phone navigation/library.

Visual review caught excessive Artwork resize-handle height and overlapping camera/lens controls. Both were corrected and covered by geometry assertions. The bundled-three.js allowlist omitted the existing zone-authoring preview; its exact route is now included without raising the 180 kB shell or 700 kB editor limits. Final measurements: 100.1 kB shell, 431.8 kB editor, gzip.

Linux parser sandbox checks and non-Chrome browsers were not verified on this macOS machine; the configuration fallback was reviewed in source, not exercised by removing the running database. No claim is made that every possible modal/data combination was visually inspected.

Regression checks also caught duplicate padding in the old application wrapper, which pushed a scrollable Artwork filmstrip below the viewport. Page layouts now own their padding. Handle-size assertions wait for the opening animation before measuring.

## Organization navigation follow-up

The separately approved Header sections approach (`F-ADM-17`) replaces the global staff People
entry with organization-scoped Overview, People, Products, Limits and Activity. Cross-organization
email lookup remains read-only in Organizations. The current routes, workflow and verification
are documented in [31-organization-workspace.md](31-organization-workspace.md).

## Orientation page extension

The orientation workspace extends Wrap with a large bounded 3D stage, blue reference aid, compact white inspector, breadcrumbs, four-step progress and sticky action footer. It uses existing semantic colors, typography, button hierarchy and AppNav. The same component serves import setup and reorientation. No global navigation changes accompany this feature. See [33-product-orientation.md](33-product-orientation.md) for controls and workflows.
