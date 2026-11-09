'use client';

import { Html, Line, OrbitControls } from '@react-three/drei';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { zoneExtentMm, type DecorationZoneDef, type Vec3 } from '@pr/design-schema';
import { mapperFor, testPatternSvg } from '@pr/placement';
import type { ZoneSurface } from '@/lib/zone-surface';
import { zoneOutlinesMm } from '@/lib/zone-authoring';

/**
 * The part, with its zones drawn on it (F-ADM-13), and the surface to click when placing one
 * (F-ADM-14).
 *
 * Deliberately not the customer editor's viewport. That one renders relief, materials and the
 * studio; this answers one question — is the rectangle where I meant it, and which way does it read
 * — and a flat grey part answers it more clearly. The active zone carries the same test pattern the
 * editor check uses: an arrow that points up and four different corner marks, so a zone that is
 * rotated, upside down or mirrored looks it, here, on a draft, before anything is published. An
 * arrow out of the surface shows which way the zone faces.
 */

export interface PreviewZone {
  key: string;
  name: string;
  zone: DecorationZoneDef;
  active: boolean;
}

/** A zone that is not yet complete enough to draw, but whose position is known. */
export interface PreviewMarker {
  point: Vec3;
  normal: Vec3;
}

/** Fixed colours: three.js draws with numbers, not CSS variables. Chosen to read on the grey part. */
const ACTIVE = '#d6246e';
const IDLE = '#6e6a69';

/** How far the pointer may move between press and release and still count as a click, in pixels. */
const CLICK_SLOP = 4;

interface View {
  label: string;
  title: string;
  dir: [number, number, number];
  up: [number, number, number];
}

const VIEWS: View[] = [
  { label: '+X', title: 'Look from +X', dir: [1, 0, 0], up: [0, 1, 0] },
  { label: '−X', title: 'Look from −X', dir: [-1, 0, 0], up: [0, 1, 0] },
  { label: '+Y', title: 'Look from +Y', dir: [0, 1, 0], up: [0, 0, -1] },
  { label: '−Y', title: 'Look from −Y', dir: [0, -1, 0], up: [0, 0, 1] },
  { label: '+Z', title: 'Look from +Z', dir: [0, 0, 1], up: [0, 1, 0] },
  { label: '−Z', title: 'Look from −Z', dir: [0, 0, -1], up: [0, 1, 0] },
  { label: '¾', title: 'Three-quarter view', dir: [1.3, 1, 1.9], up: [0, 1, 0] },
];

const viewTestId = (label: string) =>
  label.replace('−', 'neg').replace('+', 'pos').replace('¾', 'default');

export function ZonePreview({
  scene,
  surfaces,
  bboxMm,
  zones,
  marker,
  pickedPoints,
  picking,
  onPick,
  onSelect,
}: {
  scene: THREE.Object3D | null;
  surfaces: Record<string, ZoneSurface>;
  bboxMm: [Vec3, Vec3];
  zones: PreviewZone[];
  marker: PreviewMarker | null;
  /** Points already clicked for a three-point pick, shown until the third arrives. */
  pickedPoints: readonly Vec3[];
  picking: false | 'point' | 'rim';
  onPick: (pointMm: Vec3, faceNormal: Vec3) => void;
  onSelect: (key: string) => void;
}) {
  const frame = useMemo(() => {
    const [min, max] = bboxMm;
    const centre = new THREE.Vector3(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    );
    const radius = Math.max(
      1,
      new THREE.Vector3(...max).sub(new THREE.Vector3(...min)).length() / 2,
    );
    return { centre, radius };
  }, [bboxMm]);
  const [view, setView] = useState<{ view: View; seq: number }>({ view: VIEWS[6]!, seq: 0 });

  const pick = (event: ThreeEvent<MouseEvent>) => {
    // A drag to orbit also ends in a click; only a click that stayed put places anything.
    if (!picking || event.delta > CLICK_SLOP || !event.face) return;
    event.stopPropagation();
    const normal = event.face.normal
      .clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(event.object.matrixWorld))
      .normalize();
    onPick([event.point.x, event.point.y, event.point.z], [normal.x, normal.y, normal.z]);
  };

  const { centre, radius } = frame;
  const active = zones.find((zone) => zone.active);
  return (
    <div className={picking ? 'zone-preview picking' : 'zone-preview'} data-testid="zone-preview">
      <div className="zone-preview-canvas">
        <Canvas
          frameloop="demand"
          camera={{
            position: [centre.x + radius * 1.3, centre.y + radius * 1.0, centre.z + radius * 1.9],
            near: radius * 0.01,
            far: radius * 60,
            fov: 35,
          }}
        >
          <color attach="background" args={['#f7f5f3']} />
          <hemisphereLight args={['#ffffff', '#9a9796', 1.2]} />
          <directionalLight position={[radius * 2, radius * 3, radius * 2]} intensity={1.6} />
          <directionalLight position={[-radius * 2, -radius, -radius * 2]} intensity={0.5} />
          <Axes size={radius * 0.5} />
          {scene && <primitive object={scene} onClick={pick} />}
          {zones.map(({ key, name, zone, active: isActive }) => (
            <ZoneOutline
              key={key}
              zone={zone}
              surface={surfaces[key]}
              name={name}
              active={isActive}
              onSelect={() => onSelect(key)}
            />
          ))}
          {active && <TestPattern zone={active.zone} surface={surfaces[active.key]} />}
          {active && (
            <FacingArrow zone={active.zone} surface={surfaces[active.key]} size={radius * 0.25} />
          )}
          {!active && marker && (
            <Marker point={marker.point} normal={marker.normal} size={radius * 0.25} />
          )}
          {pickedPoints.map((point, index) => (
            <mesh key={index} position={point} renderOrder={12}>
              <sphereGeometry args={[radius * 0.015, 12, 8]} />
              <meshBasicMaterial color={ACTIVE} depthTest={false} />
            </mesh>
          ))}
          <OrbitControls makeDefault target={centre} enableDamping={false} />
          <ApplyView view={view.view} seq={view.seq} centre={centre} distance={radius * 2.6} />
        </Canvas>
        <div className="zone-preview-views" role="group" aria-label="Look along an axis">
          {VIEWS.map((choice) => (
            <button
              key={choice.label}
              type="button"
              title={choice.title}
              onClick={() => setView((current) => ({ view: choice, seq: current.seq + 1 }))}
              data-testid={`zone-view-${viewTestId(choice.label)}`}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <p className="zone-preview-legend">
        <span className="axis-x">X</span> <span className="axis-y">Y</span>{' '}
        <span className="axis-z">Z</span> axes drawn from the origin.{' '}
        {picking === 'rim'
          ? `Click three points spread around a round edge (${pickedPoints.length} of 3). Esc cancels.`
          : picking
            ? 'Click the part to place the zone there. Esc cancels.'
            : 'Drag to turn, scroll to zoom. The active zone shows the test pattern — its arrow points up.'}
      </p>
    </div>
  );
}

/** Moves the camera to look along a chosen axis, when one of the view buttons is pressed. */
function ApplyView({
  view,
  seq,
  centre,
  distance,
}: {
  view: View;
  seq: number;
  centre: THREE.Vector3;
  distance: number;
}) {
  const { camera, controls, invalidate } = useThree();
  useEffect(() => {
    if (seq === 0) return;
    const direction = new THREE.Vector3(...view.dir).normalize();
    camera.position.copy(centre).addScaledVector(direction, distance);
    camera.up.set(...view.up);
    camera.lookAt(centre);
    const orbit = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    orbit?.target?.copy(centre);
    orbit?.update?.();
    invalidate();
    // Only on a press: the view is where the author asked to look, not a state to hold them in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);
  return null;
}

/**
 * The axes, drawn over the part rather than inside it.
 *
 * The origin is usually inside the part — the middle of a cap's base — so axes that respected
 * depth would be hidden exactly where they are needed to read the form's numbers against.
 */
function Axes({ size }: { size: number }) {
  const helper = useMemo(() => {
    const axes = new THREE.AxesHelper(size);
    const material = axes.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    axes.renderOrder = 10;
    return axes;
  }, [size]);
  useEffect(() => () => helper.dispose(), [helper]);
  return <primitive object={helper} />;
}

function ZoneOutline({
  zone,
  surface,
  name,
  active,
  onSelect,
}: {
  zone: DecorationZoneDef;
  name: string;
  surface?: ZoneSurface;
  active: boolean;
  onSelect: () => void;
}) {
  const drawn = useMemo(() => {
    try {
      if (zone.type === 'conformal')
        return surface?.labelAt ? { outlines: surface, labelAt: surface.labelAt } : null;
      const top = mapperFor(zone).toWorld({ x: 0, y: zoneExtentMm(zone).h / 2 });
      const outlines = zoneOutlinesMm(zone);
      return {
        outlines: { boundary: [outlines.boundary], safe: [outlines.safe] },
        labelAt: top.position,
      };
    } catch {
      // A zone defined in the mesh's UV space has no frame to draw from here.
      return null;
    }
  }, [zone, surface]);
  if (!drawn) return null;

  const color = active ? ACTIVE : IDLE;
  return (
    <group>
      {drawn.outlines.boundary.map((points, i) => (
        <Line
          key={`boundary-${i}`}
          points={points}
          color={color}
          lineWidth={active ? 2.5 : 1.5}
          depthTest
        />
      ))}
      {drawn.outlines.safe.map((points, i) => (
        <Line
          key={`safe-${i}`}
          points={points}
          color={color}
          lineWidth={1}
          dashed
          dashSize={1}
          gapSize={0.8}
          depthTest
        />
      ))}
      {/* Named on the part, and a way to choose which zone to work on by pointing at it. */}
      <Html position={drawn.labelAt} center zIndexRange={[5, 0]}>
        <button
          type="button"
          className={active ? 'zone-preview-label active' : 'zone-preview-label'}
          onClick={onSelect}
          data-testid={`zone-label-${zone.key}`}
        >
          {name}
        </button>
      </Html>
    </group>
  );
}

/**
 * Conformal zones use the editor's surface patch so this check cannot disagree about the curve.
 * Other mapping types retain their existing analytic preview.
 */
function TestPattern({ zone, surface }: { zone: DecorationZoneDef; surface?: ZoneSurface }) {
  const { w, h } = zoneExtentMm(zone);
  const geometry = useMemo(() => {
    try {
      if (zone.type === 'conformal') {
        if (!surface) return null;
        const { patch } = surface;
        const positions = patch.position.map((value, i) => value + patch.normal[i]! * 0.08);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        // Patch UVs address baked images; CanvasTexture already flips its image vertically.
        const uvs = patch.zoneUv.map((value, i) => (i % 2 === 1 ? 1 - value : value));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(patch.index, 1));
        return geometry;
      }
      const mapper = mapperFor(zone);
      const columns = zone.type === 'cylindrical' ? 32 : 1;
      const rows = 1;
      const positions: number[] = [];
      const uvs: number[] = [];
      for (let row = 0; row <= rows; row++) {
        for (let column = 0; column <= columns; column++) {
          const u = column / columns;
          const v = row / rows;
          const surface = mapper.toWorld({ x: (u - 0.5) * w, y: (v - 0.5) * h });
          positions.push(...surface.position.map((p, i) => p + surface.normal[i]! * 0.08));
          uvs.push(u, v);
        }
      }
      const index: number[] = [];
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const a = row * (columns + 1) + column;
          const c = a + columns + 1;
          index.push(a, a + 1, c + 1, a, c + 1, c);
        }
      }
      const built = new THREE.BufferGeometry();
      built.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      built.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      built.setIndex(index);
      return built;
    } catch {
      return null;
    }
  }, [zone, w, h, surface]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  const texture = usePatternTexture(w, h);
  if (!geometry || !texture) return null;
  return (
    <mesh geometry={geometry} renderOrder={5}>
      <meshBasicMaterial
        map={texture}
        transparent
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-2}
      />
    </mesh>
  );
}

/** The pattern for a zone of this size, rasterised once per size. */
function usePatternTexture(widthMm: number, heightMm: number): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const { invalidate } = useThree();

  useEffect(() => {
    if (!(widthMm > 0 && heightMm > 0)) return;
    let cancelled = false;
    let made: THREE.Texture | null = null;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(testPatternSvg({ widthMm, heightMm }))}`;
    image
      .decode()
      .then(() => {
        if (cancelled) return;
        const scale = 1024 / Math.max(widthMm, heightMm);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(widthMm * scale));
        canvas.height = Math.max(1, Math.round(heightMm * scale));
        const context = canvas.getContext('2d');
        if (!context) return;
        // A pale backing, so the black pattern reads on the grey part without hiding where it sits.
        context.fillStyle = 'rgba(255, 255, 255, 0.72)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        made = new THREE.CanvasTexture(canvas);
        made.colorSpace = THREE.SRGBColorSpace;
        setTexture(made);
        invalidate();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      made?.dispose();
    };
  }, [widthMm, heightMm, invalidate]);

  return texture;
}

/** Which way the zone faces: an arrow out of its centre, along its normal. */
function FacingArrow({
  zone,
  surface,
  size,
}: {
  zone: DecorationZoneDef;
  surface?: ZoneSurface;
  size: number;
}) {
  const at = useMemo(() => {
    try {
      return zone.type === 'conformal'
        ? (surface?.centre ?? null)
        : mapperFor(zone).toWorld({ x: 0, y: 0 });
    } catch {
      return null;
    }
  }, [zone, surface]);
  if (!at) return null;
  return <Marker point={at.position} normal={at.normal} size={size} />;
}

function Marker({ point, normal, size }: { point: Vec3; normal: Vec3; size: number }) {
  const arrow = useMemo(() => {
    const direction = new THREE.Vector3(...normal).normalize();
    const helper = new THREE.ArrowHelper(
      direction,
      new THREE.Vector3(...point),
      size,
      ACTIVE,
      size * 0.3,
      size * 0.18,
    );
    helper.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.Material | undefined;
      if (material) material.depthTest = false;
      object.renderOrder = 11;
    });
    return helper;
  }, [point, normal, size]);
  useEffect(() => () => arrow.dispose(), [arrow]);
  return <primitive object={arrow} />;
}
