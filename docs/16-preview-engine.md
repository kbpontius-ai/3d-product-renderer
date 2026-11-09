# 16 — Real-Time Preview Engine

`apps/web` + `packages/materials` + `packages/placement`. three.js/R3F, WebGL2. The preview's job is
not "look nice" — it is to **predict the path-traced render** closely enough that users trust it.

---

## Placement color (F-PREV-09)

The 2D placement surface uses a representative display color, not the material's raw hex plus an
artificial brightness gradient. `PlacementColorSample` draws a 16×16 undecorated swatch with the
Viewer's shared `Environment`, `Backdrop`, `toThreeParams` material mapping and AgX/exposure setup.
It averages the central 4×4 pixels directly from the display framebuffer; an ordinary render target
would bypass Three's display tone mapping. A slightly oblique orthographic camera avoids the
area-light LTC basis singularity at exactly normal incidence.

The swatch faces the zone's center normal (the presentation frame for UV/flat-panel zones) and
uses the part's bounds to scale the studio. Material/color, zone, orientation, lighting, rotation
and background changes invalidate its sample. It runs on demand only while Place or Split is open;
there is no product mesh load or per-drag sampling loop. A loading indicator covers the placement canvas only until the artwork shading matches the current inputs. The color sample does not hold the canvas back: it is a second WebGL scene whose shader compile takes seconds on a slow or software renderer, so the canvas shows the part's own color first and changes to the sampled color when it arrives.
The sample is keyed to its inputs so a previous zone/material's color cannot be shown as current.

Blind artwork uses that sampled color with relative edge shading rather than a second absolute
light calculation. Ink retains its chosen color. Rulers, guides, transforms, saved material colors
and exported render specs are unchanged. This is a representative color match: curved highlights,
mapped textures, transparency through the actual part and view-angle-dependent reflections are
still evaluated on the real product in Viewer. The placement pane is not a flattened 3D render.

Local verification: production build, recursive type-check, lint, environment docs and
bundle budgets pass (editor 656.9 kB gz / 700 kB). Six relevant browser suites pass 38 checks;
four account-dependent orientation checks are skipped on the demo review server. Coverage includes
sampling/color/finish/lighting updates, placement gestures, ruler guides, undo/redo, cross-sections,
relief depth, curved zones and reorientation. A loaded orange Glossy split-view frame was reviewed.
The full unit/integration run passes 1,469 tests, skips seven and retains three failures in untouched
material/migration code: duplicate `pp_material_references` on migration replay, the catalog test's
obsolete `board-coated` expectation, and the fixture conformance test's obsolete paperboard-family
expectation. The entire application browser suite and new Cycles comparisons were not run for this
placement-only change. GitHub CI was not triggered.

The loading follow-up verifies that a loading skeleton covers an invisible canvas until the current
sample and artwork repaint are ready. A DOM-transition browser check covers initial entry and
color/finish/lighting changes without exposing an unmatched frame. The four focused browser suites
pass 26 checks on their first run; one reload timeout passed when rerun with tracing, together with
the loading check. The 12 shading tests, web type-check, lint, production build, bundle budgets and
environment check pass. The full unit and application browser suites were not rerun for this UI
loading follow-up; the unrelated failures above remain outside its scope.

## Scene graph

```
<Canvas>                                    // R3F, WebGL2, no antialias flag (we use post-AA)
  <Stage>
    <Environment hdri={env.hdriKey} />      // PMREM-prefiltered IBL, rotation + exposure from design
    <ProductMesh>                           // GLB LOD0 → LOD1 (progressive)
      {materialSlots.map(slot => <PatchedPhysicalMaterial …/>)}
    </ProductMesh>
    <Backdrop kind={scene.background} />     // studio sweep | solid | transparent
    <ContactShadow />                        // cheap approximation of the render's floor contact
  </Stage>
  <CameraRig />                              // presets from the pack; framing from bounding sphere
  <FaceViewPass />                            // off-screen flattening pass (see 15 §3)
  <EffectComposer>                            // SMAA + optional SSAO; tone mapping is on the renderer
</Canvas>
```

Camera presets are computed from the variant's bounding sphere (`radiusScale`, `azimuth`,
`elevation`), so a new pack gets sensible framing with zero per-product code.

## Zone texture composition (the core trick)

Artwork is never drawn per frame from SVG. On any placement change, one **composite pass** renders
all placements of a zone into zone-space render targets:

```ts
// packages/preview/composeZone.ts   — runs on placement/finish change, not per frame
function composeZone(zone: Zone, placements: Placement[], gl: WebGLRenderer): ZoneTargets {
  const px = zoneTextureSize(zone); // ~ 2048 for a 30 mm zone (≈ 68 px/mm), capped by budget
  const targets = getOrCreateMRT(zone.key, px, [
    'heightGrad', // RGBA16F: R = height (mm), G = dh/dx, B = dh/dy, A = coverage
    'ink', // RGBA8:   ink color + alpha (print/foil/blind)
  ]);

  gl.setRenderTarget(targets);
  gl.clear();
  for (const p of sortByOrder(placements)) {
    const quad = zoneQuadFor(p.transform); // unit square → zone space (15 §4)
    compositeMaterial.uniforms = {
      uSdf: artworkSdfTexture(p.artwork.versionId), // 16-bit signed distance, mm
      uSdfRange: sdfRangeMm(p.artwork.versionId),
      uDepthMm: p.finish.kind === 'print' ? 0 : p.finish.depthMm,
      uBevelDeg: p.finish.bevelDeg ?? 0,
      uEdgeRadius: p.finish.edgeRadiusMm ?? 0,
      uKind: kindEnum(p.finish.kind), // emboss = +1, deboss = -1, print = 0
      uInkColor: inkColorFor(p.finish),
      uMmPerTexel: zoneMmPerTexel(zone, px),
      uModel: placementMatrix(p.transform),
    };
    gl.render(quad, orthoZoneCamera(zone));
  }
  return targets;
}
```

```glsl
// composite fragment shader — the GLSL twin of packages/artwork/profile.ts
float heightMm(float dMm) {
  if (dMm <= 0.0) return 0.0;
  float wall = uBevelDeg >= 89.9 ? 0.0 : uDepthMm / tan(radians(uBevelDeg));
  float r    = min(uEdgeRadius, min(wall * 0.5, uDepthMm * 0.5));
  float h    = wall <= 1e-6 ? uDepthMm : (dMm >= wall ? uDepthMm : uDepthMm * (dMm / wall));
  if (r > 0.0) {                                   // top-edge fillet, identical formulation to TS
    float dTop = wall - dMm;
    if (dTop > 0.0 && dTop < r) {
      float t = dTop / r;
      h = uDepthMm - (uDepthMm - h) * (1.0 - sqrt(1.0 - (1.0 - t) * (1.0 - t)));
    }
  }
  return h;
}

void main() {
  float d = decodeSdf(texture(uSdf, vUv), uSdfRange);           // signed mm, + inside
  float h = heightMm(d) * uKind;                                 // emboss/deboss sign
  // |∇sdf| = 1, so the surface gradient is dh/dd × the SDF gradient
  vec2  g = dHeightdD(d) * uKind * normalize(sdfGradient(uSdf, vUv, uMmPerTexel));
  float coverage = smoothstep(-uMmPerTexel, uMmPerTexel, d);     // antialiased edge
  outHeightGrad = vec4(h, g.x, g.y, coverage);
  outInk        = vec4(uInkColor.rgb, uInkColor.a * coverage);
}
```

Changing depth, bevel, ink, or position re-runs one quad — sub-millisecond. Nothing re-uploads,
nothing re-parses SVG.

## Material patching

```ts
// packages/materials/three.ts
export function toThreeMaterial(def: MaterialDefinition, assign: MaterialAssignment) {
  const m = new MeshPhysicalMaterial({
    color: new Color(assign.colorHex ?? def.base.baseColorHex).convertSRGBToLinear(),
    roughness: assign.overrides?.roughness ?? def.base.roughness,
    metalness: assign.overrides?.metallic ?? def.base.metallic,
    ior: def.base.ior,
    clearcoat: def.base.clearcoat,
    clearcoatRoughness: def.base.clearcoatRoughness,
    sheen: def.base.sheen,
    transmission: def.base.transmission,
    thickness: def.base.thicknessMm,
    specularIntensity: def.base.specular,
    map: tex(def.maps.baseColor),
    roughnessMap: tex(def.maps.roughness),
    normalMap: tex(def.maps.normal),
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uZoneHeightGrad = { value: zoneTargets.heightGrad.texture };
    shader.uniforms.uZoneInk = { value: zoneTargets.ink.texture };
    shader.uniforms.uZoneMapping = { value: zoneMappingUniforms(zone) }; // see 15 §8

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        vec2 zUv = zoneUvFromWorld(vWorldPosition, uZoneMapping);
        if (inUnitRange(zUv)) {
          vec4 hg = texture2D(uZoneHeightGrad, zUv);
          // Perturb the WORLD normal along the zone's own tangent frame — avoids any TBN mismatch
          vec3 T = zoneTangentWorld(vWorldPosition, uZoneMapping);
          vec3 B = cross(normal, T);
          normal = normalize(normal - T * hg.g - B * hg.b);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        vec4 ink = texture2D(uZoneInk, zUv);
        // Coverage, not the ink's alpha. A printed mark covers where its artwork is opaque; a
        // filled relief covers where there is relief to fill, which is how the Cycles graph
        // measures it. The two differ at a bevel — invisible while the fill also changes colour,
        // and the whole signal once it does not (F-MAT-05).
        float cov = zoneInkCoverage(zUv, ink.a);
        // uZoneInkTint is 0 for a clear coating: a spot varnish glosses the mark without painting
        // it, so the colour blend is scaled away while the surface blends run at full coverage.
        diffuseColor.rgb = mix(diffuseColor.rgb, ink.rgb, cov * uZoneInkTint);
        roughnessFactor  = mix(roughnessFactor, uZoneInkRoughness, cov);
        metalnessFactor  = mix(metalnessFactor, uZoneInkMetalness, cov);`,
      );
  };
  return m;
}
```

Deep emboss (> ~0.4 mm) additionally enables parallax occlusion stepping against the height channel,
which recovers the self-occlusion the path tracer produces from real displacement.

## Cross-section (`F-EDIT-11`)

Cutting the product open, without asking anybody to pick a plane.

**Where the planes come from.** `crossSectionPlanes` in `@pr/scene` derives them from what the pack
already declares, in order of how specific the answer is:

| Cut                           | Derived from                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Through the artwork           | the decorated zone's frame — its own normal, so the section shows the mark's depth rather than shaving it off                          |
| Lengthways (×2)               | the part's axis: a cylindrical zone's `axisDir` if one is declared, else the odd extent out when the other two match, else the tallest |
| Across width / height / depth | the bounding box                                                                                                                       |

The axis test is the part worth knowing. A squat closure is 38 mm across and 18 mm tall, so
"longest dimension" calls its axis horizontal and slices it into a disc; _equality of the other
two_ is what identifies a body of revolution. Planes are deduped on their geometry rather than their
name, because a centred logo on a cap top sits on the axis and "through the artwork" and
"lengthways" are then one plane — two buttons drawing an identical picture teach the user the
controls mean nothing.

**The counters are clipped too, and that is the whole trick.** Counting an _unclipped_ mesh
balances — every ray leaves through as many back faces as it entered through front ones — so the
stencil returns to zero everywhere and the cap never draws, at any angle, with no error. The first
version of this feature omitted it and shipped: a closure's own geometry looks plausible from
directly above, which is the angle it was checked from. `apps/web/lib/cross-section.ts` holds the
configuration precisely so `cross-section.test.ts` can read it back.

**Why a cap is not optional.** `clippingPlanes` discard fragments, which on a hollow part leaves you
looking through the cut at the inside of the far wall — a shell with a bite out of it. The cap is
drawn from the stencil buffer: for every mesh, back faces increment and front faces decrement while
writing neither colour nor depth, and wherever the count is left non-zero the viewer is looking
through solid material, so a quad on the plane is drawn exactly there. It counts surfaces crossed
rather than assuming a shape, so hollow, concave and multi-part all come out right. Reusing the
object's own back faces would be a pass cheaper and wrong on exactly the parts this product is for.

**The section includes relief.** The original CAD mesh has no artwork displacement, so counting it
alone fills debossed pockets back to the original surface and leaves embossed sections uncapped.
The stencil also subtracts an undisplaced copy of the zone patch and adds its displaced copy.
Both use the visible patch's height uniforms, displacement shader and support boundary: depth and
placement changes reach the section in the same texture upload. Flat patches cancel; negative
relief removes material and positive relief adds it. This operates at the preview grid's resolution,
not as a CAD boolean or a wall-thickness measurement.

This needs a stencil buffer, which three has defaulted **off** since r163 — hence `stencil: true` on
the `<Canvas>`. Clipping is set per material rather than on the renderer, so the studio and its
backdrop are not sliced along with the product.

**One trap, paid for once.** three compiles the _number_ of clipping planes into the shader, so
going from none to one needs `needsUpdate`. Setting it unconditionally rebuilds the zone material's
program on every pass — and this file holds that material's uniforms by reference so artwork can be
re-uploaded without a rebuild. A recompile hands out fresh uniform objects, the held references go
stale, and the viewport quietly stops following the design. `relief.spec.ts` catches it.

Preview only for now (`F-EDIT-13`), and view state rather than part of the design document: a
section is how somebody is looking at a product, not something about the product. That changes when
the cut reaches Cycles, which needs real geometry — a boolean, not a plane — and brings the section
inside the parity harness. `CrossSectionPlane` is a serialisable struct for exactly that reason.

## Parity with the offline renderer

| Aspect         | Preview                                     | Render                                      | How they're kept equal                                |
| -------------- | ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Height profile | GLSL `heightMm()`                           | TS `heightMm()` baked to a texture          | Same formula; CI sweeps both and compares (≤1e-3 mm)  |
| Materials      | `MeshPhysicalMaterial` from `base`          | Principled BSDF from `base`                 | One neutral definition, two mappings, parity test     |
| Environment    | PMREM of the same `.hdr`                    | Same `.hdr` as world texture                | Same asset, same rotation, same exposure EV           |
| Tone mapping   | `AgXToneMapping`, `outputColorSpace = SRGB` | Blender view transform **AgX**, sRGB output | Pinned pair; a version bump re-runs the parity suite  |
| Exposure       | `toneMappingExposure = 2^ev`                | Film exposure `2^ev`                        | Same `exposureEv` field in the document               |
| Camera         | focal + sensor → FOV                        | focal + sensor                              | Identical formula: `fov = 2·atan(sensor / (2·focal))` |

Known and accepted divergences (documented, budgeted in the SSIM threshold): screen-space contact
shadows vs traced shadows, no caustics/transmission depth for glass (v2 flags transmissive materials
as "preview approximate" in the UI), and **the preview draws product materials double-sided while
Cycles renders the true surface** — so a mesh that is not closed looks solid here and shows its hole
in the render. That is the right way round: a pack should not ship unclosed (`F-ADM-01` raises a
todo on any draft whose parts are not watertight, and the fixture closure is a solid), and where one
does, an odd-looking interior in the preview beats a see-through product.

The displacement silhouette used to be on that list. It is not any more —
[24-displaced-preview.md](24-displaced-preview.md) gives the decorated zone a real subdivided
surface, and the shading split there is chosen so that the fragment slope this page describes is
preserved exactly: what geometry now resolves, the shader stops applying.

## Performance

```ts
// Render-on-demand: the canvas is idle unless something changed.
invalidateOn(['design.*', 'camera.*', 'zoneTexture.*', 'resize', 'assetLoaded']);

const budget = new FrameBudget({ targetMs: 16.6, floorFps: 30 });
budget.onOverrun(() => {
  dropInOrder([
    'pixelRatio → 1.0',
    'SSAO off',
    'parallax off',
    'shadow resolution ½',
    'zone texture 2048 → 1024',
    'LOD1 → LOD0',
  ]);
});
```

- LOD0 (≤150k tris, Draco) streams first; LOD1 loads in the background and swaps silently.
- Textures are KTX2/Basis; zone targets are the only float textures and are pooled per zone.
- Everything disposable is disposed on unmount (`geometry`, `material`, RTs, PMREM) — the editor is
  a long-lived SPA and leaks show up as thermal throttling within minutes.
- Static frames accumulate TAA samples while idle, which also makes the "screenshot" feature clean.

## Face view integration

The 2D face view ([15 §3](15-placement-math.md)) is a second pass over the same scene, not a second
scene: same geometry, same zone textures, flat shading. Consequences: what you position is
literally the object you're looking at, and the two views can never disagree about placement.

## Confirmed orientation and inspection lighting

`Viewport3D` receives the effective presentation frame. Shared `framePreset` resolves semantic Front (0°/0°), Top (0°/90°) and Three-quarter (35°/25°) for explicitly oriented products; pack-specific additional views retain their declared angles. A Top camera uses −Front as camera Up to avoid a singular roll. Legacy presets remain unchanged without a frame; custom cameras stay source-space.

The studio PMREM is baked in its local frame and rotated via `scene.environmentRotation`; direct lights and the visible gradient use the same frame. Rotation does not rebake PMREM on each drag. Clearing inspection restores both reflected and direct lighting. Fiber receives a retained DOM event host because asynchronous canvas initialization can complete after a wizard step unmounts.

`studio-detail-v1` adds an explicit Detail choice with a broad front source, oblique key, restrained fill and rim. Existing studio keys/default remain unchanged. **Inspection** under Viewer lighting uses the active mapper's center normal/tangent where available, otherwise the product frame, plus temporary rotation. It neither persists nor affects exports/thumbnails. The visual target still needs user review on actual materials; orientation alone does not guarantee legible shallow relief at every angle.

The new Detail studio uses three.js rectangular area lights with the shared emitter dimensions,
positions and power converted to radiance. Its environment contains the world gradient only, so
those emitter contributions are not counted twice through PMREM. Original studio profiles retain
their existing approximation. The Detail profile uses source +Y as its gradient Up until a confirmed
product/design frame provides Up; Cycles follows the same rule.

## Decoration target selection (`F-PREV-08`)

A zone may name `materialSlotKey`, the part carrying its artwork. Draft zone authoring exposes
**Artwork target part** using the variant's declared material slots. Preview and Cycles share the
same resolver: an explicit target must be drawable; an absent target preserves a drawable legacy
first slot, otherwise a unique drawable replacement is selected. Multiple replacements require
an explicit target. Historical unnamed/unrecognized GLB material names keep their legacy first-slot
mapping. Empty primitives are excluded from sampling; no source coordinates or artwork depth change.

Initial orientation setup and design reorientation both use temporary Detail lighting, including
the Front preview. The wizard does not save its studio, change material assignments or change relief
depth. The editor's Lighting preset selector persists Detail when the user chooses it for final exports.
The ambient fill remains restrained so broad illumination does not erase the relief highlights.
