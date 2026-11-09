# 19 — Frontend Architecture

Next.js App Router + TypeScript. The editor is the only complex surface; everything else is
conventional server-rendered pages over the API in [13](13-api.md).

---

## Route map

```
app/
  layout.tsx                                      html/body and globals.css; no chrome of its own
  page.tsx                                        redirects to /designs
  (auth)/signin, invite/accept, reset             server components + form actions; no navigation
  (app)/                                          layout: shared navigation (F-NAV-01/F-UI-08)
    designs/                                      dashboard
    artwork/                                      SVG gallery + expanded viewer/editor (F-ART-11)
    catalog/…                                     catalog + product detail
    renders/                                      gallery
    account/                                      profile and security
  design/[id], design/demo                        EDITOR (client-heavy island) — see below
  admin/…                                         staff console: shared header + section sidebar
  org/…                                           organisation area: shared header + section sidebar
  api/…                                           route handlers (13-api.md)
```

The editor sits outside `(app)` and shares its navigation through `design/layout.tsx`.
Its workspace reserves the shared header height, then fits the document toolbar and three-pane
editor into the remaining viewport. Both saved designs and the demo use this shell.

Artwork has its own `/artwork` route inside `(app)`, plus the existing inline library inside the
design editor. Settings is `/account`. Navigation is Designs / Artwork / Catalog / Renders.

Pages have server shells; the design editor and artwork gallery/editor are client component trees.
The Artwork server page authenticates and reads the tenant-scoped library before passing signed
asset URLs to `ArtworkPage`. `ArtworkEditor` fetches the sanitised SVG, displays it as an image
(rather than injecting markup), and keeps unsaved edit history local. `ArtworkViewer` owns only
zoom/pan. The pure whole-artwork transform lives in `packages/raster` and is shared with the
server’s ingest/edit path. Saving invalidates the selected record and reloads its SVG; navigating
away or switching artwork is guarded while edits remain unsaved.


The dynamically loaded `ArtworkPreparation` workspace is shared by gallery, saved design and
in-tab demo. `artwork-preparation-state.ts` owns revision-bound previews, separate repair mode,
ordered draft history and pending preview/Apply guards. Saved workflows request authoritative
server previews; the demo calls the same pure preparation functions. Aborted/older responses do
not enable save. Original markup never enters the DOM; computed source is an image, and numeric
geometry overlays provide picking, clipping checks, endpoint candidates and view controls.
Confirmation alone adopts a library record. The saved editor opens its existing library after
success and does not place artwork until an explicit choice. Unsaved drafts are tab-local.

## Editor component tree

```
<DesignEditor designId>                         // loads document + pack context, provides stores
  <TopBar/>                                     // name, save state, undo/redo, mode switch, Render
  <LeftRail>  <PartsTree/> <ZoneList/> <SnapControls/> </LeftRail>
  <CenterStage mode={place|look|split}>
      <FaceView>                                // 2D: flattening pass + overlay canvas
        <FaceBackdrop/>                         //   three.js RT of the real mesh in zone space
        <OverlayCanvas>                         //   Konva: transform box, guides, rulers, handles
          <TransformBox/> <SnapGuides/> <Rulers/> <SafeArea/> <CustomGuides/>
        </OverlayCanvas>
      </FaceView>
      <Viewport3D>                              // R3F canvas (16-preview-engine.md)
        <ProductScene/> <CameraRig/> <RenderCropFrame/> <WarningsStrip/>
      </Viewport3D>
  </CenterStage>
  <RightPanel> <ArtworkPanel/> <FinishPanel/> <MaterialPanel/> <ScenePanel/> </RightPanel>
  <LayerList/>                                  // v2 multi-placement
  <RenderDialog/> <JobTray/>
</DesignEditor>
```

`FaceView` and `Viewport3D` mount **one** three.js renderer shared through context; the face view is
a second pass, not a second WebGL context (contexts are a scarce resource and doubling them halves
the frame budget).

## State

Three stores, deliberately separate:

```ts
// 1. Document store — the design document. Every mutation goes through a command.
const useDesign = create<DesignState>()(immer((set, get) => ({
  document: null as DesignDocument | null,
  version: 0,
  dirty: false,
  validation: { errors: [], warnings: [] },
  apply(cmd: Command) { … },        // see command stack below
})));

// 2. Editor UI store — selection, mode, zoom, snapping, panel state. Not persisted to the server.
const useEditorUi = create<UiState>()((set) => ({
  mode: 'split', selectedZoneKey: null, selectedPlacementId: null,
  snapEnabled: true, gridEnabled: false, zoom: 1, pan: {x:0,y:0}, guides: [],
}));

// 3. Session/queue store — render jobs in flight, SSE-fed.
const useJobs = create<JobsState>()((set) => ({ jobs: {}, … }));
```

TanStack Query caching is an intended pattern, not the implementation of the standalone artwork
library. Its server page loads tenant-owned records, and `ArtworkPage` uses local React state and
the existing fetch routes. Upload, rename and delete reload the list; saves adopt the returned
record. `artwork-edit-state.ts` keeps an immutable undo/redo history for the active editing session.

## Command stack (undo/redo, F-EDIT-05)

```ts
interface Command {
  id: string; label: string;                         // "Move logo", "Set depth"
  apply(doc: Draft<DesignDocument>): void;
  invert(doc: DesignDocument): Command;              // computed at apply time from the pre-state
  coalesceKey?: string;                              // merges rapid same-key commands (slider drags)
}

function apply(cmd: Command) {
  const before = get().document!;
  const after = produce(before, (d) => cmd.apply(d));
  const issues = validateDesign(after, packContext);            // shared with the server (15 §7)
  if (issues.errors.length) return reject(issues);              // never enter an unrenderable state

  undoStack.push(cmd.invert(before));
  redoStack.clear();
  set({ document: after, dirty: true, validation: issues });
  scheduleAutosave();                                            // debounce 800 ms, flush on blur/nav
}
```

Rules: one command per **gesture**, not per pointer event (drags coalesce by `coalesceKey`); camera
moves are not commands; autosave sends the whole document with `If-Match: version` and rebases on
`409` by replaying local commands against the server's document.

## 2D ⇄ 3D synchronization

There is nothing to synchronize: both views render from `useDesign.document`. The face view converts
pointer positions to zone space and emits commands; the 3D view reads the same placements and its
zone textures are recomposed on document change ([16](16-preview-engine.md)).

```ts
function onPointerMove(e) {
  const zonePt = screenToZone(e, { pxPerMm, pan, zoom });                 // 15 §3
  const proposed = dragTransformFrom(dragStart, zonePt, mods);
  const { transform, guides } = applySnap(proposed, snapCtx, { altHeld: e.altKey });  // 15 §5
  setPreviewTransform(transform);                     // local, not yet a command → cheap, undo-clean
  useEditorUi.setState({ activeGuides: guides });
}
function onPointerUp() {
  apply(moveCommand(placementId, quantize(previewTransform)));            // one undo entry
}
```

Interactive dragging writes to a transient overlay state; only `pointerup` commits a command. That
keeps undo meaningful and autosave quiet.

## Loading and progressive enhancement

```ts
// Editor boot sequence, measured against the budgets in 03-gui.md
1. Server renders shell + design metadata (no WebGL yet)         < 300 ms
2. Fetch design document + pack context (one request)            < 200 ms
3. Start LOD0 GLB + HDRI (parallel, signed URLs prefetched)      first pixels < 1.5 s
4. Compose zone textures once artwork maps arrive                 < 300 ms after
5. LOD1 + full-res environment swap silently in the background
```

Suspense boundaries per region so the right panel is usable before the mesh finishes loading.

## Realtime (SSE)

```ts
function useJobStream(jobId: string) {
  useEffect(() => {
    const es = new EventSource(`/api/renders/${jobId}/events`, { withCredentials: true });
    es.addEventListener('progress', (e) => useJobs.getState().patch(jobId, JSON.parse(e.data)));
    es.addEventListener('preview',  (e) => useJobs.getState().setPreview(jobId, JSON.parse(e.data).url));
    es.addEventListener('done',     (e) => { toast.success('Render ready'); queryClient.invalidateQueries(['renders']); es.close(); });
    es.addEventListener('failed',   (e) => { useJobs.getState().fail(jobId, JSON.parse(e.data)); es.close(); });
    es.onerror = () => backoffReconnect();                    // state is re-derivable via GET
    return () => es.close();
  }, [jobId]);
}
```

The job tray survives navigation because it lives in the app layout, not the editor.

## Error handling

| Layer | Behavior |
|---|---|
| Query/mutation | Typed error codes → user copy map; retry for 5xx/network only |
| Validation | Blocking errors disable Render with the reason inline; warnings are amber, non-blocking |
| WebGL context loss | Detect `webglcontextlost`, show recovery card, rebuild scene from document |
| Version conflict | Rebase local commands, show "someone else edited this design" only if rebase fails |
| Session expiry | Modal re-auth; document is kept in memory and in IndexedDB so nothing is lost |
| Offline | Save state shows "reconnecting"; commands queue; flush on reconnect |

## Accessibility implementation

- All panel controls are native/Radix components with labels, roles, and visible focus.
- The canvas is a focusable region with a documented keyboard model: arrows nudge, `[`/`]` rotate,
  `+`/`-` scale, `1..4` cameras, `Tab` switches Place/Viewer — every mouse action has a key path.
- `aria-live="polite"` region announces job status, validation changes, and snap events
  ("snapped to zone center").
- Respects `prefers-reduced-motion` (no auto-orbit, instant transitions).

## Performance practices

- No React state at 60 Hz: pointer-driven values live in refs and mutate three.js objects directly;
  React re-renders only on committed commands.
- Memoized selectors (`zustand/shallow`) prevent panel re-renders on unrelated document changes.
- Route-level code splitting: three.js loads on saved/demo editors, material previews and pack zone authoring; library and account pages stay WebGL-free.
- Bundle budget: shell ≤ 180 kB gz, editor chunk ≤ 700 kB gz (three + loaders), checked locally with `pnpm bundle:budget` and in CI.

## Testing hooks

- `data-testid` on every interactive control in the editor.
- `window.__editor` (dev/test builds only) exposes `applyCommand`, `getDocument`, `screenToZone` so
  Playwright can drive precise placements without pixel-hunting.
- Deterministic mode flag disables animation/damping so screenshots are stable.

## Shared orientation workspace

`OrientationWizard` owns the candidate frame, saved baseline, staged confirmation, camera, surface-selection mode and load/save failures. `OrientationPlane` provides the rotation gizmo and grid. `PackSetup` supplies the staff draft endpoint, tenant-scoped import diagnostics, existing `VariantZones`, slot defaults and publishing. The design editor supplies read-only product context and applies its override through the existing design save API only after Review.

The candidate front preview follows every edit; the main camera changes only on explicit view choices or orbit. Product confirmation persists a draft and refreshes the concurrency token. Design confirmation stages changes until Apply; cancel restores the original document. Existing autosave is blocked while the design wizard is open. Changing product variant clears its orientation override because source axes may differ.

## PP material workflow

The current material library contains **Matte** and **Glossy** only. Glossy retains the
former pearlescent shader values. Material color remains independently editable.

In **Materials → Artwork**, emboss/deboss offers **Same as cap**, **Matte**, or **Glossy**.
Choosing a separate finish changes the artwork roughness while retaining the underlying part color;
no ink-fill toggle is needed. Print continues to expose its own color control.

Migration `0013_pp_material_cleanup.sql` updates saved design versions (including deleted-design
history), catalog defaults and stored pack manifests, then removes obsolete library definitions.
Old pearl references become Glossy; other removed materials become Matte. Fixture packs and
new CAD drafts use the same two finishes. Original CAD geometry and uploaded artwork are retained.
Tests were not run for this change at the maintainer's request.

## Design thumbnails on return

The editor’s **Back to designs** arrow saves pending edits, captures a downscaled screenshot of the
current 3D viewer, and uploads it before navigating. The screenshot uses the visible camera and
lighting, including Inspection mode; it contains no page controls and starts no render job.

Exit capture bypasses the normal 45-second background throttle and waits for an older upload so
it cannot overwrite the latest screenshot. A failed screenshot/upload leaves the previous image
available and does not block returning. Failed, blocked, or conflicting design saves keep the editor
open. If Place mode has no mounted viewer, returning briefly opens it to capture the current design.
Read-only designs do not upload thumbnails.

Design thumbnail responses use private no-store caching, and the dashboard issues fresh thumbnail
URLs to avoid old immutable browser entries. Other assets retain their existing caching policy.
This workflow applies to the editor arrow; native browser Back, tab close, and reload are unchanged.
Tests were not run for this change at the maintainer’s request.

## Render uses the active lighting

Render captures the current Design or Inspection lighting at click time, including inspection
rotation. It waits for successful autosave before submitting the fixed snapshot. Later changes do
not alter an already submitted job. Inspection remains temporary editor state and does not replace
the saved lighting preset. The Render panel retains **Use design lighting** as an explicit choice;
Render itself never switches modes. See [the plan](35-render-current-lighting.md).

## Viewer snapshot

The toolbar's outlined camera **Snapshot** action downloads the current 3D drawing buffer as PNG,
at viewer resolution. It preserves the displayed camera, lighting, materials, artwork, cross-sections
and background, excluding DOM controls. It is independent of autosave, thumbnail uploads and the
render queue, and works in demo and archived/view-only designs. Place mode disables it with a
Viewer/Split hint; loading and encoding failures allow retry. See [snapshot details](37-viewer-snapshot.md).
