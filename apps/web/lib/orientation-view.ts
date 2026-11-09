import * as THREE from 'three';
import type { DecorationZoneDef, OrientationFrame } from '@pr/design-schema';
import { frameFromDirections, IMPORTED_FRAME } from '@pr/scene';
import { mapperFor } from '@pr/placement';

export function orientationQuaternion(frame: OrientationFrame): THREE.Quaternion {
  const up = new THREE.Vector3(...frame.upSource);
  const front = new THREE.Vector3(...frame.frontSource);
  const right = new THREE.Vector3().crossVectors(up, front);
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, front),
  );
}

export function inspectionFrame(
  zone: DecorationZoneDef,
  fallback = IMPORTED_FRAME,
  rotationDeg = 0,
): OrientationFrame {
  let frame = fallback;
  if (zone.type !== 'uv_rect' && zone.type !== 'flat_panel') {
    const surface = mapperFor(zone).toWorld({ x: 0, y: 0 });
    const up = new THREE.Vector3().crossVectors(
      new THREE.Vector3(...surface.normal),
      new THREE.Vector3(...surface.tangent),
    );
    frame = frameFromDirections([...surface.normal], [up.x, up.y, up.z]);
  }
  const pose = orientationQuaternion(frame).multiply(
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.degToRad(rotationDeg),
    ),
  );
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose);
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(pose);
  return frameFromDirections([front.x, front.y, front.z], [up.x, up.y, up.z]);
}
