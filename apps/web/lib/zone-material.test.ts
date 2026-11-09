import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cylindricalZoneFixture, planarZoneFixture } from '@pr/design-schema/fixtures';
import type { DecorationZoneDef } from '@pr/design-schema';

import {
  CONFORMAL_ZONE_ALIGNMENT,
  PLANAR_ZONE_ALIGNMENT,
  zoneAlignmentMin,
  createZoneMaterial,
  createZoneMaterials,
  zoneUniformValues,
  type ZoneLayerTextures,
} from './zone-material';

/**
 * These materials are built by string surgery on three.js' own shader chunks, and the failure mode
 * of string surgery is silence: a `replace` whose needle has been renamed upstream leaves the
 * shader compiling perfectly and doing nothing. So every test here asserts on the *compiled* source
 * — the object three.js would hand to the driver — rather than on the material's properties.
 */

function layers(): ZoneLayerTextures {
  return {
    height: new THREE.Texture(),
    ink: new THREE.Texture(),
    texelMm: new THREE.Vector2(0.04, 0.04),
    texelUv: new THREE.Vector2(1 / 720, 1 / 720),
    heightRangeMm: 0.375,
    inkRoughness: 0.18,
    inkMetalness: 1,
    inkTint: 1,
    inkFromHeight: 1,
  };
}

const patchScale = {
  stepUv: new THREE.Vector2(1 / 200, 1 / 200),
  spacingMm: new THREE.Vector2(0.15, 0.15),
};

/** Compile a material the way three.js would, and hand back the sources it produced. */
function compile(material: THREE.MeshPhysicalMaterial): {
  vertex: string;
  fragment: string;
  uniforms: Record<string, THREE.IUniform>;
} {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, THREE.IUniform>,
    defines: {},
  };
  material.onBeforeCompile(shader as never, null as never);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader, uniforms: shader.uniforms };
}

describe('zoneUniformValues', () => {
  it('reads a planar zone as an origin and a frame', () => {
    const values = zoneUniformValues(planarZoneFixture);
    expect(values.kind).toBe(0);
    expect(values.origin.toArray()).toEqual([0, 18, 0]);
    expect(values.halfExtent.toArray()).toEqual([15, 15]);
  });

  it('reads a cylindrical zone as an axis and a radius', () => {
    const values = zoneUniformValues(cylindricalZoneFixture);
    expect(values.kind).toBe(1);
    expect(values.radius).toBe(19);
    expect(values.normal.toArray()).toEqual([0, 1, 0]); // the axis
  });

  it('derives a surface tolerance generous enough to be a no-op on the intended face', () => {
    // 3x the zone's own maximum relief, floored at a millimetre: nowhere near the 19 mm that
    // separates a closure's skirt from its bore.
    expect(zoneUniformValues(planarZoneFixture).surfaceToleranceMm).toBeCloseTo(1.8, 9);
    expect(zoneUniformValues(cylindricalZoneFixture).surfaceToleranceMm).toBeCloseTo(1.2, 9);
  });

  it('takes a conformal zone tolerance from its own projection depth', () => {
    const conformal: DecorationZoneDef = {
      type: 'conformal',
      key: 'wrap',
      name: 'Wrap',
      frame: { originMm: [0, 0, 0], normal: [0, 1, 0], tangent: [1, 0, 0], maxProjectionDepthMm: 5 },
      sizeMm: { width: 10, height: 10, safeMarginMm: 1 },
      constraints: planarZoneFixture.constraints,
    };
    expect(zoneUniformValues(conformal).surfaceToleranceMm).toBe(5);
  });
});

describe('base role', () => {
  const { vertex, fragment, uniforms } = compile(
    createZoneMaterial({}, zoneUniformValues(planarZoneFixture), layers()).material,
  );

  it('injects into every chunk it means to', () => {
    // If three.js renames a chunk, the replace becomes a no-op and the relief silently vanishes.
    expect(vertex).toContain('vZoneWorldPos');
    expect(fragment).toContain('zoneUv_');
    expect(fragment).toContain('roughnessFactor = mix(roughnessFactor, uZoneInkRoughness');
    expect(fragment).toContain('metalnessFactor = mix(metalnessFactor, uZoneInkMetalness');
    expect(fragment).toContain('zoneSlope(zoneUv_, uZoneTexelUv, uZoneTexelMm)');
    expect(fragment).toContain('reflectedLight.indirectDiffuse *= zoneAo_');
  });

  it('converts the zone frame into view space before perturbing the normal', () => {
    // `normal` in a three.js fragment shader is view space; the zone frame is world space. Mixing
    // them made the relief's lighting rotate with the camera.
    expect(fragment).toContain('mat3 toView = mat3(viewMatrix)');
    expect(fragment).toContain('normalize(toView * zoneT)');
    expect(fragment).toContain('normalize(toView * zoneB)');
  });

  it('bounds the zone in the third dimension as well as the first two', () => {
    expect(fragment).toContain('abs(dot(rel, uZoneNormal)) <= uZoneSurfaceTol');
    expect(fragment).toContain('abs(radial - uZoneRadius) <= uZoneSurfaceTol');
  });

  it('requires a planar zone to sit on something actually flat', () => {
    /*
     * The rule, applied to the shape that broke it.
     *
     * A 38 mm closure with a 1.2 mm fillet, carrying a 30 mm square zone on its top face. The
     * square clears the rim by 4 mm along its edges and overhangs it by 2.2 mm at its corners, so
     * the four diagonals are the *only* places the rectangle meets the fillet — which is why the
     * old sixty-degree threshold showed up as four tabs of rim, shaded as though they were the flat
     * top, at 45/135/225/315 degrees.
     *
     * Checked against geometry rather than against the text of the shader, because a string match
     * passes just as happily when the number is wrong.
     */
    const R = 19;
    const H = 18;
    const filletMm = 1.2;
    const halfExtent = 15;                 // the 30 mm zone
    const planeToleranceMm = 1.8;          // max(1, 3 x maxDepthMm) for this zone

    /** A point on the fillet, `deg` around from the top face, at `azimuth` around the axis. */
    const filletPoint = (deg: number, azimuth: number) => {
      const t = (deg * Math.PI) / 180;
      const radius = R - filletMm + filletMm * Math.sin(t);
      return {
        x: radius * Math.cos(azimuth),
        z: radius * Math.sin(azimuth),
        y: H - filletMm + filletMm * Math.cos(t),
        ny: Math.cos(t),
      };
    };

    const insideZone = (p: { x: number; z: number; y: number; ny: number }): boolean =>
      p.ny > PLANAR_ZONE_ALIGNMENT &&
      Math.abs(p.y - H) <= planeToleranceMm &&
      Math.abs(p.x) < halfExtent &&
      Math.abs(p.z) < halfExtent;

    // Every fillet angle the old threshold admitted, on the diagonals where the square reaches it.
    for (const azimuth of [45, 135, 225, 315]) {
      for (const deg of [15, 30, 45, 60]) {
        const p = filletPoint(deg, (azimuth * Math.PI) / 180);
        expect(Math.hypot(p.x, p.z)).toBeGreaterThan(R - filletMm); // really on the fillet
        expect(insideZone(p)).toBe(false);
      }
    }

    // And the face the zone is actually authored on still belongs to it.
    for (const radius of [0, 5, 10, 14]) {
      expect(insideZone({ x: radius, z: 0, y: H, ny: 1 })).toBe(true);
    }
  });

  it('does not hold a conformal zone to the standard a flat one is held to', () => {
    /*
     * A conformal zone shares the planar branch and means the opposite by it: the frame aims the
     * artwork, and the surface is *expected* to curve away from it. Ten degrees would reject the far
     * side of any dome the zone exists to decorate — and nothing would catch it, because no fixture
     * pack ships a conformal zone.
     */
    const conformal: DecorationZoneDef = {
      ...planarZoneFixture,
      type: 'conformal',
      frame: { ...planarZoneFixture.frame, maxProjectionDepthMm: 8 },
    } as DecorationZoneDef;

    expect(zoneAlignmentMin(conformal)).toBe(CONFORMAL_ZONE_ALIGNMENT);
    expect(zoneAlignmentMin(planarZoneFixture)).toBe(PLANAR_ZONE_ALIGNMENT);
    expect(CONFORMAL_ZONE_ALIGNMENT).toBeLessThan(PLANAR_ZONE_ALIGNMENT);

    // A surface 45 degrees off the frame: inside a conformal zone, outside a planar one.
    const tilted = Math.cos(Math.PI / 4);
    expect(tilted > zoneAlignmentMin(conformal)).toBe(true);
    expect(tilted > zoneAlignmentMin(planarZoneFixture)).toBe(false);

    // And the shader reads it per zone rather than baking one number in.
    expect(fragment).toContain('uZoneAlignMin');
    expect(zoneUniformValues(conformal).alignmentMin).toBe(CONFORMAL_ZONE_ALIGNMENT);
  });

  it('refuses the inside of a cylinder at any radius', () => {
    // Radius alone cannot separate a closure's bore from its skirt: the fillet between the top face
    // and the wall sweeps through the same band. Which way the surface faces can.
    expect(fragment).toContain('bool outward');
    expect(fragment).toContain('&& outward');
  });

  it('does not discard when no patch is covering the zone', () => {
    expect(uniforms['uZonePatchActive']!.value).toBe(0);
  });

  it('applies the whole slope when it is carrying the relief alone', () => {
    expect(fragment).not.toContain('residual');
  });
});

describe('patch role', () => {
  const set = createZoneMaterials({}, zoneUniformValues(planarZoneFixture), layers(), {
    patch: patchScale,
  });

  it('produces both roles', () => {
    expect(set.patch).not.toBeNull();
    expect(set.base.material).not.toBe(set.patch!.material);
  });

  it('shares uniform objects so the two cannot drift', () => {
    expect(set.base.uniforms['uZoneHeightRange']).toBe(set.patch!.uniforms['uZoneHeightRange']);
    set.uniforms['uZoneHeightRange']!.value = 0.9;
    expect(set.base.uniforms['uZoneHeightRange']!.value).toBe(0.9);
    expect(set.patch!.uniforms['uZoneHeightRange']!.value).toBe(0.9);
  });

  it('gives the two roles different program cache keys', () => {
    expect(set.base.material.customProgramCacheKey()).not.toBe(
      set.patch!.material.customProgramCacheKey(),
    );
  });

  it('displaces the vertex along its normal', () => {
    const { vertex } = compile(set.patch!.material);
    expect(vertex).toContain('transformed += normal * zoneHeightMm(aZoneUv)');
    expect(vertex).toContain('attribute vec2 aZoneUv');
    expect(vertex).toContain('attribute vec3 aZoneTangent');
  });

  it('rebuilds the vertex normal at the spacing the grid actually has', () => {
    const { vertex } = compile(set.patch!.material);
    expect(vertex).toContain('zoneSlope(aZoneUv, uZonePatchStepUv, uZonePatchSpacingMm)');
    expect(vertex).toContain('objectNormal = normalize(normal - aZoneTangent * coarse.x');
  });

  it('shades only the residual, so the relief is not applied twice', () => {
    const { fragment } = compile(set.patch!.material);
    expect(fragment).toContain('vec2 fine = zoneSlope(vZoneUvPatch, uZoneTexelUv, uZoneTexelMm)');
    expect(fragment).toContain(
      'vec2 coarse = zoneSlope(vZoneUvPatch, uZonePatchStepUv, uZonePatchSpacingMm)',
    );
    expect(fragment).toContain('vec2 residual = fine - coarse');
  });

  it('reads the zone coordinate off the varying rather than inverting a displaced position', () => {
    const { fragment } = compile(set.patch!.material);
    expect(fragment).toContain('texture2D(uZoneInk, vZoneUvPatch)');
    expect(fragment).not.toContain('vZoneWorldPos');
  });

  it('makes the base get out of the way only where the relief dips below it', () => {
    // Discarding the whole footprint cannot be made to line up with the patch's own boundary at
    // the rim of a round face; discarding on depth removes the conflict instead of tightening it.
    const { fragment, uniforms } = compile(set.base.material);
    expect(uniforms['uZonePatchActive']!.value).toBe(1);
    expect(fragment).toContain(
      'uZonePatchActive > 0.5 && zoneInside_ && zoneHasRelief(uv) && zoneHeightMm(uv) < 0.0',
    );
    expect(fragment).toContain('discard');
  });

  it('draws both sides, so an unclosed mesh does not read as a hole', () => {
    const set = createZoneMaterials({}, zoneUniformValues(planarZoneFixture), layers(), {
      patch: patchScale,
    });
    expect(set.base.material.side).toBe(THREE.DoubleSide);
    expect(set.patch!.material.side).toBe(THREE.DoubleSide);
  });

  it('biases the patch in front of the surface it is coincident with', () => {
    expect(set.patch!.material.polygonOffset).toBe(true);
    expect(set.patch!.material.polygonOffsetFactor).toBeLessThan(0);
    expect(set.base.material.polygonOffset).toBe(false);
  });

  it('disposes both materials', () => {
    const disposable = createZoneMaterials({}, zoneUniformValues(planarZoneFixture), layers(), {
      patch: patchScale,
    });
    let disposed = 0;
    disposable.base.material.addEventListener('dispose', () => disposed++);
    disposable.patch!.material.addEventListener('dispose', () => disposed++);
    disposable.dispose();
    expect(disposed).toBe(2);
  });
});

describe('height-field ambient occlusion (F-PREV-07)', () => {
  it('is on by default and reaches the relief, not the product', () => {
    const set = createZoneMaterials({}, zoneUniformValues(planarZoneFixture), layers(), {
      patch: patchScale,
    });
    // Radius tracks the height range, which tracks the relief depth — not the size of the part.
    expect(set.uniforms['uZoneAoRadiusMm']!.value).toBeCloseTo(0.75, 6);
    expect(set.uniforms['uZoneAoStrength']!.value).toBeGreaterThan(0);
  });

  it('scales its reach into zone UV on each axis independently', () => {
    const set = createZoneMaterials({}, zoneUniformValues(cylindricalZoneFixture), layers(), {});
    const radius = set.uniforms['uZoneAoRadiusUv']!.value as THREE.Vector2;
    // The skirt zone is 40 mm around by 10 mm tall, so a circular reach is not a square in UV.
    expect(radius.x).toBeCloseTo(0.75 / 40, 6);
    expect(radius.y).toBeCloseTo(0.75 / 10, 6);
  });

  it('goes quiet when the quality ladder turns it off', () => {
    const set = createZoneMaterials({}, zoneUniformValues(planarZoneFixture), layers(), {
      ambientOcclusion: false,
    });
    expect(set.uniforms['uZoneAoStrength']!.value).toBe(0);
  });

  it('never touches direct light', () => {
    const { fragment } = compile(
      createZoneMaterial({}, zoneUniformValues(planarZoneFixture), layers()).material,
    );
    expect(fragment).toContain('reflectedLight.indirectDiffuse *= zoneAo_');
    expect(fragment).not.toContain('reflectedLight.directDiffuse *= zoneAo_');
  });
});

describe('clipping the patch to the part', () => {
  it('leaves neutral substrate to the base without declaring the UV or sampler twice', () => {
    const set = createZoneMaterials({}, zoneUniformValues(planarZoneFixture), layers(), {
      patch: patchScale,
    });
    const { vertex, fragment } = compile(set.patch!.material);
    expect(vertex).toContain('vZoneUvPatch = aZoneUv;');
    expect(fragment).toContain('if (!zoneHasRelief(vZoneUvPatch)) discard;');
    expect(fragment).toContain('128.0 / 255.0) > 0.5 / 255.0');
    for (const source of [vertex, fragment]) {
      expect(source.match(/varying vec2 vZoneUvPatch;/g)).toHaveLength(1);
      expect(source.match(/uniform sampler2D uZoneHeight;/g)).toHaveLength(1);
    }
    expect(fragment.indexOf('float zoneHeightMm(')).toBeLessThan(fragment.indexOf('float zoneOcclusion('));
  });

  it('discards the fragments the part has no surface under', () => {
    // A zone is a rectangle; the face it sits on very often is not. Triangle clipping only works
    // in whole cells, and one cell of overhang scallops the rim of a round face.
    const set = createZoneMaterials({}, zoneUniformValues(planarZoneFixture), layers(), {
      patch: patchScale,
    });
    const { vertex, fragment } = compile(set.patch!.material);

    expect(vertex).toContain('attribute float aZoneSupport');
    expect(vertex).toContain('vZoneSupportPatch = aZoneSupport');
    expect(fragment).toContain('if (vZoneSupportPatch < 0.5) discard');
  });
});

describe('coordinates carried by the product (kind 3)', () => {
  /*
   * A conformal zone's patch is walked across the part, and a walk has no inverse for a shader to
   * evaluate. Treated as planar, the product stopped knowing it was in the zone a millimetre off the
   * frame plane — 12 mm from the centre of a 75 mm radius jar — and covered every deboss pocket
   * beyond that. Kind 3 reads the zone millimetres off the vertex instead.
   */
  const conformal = {
    ...planarZoneFixture,
    type: 'conformal',
    frame: { ...planarZoneFixture.frame, maxProjectionDepthMm: 1 },
  } as DecorationZoneDef;
  const set = createZoneMaterials({}, { ...zoneUniformValues(conformal), kind: 3 }, layers(), {
    patch: patchScale,
  });
  const base = compile(set.base.material);

  it('takes the zone coordinate from the vertex, not from the frame plane', () => {
    expect(base.vertex).toContain('attribute vec3 aZoneMm;');
    expect(base.vertex).toContain('vZoneMm = aZoneMm;');
    expect(base.fragment).toContain('varying vec3 vZoneMm;');
    expect(base.fragment).toContain('zoneMm = vZoneMm.xy;');
    // The third component is the vertex's membership; any outsider in the triangle keeps it out.
    expect(base.fragment).toContain('facing = vZoneMm.z > 0.999;');
    expect(base.uniforms['uZoneKind']!.value).toBe(3);
  });

  it('still gets out of the way of a deboss, and only of a deboss', () => {
    const discard = 'zoneHeightMm(uv) < 0.0) discard;';
    expect(base.fragment).toContain(discard);
    const mapping = base.fragment.indexOf('zoneMm = vZoneMm.xy;');
    expect(mapping).toBeGreaterThan(-1);
    expect(mapping).toBeLessThan(base.fragment.indexOf(discard));
  });

  it('shades its relief along the surface rather than along the flat frame', () => {
    expect(base.fragment).toContain('vec2 dMdx = dFdx(vZoneMm.xy);');
  });

  it('compiles to its own program, and leaves every other kind exactly as it was', () => {
    expect(set.base.material.customProgramCacheKey()).toBe('zone-3-base');
    const planar = compile(
      createZoneMaterial({}, zoneUniformValues(planarZoneFixture), layers()).material,
    );
    for (const source of [planar.vertex, planar.fragment]) expect(source).not.toContain('vZoneMm');
    // The patch already carries its own coordinates and needs nothing new.
    expect(compile(set.patch!.material).vertex).not.toContain('aZoneMm');
  });
});
