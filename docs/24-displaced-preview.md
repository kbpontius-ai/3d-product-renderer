# 24 — Displaced relief geometry in the preview

Scope for `F-PREV-06` and `F-PREV-07`. This replaces the accepted divergence that
[16-preview-engine.md](16-preview-engine.md) records at the bottom of its parity table —
"no true displacement silhouette in preview" — with real geometry.

## Why

The application's founding promise is that a customer can put their logo on a product and see what
it will look like. The 2D view places it; the offline renderer, at `standard` and `final`, subdivides
the mesh and genuinely displaces it (`packages/design-schema/src/render.ts`,
`packages/blender/src/scene.ts`). The preview does not. It samples a height layer, differentiates it
in zone space and tilts the surface normal — millimetre-correct shading on a surface that never
moves.

That is a good bump shader, and for a printed ink layer it is exactly right. For relief it is a lie
of a specific kind: the mark has no silhouette, no parallax, and no occlusion at its own base. A
customer looking at the viewport is being shown paint where they were promised a tool mark, and the
gap only closes when they pay for a render. **The preview is the thing they judge the product by, so
the preview has to be true.**

## What is actually true today

Measured, not assumed:

| | Preview (`apps/web`) | Draft render | Standard / final render |
|---|---|---|---|
| Relief | normal perturbation from a height layer | `BUMP` | `SUBSURF` + adaptive subdivision, `BOTH` |
| Silhouette | flat | flat | real |
| Parallax | none | none | real |
| Occlusion in relief | none | none | traced |
| Self-shadowing | **no real-time shadows at all** | traced | traced |

The last row deserves its own note, because it is easy to get wrong by reading the code too quickly.
`viewport-3d.tsx` sets `castShadow` and `receiveShadow` on every mesh, but `<Canvas>` is created
without the `shadows` prop, so `gl.shadowMap.enabled` is false and those flags are inert. The
preview has image-based lighting plus unshadowed directional lights. **Nothing in the preview casts
a shadow onto anything**, and this document does not change that (see Non-goals).

Which means displaced geometry on its own buys silhouette and parallax but no contact darkening —
and contact darkening is a large part of what makes relief read as relief. So `F-PREV-07`, a
height-field ambient occlusion term, ships alongside the geometry rather than after it. It moves the
preview *towards* the path tracer, which computes exactly this from the displaced surface.

## The shape of it

Four pieces, three of which are pure functions.

| Piece | Where | What |
|---|---|---|
| Mesh index | `@pr/placement/mesh-index.ts` | Implements the `MeshSampler` interface that has been declared in `mappers.ts` since day one and never had an implementation. Triangle lookup by UV and by world proximity. |
| Patch builder | `@pr/placement/patch.ts` | Zone + mapper + resolution → typed arrays. No three.js, no DOM. |
| Zone materials | `apps/web/lib/zone-material.ts` | Two roles from one definition: the **base** part (which now punches a hole) and the **patch** (which displaces). |
| Viewport wiring | `apps/web/components/viewport-3d.tsx` | Builds the patch, renders it, and drops it down the quality ladder. |

**Everything is derived on the client from the zone definition and the mesh already being loaded.**
No new pack asset, no `asset_kind`, no ingestion change, no republished packs. This is the single
most important decision in the document and it is what turns a multi-week pipeline change into a
contained one; see Decision 1.

## Decision log

**1. The patch is generated in the browser from the zone, not baked in the pack.**
The obvious design is a fourth LOD — a dense zone-only mesh produced by the ingestion pipeline. It
is also the expensive one: a new `asset_kind`, a new budget, pipeline work, a pack version bump and
a republish of every existing pack, for a mesh that is a *pure function of data the client already
has*. `mapperFor(zone).toWorld()` maps zone millimetres to world position, normal and tangent
analytically for planar and cylindrical zones, and through the mesh for UV-space ones. Generating
the grid on the client is a few hundred lines and no migration. It also guarantees, structurally,
that the patch lies on the same surface the 2D editor thinks it is placing artwork on, because both
call the same mapper.

**2. The grid is built on the CPU, not synthesised in the vertex shader.**
For planar and cylindrical zones the mapping is cheap enough to evaluate per-vertex on the GPU from
a bare `PlaneGeometry`, which would make resolution changes free. It does not generalise: `uv_rect`,
`flat_panel` and `conformal` zones need the mesh, and a second code path for them is a second set of
bugs. One CPU builder over `mapperFor` covers all five zone types, reuses maths that already has a
conformance suite, and runs once per zone rather than once per frame.

**3. Displacement is the only thing that happens per frame.**
Subdivision depends on the zone and the device, not on the artwork. The grid is built once and
cached; dragging a logo re-uploads a texture and nothing else. If this split were the other way
round the editor would stutter on every pointer move, which is the failure mode that makes the whole
feature not worth having.

**4. Geometry carries what it can resolve; shading carries the remainder.**
The naive version double-counts: the vertices move by the height field *and* the fragment shader
tilts the normal by the same field's slope, so the relief is shaded roughly twice as steeply as it
should be and the preview comes out looking worse than the bump shader it replaced. The fix is to
split the slope by scale. The vertex shader computes the normal at the **vertex spacing** — which is
the slope the displaced mesh actually has — and the fragment shader adds only the **residual**,
the difference between the slope at texel scale and the slope at vertex scale. The two sum to
exactly the slope the current shader applies, so shading parity with the renderer is preserved while
silhouette and parallax are gained. When the grid is as fine as the texture the residual falls to
zero on its own; no flag, no threshold.

**5. The base part gets out of the way on depth, not on footprint.**
A deboss dips below the original surface, so the coarse product mesh would occlude the pocket
entirely and something has to yield. Cutting the zone out of the mesh means a mesh boolean and
crack-free boundary matching, so the product's material `discard`s instead — but *what* it discards
went through two wrong answers before the right one, and the reason is worth keeping.

Discarding the whole zone footprint is the obvious rule and it cannot be made to work. A zone is a
rectangle; the face it sits on very often is not. On the fixture closure's round top face the
patch's own boundary runs along the rim, and the two boundaries are decided by different things —
the product's by its rectangle, the patch's by where the part has surface — so they agree only to
within a fraction of a grid cell. That disagreement is a hairline of background showing through the
rim of the product, and no amount of insetting closes it, because the inset is measured in the
wrong coordinate system.

Discarding on depth removes the conflict instead of tightening it: `discard` only where the decoded
height is below zero and the same neutral-code test used by the patch says relief is present.
A deboss genuinely needs the product out of the way and gets it;
an emboss stands proud and wins the depth test on its own; and everywhere the relief is flat —
which is most of the zone and all of it near the rim — the product keeps drawing and the patch
discards its blank pixels. A zone frame can be slightly tilted or offset from an imported face:
drawing the whole flat overlay there changes reflections into a visible rectangle. Omitting blank
overlay pixels leaves the original substrate visible without rewriting the mesh or zone frame.

Canvas clears the 8-bit height layer to code **128**, which the signed decoder reads as slightly
positive, rather than exact zero. The shared predicate compares the sampled code with 128 within
half a code, independent of the design's height range. Adjacent codes 127 and 129 still draw, so
one-code shallow deboss and emboss are retained. The base yields only to negative, non-neutral
relief; both the undisplaced and displaced stencil counters use the patch's same support and
neutral-code predicates. This keeps blank regions and feathered pocket edges from losing both
surfaces or adding a phantom cross-section surface. Ink and contact occlusion on flat substrate
continue through the base material; the patch's polygon offset remains for relief transitions.

This fixes the blank footprint, not zone alignment, material-slot ownership, or seams already in
the imported mesh. Those require their own reviewed changes.

**6. `zoneInside_` gains a surface-proximity test.**
Today a fragment is "in the zone" if its zone-space coordinates land in the rectangle and it faces
roughly the right way. On a cap that is true of the inside of the bore as well as the outside of the
skirt — they differ only in radius, which nothing checks. That is a latent bug (artwork appears on
surfaces it was never placed on) which discard promotes into a visible one (a hole through the part).
So planar and conformal zones now also require the fragment to be within a tolerance of the zone
plane, and cylindrical zones within a tolerance of the zone radius. The tolerance is deliberately
generous — `max(1 mm, 3 × maxDepthMm)`, or `maxProjectionDepthMm` for conformal zones — so that on
the intended surface it is a no-op.

**7. The height layer's encode range follows the design instead of being a constant.**
`HEIGHT_LAYER_RANGE_MM = 1.5` over 8 bits is 0.0118 mm per code. Invisible in a bump shader; on
displaced geometry it is terracing, because a 0.3 mm emboss gets 25 discrete levels and each one is
a step you can see at the wall. Sixteen-bit packing across two channels is the usual answer and is
wrong here: the zone layer is composited with `drawImage`, and bilinear filtering across a low-byte
wrap produces garbage at exactly the edges that matter. Narrowing the range instead is free and
filter-safe — `max(0.2, depthMm × 1.25)` gives roughly 100 levels across the relief. The constant
stays as the ceiling and the fallback.

**8. No new user-facing control.**
The most intuitive version of this feature is that the depth slider the customer already has starts
moving real geometry. A "relief geometry" toggle would be a preference about how much to trust the
picture, which is not a decision to hand a customer. Devices that cannot afford it lose it through
the existing quality ladder, and zones that cannot produce a patch fall back to today's shading
silently.

## Zone patch geometry

### The resolution question

Vertex spacing sets the finest relief the geometry can express, and triangle count sets whether the
editor stays interactive. The solver takes a quad budget from the quality level and turns it into a
grid that matches the zone's aspect ratio, then clamps it two ways: it never goes finer than the
height texture's own texels (there is nothing there to resolve) and never past a hard per-axis
ceiling.

```ts
// packages/placement/src/patch.ts
export interface PatchResolution {
  segmentsX: number;
  segmentsY: number;
  spacingMm: { x: number; y: number };
}

export function patchResolution(extent: ZoneExtent, options: {
  targetQuads: number;      // from the quality level
  minSpacingMm: number;     // one height-texture texel; no point going finer
  maxSegments?: number;     // hard ceiling per axis, default 1024
}): PatchResolution {
  const aspect = extent.w / extent.h;
  const segmentsY = Math.sqrt(options.targetQuads / aspect);
  const segmentsX = segmentsY * aspect;
  // …round, clamp to [4, maxSegments], and cap at extent / minSpacingMm on each axis
}
```

For a 30 × 30 mm cap face: 260 000 quads (`high`) is 0.059 mm spacing, which is finer than the
0.042 mm height texel only if the texture is capped, so the texel floor usually binds first;
24 000 quads (`low`) is 0.19 mm, comfortably coarser, and the residual term does the rest.

### The build

```ts
export interface ZonePatch {
  position: Float32Array;   // 3/vertex — world mm, undisplaced
  normal: Float32Array;     // 3/vertex — unit, and the direction displacement moves along
  tangent: Float32Array;    // 3/vertex — world direction of zone +x
  uv: Float32Array;         // 2/vertex — the base mesh's own UV, for substrate tiling
  zoneUv: Float32Array;     // 2/vertex — into the height and ink layers, v already flipped
  support: Float32Array;    // 1/vertex — 1 where the part has surface here, 0 where it does not
  index: Uint32Array;
  resolution: PatchResolution;
  vertexCount: number;
  triangleCount: number;
  fallbackVertices: number; // fell back to the zone frame because the mesh could not be sampled
  clippedTriangles: number; // dropped because the part has no surface under them
}

export function buildZonePatch(
  zone: DecorationZoneDef,
  resolution: PatchResolution,
  sampler?: MeshSampler & { uvAtWorld?(p: Vec3): Vec2 | null },
): ZonePatch {
  const mapper = mapperFor(zone, sampler);
  const { w, h } = mapper.extent();

  for (let j = 0; j <= resolution.segmentsY; j++) {
    for (let i = 0; i <= resolution.segmentsX; i++) {
      const u = i / resolution.segmentsX;
      const v = j / resolution.segmentsY;
      const surface = mapper.toWorld({ x: (u - 0.5) * w, y: (v - 0.5) * h });

      writeVec3(position, surface.position);
      writeVec3(normal, surface.normal);
      writeVec3(tangent, surface.tangent);
      // Zone space is +y up, the zone canvas is +y down. The fragment shader does this flip
      // itself when it derives UVs from world position; the patch bakes it in once.
      writeVec2(zoneUv, { x: u, y: 1 - v });
      writeVec2(uv, mapper.toUv({ … }) ?? sampler?.uvAtWorld?.(surface.position) ?? { x: u, y: 1 - v });
    }
  }

  // Two triangles per cell. (tangent, bitangent, normal) is right-handed for every zone type —
  // planar sets bitangent = cross(normal, tangent), and the cylindrical frame satisfies
  // cross(tangent, axis) = radial — so this winding faces along +normal in all of them.
  // A test asserts it rather than trusting the derivation.
  index.push(v00, v10, v11,  v00, v11, v01);
}
```

### Clipping the grid to the part

A zone is a rectangle and the surface it is authored on frequently is not. The fixture closure's top
face is a 38 mm disc carrying a 30 mm square zone, so the square's corners sit 2 mm past the rim —
and the first working build hung four visible flaps of plastic off the edge of the product.

So each vertex asks the mesh whether the part is there, and the question has two halves:

- **Near.** Within a fifth of a millimetre — well above any LOD's chord error, well below the
  millimetres a zone corner overhangs by.
- **Facing the same way.** Proximity alone is not enough and the failure is specific: a vertex a
  hair past the rim of a top face is a fraction of a millimetre from the *skirt*, which runs down at
  right angles to it. Without an alignment test the patch lays a flat sheet over the rounded edge of
  the part and shades it as though it were the top — four dark crescents on the rim, exactly where
  the square's diagonals reach it. The threshold is 0.5, sixty degrees, which is the number the zone
  shader already uses to decide which fragments a planar zone owns; matching it is what keeps the
  patch and the surface it covers agreeing about where the zone ends.

The answer is applied twice, at two resolutions. A triangle survives if **any** of its corners is
supported — dropping it on the first unsupported corner would leave a cell-wide strip along the rim
that neither surface covers. Then the support value rides along as a vertex attribute, and the patch
fragment shader discards below 0.5, so the boundary is a smooth line halfway through the cell rather
than the cell's own corner. Whole-cell clipping alone scallops the rim of a round face visibly; the
fragment test costs one varying and one compare.

### Making the per-vertex mesh query affordable

The first working version of this took **23.8 seconds** to build a 260 000-quad patch, which is not
a slow feature, it is a hung editor. The per-vertex mesh query was doing three things wrong:
collecting candidate buckets into freshly allocated arrays (twenty-seven per query, a quarter of a
million times); searching two full bucket rings whatever the tolerance; and ranking every candidate
to find the *nearest* triangle when the question was only ever whether one was *near*.

`probeNear` answers the cheap question instead: it stops at the first triangle in range, widens the
ring only as far as the tolerance can actually reach, and — the largest win by far — remembers the
triangle it last found and tries that one first. A patch walks a regular lattice, so the answer for
one vertex is nearly always the answer for the next. The same call returns the base mesh's UV, so
support and tiling cost one query between them rather than two.

The same 260 000 quads now build in **0.4 seconds**, and a test holds it under 2.5.

The `uv` attribute matters more than it looks. Materials tile their substrate maps (leather grain,
board texture) by UV, so a patch carrying invented UVs would show the grain jumping at the zone
border. Where the zone can produce a UV it does; otherwise the mesh index is asked what UV the base
mesh has at that world position; only if both fail does it fall back to zone UVs, which is correct
for the fixture materials because they carry no tiled maps at all.

## Mesh index

`MeshSampler` has been an unimplemented interface in `packages/placement/src/mappers.ts` since the
zone mappers were written; `uv_rect` and `flat_panel` zones throw `ZoneMappingError` without one.
Implementing it here unlocks those zone types for the patch *and* for everything else that takes a
mapper.

Pure typed arrays in, no three.js — the caller adapts a `BufferGeometry`, and tests build a cube by
hand.

```ts
export interface MeshArrays {
  position: Float32Array;                 // 3/vertex, world mm
  normal: Float32Array;
  uv: Float32Array;
  index: Uint32Array | Uint16Array;
}

export interface MeshIndex extends MeshSampler {
  sampleByUv(uv: Vec2): SurfacePoint;     // UV → surface, for uv_rect / flat_panel zones
  uvMetricAt(uv: Vec2): number;           // mm per UV unit, so distortion warnings stay honest
  uvAtWorld(p: Vec3): Vec2 | null;        // world → UV, for substrate tiling continuity
  nearestSurface(p: Vec3): SurfacePoint | null;
  projectAlong(origin: Vec3, direction: Vec3, maxDistanceMm: number): SurfacePoint | null;
}
```

Two uniform-grid accelerators over the same triangle list — one bucketed by UV cell, one by world
cell — because the two query directions are both needed and a grid is a hundred lines rather than a
BVH's several hundred. Bucket count is derived from triangle count so it degrades gracefully on a
mesh far denser or sparser than expected. `sampleByUv` finds the triangle whose UV triangle contains
the query point and interpolates barycentrically; `uvAtWorld` finds the nearest triangle by point-to-
triangle distance within a small radius and does the same in reverse.

`projectAlong` is what a `conformal` zone wants — a ray from the frame plane onto whatever surface
lies within `maxProjectionDepthMm` — and it is used to build conformal patches that follow the real
part instead of the flat frame. Where the ray misses, the patch falls back to the frame plane, which
is what the shader assumes today.

## Materials

One definition, two roles. `createZoneMaterials` returns both so they cannot drift, and they share
uniform objects so a texture upload reaches both at once.

### Shared GLSL

```glsl
// height, decoded to millimetres. The layer is a signed value about a mid-grey zero.
float zoneHeightMm(vec2 uv) {
  return (texture2D(uZoneHeight, uv).r * 2.0 - 1.0) * uZoneHeightRange;
}

// Central-difference slope at an arbitrary scale, in dimensionless mm/mm.
vec2 zoneSlope(vec2 uv, vec2 stepUv, vec2 stepMm) {
  float hR = zoneHeightMm(uv + vec2(stepUv.x, 0.0));
  float hL = zoneHeightMm(uv - vec2(stepUv.x, 0.0));
  float hD = zoneHeightMm(uv + vec2(0.0, stepUv.y));
  float hU = zoneHeightMm(uv - vec2(0.0, stepUv.y));
  // Texture v runs opposite to zone y, hence hU - hD rather than hD - hU.
  return vec2((hR - hL) / (2.0 * stepMm.x), (hU - hD) / (2.0 * stepMm.y));
}
```

### Patch: vertex

```glsl
attribute vec2 aZoneUv;
attribute vec3 aZoneTangent;
varying vec2 vZoneUvPatch;
varying vec3 vZoneTangentPatch;

// #include <begin_vertex>
transformed += normal * zoneHeightMm(aZoneUv);       // object space == world mm: patch is at identity

// #include <beginnormal_vertex>
vec2 coarse = zoneSlope(aZoneUv, uZonePatchStepUv, uZonePatchSpacingMm);
vec3 B = cross(normal, aZoneTangent);
objectNormal = normalize(normal - aZoneTangent * coarse.x - B * coarse.y);
```

`normal * height` is correct to first order and ignores the curvature term — displacing 0.4 mm along
the normal of a 19 mm radius changes the surface normal by about 0.02°, which is four orders of
magnitude below anything visible.

### Patch: fragment

Zone UVs come from the varying, not from inverting the world position. That is both cheaper and
*more* correct: the displaced vertex has moved off the analytic surface, so inverting its world
position would report the wrong zone coordinate by exactly the relief depth.

```glsl
// #include <normal_fragment_maps>
vec2 fine     = zoneSlope(vZoneUvPatch, uZoneTexelUv,      uZoneTexelMm);
vec2 coarse   = zoneSlope(vZoneUvPatch, uZonePatchStepUv,  uZonePatchSpacingMm);
vec2 residual = fine - coarse;                        // → 0 when the grid resolves the texture
normal = normalize(normal - vZoneTangentPatch * residual.x - vZoneBitangentPatch * residual.y);
```

### Base: yielding to the patch

```glsl
// inside the existing <map_fragment> block, once zoneUv_ and zoneInside_ exist
if (uZonePatchActive > 0.5 && zoneInside_ && zoneHeightMm(zoneUv_) < -0.002) discard;
```

and, on the patch material, `polygonOffset` with a factor and units of `-1` — two surfaces at the
same depth is otherwise a coin toss resolved per pixel.

### Base: surface proximity

```glsl
// kind 0 — planar / conformal: how far off the zone plane the fragment is
facing = dot(normalize(vZoneWorldNormal), uZoneNormal) > 0.5
      && abs(dot(rel, uZoneNormal)) <= uZoneSurfaceTolMm;

// kind 1 — cylindrical: how far off the zone radius
float radial = length(rel - uZoneNormal * dot(rel, uZoneNormal));
facing = abs(dot(normalize(vZoneWorldNormal), uZoneNormal)) < 0.7
      && abs(radial - uZoneRadius) <= uZoneSurfaceTolMm;

// kind 3 — conformal with a patch: coordinates carried by the product's own vertices
zoneMm = vZoneMm.xy;
facing = vZoneMm.z > 0.999;
```

### Base: conformal zones carry their coordinates (kind 3)

A conformal patch is *walked* across the part (`buildSurfaceGrid`), so its zone millimetres are
measured along the surface. A walk has no inverse a shader can evaluate, and kind 0 does not try:
it projects onto the frame plane and only counts fragments within `maxProjectionDepthMm` of it.
On a curved part the two disagree twice. The surface leaves that slab a short way from the centre:
12 mm either side on a 75 mm radius with the 1 mm default. Beyond that the base thinks it is
outside the zone, never gets out of the way of a deboss, and draws over every pocket. Inside the
slab it measures a chord where the patch measures an arc, so its holes drift off the letters, by
1.75 mm at the ends of a 78 mm logo on that radius. The same test decides where the base
composites print ink, so a printed mark was cut off at the same place.

So whenever a conformal zone has a patch, the viewport hands the patch's coordinates to the product
(`surfaceCoordinates` in `@pr/placement`) and builds the base as kind 3. Each product vertex takes
the zone coordinate of the nearest supported patch node, plus its offset from that node in the
node's tangent frame. That is exact at the nodes, second order between them, and extrapolates past
the patch's edge. The extrapolation matters because CAD tessellates a cylinder as full-height
strips (up to 119 mm on the 120mm Container), so a triangle that crosses the zone may have no vertex
inside it. A vertex counts only if it faces the patch (`CONFORMAL_ZONE_ALIGNMENT`) and is not
behind it. The second test keeps out the inside of the far wall of a hollow part, which faces the
same way as the zone. The coordinates ride on `aZoneMm`, on a per-viewer copy of the mesh's
geometry, because the loaded glTF's geometry is shared through the loader cache.

Kinds 0–2 compile byte-identical programs to before; only kind 3 declares `aZoneMm`. With no patch
there are no coordinates to carry, and a conformal zone falls back to kind 0. The relief readout
reports `body <n>`, the number of product vertices carrying coordinates, so a browser test can tell
the two apart.

The final render does not share this. `packages/blender` maps a conformal zone by planar projection,
not by walking, so on a curved part the render places artwork by chord while the preview places it
by arc.

## Ambient occlusion from the height field (`F-PREV-07`)

Horizon estimation in zone space: for each of eight directions, walk three steps out to the AO
radius and keep the steepest rise. A point at the bottom of a debossed stroke sees rising walls in
most directions and darkens; a point on a flat field sees none and does not.

```glsl
float zoneOcclusion(vec2 uv, float h0) {
  float occluded = 0.0;
  for (int d = 0; d < 8; d++) {
    vec2 dir = kZoneAoDirs[d];
    float steepest = 0.0;
    for (int s = 1; s <= 3; s++) {
      float t = float(s) / 3.0;
      float dh = zoneHeightMm(uv + dir * uZoneAoRadiusUv * t) - h0;
      steepest = max(steepest, dh / (uZoneAoRadiusMm * t));
    }
    occluded += clamp(steepest, 0.0, 1.0);
  }
  return 1.0 - uZoneAoStrength * occluded * 0.125;
}
```

Applied to indirect light only, after `<aomap_fragment>`, exactly as three.js applies a baked AO
map — direct light must keep its own falloff or the relief goes muddy. Twenty-four taps is the
single most expensive thing added here, which is why it is the first thing the quality ladder drops.
It runs on both roles, so the fallback path gets it too.

## Quality ladder

`apps/web/lib/quality.ts` already steps three levels on measured frame time with hysteresis. Two
fields join it:

| Level | dpr | patchQuads | zoneAo |
|---|---|---|---|
| low | 0.75 | 24 000 | off |
| medium | 1 | 90 000 | on |
| high | 2 | 260 000 | on |

Geometry survives all three levels — losing it is losing the feature — and AO goes first because it
is fragment cost and the geometry is not. A device that cannot hold 30 fps at `low` is already
dropping device-pixel ratio, which is a much bigger lever than 24 000 quads.

## Lifecycle and performance

- The patch geometry is memoised on `(zone.key, resolution, meshUrl)`. Artwork edits, colour changes,
  finish changes and camera moves do not touch it.
- A level change rebuilds it. At `high` that is roughly 260 000 quads — about 0.4 s, once, on a level
  transition that already redraws everything. See "Making the per-vertex mesh query affordable"
  above for why that number is 0.4 and not 24.
- `BufferGeometry`, materials and canvas textures are disposed on unmount and on rebuild. The editor
  is a long-lived SPA; the existing code is careful about this and the patch must not be the leak.
- `frameloop="demand"` is unchanged: the patch invalidates on the same events the material does.

## UX and failure behaviour

Nothing new appears in the interface. What changes is that the finish depth control now moves
geometry, and the emboss holds its shape when the product is orbited to a grazing angle.

Failure is always a fallback, never an error:

| Situation | Behaviour |
|---|---|
| `uv_rect` / `flat_panel` zone on a mesh with no usable UVs | No patch; today's bump shading, no message |
| `conformal` ray misses the surface | That vertex falls back to the frame plane |
| Patch would exceed the segment ceiling | Clamped, and the residual term absorbs the difference |
| Height layer absent (no artwork yet) | Height is uniformly zero; the patch is geometrically identical to the surface it covers |
| Zone overhangs the face it is authored on | Those vertices are unsupported; the patch is clipped to the part, per triangle and then per fragment |
| Zone misses the part entirely | The patch has no triangles at all, and nothing is drawn |

The last row is the important one: **with no relief the patch is invisible.** Its neutral-code
pixels are discarded, so an empty zone shows only the original substrate even if the authored frame
does not coincide exactly with the mesh. Printed ink is shaded on that substrate.

## Parity

The preview's job is to predict the render. Three things move it closer and one is new risk.

Closer: silhouette, parallax, and occlusion in the relief now exist where the path tracer has always
had them. Risk: the fragment shading of the relief must not change, or every SSIM baseline moves for
a reason that has nothing to do with geometry. Decision 4 is what protects it — geometry and
residual sum to the slope the single-surface shader applied.

That claim is checked at four levels, and it is worth being precise about which of them actually
runs where:

| Check | What it proves | Runs |
|---|---|---|
| Shader construction tests | The vertex shader asks for the slope at the vertex spacing, and the fragment shader applies `fine - coarse` and nothing else | Every `pnpm test` |
| `relief.spec.ts` in a real browser | Both programs compile and link, the patch is built and drawn, and the frame differs from the undecorated one | Every `pnpm e2e` |
| `blank-relief.spec.ts` in a real browser | The production patch predicate leaves code 128 transparent, retains one-code shallow relief on both sides, and still rejects unsupported surface, with linear texture filtering | Every `pnpm e2e` |
| `parity.spec.ts`, embossed case | The shading split is right in *magnitude* — get it wrong either way and the relief reads at half or twice its depth | Only with `DEV_TOOLING=true` and `E2E_RENDER_WORKER=true` |

The parity check needs a configured Blender worker and database. A run that skips it supplies no
preview/render evidence; report its measured result separately from shader and browser checks.

The parity budget itself is deliberately unchanged. If displaced geometry moves the score, that is
the measurement doing its job and the number to argue with is the one it reports.

## Non-goals

- **Real-time shadows stay off.** Enabling `shadowMap` is a global change to every existing frame,
  with acne risk at a 0.3 mm feature scale on maps sized for a 38 mm part, and the contact darkening
  it would buy is what `F-PREV-07` buys locally and more cheaply.
- **No B-rep is modified.** This is a render-time surface, not a CAD edit; a manufacturable solid is
  `F-EXP-04` and a kernel boolean, unchanged by any of this.
- **The offline renderer is untouched.** It already displaces. This is the preview catching up.
- **The 2D face view is untouched.** It is a flat view of a flat placement and gains nothing from
  geometry.

## Build order

1. `@pr/placement`: mesh index — `MeshSampler`, `uvAtWorld`, `probeNear`, `projectAlong`, with unit
   tests on a hand-built quad, disc, cylinder and capped disc.
2. `@pr/placement`: patch builder, resolution solver and clipping, with winding, continuity,
   clipping and build-time tests.
3. Adaptive height range, so displacement lands on a signal with enough levels to be smooth.
4. `zone-material`: the two roles, displacement, residual split, proximity test, depth discard, AO.
5. `viewport-3d`: build, render, dispose, quality wiring, fallback, and the relief readout.
6. Tests, parity baselines, and an audit of this document against what shipped.

## What the build changed about this document

Four things were wrong in the plan and are corrected above rather than left as history:

| Planned | Shipped | Why |
|---|---|---|
| Base discards the zone footprint, inset by 1.5 texels | Base discards non-neutral negative relief; patch discards blank pixels and carries a polygon offset at relief transitions | The footprint rule cannot line up with the patch's own boundary on a face that is not a rectangle; a blank overlay must not change substrate reflections |
| No clipping — the grid is the zone | The grid is clipped to the part, per triangle and per fragment, on proximity **and** alignment | A 30 mm square zone on a 38 mm round face hangs its corners off the product |
| One mesh query per vertex, cost unexamined | `probeNear`: near-not-nearest, tolerance-bounded ring, and a one-slot memo | 23.8 s to build a patch is a hung editor, not a slow feature |
| Nothing said about diagnostics | A hidden `relief-readout` reports what the zone is actually drawn with | The fallback to shading is silent by design, so it needs to be legible to a test |

Two bugs in the shipped preview were found on the way and fixed here, because both are things this
feature would otherwise have inherited:

- The zone shader perturbed a **view-space** normal by a **world-space** frame, so the direction the
  relief appeared lit from rotated with the camera. That reads as artwork painted on rather than cut
  in, which is close to the complaint this whole document exists to answer.
- A zone was bounded in two coordinates and unbounded in the third, so a closure's bore satisfied
  its skirt zone exactly as the skirt did — artwork on surfaces it was never placed on, and a hole
  through the part once the base material started discarding them.

## Blank-overlay verification

- Reproduced the rectangular reflection artifact on a locally imported cap with generic fixture
  artwork. The actual implementation removes the blank rectangle and preserves the raised mark;
  no shader errors were reported. An existing circular mesh seam remains visible. No CAD assets,
  authored zone frames, or saved designs were changed.
- `pnpm test`: 1,381 passed; seven Linux-only sandbox tests skipped on macOS. Real PostgreSQL,
  Blender and OCCT integration checks ran.
- `pnpm -r typecheck`, `pnpm lint`, and `pnpm check:env`: passed.
- Full local `pnpm e2e --workers=2`, through the isolated database/storage wrapper: 153 passed,
  one failed. Cap print, emboss, filled-relief parity and cross-section checks passed. The existing
  prepared-carton mismatch remains: mean SSIM 0.208, local aggregate -0.713, against budgets
  0.8 / 0.35. This matches the previously recorded failure in
  [workspace verification](30-workspace-reskin.md); the full browser suite is not green.
- The final `blank-relief.spec.ts` also passed separately with WebGL 2, actual vertex displacement,
  linear-filtered quarter-code edges, supported/unsupported surface, and all three height ranges.
- Documentation and regression coverage follow the approved scope: hide blank relief-overlay
  pixels without correcting zone alignment, material-slot ownership, or imported mesh seams.
  No GitHub CI was triggered.
