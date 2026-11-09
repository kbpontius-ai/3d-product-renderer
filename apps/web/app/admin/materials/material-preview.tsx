'use client';

import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { toThreeParams } from '@pr/materials';
import type { MaterialDefinition } from '@pr/design-schema';

/**
 * A material on a reference object (F-ADM-04).
 *
 * The same mapping and the same environment the editor uses, on a sphere rather than a product:
 * a curved surface shows roughness, clearcoat and metalness across every angle at once, which is
 * what an operator is judging. Anything that looked right here and wrong in the editor would mean
 * two definitions of "material", which is exactly what `toThreeParams` exists to prevent.
 */
export function MaterialPreview({ definition }: { definition: MaterialDefinition }) {
  return (
    <div className="material-preview">
      <Canvas
        camera={{ position: [0, 0, 3.1], fov: 32 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
        // A still sphere: drawing it sixty times a second would heat the machine to no effect, and
        // a page full of these would never settle enough to click a button on.
        frameloop="demand"
        resize={{ scroll: false }}
      >
        <color attach="background" args={['#0f1115']} />
        <Environment />
        <Sphere definition={definition} />
      </Canvas>
    </div>
  );
}

function Environment() {
  const { scene, gl } = useThree();

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    return () => {
      environment.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  return null;
}

function Sphere({ definition }: { definition: MaterialDefinition }) {
  const material = useMemo(() => {
    const params = toThreeParams(definition);
    const physical = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(params.color),
      roughness: params.roughness,
      metalness: params.metalness,
      ior: params.ior,
      clearcoat: params.clearcoat,
      clearcoatRoughness: params.clearcoatRoughness,
      sheen: params.sheen,
      transmission: params.transmission,
      // Thickness is authored in millimetres; the reference sphere is one unit across, so it is
      // scaled to the object rather than taken literally.
      thickness: params.transmission > 0 ? 1 : 0,
      transparent: params.transparent,
    });
    return physical;
  }, [definition]);

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh material={material}>
      <sphereGeometry args={[1, 96, 64]} />
    </mesh>
  );
}
