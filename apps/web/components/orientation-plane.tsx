'use client';

import { useMemo, useRef } from 'react';
import { Html, Line, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrientationFrame, Vec3 } from '@pr/design-schema';
import { frameFromDirections } from '@pr/scene';
import { orientationQuaternion } from '@/lib/orientation-view';

export function OrientationPlane({
  frame,
  center,
  radius,
  editable,
  onChange,
}: {
  frame: OrientationFrame;
  center: Vec3;
  radius: number;
  editable: boolean;
  onChange: (frame: OrientationFrame) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const quaternion = useMemo(() => orientationQuaternion(frame), [frame]);
  const size = radius * 2.2;
  const plane = (
    <group ref={group} position={center} quaternion={quaternion}>
      <mesh renderOrder={10}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial
          color="#7ab5ff"
          transparent
          opacity={0.13}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Line
        points={[
          [-size / 2, -size / 2, 0],
          [size / 2, -size / 2, 0],
          [size / 2, size / 2, 0],
          [-size / 2, size / 2, 0],
          [-size / 2, -size / 2, 0],
        ]}
        color="#448ee8"
        lineWidth={1}
      />
      {Array.from({ length: 9 }, (_, i) => ((i - 4) * size) / 10).map((offset) => (
        <group key={offset}>
          <Line
            points={[
              [-size / 2, offset, 0],
              [size / 2, offset, 0],
            ]}
            color="#76aaf0"
            transparent
            opacity={0.35}
          />
          <Line
            points={[
              [offset, -size / 2, 0],
              [offset, size / 2, 0],
            ]}
            color="#76aaf0"
            transparent
            opacity={0.35}
          />
        </group>
      ))}
      <arrowHelper
        args={[
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(),
          radius * 0.75,
          0x2478dc,
          radius * 0.12,
          radius * 0.06,
        ]}
      />
      <arrowHelper
        args={[
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(),
          radius * 0.75,
          0x2478dc,
          radius * 0.12,
          radius * 0.06,
        ]}
      />
      <Html position={[0, radius * 0.85, 0]} center>
        <span className="orientation-axis-label">Up</span>
      </Html>
      <Html position={[0, 0, radius * 0.85]} center>
        <span className="orientation-axis-label">Front</span>
      </Html>
    </group>
  );
  if (!editable) return plane;
  return (
    <TransformControls
      mode="rotate"
      size={0.8}
      onObjectChange={() => {
        if (!group.current) return;
        const front = new THREE.Vector3(0, 0, 1).applyQuaternion(group.current.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(group.current.quaternion);
        onChange(frameFromDirections([front.x, front.y, front.z], [up.x, up.y, up.z]));
      }}
    >
      {plane}
    </TransformControls>
  );
}
