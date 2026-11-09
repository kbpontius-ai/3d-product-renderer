# 04 — Technology Choices

Recommendations with the alternatives considered. Nothing here is locked; each row is a decision
we should confirm before the implementation plan. Bold = recommended default.

---

## 1. The core architectural idea

One **Design Document** (versioned JSON, validated by a shared schema package) is the single
source of truth. Two consumers render it:

```
                    ┌──────────────────────────┐
   Editor UI ─────► │  Design Document (JSON)  │ ◄───── Render job snapshot (immutable)
                    └──────────┬───────────────┘
                               │
              ┌────────────────┴─────────────────┐
              ▼                                  ▼
   three.js real-time preview          Blender/Cycles GPU worker
   (WebGL2, PBR, normal-map emboss)    (path traced, displaced emboss)
              ▲                                  ▲
              └────── shared material library, HDRIs, artwork-derived maps ──────┘
```

Consequences that drive every choice below: materials are defined once in a neutral schema and
*mapped* into each renderer; artwork-derived textures are generated **server-side once** and used
by both; tone mapping and color management are matched and verified by an automated parity test.

---

## 2. Frontend

| Concern | Recommendation | Alternatives / notes |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript** | Remix, Vite SPA + separate API. Next gives SSR for marketing/auth pages, route handlers for the BFF, and good streaming support. |
| 3D runtime | **three.js** via **react-three-fiber** + **drei** | Babylon.js (strong PBR, heavier API), raw three (more boilerplate). R3F keeps 3D state in the same React model as the UI. |
| Editor state | **Zustand** + immer, with an explicit command/undo stack | Redux Toolkit (heavier), Valtio. Undo/redo must be a first-class command pattern, not state diffing. |
| Server state | **TanStack Query** | SWR. |
| UI kit | **Tailwind + shadcn/ui (Radix)** | MUI, Mantine. Radix gives accessible primitives we'd otherwise hand-roll. |
| Forms/validation | **react-hook-form + Zod** (schemas shared with server) | — |
| **2D face view** | **three.js orthographic pass** for the part backdrop + **Konva** (or a thin custom canvas) for the artwork transform box, guides, rulers | Fabric.js. The backdrop must come from the real mesh, so it is rendered by the same three.js scene into a second target; the overlay only needs to share the exact ortho projection (`pxPerMm`) to stay mm-accurate. |
| Color picker | **react-colorful** + curated palettes | — |
| Realtime job status | **SSE** from the API, fed by Redis pub/sub | WebSockets (needed only if we add collaboration). |
| Analytics/telemetry | **PostHog** (self-host option) + **Sentry** | — |
| Video encode (v2 turntable) | **ffmpeg** in the worker (H.264 + VP9/WebM) | Frames come from the path tracer; encoding is a worker step, not a service. |
| PDF spec sheet (v2) | **React-pdf** or **Typst/WeasyPrint** in a worker | Layout is generic across packs — driven by the design document, not per-product templates. |

**3D asset delivery:** glTF/GLB with **Draco** or **meshopt** compression, textures as **KTX2/Basis**
(GPU-compressed, fast decode, small). LOD0 (~50–150k tris) loads first, LOD1 refines.

## 2b. Extensibility architecture (product-agnostic core)

The platform must run someone else's catalog without a fork. Three seams carry that:

**1. Product Packs (data, not code).** A pack is a versioned bundle:

```
pack.yaml / manifest.json      # schema-validated; see 12-schemas.md
  products[] -> variants[] -> materialSlots[], zones[], cameraPresets[], capabilities{}
assets/
  meshes/{product}/lod0.glb, lod1.glb, render.glb|blend
  textures/…  thumbnails/…  materials/…(optional embedded)
```

Loading a pack is: validate → resolve asset digests → upsert catalog rows. Nothing about a cap,
bottle, or box appears in application code — only zone *types* and capability flags do.

**2. Adapter interfaces.** `RenderBackend` (Cycles today), `ObjectStorage` (S3/R2/MinIO/local),
`CadImporter` (a reference importer today, OCCT next), `Mailer`, `AuthProvider`, `Rasterizer`. Each
has a conformance test suite so a swapped implementation is verifiably equivalent. Queueing is not
an adapter: it is Postgres, deliberately, and shared across queues in `@pr/job-queue`.

**3. Closed set of zone types.** `planar`, `cylindrical`, `uv-rect`, `conformal` (mesh-projected),
`flat-panel` (dieline, v2). A new product picks one; adding a type is a deliberate, generic change
with tests on both fixture packs.

**Conformance gate:** CI ships two fixture packs — a cap and a box — and runs the full workflow
suite against both (`F-GEN-09`). It is the mechanism that keeps the code honest about genericity,
and it doubles as the open-source example content.

## 3. CAD → web pipeline (admin-side, offline)

| Step | Tooling | Notes |
|---|---|---|
| Source format | STEP (AP214/242) primary; IGES/Parasolid via conversion | Source files never leave the server. |
| Tessellation | **OpenCascade (OCCT)** via **pythonocc-core** or CadQuery | Deflection-controlled meshing gives us clean, scale-correct triangles in mm. |
| Mesh prep / UV / LOD | **Blender (bpy, headless)**; **xatlas** for auto-UV where authoring isn't warranted | Decoration-zone UVs should be *authored* for quality; auto-UV is the fallback with a review flag. |
| Export | **glTF 2.0 (GLB)** for preview; Blender `.blend`/USD or high-res mesh for render | Two artifacts per product: preview LODs and the render mesh (dense enough for adaptive displacement). |
| In-browser CAD import (later) | **occt-import-js** / **opencascade.js** (WASM) | Only if we ever allow customer CAD upload — out of scope for v1. |

**Decoration zones** are authored per product: a UV rectangle + a projection frame (planar for cap
tops, cylindrical for skirts/bottles) + physical dimensions + constraints (max depth, min stroke,
allowed finishes). This is what makes "logo in mm" meaningful on curved geometry.

## 4. Artwork (SVG) pipeline

**Built implementation:** the table below is the earlier target tooling, not a list of installed
services. Static SVG preparation uses the bounded TypeScript XML/path core plus pinned
`css-tree` 3.2.1 for permitted CSS and `clipper-lib` 6.4.2 for visible-region Booleans. The custom
TypeScript coverage rasterizer supplies both preview and renderer assets; no resvg, SVGO,
DOMPurify, Paper.js, parser worker or new runtime service is introduced by F-ART-12. Safe computed
source is displayed as an image; unsupported appearance features are rejected with re-export
instructions. Selection and explicit repair share the same pure core on server and demo.
See [29](29-artwork-preparation.md) for the supported subset and precision limits.


| Step | Tooling | Notes |
|---|---|---|
| Sanitize | **DOMPurify (SVG profile)** client-side for preview + **server-side sanitizer** (authoritative) | Server-side is the security boundary; see [security](05-security.md). |
| Normalize/optimize | **SVGO** with a locked plugin set; **svgpathtools / paper.js** for stroke→fill and boolean cleanup | Deterministic, versioned config — changing it changes renders. |
| Text handling | Reject un-outlined text, or outline with an allow-listed embedded font | Fonts are a licensing and determinism hazard; explicit rejection is safer. |
| Rasterization | **resvg** (Rust) server-side, fixed DPI | Deliberately *not* browser SVG rendering — guarantees preview and render use identical pixels. |
| Derived maps | Fill mask → **SDF** (jump-flood or `msdfgen`) → height map (bevel profile from SDF) → normal map | The SDF is what makes bevels/draft angles controllable and resolution-independent. |
| Contours for geometry | Path outlines exported for displacement masking and (P2) OCCT boolean/STEP export | — |
| Raster/AI/EPS input (P1) | **Ghostscript/pdf2svg** or **Inkscape CLI** in a sandboxed converter | Higher risk surface; isolate hard. |

## 5. Real-time preview rendering

- **three.js `MeshPhysicalMaterial`** (clearcoat, sheen, transmission, iridescence for metallized).
- Artwork applied in the decoration zone's UV space by compositing the artwork maps into the
  material's base color / roughness / normal channels — *not* by re-uploading SVG per frame.
- Emboss/deboss preview = normal map from the SDF + optional parallax occlusion; depth in mm is
  converted to normal strength using the zone's physical scale so it reads correctly.
- Alternative for freeform placement on arbitrary curvature: `DecalGeometry` projection. Keep it
  behind the same placement API in case a product has no clean UV zone.
- IBL from the same HDRI the render uses; **AgX tone mapping** in three matched to Blender's AgX
  view transform (parity is verified by test, not assumed).

## 6. Photorealistic render backend

| Option | Verdict |
|---|---|
| **Blender + Cycles (headless, CUDA/OptiX)** | **Recommended.** No license cost, excellent plastics/cardboard/glass, adaptive subdivision + true displacement for emboss, GPU denoising (OptiX/OIDN), scriptable via Python, huge material ecosystem. |
| NVIDIA Omniverse / USD + RTX | Strong quality and USD interop; heavier infra and vendor coupling. Revisit if we go multi-part assemblies at scale. |
| V-Ray / KeyShot | Best-in-class packaging looks, but per-node licensing and weaker headless automation for our volume. |
| LuxCoreRender / Cycles-standalone | Fewer batteries included than full Blender. |
| In-browser path tracing (`three-gpu-pathtracer`) | Good **P2** middle tier ("better preview"), not a substitute for the final export. |

**Worker shape:** container with Blender + our render script. The job spec (validated JSON) is the
*only* input — the worker never executes user-supplied Python or opens user-supplied `.blend`
files. Scene assembly, material mapping, displacement setup, camera, sampling, and denoise are all
derived from the spec.

**Emboss in the final render:** adaptive subdivision + displacement driven by the artwork height
map in zone UV space, with bevel/draft coming from the SDF profile. True B-rep booleans (OCCT) are
reserved for P2 "manufacturing STEP export", where accuracy beats speed.

**Where workers run:**

| Option | Verdict |
|---|---|
| **Serverless GPU (Modal / RunPod / fal)** | **Recommended for v1** — no idle cost, fast scale-to-zero, minutes to production. |
| Self-managed GPU ASG (AWS `g6`/`g5`, or bare metal) | Cheaper at sustained volume; more ops. Plan the migration path from day one behind a `RenderBackend` interface. |
| Local dev | Same container image, CPU fallback, tiny sample counts. |

## 7. Backend / API

| Concern | Recommendation | Notes |
|---|---|---|
| API layer | **Next.js route handlers as a BFF** + a separate **worker service** | Keeps one deployable for the app; heavy work is out-of-process. If the API outgrows Next, extract to Fastify/NestJS without touching the client contract. |
| Language split | TypeScript for app + orchestration; Python only *inside* the Blender/CAD scripts | Avoids a second web framework and a second auth implementation. |
| Queue | **PostgreSQL** (`for update skip locked`) | *Corrected from BullMQ/Redis, which is what this table used to say.* Jobs are enqueued by TS and consumed by TS workers that shell out to Blender or OCCT. Leases, heartbeats, bounded retries, poison-job quarantine, dedupe by content hash and per-org quotas are implemented and tested, including a saturation test that found a real concurrency bug in the quota check. A second store would mean two queue implementations and two failure modes for no gain at this workload. See `packages/render-jobs` and [23](23-cad-ingestion.md). |
| DB | **PostgreSQL** (Neon/RDS) | JSONB for design documents + relational tables for entities/ACLs. |
| ORM/migrations | **Drizzle** (typed, SQL-first, explicit migrations) | Prisma is fine; Drizzle keeps generated SQL legible for the audit-heavy parts. |
| Object storage | **S3** (or Cloudflare R2) + CloudFront/R2 CDN | Private buckets only; presigned PUT for uploads, short-lived signed GET for delivery. |
| Cache / pubsub / rate limits | **Redis** (P1, not yet needed) | Rate limits are currently in-process behind an interface, which is honest for a single node; a fleet swaps in a shared limiter without touching a call site. Not required for the queue — see above. |
| Email | **Postmark** (or Resend) | Transactional deliverability matters — invites are the front door. |
| Background scheduling | BullMQ repeatable jobs | Cleanup, retention, quota resets. |
| Feature flags | **Unleash** or a simple DB-backed table | P1. |
| Observability | **OpenTelemetry** traces web→queue→worker, **Sentry**, structured logs, Grafana/Better Stack dashboards | Per-stage render timings are a product metric, not just ops data. |

## 8. Repo & infrastructure

- **Monorepo** (pnpm workspaces + Turborepo):
  `apps/web`, `apps/worker`, `apps/cad-pipeline` (Python), `packages/design-schema` (Zod, shared),
  `packages/materials` (neutral definitions + three/Cycles mappings), `packages/artwork`,
  `packages/ui`, `packages/config`.
- **Containers** for worker and CAD pipeline; the web app deploys to Vercel or a container host —
  a container keeps environments identical, so lean that way if we're already running containers.
- **IaC**: Terraform (or SST/Pulumi) for buckets, DB, Redis, queues, CDN, secrets.
- **CI**: GitHub Actions — typecheck, lint, unit, integration (Testcontainers Postgres/Redis),
  Playwright E2E, and **golden-image tests** for preview and render output.
- **Environments**: `dev` → `staging` (full render path, small GPU) → `prod`.

## 9. Testing technologies

| Layer | Tool |
|---|---|
| Unit | Vitest |
| Component | Testing Library + Vitest |
| E2E | Playwright (Chromium pre-installed here) |
| Visual regression (UI) | Playwright screenshots + pixelmatch |
| **3D preview regression** | Headless WebGL screenshots of fixed scenes, SSIM threshold |
| **Render regression / parity** | Golden path-traced images at low samples; SSIM between preview and render for the same design — the guardrail for WYSIWYG |
| Load | k6 against API + queue depth behavior |
| Security | `npm audit`/Snyk, SVG fuzz corpus against the sanitizer, ZAP baseline scan |

---

## Principal technical risks

| Risk | Mitigation |
|---|---|
| Preview ≠ render (broken WYSIWYG promise) | Shared design doc + shared maps + shared HDRI/tone map + automated parity test in CI with an SSIM budget |
| Emboss looks convincing in preview but wrong in render | Both derive from the same SDF/height map; render uses real displacement; parity test covers depth/bevel extremes |
| Bad UVs on curved parts distort logos | UVs authored (not auto) for decoration zones; ingestion QA renders a checkerboard + a test logo at zone corners |
| Hostile or pathological SVGs | Server-side sanitize + normalize in an isolated sandbox with CPU/memory/time caps; fuzz corpus in CI |
| GPU cost blowout | Per-org quotas, cost estimate before submit, dedupe identical specs, aggressive draft defaults |
| Curated CAD leaking to competitors | Only decimated GLB reaches the client, signed short-lived URLs, no source CAD in any client bundle |
| Blender/renderer version drift changing outputs | Pin renderer version per render; record it on every output; re-render uses the pinned version |
| Cap-specific assumptions leak into code, blocking the generic/OSS goal | Two-pack conformance suite in CI from M1; zone types are a closed generic set; packs are pure data |
