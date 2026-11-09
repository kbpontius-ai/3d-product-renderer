# 01 — Feature Inventory

Priority ⇒ release: **P0 = v1**, **P1 = v2**, **P2 = v3**.
Each feature has a stable ID. Acceptance = the observable condition that closes it.
Genericity rule: no feature may assume a specific product shape (see `F-GEN-09`).

The **v1** column tracks the P0 set only. `[x]` means the code was read and the acceptance text
checked against it; `[ ]` means something in the acceptance is not met, and each one is explained
where it sits. `–` means the feature is out of the v1 scope and the box would never be ticked.

A tick is a claim about the acceptance text, not about a test passing. Where a feature is only
partly met the box stays empty rather than being ticked with a caveat, because a half-ticked
checklist is the kind that gets believed.

Three sections sit outside that scheme, added after the v1 set was closed. They read in release
order, and each says which release it belongs to in its heading:

- **O — v1.1 local deployment (`F-DEPLOY-*`).** What stands between "the code is complete" and
  "somebody else can run it". Almost entirely documentation and one script; no product behaviour
  changes. This is the nearest release and the cheapest.
- **P — v1.5 hardening and documentation (`F-HARD-*`, `F-DOC-*`).** Security and reliability work
  on code that already shipped, plus the documentation debt v1 left. None of it is a v1 acceptance
  criterion and none of it blocks release; the hardening half is what a security review of the CAD
  pipeline would raise, written down before it is forgotten.
- **Q — v2 CAD pipeline (`F-CADX-*`).** New capability proposed while building v1, kept out of it.
  These come from [23-cad-ingestion.md](23-cad-ingestion.md), which labelled most of them
  "proposals, not commitments" — this is where they wait until somebody commits.

Everything known-outstanding is in one of those three. Where a detail is too long to sit in a table
cell it lives in the linked document and the cell says which one, so this file stays the index.

---

## Where this stands

**v1 is code-complete.** 75 of the 77 P0 features are ticked. What is left is not engineering:

| | What | Who |
|---|---|---|
| `F-MAT-08` | Current curated palette is Matte and Glossy; additional presets are not offered. | pack authoring |
| Catalog depth | [00-overview.md](00-overview.md) wants a curated catalog of 5–15 SKUs from one pack. There are two fixture packs with one product each. | pack authoring |
| M1 exit | [07-roadmap.md](07-roadmap.md) asks for an internal user completing the whole workflow on staging unaided. The local half is done (`F-DEPLOY-*`); a staging environment is the rest. | deployment |
| `F-MAT-09` | The closure liner. **Backlogged by standing decision** — the slot is to be removed, and nothing is built on it. See the row in section F. | deferred |
| `F-PLAT-08` | Accessibility. **Backlogged by standing decision** — see the row in section N. No accessibility code is written until it is explicitly picked up. | deferred |
| `F-AUTH-09` | Staff two-factor. **Not in the initial release, by decision; high priority immediately after it.** See the row in section A. | after release |
| `F-SHIP-11`–`13` | **Start here.** Production setup, email, and a clean-server run-through: the first work after the initial release, before anything else. Detailed steps in [38](38-first-work-after-release.md). | after release |

**The release ladder after v1**, cheapest first. Each is a section below:

| Release | Section | What it is | Blocks release? |
|---|---|---|---|
| v1.1 | O — `F-DEPLOY-*` | **Done.** Somebody other than the author can run this: `scripts/deploy-local.sh you@example.com`. | — |
| v1.5 | P — `F-HARD-*` | Security and reliability on shipped code, mostly the CAD pipeline's attack surface. Ingestion is staff-only, which is the compensating control keeping it off the critical path. | No |
| v2 | Q — `F-CADX-*` | New capability, proposed while building v1 and deliberately left out. | No |

Nothing known-outstanding lives outside this file. Where a detail is too long for a table cell it
sits in the linked document; the cell names it.

---

## A. Account & Access (`F-AUTH-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-AUTH-01 | Admin-issued email invitation | P0 | Staff/owner enters email(s); single-use, TTL-bounded invite link sent. Resend + revoke supported — on the invited person's row, for staff and owners alike. The form reports whether the email actually went; the link is shown to the inviter only with development tooling on. |
| [x] | F-AUTH-02 | Email verification | P0 | Clicking the invite link proves mailbox control; token single-use and hashed at rest. |
| [x] | F-AUTH-03 | Set password on acceptance | P0 | zxcvbn strength gate + breached-password check; account becomes active. |
| [x] | F-AUTH-04 | Email + password sign-in | P0 | Session cookie; enumeration-safe errors; per-IP and per-account rate limits with backoff. |
| [x] | F-AUTH-05 | Forgot / reset password | P0 | Same token mechanics; all sessions invalidated on reset. |
| [x] | F-AUTH-06 | Session management | P0 | HttpOnly/Secure/SameSite cookies; idle + absolute expiry; "sign out everywhere". |
| [x] | F-AUTH-07 | Roles & permissions | P0 | `staff`, `owner`, `member`; every read/write org-scoped. |
| – | F-AUTH-08 | Team management | P1 | Owner invites/removes members, sees seat usage. |
| – | F-AUTH-09 | Two-factor (TOTP) | P1 | Optional per user; required for `staff`. **High priority: the first feature after the initial release.** The initial release ships without it, by decision, so staff sign in with a password only, and the release notes say so. Staff reach every organization and alone can import CAD, which makes a staff password the most valuable credential in an installation ([36 section 8](36-self-host-readiness.md#security-findings-review), S-3). |
| – | F-AUTH-10 | SSO (OIDC/SAML) | P2 | Enterprise orgs; also an auth adapter for self-hosters. |
| – | F-AUTH-11 | Audit log (auth + admin) | P1 | Invites, logins, role changes, admin actions; staff-viewable. |
| – | F-AUTH-12 | Request access from sign-in | P1 | A visitor asks for an account; the request reaches staff, who approve (choosing org and role, which issues the normal invitation) or deny. Requires `F-PLAT-09`. The endpoint is unauthenticated and must answer identically for every address, or it becomes the enumeration oracle `F-AUTH-04` refuses to be. **Scoped:** [28-enterprise-access.md](28-enterprise-access.md). |
| – | F-AUTH-13 | Bulk invitation import | P1 | Staff paste or upload CSV, see a per-row dry run (new / already a member / live invite exists / malformed), then commit. Rides the existing `invite()`; the partial unique index makes a re-run report rather than duplicate. Requires `F-PLAT-09`. **Scoped:** [28-enterprise-access.md](28-enterprise-access.md). |

## B. Product Catalog (`F-CAT-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-CAT-01 | Browse catalog | P0 | Grid of products with thumbnail, name, category, key dimensions — rendered from pack manifests. Captured thumbnails are catalog presentation assets under `F-CAT-08`; missing images show an explicit placeholder. |
| [x] | F-CAT-02 | Filter/search | P0 | Facets are declared by packs (e.g. closure type, neck size), not hard-coded. Search filters as it is typed, debounced, with the term in the URL so a filtered catalog stays a link; typing replaces the history entry, choosing a facet pushes one. |
| [x] | F-CAT-03 | Product detail + spec | P0 | Dimensions, zone sizes, allowed finishes, material options. |
| [x] | F-CAT-04 | Variants | P0 | Size/config variants; placements carry over where zone geometry permits. |
| – | F-CAT-05 | Quick 3D preview from catalog | P1 | Spin the product before starting a design. |
| – | F-CAT-06 | Org-private products | P1 | Packs visible only to specified orgs. |
| – | F-CAT-07 | Additional product families | P1 | Bottles/jars, boxes, sleeves, tubes — delivered as packs (see F-GEN-01). |
| [x] | F-CAT-08 | Catalog thumbnail capture | P1 | Implemented. Staff capture the product-only web viewer using an existing camera preset or a manual angle. Images are presentation assets; manifests, geometry and saved designs stay unchanged. Regeneration needs no render worker; the CLI publishes a folder of viewer captures. See docs/32-catalog-thumbnails.md. |

## C. Artwork Ingestion (`F-ART-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-ART-01 | SVG upload | P0 | Drag/drop or picker; size cap; MIME + content sniffing; progress + clear errors. |
| [x] | F-ART-02 | Sanitization | P0 | Strip scripts/handlers/external refs/foreignObject/DTD entities before anything renders it. |
| [x] | F-ART-03 | Normalization | P0 | Resolve viewBox/units, flatten transforms, text→paths (or reject with reason), strokes→fills, merge overlaps. |
| [x] | F-ART-04 | Validation & manufacturability warnings | P0 | Open paths, min stroke below zone limit, node-count ceiling, unsupported gradients/filters for emboss, artwork exceeding zone. |
| [x] | F-ART-05 | Derived asset generation | P0 | Canonical raster fill mask, SDF, height + normal maps, contours — used by BOTH preview and render. |
| [x] | F-ART-06 | Artwork library | P0 | Per-org list with thumbnails, reuse, rename and protected soft deletion. Available in the design editor and at `/artwork`; shape editing is `F-ART-11`. Legacy versions can explicitly re-upload their original through `F-ART-12`; arbitrary replacement remains outside this workflow. |
| – | F-ART-07 | Multi-color / spot mapping | P1 | Map SVG fill colors to inks/finishes (one path foil, one ink). |
| – | F-ART-08 | Raster/PDF/AI/EPS upload | P1 | PNG for print finishes; vector conversion server-side in a hardened sandbox. |
| – | F-ART-09 | Auto-trace raster → vector | P2 | For customers with only a JPG. |
| ~ | F-ART-10 | Artwork versioning | P1 | Shape edits at `/artwork` retain prior immutable versions and designs pin a version. Version-history browsing and an explicit "update to latest" action remain planned. |
| [x] | F-ART-11 | Standalone artwork gallery and editor | P0 | `/artwork`, reached through Designs / Artwork / Catalog / Renders. Four-column SVG gallery with upload, search, sorting, rename and protected deletion. Opening a tile expands a 2D viewer with resize, rotate, flip, undo/redo, zoom and pan; other artwork moves into a horizontal strip. Upload is hidden while editing. Shape edits save a new immutable version; existing designs keep their pinned artwork. No path/node editing or automatic updates to saved designs. |
| – | F-ART-12 | Select and prepare SVG artwork | — | **Implemented; review pending.** Retain selected objects' visible portions; use a separate Repair paths mode for previewed closure and compatible joins. Selection never closes source paths. Preserve original source and a versioned recipe. The carton preview/render acceptance check remains unresolved. See [29-artwork-preparation.md](29-artwork-preparation.md). |
| [x] | F-ART-13 | Archive artwork and lock affected designs | P1 | Organisation-wide reversible archive; active/archived gallery, retained assets, amber view-only banner and server-enforced edit/render restrictions across all pinned versions. Archive/restore and read-only workflows are implemented and verified locally. See [34-artwork-archive.md](34-artwork-archive.md). |

## D. 2D Face Placement (`F-PLACE-*`) — v1 headline workflow

The primary way artwork is positioned: a flat, orthographic view of the actual part face, with
precise snapping that is trivially overridden. Works for any zone type on any pack.

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-PLACE-01 | Face view | P0 | Orthographic camera locked to the zone's normal renders the real part silhouette + zone outline as the 2D backdrop. Scale is exact: on-screen px ↔ mm is a fixed ratio. |
| [x] | F-PLACE-02 | Zone selection | P0 | Pick a face/zone in 3D or from a list → the 2D view frames it. Packs may declare several zones. |
| [x] | F-PLACE-03 | Drop + auto-fit | P0 | Dropped artwork lands centered, contained inside the zone's safe area at a sensible default size. |
| [x] | F-PLACE-04 | Drag translate | P0 | Pointer drag with live mm readout of offset from zone center and clearance to zone edges. |
| [x] | F-PLACE-05 | Snapping to center & middle lines | P0 | Snap targets: zone center (X and Y), zone middle lines, safe-margin edges, zone bbox edges, and other placements' centers/edges. Highlighted guides appear only while active. |
| [x] | F-PLACE-06 | Snap override | P0 | Hold `Alt` (or drag past a break threshold) to move freely; a global snap toggle persists per user. Snapping never blocks a deliberate position. |
| [x] | F-PLACE-07 | Scale | P0 | Corner handles scale proportionally, edge handles stretch with modifier, plus numeric width/height in mm with an aspect lock; **Fit**, **Fill**, and **Reset 100%** actions. |
| [x] | F-PLACE-08 | Rotate | P0 | Rotation handle with 15° snapping (`Shift` for free rotation) and numeric degrees. |
| [x] | F-PLACE-09 | Keyboard nudge | P0 | Arrow keys move 0.5 mm, `Shift`+arrow 0.1 mm; `Tab` cycles numeric fields. |
| [x] | F-PLACE-10 | Alignment actions | P0 | Center horizontally/vertically, align to zone edges, reset transform. |
| [x] | F-PLACE-11 | Rulers, guides, grid | P0 | mm rulers, draggable custom guides (snap targets too), optional grid, zoom/pan of the 2D canvas. |
| [x] | F-PLACE-12 | Live 3D sync | P0 | Split view; edits in 2D update 3D within one frame and vice versa — one transform state, two views. |
| [x] | F-PLACE-13 | Curvature awareness | P0 | For curved zones the 2D view is the unrolled surface; a warning appears when wrap angle exceeds a legibility threshold. |
| [x] | F-PLACE-14 | Clearance & safe-area enforcement | P0 | Artwork clamps at the zone boundary; violating the safe margin is possible but flagged. |
| – | F-PLACE-17 | Face view shows the real surface | P1 | The flattening pass of [15-placement-math.md](15-placement-math.md) §3: render the actual mesh into zone space behind the artwork, shaded by the local distortion metric, instead of the flat gradient `face-view-canvas.tsx` draws today. Cosmetic on a flat or cylindrical zone; on a doubly curved one it is the difference between placing artwork and guessing. [26-curved-relief.md](26-curved-relief.md) §6. |
| – | F-PLACE-15 | Multiple placements | P1 | Several artworks per zone with layer list, z-order, distribute/align between them. |
| – | F-PLACE-16 | Placement templates | P2 | Save a placement (position/scale/finish) and apply it to another product/pack. |

## E. Design Editor (`F-EDIT-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-EDIT-01 | Real-time 3D viewport | P0 | Orbit/pan/zoom, damped controls, adaptive quality while interacting. |
| [x] | F-EDIT-02 | Progressive model load | P0 | LOD0 GLB streams first; skeleton + progress; no blank canvas > 1 s. |
| [x] | F-EDIT-03 | Finish selection | P0 | Emboss / deboss / printed; params: depth (mm), bevel/draft angle, edge radius, ink material. |
| [x] | F-EDIT-04 | Live emboss preview | P0 | Height/normal shading from the artwork SDF that matches the path-traced result within the parity budget. |
| [x] | F-EDIT-05 | Undo/redo | P0 | Command-stack history for every design mutation; keyboard shortcuts. |
| [x] | F-EDIT-06 | Autosave + explicit save | P0 | Debounced autosave with save-state indicator; version bump per save. |
| [x] | F-EDIT-07 | Validation strip | P0 | Non-blocking manufacturability warnings surfaced in-editor and repeated at render time. |
| – | F-EDIT-08 | Multi-zone editing | P1 | Switch zones without losing state; per-zone placements. |
| – | F-EDIT-09 | Measurement/inspection overlay | P1 | Artwork size, edge clearance, achieved depth in mm. |
| [x] | F-EDIT-11 | Cross-section view | P1 | Cut the product on a named plane in the Look viewport, so wall thickness, relief depth and how a mark sits in the surface can be seen rather than inferred. **No plane is picked by hand:** the cuts are derived from what the part already declares — its axis of revolution, its decoration zones, its bounding box — because this is not a CAD program and "select a datum" is the interaction it exists to avoid. The shell is capped with a stencil pass, so a section reads as solid material rather than as a hole through the back wall. Preview only (see `F-EDIT-13`), and it is view state rather than part of the design document. |
| – | F-EDIT-12 | Wall thickness readout | P2 | With a cross-section open, report the material thickness at the cursor in millimetres. **Backlogged by decision** — the measurement itself is a ray cast through the capped section, but a number a packaging engineer will quote to a moulder needs to say what it measured and where, and that is an interface question rather than a geometry one. Depends on `F-EDIT-11`. |
| – | F-EDIT-13 | Cross-section in renders | P2 | Carry the cut into Cycles so a section can be rendered, not only previewed. **Backlogged by decision** — clipping in the viewport is a shader-side plane, while a render needs real geometry (a boolean), which also brings it inside the parity harness. `crossSectionPlanes` already returns a serialisable plane for exactly this reason; the work is a `crossSection` field on the design document, a boolean modifier in `scene.ts`, and a parity case. Depends on `F-EDIT-11`. |
| – | F-EDIT-10 | Design comparison (A/B) | P2 | Side-by-side of two versions/variants. |

## F. Materials, Colors & Finishes (`F-MAT-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-MAT-01 | Part material assignment | P0 | Curated library per material slot declared by the pack. |
| [x] | F-MAT-02 | Color selection | P0 | Hex/HSL picker + curated palette; named swatches labeled approximate. |
| [x] | F-MAT-03 | Finish selection | P0 | The current library offers only Matte and Glossy. Glossy uses the former pearlescent shading. Obsolete assignments in stored designs and catalog defaults are replaced with Matte; prior pearl assignments become Glossy. |
| [x] | F-MAT-04 | Textured/patterned materials | P0 | Tiled PBR sets (knurl, kraft, linen) with scale/rotation controls. |
| [x] | F-MAT-05 | Independent artwork finish | P0 | Emboss/deboss offers Same as cap, Matte, or Glossy. Independent relief finishes retain the underlying part color and resolve roughness in shared `inkShading` for the preview and Cycles. Printed artwork retains a color control. |
| – | F-MAT-06 | Transparent/translucent materials | P1 | Transmission, IOR, tint, roughness — prerequisite for bottles. |
| – | F-MAT-07 | Custom material request | P2 | Org uploads a texture set for staff review and publication. |
| [x] | F-MAT-08 | Pack material presets | P0 | Curated Matte and Glossy presets, shared by fixture packs and new CAD drafts. Additional presets are not offered. |

| – | F-MAT-09 | Remove the liner slot | P2 | Take the closure liner out of the product entirely: the `liner` material slot in every pack manifest, its assignment in stored design documents, and the parts of the drafter and the CAD conformance suite that expect a two-slot closure (`draft.test.ts`, `occt.integration.test.ts`). **Backlogged by standing decision** — a liner is the sealing wad inside a cap: a real part, but not one a customer specifies and not one any mesh this product ships can show, since the fixture cap is a single body and a real closure reveals its liner only on a cutaway. Nothing new is built on it in the meantime, and its colour control is already gone from the editor. Removal is deferred rather than done because the slot is referenced by stored documents and by fixtures a migration has to move together. |

## G. Scene, Camera & Environment (`F-SCENE-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-SCENE-01 | Curated studio environments | P0 | Shipped HDRIs (softbox, three-point, gradient sweep) shared by preview + render. |
| [x] | F-SCENE-02 | Camera presets | P0 | Front / three-quarter / top / macro-on-zone; framing computed from bounding box, so packs get them free. |
| [x] | F-SCENE-03 | Free camera with bounds | P0 | Orbit within limits; focal length control; save camera to design. |
| [x] | F-SCENE-04 | Background options | P0 | Studio sweep, solid color, transparent (alpha). |
| – | F-SCENE-05 | Ground/shadow control | P1 | Contact shadow strength, reflection amount. |
| – | F-SCENE-06 | Depth of field | P1 | Focus target + aperture; approximate in preview, exact in render. |
| – | F-SCENE-07 | Lifestyle backplates & custom HDRIs | **P2** | Photographic backdrops with matched lighting; org-uploaded environments. *(moved to v3)* |
| – | F-SCENE-08 | Confirmed product orientation | P1 | Guided Import → Orientation → Decoration zones → Review setup implemented for staff drafts and design overrides. Shared source-space camera/light resolution preserves legacy views and physical geometry. Legacy regression decisions and actual-part lighting aesthetics await review; see [specification](33-product-orientation.md). |

## H. Preview Rendering (`F-PREV-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-PREV-01 | PBR real-time preview | P0 | IBL + tone mapping matched to the offline renderer's view transform. |
| [x] | F-PREV-02 | Emboss/deboss shading | P0 | Normal shading from the artwork SDF with mm-correct depth response. Superseded as the primary path by `F-PREV-06`, and still the fallback where a zone cannot produce a patch. |
| [x] | F-PREV-03 | Quality auto-tuning | P0 | Device capability detection; resolution scale and effects tuned to hold the frame budget. |
| [x] | F-PREV-06 | Displaced relief geometry | P0 | The zone carries a real subdivided surface that the height field displaces, so an emboss has a silhouette, parallax and occlusion instead of shading alone. Blank overlay pixels leave the original substrate visible; shallow relief and section counters share the neutral-code boundary. Client-derived from the zone — no pack change. [24-displaced-preview.md](24-displaced-preview.md). |
| [x] | F-PREV-07 | Height-field ambient occlusion | P1 | Horizon-estimated occlusion in zone space, applied to indirect light. The contact darkening the path tracer gets from real displacement; first thing the quality ladder drops. |
| ✓ | F-PREV-08 | Artwork surface targeting and consistent inspection | P0 | Implemented; visual review pending. Explicit per-zone material target, shared legacy drawable-part resolution, empty-mesh GLB compatibility, bright Detail lighting shared by initial setup/reorientation, and always-visible Design lighting / Inspection controls. Designs open in Viewer with Inspection lighting at 0°; Place / Split / Viewer buttons are spaced individually. Source CAD and physical artwork/depth remain unchanged. See docs/33-product-orientation.md for local verification and the separate legacy studio parity limitation. |
| [x] | F-PREV-04 | Viewer snapshot | P1 | Toolbar **Snapshot** downloads the current 3D canvas as a PNG at viewer resolution without saving or queuing a render. Available in Viewer/Split, including demo and view-only designs. Exact viewer imagery with no added watermark. [Plan and verification](37-viewer-snapshot.md). |
| – | F-PREV-05 | In-browser progressive path trace | P2 | "Better preview" tier between raster preview and server render. |
| ✓ | F-PREV-09 | Placement color matching | P1 | Sample an undecorated material swatch with the Viewer studio, material mapping and AgX transform. Use its representative color instead of the placement gradient; update for material/color, zone and lighting changes. Preserve placement interactions and saved design/render data. Curved highlights and texture patterns remain a Viewer concern. |

## I. Photorealistic Render Export (`F-REND-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-REND-01 | Submit render job | P0 | From a design snapshot: quality, resolution, camera(s), format, background. |
| [x] | F-REND-02 | Quality presets | P0 | Draft / Standard / Final → samples, denoiser, displacement subdivision. |
| [x] | F-REND-03 | Queue with progress | P0 | Status, %, ETA, cancel; survives page reload. |
| [x] | F-REND-04 | Geometry-accurate emboss | P0 | True displacement from the artwork height map with bevel/draft, not just bump. |
| [x] | F-REND-05 | Output formats | P0 | PNG (8/16-bit), JPEG, WebP; alpha option; sRGB color management. |
| [x] | F-REND-06 | Resolutions | P0 | 1K / 2K / 4K presets + custom within quota. |
| [x] | F-REND-07 | Render gallery & history | P0 | Per-design and per-org, thumbnails, download, delete, link to originating design version. |
| [x] | F-REND-15 | Render current viewer lighting | P0 | Capture the active studio and source-space lighting orientation at submission, including Inspection rotation, without changing the design. Validated immutable job input, legacy fallback, and shared light placement. [Plan](35-render-current-lighting.md). |
| [x] | F-REND-08 | Completion notifications | P0 | In-app + email for long jobs. |
| – | F-REND-09 | Multi-camera / batch renders | P1 | One submission → N images (angles, colorways, artwork variants). |
| – | F-REND-10 | Turntable demo video | **P1** | Photorealistic orbit video from a **single pre-planned camera path shared by all products** (path derived from the product bounding box). Presets: length, resolution, loop; output MP4/WebM. *(moved to v2)* |
| – | F-REND-11 | Saved render presets | P1 | Reusable output configurations per org. |
| – | F-REND-12 | Deterministic re-render | P1 | Re-run an old job at higher resolution with identical look (pinned versions + seed). |
| – | F-REND-13 | Cost/credit accounting | P1 | Per-job estimate before submit; org quota enforcement. |
| – | F-REND-14 | Render-ready email with preview | P1 | Extends `F-REND-08`: design name, product and variant, finished time, duration, dimensions, a link to the gallery, and an inline preview built at send time from the existing web-sized output and never stored. Sends on every completion — `EMAIL_AFTER_SECONDS` goes — which makes `users.notify_email` the pressure valve, so this also puts that setting on the account page. Requires `F-PLAT-09`. **Scoped:** [28-enterprise-access.md](28-enterprise-access.md). |

## J. Projects & Collaboration (`F-PROJ-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-PROJ-01 | Design CRUD | P0 | Create, rename, duplicate, delete (soft delete + restore window). |
| [x] | F-PROJ-02 | Dashboard | P0 | Recent designs with viewer screenshots, last modified, owner. Back to designs waits for pending saves and refreshes the thumbnail from the current 3D view, including Inspection lighting. Mutable thumbnail caching is disabled; capture failure retains the last thumbnail and allows navigation. |
| – | F-PROJ-03 | Design versioning | P1 | Named snapshots, restore previous. |
| – | F-PROJ-04 | Share link (view-only) | P1 | Tokenized, expiring, optional password; no edit, no source assets. |
| – | F-PROJ-05 | Comments & approval | P2 | Threaded comments pinned to a render or a 3D point. |
| – | F-PROJ-06 | Folders/tags | P2 | Organization for high-volume users. |

## K. Downloads & Exports (`F-EXP-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-EXP-01 | Download render | P0 | Short-lived signed URL; original + web-sized variants. |
| – | F-EXP-02 | PDF spec sheet | **P1** | Artwork dimensions, placement offsets from zone datum, depth/bevel, materials, product/variant IDs, preview image — supplier-ready. Layout is generic across packs. *(moved to v2)* |
| – | F-EXP-03 | Export 3D (GLB) for viewer use | P2 | Decimated/watermarked; org-gated, off by default. |
| – | F-EXP-04 | Export modified CAD (STEP) | P2 | True embossed solid for tooling — separate OCCT pipeline. **Backlogged with a scope:** [23-cad-ingestion.md](23-cad-ingestion.md) — a kernel boolean against the original B-rep, not a mesh operation, and its own piece of work rather than part of "exports". |

## L. Genericity & Extensibility (`F-GEN-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-GEN-01 | Product Pack format | P0 | Versioned manifest + assets defining products, variants, zones, materials, presets. Schema-validated; a pack is the only way to add a product. |
| [x] | F-GEN-02 | Pack ingestion & publishing tools | P0 | Admin UI + CLI: STEP → mesh/LOD/UV → zones → QA → pack → publish. Both ends are in: `/admin/cad` takes a STEP file to a draft pack through the queue, `/admin/packs` and `pnpm import:pack` take a built pack to a published one, and the zone authoring step joins them. The importer is OCCT (`@pr/cad-occt`), with a kernel-free reference importer standing in where none is installed. **A published version is never rewritten:** importing different contents under a published or deprecated `key@version` is refused with the reason (the upload preview says so first); a draft is simply replaced. `pnpm import:pack --replace` overrides deliberately, and even then a zone that a design places artwork in cannot be dropped. |
| – | F-GEN-03 | ~~Automatic zone candidate detection~~ | — | **Dropped, not deferred.** Proposing where a zone goes from the part's shape is unreliable — ribs, hinges, an off-centre measured size or a part modelled upside down all produce confident wrong answers — and a plausible wrong guess gets accepted without being read. Zones are placed by a person (`F-ADM-13`, `F-ADM-14`). The ID is kept so it is not reused. |
| [x] | F-GEN-04 | Renderer adapter interface | P0 | `RenderBackend` contract; Cycles is the default implementation, others pluggable. |
| – | F-GEN-05 | Infrastructure adapters | P1 | Storage, queue, email, and GPU-execution behind interfaces for self-hosting. |
| – | F-GEN-06 | White-label theming | P2 | Logo, palette, domain, email branding per deployment/org. |
| – | F-GEN-07 | Public/headless API + API keys | P2 | Create designs, submit renders, fetch outputs programmatically. |
| – | F-GEN-08 | Self-host distribution | P2 | **Readiness spec drafted; implementation/release review pending.** Independent copies of the complete application using the existing single-server deployment; own organizations, people, products and assets. [36-self-host-readiness.md](36-self-host-readiness.md) defines setup, isolation, CAD, upgrade, recovery and release gates. SDKs and embedding are deferred. Distributed as source under the MIT licence. |
| [x] | F-GEN-09 | Two-pack conformance suite | P0 | CI runs the full workflow test suite against two dissimilar packs (cap + box fixture). A feature that only works on one pack fails CI. |
| – | F-GEN-10 | Embeddable customizer widget | P2 | iframe/web-component embed for a customer's own storefront. |
| – | F-GEN-11 | Reproducible tessellation | **P1 (proposed)** | Ingesting the same source twice produces byte-identical meshes, checked in CI. Render dedupe is keyed on the mesh digest and the parity budget is measured against a specific mesh, so a tessellator that varies between machines silently invalidates both. Cheap now, expensive to retrofit. See [23](23-cad-ingestion.md). |
| – | F-GEN-12 | Golden CAD corpus | **P1 (proposed)** | A dozen real source files with known-good outputs, run in CI. The regression suite for a tessellator is a set of files, not a set of assertions. See [23](23-cad-ingestion.md). |
| – | F-GEN-13 | Installation name and logo | P2 | Staff set the application name and upload a logo in Admin, replacing the hardcoded "3D Product Renderer" in the page title, navigation wordmark, icon and email subjects and bodies. The logo is stored through the existing object storage and an uploaded SVG passes the existing sanitizer, since an SVG can carry script. CSS themes are unchanged. The narrow, per-installation first step of `F-GEN-06`. |
| – | F-GEN-14 | Public repository go-live | P2 | Repository settings for public development: turn on secret scanning with push protection and private vulnerability reporting; protect `main` (pull requests and passing CI required, merge commits only, head branches deleted automatically); require approval before Actions runs for first-time contributors from forks. |

## M. Admin & Content Ops (`F-ADM-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-ADM-01 | CAD ingestion pipeline | P0 | STEP upload → tessellation, UV check, LOD generation, thumbnails; preview before publish. Built: `/admin/cad` sniffs the file by content, refuses an unsupported protocol in milliseconds, queues it to `cad_jobs`, and `apps/worker-cad` tessellates per-LOD, re-validates everything the importer returns, and stages the meshes. Drafting a pack from the result creates it as a *draft*, with the measured dimensions shown and the zones left for the authoring step; a part that comes back as an open shell rather than a closed solid raises a `not_watertight` todo rather than a refusal, because an open part is legitimate for a sleeve or a label and a defect for anything moulded and only the supplier's drawing settles which. **Open:** authored decoration UVs (OCCT returns each face's own surface parameters, which is not a decoration atlas — see decision 1); Catalog thumbnails are captured after camera review under `F-CAT-08`. **Scoped:** [23-cad-ingestion.md](23-cad-ingestion.md). |
| [x] | F-ADM-02 | Zone authoring | P0 | Adjust a zone's size, margin, depth limits and finishes; visual verification with a test pattern. Adding, placing and removing zones is `F-ADM-13`; until that landed, a pack made from an upload could not be given a zone without editing its manifest. |
| [x] | F-ADM-03 | Catalog publishing | P0 | Draft → published; per-org visibility; deprecation; pack versioning. Publishing a version retires the pack's other published version to deprecated in the same transaction, so the catalog offers one version of a pack at a time; designs made on a retired version keep opening, saving and rendering against it (they resolve their exact `packVersion`, and tenants may read deprecated packs — migration 0009). Publish asks first, naming the version it retires. |
| [x] | F-ADM-04 | Material library management | P0 | Create/edit materials, upload texture sets, preview on a reference object. |
| – | F-ADM-05 | Environment management | P1 | Upload/calibrate HDRIs so preview and render match. |
| [x] | F-ADM-06 | User & org administration | P0 | Invite, resend, revoke, suspend, delete users; set org quotas. Deleting keeps the person's work (every reference to them is `on delete set null`); until migration `0010` it failed for anyone who had saved a design. Every access change — role, suspend, restore, delete, revoke — asks first in a modal that lists what it will do (`F-UI-07`). Nobody changes their own role or suspends themselves (server-enforced, like self-deletion): a staff member who made themselves an organisation's owner from the role select would, in one role column, stop being staff and lose the console mid-session. |
| [x] | F-ADM-07 | Render queue operations | P0 | All jobs view, retry, cancel, worker logs. Each job keeps its worker's own log lines (claimed, each stage, warnings, errors, outcome; newest 200) behind a **Log** button on the queue and CAD pages. Workers register and report in every 10 s, so the Workers panel lists idle ones too and marks a silent one stale after 30 s; a running job whose worker has gone quiet or whose lease has lapsed is flagged **stuck** at once. Cancel asks first; Retry is offered, and accepted by the API, only for failed or cancelled jobs. |
| – | F-ADM-08 | Feature flags | P1 | Per-org gating. |
| – | F-ADM-09 | Usage analytics | P1 | Renders per design/user, failure reasons, GPU minutes, cost. |
| – | F-ADM-10 | Assembly → material slots | **P1 (proposed)** | A STEP assembly already names its parts; map them onto the material slots a pack declares. Free at ingestion, tedious by hand. See [23](23-cad-ingestion.md). |
| – | F-ADM-11 | Manufacturability analysis | **P1 (proposed)** | Draft angle, undercut and wall thickness at ingestion. A supplier who learns at ingestion that a zone has no draft is better served than one who learns it from a tool trial. See [23](23-cad-ingestion.md). |
| – | F-ADM-12 | Customer-uploaded CAD | **P2 (proposed)** | Turns the most dangerous parser in the system into an endpoint any account can reach. Its own project with its own review — see the security section of [23](23-cad-ingestion.md). |
| [x] | F-ADM-13 | Add, place and remove zones | P0 | The Zones page lists every variant, including one with no zones, and adds a zone with Flat surface or Follow surface mapping to it (`F-ADM-18`). Existing cylindrical zones remain compatible. **Nothing is suggested**: a new zone's placement starts empty and cannot be saved empty; one-click axis directions, "face the other way", "rotate artwork 90°" and "turn artwork upside down" cover the common fixes. A live 3D preview names every zone on the part (click a name to edit it), draws its outline and safe area, and lays **the test pattern** on the active zone with an arrow for its facing — so rotation, upside-down and mirroring are visible on a draft, before publishing; view buttons look along ±X/±Y/±Z. The zone is measured against the mesh — centre, four corners, and facing against the surface — and the form says when it is off the part, hangs over an edge, or faces into it. A half-filled zone shows its centre as soon as that is known. Forms mark unsaved changes and leaving the page asks first. Add, move and remove are draft-only; a published pack opens its existing draft version, or makes one (next minor, zones, meshes and visibility copied) — one draft at a time. A zone a design places artwork in can be neither moved nor removed, even on a draft. Names are unique per variant; keys come from the name and never change. **Overlapping zones are allowed by decision** — alternative positions for one face ("small logo", "large logo") are a legitimate pack design. The full test-pattern check in the customer editor still needs a published pack. |
| [x] | F-ADM-14 | Place a zone by clicking the part | P1 | "Place by clicking the part": a flat or curved face takes the clicked point as its centre and the surface there as its facing; a band keeps the axis the author entered and takes the point's height, angle and radius. "Centre from 3 rim points" / "Axis from 3 rim points": three clicks around a round edge fix a circle — a face is centred on it and takes its plane, a band takes it as its axis and radius — which is how the centre of a cap top or the axis of a skirt is found at all. Esc leaves either mode. Measurements of where the author clicked, never suggestions. |
| [x] | F-ADM-15 | System status page | P0 | `/admin/status`, staff only, refreshing every 5 s (Pause to read). One verdict (operational / degraded / outage) and a list of what needs attention; a card per service — web app, database, object storage, render workers, CAD workers, render queue, CAD queue, email — with its health in the theme's information colours and the facts behind it; every worker and whether it is alive; renders in progress across all organisations with stage and progress; the render queue in claim order; CAD ingestions in flight; the last 24 hours (throughput per hour, failure rate and reasons, median and slowest render times, organisations at or near a limit); and the server log — warnings and errors from every service, colour-coded, filterable by level and service. Reads only what the platform already records; the verdict rules are pure functions with their own tests. |
| – | F-ADM-16 | A flat zone's test pattern never sinks into the part it sits on | P2 | **Bug, not yet fixed.** On the Zones page, a flat zone placed by clicking the part can show a grey wedge cut out of one corner of its test pattern, which comes and goes as the view turns. Seen on `89-400-ribbed` 0.1.0: the click took the mesh's smoothed normal, (0.0049, 0.0038, 1) instead of (0, 0, 1) — a 0.36° tilt — and on a 50 × 50 mm zone that moves the corners about 0.2 mm, more than the pattern's 0.08 mm lift, so the low corner drops below the cap top and the surface hides it. The straight edge of the wedge is where the tilted pattern crosses the surface; the preview's `polygonOffset` is view-dependent, which is why it flickers with the angle. Only the preview is wrong: the surface check allows 1 mm and reports all four corners on the part, and a render is unaffected. Workaround: the **+Z** (and **+X**) axis buttons square the facing up. **Fix:** draw a flat zone's pattern as a grid draped onto the surface — as a band's already is — rather than one flat quad, keeping it lifted along the zone's facing so a zone that genuinely faces *into* the part still disappears (that disappearance is the existing signal for that mistake). **Optional, decide separately:** when a clicked normal lies within ~1° of a principal axis, *offer* to snap it ("Facing is 0.36° from +Z — snap to +Z?") — offered, never applied silently, because it rounds a measurement of the author's click. **Acceptance:** the tilted 50 × 50 zone above shows its whole pattern from every view angle; a zone turned to face into the part still vanishes; `zone-preview.tsx` is the only file the fix needs. |
| [x] | F-ADM-17 | Organization workspace | P0 | Header sections: Overview, People, Products, Limits, Activity. People management is scoped to the selected organization; read-only email lookup stays in the organization directory. Legacy `/admin/users` links redirect there. See [31-organization-workspace.md](31-organization-workspace.md). |
| [x] | F-ADM-18 | Surface-following Admin zones | P0 | Existing zone form gains Flat surface / Follow surface mapping, draft-only conversion and actual mesh-following pattern, boundaries and surface checks. No navigation changes; stored cylindrical zones remain compatible but are absent from new-zone choices. |

### Organisation self-service (`F-ORG-*`)

`/admin` is staff-only and answers `notFound()` to everyone else, so an organisation's owner has no
administrative surface at all — while `packages/auth/src/policy.ts` already grants owners `invite.create`,
`invite.revoke`, `member.remove` and `quota.read`. Most of this is building the surface for permissions
that already exist. Scoped in [25-org-admin.md](25-org-admin.md).

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-ORG-01 | Owner admin shell | P0 | `/org`, guarded to `owner` and `staff`; every query tenant-scoped, every page one organisation. Separate from `/admin`, which is cross-tenant by construction. |
| [x] | F-ORG-02 | Member management | P0 | Invite, resend, revoke, suspend, reinstate, change role. No delete — suspension is reversible and covers the need; `deleteUser` stays staff-only. Suspend, reinstate, role changes and revoke each ask first and say what they do (`F-UI-07`). |
| [x] | F-ORG-03 | Per-user product access | P0 | Which catalog products a member may start designs on. Deny by exception, enforced in RLS on `product_packs`, not in the UI. |
| [x] | F-ORG-04 | Organisation overview | P1 | Seats, renders against quota, storage. Read-only: quota writes stay staff-only, as the policy already says. |
| [x] | F-ORG-05 | Organisation audit trail | P1 | The existing `audit_log`, scoped to this organisation. |
| – | F-ORG-06 | Access presets | P2 | Named product bundles, so a large organisation is not one checklist per person. |

## N. Platform, Reliability & Compliance (`F-PLAT-*`)

| v1 | ID | Feature | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-PLAT-01 | Job durability | P0 | Survives worker restarts; idempotent bounded retries; poison-job quarantine. |
| [x] | F-PLAT-02 | Observability | P0 | Structured logs, traces web→queue→worker, per-stage metrics, error tracking. Error tracking is the logger's reporter seam writing warnings and errors from the web app and both workers to `service_events` (redacted, batched, bounded to 14 days / 20 000 rows), shown on the System Status page (`F-ADM-15`). Refused requests (4xx) are left out. |
| [x] | F-PLAT-03 | Rate limiting & abuse controls | P0 | Per-user/org limits on uploads, renders, auth attempts. |
| [x] | F-PLAT-04 | Asset protection | P0 | Source CAD never served to clients; signed short-lived per-user asset URLs. |
| [x] | F-PLAT-05 | Backups & restore drill | P0 | DB PITR + object versioning; restore tested each phase. |
| – | F-PLAT-06 | Data retention & deletion | P1 | Org-level export and hard delete. |
| – | F-PLAT-07 | Status/maintenance messaging | P1 | Degraded-capacity banner instead of silent queue growth. |
| – | F-PLAT-08 | Accessibility conformance | P1 | WCAG 2.2 AA for non-3D UI; keyboard-operable editor. **Backlogged (standing)** — deferred by decision, not by oversight, and it stays there until it is explicitly picked up; no accessibility code is written in the meantime. What exists today: `prefers-reduced-motion` is respected, every slider has a typed field, the placement canvas is focusable and labelled, and `jsx-a11y` runs in CI. What the backlog item covers: the rest of the canvas keyboard model (`[`/`]` rotate, `+`/`-` scale, `1..4` cameras, `Tab` between Place and Look — only the arrow keys are wired), `aria-live` regions for job status, validation and snap events (none exist), and a focus-visible treatment beyond the one rule on auth inputs. Conformance itself needs a human audit — contrast, reflow, target sizes — and is not claimed here. |
| [x] | F-PLAT-09 | Transactional email delivery | **P0** | `@pr/mail`: one `Mailer` interface (it had been declared twice), a template registry rendering subject/HTML/text for `invite`, `password-reset`, `render-ready` and `render-failed`, and a Resend transport over `fetch` with no SDK. Selected by `RESEND_API_KEY` + `MAIL_FROM`; unset means a logging no-op, never a throw — the throwing development mailer is what had turned password reset into an enumeration oracle in production. Every real transport refuses reserved recipient domains (`example.com`, `.test`, `.invalid`, …), so no test run, script or future caller can send the suite's addresses to the provider; `scripts/e2e.sh` also unsets the mail variables for everything it starts. **Not yet observed end to end:** the transport is tested against a stubbed `fetch`, and the first real delivery has to come from an environment that can reach `api.resend.com`. **Scoped:** [28-enterprise-access.md](28-enterprise-access.md). `Mailer.send` reports what happened — `{ delivered: true }`, or `false` with the reason (`no_provider`, `reserved_recipient`, `captured` in the development mailbox, `failed`) — so an invitation form says "emailed" only when it was. |

## O. Local Deployment & Operability (`F-DEPLOY-*`) — v1.1

What stands between "the code is complete" and "somebody else can run it". **Done.** The README now
covers the CAD pipeline, every variable the code reads is documented and a CI check keeps it that
way, `.env.example` exists, `pnpm start:web` serves the built app, macOS is a supported platform
with its one real caveat stated, and `scripts/deploy-local.sh` takes a clean clone to a sign-in link
in one command.

No product behaviour changed: documentation, one shell script, two npm scripts and a template.

| Done | ID | Item | Pri | Description / acceptance |
|---|---|---|---|---|
| [x] | F-DEPLOY-01 | README: the CAD pipeline | P0 | A section covering: install Python 3.11 and `pip install cadquery-ocp==7.9.3.1.1`; run `pnpm worker:cad` alongside `pnpm worker:render`; and the walkthrough — upload a STEP file at `/admin/cad`, watch the job, draft a pack from the result, author zones, publish. Must state plainly that **without OCCT the worker silently falls back to the reference importer**, which produces parametric cylinders rather than the supplier's geometry: a fallback that looks like success is the failure mode worth a sentence. **Acceptance:** somebody following it from a clean clone gets a STEP file to a draft pack in the catalog. |
| [x] | F-DEPLOY-02 | Environment reference is complete | P0 | The env table is missing ten variables the code reads: `CAD_IMPORTER`, `CAD_PYTHON`, `CAD_SANDBOX`, `CAD_SCRATCH`, `CAD_THREADS`, `CAD_TIMEOUT_SEC`, `CAD_MAX_SOURCE_BYTES`, `CAD_PIPELINE_VERSION`, `CAD_UNSHARE`, `CAD_PRLIMIT`. Each needs a default and a one-line "what it does", in the existing table's style. **Acceptance:** a check — a test or a lint script — asserts that every `process.env[...]` key read anywhere in `packages/` and `apps/` appears in the table, so the next variable added cannot go undocumented. That check is the deliverable as much as the rows are. |
| [x] | F-DEPLOY-03 | `.env.example` | P0 | 26 variables and nothing to copy. An annotated example with safe local defaults, every secret left blank with a comment on how to generate it (`ASSET_URL_SECRET` in particular — unset means a new one per process, which is right for one machine and wrong for two). Grouped: required, storage, render, CAD, development-only. Must be listed in `.gitignore` guidance so nobody commits a filled-in `.env`. |
| [x] | F-DEPLOY-04 | A production start path | P0 | The README documents `pnpm --filter @pr/web dev`. There is `build:web` and no `start:web`. Add the script, and a short note on what differs in a built app — chiefly that the CSP nonce middleware only stamps dynamically rendered pages, which is why `/` and `/design/demo` carry `export const dynamic = 'force-dynamic'`. **Acceptance:** `pnpm build:web && pnpm start:web` serves a working instance, and the note says why `dev` is not what you deploy. |
| [x] | F-DEPLOY-05 | macOS is supported and says so | P0 | The requirements table assumes Debian. macOS needs: Homebrew PostgreSQL with `PG_BIN` pointed at it (already noted, easy to miss), `BLENDER_PATH` pointed inside `Blender.app/Contents/MacOS/Blender`, and `cadquery-ocp` — which does publish an Apple Silicon wheel for the pinned version, so CAD ingestion works. **The one real difference: the parser sandbox is Linux-only.** `unshare` and `prlimit` are util-linux, so on macOS `probeSandbox` fails and the default `CAD_SANDBOX=prefer` warns and parses unconfined. That is defensible for a laptop reading your own files and unacceptable on a server, and the docs should say so in those words rather than leaving it to a log line. See `F-HARD-01` and `deploy/cad-worker/README.md`. |
| [x] | F-DEPLOY-06 | `scripts/deploy-local.sh` | P1 | One idempotent script for the whole sequence: start the database, migrate, import both fixture packs only when `--samples` is passed (a fresh install has an empty catalog), seed an organisation and print the invitation link, then say what to run next. Re-running it must not duplicate anything. A `--check` flag reports what is installed and what each missing piece disables — Postgres, Blender, OCCT, Chromium are all independently optional, and today the only way to find out is to hit the feature that needs one. **Acceptance:** clean clone to signed-in instance in one command; the README's numbered steps and this script cannot drift, because the steps become "run this, or do it by hand as below". |

## S. Deploying to one server (`F-SHIP-*`) — v1.1

Section O got a clean clone to a sign-in link on a laptop. This is the same distance again for a
machine nobody is sitting at: images, a compose file, TLS, and the handful of settings whose default
is right on a laptop and wrong on a server.

Scoped to **one droplet**, deliberately. The thing that makes more than one impossible today is
object storage: `packages/storage` has a local-filesystem adapter and nothing else, so every process
that reads an asset has to share a disk with the one that wrote it. That is a real ceiling and it is
named here rather than discovered later (`F-SHIP-06`).

| Status | ID | Item | Priority | Notes |
| --- | --- | --- | --- | --- |
| [x] | F-SHIP-01 | An image for the web app | P0 | Multi-stage, Node 22, pnpm via corepack. Workspace packages are consumed as TypeScript source (`transpilePackages`), so the build stage needs the whole workspace, not just `apps/web`. |
| [x] | F-SHIP-02 | An image for the render worker | P0 | Node 22 plus Blender and `python3-numpy` — Blender's glTF importer needs numpy, and without it every render fails at mesh import rather than at start-up, which is the slow way to find out. The runtime base is Ubuntu 24.04, not the Node image's Debian: the parity budgets are calibrated against Ubuntu's Blender 4.0.2, and bookworm's 3.x predates the AgX view transform `docs/16` pins the preview to. The series is asserted at build time. |
| [x] | F-SHIP-03 | One compose file | P0 | web, render worker, PostgreSQL and Caddy; the CAD worker behind a `cad` profile so it is off unless asked for. Migrations run once, before the web app starts. |
| [x] | F-SHIP-04 | TLS that renews itself | P0 | Caddy, automatic Let's Encrypt. Not a nicety: the session cookie is `__Host-` prefixed, so it requires `Secure` and nobody can sign in over plain http off localhost. |
| [x] | F-SHIP-05 | `/api/health` | P0 | What compose restarts on and what a deploy checks. Reports the database and the object store, because a web process that is up and cannot reach either is not serving anybody. |
| [x] | F-SHIP-06 | A production environment template | P0 | `deploy/.env.production.example`. Every secret blank with the command to generate it, and the settings whose laptop default is wrong on a server — `CAD_SANDBOX=require`, an absolute `STORAGE_ROOT`, `ASSET_URL_SECRET` — called out rather than listed. |
| [x] | F-SHIP-07 | The runbook | P0 | [27-deployment.md](27-deployment.md): droplet sizing, first boot, upgrades, backups, and what to look at when it is broken. |
| – | F-SHIP-08 | An S3 adapter | P1 | The single-node ceiling. `packages/storage` is local-filesystem only, so web and the render worker must share a volume and there can only be one of each. An adapter for Spaces removes both limits; nothing above the `Storage` interface changes. |
| – | F-SHIP-09 | Renders on a GPU | P2 | A droplet has no GPU, so Cycles runs on CPU and a render takes minutes rather than seconds. Fine for a pilot, not for a queue with people waiting on it. |
| [x] | F-SHIP-10 | CI builds and boots the images | P0 | An `images` job that builds through the compose file, brings the stack to a healthy `/api/health`, asserts the application role is not a superuser, and checks the render worker stays up. Every other job tests the code; nothing tested the thing that ships it, so a broken Dockerfile surfaced at deploy time. It found three on its first pass: a Blender series the budgets do not match, an entrypoint that resolves pnpm over the network, and a `migrate` one-shot whose script was never copied into the image — which, because `web` waits on it, meant nothing started at all. |
| [ ] | F-SHIP-11 | A production setup command | P0 | **First work after the initial release** ([38](38-first-work-after-release.md), step 1). Creates the operator's named organisation and administrator from the built web container, safe to run again, printing the invitation only to the terminal. Until then the first account comes from `scripts/seed-dev.ts`, which always names the organisation "Demo Organisation". |
| [ ] | F-SHIP-12 | Email in the Compose deployment | P0 | **First work after the initial release** ([38](38-first-work-after-release.md), step 1). Compose passes `RESEND_API_KEY`, `MAIL_FROM` and `MAIL_REPLY_TO` to every service as of the release, which matters because the console never shows invitation links outside development. Still to do: half-set mail settings stop start-up with a clear message, and delivery is seen working on a real server (`F-SHIP-13`). |
| [ ] | F-SHIP-13 | Clean-server run-through | P0 | **First work after the initial release** ([38](38-first-work-after-release.md), step 2). Install from the quickstart on a fresh Ubuntu 24.04 server, then: real email, the whole product workflow, two organisations, worker interruption, and a timed backup and restore. Every departure from the documents is fixed in the documents and the run repeated. |

## T. Navigation & Design System (`F-NAV-*`, `F-UI-*`) — v1.2

The application had no navigation. `app/layout.tsx` rendered `<body>{children}</body>`, and each
page grew whatever header its author needed, so the link sets disagreed: `/designs` offered Catalog
and Renders, `/catalog` offered Designs and Account, `/renders` offered neither Account nor Catalog.
Two areas were effectively unreachable — `/org` had exactly one inbound link in the entire codebase,
on `/account`, and the editor had none at all.

The information architecture in [03-gui.md](03-gui.md) had described the intended shape since
before there was an application to put it in, and [19-frontend.md](19-frontend.md) had described an
`(app)/` route group holding the shell. Neither was built. This section builds both, and adopts a
supplied reference design system as the token layer [03-gui.md](03-gui.md) has asked
for since it was written: "component library with tokens (color, spacing, radius, elevation) shared
by app and admin".

The original F-UI-01…07 notes below record that delivery. **F-UI-08 supersedes its visual rules**
with the current Wrap guide, compact full-width header and shared editor navigation.

| Done | ID | Feature | Priority | Notes |
|---|---|---|---|---|
| [x] | F-NAV-01 | One global navigation | P0 | The nav pill on every signed-in page, mounted once by the `(app)` route group rather than repeated per page. Primary links are Designs / Artwork / Catalog / Renders; the account menu carries Account, Organization (owner and staff) and Admin (staff). Closes the two dead ends: `/org` is now one menu away from anywhere instead of three pages deep behind `/account`, and the editor's brand mark is a link rather than a `<span>`. |
| [x] | F-NAV-02 | Staff console sections | P0 | Six flat tabs become a grouped left sidebar: Tenants (Organizations, with organization-scoped header sections under `F-ADM-17`), Content (Packs, CAD, Materials), Operations (Status, Queue). A sidebar rather than a second bar because `DESIGN.md` requires the pill "never duplicates into a secondary bar" — and because a column has room for the hint that says whether to reach for Packs or CAD. |
| [x] | F-NAV-03 | Organisation sections | P0 | The same `SectionNav` component, four links, no grouping. Replaces the second copy of the tab list that had already drifted from the first. |
| [x] | F-UI-01 | Design tokens | P0 | A palette and type scale installed as the root token layer, with the application's existing semantic names (`--bg`, `--panel`, `--line`) repointed at them. The stylesheet was already tokenised — 243 `var()` call sites against 19 hardcoded colours — so the dark-to-light inversion is one edit and the call sites never learn the palette changed. Three rules are recorded in the stylesheet header: Inter as the face, surviving status colours, and a third surface for inset regions. |
| [x] | F-UI-02 | One radius, two values | P1 | `DESIGN.md`: "16px is the rule, 12px only for image tiles", and do not mix. The stylesheet had 4, 6, 8, 10, 12, 18, 999 and 9999px across 31 rules; every one now resolves to `var(--radius)`, `var(--radius-tile)` or a 9999px pill. |
| [x] | F-UI-03 | Buttons and tables on the tokens | P1 | Filled and outlined buttons share padding and radius so they sit together as a two-button row; `.cta` carries the 16/24px page-level size, and the default is the same button at console density. Tables are built from the palette: Paper White on linen, Ink Black rules at border opacity, 14px caption type, and the radius on a wrapper because `border-collapse` ignores it. |
| [x] | F-UI-05 | Selects that belong to the system | P1 | Nine `<select>` elements, seven of which had no styling at all and rendered as raw operating-system widgets. `appearance: none` and a data-URI chevron put them in the system. What CSS cannot reach is the open menu — `<option>` rendering belongs to the OS on every browser — which is the honest argument for a component library rather than a thing to fix in a stylesheet. |
| [x] | F-UI-06 | Icons from an icon library | P2 | `lucide-react`, stroked SVG at `currentColor`, which is what `DESIGN.md` asks for: "minimal stroked linework in Ink Black". Replaces the notification bell's `◍` — a Unicode circled bullet that rendered as a dark blob and belonged to whichever font loaded. Tree-shakes to nothing measurable: the shell bundle is unchanged at 56% of budget. |
| [x] | F-UI-04 | The face | P2 | **Inter**, vendored under `apps/web/public/fonts/` with its OFL licence, declared as two `@font-face` subsets so latin-ext is fetched only when a page needs it. Not a serif: a serif is a reading face for long text, in an application of 14px table cells and 11–12px editor rails. The type *scale* is kept in full; only the face beneath it changed. Vendored rather than fetched by `next/font/google` because the Next build runs inside `deploy/web/Dockerfile`, and a build-time fetch would make `docker compose up --build` depend on Google's CDN — the same shape as the corepack problem `F-SHIP-10` fixed. |
| [x] | F-UI-07 | Confirmation modal | P1 | `useConfirm()` in `components/confirm-dialog.tsx`: awaitable replacements for `window.confirm` (`confirm`) and `window.prompt` (`prompt`, a single text field) on the native `<dialog>` — Escape and the backdrop cancel; a confirmation focuses Cancel first so Enter never confirms, a prompt focuses its field and Enter submits. Rendered into `document.body` so the surrounding page's styles never leak in. Flat: Paper White on an ink scrim, hairline border, 16px radius, no shadow; the destructive button is the only hue, `--error`. Title, paragraphs, a consequences list, `default` or `danger` tone. **Every** confirmation and prompt in the app uses it: access changes, deleting designs, artwork and renders, renaming designs and artwork, publishing and deprecating packs, removing a zone, cancelling a render and requeueing failures from the queue, and leaving the Zones page with unsaved edits through an in-app link. The one native prompt left is the browser's own on reload or close with unsaved zone edits — a page cannot replace that one. |
| [x] | F-UI-08 | Wrap identity and workspace reskin | P0 | Scalable Wrap identity; unified shell, image-led Designs, compact editor and consistent admin/owner/auth surfaces. Existing workflows retained; local unit/browser suites, build checks and actual frames verified. See docs/30-workspace-reskin.md. |
| ✓ | F-UI-09 | Standard loading animation | P1 | Approved quiet ring implemented as reusable `LoadingSpinner` across placement color loading, the 3D viewer, Admin previews, SVG loading, preparation and pending actions. Keep measured progress bars and stage text. See [the loading review](design-system/LOADING-REVIEW.md). |

## P. Post-v1 Hardening & Documentation — v1.5

Security and reliability on shipped code. The CAD ingestion pipeline landed after the security
checklist in [05-security.md](05-security.md) was signed off, so none of it was reviewed under that
checklist; most of this section is the difference. Ingestion is staff-only, which is the compensating
control that keeps all of it off the critical path.

| Done | ID | Item | Description / acceptance |
|---|---|---|---|
| [x] | F-HARD-01 | Parser runs confined | Every CAD parse gets its own user, network, IPC, UTS, PID and mount namespaces, with `prlimit` ceilings applied at `exec`. No network at all — not a filtered egress. `CAD_SANDBOX=require` makes it non-optional in the container. Covered by `packages/cad-occt/src/sandbox.integration.test.ts`, and the whole OCCT conformance suite runs through it. |
| [x] | F-HARD-02 | Parser gets no credentials | The parser's environment is an allow-list, not the supervisor's. `spawn` inheriting `process.env` was handing `DATABASE_URL` to the process whose whole job is reading a stranger's file. An allow-list rather than a deny-list so the next secret added to the worker is not inherited by accident. |
| [ ] | F-HARD-03 | Parser gets no filesystem either | The mount namespace is a *copy* of the host's, so the parser can still read the application tree and the object-storage volume — where every tenant's assets live. It needs only its own scratch directory and a read-only `/usr`. A `pivot_root` step in the existing sandbox; testable the same way F-HARD-01 is. |
| [ ] | F-HARD-04 | Source CAD retention and deletion | `F-PLAT-04` covers "never served", which is done and tested. This is the other half: no deletion path exists, and `cad-source/` goes into the same backup as everything else where [23-cad-ingestion.md](23-cad-ingestion.md) asks for separate retention and a separate key. It is the customer's supplier's most valuable file. Related to `F-PLAT-06` (P1), which covers org-level export and delete generally. |
| [ ] | F-HARD-05 | Supply chain: hash-pinned deps + SBOM | The image pins `cadquery-ocp` by version; docs/23 asks for by-hash and a generated SBOM. `packages/cad-occt/THIRD-PARTY.md` records which licence obligations are met and which are not. OCCT has a CVE history and will need patching on someone else's schedule. |
| [ ] | F-HARD-06 | Worker-class routing | Reliability rather than security. `cad_jobs.profile` (`wasm`/`standard`/`heavy`) is set at upload, stored, and then ignored: `claimNext` orders by priority and age with no filter, so a 60-minute 32 GB assembly can be claimed by a worker sized for closures and fail on memory. Needs the claim to filter on the classes a worker declares. |
| [ ] | F-HARD-07 | Container image verified | The image, compose and k8s manifests in `deploy/cad-worker/` have never been built or scheduled — written where there was a Docker CLI and no daemon. Until one is built they are a reviewed specification. Expect corrections around VTK's link-time dependencies. |
| [ ] | F-HARD-08 | Re-run the security checklist | [05-security.md](05-security.md) went green before `apps/worker-cad`, `@pr/cad-occt` and the `/admin/cad` routes existed. The checklist should be re-run against the surface that exists now, and [22-pentest-brief.md](22-pentest-brief.md) updated to include CAD ingestion. Re-run for the initial release: findings and missing tests in [36 section 8](36-self-host-readiness.md#security-findings-review). The pentest brief is still to update. |
| [x] | F-HARD-09 | Secret scanning on every change | CI runs on every pull request under `pull_request`, never `pull_request_target`, so fork code gets no repository secrets. The `secrets` job runs Gitleaks and TruffleHog (verified and unknown results) over the whole history, from pinned releases whose checksums are checked before they run. GitHub secret scanning with push protection is turned on at the public cut-over (`F-GEN-14`). |
| [x] | F-HARD-10 | Security doc describes only what is built | [05-security.md](05-security.md) states staff MFA as required, Turnstile CAPTCHA after repeated failures, and one `can()` policy module "never inline in route handlers". None of those exists: MFA is `F-AUTH-09`, there is no CAPTCHA, and route guards are inline (`requireStaff`, `requireOwner`, `requireTenant`). Mark each as planned with its feature ID, or describe what is built instead. Finding S-4 in [36 section 8](36-self-host-readiness.md#security-findings-review). Done for the initial release: a table at the top of the document lists what is built against what is designed, and the four claims S-4 named are corrected in place. |
| [ ] | F-HARD-11 | Assert the app role cannot bypass row-level security | CI's `images` job checks `rolsuper` for the `product_renderer` role but not `rolbypassrls`, and either one silently switches off every tenancy policy. Add the `rolbypassrls` check to that step, and an integration test in `packages/db` that the role the suite connects as has both false, so the isolation tests cannot pass vacuously. Findings S-5 and T-4. Deploy creates the role correctly today. Deferred past the initial release by decision. |
| [ ] | F-HARD-12 | Demo and fixture routes off in production | `/design/demo` and `/api/fixtures/*` need no session. In production they fail rather than serve, because the web image has no `fixtures/` directory, and the fixtures are synthetic. Return 404 in production unless dev tooling is on (`devToolingEnabled`), keeping local development and the e2e suite (which turns dev tooling on) working; the "database not configured" page links to the demo. Finding S-6. Deferred past the initial release by decision. |
| [ ] | F-HARD-13 | Route-matrix tests | Enumerate the route tree, so a new route cannot skip the check. An owner, a member and a signed-out request each get 404 from every `/api/admin/*` route and `/admin/*` page; a member gets 404 from every `/api/org/*` route and `/org/*` page. Today `admin.spec.ts` checks only `/admin` and `/api/admin/orgs`, and `org.spec.ts` only invitations. Findings T-1 and T-2. Deferred past the initial release by decision. |
| [ ] | F-HARD-14 | Tenant context does not outlive its transaction | `withTenant`, `withStaff` and `withSystem` rely on `set_config(..., true)` being transaction-local. An integration test that takes a pooled connection after a tenant transaction ends and finds no organization set on it. Finding T-3. Deferred past the initial release by decision. |
| [ ] | F-HARD-15 | Render worker checks artwork digests | Render specs carry a placeholder artwork digest (`'0' * 64`), so the worker cannot tell that an artwork file changed under it. Harmless while storage is a local disk shared only with the application; needed before object storage. Finding S-7. |

### Documentation (`F-DOC-*`)

Twenty-two documents exist in `docs/` and every one of them is written for a developer. The closest
thing to a manual is [02-workflows.md](02-workflows.md), which is a specification — actor, trigger,
preconditions, happy path, done-when, with Mermaid diagrams and feature IDs referenced by tests.
Nobody using the product should have to read that.

| Done | ID | Item | Pri |
|---|---|---|---|
| [ ] | F-DOC-01 | User and administrator guide | P1 |
| [ ] | F-DOC-02 | Screenshots for the guide | P2 |

#### F-DOC-01 — User and administrator guide

**One guide, two audiences.** A customer designing a closure and an operator publishing a pack are
different jobs, but they are frequently the same person and always the same product, so they get one
guide with two halves rather than two documents that drift apart.

**Format.** Markdown under `docs/guide/`, named so the directory can be pushed to the repository's
GitHub Wiki unchanged: `Page-Name.md` (the hyphens become spaces in the wiki's page titles), a
`Home.md` landing page, and a `_Sidebar.md` for navigation. Links between pages are relative
(`[Placement](Placement.md)`) so they resolve both in the wiki and when browsing the repo. No Jekyll
front-matter, no build step — a copy is the export.

##### Pages, and what each must answer

*Using it*

| Page | Must answer |
|---|---|
| `Home` | What is this for, who is it for, where do I start. Three entry paths: brand new, need the vocabulary, running it for others. |
| `Getting-Started` | Why there is no sign-up button. Accepting an invitation, the password rules and *why* they are what they are, signing in, what the enumeration-safe error means, what each route in the top nav is for, and what `/design/demo` is. |
| `Core-Concepts` | Pack, product, variant, zone, design, render — in that order, because each depends on the last. Must explain *why* packs exist (no product-specific code) rather than only what they contain, since that is the fact that makes the rest of the product make sense. |
| `Your-First-Design` | One unbroken walkthrough, catalog to downloaded file. The page somebody follows on their first afternoon. |
| `Artwork` | Why SVG only — an emboss is geometry, and a JPEG has no shape. What the pipeline does to a file (sanitise, normalise, measure, derive maps). Every rejection reason and what to do about each. The library: reuse, rename, delete and why deleting is refused when a design uses it. |
| `Placement` | That the numbers are real millimetres on the real product. Dragging, arrow-key nudging and the Shift modifier, typing coordinates, snapping and the Alt override, guides and rulers, the grid, alignment actions, lock aspect, and undo's one-press-per-action behaviour. What the safe margin is. Every validation error that blocks a save, and that these come from the pack rather than the app. |
| `Materials-and-Finishes` | The two orthogonal axes — what it is made of versus how it reads — and why both exist. Slots as addressable parts. Colourways plus the free picker, and that named colours are approximate on screen. The six finish families with what each looks like. Textures and their scale. The artwork's own finish: emboss, deboss, print, and the ink-versus-foil choice. |
| `Preview-and-Cameras` | Place versus Look. Orbiting. Camera presets and taking the camera off-preset. The lens control and why focal length changes the character of a product shot. Studio environments and backgrounds. That the camera is saved with the design and is what the render uses. That preview quality adapts to the machine. |
| `Rendering` | Quality presets and what actually differs between them. Sizes and formats, and which to give a printer. The estimate before committing. That the job is queued and the tab can be closed. The bell. The gallery, what is recorded against each render, and how downloads work — short-lived links issued to one person. Deleting a render, and that deleting frees the design to be rendered again at the same settings. |
| `Designs-and-Projects` | The dashboard and its thumbnails. Autosave. Named snapshots and version history. Duplicating. Renaming. Deleting and the restore window. Switching variants mid-design and what happens to the placement. |

*Running it*

| Page | Must answer |
|---|---|
| `Accounts-and-Permissions` | The three roles — `staff`, `owner`, `member` — and precisely what each may do, as a table. What an organisation is and that data is isolated per organisation. Account states (`invited`, `active`, `suspended`). Inviting, resending, revoking, suspending. Why staff can only be created by staff, and the one CLI escape hatch. Quotas *and* rate limits as separate things: quotas answer "how much may this organisation have", rate limits answer "how fast", and a person hitting either sees a different message. |
| `Admin-Console` | Every screen under `/admin` and the task each exists for. Organisations and their limits. People. The render queue — reading it, retrying, cancelling, and what a quarantined job means. The material library, including editing a material and seeing it on a reference object. The audit trail. |
| `Product-Packs` | What a pack is on disk. Importing one, the dry-run inspection before anything is written, and why importing and publishing are separate presses. Publishing, restricting visibility to named organisations, and deprecating — including that deprecating does not break designs already made against it. Zone authoring and the test-pattern QA step. Pack versioning and immutability. |
| `CAD-Ingestion` | That it is staff-only and why. The whole path: upload, content-based format detection, the queue, tessellation, validation, drafting a pack, authoring zones, publishing. What the measured dimensions tell you and why checking them first matters. Which importer is running and how to tell — including that without OCCT the fallback produces parametric cylinders and *looks like success*. What is stored, where, and for how long. |
| `How-the-Queues-Work` | Both queues in one place, because the behaviour is shared. Claiming, leases, heartbeats. Why a worker dying is a delay and not a loss. Retries and which failures are retried at all. Dedupe — identical work is not paid for twice — and what that means when you resubmit. Quotas and concurrency caps. Enough that "still pending" and "why did my second render return instantly" both have answers. |
| `Troubleshooting` | Symptom → cause → fix, for the things that will actually happen: an SVG refused, a design that will not save, a render stuck pending, a render that failed, images not loading, an invitation that expired, a CAD job that produced the wrong shape. |

##### How it must be written

- **Task-oriented.** Headings are things a person wants to do, not features that exist.
- **Say what is true, not what would be nice.** Where behaviour is imperfect, document the behaviour.
  Specifically: source CAD currently persists indefinitely with no deletion path (`F-HARD-04`); the
  CAD parser sandbox does not exist on macOS (`F-HARD-03`, `F-DEPLOY-05`); no fixture pack ships a
  catalog thumbnail yet (`F-CADX-02`); accessibility conformance is not claimed (`F-PLAT-08`).
- **Explain the why where it changes behaviour.** "Named colours are approximate" is only useful
  next to "a screen cannot promise a moulded part's colour".
- **No invented interface.** Every label, keyboard shortcut and route must be checked against the
  running application. A guide that names a button that does not exist is worse than no guide.
- **British English**, to match the rest of the repository.
- **One page per job.** If a page needs a table of contents to be navigable, it is two pages.

##### Acceptance

Behavioural, not a page count:

1. Somebody who has never seen the product completes a design and downloads a render, from the guide
   alone, without asking anyone a question.
2. A new operator ingests a STEP file and publishes a pack from it, from the guide alone.
3. Every route, label and shortcut named in the guide is verified against the running application.
4. `docs/guide/` pushes to the wiki unchanged and every internal link resolves in both places.

#### F-DOC-02 — Screenshots for the guide

`scripts/screenshot.ts` already drives a real browser and writes to `docs/screenshots`, so the guide
can carry images that are regenerated rather than hand-captured and left to rot. Extend it to cover
the pages `F-DOC-01` needs — the face view with a placement, the material picker grouped by finish,
the render dialog, the admin queue, the CAD job list — and reference them from the guide. P2 because
the words have to be right first, and a screenshot of a screen nobody has described is decoration.

## Q. CAD Pipeline, Next Phase (`F-CADX-*`) — v2

Capability proposed while building v1 and deliberately left out of it. Sources:
[23-cad-ingestion.md](23-cad-ingestion.md), which labelled most of these "proposals, not
commitments".

| ID | Feature | Pri | Description / acceptance |
|---|---|---|---|
| F-CADX-01 | Authored decoration UVs | P1 | OCCT returns each face's own surface parameters, which is not a decoration atlas: a cylinder's `u` runs 0..2π and a trimmed face's range is whatever the trim left. So meshes claim only `auto` and the validator refuses to draft a `uv_rect` zone from them. `xatlas` is the next piece. Low urgency by design — four of the five zone types address geometry by millimetre frames and never look at the unwrap. |
| F-CADX-02 | Ingestion thumbnails | P1 | Stage 9. Render a catalog thumbnail through the existing `RenderBackend` once a camera preset has been reviewed. `F-CAT-01` notes the empty slot; the placeholder is what shows today. |
| F-CADX-03 | Re-tessellation with zones carried forward | P1 | Decided in docs/23 (decision 2) and unbuilt. A re-import is currently an unrelated new pack. Should carry zones forward as re-validated *proposals* requiring explicit acceptance — never silently re-projected, because "the numbers still validate" is not "the logo still lands where the customer approved it". |
| F-CADX-04 | Formats beyond STEP | P2 | The registry and the sniffer already model IGES, BREP, STL, Parasolid and JT; only STEP has a reader. Adding one is registering an importer, not editing the pipeline. Parasolid and JT likely need a commercial kernel — the `CadImporter` seam is where it plugs in. |
| F-CADX-05 | Parser as a separate container | P2 | The cleaner form of `F-HARD-01`: a supervisor with network, and a parser container per job with `network_mode: none` and no volumes but scratch. Then the seccomp profile goes back to Docker's default instead of keeping the namespace syscalls the nested design needs. Requires an orchestrator API, and its shape depends on the deployment target — build it once that is decided, not before. |
| F-CADX-06 | Golden CAD corpus | P1 | A dozen real supplier files with known-good outputs, run in CI. The regression suite for a tessellator is a set of files, not a set of assertions. Today: three generated fixtures plus a two-run determinism check. |
| F-CADX-07 | Manufacturability analysis | P2 | Draft angle, undercut, wall thickness, reported at ingestion. This is a packaging product, and a supplier who learns at ingestion that a zone has no draft is better served than one who learns it from a tool trial. |
| F-CADX-08 | Simplify an overrunning mesh instead of refusing it | P1 | The mesh budgets in `packages/cad/src/budgets.ts` were raised to admit the 89-400 Ribbed closure (`lod1` about 20 MB), which gives up the editor's loading targets for every part. The fix that keeps both: when a mesh overruns its rung, coarsen that mesh until it fits rather than refusing the file. Has to answer docs/23's stage 7 objection — a mesh a zone was authored against should not change underneath it — which likely means simplifying only the editor meshes and never `render`, and checking that the zone validator still passes on what comes out. Once built, the budgets go back down. |
| F-CADX-09 | Delete finished ingestions | P2 | Staff can delete a row from the CAD ingestion table once it has **succeeded or failed** — never while queued or running, since the worker holds it. Deleting removes everything the ingestion stored: its meshes under `cad-out/<org>/<job>/`, and its uploaded source under `cad-source/`. Today the source is keyed by content digest and file name, so a file uploaded twice (a failed attempt, then a retry) shares one source object, and it may be deleted only when no remaining ingestion refers to it. Once `F-CADX-10` lands every upload owns its source outright and that check goes away. A pack already made from the ingestion is unaffected, because making a pack copies the meshes into `packs/` rather than referring to them. Acceptance: after the delete, the row is gone, and a listing of both storage prefixes shows nothing that belonged to it. |
| F-CADX-10 | One stored source per upload, named for when it arrived | P2 | Every upload stores its own copy of the source as `cad-source/<org>/<file name> - <datestamp>.step`, with the datestamp taken at upload, instead of today's `<content digest>-<file name>`. An identical re-upload also gets its own new ingestion row rather than being pointed back at the earlier successful one — which means relaxing the digest dedupe in `submitIngestion` (`packages/cad-jobs/src/queue.ts`) and the route's `deduped` response. The datestamp needs time of day as well as the date, so two uploads on one day do not collide, and no colons, which macOS and Windows refuse in file names; e.g. `2030-01-15 093000` in UTC. Two uploads in the same second still collide, so the key needs a tiebreaker in that case. The digest stays recorded on the job for reproducibility; it just stops deciding where the file lives. **Why:** not to stop a tweaked file being hidden — it isn't today, because the digest in the key means any edit gets its own copy and its own row. The reasons are these. (1) *Every upload is a row.* An identical re-upload currently adds nothing and points back at the earlier success, so to the person uploading it looks like the upload did not happen, or shows a date from days ago; with this the table is a true history of what was uploaded and when. (2) *Deletion becomes simple and safe.* While one stored source can belong to several rows, deleting a row (`F-CADX-09`) has to check whether anything else still uses it: wrong one way deletes a file another row needs, wrong the other leaves files nothing points at. One source per upload means deleting a row deletes its files, with no check. (3) *A fresh run can be forced.* Reuse is keyed on `PIPELINE_VERSION`, which has to be bumped by hand whenever conversion settings change; if it is missed, re-uploading returns the stale result and nothing forces a new one. With this, uploading again always converts again. (4) *Stored files are recognisable.* `cap-89-400-ribbed - 2030-01-15 093000.step` says what and when; a key that opens with 32 hex characters does not, which matters to whoever reads storage directly for support, backup or clean-up. **Costs, accepted:** identical re-uploads are stored twice (about 5 MB for a closure), converted again (about 8 s), and an accidental double upload becomes two rows. |
| F-CADX-11 | Size limits for products beyond packaging | P2 | CAD validation refuses a part outside `PLAUSIBLE_SIZE_MM` (1–3000 mm, `packages/cad/src/validate.ts`), a range chosen as a unit-mistake detector for closures and cartons. The product is no longer only packaging, so the range, and the comments that justify it by packaging parts, need checking against the products it is now meant for before anything larger or smaller is imported. |

---

## Dependency notes

- `F-EDIT-04` (live emboss) and `F-REND-04` (geometry emboss) **must** share `F-ART-05` derived
  assets, or WYSIWYG breaks. Highest-risk coupling in v1.
- `F-PLACE-*` depends on zone definitions from `F-GEN-01`/`F-ADM-02`; the 2D view is generated from
  the zone frame, so it costs nothing per product.
- `F-CAT-07` (bottles/boxes) depends on `F-MAT-06` and, for boxes, a dieline/flat-print zone type.
- `F-REND-10` (turntable) reuses the render pipeline with a shared camera path — no per-product work.
- `F-EXP-04` (STEP export) is an OCCT boolean workstream, not a render feature.

## R. Relief on Curved Surfaces (`F-ZONE-*`)

Scoped in [26-curved-relief.md](26-curved-relief.md). Singly-curved surfaces already work — a
cylindrical zone unrolls isometrically and is reproduced by the preview, the displaced patch and
Cycles alike. These rows are the rest: the developable case the schema has no type for, and the
doubly-curved case where `conformal` is half-built and, until it is finished, dishonest about it.

Status here reads as elsewhere in this file — `[x]` met, `–` not started — with `~` for a row whose
work has landed in part. A `~` row says which half in its own notes, because "in progress" on its
own is the kind of status that gets believed.

| Status | ID | Feature | Priority | Notes |
| --- | --- | --- | --- | --- |
| – | F-ZONE-01 | Cone zones | P1 | A tapered closure skirt, a bottle neck and a tub wall are cones, and no zone type addresses them: today they must be faked with a cylinder at one reference radius. A cone is developable, so this is the cylinder case with different arithmetic — zone coordinates are Cartesian in the unrolled sector, which keeps the 2D view a rectangle and the millimetres exact. Touches the schema, the validator, `mappers`, the preview shader, the Cycles graph and a fixture. |
| ~ | F-ZONE-02 | Honest distortion metric for `conformal` | P1 | Half done. The *patch* no longer projects: `buildSurfaceGrid` walks the surface geodesically, so a 45 mm zone on the oval flank spans 45 mm of surface rather than the 79 mm a projection gave. What is left is the reporting side, and it is emptier than this row used to claim: `mapper.metric()` is read by **nothing** in production. Only `patch.ts` calls `mapperFor`, and it does not ask for the metric; the editor's W/H fields show authored zone-space millimetres straight through; `F-PLACE-13` warns on wrap angle alone; `pack-validate` has no distortion check at all. So conformal distortion is unreported rather than misreported, and `metric: () => 1` is a wrong answer nobody is yet asking for. Closing this means adding the readers as well as the number. The grid has the number (`SurfaceGrid.metric`). |
| – | F-ZONE-03 | `conformal` renders the same in both engines | P1 | The preview's patch ray-projects onto the part; the base shader and Cycles project flat. The disagreement is now *reachable* — `bottle-oval` ships a conformal zone — but nothing asserts on it yet. Closing it wants the zone baked into the mesh's own UV space, which is the same operation `F-CADX-01` needs — so this likely lands as a special case of that rather than on its own. |
| [x] | F-ZONE-04 | A doubly-curved fixture | P0 for the above | Done. `buildBottle` and the `bottle-oval` pack: an elliptical section bellied through the body, carrying the repository's only `conformal` zone (45 × 35 mm on the front flank). An oval bottle rather than the dome first sketched here — a real product shape, and one whose curvature differs between the two axes rather than being uniform. It joins `cap-basic` and `box-basic` in the `F-GEN-09` conformance gate, so every placement behaviour is now exercised on a surface that cannot be unrolled. |
