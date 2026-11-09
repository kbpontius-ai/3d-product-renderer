# 00 — Product Overview

## One-liner

A **generic product customizer**: pick a 3D product from a curated catalog, place your vector
artwork on it in a 2D face view, see it live in 3D, and export a photorealistic render.
The first product pack is plastic caps with embossed/debossed logos — the platform is not
about caps.

## Product-agnostic by design (standing directive)

The long-term goal is a tool anyone can run for their own products — open source and/or
commercial — so **any product-specific behavior must live in data, not code**.

- Products ship as **Product Packs**: a manifest (metadata, variants, decoration zones, default
  materials, camera presets) plus assets (meshes, textures). Adding a product = adding a pack,
  never a code change.
- Caps, bottles, boxes, tubes, labels, mugs, phone cases are all "a mesh with decoration zones".
- Zone types (planar, cylindrical, UV-rect, conformal) are a small closed set; a new product uses
  existing types or contributes one generic type.
- Renderer, storage, queue, email, and auth are behind **adapter interfaces** so a self-hoster can
  swap them.
- Conformance rule: every feature must work on **two dissimilar packs** (a cap and, say, a box)
  before it's done. See `F-GEN-09`.

## Problem

Getting a realistic image of "our logo on this product" today requires a CAD seat, a 3D artist,
and days of turnaround. Brand teams and their suppliers need it in minutes, repeatedly, across
variants (colors, finishes, artwork revisions).

## Users

| Persona | Goal | Notes |
|---|---|---|
| **Brand/marketing user** (primary) | Upload logo, place it, download a hero image | Not a 3D user. Judges by realism + speed. |
| **Sales engineer at the supplier** | Produce a customer-specific mockup during a deal | High volume, repeats the same flow per customer. |
| **Admin / content ops** (internal) | Curate product packs, materials; manage access | The only role touching CAD tooling. |
| **Account owner** (customer-side) | Invite teammates, see the team's designs | Light admin, no 3D. |
| **Operator / self-hoster** (v3) | Run the platform for their own catalog | Consumes packs + adapters, not our infrastructure. |

Access is invite-only by email throughout v1 — no self-serve signup.

## Value proposition

1. **WYSIWYG**: browser preview and final photoreal render are driven by the *same* design
   document, the *same* artwork-derived maps, and the *same* materials/environment.
2. **Real geometry**: renders use the actual CAD part, not a stand-in.
3. **Minutes, not days**: preview is instant; the final render is a queued job of a few minutes.
4. **Any product**: the pipeline treats a cap and a carton the same way.

## Scope

Priority tags used in [features](01-features.md): **P0 = v1**, **P1 = v2**, **P2 = v3**.

### v1 (MVP)
- Invite-only auth: email invite → verification → user sets password.
- Curated catalog from one shipped product pack (plastic caps/closures, ~5–15 SKUs).
- SVG upload with safe styled-source analysis, explicit object selection, issue review and optional path repair (`F-ART-12`), followed by sanitization, normalization and derivation. Unsupported features return a recovery hint.
- **2D face placement view** — orthographic view of the actual part face, artwork positioned with
  center/middle-line snapping (easily overridden), scaling, rotation, mm-accurate readouts.
- Live 3D preview synced to the 2D view.
- Finishes: **emboss**, **deboss**, **printed/ink** with depth/bevel controls.
- Materials: color + finish family (gloss / matte / soft-touch / metallic) per part slot.
- Studio environments (curated HDRIs) and camera presets.
- Photorealistic render export (queued, GPU path tracer), download PNG/JPEG, alpha optional.
- Projects: save, rename, duplicate, delete; render history per design.
- Product Pack format + admin ingestion (STEP → pack) as a first-class capability.

### v2
- Product families: **bottles/jars** (transmission materials), **cardboard boxes** (dieline,
  print-on-flat then fold), labels/sleeves — delivered as new packs.
- **Turntable video render** — a single pre-planned orbit path shared by all products, rendered
  photorealistically for product demos.
- **PDF spec sheet export** — artwork dimensions, placement offsets, depth, materials.
- Multiple artwork layers per zone and multi-zone products; artwork version-history browsing and explicit update-to-latest (immutable edit versions already exist).
- Batch/multi-camera renders, saved render presets, deterministic re-render.
- Share links for review, team management, 2FA, raster/PDF artwork ingestion.

### v3
- **Lifestyle backplates and custom HDRI environments** (photographic backdrops with matched
  lighting, org-uploaded environments).
- Multi-part assemblies (cap + bottle + label as one scene), comments/approvals.
- AR/QuickLook, supplier handoff (modified STEP with real embossed geometry).
- Self-host distribution, headless/embeddable API, white-label theming, marketplace of packs.

### Non-goals (explicit)
- Not a CAD editor. Users never edit geometry topology.
- Not a general 3D scene editor. Camera/lighting is preset-driven with bounded controls.
- No user-uploaded CAD in v1 (packs are curated). No raster logo upload in v1 (SVG only).
- No print-production color proofing (no ICC/spot-color accuracy claims) in v1.
- No public/anonymous access; no e-commerce checkout.
- **No product-specific code paths.** If a feature needs "if cap", it needs a pack capability flag.

## Domain objects (conceptual — schema in [12-schemas.md](12-schemas.md))

| Object | Description |
|---|---|
| **Organization** | Tenant. Owns users, artwork, projects, quotas. |
| **User** | Belongs to one org (v1). Roles: `owner`, `member`, plus internal `staff`. |
| **Invitation** | Email + token; consumed to create a User with a password. |
| **ProductPack** | Versioned bundle: manifest + assets. The unit of catalog extension. |
| **Product** / **ProductVariant** | Catalog entry from a pack; variants are sizes/configurations. |
| **ProductAsset** | Derived files: preview GLB LODs, render mesh, texture sets, thumbnails. |
| **DecorationZone** | Where artwork may go: zone type + projection frame + physical size + constraints (max area, min stroke, max depth, allowed finishes). |
| **Material** | Neutral PBR definition + per-renderer mappings. |
| **Environment** | HDRI + tone mapping + backdrop, shared by preview and render. |
| **Artwork** (+ versions) | Canonical SVG + mask/SDF/contours; source-backed prepared versions also retain private original bytes and a versioned selection/repair recipe. |
| **Design** / **DesignVersion** | The saved document: variant + materials + placements + finishes + scene/camera. |
| **Placement** | One artwork instance in a zone: transform in zone-space mm, finish, finish params, ink material. |
| **RenderJob** / **RenderOutput** | Immutable spec snapshot → produced images/video + provenance. |

## Key product principles

1. **Preview and render share one source of truth.** Anything that can change the render lives in
   the design document; nothing render-only hides in worker code.
2. **Place in 2D, judge in 3D.** Positioning artwork is a flat, precise, snap-assisted task;
   evaluation is a 3D/photoreal task. The UI honors both.
3. **Constrain to what manufactures.** Zones enforce real limits and warn before render.
4. **Determinism.** Same design version + same renderer version ⇒ same image.
5. **Generic first.** Every addition is asked: "does this work for a box?"

## Success metrics (v1)

- Time from login → first downloaded render: **< 10 min** for a new user.
- Preview interactive at **≥ 45 fps** on a 2020-class laptop iGPU.
- Final render (2K, final quality) queued→done: **p50 < 3 min, p95 < 8 min**.
- Render job success rate **> 98%**; SVG acceptance rate **> 90%** on first upload.
- A new product pack goes from STEP file to published catalog entry in **< 2 hours** of admin work.

## Glossary

- **Product Pack** — the portable bundle that defines a product for the platform.
- **Deboss / emboss** — artwork pressed into / raised out of the part surface.
- **Decoration zone** — the region of the part where artwork is allowed.
- **Zone space** — 2D millimetre coordinate system of a zone; the space the user manipulates.
- **SDF** — signed distance field derived from artwork; drives bevels and crisp edges.
- **UV** — 2D texture coordinates on the mesh; bridge between flat artwork and curved part.
- **Path tracer** — physically based offline renderer used for final export.
