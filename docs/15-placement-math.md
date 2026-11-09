# 15 — Placement Math & the 2D Face View

`packages/placement` — pure TypeScript, no I/O, used identically by the editor (interactive) and
the API (validation) and the render worker (baking). This is the code behind `F-PLACE-*` / W-05.

---

## 1. Coordinate systems

| Space | Units | Definition |
|---|---|---|
| **World** | mm | The product's own coordinate system, as tessellated from CAD. |
| **Zone** | mm | 2D: origin at the zone center, `+x` right, `+y` up, on the **unrolled** surface. This is the space the user manipulates and the only space stored in the design document. |
| **UV** | 0–1 | Mesh texture coordinates; the bridge to shading. |
| **Screen** | px | The 2D face view canvas. `pxPerMm` is a single scalar — the whole UI depends on that being exact. |

```
design document ──(zone space, mm)──► placement package ──► { world (3D preview), uv (shading), screen (2D view) }
```

Conversions are defined once, in one direction each, and unit-tested against their inverses.

## 2. Zone frames → world

```ts
type ZoneMapper = {
  toWorld(p: Vec2): { position: Vec3; normal: Vec3; tangent: Vec3 };
  toUv(p: Vec2): Vec2 | null;      // null when the zone type needs mesh sampling
  boundsMm(): { w: number; h: number; safeMarginMm: number };
  metric(p: Vec2): number;         // local mm-per-mm distortion, 1.0 = undistorted
};

function mapperFor(zone: DecorationZoneDef, mesh?: MeshIndex): ZoneMapper {
  switch (zone.type) {

    case 'planar': {
      const n = normalize(zone.frame.normal);
      const t = normalize(orthogonalize(zone.frame.tangent, n));   // Gram-Schmidt: guarantees ⟂
      const b = cross(n, t);                                        // +y
      return {
        toWorld: (p) => ({ position: add(zone.frame.originMm, add(scale(t, p.x), scale(b, p.y))),
                           normal: n, tangent: t }),
        toUv: zone.uvRect ? (p) => uvFromRect(p, zone) : () => null,
        boundsMm: () => zone.sizeMm, metric: () => 1,               // planar is distortion-free
      };
    }

    case 'cylindrical': {
      const a = normalize(zone.frame.axisDir);
      const u = normalize(orthogonalize(anyPerpendicular(a), a));
      const v = cross(a, u);
      const R = zone.frame.radiusMm;
      return {
        toWorld: (p) => {
          const theta = deg2rad(zone.frame.centerAngleDeg) + p.x / R;   // arc length → angle
          const radial = add(scale(u, Math.cos(theta)), scale(v, Math.sin(theta)));
          const height = zone.frame.centerHeightMm + p.y;
          return { position: add(zone.frame.axisOriginMm, add(scale(a, height), scale(radial, R))),
                   normal: radial,
                   tangent: add(scale(u, -Math.sin(theta)), scale(v, Math.cos(theta))) };
        },
        toUv: () => null,                                            // shading samples via mesh UVs
        boundsMm: () => ({ w: zone.sizeMm.arcWidthMm, h: zone.sizeMm.height, ...zone.sizeMm }),
        // Unrolling a cylinder is isometric: lengths are preserved exactly.
        metric: () => 1,
      };
    }

    case 'uv_rect':
      return { toWorld: (p) => mesh!.sampleByUv(uvFromRect(p, zone)),
               toUv:    (p) => uvFromRect(p, zone),
               boundsMm: () => zone.sizeMm,
               // authored UV islands may stretch; the ingestion QA measures it and stores a factor
               metric: (p) => mesh!.uvMetricAt(uvFromRect(p, zone)) };

    case 'conformal':                                                // planar frame, ray-cast onto the mesh
      return conformalMapper(zone, mesh!);

    case 'flat_panel':                                               // v2: dieline panel, flat by construction
      return flatPanelMapper(zone);
  }
}
```

`metric()` is how the UI can honestly say "24.0 mm" on a stretched UV island: if the metric deviates
from 1 beyond a tolerance, ingestion QA fails the zone rather than letting the number lie.

## 3. The 2D face view (F-PLACE-01)

One mechanism for every zone type: a **flattening pass** that renders the real mesh into zone space.

```glsl
// vertex shader (face view pass): position the vertex by its ZONE coordinate, not by a camera
attribute vec3 position;      // world mm
varying float vInZone;
uniform mat4 uWorldToZone;    // planar/conformal: rigid transform
uniform int  uZoneType;       // cylindrical/uv_rect take their own branch
void main() {
  vec2 z = zoneCoord(position);                    // per-type inverse of §2 (analytic, no search)
  vInZone = insideZone(z) ? 1.0 : 0.0;
  gl_Position = vec4((z - uZoneCenter) / uZoneHalfExtent, depthFromSurface(position), 1.0);
}
```

- The backdrop is therefore the **actual part**, flat-shaded (matcap + world-normal rim), with
  geometry outside the zone faded rather than clipped, so users see context (the cap edge, the
  bottle shoulder) around their artwork.
- Curved zones appear **unrolled**; for cylinders the unrolling is isometric, so millimetres on
  screen are millimetres on the part.
- `pxPerMm = canvasHeightPx / (zoneHeightMm × (1 + viewMargin) / zoom)`; this single scalar drives
  rulers, snap thresholds, handle sizes, and the mm readouts.

Overlays (zone boundary, safe margin, center cross-hair, guides, rulers, transform box) are drawn
in a 2D canvas layer sharing exactly this transform.

## 4. Placement transform

```ts
// Zone-space model matrix for one placement
function placementMatrix(t: Transform): Mat3 {
  return mat3.compose(
    /* translate */ t.offsetMm,
    /* rotate    */ deg2rad(t.rotationDeg),
    /* scale     */ { x: (t.flipX ? -1 : 1) * t.sizeMm.w, y: (t.flipY ? -1 : 1) * t.sizeMm.h },
  );
}

// Artwork occupies the unit square [-0.5,0.5]² before scaling.
function corners(t: Transform): [Vec2, Vec2, Vec2, Vec2] {
  const m = placementMatrix(t);
  return UNIT_SQUARE.map(c => transform(m, c)) as any;
}
function aabb(t: Transform) { const c = corners(t); return { min: minOf(c), max: maxOf(c) }; }
```

Rotation is around the artwork center. All handle math happens in the placement's **local rotated
basis**, so a rotated logo scales along its own axes — the behavior every design tool has.

## 5. Snapping (F-PLACE-05/06)

```ts
const SNAP_PX = 6;            // constant feel at any zoom
const BREAK_FACTOR = 1.5;     // how far you must pull to escape a snap

type SnapTarget = { axis: 'x' | 'y'; valueMm: number; kind: SnapKind; priority: number };
type SnapKind = 'zoneCenter' | 'guide' | 'safeEdge' | 'zoneEdge' | 'neighborCenter' | 'neighborEdge';
const PRIORITY: Record<SnapKind, number> = {
  zoneCenter: 0, guide: 1, safeEdge: 2, zoneEdge: 3, neighborCenter: 4, neighborEdge: 5,
};

function snapTargets(ctx: PlacementContext): SnapTarget[] {
  const { zone, guides, others } = ctx;
  const halfW = zone.w / 2, halfH = zone.h / 2, m = zone.safeMarginMm;
  return [
    { axis: 'x', valueMm: 0, kind: 'zoneCenter', priority: 0 },      // the middle lines
    { axis: 'y', valueMm: 0, kind: 'zoneCenter', priority: 0 },
    ...guides.map(g => ({ axis: g.axis, valueMm: g.valueMm, kind: 'guide' as const, priority: 1 })),
    { axis: 'x', valueMm: -(halfW - m), kind: 'safeEdge', priority: 2 },
    { axis: 'x', valueMm: +(halfW - m), kind: 'safeEdge', priority: 2 },
    { axis: 'y', valueMm: -(halfH - m), kind: 'safeEdge', priority: 2 },
    { axis: 'y', valueMm: +(halfH - m), kind: 'safeEdge', priority: 2 },
    { axis: 'x', valueMm: -halfW, kind: 'zoneEdge', priority: 3 },
    /* … remaining zone edges … */
    ...others.flatMap(neighborTargets),
  ];
}

// Called on every pointermove during a drag.
function applySnap(proposed: Transform, ctx: PlacementContext, input: DragInput): SnapResult {
  if (ctx.snapEnabled === false || input.altHeld) return { transform: proposed, guides: [] };

  const thresholdMm = SNAP_PX / ctx.pxPerMm;
  const box = aabb(proposed);
  const anchors = {
    x: [{ v: (box.min.x + box.max.x) / 2, role: 'center' }, { v: box.min.x, role: 'min' }, { v: box.max.x, role: 'max' }],
    y: [{ v: (box.min.y + box.max.y) / 2, role: 'center' }, { v: box.min.y, role: 'min' }, { v: box.max.y, role: 'max' }],
  };

  const result = { ...proposed, offsetMm: { ...proposed.offsetMm } };
  const guides: ActiveGuide[] = [];

  for (const axis of ['x', 'y'] as const) {
    let best: { delta: number; target: SnapTarget } | null = null;

    for (const target of snapTargets(ctx).filter(t => t.axis === axis)) {
      for (const anchor of anchors[axis]) {
        const delta = target.valueMm - anchor.v;
        if (Math.abs(delta) > thresholdMm) continue;
        if (!best
            || Math.abs(delta) < Math.abs(best.delta) - EPS
            || (approxEqual(delta, best.delta) && target.priority < best.target.priority)) {
          best = { delta, target };
        }
      }
    }

    // Sticky release: an established snap survives until pulled BREAK_FACTOR × threshold away.
    const held = ctx.activeSnap[axis];
    if (held && !best) {
      const drift = Math.abs(held.valueMm - anchorValue(axis, box, held.anchorRole));
      if (drift < thresholdMm * BREAK_FACTOR) best = { delta: held.valueMm - anchorValue(axis, box, held.anchorRole), target: held.target };
    }

    if (best) {
      result.offsetMm[axis] += best.delta;
      guides.push({ axis, valueMm: best.target.valueMm, kind: best.target.kind });
    }
  }

  return { transform: quantize(result), guides };     // quantize → 0.01 mm on commit
}
```

Design rules this encodes:
- **Center and middle lines win** over every other target at equal distance (`priority 0`).
- Thresholds are in **screen pixels**, so zooming in gives finer control automatically.
- Override is always available: `Alt` during a drag, the persistent snap toggle, or simply pulling
  past the break distance. Snapping assists; it never decides.
- Only the guides that actually fired are drawn, and only during the gesture.

## 6. Scaling, rotation, nudge (F-PLACE-07/08/09)

```ts
function scaleFromHandle(start: Transform, handle: HandleId, pointerZone: Vec2, mods: Mods): Transform {
  const local = toLocal(pointerZone, start);                 // rotate into the placement's basis
  const anchor = anchorForHandle(handle, start);             // opposite corner/edge stays put
  const raw = { w: Math.abs(local.x - anchor.x), h: Math.abs(local.y - anchor.y) };

  const proportional = isCorner(handle) ? !mods.shift : mods.shift;   // corners proportional by default
  let size = raw;
  if (proportional) {
    const k = Math.max(raw.w / start.sizeMm.w, raw.h / start.sizeMm.h);
    size = { w: start.sizeMm.w * k, h: start.sizeMm.h * k };
  }
  size = clampSize(size, MIN_SIZE_MM, maxSizeForZone(start, zone));
  return recenterAroundAnchor(start, size, anchor);
}

function rotate(start: Transform, pointerZone: Vec2, mods: Mods): Transform {
  const raw = rad2deg(angleOf(sub(pointerZone, start.offsetMm)));
  const deg = mods.shift ? raw : Math.round(raw / 15) * 15;   // snap by default, Shift frees it
  return { ...start, rotationDeg: normalizeDeg(deg) };
}

const NUDGE_MM = 0.5, NUDGE_FINE_MM = 0.1;                    // arrows / Shift+arrows
```

**Fit / Fill / 100%:**

```ts
function fit(zone, artworkAspect, mode: 'contain'|'cover'|'natural', naturalMm) {
  const w = zone.w - 2 * zone.safeMarginMm, h = zone.h - 2 * zone.safeMarginMm;
  if (mode === 'natural') return naturalMm;
  const k = mode === 'contain' ? Math.min(w / naturalMm.w, h / naturalMm.h)
                               : Math.max(w / naturalMm.w, h / naturalMm.h);
  return { w: naturalMm.w * k, h: naturalMm.h * k };
}
```

Auto-fit on drop uses `contain` scaled to `DEFAULT_FILL = 0.8` of the safe area — big enough to
look intentional, small enough that the first instinct isn't "shrink it".

## 7. Clamping and validation (shared with the API)

```ts
function clampToZone(t: Transform, zone: ZoneBounds): { transform: Transform; hitBoundary: boolean } {
  const box = aabb(t);                                        // rotation-aware
  const halfW = zone.w / 2, halfH = zone.h / 2;
  let dx = 0, dy = 0;
  if (box.min.x < -halfW) dx = -halfW - box.min.x;
  if (box.max.x > +halfW) dx = -halfW + (halfW - box.max.x);  // never both, boxes are convex
  /* same for y */
  const hit = dx !== 0 || dy !== 0;
  return { transform: translate(t, { x: dx, y: dy }), hitBoundary: hit };
}

export function validatePlacement(p: Placement, zone: DecorationZoneDef, art: ArtworkStats): Issue[] {
  const issues: Issue[] = [];
  const c = zone.constraints;
  const box = aabb(p.transform);

  if (outsideZone(box, zone))            issues.push(error('placement_outside_zone'));
  if (!c.finishes.includes(p.finish.kind)) issues.push(error('finish_not_allowed'));
  if (p.finish.kind !== 'print' && p.finish.depthMm > c.maxDepthMm)
                                         issues.push(error('depth_exceeds_max', { max: c.maxDepthMm }));

  const scaleK = p.transform.sizeMm.w / art.naturalSizeMm.w;       // uniform for locked aspect
  const strokeMm = art.minStrokeMm === null ? null : art.minStrokeMm * scaleK;
  if (strokeMm !== null && strokeMm < c.minStrokeMm)
    issues.push(warn('thin_strokes', { actual: strokeMm, min: c.minStrokeMm }));

  if (insideSafeMargin(box, zone) === false)  issues.push(warn('outside_safe_margin'));
  if (art.coverage * area(box) > c.maxCoverage * zoneArea(zone)) issues.push(warn('coverage_high'));

  if (zone.type === 'cylindrical') {
    const wrapDeg = rad2deg(p.transform.sizeMm.w / zone.frame.radiusMm);
    if (wrapDeg > c.wrapWarnDeg) issues.push(warn('wrap_angle_high', { wrapDeg }));
  }
  return issues;
}
```

The editor calls this on every change (fast, pure); `PATCH /api/designs/{id}` calls the same
function and refuses to persist a document with `error`-level issues. One implementation, no drift.

## 8. Zone → shading (hand-off to the preview engine)

The preview composites artwork into a **zone texture** in zone space
([16](16-preview-engine.md)); the mesh shader converts mesh UV → zone coordinates:

```
zoneUv = (zoneCoordFromMeshPoint(p) + halfExtent) / extent      // per zone type, same functions as §2
```

For `uv_rect` zones this is an affine map from the authored UV island — a `mat3` uniform. For
planar/cylindrical/conformal it is the analytic inverse from §2, evaluated in the fragment shader.
The render worker performs the identical mapping when it bakes displacement textures, which is why
the two agree.

## 9. Numerical notes

- Store millimetres as `number`, quantized to **0.01 mm** on commit (not during drag) — prevents
  jitter in the document and keeps diffs meaningful for undo.
- Angles quantized to 0.1°.
- All comparisons use a relative epsilon of `1e-6 mm`; never compare floats for equality.
- Undo granularity: one command per gesture (drag/scale/rotate), not per pointermove.

## Presentation frame boundary

Orientation is a presentation basis, not a geometry transform. Source mesh vertices and physical zone origins/normals/tangents, mapper outputs, relief direction and artwork millimetres stay unchanged. Only camera/studio directions are resolved from Right/Up/Front to source space via shared `@pr/scene` math. The bounding center remains the pivot. Surface alignment takes the selected source-space face normal and projects the current Up into its tangent plane; parallel/zero inputs ask for another Up rather than guessing roll.
