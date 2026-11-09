import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SECTION_RENDER_ORDER, sectionCapMaterial, sectionCountingMaterials, sectionReliefMaterials } from './cross-section';

/**
 * The cross-section's cap is a configuration, not an algorithm: a handful of flags across three
 * materials, none of which draws anything on its own. Every way of getting it wrong fails the same
 * silent way — no cap appears, at any angle, with no error and no warning.
 *
 * These assert the configuration rather than the picture, for the reason `zone-material.test.ts`
 * gives about shader chunks: the failure mode is silence, so something has to read the settings
 * back. Each test names the symptom its invariant prevents, because the symptoms are identical and
 * the causes are not.
 */

const plane = () => new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);

describe('sectionCountingMaterials', () => {
  it('clips the counters by the same plane as the product', () => {
    /*
     * The one that shipped broken.
     *
     * An unclipped count balances — every ray leaves through as many back faces as it entered
     * through front ones — so the stencil returns to zero everywhere and the cap never draws. It
     * looks plausible from directly above, because a closure's own geometry does, and is wrong from
     * every other angle.
     */
    const cut = plane();
    for (const material of sectionCountingMaterials(cut)) {
      expect(material.clippingPlanes).toEqual([cut]);
    }
  });

  it('counts back faces up and front faces down', () => {
    const [back, front] = sectionCountingMaterials(plane()) as [THREE.Material, THREE.Material];

    expect((back as THREE.MeshBasicMaterial).side).toBe(THREE.BackSide);
    expect((front as THREE.MeshBasicMaterial).side).toBe(THREE.FrontSide);

    // All three outcomes, not just the one that passes: a fragment behind other geometry still
    // crossed a surface, and a count that ignored it would leave holes wherever parts overlap.
    for (const slot of ['stencilFail', 'stencilZFail', 'stencilZPass'] as const) {
      expect(back[slot]).toBe(THREE.IncrementWrapStencilOp);
      expect(front[slot]).toBe(THREE.DecrementWrapStencilOp);
    }
  });

  it('counts every surface along the ray, not only the nearest', () => {
    // With depth testing on, the first surface hides the rest and the parity is never reached.
    for (const material of sectionCountingMaterials(plane())) {
      expect(material.depthTest).toBe(false);
      expect(material.stencilWrite).toBe(true);
      expect(material.stencilFunc).toBe(THREE.AlwaysStencilFunc);
    }
  });

  it('leaves no mark of its own on the picture', () => {
    // Counting is bookkeeping. A counter that wrote colour would paint the product's silhouette
    // flat; one that wrote depth would occlude the cap it exists to enable.
    for (const material of sectionCountingMaterials(plane())) {
      expect(material.colorWrite).toBe(false);
      expect(material.depthWrite).toBe(false);
    }
  });
});

describe('sectionCapMaterial', () => {
  it('draws only where the counters found solid material', () => {
    const cap = sectionCapMaterial('#1b4d3e');

    expect(cap.stencilWrite).toBe(true);
    expect(cap.stencilFunc).toBe(THREE.NotEqualStencilFunc);
    expect(cap.stencilRef).toBe(0);
  });

  it('resets the count as it draws', () => {
    // Otherwise the buffer carries into the next frame and the cap spreads across everything the
    // camera has ever pointed at.
    const cap = sectionCapMaterial('#1b4d3e');
    for (const slot of ['stencilFail', 'stencilZFail', 'stencilZPass'] as const) {
      expect(cap[slot]).toBe(THREE.ReplaceStencilOp);
    }
  });

  it('is visible from both sides', () => {
    // The cut face is approached from whichever side the camera happens to be on, and a
    // single-sided quad disappears from half of them.
    expect(sectionCapMaterial('#1b4d3e').side).toBe(THREE.DoubleSide);
  });

  it('takes the part\'s colour, flat', () => {
    const cap = sectionCapMaterial('#1b4d3e');
    expect(`#${cap.color.getHexString()}`).toBe('#1b4d3e');
    expect(cap.metalness).toBe(0);
  });

  it('is not clipped by the plane it sits on', () => {
    // It lies exactly in the cut. Clip it and it removes itself.
    expect(sectionCapMaterial('#1b4d3e').clippingPlanes).toBeNull();
  });
});

describe('render order', () => {
  it('counts before it caps', () => {
    // The cap reads a number the counters have to have written already.
    expect(SECTION_RENDER_ORDER.counting).toBeLessThan(SECTION_RENDER_ORDER.cap);
  });
});


describe('relief section contribution', () => {
  it('subtracts the original patch winding and adds the displaced winding', () => {
    const materials = sectionReliefMaterials(plane(), {});
    expect(materials.map((m) => m.stencilZPass)).toEqual([
      THREE.DecrementWrapStencilOp, THREE.IncrementWrapStencilOp,
      THREE.IncrementWrapStencilOp, THREE.DecrementWrapStencilOp,
    ]);
    expect(materials.map((m) => (m as THREE.MeshBasicMaterial).side)).toEqual([
      THREE.BackSide, THREE.FrontSide, THREE.BackSide, THREE.FrontSide,
    ]);
  });

  it('shares live height uniforms and clips both surfaces at the same supported boundary', () => {
    const cut = plane();
    const uniforms = { uZoneHeightRange: { value: 0.35 }, uZoneHeight: { value: new THREE.Texture() } };
    const materials = sectionReliefMaterials(cut, uniforms);
    const shaders = materials.map((material) => {
      const shader = {
        vertexShader: THREE.ShaderLib.basic.vertexShader,
        fragmentShader: THREE.ShaderLib.basic.fragmentShader,
        uniforms: {} as Record<string, THREE.IUniform>,
      };
      material.onBeforeCompile(shader as never, null as never);
      expect(material.clippingPlanes).toEqual([cut]);
      expect(shader.fragmentShader).toContain('if (vZoneSupportPatch < 0.5) discard;');
      expect(shader.fragmentShader).toContain('if (!zoneHasRelief(vZoneUvPatch)) discard;');
      expect(shader.vertexShader).toContain('vZoneUvPatch = aZoneUv;');
      expect(shader.uniforms['uZoneHeight']).toBe(uniforms.uZoneHeight);
      return shader;
    });
    for (const shader of shaders.slice(0, 2)) {
      expect(shader.vertexShader).not.toContain('transformed += normal * zoneHeightMm(aZoneUv);');
    }
    for (const shader of shaders.slice(2)) {
      expect(shader.vertexShader).toContain('transformed += normal * zoneHeightMm(aZoneUv);');
    }
    uniforms.uZoneHeightRange.value = 0.6;
    expect(shaders.every((s) => s.uniforms['uZoneHeightRange']?.value === 0.6)).toBe(true);
    expect(materials[0]!.customProgramCacheKey()).not.toBe(materials[2]!.customProgramCacheKey());
  });
});
