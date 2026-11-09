import * as THREE from 'three';
import { patchSurfaceFragment, patchSurfaceVertex } from './zone-material';

/**
 * The materials that turn a clipped product into a *capped* one (F-EDIT-11, docs/16).
 *
 * Clipping alone is not a cross-section. `clippingPlanes` discard fragments, which on a hollow part
 * leaves the viewer looking through the cut at the inside of the far wall — a shell with a bite out
 * of it, which reads as a broken model rather than as a section. A cap across the cut face is what
 * makes it read as material.
 *
 * Built here rather than inline in the component because the whole mechanism is a *configuration*:
 * six or seven flags across three materials, none of which draws anything visible on its own, and
 * getting one wrong fails silently — the cap simply never appears, on every angle, with no error.
 * That is the same argument `zone-material.ts` makes about shader string surgery, and it has the
 * same answer: put the configuration somewhere a test can read it back.
 */

/** Nothing about the count is visible; these only leave a number in the stencil buffer. */
function countingMaterial(side: THREE.Side, op: THREE.StencilOp, plane: THREE.Plane): THREE.Material {
  const material = new THREE.MeshBasicMaterial({ side, colorWrite: false, depthWrite: false });

  /*
   * Clipped by the same plane the product is, and this is the whole trick.
   *
   * Counting an *unclipped* mesh balances: every ray leaves through as many back faces as it
   * entered through front ones, so the count returns to zero everywhere and the cap — which draws
   * only where the count is non-zero — never appears anywhere. Clipping the counters too removes
   * the faces in front of the plane, and the surplus of back faces left behind is exactly the solid
   * material the cut passes through.
   *
   * This was omitted in the first version of the feature. It cost nothing at the angles that were
   * checked, because a closure's own geometry happens to look plausible from above, and it was
   * wrong from every other angle.
   */
  material.clippingPlanes = [plane];

  // The count is over every surface along the ray, not only the nearest one, so depth cannot be
  // allowed to reject any of them.
  material.depthTest = false;
  material.stencilWrite = true;
  material.stencilFunc = THREE.AlwaysStencilFunc;
  material.stencilFail = op;
  material.stencilZFail = op;
  material.stencilZPass = op;
  return material;
}

/**
 * A pair of materials that count surfaces crossed: back faces up, front faces down.
 *
 * Counting rather than assuming a shape is what makes this work on a real part. A closure is a
 * hollow shell with a bore and a cavity; a carton is a box; a bottle is neither. The parity of the
 * count is right for all of them, and the alternative — reusing the object's own back faces as the
 * cap — is a pass cheaper and wrong on exactly the hollow parts this product exists for.
 */
export function sectionCountingMaterials(plane: THREE.Plane): readonly THREE.Material[] {
  return [
    countingMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp, plane),
    countingMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp, plane),
  ];
}

/**
 * Replace the patch's original surface in the winding count, rather than counting both surfaces.
 * The reversed undisplaced pair removes the CAD surface contribution; the displaced pair adds
 * the actual relief. The same support and neutral-code masks keep blank substrate out of both
 * pairs, so a slightly offset blank grid cannot add a phantom section surface.
 */
export function sectionReliefMaterials(
  plane: THREE.Plane,
  uniforms: Record<string, THREE.IUniform>,
): readonly THREE.Material[] {
  return [false, true].flatMap((displaced) => {
    const materials = displaced
      ? sectionCountingMaterials(plane)
      : [
          countingMaterial(THREE.BackSide, THREE.DecrementWrapStencilOp, plane),
          countingMaterial(THREE.FrontSide, THREE.IncrementWrapStencilOp, plane),
        ];
    for (const material of materials) {
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = patchSurfaceVertex(shader.vertexShader, displaced);
        shader.fragmentShader = patchSurfaceFragment(shader.fragmentShader);
      };
      material.customProgramCacheKey = () => `section-relief-${displaced}`;
    }
    return materials;
  });
}

/**
 * The cut face itself: drawn wherever the counters left a non-zero count.
 *
 * Flat and matte on purpose. A cut face is not a moulded surface, and giving it a finish of its own
 * would invite reading a sheen into a section that has none.
 */
export function sectionCapMaterial(colorHex: string): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    metalness: 0,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  material.stencilWrite = true;
  material.stencilRef = 0;
  material.stencilFunc = THREE.NotEqualStencilFunc;
  // Resets the count as it draws, so the next frame starts clean without a separate clear.
  material.stencilFail = THREE.ReplaceStencilOp;
  material.stencilZFail = THREE.ReplaceStencilOp;
  material.stencilZPass = THREE.ReplaceStencilOp;
  return material;
}

/** Counters first, then the cap that reads what they left. Both before the product. */
export const SECTION_RENDER_ORDER = { counting: 1, cap: 2 } as const;
