'use client';

import { useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { DecorationZoneDef, MaterialDefinition, OrientationFrame } from '@pr/design-schema';
import { environmentFor, IMPORTED_FRAME, subjectFromBbox } from '@pr/scene';
import { toThreeParams } from '@pr/materials';
import { Backdrop, configurePreviewColor, Environment } from '@/components/viewport-3d';
import { inspectionFrame, orientationQuaternion } from '@/lib/orientation-view';
import type { SceneBackground, SlotAssignment } from '@/lib/design-state';

interface Props {
  material: MaterialDefinition;
  assignment: SlotAssignment;
  zone: DecorationZoneDef;
  bboxMm: [[number, number, number], [number, number, number]];
  surfaceOrientation?: OrientationFrame;
  lightingOrientation?: OrientationFrame;
  environmentKey: string;
  rotationDeg: number;
  background: SceneBackground;
  onColor: (hex: string) => void;
}

function ReadSample({ onColor }: Pick<Props, 'onColor'>) {
  const { gl, scene, camera } = useThree();
  const pixels = useMemo(() => new Uint8Array(4 * 4 * 4), []);
  useFrame(() => {
    if (!scene.environment || gl.getContext().isContextLost()) return;
    // Read the default framebuffer immediately: render targets bypass Three's display tone mapping.
    gl.render(scene, camera);
    gl.getContext().readPixels(
      6,
      6,
      4,
      4,
      gl.getContext().RGBA,
      gl.getContext().UNSIGNED_BYTE,
      pixels,
    );
    const channels = [0, 1, 2].map((channel) => {
      let sum = 0;
      for (let i = channel; i < pixels.length; i += 4) sum += pixels[i]!;
      return Math.round(sum / 16)
        .toString(16)
        .padStart(2, '0');
    });
    onColor(`#${channels.join('')}`);
  }, 1);
  return null;
}

export function PlacementColorSample(props: Props) {
  const {
    material,
    assignment,
    zone,
    bboxMm,
    surfaceOrientation,
    lightingOrientation,
    environmentKey,
    rotationDeg,
    background,
    onColor,
  } = props;
  const subject = useMemo(() => subjectFromBbox(bboxMm), [bboxMm]);
  const environment = useMemo(() => environmentFor(environmentKey), [environmentKey]);
  const pose = useMemo(
    () => (lightingOrientation ? orientationQuaternion(lightingOrientation) : undefined),
    [lightingOrientation],
  );
  const surface = useMemo(
    () => orientationQuaternion(inspectionFrame(zone, surfaceOrientation ?? IMPORTED_FRAME)),
    [zone, surfaceOrientation],
  );
  const params = useMemo(
    () =>
      toThreeParams(material, {
        materialKey: material.key,
        ...(assignment.colorHex ? { colorHex: assignment.colorHex } : {}),
        textureScale: assignment.textureScale,
        textureRotationDeg: assignment.textureRotationDeg,
      }),
    [material, assignment],
  );
  const camera = useMemo(() => {
    const centre = new THREE.Vector3(...subject.centreMm);
    // Area-light LTC shading has a singular basis when the view exactly matches a flat normal.
    const view = new THREE.Vector3(0.25, 0, 1).normalize().applyQuaternion(surface);
    const camera = Object.assign(
      new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, subject.radiusMm * 60),
      { manual: true },
    );
    camera.position.copy(centre).addScaledVector(view, subject.radiusMm * 4);
    camera.up.set(0, 1, 0).applyQuaternion(surface);
    camera.lookAt(centre);
    return camera;
  }, [subject, surface]);
  const backgroundHex =
    background.kind === 'solid'
      ? background.colorHex
      : background.kind === 'transparent'
        ? '#20242c'
        : null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        width: 16,
        height: 16,
        overflow: 'hidden',
        opacity: 0,
        pointerEvents: 'none',
      }}
    >
      <Canvas
        style={{ pointerEvents: 'none' }}
        camera={camera}
        dpr={1}
        frameloop="demand"
        gl={{ antialias: false }}
        onCreated={({ gl }) => configurePreviewColor(gl)}
      >
        {backgroundHex ? (
          <color attach="background" args={[backgroundHex]} />
        ) : (
          <Backdrop
            world={environment.world}
            strength={environment.backdropStrength}
            radiusMm={subject.radiusMm * 30}
            upSource={lightingOrientation?.upSource}
          />
        )}
        <Environment
          environment={environment}
          subject={subject}
          rotationDeg={rotationDeg}
          orientation={pose}
        />
        <mesh position={subject.centreMm} quaternion={surface}>
          <planeGeometry args={[4, 4]} />
          <meshPhysicalMaterial {...params} />
        </mesh>
        <ReadSample onColor={onColor} />
      </Canvas>
    </div>
  );
}
