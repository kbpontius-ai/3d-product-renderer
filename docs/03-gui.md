# 03 — GUI & Experience Spec

Desktop-first (the editor needs screen area). Tablet = view/approve only. Phone = view renders,
manage account. Design language: Wrap — warm linen canvas, white panels and restrained ink typography.
The current implementation reference is [the style guide](design-system/DESIGN.md).

---

## Screen inventory

| Screen             | Route                           | Purpose                                                              |
| ------------------ | ------------------------------- | -------------------------------------------------------------------- |
| Sign in            | `/signin`                       | Email + password, reset link                                         |
| Accept invite      | `/invite/accept`                | Verify token, set password                                           |
| Reset password     | `/reset`                        | Request + complete                                                   |
| Designs            | `/designs` (`/` redirects here) | Recent designs, search/filter, grid/list, new design CTA             |
| Catalog            | `/catalog`                      | Browse/filter products; product detail page                          |
| **Editor**         | `/design/:id`                   | The product; everything else supports it                             |
| Render gallery     | `/renders`                      | Outputs, download; submit new renders from the editor                |
| Artwork library    | `/artwork`                      | Uploaded logos, versioned basic edits and reusable artwork           |
| Account            | `/account`                      | Who you are signed in as                                             |
| Organisation admin | `/org/*`                        | Owner-facing: members, product access, quota use, activity           |
| Admin console      | `/admin/*`                      | Staff-only, cross-tenant: catalog ingestion, materials, users, queue |
| Share view (P1)    | `/s/:token`                     | Read-only design + renders                                           |

## Information architecture

```
Sign in ──► Designs ──► Catalog ──► Editor ──► Render settings ──► Renders ──► Download
               │           │           │
               │           │           └─ Save / duplicate / artwork library (inline)
               │           │
               └───────────┴─ global header: Designs · Artwork · Catalog · Renders
                              account menu: Account · Organization (owner) · Admin (staff)
```

Built as written, in `F-NAV-01`. Until then this diagram described an architecture the application
did not have: there was no global navigation at all, each page carried its own header with its own
link set, `/org` had one inbound link in the codebase, and the editor had none. The shared header is the
single answer to "where can I go from here", and it is the same answer on every signed-in page.

Below it, `/admin` and `/org` each add a left sidebar for their own sections (`F-NAV-02`,
`F-NAV-03`) — section navigation beneath the common application header.

---

## Editor anatomy

Designs open in **Viewer** with **Inspection** lighting at **0°** rotation. Place, Split and Viewer are separately spaced toolbar buttons. Inspection is viewer-only; saved studio lighting and exports are unaffected.

The placement surface uses a small material swatch rendered with the current Viewer lighting
(`F-PREV-09`) instead of an artificial color gradient. Color, material finish, studio and inspection
rotation changes refresh it in both Place and Split. A loading indicator remains until the artwork shading is ready. The matched color can arrive a moment later, so the part's own color shows first. Artwork retains edge shading for depth.
The match is representative; the 3D model still shows reflections and highlights that depend on
its curvature and camera angle. Placement tools and saved color values are unchanged.

Two modes share one document: **Place** (2D face view, artwork positioning) and **Viewer**
(3D viewport, materials/scene judgement). They can be shown split or full-width; the mode toggle
is the most-used control in the app.

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ ◀ Designs   Cap 38mm — Acme     ● Saved   ↶ ↷   [ Place ] [ Split ] [ Viewer ]    [ Render ] │
├──────────────┬───────────────────────────┬──────────────────┬─────────────────────────┤
│ PARTS        │  2D FACE VIEW (Place)     │  3D PREVIEW      │ ▣ Artwork               │
│ ▸ Cap body   │   ┌ ruler mm ───────────┐ │                  │   [logo.svg] ⟳ replace  │
│ ▸ Liner      │   │ ┌ ─ zone ─ ─ ─ ─ ┐  │ │      ╭─────╮     │   W 24.0  H 8.2 mm  🔒  │
│              │   │ ╎   ┌───────┐   ╎  │ │     ╱       ╲    │   X  0.0  Y  0.0 mm     │
│ ZONES        │   │ ╎   │ LOGO  │   ╎  │ │    │  logo   │    │   ∠  0°                 │
│ ▸ Top face ● │   │ ╎   └───────┘   ╎  │ │     ╲       ╱     │   [Fit] [Fill] [100%]   │
│ ▸ Skirt      │   │ └ ─ safe area ─ ┘  │ │      ╰─────╯     │   [⌖ Center H] [⌖ V]    │
│              │   └────────────────────┘ │                  │ ▣ Finish                │
│ GUIDES       │    ⇅ center guide shown  │  orbit / presets │   ( ) Print (•) Deboss  │
│ ▸ Snap  ON   │    28.4 px/mm · 4.1 mm   │                  │   Depth 0.35 mm ▁▂▃     │
│ ▸ Grid  off  │      clearance to edge   │                  │   Bevel 30°             │
├──────────────┴───────────────────────────┴──────────────────┤ ▣ Material  ▣ Scene     │
│ LAYERS  ▸ logo.svg (deboss)  👁 🔒            + Add artwork  │                         │
└───────────────────────────────────────────────────────────────┴─────────────────────────┘
```

**Left rail** — parts tree (selecting a part scopes the material panel) and decoration zones
(selecting a zone opens its 2D face view and frames the 3D camera on it). Snap/grid/guide toggles
live here so they're always reachable without leaving the canvas.

**Center — Place mode (the 2D face view).** The primary placement surface for every product:

- Orthographic render of the **actual part** along the zone normal, flat-shaded, with the zone
  boundary, safe margin, and center cross-hair drawn over it. Curved zones are shown unrolled.
- A live **px/mm** readout; mm rulers on two edges; optional grid; draggable custom guides.
- Artwork is a transform box: 8 handles (corners proportional, edges stretch), a rotation handle,
  and a move body. Every gesture reports mm live near the cursor.
- **Snap guides** appear only while they're active — a magenta line for zone center X/Y, a dashed
  line for safe margin/edges, a thinner line for custom guides and neighbouring artwork.
- Snapping is overridable at all times: `Alt` disables it during a drag, dragging ~1.5× past the
  threshold breaks the snap, and the rail toggle turns it off permanently.
- Zoom/pan with wheel and space-drag; `F` fits the zone to the view.

**Center — Viewer mode (3D).** Orbit/pan/zoom with damped controls, camera preset buttons, the
render-crop frame, quality indicator, and the warnings strip. Edits made in Place mode appear here
within a frame; dragging artwork directly on the 3D model is supported but secondary.

**Right panel** — accordion in workflow order: Artwork (size/position/rotation with aspect lock,
Fit/Fill/100%, align actions) → Finish (type, depth, bevel, ink) → Material → Scene. Numeric
inputs are mm-first with drag-scrub and keyboard step; every slider has a typed value.

**Bottom** — layer list (multiple placements in v2) with visibility/lock and reorder.

**Top bar** — breadcrumb, design name, save-state, undo/redo, mode switch, and the primary CTA:
**Render**.

### Cross-section

Top-left of the Viewer viewport: **Whole** plus one button per cut the part offers, and a single
"Cut at N mm" slider once a cut is chosen. No plane picker, no gizmo — the cuts are named for what
they show ("Through the artwork", "Lengthways") and derived from the pack (`F-EDIT-11`,
docs/16). Zero on the slider is always the middle of the part, so the control reads the same
whichever cut is open.

### Interaction rules

- Drag artwork from the library onto the face view or the model → drops into the nearest legal zone,
  auto-fitted to the safe area.
- Placement is clamped to the zone; hitting the boundary flashes the edge rather than snapping back.
- Snap targets in priority order: zone center X/Y → custom guides → safe margin → zone edges →
  other placements. Threshold is measured in screen pixels so it feels identical at any zoom.
- Camera never leaves the product's bounds; double-click a feature to focus it.
- Modifier keys: `Shift` = constrain axis / 15° rotation snap / free aspect while scaling,
  `Alt` = suspend snapping during a drag, `Space` = temporary pan, `Cmd/Ctrl+D` = duplicate placement.
- Every mutation is undoable; camera moves are not part of undo history.

### Keyboard shortcuts

`⌘/Ctrl+Z` undo · `⇧⌘Z` redo · `⌘S` save now · `⌘⏎` render · `F` frame selection · `1..4` camera
presets · `G/R/S` move/rotate/scale mode · `⌫` remove placement · `Tab` switch Place/Viewer · arrows nudge
0.5 mm (`Shift` 0.1 mm) · `?` shortcut sheet.

---

## Render settings

Compact, one screen, no surprises:

- Camera: current view or saved presets (multi-select in P1 for batch).
- Quality: Draft / Standard / Final — each shows expected time and cost in plain words.
- Resolution + format + background (studio / solid / transparent).
- Live cost estimate + remaining quota; **Render** disabled with an explicit reason if blocked.
- Warnings from the design (e.g. artwork below minimum stroke) are repeated here — last chance
  before spending GPU minutes.

After submit: a job card appears in a persistent tray (bottom-right) with a progress bar, ETA,
streaming preview frames as the path trace resolves, and cancel. Closing the tab is safe;
completion notifies in-app and by email.

## Render gallery

Masonry grid of outputs with hover metadata (design version, camera, resolution, date). Actions:
download (original + web size), re-render at higher resolution, open the originating design
version, delete. Filters by design, date, and status; failed jobs stay visible with the reason
and a one-click retry.

## Dashboard

The current entry screen is Designs: recent thumbnail cards, search/product filters, sorting and
grid/list views. New design opens Catalog. Render activity lives on Renders, and uploads on Artwork.

## Artwork library

`/artwork` uses the Wrap system: Inter, linen canvas, white surfaces, 8px controls, 12px cards
and the same full-width navigation as Designs/Catalog/Renders.

- **Gallery:** four square preview tiles across on desktop, two on narrower screens. Each tile
  shows the sanitised SVG, name, visible dimensions and upload date. Search and newest/name sort
  sit above the grid. **Upload SVG** is the sole upload entry, at the top right. Tile actions offer
  rename and confirmed, protected deletion. Empty and no-match states say how to proceed.
- **Expanded editor:** selecting a tile opens a large checkerboard SVG canvas with a property
  inspector and **Back to artwork**, **Cancel**, **Save changes**. Selection handles resize
  proportionally; numeric dimensions can stretch with the aspect lock off. Rotate and flips edit
  the whole artwork; zoom, Fit and pan only change the view. Undo/redo affects unsaved edits.
  Warnings appear in the inspector. Invalid dimensions/name block saving.
- **Other artwork:** a horizontal strip beneath the expanded workspace; switch by selecting a tile.
  Switching or leaving asks before discarding changes. **Upload SVG** is hidden while editing.
- **Saving:** shape edits create a new immutable version; existing designs stay pinned. Rename-only
  edits update the shared label. Deletion remains blocked when any saved design uses the artwork.

**Preparation (F-ART-12):** a full-width object list, styled Source canvas and checkerboard
Prepared mark replaces the gallery/filmstrip during upload or Edit selection. Select/pan are
separate pointer tools; zoom, overlap candidates, groups, exact/similar color shortcuts and
fill/stroke inspection help identify objects without guessing intent. Selection begins empty.
**Repair paths** changes the heading and list, freezes inclusion, and starts in Inspect. Ends
A/B, Fit gap/object, explicit endpoint choices, a dashed proposed connection, before/after
paint, review acceptance and Apply make every repair deliberate. Open strokes can stay open.
Review/Confirm show physical size and understandable errors with recovery hints. Undo/redo and
navigation discard guards apply throughout. Narrow screens switch Source/Prepared canvases.
Source-backed editor entries expose Edit selection and private original download; legacy entries
explain why an original reupload is required. See [29](29-artwork-preparation.md).

The inline Artwork library in a saved design remains the way to place library artwork on a product.
Version-history browsing, usage counts, height-map previews and path/node editing are not built.
See W-17 in [02-workflows.md](02-workflows.md).

## Organisation admin

Owner-facing, and one organisation at a time. Four tables — people, product access, overview,
activity — with the same shape as the staff console so nothing has to be learned twice.

Two things it deliberately does not offer, because both are irreversible and neither is needed:
deleting a member (suspend instead — it locks the account out of both doors and keeps every design)
and changing quotas (staff).

The screen inventory used to promise a `/settings/*` area bundling members with profile, password
and 2FA. It was never built, and organisation administration and personal account settings turned
out to want different guards — one is `owner`-only, the other is anybody signed in — so they are
separate routes rather than tabs of one.

## Admin console

Staff-only and cross-tenant by construction. Organizations is the tenant entry in the sidebar;
its directory retains read-only email lookup across accounts. A selected organization keeps its
identity and status above Overview, People, Products, Limits and Activity header sections. People
filters and pagination stay within that organization, with account controls on person details.
See [organization workspace](31-organization-workspace.md). Table-driven: products (with ingestion status pipeline), materials, environments,
users/invites, render queue. Each ingestion step exposes its QA output, and publishing is gated on
green checks.

**System status** (`/admin/status`, `F-ADM-15`) is the first page to open when something seems wrong.
Top to bottom it answers: is anything wrong (one verdict and a list), which service (a card each, green
/ amber / red), what is running right now (renders in progress, the queue, CAD ingestions), how the
last day went, and what the servers have been complaining about (the server log, filterable). It
refreshes itself; the queue page is where a job is then cancelled, retried or its log read.

---

## States, feedback, and error surfaces

| Situation                    | Treatment                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model loading                | Skeleton + progress %, LOD0 appears < 1s, sharpening to LOD1 silently                                                                                                                   |
| Slow device                  | Automatic quality drop with a discreet "performance mode" chip (user can override)                                                                                                      |
| Upload rejected              | Inline, specific, actionable ("Text isn't outlined — convert text to paths and re-upload"), with a link to the report                                                                   |
| Manufacturability warning    | Non-blocking amber strip in the viewport + repeat in render dialog                                                                                                                      |
| Render running               | Persistent tray card with progress + preview frames; also reachable from gallery                                                                                                        |
| Render failed                | Human-readable cause, retry button, staff-only diagnostics behind a role check                                                                                                          |
| Quota exhausted              | Blocking dialog stating the limit, reset time, and who to contact                                                                                                                       |
| Session expired              | Non-destructive: work is preserved locally, re-auth modal, then continue                                                                                                                |
| Offline/network loss         | Save state shows "reconnecting", edits queue locally, no silent data loss                                                                                                               |
| A change to someone's access | Confirmation modal (`F-UI-07`) naming the person and the change, with a list of exactly what will happen; Cancel is the default. Nobody can change their own role or suspend themselves |

**Empty states** are instructional, not decorative: dashboard suggests browsing the catalog;
artwork library explains SVG requirements up front (outlined text, closed paths, min stroke width).

---

## Performance budgets (UX-visible)

- First meaningful paint of editor shell < 1.5 s; LOD0 model visible < 3 s on cable broadband.
- Sustained ≥ 45 fps orbiting a cap scene on integrated graphics; ≥ 30 fps floor before
  auto-quality kicks in.
- Artwork placement updates preview in < 100 ms; changing emboss depth < 150 ms.
- Artwork upload → usable in editor < 10 s for a typical logo.

## Accessibility

- WCAG 2.2 AA for all non-canvas UI; 3D canvas has documented keyboard equivalents for every
  action (camera presets, numeric transforms, finish selection) so nothing is mouse-only.
- Visible focus rings, logical tab order, ARIA live regions for job status changes.
- Never encode meaning in color alone (warnings carry icon + text).
- Respect `prefers-reduced-motion` (disables auto-turntable and animated transitions).
- Minimum 14px UI type; numeric fields accept typed values everywhere sliders exist.

## Design system notes

The system is **Wrap** — see [design-system/DESIGN.md](design-system/DESIGN.md) for current
identity, tokens and component rules. The historical supplied files are identified in
[design-system/README.md](design-system/README.md). Base styles live in `globals.css`; the
approved workspace refinements live in `workspace.css` and apply to app, owner and staff screens.

User-editable values and system-reported values are distinguished by placement and labels.
The viewport background remains a property of the design document (`studio`, `solid`,
`transparent`), so changing the surrounding interface does not change rendered output or the
preview parity contract in [16-preview-engine.md](16-preview-engine.md).

## Wrap workspace (F-UI-08)

Designs uses an image-led desktop grid with optional list view, search, product filter and sorting. New design opens Catalog for product selection. Rename/duplicate/delete live in each design’s overflow menu; Recently deleted retains restore. Saved and demo editors share global navigation with library pages; their document toolbar holds Place/Split/Viewer, history and save status. The toolbar Render action scrolls to the mounted settings panel, preserving active job state. Admin Organizations adds client-side search/status filtering over its loaded records and a server-backed, read-only person lookup. Organization header sections and nested People details follow [the organization workflow](31-organization-workspace.md). All routes use the shared visual tokens. See [reskin plan](30-workspace-reskin.md) for scope and verification.

Catalog imagery (`F-CAT-08`): cards show the captured product-only web viewer, falling back to a
supplied pack thumbnail or an explicit Preview not available state. Admin → Packs → Catalog
previews provides Generate/Regenerate, camera presets, orbit/pan/zoom and Capture preview. The
saved image excludes interface controls and artwork; no render worker is needed.

## Guided orientation interface

The full-width orientation page reuses the exact AppNav and existing Wrap tokens. Page breadcrumbs sit above the title; four connected step dots sit at the right. The orbitable main viewer has a blue reference plane, rotation rings and perpendicular Front/tangential Up arrows. The inspector offers surface alignment, current-view alignment, flip, quarter-turn, restore and a live Front preview. Three-quarter, Front, Top and Reset view remain visible. The bottom bar contains Back, Close and the step-specific confirmation action. The design Review compares proposed and starting Front views when changed.

Initial setup and reorientation share `OrientationWizard`; staff setup reuses existing zone authoring and material selectors. Pending zone/material edits block leaving that stage until saved or explicitly reset. See [the complete interaction specification](33-product-orientation.md).

### Decoration target and orientation lighting

The existing zone form includes **Artwork target part**, with Automatic and the product's declared
part labels. Published targets are disabled; use a new draft version to change physical targeting.
An ambiguous or stale target produces a message inside the viewport, leaving the design editor
available for review. Staff resolves the target through Admin zone authoring.

Both setup/reorientation viewers and the Front preview use the same bright Detail rig. **Lighting
preset** remains the persistent lighting control. Below Background, **Orientation** contains the
full-width **Reorient product** action. **Viewer lighting** uses a joined **Design lighting / Inspection**
selector. **Light rotation** and its degree value appear only while Inspection is selected;
**Reset rotation** remains available in either mode. Inspection and its angle are temporary;
exports use the selected preset.
No upload, placement, material, depth, camera-preset or render controls are removed.

### Admin surface-zone mapping (F-ADM-18)

The existing zone form has a Mapping dropdown: Flat surface and Follow surface. Add zone opens a
surface-following zone with placement left for the author. Follow surface uses the actual target
mesh, including oval, tapered and irregular faces, for the test pattern, boundaries and surface
checks. Unsupported areas are omitted from the drawn patch and reported in the form; adjust the
position, dimensions or projection depth. Camera and picking controls, navigation, constraints and
finishes retain their existing layout. Saved mapping changes are allowed only on unused drafts.
Stored cylindrical zones remain readable/editable for compatibility; new zone creation does not
offer cylindrical mapping. Check with test pattern remains available after publication.
