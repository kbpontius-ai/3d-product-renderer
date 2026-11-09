# 07 — Phasing, Risks & Open Decisions

Priority mapping: **P0 = v1**, **P1 = v2**, **P2 = v3**.
Sequencing rule: **prove the riskiest thing first** — not auth or CRUD, but that a logo placed in
a 2D face view looks identical in the browser preview and in the final path-traced render, on a
product the code knows nothing special about.

---

> CI references in this roadmap describe the available checks. GitHub CI must pass before merge
> unless explicitly waived for that PR; dispatch it if needed. Local validation remains required.

## M0 — Vertical spike (de-risking, no product surface)

**Goal:** one cap, one SVG, end to end, twice-rendered.

- STEP → tessellated GLB with one hand-authored decoration zone.
- SVG → sanitized → SDF → height/normal maps (scripts, not services).
- three.js scene showing a debossed logo; Blender/Cycles script rendering the same design.
- Side-by-side comparison + first SSIM parity measurement.

**Exit:** a screenshot pair stakeholders agree "match", and a measured parity threshold we can
enforce in CI. If normal-map preview can't reach it, we change approach here — before the app is
built around it.

## M1 — Walking skeleton (+ genericity foundations)

Auth (invite → verify → password → session), org model with RLS, **Product Pack loader** with one
real pack, artwork upload through the real sanitize/derive pipeline, **2D face placement view**
(snap/override/scale/rotate), minimal 3D preview, render submission through the real queue to a
real GPU worker, download. Deployed to staging with CI, telemetry, and the parity test running.

**Exit:** an internal user completes W-01 → W-08 on staging unaided, and the **box fixture pack**
imports and renders through the same code path (`F-GEN-09` scaffolding in place).

## M2 — v1 feature completion

Full cap catalog (5–15 SKUs), material library + colorways, placement polish (guides, rulers,
alignment, keyboard nudge, clearance readouts), validation warnings, scene/camera presets, render
presets and gallery, notifications, quotas, admin console (pack ingestion, zone authoring,
materials, users, queue), audit log, accessibility pass.

**Exit:** all P0 features accepted; security checklist in [05-security.md](05-security.md) green;
two-pack conformance suite green; pen test scheduled.

## M3 — Pilot hardening

Pilot with 3–5 friendly customers. Focus: SVG acceptance rate, render success rate, queue behavior
under real load, cost per render, and the top three confusions in the placement UI.

**Exit:** the success metrics in [00-overview.md](00-overview.md) met on real traffic.

## M4 — v2

Product packs for **bottles/jars** (transmission materials) and **cardboard boxes** (flat-panel
zone type, print-on-flat then fold), **turntable demo video** (one shared orbit path, all
products), **PDF spec sheet export**, multi-placement layers and multi-zone editing, artwork
versioning, batch/multi-camera renders, saved render presets, deterministic re-render, share
links, team management, 2FA, raster/PDF artwork ingestion, usage analytics.

**Exit:** two additional packs shipped without a single product-specific code path.

## M5 — v3 / platform

Lifestyle backplates and custom HDRI environments, multi-part assemblies, comments/approvals,
AR/QuickLook, STEP export with true embossed geometry, self-host distribution, headless API +
API keys, white-label theming, embeddable widget, pack marketplace.

---

## Cross-cutting risks

| Risk | Impact | Mitigation | Phase |
|---|---|---|---|
| Preview ≠ render | Kills the core promise | M0 spike, shared design doc + shared maps + shared HDRI/tone map, CI parity budget | M0 |
| Placement UX feels imprecise or fights the user | The one workflow everyone touches | Screen-space snap thresholds, always-available override, mm readouts everywhere, usability test in M3 | M1–M3 |
| UV distortion on curved zones | Logos look stretched or mis-sized | Authored UVs for zones, ingestion QA with test patterns, unrolled 2D view, wrap-angle warnings | M1 |
| Cap-specific assumptions creep in | Blocks the generic/OSS goal | Two-pack conformance suite in CI from M1; packs are pure data; closed set of zone types | all |
| Messy customer SVGs | Support burden, abandoned uploads | Normalization pipeline + plain-language validation + fix hints; measure acceptance rate in pilot | M1–M3 |
| GPU cost per render | Margin | Estimate before submit, quotas, spec-hash dedupe, draft defaults; measure in M3 | M1 |
| Render latency at peak | Perceived reliability | Autoscaling GPU backend, honest ETAs, small-job priority | M2 |
| Pack authoring is slow | Catalog growth stalls | Ingestion is a P0 product feature, plus auto zone detection in v2 | M2/M4 |
| Scope creep into a 3D editor | Ships nothing | Non-goals in `00-overview.md` enforced in review | all |

---

## Open decisions

Still needed before/while building (recorded as ADRs when answered):

1. **Render backend hosting** — serverless GPU (fastest, higher per-minute) vs self-managed GPU
   instances (cheaper at volume, real ops). *Assumed for the plan: serverless behind the
   `RenderBackend` adapter, migrate when volume justifies it.*
2. **Renderer** — Blender/Cycles (assumed) vs a commercial engine you must visually match.
3. **Emboss fidelity in v1** — displacement-only (assumed) vs true CAD boolean; boolean is needed
   for the v3 STEP export regardless.
4. **Tenancy** — one org per customer (assumed) vs agency accounts managing several brands.
5. **Cloud** — AWS vs Cloudflare+Neon vs other. *Assumed: S3-compatible storage + Postgres + Redis,
   all behind adapters, so the choice is late-binding.*
6. **CAD asset authoring** — do you have STEP files plus someone to author UVs/zones? *Settled:
   a person places every zone (`F-ADM-13`, `F-ADM-14`); proposing zones from geometry
   (`F-GEN-03`) was dropped as unreliable.*
7. **Brand/design system** — existing brand to match, or define one?
8. **Volume expectations** — designs/day and renders/day at pilot and at 12 months.
9. **OSS boundary** — which parts are open (core, packs, adapters) vs commercial (render service,
   SSO, white-label)? Affects repo layout and licensing before first public release.

The implementation plan proceeds on the assumptions above; each is isolated behind an adapter or a
config choice, so changing one is a swap, not a rewrite.
