import * as THREE from 'three';
import type { DecorationZoneDef } from '@pr/design-schema';
import { zoneExtentMm } from '@pr/design-schema';
import { anyPerpendicular, cross, normalize, orthogonalize } from '@pr/placement';

/**
 * Applies a zone's artwork to a product material.
 *
 * Zone coordinates are computed analytically — the same mapping `packages/placement` implements on
 * the CPU and the render worker builds as a Cycles node group (docs/17-render-service.md), which is
 * what F-PREV-02 asks for: emboss and deboss with a millimetre-correct depth response.
 *
 * Since `F-PREV-06` there are two of these rather than one, built together so they cannot drift
 * (docs/24-displaced-preview.md):
 *
 * - **`base`** shades the product itself. When a patch is covering the zone it also punches a hole,
 *   because a deboss dips below the original surface and the coarse product mesh would otherwise
 *   occlude the pocket entirely.
 * - **`patch`** shades the dense zone surface, and displaces it in the vertex shader.
 *
 * The two split the relief's slope by scale. Geometry resolves what the vertex grid can carry; the
 * fragment shader adds only the residual — the difference between the slope at texel scale and the
 * slope at vertex scale. They sum to exactly the slope the single-surface shader applied before
 * this existed, so the shading the parity baselines were measured against does not move while
 * silhouette, parallax and occlusion are gained.
 */

/**
 * planar/conformal, cylindrical, uv-space, and 3: a conformal zone whose coordinates the product's
 * vertices carry (`aZoneMm`, from `surfaceCoordinates`), because a walked surface has no analytic
 * inverse for the shader to evaluate.
 */
export type ZoneKind = 0 | 1 | 2 | 3;
export type ZoneMaterialRole = 'base' | 'patch';

export interface ZoneUniformValues {
  kind: ZoneKind;
  origin: THREE.Vector3;
  tangent: THREE.Vector3;
  bitangent: THREE.Vector3;
  normal: THREE.Vector3;
  halfExtent: THREE.Vector2;
  radius: number;
  centerAngle: number;
  centerHeight: number;
  uvRect: THREE.Vector4;
  /**
   * How far off the zone's own surface a fragment may be and still count as inside the zone.
   *
   * Without this a zone is a rectangle in two coordinates and unbounded in the third: on a closure,
   * the inside of the bore satisfies a skirt zone's angle and height exactly as the outside does,
   * and differs only in a radius nothing was checking. That put artwork on surfaces it was never
   * placed on — tolerable while the zone only tinted pixels, and a hole straight through the part
   * once the base material started discarding them.
   */
  surfaceToleranceMm: number;
  /** Minimum dot(surface normal, zone normal) for a fragment to belong to a frame-based zone. */
  alignmentMin: number;
}

const toVector = (v: readonly [number, number, number]) => new THREE.Vector3(v[0], v[1], v[2]);

/*
 * How parallel the surface must be for a zone to own it.
 *
 * Defined in `@pr/placement` and re-exported here. Two consumers have to agree about it — this
 * shader, which decides what the base draws as zone, and the patch's own support test, which
 * decides what the dense surface covers. They were separate numbers once: the shader was tightened
 * to ten degrees for a planar zone and the patch was left at sixty, so the base stopped claiming a
 * closure's fillet while the patch went on laying a sheet over it, offset toward the camera. That
 * is what the four tabs on the rim were.
 */
import { zoneAlignmentMin } from '@pr/placement';
export { PLANAR_ZONE_ALIGNMENT, CONFORMAL_ZONE_ALIGNMENT, zoneAlignmentMin } from '@pr/placement';

function surfaceTolerance(zone: DecorationZoneDef): number {
  if (zone.type === 'conformal') return zone.frame.maxProjectionDepthMm;
  return Math.max(1, zone.constraints.maxDepthMm * 3);
}

export function zoneUniformValues(zone: DecorationZoneDef): ZoneUniformValues {
  const base: ZoneUniformValues = {
    kind: 0,
    origin: new THREE.Vector3(),
    tangent: new THREE.Vector3(1, 0, 0),
    bitangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    halfExtent: new THREE.Vector2(1, 1),
    radius: 1,
    centerAngle: 0,
    centerHeight: 0,
    uvRect: new THREE.Vector4(0, 0, 1, 1),
    surfaceToleranceMm: surfaceTolerance(zone),
    alignmentMin: zoneAlignmentMin(zone),
  };

  switch (zone.type) {
    case 'planar':
    case 'conformal': {
      const n = normalize(zone.frame.normal);
      const t = orthogonalize(zone.frame.tangent, n);
      const b = cross(n, t);
      return {
        ...base,
        kind: 0,
        origin: toVector(zone.frame.originMm),
        tangent: toVector(t),
        bitangent: toVector(b),
        normal: toVector(n),
        halfExtent: new THREE.Vector2(zone.sizeMm.width / 2, zone.sizeMm.height / 2),
      };
    }

    case 'cylindrical': {
      const a = normalize(zone.frame.axisDir);
      const u = anyPerpendicular(a);
      const v = cross(a, u);
      return {
        ...base,
        kind: 1,
        origin: toVector(zone.frame.axisOriginMm),
        tangent: toVector(u),
        bitangent: toVector(v),
        normal: toVector(a), // the axis: cylindrical zones measure height along it
        halfExtent: new THREE.Vector2(zone.sizeMm.arcWidthMm / 2, zone.sizeMm.height / 2),
        radius: zone.frame.radiusMm,
        centerAngle: (zone.frame.centerAngleDeg * Math.PI) / 180,
        centerHeight: zone.frame.centerHeightMm,
      };
    }

    case 'uv_rect':
    case 'flat_panel': {
      const { w, h } = zoneExtentMm(zone);
      return {
        ...base,
        kind: 2,
        halfExtent: new THREE.Vector2(w / 2, h / 2),
        uvRect: new THREE.Vector4(zone.uvRect.u0, zone.uvRect.v0, zone.uvRect.u1, zone.uvRect.v1),
      };
    }
  }
}

export interface ZoneLayerTextures {
  height: THREE.Texture;
  ink: THREE.Texture;
  /** Millimetres per texel of the zone textures, for differentiating the height layer. */
  texelMm: THREE.Vector2;
  /** Texture-space step matching one texel. */
  texelUv: THREE.Vector2;
  heightRangeMm: number;
  inkRoughness: number;
  inkMetalness: number;
  /** 0 for a clear coating, 1 for anything that paints. See `uZoneInkTint`. */
  inkTint: number;
  /** 1 when the mark is a filled relief, so coverage is measured from depth as Cycles measures it. */
  inkFromHeight: number;
}

/** What the patch surface, if any, resolves on its own — so the shader can stop reapplying it. */
export interface ZonePatchScale {
  /** Zone-texture UV step matching one patch vertex spacing. */
  stepUv: THREE.Vector2;
  /** Millimetres of one patch vertex spacing. */
  spacingMm: THREE.Vector2;
}

export interface ZoneMaterialOptions {
  /** Present when a dense patch is covering the zone; absent means today's single-surface path. */
  patch?: ZonePatchScale | null | undefined;
  /** Height-field ambient occlusion (`F-PREV-07`). The first thing the quality ladder drops. */
  ambientOcclusion?: boolean;
}

export interface ZoneMaterialHandles {
  material: THREE.MeshPhysicalMaterial;
  uniforms: Record<string, THREE.IUniform>;
}

export interface ZoneMaterialSet {
  base: ZoneMaterialHandles;
  /** Null when no patch is being rendered — the base then carries the whole relief on its own. */
  patch: ZoneMaterialHandles | null;
  uniforms: Record<string, THREE.IUniform>;
  dispose(): void;
}

/** Occlusion reach, in millimetres of zone surface. Scaled to the relief, not to the product. */
function aoRadiusMm(heightRangeMm: number): number {
  return Math.min(1.5, Math.max(0.3, heightRangeMm * 2));
}

const AO_STRENGTH = 0.85;

/**
 * Shared GLSL, in both roles and in both stages.
 *
 * `zoneSlope` takes the scale it should measure at, which is the whole trick: the vertex shader
 * asks for the slope at the patch's vertex spacing (what the geometry will actually have) and the
 * fragment shader asks for it at both scales and applies only the difference.
 */
const ZONE_SAMPLING_GLSL = /* glsl */ `
  uniform sampler2D uZoneHeight;
  uniform vec2 uZoneTexelMm;
  uniform vec2 uZoneTexelUv;
  uniform float uZoneHeightRange;
  uniform vec2 uZonePatchStepUv;
  uniform vec2 uZonePatchSpacingMm;

  float zoneHeightMm(vec2 uv) {
    return (texture2D(uZoneHeight, uv).r * 2.0 - 1.0) * uZoneHeightRange;
  }

  bool zoneHasRelief(vec2 uv) {
    // Canvas clears to code 128, whose decoded height is slightly positive. Compare codes so
    // blank substrate disappears without clipping a one-code emboss or deboss at any depth range.
    return abs(texture2D(uZoneHeight, uv).r - 128.0 / 255.0) > 0.5 / 255.0;
  }

  // Central differences in zone space. Both numerator and denominator are millimetres, so the
  // result is a dimensionless slope. Texture v runs opposite to zone y, hence hU - hD.
  vec2 zoneSlope(vec2 uv, vec2 stepUv, vec2 stepMm) {
    float hR = zoneHeightMm(uv + vec2(stepUv.x, 0.0));
    float hL = zoneHeightMm(uv - vec2(stepUv.x, 0.0));
    float hD = zoneHeightMm(uv + vec2(0.0, stepUv.y));
    float hU = zoneHeightMm(uv - vec2(0.0, stepUv.y));
    return vec2((hR - hL) / (2.0 * stepMm.x), (hU - hD) / (2.0 * stepMm.y));
  }
`;

/**
 * Horizon-estimated occlusion in zone space (`F-PREV-07`).
 *
 * Eight directions, three steps each: a point at the bottom of a debossed stroke sees walls rising
 * in most directions and darkens; a point on the flat field sees none. This is the contact
 * darkening the path tracer gets for free from real displacement, and the preview has never had it
 * — the canvas is created without `shadows`, so nothing in the scene casts one.
 */
const ZONE_AO_GLSL = /* glsl */ `
  uniform vec2 uZoneAoRadiusUv;
  uniform float uZoneAoRadiusMm;
  uniform float uZoneAoStrength;

  float zoneOcclusion(vec2 uv) {
    if (uZoneAoStrength <= 0.0) return 1.0;
    float h0 = zoneHeightMm(uv);
    float occluded = 0.0;

    for (int d = 0; d < 8; d++) {
      float angle = float(d) * 0.7853981634;   // 2 pi / 8
      vec2 direction = vec2(cos(angle), sin(angle));
      float steepest = 0.0;
      for (int s = 1; s <= 3; s++) {
        float t = float(s) / 3.0;
        float rise = zoneHeightMm(uv + direction * uZoneAoRadiusUv * t) - h0;
        steepest = max(steepest, rise / max(1e-4, uZoneAoRadiusMm * t));
      }
      occluded += clamp(steepest, 0.0, 1.0);
    }

    return 1.0 - uZoneAoStrength * occluded * 0.125;
  }
`;

/**
 * Ink, roughness and metalness from the ink layer. Identical in both roles.
 */
const ZONE_INK_GLSL = /* glsl */ `
  uniform sampler2D uZoneInk;
  uniform float uZoneInkRoughness;
  uniform float uZoneInkMetalness;
  // 0 for a clear coating. A spot varnish covers the mark and changes how it takes the light
  // without changing its colour, so the roughness and metalness blends run at full coverage while
  // the colour blend is scaled to nothing.
  uniform float uZoneInkTint;
  // 1 where the mark is filled relief rather than print.
  uniform float uZoneInkFromHeight;

  /**
   * How much of the mark covers this fragment, 0..1.
   *
   * A printed mark covers where its artwork is opaque, which is what the ink layer's alpha says.
   * A *filled* relief covers where there is relief to fill, which is what its depth says — and the
   * Cycles graph measures it that way, in millimetres, off the same threshold. The two used to
   * disagree here: the preview took the ink alpha for both, so a fill whose only effect is
   * specular — a clear gloss varnish — landed over a different area in each renderer. Invisible
   * while the fill also changed colour, and the whole of the signal once it did not.
   */
  float zoneInkCoverage(vec2 uv, float inkAlpha) {
    float relief = clamp(abs(zoneHeightMm(uv)) / 0.02, 0.0, 1.0);
    return mix(inkAlpha, relief, uZoneInkFromHeight);
  }
`;

/** Zone uniforms only the base role needs: it has to work out where it is from world position. */
const ZONE_MAPPING_GLSL = /* glsl */ `
  uniform int uZoneKind;
  uniform vec3 uZoneOrigin;
  uniform vec3 uZoneTangent;
  uniform vec3 uZoneBitangent;
  uniform vec3 uZoneNormal;
  uniform vec2 uZoneHalfExtent;
  uniform float uZoneRadius;
  uniform float uZoneCenterAngle;
  uniform float uZoneCenterHeight;
  uniform vec4 uZoneUvRect;
  uniform float uZoneSurfaceTol;
  uniform float uZoneAlignMin;
  uniform float uZonePatchActive;
`;

function buildUniforms(
  zone: ZoneUniformValues,
  layers: ZoneLayerTextures,
  options: ZoneMaterialOptions,
): Record<string, THREE.IUniform> {
  const size = new THREE.Vector2(zone.halfExtent.x * 2, zone.halfExtent.y * 2);
  const radiusMm = aoRadiusMm(layers.heightRangeMm);

  return {
    uZoneHeight: { value: layers.height },
    uZoneInk: { value: layers.ink },
    uZoneTexelMm: { value: layers.texelMm },
    uZoneTexelUv: { value: layers.texelUv },
    uZoneHeightRange: { value: layers.heightRangeMm },
    uZoneInkRoughness: { value: layers.inkRoughness },
    uZoneInkMetalness: { value: layers.inkMetalness },
    uZoneInkTint: { value: layers.inkTint },
    uZoneInkFromHeight: { value: layers.inkFromHeight },
    uZoneKind: { value: zone.kind },
    uZoneOrigin: { value: zone.origin },
    uZoneTangent: { value: zone.tangent },
    uZoneBitangent: { value: zone.bitangent },
    uZoneNormal: { value: zone.normal },
    uZoneHalfExtent: { value: zone.halfExtent },
    uZoneRadius: { value: zone.radius },
    uZoneCenterAngle: { value: zone.centerAngle },
    uZoneCenterHeight: { value: zone.centerHeight },
    uZoneUvRect: { value: zone.uvRect },
    uZoneSurfaceTol: { value: zone.surfaceToleranceMm },
    uZoneAlignMin: { value: zone.alignmentMin },
    uZonePatchActive: { value: options.patch ? 1 : 0 },
    uZonePatchStepUv: { value: options.patch?.stepUv ?? new THREE.Vector2(1, 1) },
    uZonePatchSpacingMm: { value: options.patch?.spacingMm ?? new THREE.Vector2(1, 1) },
    uZoneAoRadiusUv: {
      value: new THREE.Vector2(
        radiusMm / Math.max(1e-3, size.x),
        radiusMm / Math.max(1e-3, size.y),
      ),
    },
    uZoneAoRadiusMm: { value: radiusMm },
    uZoneAoStrength: { value: options.ambientOcclusion === false ? 0 : AO_STRENGTH },
  };
}

/**
 * Builds both roles from one definition.
 *
 * They share uniform objects, so a texture upload or a depth change reaches both in one write —
 * two materials with two copies of the same uniforms is how a preview ends up showing the artwork
 * at one depth on the product and another on the patch.
 */
export function createZoneMaterials(
  base: THREE.MeshPhysicalMaterialParameters,
  zone: ZoneUniformValues,
  layers: ZoneLayerTextures,
  options: ZoneMaterialOptions = {},
): ZoneMaterialSet {
  const uniforms = buildUniforms(zone, layers, options);
  const baseHandles = buildRole('base', base, zone, uniforms);
  const patchHandles = options.patch ? buildRole('patch', base, zone, uniforms) : null;

  return {
    base: baseHandles,
    patch: patchHandles,
    uniforms,
    dispose() {
      baseHandles.material.dispose();
      patchHandles?.material.dispose();
    },
  };
}

/**
 * The single-surface material, for callers that do not render a patch.
 *
 * Kept because it is the fallback path: a zone whose type cannot produce a patch, or a device the
 * quality ladder has taken geometry away from, still has to show the relief.
 */
export function createZoneMaterial(
  base: THREE.MeshPhysicalMaterialParameters,
  zone: ZoneUniformValues,
  layers: ZoneLayerTextures,
  options: ZoneMaterialOptions = {},
): ZoneMaterialHandles {
  const uniforms = buildUniforms(zone, layers, { ...options, patch: null });
  return buildRole('base', base, zone, uniforms);
}

function buildRole(
  role: ZoneMaterialRole,
  base: THREE.MeshPhysicalMaterialParameters,
  zone: ZoneUniformValues,
  uniforms: Record<string, THREE.IUniform>,
): ZoneMaterialHandles {
  const material = new THREE.MeshPhysicalMaterial(base);
  material.defines = { ...(material.defines ?? {}), USE_UV: '' };
  material.side = THREE.DoubleSide;

  if (role === 'patch') {
    // Feathered relief approaches the substrate closely enough to z-fight. Bias depth rather
    // than position to break that tie without moving anything anybody can measure.
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      role === 'patch' ? patchVertex(shader.vertexShader) : baseVertex(shader.vertexShader, zone.kind);
    shader.fragmentShader =
      role === 'patch'
        ? patchFragment(shader.fragmentShader)
        : baseFragment(shader.fragmentShader, zone.kind);
  };

  // Two roles compile to different programs and must not share a cache entry, or three.js hands
  // the patch the base's shader and the relief silently stops displacing.
  material.customProgramCacheKey = () => `zone-${zone.kind}-${role}`;
  return { material, uniforms };
}

// ---------------------------------------------------------------------------------------------
// base role — the product's own surface

// Only kind 3 declares the carried coordinates, so every other kind compiles exactly the program it
// always has and its parity baselines have nothing to move.
function baseVertex(source: string, kind: ZoneKind): string {
  const carried = kind === 3;
  return source
    .replace(
      '#include <common>',
      `#include <common>
       varying vec3 vZoneWorldPos;
       varying vec3 vZoneWorldNormal;${carried ? CARRIED_DECLARE_GLSL : ''}`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vZoneWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
       vZoneWorldNormal = normalize(mat3(modelMatrix) * normal);${carried ? CARRIED_PASS_GLSL : ''}`,
    );
}

const CARRIED_DECLARE_GLSL = `
       attribute vec3 aZoneMm;
       varying vec3 vZoneMm;`;

const CARRIED_PASS_GLSL = `
       vZoneMm = aZoneMm;`;

/*
 * Kind 3 reads its zone millimetres off the vertex rather than working them out. The third
 * component is 1 on every vertex that belongs to the zone's surface, so a triangle with any vertex
 * that does not interpolates below 1 and stays out of the zone.
 */
const CARRIED_MAPPING_GLSL = /* glsl */ `if (uZoneKind == 3) {
             zoneMm = vZoneMm.xy;
             facing = vZoneMm.z > 0.999;
           } else `;

// The zone's directions on a curved surface, from how its coordinates change across the screen —
// the same construction the UV branch uses, with zone millimetres in place of UVs.
const CARRIED_FRAME_GLSL = /* glsl */ `if (uZoneKind == 3) {
               vec3 dPdx = dFdx(vZoneWorldPos);
               vec3 dPdy = dFdy(vZoneWorldPos);
               vec2 dMdx = dFdx(vZoneMm.xy);
               vec2 dMdy = dFdy(vZoneMm.xy);
               float det = dMdx.x * dMdy.y - dMdy.x * dMdx.y;
               zoneT = abs(det) < 1e-12 ? uZoneTangent
                                        : normalize((dPdx * dMdy.y - dPdy * dMdx.y) / det);
               zoneB = normalize(cross(normalize(vZoneWorldNormal), zoneT));
             } else `;

function baseFragment(source: string, kind: ZoneKind): string {
  const carried = kind === 3;
  return (
    source
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vZoneWorldPos;
         varying vec3 vZoneWorldNormal;${carried ? '\n         varying vec3 vZoneMm;' : ''}
         ${ZONE_SAMPLING_GLSL}
         ${ZONE_AO_GLSL}
         ${ZONE_INK_GLSL}
         ${ZONE_MAPPING_GLSL}

         vec2 zoneUv_;
         bool zoneInside_;
         vec4 zoneInk_;
       float zoneInkCov_;
         float zoneAo_ = 1.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec2 zoneMm = vec2(0.0);
           bool facing = true;

           ${carried ? CARRIED_MAPPING_GLSL : ''}if (uZoneKind == 0) {
             vec3 rel = vZoneWorldPos - uZoneOrigin;
             zoneMm = vec2(dot(rel, uZoneTangent), dot(rel, uZoneBitangent));
             /*
              * On this flat face, not merely near its plane and pointing roughly upward.
              *
              * Both halves are needed — a parallel face further down the part passes the alignment
              * test on its own — but the alignment has to be strict, and at sixty degrees it was
              * not. A closure's fillet rolls from the top face to the skirt inside about a
              * millimetre, so every part of it steeper than sixty degrees still counted, and it sits
              * well inside the 1.8 mm plane tolerance the whole way down.
              *
              * That is invisible along the zone's edges, where a 30 mm square on a 38 mm disc stops
              * 4 mm short of the rim — and very visible at its corners, which reach 21.2 mm and are
              * the only places the rectangle overlaps the fillet at all. The result was four tabs of
              * rim, at 45, 135, 225 and 315 degrees, shaded as though they were the flat top while
              * the patch (which clips on distance, and stops correctly) left them uncovered.
              *
              * A planar zone is authored on something flat, so the surface under it should be
              * parallel to it, not within sixty degrees of it. Ten degrees is loose enough for
              * tessellation and mould draft and tight enough that the fillet's first ring — fifteen
              * degrees over on this closure — is already out.
              */
             facing = dot(normalize(vZoneWorldNormal), uZoneNormal) > uZoneAlignMin
                   && abs(dot(rel, uZoneNormal)) <= uZoneSurfaceTol;
           } else if (uZoneKind == 1) {
             vec3 rel = vZoneWorldPos - uZoneOrigin;
             float height = dot(rel, uZoneNormal);
             float theta = atan(dot(rel, uZoneBitangent), dot(rel, uZoneTangent));
             float delta = theta - uZoneCenterAngle;
             delta = mod(delta + PI, 2.0 * PI) - PI;   // shortest way round the axis
             zoneMm = vec2(delta * uZoneRadius, height - uZoneCenterHeight);
             /*
              * The bore of a closure shares this angle and height with the skirt, so something has
              * to separate them — and radius alone cannot, because the fillet between the top face
              * and the wall sweeps through the same band on its way down. What separates them is
              * which way they face: the skirt outward from the axis, the bore into the cavity.
              *
              * Both tests, then. Radius keeps a coaxial surface further in or out from counting;
              * the outward test keeps the inside of the part from counting at any radius.
              */
             vec3 radialDir = rel - uZoneNormal * height;
             float radial = length(radialDir);
             bool outward = radial > 1e-4
                         && dot(normalize(vZoneWorldNormal), radialDir / radial) > 0.0;
             facing = abs(dot(normalize(vZoneWorldNormal), uZoneNormal)) < 0.7
                   && outward
                   && abs(radial - uZoneRadius) <= uZoneSurfaceTol;
           } else {
             vec2 span = vec2(uZoneUvRect.z - uZoneUvRect.x, uZoneUvRect.w - uZoneUvRect.y);
             vec2 t = (vUv - uZoneUvRect.xy) / span;
             zoneMm = (t - 0.5) * (2.0 * uZoneHalfExtent);
           }

           vec2 uv = zoneMm / (2.0 * uZoneHalfExtent) + 0.5;
           uv.y = 1.0 - uv.y;   // zone space is +y up; textures are +y down
           zoneUv_ = uv;
           zoneInside_ = facing && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;

           /*
            * Get out of the patch's way, but only where the patch is actually below this surface.
            *
            * The obvious rule — discard the whole zone footprint — cannot be made to work at the
            * edges. The zone is a rectangle and the face it sits on is not, so on a round top face
            * the patch's own boundary runs along the rim, and the two boundaries are decided by
            * different things: the product's by its rectangle, the patch's by where the part has
            * surface. They agree to within a fraction of a grid cell, and the disagreement shows
            * as a hairline of background through the rim of the product.
            *
            * Discarding on depth instead removes the conflict rather than tightening it. A deboss
            * dips below the original surface and genuinely needs the product out of the way; an
            * emboss stands proud of it and wins the depth test on its own; and everywhere the
            * relief is flat — which is most of the zone, and all of it near the rim — the product
            * keeps drawing and the patch discards its blank pixels. The shared neutral-code test
            * prevents a shallow pocket from losing both surfaces at its feathered edge.
            */
           if (uZonePatchActive > 0.5 && zoneInside_ && zoneHasRelief(uv) && zoneHeightMm(uv) < 0.0) discard;

           zoneInk_ = zoneInside_ ? texture2D(uZoneInk, uv) : vec4(0.0);
           zoneInkCov_ = zoneInside_ ? zoneInkCoverage(uv, zoneInk_.a) : 0.0;
           if (zoneInside_) zoneAo_ = zoneOcclusion(uv);

           diffuseColor.rgb = mix(diffuseColor.rgb, zoneInk_.rgb, zoneInkCov_ * uZoneInkTint);
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(roughnessFactor, uZoneInkRoughness, zoneInkCov_);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
         metalnessFactor = mix(metalnessFactor, uZoneInkMetalness, zoneInkCov_);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         if (zoneInside_) {
           vec2 slope = zoneSlope(zoneUv_, uZoneTexelUv, uZoneTexelMm);

           if (abs(slope.x) + abs(slope.y) > 1e-5) {
             vec3 zoneT;
             vec3 zoneB;

             ${carried ? CARRIED_FRAME_GLSL : ''}if (uZoneKind == 0) {
               zoneT = uZoneTangent;
               zoneB = uZoneBitangent;
             } else if (uZoneKind == 1) {
               vec3 rel = vZoneWorldPos - uZoneOrigin;
               vec3 radial = normalize(rel - uZoneNormal * dot(rel, uZoneNormal));
               zoneT = normalize(cross(uZoneNormal, radial)); // circumferential
               zoneB = uZoneNormal;                            // along the axis
             } else {
               vec3 dPdx = dFdx(vZoneWorldPos);
               vec3 dPdy = dFdy(vZoneWorldPos);
               vec2 dUVdx = dFdx(vUv);
               vec2 dUVdy = dFdy(vUv);
               float det = dUVdx.x * dUVdy.y - dUVdy.x * dUVdx.y;
               zoneT = abs(det) < 1e-12 ? vec3(1.0, 0.0, 0.0)
                                        : normalize((dPdx * dUVdy.y - dPdy * dUVdx.y) / det);
               zoneB = normalize(cross(normalize(vZoneWorldNormal), zoneT));
             }

             // \`normal\` here is in view space; the zone frame is in world space. Perturbing one by
             // the other made the relief's lighting rotate with the camera, which reads as artwork
             // painted on rather than cut in — the exact complaint F-PREV-06 exists to answer.
             mat3 toView = mat3(viewMatrix);
             normal = normalize(normal - normalize(toView * zoneT) * slope.x
                                       - normalize(toView * zoneB) * slope.y);
           }
         }`,
      )
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${applyZoneAo()}`)
  );
}

// ---------------------------------------------------------------------------------------------
// patch role — the dense surface laid over the zone

/** Shared by the visible patch and stencil counters, which must describe the same surface. */
export function patchSurfaceVertex(source: string, displaced = true): string {
  return source
    .replace(
      '#include <common>',
      `#include <common>
       attribute vec2 aZoneUv;
       attribute float aZoneSupport;
       varying float vZoneSupportPatch;
       varying vec2 vZoneUvPatch;
       ${ZONE_SAMPLING_GLSL}`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vZoneSupportPatch = aZoneSupport;
       vZoneUvPatch = aZoneUv;
       ${displaced ? 'transformed += normal * zoneHeightMm(aZoneUv);' : ''}`,
    );
}

/** Blank grid cells must not change substrate shading or contribute a phantom section surface. */
export function patchSurfaceFragment(source: string): string {
  return source
    .replace(
      '#include <common>',
      `#include <common>\nvarying float vZoneSupportPatch;\nvarying vec2 vZoneUvPatch;\n${ZONE_SAMPLING_GLSL}`,
    )
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
       if (vZoneSupportPatch < 0.5) discard;
       if (!zoneHasRelief(vZoneUvPatch)) discard;`,
    );
}

function patchVertex(source: string): string {
  return patchSurfaceVertex(source)
    .replace(
      '#include <common>',
      `#include <common>
       attribute vec3 aZoneTangent;
       varying vec3 vZoneTangentPatch;
       varying vec3 vZoneBitangentPatch;`,
    )
    .replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
       {
         // The normal the displaced mesh actually has: the slope measured at the vertex spacing,
         // which is the finest detail this grid can carry. Everything finer is the fragment
         // shader's job (docs/24-displaced-preview.md, decision 4).
         vec2 coarse = zoneSlope(aZoneUv, uZonePatchStepUv, uZonePatchSpacingMm);
         vec3 zoneB = cross(normal, aZoneTangent);
         objectNormal = normalize(normal - aZoneTangent * coarse.x - zoneB * coarse.y);

         vZoneTangentPatch = normalize(mat3(modelMatrix) * aZoneTangent);
         vZoneBitangentPatch = normalize(mat3(modelMatrix) * zoneB);
       }`,
    );
}

function patchFragment(source: string): string {
  return patchSurfaceFragment(source)
    .replace(
      ZONE_SAMPLING_GLSL,
      `${ZONE_SAMPLING_GLSL}
       varying vec3 vZoneTangentPatch;
       varying vec3 vZoneBitangentPatch;
       ${ZONE_AO_GLSL}
       ${ZONE_INK_GLSL}

       vec4 zoneInk_;
       float zoneInkCov_;
       float zoneAo_ = 1.0;`,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       {
         // The patch *is* the zone, so there is nothing to test and nothing to invert. Reading the
         // zone coordinate off the varying is also the only correct option: the vertex has moved
         // off the analytic surface by the relief depth, so inverting its world position would
         // report a zone coordinate wrong by exactly that much.
         zoneInk_ = texture2D(uZoneInk, vZoneUvPatch);
         zoneInkCov_ = zoneInkCoverage(vZoneUvPatch, zoneInk_.a);
         zoneAo_ = zoneOcclusion(vZoneUvPatch);
         diffuseColor.rgb = mix(diffuseColor.rgb, zoneInk_.rgb, zoneInkCov_ * uZoneInkTint);
       }`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       roughnessFactor = mix(roughnessFactor, uZoneInkRoughness, zoneInkCov_);`,
    )
    .replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
       metalnessFactor = mix(metalnessFactor, uZoneInkMetalness, zoneInkCov_);`,
    )
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
       {
         // Only the residual: what the height field has that the vertex grid could not resolve.
         // When the grid is as fine as the texture this falls to zero on its own — no flag, no
         // threshold — and the geometry carries the whole relief.
         vec2 fine = zoneSlope(vZoneUvPatch, uZoneTexelUv, uZoneTexelMm);
         vec2 coarse = zoneSlope(vZoneUvPatch, uZonePatchStepUv, uZonePatchSpacingMm);
         vec2 residual = fine - coarse;

         if (abs(residual.x) + abs(residual.y) > 1e-5) {
           mat3 toView = mat3(viewMatrix);
           normal = normalize(normal - normalize(toView * vZoneTangentPatch) * residual.x
                                     - normalize(toView * vZoneBitangentPatch) * residual.y);
         }
       }`,
    )
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${applyZoneAo()}`);
}

/**
 * Occlusion goes on indirect light only, exactly as three.js applies a baked AO map.
 *
 * Multiplying direct light too would flatten the relief rather than seat it: the key light is what
 * gives the wall of an emboss its bright edge, and darkening that is the opposite of the effect.
 */
function applyZoneAo(): string {
  return /* glsl */ `
    {
      reflectedLight.indirectDiffuse *= zoneAo_;
      #if defined( USE_CLEARCOAT )
        clearcoatSpecularIndirect *= zoneAo_;
      #endif
      #if defined( USE_SHEEN )
        sheenSpecularIndirect *= zoneAo_;
      #endif
      #if defined( USE_ENVMAP ) && defined( STANDARD )
        float zoneDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
        reflectedLight.indirectSpecular *= computeSpecularOcclusion( zoneDotNV, zoneAo_, material.roughness );
      #endif
    }
  `;
}
