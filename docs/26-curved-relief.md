# 26 — Relief on Curved Surfaces

How an SVG becomes an emboss or a deboss on something that is not flat, what already does that,
and what is missing. Companion to [15-placement-math.md](15-placement-math.md) (the zone frames),
[24-displaced-preview.md](24-displaced-preview.md) (the displaced patch) and
[23-cad-ingestion.md](23-cad-ingestion.md) (where decoration UVs would come from).

## 0. The short version

"Curved" is two problems, and the system has already solved one of them.

- **Singly-curved surfaces — cylinders — work today, end to end.** The zone unrolls isometrically,
  so a millimetre in the 2D view is a millimetre on the part; the preview shades it, the patch
  displaces real geometry on it, and Cycles reproduces it from the same numbers. The cap fixture's
  skirt zone is exactly this and is covered by e2e and by the parity gate.
- **Doubly-curved surfaces — domes, shoulders, oval faces — do not.** A `conformal` zone type
  exists and is half-built: its patch geometry projects onto the real surface, but its *texture
  coordinates* are a flat projection in every renderer, no pack ships one, and its distortion
  metric reports 1.0 (no distortion) which is simply false.

There is also a gap between them: **cones have no zone type at all**, and a tapered closure skirt
or a bottle neck is a cone. It is the cheapest large win here, because a cone unrolls isometrically
exactly as a cylinder does.

### What has since landed

Two of the pieces below are built. Recorded here so the plan does not read as wholly unstarted:

- **B3, the doubly-curved fixture (`F-ZONE-04`).** Not the dome sketched in §4 — `buildBottle` and
  the `bottle-oval` pack, an oval-section bottle bellied through the body, carrying a 45 × 35 mm
  `conformal` zone on the front flank. An oval rather than a dome because its two principal
  curvatures differ, so a mapping that is merely *rotationally* correct still fails on it. The pack
  joins the `F-GEN-09` conformance gate.
- **Half of B1: the patch is spaced along the surface (`F-ZONE-02`).** `buildSurfaceGrid` replaces
  the flat projection with a geodesic walk — step in the tangent plane, project back onto the mesh,
  correct until the chord travelled matches the millimetres asked for, and carry the frame by
  discrete parallel transport. On the oval flank a 45 mm zone now spans 44.99 mm of surface, where
  projecting the same grid gave 79 mm.

What remains of B1 is the *reporting* side, and it is more than plumbing a number out.
`mapperFor` does still answer `metric: () => 1` — but nothing in production reads
`mapper.metric()` at all, which is what §4's "consumers that must start using it" list means. `patch.ts` is the only caller of `mapperFor` and never asks; the editor's
W/H fields show authored zone-space millimetres straight through; `F-PLACE-13` warns on wrap angle
alone; `pack-validate` has no distortion check. Conformal distortion is therefore *unreported*
rather than misreported, and closing B1 means writing the readers, not only the number.

B2 (Cycles) is untouched: the render still projects a conformal zone flat, and now that a pack ships
one, that disagreement is reachable from the UI.

## 1. What exists, precisely

| Zone type | Preview base shader | Preview patch (geometry) | Cycles | 2D face view | `metric()` | In a fixture? |
| --- | --- | --- | --- | --- | --- | --- |
| `planar` | flat frame | flat | flat projection | rectangle | `1` — correct | yes |
| `cylindrical` | true unroll | analytic cylinder | true unroll | unrolled rectangle | `1` — correct | yes |
| `flat_panel` | mesh UVs | via mesh UVs | mesh UVs | rectangle | `1` | yes (carton) |
| `uv_rect` | mesh UVs | via `sampleByUv` | mesh UVs | rectangle | `mesh.uvMetricAt` — real | **no** |
| `conformal` | **treated as planar** | ray-projected onto mesh | **flat projection** | rectangle | **`1` — a lie** | **no** |

Three facts follow from that table and they drive everything below.

**`uv_rect` is the general answer and it is already wired.** A zone in the mesh's own UV space works
in both renderers, in the patch, and reports honest distortion. Nothing ships one only because no
pack has a decoration atlas — OCCT hands back each face's own surface parameters, which is not an
atlas (`F-CADX-01`, and decision 1 of docs/23). The machinery is finished and starved of input.

**`conformal` is a decal, not a wrap.** `surfaceSampler` in `packages/placement/src/patch.ts` fires
a ray from the frame and takes the first hit, so the *geometry* follows the part. But `mapperFor`
returns the planar frame for `toWorld`, the base shader maps `kind: 0`, and `zoneFrame` in
`packages/blender/src/scene.ts` emits `kind: 'planar'`. So the artwork is projected along the frame
normal like a slide projector: correct directly under the frame, stretched by `sec θ` wherever the
surface tilts by `θ`.

**Nothing tests it.** `conformal` has unit tests around its projection and no fixture, no e2e, no
parity coverage. That absence has already cost us once: tightening the frame-alignment test from
60° to 10° for `planar` (correct) silently applied to `conformal` too (wrong — the far side of any
dome would have stopped being part of the zone), and no test failed. Fixed by making the threshold
a per-type uniform, but the lesson stands: **a fixture with a doubly-curved zone is a prerequisite
for any of this work, not a nice-to-have.**

## 2. The constraint that shapes the design

A cylinder and a cone can be flattened without distortion. A sphere, a torus, a bottle shoulder
cannot — that is Gauss's *Theorema Egregium*, not an implementation shortfall. Any 2D placement
view for a doubly-curved zone is distorted, and the only honest choices are *how* the distortion is
distributed and *whether the UI admits it*.

So the design rule for everything below:

> Never silently distort. Either the mapping is isometric and the millimetres are real, or the
> distortion is measured, bounded at ingestion, and shown to the person placing the artwork.

`metric()` in the `ZoneMapper` interface is where that lives, and it is already specified in
docs/15 §2: *"if the metric deviates from 1 beyond a tolerance, ingestion QA fails the zone rather
than letting the number lie."* It is implemented honestly for `uv_rect` and dishonestly (`() => 1`)
for `conformal`.

## 3. Track A — cone zones (`F-ZONE-01`)

The cheapest real capability. A cone is developable, so this is the cylinder case with different
arithmetic, and every consumer already has a branch to extend.

### The mapping

Unroll the cone about its apex. A surface point at slant distance `s` from the apex and azimuth `φ`
about the axis maps to a point in a flat plane at polar `(r = s, ψ = φ·sin α)`, where `α` is the
half-angle. That map is an isometry.

Zone coordinates are **Cartesian in that unrolled plane**, centred on the zone's centre. This keeps
the 2D face view a plain rectangle and the millimetres exact; the zone's outline on the part is
then slightly arced, which is what decoration on a cone genuinely looks like.

```ts
// packages/placement/src/mappers.ts — new case
case 'cone': {
  const a  = normalize(zone.frame.axisDir);          // apex → base
  const α  = zone.frame.halfAngleRad;
  const s0 = zone.frame.centerSlantMm;               // apex → zone centre, along the surface
  const k  = Math.sin(α);                            // unroll factor: ψ = φ·k
  const ψ0 = zone.frame.centerAngleDeg * DEG * k;

  // Basis of the unrolled plane: r̂ points away from the apex, t̂ is arc-wise.
  const rHat = [Math.cos(ψ0), Math.sin(ψ0)];
  const tHat = [-Math.sin(ψ0), Math.cos(ψ0)];

  const unrolledOf = (p: Vec2): Vec2 => [
    rHat[0] * (s0 + p.y) + tHat[0] * p.x,
    rHat[1] * (s0 + p.y) + tHat[1] * p.x,
  ];

  return {
    toWorld: (p) => {
      const u = unrolledOf(p);
      const s = Math.hypot(u[0], u[1]);              // slant distance, preserved by the unroll
      const φ = Math.atan2(u[1], u[0]) / k;          // back to a real azimuth
      // Cone surface point: apex + s·(cos α · axis + sin α · radial(φ))
      const radial = add(scale(uPerp, Math.cos(φ)), scale(vPerp, Math.sin(φ)));
      const position = add(apex, add(scale(a, s * Math.cos(α)), scale(radial, s * Math.sin(α))));
      // Outward normal tilts off the radial by the half-angle.
      const normal = normalize(sub(scale(radial, Math.cos(α)), scale(a, Math.sin(α))));
      const tangent = add(scale(uPerp, -Math.sin(φ)), scale(vPerp, Math.cos(φ)));
      return { position, normal, tangent };
    },
    fromWorld: (world) => { /* invert: project to (s, φ), unroll, express in (r̂, t̂) */ },
    toUv: () => null,                                 // shading samples the surface, as cylinders do
    metric: () => 1,                                  // developable: exact, and true
  };
}
```

The degenerate case `α → 0` is a cylinder and `α → π/2` is a flat annulus; both should be refused at
authoring with a clear message rather than allowed to divide by a vanishing `k`.

### What else changes

| File | Change |
| --- | --- |
| `packages/design-schema/src/zone.ts` | `ConeZone` in the discriminated union: `frame { apexMm, axisDir, halfAngleRad, centerSlantMm, centerAngleDeg }`, `sizeMm { arcWidthMm, height, safeMarginMm }` |
| `packages/design-schema/src/pack-validate.ts` | half-angle in `(0, π/2)`; zone must not cross the apex (`centerSlantMm − height/2 > 0`); wrap angle warning as for cylinders |
| `packages/placement/src/mappers.ts` | the case above |
| `packages/placement/src/patch.ts` | `zoneSupportsPatch` → `true` (analytic, needs no mesh) |
| `apps/web/lib/zone-material.ts` | `ZoneKind = 3`; a shader branch that inverts the same map |
| `packages/blender/src/scene.ts` | `kind: 'cone'` plus the matching node graph — arctan2, scale by `1/k`, radius from `s` |
| `fixtures/packs/` | a tapered-closure fixture, so the type is exercised by e2e and parity |

The shader and the Cycles graph are the same arithmetic twice, which is the standing hazard in this
codebase — docs/16 already warns that string-surgery shaders fail silently. The mitigation used for
cylinders applies: one TypeScript function computes the basis, both consumers receive numbers.

**Estimate: 3–4 days**, most of it in the two shader paths and the fixture.

## 4. Track B — finish `conformal` (`F-ZONE-02`, `F-ZONE-03`)

Make the half-built type honest. This does *not* make it a true wrap — a decal projection onto a
dome is a legitimate and often desirable thing (it is how pad printing behaves) — it makes the
system tell the truth about it and reproduce it identically in both renderers.

### B1. An honest metric (`F-ZONE-02`)

The projection is along the frame normal `n`. Where it lands on a surface whose normal is `m`, a
step `Δ` in the frame becomes a step `Δ / |m·n|` along the tilt direction and `Δ` across it. So:

```ts
// packages/placement/src/mappers.ts — conformal case
metric: (p) => {
  const hit = mesh?.projectAlong(originAbove(p), negated(frameNormal), 2 * maxProjectionDepthMm);
  if (!hit) return 1;                                  // fell back to the frame; it is flat there
  const cos = Math.abs(dot(hit.normal, frameNormal));
  return 1 / Math.max(cos, MIN_COS);                   // sec θ, the larger singular value
},
```

`MIN_COS` bounds the report where the surface turns edge-on to the frame — past roughly 60° the
number stops being useful and the zone should have been authored differently.

Consumers of `metric()` that must start using it:

- the mm readouts in the editor (`W (mm)` / `H (mm)` today report frame millimetres, which on a
  dome are not surface millimetres),
- `F-PLACE-13` curvature awareness — the existing wrap-angle warning generalises to "this placement
  stretches by up to 1.6× at its corner",
- `pack-validate`, which should refuse to publish a conformal zone whose worst-case metric exceeds
  a pack-declared tolerance.

### B2. Cycles must project the way the preview does (`F-ZONE-03`)

Today `zoneFrame()` emits `kind: 'planar'` for a conformal zone, so Cycles maps by
`world → frame → (x, y)`. The preview's *base* shader does the same, but the preview's *patch* ray-
projects, and the patch is what the user sees. Those two disagree wherever the surface is not flat,
and the parity gate would catch it the moment a conformal fixture exists.

Two ways to close it, and the choice matters:

1. **Make Cycles ray-project too.** There is no "project along a vector onto myself" node; it would
   need the height and ink maps baked into the mesh's own UV space at submit time — which is a bake
   step the render pipeline does not currently have for zones.
2. **Make the preview patch project flat, matching Cycles.** One-line change in `surfaceSampler`,
   and it makes the preview agree with the render — but the patch geometry would then float above
   the surface exactly as the comment in `patch.ts` warns.

**Recommendation: (1), via the existing bake.** `packages/blender/src/bake.ts` already bakes zone
maps; extending it to bake a conformal zone into the mesh's UV set is the same operation applied
earlier. It also happens to be the step that Track C needs anyway, which is the argument for doing
Track C first and letting `conformal` become a special case of it.

### B3. A fixture that is actually doubly curved — **done**

Nothing here could be trusted without one, so this went first rather than last.

Built as `buildBottle` and the `bottle-oval` pack rather than the `buildDome` sketched here. A
sphere is the *easy* doubly-curved surface: its curvature is the same in every direction and at
every point, so a mapping can be wrong in a way a dome never reveals. An oval bottle has different
curvature along each principal axis and a profile that varies with height, which is both the harder
test and the more honest one for a packaging product. It is closed, its normals come from the
ellipse gradient rather than the radial, and it sits in the `F-GEN-09` conformance gate beside the
closure and the carton.

**Estimate: 2 days for the rest of B1, 4–6 days for B2** depending on the bake route.

## 5. Track C — decoration UVs, the general answer (`F-CADX-01`)

The honest architectural conclusion: **`uv_rect` already solves relief on arbitrary geometry, and
the only missing piece is upstream.** Everything downstream — the preview base shader, the patch
via `sampleByUv`, the Cycles node graph, the honest `uvMetricAt` metric — is built and tested.

What is missing is a decoration atlas. From docs/23, stage 6: OCCT returns each face's own surface
parameters (a cylinder's `u` runs 0..2π, a trimmed face's range is whatever the trim left), so
meshes claim only `auto` and the validator refuses to draft a `uv_rect` zone from them.

```python
# packages/cad-occt/src/occt_import.py — after tessellation, before writing
import xatlas

def decoration_uvs(vertices, indices, *, max_stretch: float) -> UvSet:
    atlas = xatlas.Atlas()
    atlas.add_mesh(vertices, indices)
    options = xatlas.PackOptions()
    options.padding = 4                    # texels, so relief at an island edge does not bleed
    options.bruteForce = False
    chart = xatlas.ChartOptions()
    chart.maxCost = max_stretch            # the distortion bound we will later report as metric()
    atlas.generate(chart_options=chart, pack_options=options)
    vmap, ibuf, uvs = atlas[0]
    # xatlas splits vertices at seams: the mesh must be rewritten, not just annotated.
    return UvSet(name='decor', vertices=vertices[vmap], indices=ibuf, uv=uvs,
                 maxStretch=measure_stretch(vertices[vmap], ibuf, uvs))
```

The consequences to design for, none of them small:

- **Seams.** An atlas cuts the surface. A zone that straddles a cut gets a discontinuity in the
  height field, which displaces geometry apart. Either zones are constrained to lie inside one
  chart (checkable at authoring), or the patch must be seam-aware.
- **Vertex count.** Splitting at seams grows the mesh. The *triangle* budgets in
  `packages/cad/src/budgets.ts` were raised to just above the heaviest real part measured, the
  89-400 Ribbed closure (`lod0` allows 120 000 against its ~101 000), so there is little headroom
  on a part like that and plenty on a fixture (~1 900). A hard edge splits a vertex, and ribs and
  relief are all hard edges; `F-CADX-08` is what would restore the margin.
- **Determinism.** `docs/20` requires fixture meshes to be reproducible byte-for-byte, and CI checks
  it. xatlas must be pinned and seeded, or the check has to move to a tolerance.
- **`maxStretch` becomes the honest `metric()`**, measured once at ingestion and carried in the
  pack, which is exactly what docs/15 §2 anticipated.

**Estimate: 1.5–2 weeks**, most of it in seam handling and the determinism story.

## 6. Track D — the 2D face view tells the truth (`F-PLACE-14`)

docs/15 §3 specifies a flattening pass that renders the real mesh into zone space, so the backdrop
behind the artwork is the actual part — the cap edge, the bottle shoulder — rather than a rectangle.
It is unbuilt; `face-view-canvas.tsx` says so in a comment and draws a gradient instead.

On flat and cylindrical zones this is cosmetic. On a dome it is the difference between placing
artwork and guessing: the user cannot see where the surface falls away, and the mm readouts are
frame millimetres.

```glsl
// A second pass into the existing face-view canvas, drawn under the artwork layer.
// Vertex position comes from the zone coordinate, not from a camera.
vec2 z = zoneCoord(worldPosition);          // per-type inverse of docs/15 §2 — analytic, no search
gl_Position = vec4((z - uZoneCenter) / uZoneHalfExtent, depthFromSurface(worldPosition), 1.0);
```

Draw it with a matcap plus a world-normal rim so curvature reads without a light rig, fade geometry
outside the zone rather than clipping it, and — the part that matters here — **shade by the local
metric** so the user can see where their artwork is being stretched.

**Estimate: 4–5 days.** Independent of A/B/C and useful with any of them.

## 7. Order, and what I would actually do

1. **Track A (cones)** — self-contained, isometric, no honesty problem to solve, and it covers a
   large share of real packaging. Ship it first and the system covers every *developable* surface.
2. **B1 + B3 (honest metric, dome fixture)** — small, and B3 is a prerequisite for trusting anything
   about curved zones. Do it alongside A.
3. **Track C (decoration UVs)** — the general answer, and it subsumes B2: once a conformal zone can
   be baked into a real atlas, "make Cycles project the way the preview does" stops being a special
   case.
4. **Track D (face view)** — any time; most valuable once C lands and people are placing artwork on
   genuinely curved parts.

## 8. Risks

- **Two implementations of every mapping.** Each zone type is written once in GLSL and once as a
  Cycles node graph, and docs/16 already records that string-surgery shaders fail silently. Every
  new type must land with a parity fixture in the same change, or it is untested by construction.
- **The zone rectangle is not a rectangle on the part.** True for cones (arcs) and for conformal
  zones (projected outline). Authoring UI, safe-margin checks and the clamping in docs/15 §7 all
  assume a rectangle in zone space; that assumption survives, but the *displayed* outline must not.
- **Doubly-curved relief has a manufacturing story we are not telling.** `F-CADX-07` proposes draft
  and undercut analysis. An emboss on a steep shoulder may be untoolable regardless of what the
  preview shows, and the zone's `maxDepthMm` is currently a flat number per zone rather than a
  function of local geometry.
