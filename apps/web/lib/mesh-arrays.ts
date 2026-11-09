import * as THREE from 'three';
import type { MeshArrays } from '@pr/placement';

/**
 * The decorated meshes, merged into one array set in world millimetres.
 *
 * A zone is authored against the part, not against a node of the glTF scene graph, so the sampler
 * that answers questions about that surface has to see it in the same space the zone frame is
 * written in. Node transforms are baked here rather than carried alongside, because a sampler that
 * takes a matrix is a sampler every caller can forget to give one to.
 */
export function collectDecoratedGeometry(
  scene: THREE.Object3D,
  otherSlots: ReadonlySet<string>,
): MeshArrays | null {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  let hasUvs = true;

  for (const mesh of decoratedMeshes(scene, otherSlots)) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');

    const base = position.length / 3;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const point = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const uvs = geometry.getAttribute('uv');
    if (!uvs) hasUvs = false;

    for (let v = 0; v < positions.count; v++) {
      point
        .fromBufferAttribute(positions as THREE.BufferAttribute, v)
        .applyMatrix4(mesh.matrixWorld);
      position.push(point.x, point.y, point.z);

      if (normals) {
        direction
          .fromBufferAttribute(normals as THREE.BufferAttribute, v)
          .applyMatrix3(normalMatrix)
          .normalize();
        normal.push(direction.x, direction.y, direction.z);
      } else {
        normal.push(0, 0, 0); // the sampler falls back to the geometric normal
      }

      uv.push(uvs ? (uvs.getX(v) as number) : 0, uvs ? (uvs.getY(v) as number) : 0);
    }

    const source = geometry.getIndex();
    if (source) {
      for (let i = 0; i < source.count; i++) index.push(base + (source.getX(i) as number));
    } else {
      for (let v = 0; v < positions.count; v++) index.push(base + v);
    }
  }

  if (index.length < 3) return null;
  return {
    position: Float32Array.from(position),
    normal: Float32Array.from(normal),
    uv: hasUvs ? Float32Array.from(uv) : undefined,
    index: Uint32Array.from(index),
  };
}

/**
 * The meshes `collectDecoratedGeometry` merges, in the order it merges them.
 *
 * Anything that computes a value per merged vertex and has to hand it back to the meshes it came
 * from — the zone coordinates the product carries for a conformal zone — slices by this list, so
 * the filter and the order exist once.
 */
export function decoratedMeshes(
  scene: THREE.Object3D,
  otherSlots: ReadonlySet<string>,
): THREE.Mesh[] {
  scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const named = (mesh.material as THREE.Material | undefined)?.name ?? '';
    if (otherSlots.has(named)) return;
    if (!(mesh.geometry as THREE.BufferGeometry).getAttribute('position')) return;
    meshes.push(mesh);
  });
  return meshes;
}
