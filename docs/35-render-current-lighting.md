# Render the current viewer lighting

## Goal and scope

Pressing Render captures the lighting currently visible in the editor, including Inspection mode
and its rotation. The render uses this snapshot without changing the saved design or switching the
viewer to Design lighting. Camera, materials, geometry, quality presets and quotas keep their
existing behavior. No new service, dependency, database migration, or lighting control is needed.

## Implementation

1. Define a validated render-lighting snapshot: curated environment key, finite rotation in degrees,
   and an optional orthonormal source-space orientation frame. Keep it separate from the design.
2. Derive one snapshot in the editor and feed it to both the viewer and Render panel. Copy it when
   Render is clicked, before asynchronous work; flush pending design saves and abort submission on
   save failure. Do not reset Inspection mode.
3. The submit endpoint validates the snapshot and rejects an unknown preset, malformed frame, or
   invalid rotation with `invalid_lighting` and an understandable error. Legacy callers may omit it.
4. Store the snapshot's resolved environment and optional orientation in the immutable RenderSpec.
   Catalog data, assets and material definitions are still resolved server-side. The existing spec
   hash includes these values, so changed lighting has distinct job identity and retries are stable.
5. The Blender scene builder uses the resolved preset, rotation and lighting orientation for light
   placement and the studio gradient's Up direction. Use the existing shared `placeLights` math.
   Keep product presentation orientation independent so the lighting override cannot rotate the
   product or camera. Specs without the new orientation retain the previous placement fallback.
6. Replace the viewer/export mismatch messages with a clear current-lighting statement. Keep an
   optional explicit switch back to Design lighting; Render itself never changes the lighting.

## Files

- `packages/design-schema/src/render.ts`: request snapshot and optional resolved orientation.
- `apps/web/components/editor.tsx`, `render-panel.tsx`: shared viewer state, click-time capture,
  save completion, and notices.
- `apps/web/app/api/designs/[id]/renders/route.ts`, `lib/server/render-spec.ts`: boundary validation
  and immutable snapshot resolution.
- `packages/blender/src/scene.ts`: resolved lighting, background and orientation.
- Schema/spec/scene regressions and render workflow E2E coverage.
- Feature index, render service, API and frontend documentation.

## Risks and verification

- Wrong coordinate frame or center: compare every generated light against shared placement math
  for a non-origin subject and an inspection frame rotated independently of product presentation.
- Stale state: capture before awaiting autosave; later viewer edits do not alter the request.
- Compatibility: omitted snapshot remains valid and produces legacy job behavior; optional resolved
  orientation does not change hashes of jobs that omit it.
- Reproducibility/deduplication: different snapshot orientations change hashes; identical snapshots
  retain identical identity. Saved design remains unchanged.
- Rejection behavior: unknown presets, non-finite rotations and invalid axes fail before queuing.
- Real engine: run a small Blender render with captured inspection lighting and inspect its frame.
- Run feasible local unit/integration, typecheck, lint, environment checks, E2E and preview probe.
  GitHub CI must pass before merge unless explicitly waived for that PR; dispatch it if needed. Record actual results and limitations below.

## Verification results

- Implemented and applied to the production checkout serving localhost:3000; health check passed.
  Both idle workers were reloaded; CAD reports OCCT 7.9.3.1.1 and render reports Cycles 5.2.0.
- Typecheck across workspaces, ESLint, environment-documentation checks and production build passed.
- New schema/scene/spec regressions verify frame validation, independently oriented lights for an
  off-origin subject, unchanged camera/materials/document, legacy fallback and job-hash identity.
- All 13 real Blender integration checks passed with normal GPU access. A small real Detail render
  using the snapshot override was visually inspected. The first sandboxed run crashed in Metal
  initialization, before the scene; it is not counted as a product failure.
- All 12 existing/new render-workflow browser cases passed in an isolated production server/database
  with the fake queue worker. A subsequent 3-case pass additionally verified actual queued job
  snapshots for Inspection and Design lighting. The fake worker verifies queue/download behavior;
  the separate Blender checks verify the real engine.
- `preview:probe` succeeded and its actual viewer frame was inspected. Temporary accounts, database,
  object store, processes and screenshots were removed after verification. Localhost:3000 was not
  used as a test-data store.
- Final complete unit/integration run: **1,462 passed, 7 skipped, 3 failed** across 110 files.
  The failures are baseline material-cleanup regressions outside this
  feature: catalog defaults still expected to be board-coated, the two-pack test still requiring
  paperboard, and replay of an existing temporary SQL function after a test database reset. Those
  files are unchanged by this feature. A separate follow-up was offered, not included silently.
- The complete browser suite and quantitative preview/Cycles image parity suite were not run;
  browser coverage here targets rendering and the new snapshot behavior. GitHub CI was not run.

## Implementation review

The same `renderLighting` value feeds the viewport and submit panel. Submission clones it before
awaiting autosave, validates it at the endpoint, and copies its key/rotation/orientation into the
immutable resolved environment. The Blender builder consumes that environment without rewriting
presentation orientation or saved scene settings. The former automatic switch to Design lighting
is removed; an explicit switch remains available. Optional schema fields preserve older jobs and
callers. The implementation covers the planned workflow and compatibility cases.
