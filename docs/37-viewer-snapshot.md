# 37 — Viewer snapshot

Feature: `F-PREV-04` (the existing draft-screenshot backlog item). Approved scope: a **Snapshot** button matching the editor toolbar that
immediately downloads what the 3D viewer is displaying.

## Behavior and design

- Place an outlined **Snapshot** button with a 16px Lucide camera icon immediately before Render.
  Use existing typography, borders, control radii and hover states; Render remains the primary action.
- Download the current 3D canvas as PNG at its actual drawing-buffer resolution. Preserve camera,
  artwork, materials, lighting, cross-sections and the background as displayed. Canvas imagery only:
  navigation, viewer controls and DOM overlays are not part of the image. Transparent mode's
  displayed dark gray backing remains in the screenshot; this is not a transparent-background render export.
- Use a filesystem-safe design-based name (or `viewer` in the demo), followed by local capture date
  and time including milliseconds: `My-cap-snapshot-2026-10-23_18-34-56-789.png`. This distinguishes
  repeated captures within a day or second. Capture the filename and image at click time, before
  asynchronous PNG encoding completes. Do not scale to thumbnail size.
- Available without artwork, while autosave/rendering is in progress, in the demo and in view-only
  designs. Snapshot does not alter the design, require a successful save, upload an asset or queue a
  render. Existing server/export permissions remain unchanged.
- Disable in Place mode and while leaving the editor; explain switching to Viewer/Split in the
  tooltip. If the viewer is loading or capture fails, show a compact error beside the button and
  allow retry. Prevent duplicate clicks during encoding and release the temporary download URL.

## Implementation and boundaries

Reuse the existing `Viewport3D.onFrame` readiness callback and preserved drawing buffer. Maintain
a reference separate from thumbnail uploads; forward the same callback to the thumbnail workflow
for editable designs. Keep snapshot state in its own toolbar component so capture feedback does
not reset scene readiness. Do not change scene rendering, thumbnail throttling, saving or Blender.

Files: editor wiring, Snapshot button component, workspace styles, browser tests, README/frontend
documentation, feature inventory and documentation index. No new dependencies, endpoints,
storage, schema or infrastructure. No resolution/format picker or screenshot gallery.

## Risks and verification

- Loading/stale buffers: reject absent, disconnected or zero-size canvases; use the existing
  readiness notification rather than a DOM query that might pick the 2D face view.
- Fidelity: decode the downloaded PNG in a browser and compare dimensions and pixels with the
  displayed canvas; change view/background and confirm subsequent captures reflect them.
- Failure handling: simulate failed PNG encoding; verify understandable error, no download, and
  successful retry. Exercise Place → Viewer and Split without capturing the wrong canvas.
- Isolation: assert no render submission or thumbnail upload is caused by Snapshot. Verify the
  demo, a saved design and an archived/view-only design where the existing test harness permits.
- Run local unit/integration, typecheck, lint, env checks, production build, relevant browser tests
  and a preview probe; inspect an actual frame. Use an isolated server/database for testing and
  preserve the existing localhost runtime. GitHub CI must pass before merge unless explicitly waived for that PR; dispatch it if needed.

## Verification record

- Reviewed implementation against the behavior above: full viewer buffer, click-time PNG capture,
  safe filename, independent component state and existing readiness/thumbnail callback. No scene,
  save, server, queue or storage changes. The earlier backlog's added watermark is superseded by
  the requested exact viewer screenshot.
- Isolated production build, workspace typechecks, lint and environment documentation checks passed.
- Eight focused browser tests passed: byte-for-byte PNG versus current canvas, native dimensions,
  changed camera/background, no API writes in demo, Place/Split, loading refusal, encoding failure
  and retry, saved designs without artwork, and archive/read-only download with unchanged design.
- Inspected actual button and downloaded PNG; the image includes the product/background and
  excludes DOM controls. The existing preview probe passed and its actual frame was inspected.
- Full local unit/integration run: 1,462 passed, 7 skipped, 3 pre-existing failures. The catalog and
  pack-family assertions still expect retired carton materials; migration replay reuses the
  connection's existing `pg_temp.pp_material_references` function. These are unchanged from the
  merged baseline and are outside Snapshot. All 13 real Blender integration tests passed with
  normal local GPU access; the initial sandboxed run failed during Metal initialization.
- The full 181-case browser run stopped after 30 passes at the existing styled-strokes SVG
  preparation comparison (mark MAE `0.0027352526296977125`, expected below `0.002`). The exact
  discrepancy reproduces on an empty browser page using unchanged SVG/raster packages, with no
  Snapshot UI or application present. One concurrent case was interrupted and 149 were not run.
  A separate 57-case editor/viewer/render-control run stopped after 29 passes at an existing guide
  test: its second `openEditor()` resets to the default Viewer mode, but the test then requires a
  Place canvas without selecting Place again. One case was interrupted and 26 did not run. The
  test's mode precondition is unrelated to Snapshot; no application or unrelated-test fix is included.
  Image-render/parity cases are skipped without a real queue worker. The test queue uses the
  existing fake backend. The final 22-case render-controls/modes/layout run had 17 passes and
  3 real-render-only skips, then stopped at the same obsolete Place-canvas assumption in
  `workspace.spec.ts:13`; its other workspace case was interrupted. All five Snapshot cases,
  Viewer defaults and the non-Cycles render-control tests passed in that run.
- Initial local verification did not run GitHub CI. Localhost:3000 and its existing workers were left untouched; verification
  uses a disposable database/store and a production server on 3100. A read-only attempt to run the
  SVG comparison against the existing 3000 demo timed out waiting for hydration, despite its
  successful health response; it is not baseline evidence or a verified live UI.
- Final verification used an isolated branch against merged main, containing only Snapshot
  changes. Unrelated placement-color work in the shared workspace is excluded. The first
  mixed-workspace browser attempt is not counted as passing.
- Disposable test accounts, databases, object stores, processes and scratch artifacts were cleaned
  up after verification.

## Local review deployment

Localhost:3000 was subsequently updated at the user's request. The running web source is
`.tmp/localhost-snapshot` in the main workspace: a complete reconstruction preserving the prior
local PET/transparency source, with Snapshot's component, editor wiring and styles added. Production
build passed; a staging browser check passed before switching the web process. On port 3000 the
editor hydrated without browser errors and downloaded a PNG byte-identical to its current viewer.
Existing database/storage configuration and both original worker processes were preserved. The
temporary staging server was stopped. Runtime details are in `.tmp/localhost-snapshot-process.json`.

## Frame readiness regression

A drawn canvas remains available during ordinary scene rerenders. The frame callback clears it
only while assets are loading, then marks the current canvas `data-capture-ready` after its drawn
frame is handed back. Repeated Place/Split transitions and lighting edits must still download the
exact drawing buffer; delayed asset loading and PNG encoding failures retain their recovery errors.
