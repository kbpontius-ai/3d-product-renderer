# 14 — Artwork Pipeline (SVG → renderable maps)

Runs inline in the web API via `packages/artworks`; pure logic lives in `packages/svg`,
`packages/raster` and `packages/artwork` so the browser can use the
same profile math. This pipeline is both the security boundary for untrusted input
([05](05-security.md)) and the source of WYSIWYG.

## Invariants

1. **Deterministic:** legacy bytes, or source + canonical preparation recipe, plus pipeline/analyzer
   version ⇒ deterministic output. Existing immutable assets are never rewritten.
2. **Finish-independent storage:** what is stored is *geometry of the artwork* (coverage mask, SDF,
   contours). Depth/bevel/ink are placement parameters applied later, so changing depth costs
   nothing and never re-runs the pipeline.
3. **One canonical coverage core:** the built rasterizer is custom TypeScript in `packages/raster`.
   Saved designs and the render worker consume the stored mask; the demo uses the same pure core
   locally. The resvg/SVGO pseudocode below remains an earlier target, not the installed stack.
4. **Physical units throughout:** every raster records `mmPerPx`; distances are millimetres.

## Stages

| # | Stage | Output | Hard limits |
|---|---|---|---|
| 1 | Intake | verified bytes | ≤ 5 MB, magic bytes, declared + sniffed type |
| 2 | Sanitize | safe SVG string | XML entities disabled, allow-listed elements/attrs |
| 3 | Normalize | canonical SVG | ≤ 5 000 paths, ≤ 200 000 nodes, depth ≤ 32 |
| 4 | Validate | `ArtworkReport` | blocking errors stop here |
| 5 | Rasterize | `mask.png` (8-bit coverage) | 512–4096 px on the long side |
| 6 | Distance field | `sdf.png` (16-bit signed, mm) | same resolution as mask |
| 7 | Contours | `contours.json` | simplified polygons, mm |
| 8 | Thumbnail | `thumb.webp` | 512 px |

Wall-clock budget: 10 s p95, 30 s hard kill.

## Entry point

```ts
async function processArtworkVersion(job: {orgId, artworkId, versionId, sourceKey, digest}) {
  const t = trace.start('artwork.process', { versionId: job.versionId });
  const raw = await storage.get(job.sourceKey);                 // quarantine prefix

  if (raw.byteLength > MAX_BYTES)          return reject('too_large');
  if (!looksLikeSvg(raw))                  return reject('not_svg');

  const text = decodeUtf8Strict(raw);                            // reject invalid UTF-8
  const clean = sanitizeSvg(text);                               // stage 2 — throws on hostile input
  const norm  = normalizeSvg(clean);                             // stage 3
  const report = validate(norm, ZONE_AGNOSTIC_LIMITS);           // stage 4
  if (report.errors.length) return reject(report);

  const naturalMm = naturalSizeMm(norm);                         // from viewBox + units
  const mmPerPx   = chooseResolution(naturalMm);                 // §Resolution policy
  const mask      = await rasterizeAlpha(norm, mmPerPx);         // stage 5, resvg in sandbox
  const sdf       = signedDistanceFieldMm(mask, mmPerPx);        // stage 6
  const contours  = extractContours(norm);                       // stage 7
  const thumb     = await renderThumb(norm, 512);                // stage 8

  await storage.putMany([
    [key(job,'sanitized.svg'), norm],
    [key(job,'mask.png'),      encodePng8(mask)],
    [key(job,'sdf.png'),       encodePng16(sdf.data, {min: sdf.minMm, max: sdf.maxMm})],
    [key(job,'contours.json'), JSON.stringify(contours)],
    [key(job,'thumb.webp'),    thumb],
  ]);

  await db.markReady(job.versionId, { report, naturalMm, mmPerPx, sdfRange: [sdf.minMm, sdf.maxMm] });
  t.end();
}
```

Retries are safe: outputs are content-addressed by `(digest, pipelineVersion)` and writes are
idempotent overwrites of the same keys.

## Stage 2 — Sanitize (security-critical)

```ts
const ALLOWED_ELEMENTS = new Set([
  'svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon',
  'linearGradient','radialGradient','stop','clipPath','mask','use','title','desc','style','symbol',
]);
const ALLOWED_ATTRS = new Set([
  'd','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','points','width','height','viewBox',
  'transform','fill','fill-rule','fill-opacity','stroke','stroke-width','stroke-linecap',
  'stroke-linejoin','stroke-dasharray','opacity','offset','stop-color','stop-opacity',
  'gradientUnits','gradientTransform','clip-path','mask','id','class','style','xmlns',
]);

function sanitizeSvg(text: string): string {
  const doc = parseXml(text, {
    resolveEntities: false,        // blocks XXE and billion-laughs
    loadExternalDtd: false,
    maxDepth: 32, maxNodes: 200_000,
  });

  walk(doc, (node) => {
    if (node.type !== 'element') { if (node.type === 'pi' || node.type === 'doctype') remove(node); return; }
    if (!ALLOWED_ELEMENTS.has(localName(node))) return remove(node);   // drops script, foreignObject, image, font-face…

    for (const attr of node.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on'))            remove(attr);              // event handlers
      else if (!ALLOWED_ATTRS.has(name))    remove(attr);
      else if (hasUrlValue(attr)) {
        const url = extractUrl(attr.value);
        if (!url.startsWith('#')) remove(attr);                        // only same-document refs survive
      }
    }
    if (node.has('style')) node.set('style', filterCssDeclarations(node.get('style')));  // no url(), no @import
  });

  // <use xlink:href> must resolve inside the document; unresolved => drop
  resolveInternalUses(doc);
  assert(!containsScriptableContent(doc));
  return serialize(doc);
}
```

Executed inside the sandbox described in [05](05-security.md): non-root, read-only FS, no network,
CPU/RAM/time rlimits, one process per file.

## Stage 3 — Normalize

```ts
function normalizeSvg(svg: string): string {
  let doc = parse(svg);
  doc = resolveViewBoxAndUnits(doc);          // absolute mm; px assumed 96dpi when unitless
  doc = convertShapesToPaths(doc);            // rect/circle/… → path
  doc = flattenTransforms(doc);               // bake transforms into path data
  doc = expandStrokesToFills(doc);            // stroke geometry becomes outline geometry
  doc = applyClipPathsAndMasks(doc);          // bake to path geometry where possible; else warn+drop
  doc = flattenGradientsForGeometry(doc);     // color info retained separately; geometry is what matters
  doc = unionOverlappingPaths(doc);           // even-odd artifacts would create false emboss holes
  doc = dropEmptyAndInvisible(doc);
  doc = svgo(doc, LOCKED_SVGO_CONFIG);        // config version is part of pipelineVersion
  return serialize(doc);
}
```

Text: if `<text>` survives sanitize it is either outlined using an allow-listed embedded font or
rejected with `text_not_outlined`. Never silently substituted — a substituted font is a wrong logo.

## Stage 4 — Validation

```ts
function validate(svg, limits): ArtworkReport {
  const stats = measure(svg);                 // paths, nodes, bbox, coverage, min stroke width
  const errors = [], warnings = [];

  if (stats.pathCount === 0)                     errors.push(err('empty_after_normalize'));
  if (stats.pathCount > limits.maxPaths ||
      stats.nodeCount > limits.maxNodes)         errors.push(err('complexity_exceeded'));
  if (stats.hasText)                             errors.push(err('text_not_outlined'));

  if (stats.openPathCount > 0)                   warnings.push(warn('open_paths'));
  if (stats.selfIntersections > 0)               warnings.push(warn('self_intersections'));
  if (stats.hasGradients)                        warnings.push(warn('gradients_flattened'));
  if (aspect(stats.bbox) > 20 || aspect < 0.05)  warnings.push(warn('aspect_extreme'));
  return { status: errors.length ? 'rejected' : 'ready', errors, warnings, stats, pipelineVersion };
}
```

Zone-dependent checks (min stroke in mm, coverage vs zone area, depth vs `maxDepthMm`) run **at
placement time**, not here — the same artwork may be legal on one product and not another. That
check lives in `packages/placement` and runs identically in the editor and on `PATCH /api/designs`.

## Stage 5 — Resolution policy

The bevel wall must be several pixels wide or emboss edges alias:

```
wallWidthMm(depth, bevelDeg) = depth / tan(bevelDeg)      // horizontal run of the draft wall
mmPerPx ≤ wallWidthMm(minSupportedDepth = 0.1mm, maxBevel = 60°) / 4   ≈ 0.0144 mm/px
px      = clamp(round(longestSideMm / mmPerPx), 512, 4096)
```

In practice a 25 mm logo lands at 2048 px (≈ 0.012 mm/px, ~82 px/mm). The number is recorded per
asset — nothing downstream assumes a resolution.

## Stage 6 — Signed distance field

```ts
function signedDistanceFieldMm(mask: Gray8, mmPerPx: number) {
  const inside  = euclideanDistanceTransform(mask, {of: 'inside'});   // Felzenszwalb, O(n)
  const outside = euclideanDistanceTransform(mask, {of: 'outside'});
  const sdf = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    const subpixel = (mask[i] / 255 - 0.5);                 // AA coverage → sub-pixel edge offset
    sdf[i] = (inside[i] > 0 ? inside[i] : -outside[i]) * mmPerPx + subpixel * mmPerPx;
  }
  return { data: sdf, minMm: min(sdf), maxMm: max(sdf) };   // positive = inside the artwork
}
```

Encoded as 16-bit PNG with `[minMm, maxMm]` in metadata. The SDF is the reason depth and bevel are
free parameters: the surface profile is a pure function of distance-to-edge.

## The height profile (shared by preview and render)

`packages/artwork/profile.ts` — the single definition of what emboss means. The GLSL preview
implementation and the worker's baking step must agree to within 1e-3 mm (enforced in CI).

```ts
export interface FinishParams { depthMm: number; bevelDeg: number; edgeRadiusMm: number; kind: 'emboss'|'deboss'; }

export function heightMm(dMm: number, p: FinishParams): number {
  if (dMm <= 0) return 0;                                   // outside the artwork: base surface
  const wall = p.depthMm / Math.tan(p.bevelDeg * DEG2RAD);   // draft run; bevelDeg=90 ⇒ wall→0 (vertical)
  const r    = Math.min(p.edgeRadiusMm, wall * 0.5, p.depthMm * 0.5);

  let h: number;
  if (wall <= 1e-6)          h = p.depthMm;                 // vertical wall
  else if (dMm >= wall)      h = p.depthMm;                 // plateau
  else                       h = p.depthMm * (dMm / wall);  // linear draft

  if (r > 0) {                                              // round the top edge over radius r
    const dTop = wall - dMm;                                // distance from the plateau edge
    if (dTop > 0 && dTop < r) {
      const t = dTop / r;
      h = p.depthMm - (p.depthMm - h) * (1 - Math.sqrt(1 - (1 - t) * (1 - t)));
    }
  }
  return p.kind === 'deboss' ? -h : h;
}

// Analytic derivative → normals without sampling neighbours (|∇sdf| = 1)
export function dHeightdD(dMm: number, p: FinishParams): number { /* piecewise derivative of the above */ }
```

**Consequence worth knowing:** a stroke thinner than `2 × wall` never reaches full depth — its peak
is `depth × (halfWidth / wall)`. That is physically correct and is exactly what the `thin_strokes`
warning is telling the user. Preview and render both show it, so the warning matches reality.

## Where height and normal maps come from

- **Preview:** not stored at all. The shader samples `sdf.png` and evaluates `heightMm()` /
  `dHeightdD()` in GLSL per pixel — so dragging the depth slider is free ([16](16-preview-engine.md)).
- **Render:** the worker bakes `height_{placementId}.png` (16-bit, mm-scaled) from the SDF and the
  placement's finish parameters at job-build time, and feeds it to Cycles displacement
  ([17](17-render-service.md)). Baking uses the same TS function, so preview and render share one
  definition.
- Optional cached `height`/`normal` assets exist only to make library thumbnails cheap.

## Caching, dedupe, versioning

```
cacheKey = sha256(sourceBytes) + ':' + pipelineVersion
```

- Re-uploading the same bytes returns the existing version (`200`), deduplicated within the
  organisation and pipeline version. Re-uploading a deleted artwork restores it.
- Bumping `pipelineVersion` does **not** rewrite existing assets. Designs pin `versionId`, so an
  approved render's inputs never change. An "update to latest" action remains planned.
- `pipelineVersion` is part of every render's provenance tuple.

## Whole-artwork editing (`F-ART-11`)

`PUT /api/artworks/{id}` takes a name, expected current version and whole-artwork transform, not
arbitrary new SVG markup. The service reads its sanitised source from storage. The shared
`packages/raster/src/edit.ts` transform converts strokes using the rasteriser’s existing
stroke-to-filled-area routines before stretching, applies size/rotation/flips around the visible
bounds centre, and fits the SVG canvas to the transformed bounds without clipping. The Artwork
viewer uses this same transform for its 2D preview.

The transformed source goes through `prepareArtwork` and the existing raster/SDF/contour pipeline.
Shape edits append an immutable version and update the artwork’s current pointer under a row lock;
the expected version prevents a concurrent edit from being overwritten. Failed adoption cleans
up newly staged files. Name-only edits do not regenerate geometry. Existing designs and renders
continue to load their pinned version, and neither historical source nor derived assets are rewritten.

Rotation can expand or swap the final visible dimensions. Width/height inputs are the dimensions
before rotation. There is no path editor, history browser or automatic update to saved designs.

## Failure taxonomy

| Class | Example | User sees | System does |
|---|---|---|---|
| Rejected input | text not outlined | Specific message + fix hint + report link | Mark `rejected`, keep source 30 days |
| Resource exceeded | 12 000 paths | "Artwork is too complex (12 000 shapes, limit 5 000)" | Reject, log stats |
| Sandbox kill | infinite loop in parser | "We couldn't process this file" | Quarantine sample, alert if rate rises |
| Transient | storage 5xx | "Processing — this is taking longer than usual" | Bounded retry with backoff |
| Poison | repeated crash on same digest | Same as sandbox kill | Quarantine, never auto-retry again |


## Interactive preparation (F-ART-12)

Before legacy derivation, `packages/svg` analyzes a static SVG subset: case-sensitive XML and
SVG namespaces, CSS cascade/used color, transforms, solid paints, per-instance internal reuse,
compound fill rules and supported clip paths. `packages/raster` compiles each object's fill/stroke,
subtracts later occluders, and unions only selected visible paint. The emitted single-color
nonzero contour SVG preserves holes; it feeds existing mask/SDF/contour derivation unchanged.

Original shape/arc data remains in safe styled source and immutable private original bytes.
Only explicit recipe operations change source geometry. Generated filled stroke contours and
implicit SVG fill boundaries are not source repairs. A separate previewed close adds one straight
edge to one subpath; compatible joins resolve chosen endpoints without snapping. Unsupported
styles/effects and unreliable/over-budget geometry stop with a recovery hint, never silent loss.

Geometry stages use 0.001 mm arc, flattening and round-stroke approximation thresholds and a
0.00001 mm integer base grid, refined before enlargement. These are per-stage controls, not a
certified maximum error for every stroked SVG: curve tangents, acute miters, intersecting contours
and very small features can amplify boundary or topology differences. Browser comparisons of
curved/dashed strokes, arcs, clips, counters and reuse measure actual output at 256 and 1,024 px;
they do not establish universal SVG conformance. High-precision intermediate serialization avoids
magnifying coordinate rounding during enlargement. Fine detail still needs inspection at the
intended size; the vector preview explains that placement masks have finite resolution. Limits include 5 MB source, XML depth 32 / 10,000 nodes / 64 attributes,
5,000 expanded objects/groups, 500 CSS rules / 200,000 CSS characters, 100,000 expanded
shape and clipping segments, 8,000,000 expanded source/label characters, attributes up to
200,000 characters (class 4,096; inline style 16,000),
50,000 compiled points and a budget of 200,000 Clipper steps per geometry pass, counted rather
timed so that the same drawing gets the same answer on any machine. Repair comparison also
compiles the prior mark and highlights added/removed visible paint. Changes to transparent counter
areas require review, including paint inside a counter. Clipper is preceded by an edge
complexity guard (1,000,000 comparisons / 50,000 potential intersections); no result is truncated.
There is no native parser sandbox or hard process-kill guarantee in this inline TypeScript path.

Source-backed whole-artwork saves append ordered transforms and replay from original selected
paint before derivation. Legacy saves retain their prior behavior. Dedupe uses canonical recipe
identity, including source SHA-256/analyzer version, under the existing pipeline key and tenant.
See [29](29-artwork-preparation.md) for supported input, review and recovery contracts.
