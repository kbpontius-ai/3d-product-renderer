'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import type { ReactNode } from 'react';
import type { OrientationFrame, Vec3 } from '@pr/design-schema';
import { orientationQuaternion } from '@/lib/orientation-view';
import {
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { sameRelief, type ReliefState } from '@/lib/relief-state';
import { collectDecoratedGeometry, decoratedMeshes } from '@/lib/mesh-arrays';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import {
  environmentFor,
  placeLights,
  subjectFromBbox,
  type CrossSectionPlane,
  type StudioEnvironment,
  type WorldBackground,
} from '@pr/scene';
import type { DecorationZoneDef } from '@pr/design-schema';
import { zoneExtentMm } from '@pr/design-schema';
import {
  buildMeshIndex,
  buildZonePatch,
  patchResolution,
  surfaceCoordinates,
  zoneAlignmentMin,
  zoneSupportsPatch,
  type MeshIndex,
  type SurfaceCoordinates,
  type ZonePatch,
  resolveDecorationTarget,
} from '@pr/placement';
import {
  boundingSphere,
  framePreset,
  verticalFovDeg,
  verticalFovDegForAspect,
  type CameraPresetDef,
  type ResolvedCamera,
} from '@pr/scene';
import { toThreeParams } from '@pr/materials';
import {
  SECTION_RENDER_ORDER,
  sectionCapMaterial,
  sectionCountingMaterials,
  sectionReliefMaterials,
} from '@/lib/cross-section';
import type { MaterialDefinition } from '@pr/design-schema';
import type { SlotAssignment } from '@/lib/design-state';
import { QUALITY_LEVELS, probeDeviceHints, startingLevel } from '@/lib/quality';
import { useAdaptiveQuality } from '@/lib/use-quality';
import { assetHref } from '@/lib/asset-url';
import { createZoneMaterials, zoneUniformValues } from '@/lib/zone-material';

/**
 * The 3D preview ("Look" mode).
 *
 * Geometry comes from the product pack, framing from the pack's camera presets scaled by the
 * bounding sphere, and artwork from the zone texture the 2D view composites — so switching modes
 * cannot show a different design.
 */

export interface ZoneLayers {
  height: HTMLCanvasElement | null;
  ink: HTMLCanvasElement | null;
  texelMm: { x: number; y: number };
  heightRangeMm: number;
  inkRoughness: number;
  inkMetalness: number;
  inkTint: number;
  inkFromHeight: number;
}

/**
 * What the decorated zone is being drawn with.
 *
 * `displaced` is a real subdivided surface the height layer moves (`F-PREV-06`); `shaded` is the
 * fallback, where the relief is normal perturbation on the product's own mesh. The fallback is
 * deliberately silent to the customer — a zone type that cannot produce a patch, or a device the
 * quality ladder has taken geometry away from, should show relief rather than an apology — which
 * is exactly why it needs to be legible to a test.
 */
export type { ReliefState } from '@/lib/relief-state';

export interface Viewport3DProps {
  orientation?: OrientationFrame;
  sceneOverlay?: ReactNode;
  hideControls?: boolean;
  lockedView?: boolean;
  onModelReady?: () => void;
  onDecorationTarget?: (slot: string) => void;
  onSurfacePick?: (normal: Vec3) => void;
  lightingOrientation?: OrientationFrame;
  productOnly?: boolean;
  meshUrl: string;
  bboxMm: [[number, number, number], [number, number, number]];
  zone: DecorationZoneDef;
  layers: ZoneLayers;
  /** Every material this deployment knows, by key; slots name one of them. */
  materials: Record<string, MaterialDefinition>;
  /** What the design puts on each slot (F-MAT-01). */
  assignments: Record<string, SlotAssignment>;
  /** The slot the artwork sits on: the one mesh that gets the zone shader. */
  decoratedSlot: string;
  cameraPresets: CameraPresetDef[];
  presetKey: string;
  onPresetChange: (key: string) => void;
  /**
   * A camera the customer framed by hand, if the design has one (F-SCENE-03).
   *
   * Takes precedence over the preset: they moved it on purpose, and reopening the design to a
   * different view than the one they left is the kind of thing that makes people stop trusting
   * that anything was saved.
   */
  customCamera: ResolvedCamera | null;
  /** Called with the whole resolved camera whenever the customer changes it themselves. */
  onCameraChange: (camera: ResolvedCamera) => void;
  /** Which curated studio lights the product; the renderer is given the same key. */
  environmentKey: string;
  environmentRotationDeg?: number;
  /** What sits behind it: the studio's own backdrop, a flat colour, or nothing (F-SCENE-04). */
  background: { kind: 'studio' } | { kind: 'solid'; colorHex: string } | { kind: 'transparent' };
  /**
   * Called with the drawn canvas after a frame; null while a new scene is preparing.
   *
   * The viewport does not know what a thumbnail is; it knows when it has drawn something.
   */
  onFrame?: (canvas: HTMLCanvasElement | null) => void;
  /**
   * The cuts this product offers, derived by `@pr/scene` from what the pack declares (F-EDIT-11).
   *
   * View state, not design state: a section is how somebody is looking at a product, not something
   * about the product, so it is not stored and does not bump a version. That changes when the cut
   * reaches renders (`F-EDIT-13`) and has to travel in the design document to get there.
   */
  crossSections?: readonly CrossSectionPlane[];
}

/**
 * The studio, built from the shared definition (F-SCENE-01).
 *
 * The same environment the renderer uses, expressed in three.js: emissive planes where the rig puts
 * its area lights, turned into image-based lighting so speculars and reflections have something
 * real to reflect. Previously this was three.js' procedural room while Cycles used a hand-written
 * rig, which meant every preview-versus-render comparison was partly a comparison of two studios.
 *
 * Original profiles retain their irradiance approximation. Detail converts shared area-emitter
 * power to radiance; keeping its emitters out of PMREM prevents counting that light twice.
 */
let areaUniformsInitialized = false;

export function configurePreviewColor(gl: THREE.WebGLRenderer) {
  gl.toneMapping = THREE.AgXToneMapping;
  gl.toneMappingExposure = 1;
}

export function Environment({
  environment,
  subject,
  rotationDeg,
  orientation,
}: {
  environment: StudioEnvironment;
  subject: { centreMm: readonly [number, number, number]; radiusMm: number };
  rotationDeg: number;
  orientation?: THREE.Quaternion;
}) {
  const { gl, scene, invalidate } = useThree();
  const detail = environment.key === 'studio-detail-v1';
  const directLights = useRef<(THREE.DirectionalLight | THREE.RectAreaLight | null)[]>([]);
  const retireEnvironment = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (detail && !areaUniformsInitialized) {
      RectAreaLightUniformsLib.init();
      areaUniformsInitialized = true;
    }
  }, [detail]);
  const target = useMemo(() => new THREE.Object3D(), []);
  const pose = useMemo(() => new THREE.Quaternion(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const centre = useMemo(() => new THREE.Vector3(...subject.centreMm), [subject]);
  const inspecting = Boolean(orientation);

  const lights = useMemo(
    () => placeLights(environment, subject, rotationDeg),
    [environment, subject, rotationDeg],
  );

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const source = new THREE.Scene();

    // The backdrop: a large inverted sphere carrying the environment's own gradient, so what the
    // product reflects is the studio it is standing in.
    const backdrop = environment.world;
    const top = new THREE.Color(backdrop.kind === 'gradient' ? backdrop.topHex : backdrop.colorHex);
    const bottom = new THREE.Color(
      backdrop.kind === 'gradient' ? backdrop.bottomHex : backdrop.colorHex,
    );

    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(subject.radiusMm * 40, 32, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        // The same strength the visible backdrop and the renderer's world shader use: in Cycles one
        // world shader both lights the product and is photographed behind it, so a preview that
        // applied the strength to only one of those would light the product too brightly.
        uniforms: {
          top: { value: top },
          bottom: { value: bottom },
          strength: { value: environment.backdropStrength },
        },
        vertexShader: `varying vec3 vWorld;
          void main() {
            vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform float strength; varying vec3 vWorld;
          void main() {
            float t = clamp(normalize(vWorld).y * 0.5 + 0.5, 0.0, 1.0);
            gl_FragColor = vec4(mix(bottom, top, smoothstep(0.35, 0.85, t)) * strength, 1.0);
          }`,
      }),
    );
    source.add(shell);

    for (const light of detail ? [] : lights) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(light.sizeMm, light.sizeMm),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(light.colorHex).multiplyScalar(light.irradiance),
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      plane.position.set(...(light.positionMm as [number, number, number]));
      if (inspecting) plane.position.sub(new THREE.Vector3(...subject.centreMm));
      if (inspecting) plane.lookAt(0, 0, 0);
      else plane.lookAt(...(light.targetMm as [number, number, number]));
      source.add(plane);
    }

    const generated = pmrem.fromScene(source, 0.04);
    const texture = generated.texture;
    scene.environment = texture;
    invalidate();

    // After the replacement exists, not before. Three shares a compiled program between identical
    // materials only while one of them is alive, so disposing first threw away every program here
    // and relinked them all on each lighting change, which is seconds on a software renderer.
    retireEnvironment.current?.();
    retireEnvironment.current = () => {
      generated.dispose();
      pmrem.dispose();
      source.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
    };
  }, [detail, environment, gl, inspecting, invalidate, lights, scene, subject]);

  useEffect(
    () => () => {
      scene.environment = null;
      scene.environmentRotation.set(0, 0, 0);
      retireEnvironment.current?.();
      retireEnvironment.current = null;
    },
    [scene],
  );

  useEffect(() => {
    invalidate();
  }, [orientation, invalidate]);

  useFrame(() => {
    if (orientation) pose.copy(orientation);
    else pose.identity();
    scene.environmentRotation.setFromQuaternion(pose);
    if (orientation || detail) target.position.copy(centre);
    else target.position.set(0, 0, 0);
    target.updateMatrixWorld();
    for (const [index, light] of lights.entries()) {
      const direct = directLights.current[index];
      if (!direct) continue;
      offset.set(...light.positionMm);
      if (orientation) offset.sub(centre).applyQuaternion(pose).add(centre);
      direct.position.copy(offset);
      if (direct instanceof THREE.RectAreaLight) direct.lookAt(target.position);
      else direct.target = target;
    }
  });

  // Direct light as well as the environment: image-based lighting alone gives soft, shadowless
  // renders, and the relief this product exists to show needs a direction to catch.
  return (
    <>
      <ambientLight intensity={detail ? 0 : environment.ambient * 3} />
      {(inspecting || detail) && <primitive object={target} />}
      {lights.map((light, index) =>
        detail ? (
          <rectAreaLight
            key={light.name}
            ref={(value) => {
              directLights.current[index] = value;
            }}
            position={light.positionMm as unknown as [number, number, number]}
            width={light.sizeMm}
            height={light.sizeMm}
            intensity={light.energyW / (Math.PI * (light.sizeMm / 1000) ** 2)}
            color={light.colorHex}
          />
        ) : (
          <directionalLight
            key={light.name}
            ref={(value) => {
              directLights.current[index] = value;
            }}
            position={light.positionMm as unknown as [number, number, number]}
            intensity={light.irradiance}
            color={light.colorHex}
          />
        ),
      )}
    </>
  );
}

/**
 * The studio's backdrop, as the camera sees it (F-SCENE-04).
 *
 * The renderer sweeps a vertical gradient behind the product; the preview used to paint the
 * gradient's bottom colour flat across the frame, which is both a different picture and — because
 * a clear colour skips the tone mapping every other pixel goes through — a much brighter one. The
 * same design previewed against a backdrop two and a half times brighter than it rendered against.
 *
 * So: the same ramp, at the same strength, on a shell around the subject, drawn through the same
 * AgX transform as everything else. The ramp is a function of the view direction's height rather
 * than of the shell's own coordinates, which is what the renderer's world shader does too — a
 * texture mapped onto the sphere would ramp by angle instead and bend the horizon.
 */
export function Backdrop({
  world,
  strength,
  radiusMm,
  upSource,
}: {
  upSource?: Vec3;
  world: WorldBackground;
  strength: number;
  radiusMm: number;
}) {
  const material = useMemo(() => {
    const top = new THREE.Color(world.kind === 'gradient' ? world.topHex : world.colorHex);
    const bottom = new THREE.Color(world.kind === 'gradient' ? world.bottomHex : world.colorHex);

    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        up: { value: new THREE.Vector3(...(upSource ?? [0, 1, 0])) },
        top: { value: top },
        bottom: { value: bottom },
        strength: { value: strength },
      },
      vertexShader: `varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      // The two includes at the end are what put the backdrop on the same footing as the product:
      // without them it is the one thing in frame that skipped AgX. Only the statements go here —
      // three.js already puts the matching declarations in every fragment shader's prefix, and
      // including the `_pars_` chunks as well redefines those functions and fails to compile.
      fragmentShader: `
        uniform vec3 up;
        uniform vec3 top;
        uniform vec3 bottom;
        uniform float strength;
        varying vec3 vWorld;
        void main() {
          float t = clamp(dot(normalize(vWorld), up) * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottom, top, smoothstep(0.35, 0.85, t)) * strength, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }, [strength, world, upSource]);

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[radiusMm, 32, 24]} />
    </mesh>
  );
}

/**
 * Loads a material's tiled textures and hangs them on a three.js material (F-MAT-04).
 *
 * Tiling is authored in millimetres of product per tile, which Cycles applies in object space. A
 * real-time material tiles by UV, so the repeat is derived from the product's size — an
 * approximation of the same physical density, and one the parity budget covers. Anything sharper
 * would mean triplanar mapping in the preview shader, which is a v2 concern.
 */
interface TextureTarget {
  definition: MaterialDefinition | undefined;
  assignment: SlotAssignment | undefined;
  /**
   * Every material that should carry this slot's textures.
   *
   * More than one since `F-PREV-06`: the decorated slot is shaded by both the product's own
   * material and the displaced patch laid over its zone, and they have to be textured from one
   * load rather than two — a second load is a second copy of the same maps in GPU memory, and two
   * copies is how a substrate ends up tiling differently either side of the patch border.
   */
  materials: (THREE.MeshPhysicalMaterial | null)[];
}

function useTiledTextures(targets: TextureTarget[], sizeMm: number, anisotropy: number): void {
  const { invalidate } = useThree();

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    const loaded: THREE.Texture[] = [];
    let cancelled = false;

    for (const { definition, assignment, materials } of targets) {
      const live = materials.filter((m): m is THREE.MeshPhysicalMaterial => Boolean(m));
      if (!definition || !assignment || live.length === 0) continue;
      applyTo(definition, assignment, live);
    }

    function applyTo(
      definition: MaterialDefinition,
      assignment: SlotAssignment,
      materials: THREE.MeshPhysicalMaterial[],
    ): void {
      const maps = definition.maps;
      const tilingMm = (maps.tilingMm || 50) * (assignment.textureScale || 1);
      const repeat = Math.max(0.1, sizeMm / Math.max(tilingMm, 0.001));

      const wanted: [keyof THREE.MeshPhysicalMaterial, { path: string } | undefined, boolean][] = [
        ['map', maps.baseColor, true],
        ['roughnessMap', maps.roughness, false],
        ['metalnessMap', maps.metallic, false],
        ['normalMap', maps.normal, false],
      ];

      for (const [slot, reference, colour] of wanted) {
        if (!reference?.path) continue;
        void loader.loadAsync(assetHref(reference.path)).then((texture) => {
          if (cancelled) {
            texture.dispose();
            return;
          }
          texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(repeat, repeat);
          texture.center.set(0.5, 0.5);
          texture.rotation = ((assignment.textureRotationDeg || 0) * Math.PI) / 180;
          texture.anisotropy = anisotropy;

          for (const material of materials) {
            (material as unknown as Record<string, unknown>)[slot as string] = texture;
            material.needsUpdate = true;
          }
          loaded.push(texture);
          invalidate();
        });
      }
    }

    return () => {
      cancelled = true;
      for (const texture of loaded) texture.dispose();
    };
  }, [anisotropy, invalidate, sizeMm, targets]);
}

/** A patch's typed arrays as geometry three.js will draw. */
function patchGeometryFrom(patch: ZonePatch, heightRangeMm: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(patch.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(patch.normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(patch.uv, 2));
  geometry.setAttribute('aZoneUv', new THREE.BufferAttribute(patch.zoneUv, 2));
  geometry.setAttribute('aZoneTangent', new THREE.BufferAttribute(patch.tangent, 3));
  geometry.setAttribute('aZoneSupport', new THREE.BufferAttribute(patch.support, 1));
  geometry.setIndex(new THREE.BufferAttribute(patch.index, 1));

  // The bounds three.js computes are of the undisplaced surface; the shader moves vertices off it
  // by up to the height range either way, so anything that reads them gets the truth.
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += heightRangeMm;
  return geometry;
}

class ModelBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state: { error: string | null } = { error: null };

  static getDerivedStateFromError(reason: unknown) {
    return {
      error: reason instanceof Error ? reason.message : 'The model could not be displayed.',
    };
  }

  override render() {
    return this.state.error ? (
      <div className="orientation-load-error" data-testid="viewport-error">
        <p>{this.state.error}</p>
        <p>The design remains available. Staff can review its decoration-zone target in Admin.</p>
      </div>
    ) : (
      this.props.children
    );
  }
}

function Product({
  productOnly = false,
  meshUrl,
  zone,
  layers,
  materials,
  assignments,
  decoratedSlot: legacyDecoratedSlot,
  sizeMm,
  startQuality,
  onRelief,
  clipPlane,
  onModelReady,
  onDecorationTarget,
}: Pick<
  Viewport3DProps,
  | 'productOnly'
  | 'meshUrl'
  | 'zone'
  | 'layers'
  | 'materials'
  | 'assignments'
  | 'decoratedSlot'
  | 'onModelReady'
  | 'onDecorationTarget'
> & {
  /** The cross-section, or null when the product is whole. */
  clipPlane: THREE.Plane | null;
  /** Longest side of the product, for turning millimetres-per-tile into a UV repeat. */
  sizeMm: number;
  /** Where quality starts, from what the device said about itself before the canvas existed. */
  startQuality: number;
  /** Reports what the relief surface turned out to be, for the readout outside the canvas. */
  onRelief: (state: ReliefState) => void;
}) {
  // Measured from here on: the level moves with what this machine actually manages (F-PREV-03).
  const quality = useAdaptiveQuality(startQuality);
  const gltf = useLoader(GLTFLoader, meshUrl);
  useEffect(() => {
    onModelReady?.();
  }, [gltf, onModelReady]);
  const { invalidate } = useThree();

  const scene = useMemo(() => gltf.scene.clone(true), [gltf]);
  const drawableSlots = useMemo(() => {
    const slots = new Set<string>();
    gltf.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (
        !mesh.isMesh ||
        !mesh.geometry.getAttribute('position')?.count ||
        mesh.geometry.index?.count === 0
      )
        return;
      const targets = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const target of targets) slots.add(target.name || legacyDecoratedSlot);
    });
    return [...slots];
  }, [gltf, legacyDecoratedSlot]);
  const decoratedSlot = resolveDecorationTarget(
    zone.materialSlotKey,
    legacyDecoratedSlot,
    !zone.materialSlotKey && !layers.height && !layers.ink
      ? [drawableSlots.includes(legacyDecoratedSlot) ? legacyDecoratedSlot : drawableSlots[0]!]
      : drawableSlots,
    Object.keys(assignments),
  );
  const decorated = assignments[decoratedSlot];
  const material = materials[decorated?.materialKey ?? ''] ?? Object.values(materials)[0]!;
  const colorHex = decorated?.colorHex ?? '#cccccc';
  useEffect(() => onDecorationTarget?.(decoratedSlot), [decoratedSlot, onDecorationTarget]);

  const zoneSizeMm = useMemo(() => zoneExtentMm(zone), [zone]);

  /** Slots that are not the decorated one; everything else on the mesh carries the artwork. */
  const otherSlots = useMemo(
    () => new Set(Object.keys(assignments).filter((slot) => slot !== decoratedSlot)),
    [assignments, decoratedSlot],
  );

  /**
   * A sampler over the decorated surface (`F-PREV-06`).
   *
   * Needed outright by zones defined in the mesh's UV space, by conformal zones to find the real
   * surface under their frame, and by every zone type to recover the base mesh's UVs so a tiled
   * substrate does not jump at the patch border.
   */
  const decoratedGeometry = useMemo(
    () => (productOnly ? null : collectDecoratedGeometry(scene, otherSlots)),
    [scene, otherSlots, productOnly],
  );
  const meshIndex = useMemo<MeshIndex | null>(
    () => (decoratedGeometry ? buildMeshIndex(decoratedGeometry) : null),
    [decoratedGeometry],
  );

  /**
   * The dense zone surface, or null to fall back to shading the relief on the product itself.
   *
   * Rebuilt on a zone or quality change and on nothing else: subdivision depends on the part and
   * the device, not on the artwork, so dragging a logo re-uploads a texture and touches no
   * geometry at all. Failure is a fallback rather than an error — a zone whose type cannot produce
   * a patch still shows its relief, just without a silhouette.
   */
  const patch = useMemo<ZonePatch | null>(() => {
    if (productOnly) return null;
    if (quality.patchQuads <= 0) return null;
    if (!zoneSupportsPatch(zone, Boolean(meshIndex?.hasUvs))) return null;

    try {
      const resolution = patchResolution(zoneExtentMm(zone), {
        targetQuads: quality.patchQuads,
        // Nothing below one height-layer texel is signal, so nothing below it is worth a vertex.
        minSpacingMm: Math.max(1e-3, Math.min(layers.texelMm.x, layers.texelMm.y)),
      });
      return buildZonePatch(zone, resolution, { mesh: meshIndex ?? undefined });
    } catch {
      return null;
    }
  }, [zone, meshIndex, quality.patchQuads, layers.texelMm.x, layers.texelMm.y, productOnly]);

  /**
   * A conformal zone's coordinates, handed to the product's own vertices (zone kind 3).
   *
   * The patch walks the part, so its zone millimetres are measured along the surface, and the
   * product cannot recompute them in a shader — there is no inverse of a walk. Left to treat the
   * zone as planar, it stopped counting itself inside the zone a projection depth off the frame
   * plane: on a 75 mm jar with the 1 mm default, 12 mm from the centre. Beyond that it never got out
   * of the way of a deboss, and covered every pocket. Null for every other zone type, which the
   * shader can map exactly on its own, and whenever there is no patch to read coordinates from.
   */
  const carried = useMemo<SurfaceCoordinates | null>(() => {
    if (zone.type !== 'conformal' || !patch || !decoratedGeometry) return null;
    const result = surfaceCoordinates(patch, zoneExtentMm(zone), decoratedGeometry, {
      alignmentMin: zoneAlignmentMin(zone),
    });
    return result.valid > 0 ? result : null;
  }, [zone, patch, decoratedGeometry]);
  const carriesCoordinates = carried !== null;

  /*
   * Onto the meshes, sliced in the order they were merged. Layout rather than passive: the kind 3
   * material is built in the same render, and a frame drawn between the two would show the product
   * without its coordinates — every pocket covered for one frame.
   *
   * `gltf.scene.clone(true)` shares geometry with the loader's cache, so each mesh gets its own
   * copy before anything is attached to it; another viewer of the same part must not inherit this
   * zone's coordinates.
   */
  useLayoutEffect(() => {
    if (!carried) return;
    const meshes = decoratedMeshes(scene, otherSlots);
    let offset = 0;
    for (const mesh of meshes) {
      if (!mesh.userData['ownsGeometry']) {
        mesh.geometry = mesh.geometry.clone();
        mesh.userData['ownsGeometry'] = true;
      }
      const count = mesh.geometry.getAttribute('position').count;
      const slice = carried.coordinates.subarray(offset * 3, (offset + count) * 3);
      mesh.geometry.setAttribute('aZoneMm', new THREE.BufferAttribute(slice, 3));
      offset += count;
    }
    invalidate();
    return () => {
      for (const mesh of meshes) mesh.geometry.deleteAttribute('aZoneMm');
      invalidate();
    };
  }, [carried, scene, otherSlots, invalidate]);

  useEffect(
    () => () =>
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.userData['ownsGeometry']) mesh.geometry.dispose();
      }),
    [scene],
  );

  const patchGeometry = useMemo(
    () => (patch ? patchGeometryFrom(patch, layers.heightRangeMm) : null),
    [patch, layers.heightRangeMm],
  );
  useEffect(() => () => patchGeometry?.dispose(), [patchGeometry]);

  /**
   * The layers as they stand right now, for the material builder to seed itself from.
   *
   * A new `layers` object arrives on every pointer move of a drag. Rebuilding both materials that
   * often allocates two of everything per frame and — now that they are disposed on replacement —
   * opens a window where a mesh points at a material that has just been thrown away. Everything
   * that changes with a placement is pushed through the shared uniforms instead, which is what
   * they are for.
   */
  const layersRef = useRef(layers);
  layersRef.current = layers;

  const materialSet = useMemo(() => {
    const seed = layersRef.current;
    const params = toThreeParams(material, {
      materialKey: material.key,
      colorHex,
      textureScale: decorated?.textureScale ?? 1,
      textureRotationDeg: decorated?.textureRotationDeg ?? 0,
    });

    // Zero relief, not transparent black: an empty layer decodes to minus the full height range,
    // which under the old bump shader was a constant nobody could see and under displacement is
    // the whole patch sinking into the part.
    const blank = document.createElement('canvas');
    blank.width = 1;
    blank.height = 1;
    const flat = blank.getContext('2d');
    if (flat) {
      flat.fillStyle = 'rgb(128, 128, 128)';
      flat.fillRect(0, 0, 1, 1);
    }

    const height = new THREE.CanvasTexture(seed.height ?? blank);
    height.colorSpace = THREE.NoColorSpace; // data, not colour
    const ink = new THREE.CanvasTexture(seed.ink ?? blank);
    ink.colorSpace = THREE.SRGBColorSpace;

    // The shader flips v itself, because zone space is +y up and the zone canvas is +y down. Left
    // at its default, three.js flips it a second time and the artwork renders upside down — which
    // the face view, drawing the same canvas directly, does not.
    height.flipY = false;
    ink.flipY = false;
    ink.anisotropy = quality.anisotropy;

    return createZoneMaterials(
      params,
      { ...zoneUniformValues(zone), ...(carriesCoordinates ? { kind: 3 as const } : {}) },
      {
        height,
        ink,
        texelMm: new THREE.Vector2(seed.texelMm.x, seed.texelMm.y),
        texelUv: new THREE.Vector2(
          1 / Math.max(1, seed.height?.width ?? 1),
          1 / Math.max(1, seed.height?.height ?? 1),
        ),
        heightRangeMm: seed.heightRangeMm,
        inkRoughness: seed.inkRoughness,
        inkMetalness: seed.inkMetalness,
        inkTint: seed.inkTint,
        inkFromHeight: seed.inkFromHeight,
      },
      {
        patch: patch
          ? {
              // What the grid resolves on its own, so the fragment shader can stop reapplying it.
              stepUv: new THREE.Vector2(
                1 / patch.resolution.segmentsX,
                1 / patch.resolution.segmentsY,
              ),
              spacingMm: new THREE.Vector2(
                patch.resolution.spacingMm.x,
                patch.resolution.spacingMm.y,
              ),
            }
          : null,
        ambientOcclusion: quality.zoneAo,
      },
    );
    // A new material per zone, colour or patch is cheap and keeps the shader cache key honest.
    // `decorated` in full, not just the colour: the memo also reads the texture scale and rotation
    // off it, and listing only some of what a memo reads is how a slot stops responding to half of
    // its own controls.
  }, [
    colorHex,
    decorated,
    material,
    patch,
    quality.anisotropy,
    quality.zoneAo,
    zone,
    carriesCoordinates,
  ]);

  const zoneMaterial = materialSet.base.material;
  const patchMaterial = materialSet.patch?.material ?? null;
  const uniforms = materialSet.uniforms;

  /*
   * Both roles go together, and neither outlives the memo that built it — nor do the two canvas
   * textures they were built around.
   *
   * The editor is a long-lived single page and this memo re-runs on every colour, finish and
   * quality change. Dropping a `CanvasTexture` without disposing it leaves its GPU copy behind,
   * and the symptom of that is not a crash but a machine that gets slower the longer somebody
   * works on a design.
   */
  useEffect(() => {
    // From the material set rather than a ref, for the same reason the upload below does: the ref
    // is written while rendering, so under StrictMode's double invoke it holds the textures of a
    // render that was thrown away. Disposing those frees a copy nothing was using and leaves the
    // committed pair on the GPU — the leak this cleanup exists to prevent.
    const uniforms = materialSet.uniforms;
    const height = uniforms['uZoneHeight']?.value as THREE.Texture | undefined;
    const ink = uniforms['uZoneInk']?.value as THREE.Texture | undefined;
    return () => {
      materialSet.dispose();
      height?.dispose();
      ink?.dispose();
    };
  }, [materialSet]);

  // Re-upload the zone layers whenever the placement or finish changes.
  useEffect(() => {
    // Through the uniforms, which name the textures the meshes are actually sampling.
    //
    // These used to be reached through a ref the material memo wrote while rendering. StrictMode
    // invokes a memo twice in development and keeps one result, so the ref held the textures of the
    // render that was discarded: every upload afterwards landed on a texture nothing sampled. The
    // layer was correct and the frame was drawn, and the relief on screen stayed the previous one —
    // so emboss and deboss produced identical pixels until a mode switch rebuilt the material.
    // Production never double-invokes, which is why `next start` was fine and only `next dev` was
    // not, and why the e2e suite — which builds — could not have caught it.
    const height = uniforms['uZoneHeight']?.value as THREE.Texture | undefined;
    const ink = uniforms['uZoneInk']?.value as THREE.Texture | undefined;
    if (!height || !ink) return;
    if (layers.height) {
      height.image = layers.height;
      height.needsUpdate = true;
    }
    if (layers.ink) {
      ink.image = layers.ink;
      ink.needsUpdate = true;
    }
    uniforms['uZoneTexelMm']!.value = new THREE.Vector2(layers.texelMm.x, layers.texelMm.y);
    uniforms['uZoneTexelUv']!.value = new THREE.Vector2(
      1 / Math.max(1, layers.height?.width ?? 1),
      1 / Math.max(1, layers.height?.height ?? 1),
    );
    uniforms['uZoneInkRoughness']!.value = layers.inkRoughness;
    uniforms['uZoneInkMetalness']!.value = layers.inkMetalness;
    uniforms['uZoneInkTint']!.value = layers.inkTint;
    uniforms['uZoneInkFromHeight']!.value = layers.inkFromHeight;

    // The encode range follows the design's own relief depth now, so it is not a constant the
    // material can be built with and forget — the shader decoding a different range from the one
    // the layer was encoded with is a silent depth error, at exactly the ratio between them.
    uniforms['uZoneHeightRange']!.value = layers.heightRangeMm;
    const aoRadiusMm = Math.min(1.5, Math.max(0.3, layers.heightRangeMm * 2));
    uniforms['uZoneAoRadiusMm']!.value = aoRadiusMm;
    uniforms['uZoneAoRadiusUv']!.value = new THREE.Vector2(
      aoRadiusMm / Math.max(1e-3, zoneSizeMm.w),
      aoRadiusMm / Math.max(1e-3, zoneSizeMm.h),
    );
    invalidate();
  }, [layers, uniforms, invalidate, zoneSizeMm]);

  /**
   * A plain material per slot, for the parts the artwork is not on.
   *
   * Packs name their meshes' materials after the slots they belong to, so a cap's body and its
   * liner can carry different plastics. A mesh that names no slot we know falls back to the
   * decorated one, which is what a single-part product wants anyway.
   */
  const slotMaterials = useMemo(() => {
    const built = new Map<string, THREE.MeshPhysicalMaterial>();

    for (const [slot, assignment] of Object.entries(assignments)) {
      if (slot === decoratedSlot && !productOnly) continue;
      const definition = materials[assignment.materialKey];
      if (!definition) continue;

      const params = toThreeParams(definition, {
        materialKey: definition.key,
        ...(assignment.colorHex ? { colorHex: assignment.colorHex } : {}),
        textureScale: assignment.textureScale,
        textureRotationDeg: assignment.textureRotationDeg,
      });
      built.set(
        slot,
        new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(params.color),
          roughness: params.roughness,
          metalness: params.metalness,
          ior: params.ior,
          clearcoat: params.clearcoat,
          clearcoatRoughness: params.clearcoatRoughness,
          sheen: params.sheen,
          transmission: params.transmission,
          transparent: params.transparent,
          /*
           * Both sides, so a mesh that is not closed does not read as a hole in the product.
           *
           * The fixture closure was an open shell for months and nobody saw it from above the
           * equator; from below, back-face culling removed the whole part and left a crescent of
           * the far side of its own skirt. That fixture is closed now and `F-ADM-01` raises a todo
           * on any pack draft whose parts are not, but neither of those helps a pack that is
           * already published — and three.js flips the normal on a back face, so the cost of being
           * wrong this way is a slightly odd-looking interior instead of a see-through product.
           *
           * Recorded in docs/16 as a preview/render divergence, because Cycles renders the true
           * surface and will still show the hole.
           */
          side: THREE.DoubleSide,
        }),
      );
    }
    return built;
  }, [assignments, decoratedSlot, materials, productOnly]);

  useEffect(() => () => slotMaterials.forEach((material) => material.dispose()), [slotMaterials]);

  // Every part is textured, the decorated one included: its shader composites the artwork on top.
  const textureTargets = useMemo<TextureTarget[]>(
    () => [
      { definition: material, assignment: decorated, materials: [zoneMaterial, patchMaterial] },
      ...[...slotMaterials.entries()].map(([slot, built]) => ({
        definition: materials[assignments[slot]?.materialKey ?? ''],
        assignment: assignments[slot],
        materials: [built],
      })),
    ],
    [assignments, decorated, material, materials, patchMaterial, slotMaterials, zoneMaterial],
  );
  useTiledTextures(textureTargets, sizeMm, quality.anisotropy);

  useEffect(() => {
    scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        const mesh = object as THREE.Mesh;
        const named = (mesh.material as THREE.Material | undefined)?.name ?? '';
        mesh.material =
          slotMaterials.get(named) ??
          (productOnly ? (slotMaterials.get(decoratedSlot) ?? zoneMaterial) : zoneMaterial);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    invalidate();
    // `slotMaterials` matters here: it rebuilds when a part's material or colour changes, and the
    // effect that disposes the previous set runs whether or not this one has re-bound the meshes.
    // Without it, changing an undecorated part left every mesh pointing at a disposed material.
  }, [scene, slotMaterials, zoneMaterial, invalidate, productOnly, decoratedSlot]);

  /*
   * What the relief actually ended up being, for the readout the e2e suite reads. A feature whose
   * absence is a silent fallback needs a way to ask whether it is on.
   *
   * Reported only when it *changes*. This used to hand up a freshly built object every time the
   * effect ran, and the state it sets lives in `Viewport3D` — so every run re-rendered the whole
   * viewport, `Product` included. That is a loop waiting for a reason: anything that gives `patch`
   * a new identity per render (the quality ladder moving `patchQuads` is the obvious one) turns
   * "rebuild once" into "rebuild forever", each iteration rebuilding tens of thousands of
   * triangles. Measured with a deliberately churning dependency, a single colour change went from
   * 60 ms to about five seconds, and React eventually gives up with "Maximum update depth
   * exceeded" pointing at this effect.
   *
   * Comparing before reporting cuts the feedback path: a rebuild that produces the same numbers —
   * which is every rebuild that is not a genuine quality change — now sets no state at all.
   */
  const reportedRef = useRef<ReliefState | null>(null);
  useEffect(() => {
    const next: ReliefState = patch
      ? {
          kind: 'displaced',
          triangles: patch.triangleCount,
          segmentsX: patch.resolution.segmentsX,
          segmentsY: patch.resolution.segmentsY,
          spacingMm: patch.resolution.spacingMm.x,
          fallbackVertices: patch.fallbackVertices,
          clippedTriangles: patch.clippedTriangles,
          bodyVertices: carried?.valid ?? 0,
        }
      : { kind: 'shaded' };

    if (sameRelief(reportedRef.current, next)) return;
    reportedRef.current = next;
    onRelief(next);
  }, [patch, carried, onRelief]);

  /**
   * The cut, applied to everything that draws the product.
   *
   * Set on the materials rather than globally (`renderer.clippingPlanes`) so the backdrop, the
   * studio's emissive panels and the cap itself are left alone — a global plane would slice the
   * room as well as the product, which is not a section of anything.
   */
  useEffect(() => {
    const planes = clipPlane ? [clipPlane] : [];
    const targets: THREE.Material[] = [];
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        targets.push(material);
      }
    });
    if (patchMaterial) targets.push(patchMaterial);

    for (const material of targets) {
      const had = (material.clippingPlanes?.length ?? 0) > 0;
      material.clippingPlanes = planes.length > 0 ? planes : null;
      /*
       * Only when the *count* changes.
       *
       * three compiles the number of clipping planes into the shader, so going from none to one
       * needs a recompile — and nothing else here does. Setting it unconditionally rebuilds the
       * zone material's program on every pass, and that material's uniforms are held by reference
       * elsewhere in this file so the artwork can be re-uploaded without a rebuild. A recompile
       * hands out fresh uniform objects, the held references go stale, and the viewport quietly
       * stops following the design — which is the bug `relief.spec.ts` exists to catch, and did.
       */
      if (had !== planes.length > 0) material.needsUpdate = true;
    }
    invalidate();
  }, [clipPlane, invalidate, patchMaterial, scene]);

  return (
    <>
      <primitive object={scene} />
      {clipPlane && (
        <CrossSectionCap
          scene={scene}
          plane={clipPlane}
          radiusMm={sizeMm}
          colorHex={colorHex}
          patchGeometry={patchGeometry}
          uniforms={uniforms}
        />
      )}
      {patchGeometry && patchMaterial ? (
        /*
         * The patch is built in the same world millimetres the zone frame is authored in, so it is
         * rendered at identity rather than parented to whichever node of the glTF happens to carry
         * the decorated surface.
         *
         * Frustum culling is off because the product this sits on is the only thing in the scene:
         * there is nothing to be gained by culling one more small mesh, and a relief that pops
         * out of existence at the edge of frame to be lost by getting its bounds wrong.
         */
        <mesh geometry={patchGeometry} material={patchMaterial} frustumCulled={false} />
      ) : null}
    </>
  );
}

/**
 * The cut, and the cap that stops it looking like a hole (F-EDIT-11).
 *
 * Clipping alone is not a cross-section. `clippingPlanes` discard fragments in front of the plane,
 * which on a hollow part leaves you looking through the cut at the *inside* of the far wall — a
 * shell with a bite out of it, which reads as a broken model rather than as a section. What makes
 * it read as material is a cap across the cut face.
 *
 * The cap is drawn with the stencil buffer, which is the standard trick and the only one that works
 * on arbitrary geometry. For every mesh in the product, back faces increment the stencil and front
 * faces decrement it, neither writing colour or depth; wherever the count is left non-zero, the
 * viewer is looking through solid material, and a quad laid on the plane is drawn exactly there.
 * Hollow, concave, several separate parts — the count comes out right regardless, because it is
 * counting surfaces crossed rather than assuming anything about the shape.
 *
 * The alternative — reusing the object's own back faces as the cap — is one pass cheaper and wrong
 * on precisely the parts this product is for: the inside of a closure is not where its cut face is.
 */
function CrossSectionCap({
  scene,
  plane,
  radiusMm,
  colorHex,
  patchGeometry,
  uniforms,
}: {
  scene: THREE.Object3D;
  plane: THREE.Plane;
  radiusMm: number;
  colorHex: string;
  patchGeometry: THREE.BufferGeometry | null;
  uniforms: Record<string, THREE.IUniform>;
}) {
  const group = useMemo(() => {
    const root = new THREE.Group();
    scene.updateMatrixWorld(true);

    const sources: THREE.Mesh[] = [];
    scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) sources.push(object as THREE.Mesh);
    });

    for (const source of sources) {
      for (const material of sectionCountingMaterials(plane)) {
        const mesh = new THREE.Mesh(source.geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(source.matrixWorld);
        mesh.renderOrder = SECTION_RENDER_ORDER.counting;
        mesh.frustumCulled = false;
        root.add(mesh);
      }
    }

    if (patchGeometry) {
      for (const material of sectionReliefMaterials(plane, uniforms)) {
        const mesh = new THREE.Mesh(patchGeometry, material);
        mesh.renderOrder = SECTION_RENDER_ORDER.counting;
        mesh.frustumCulled = false;
        root.add(mesh);
      }
    }

    return root;
  }, [plane, scene, patchGeometry, uniforms]);

  const cap = useMemo(() => {
    const material = sectionCapMaterial(colorHex);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radiusMm * 4, radiusMm * 4), material);
    mesh.renderOrder = SECTION_RENDER_ORDER.cap;
    mesh.frustumCulled = false;
    return mesh;
  }, [colorHex, radiusMm]);

  useEffect(
    () => () => {
      cap.geometry.dispose();
      (cap.material as THREE.Material).dispose();
    },
    [cap],
  );
  useEffect(
    () => () => {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) (mesh.material as THREE.Material).dispose();
      });
    },
    [group],
  );

  // The quad has to sit on the plane and face along it, every frame the plane moves.
  useFrame(() => {
    plane.coplanarPoint(cap.position);
    cap.lookAt(
      cap.position.x - plane.normal.x,
      cap.position.y - plane.normal.y,
      cap.position.z - plane.normal.z,
    );
  });

  return (
    <>
      <primitive object={group} />
      <primitive object={cap} />
    </>
  );
}

/**
 * Moves the camera when the preset changes.
 *
 * The `camera` prop on `<Canvas>` only builds the camera; it is not reapplied afterwards, so
 * without this a preset button changes which button looks active and nothing else. Framing comes
 * from the same `framePreset` the render service uses, so picking "Top" here and rendering it
 * produce the same view.
 */
function ApplyCamera({
  camera,
  backdropRadiusMm,
}: {
  camera: ResolvedCamera;
  backdropRadiusMm: number;
}) {
  const { camera: three, controls, invalidate } = useThree();

  useEffect(() => {
    three.position.set(...camera.positionMm);
    three.up.set(...camera.upMm);
    three.lookAt(...camera.targetMm);

    const orbit = controls as { target?: THREE.Vector3; update?: () => void } | null;
    orbit?.target?.set(...camera.targetMm);
    orbit?.update?.();
    invalidate();
  }, [camera, controls, invalidate, three]);

  /**
   * The field of view, kept honest against the frame's actual shape.
   *
   * three.js takes a vertical angle and the renderer fits the sensor across the width, so the two
   * only frame the same thing if the vertical angle is derived from the shared horizontal one and
   * the viewport's aspect. Doing that in an effect is not enough: the effect can run while the
   * layout is still settling — before the loading overlay goes and the panel takes its final height
   * — and the camera then keeps an aspect the canvas no longer has. That is not a subtle error; it
   * drew the product nineteen per cent larger than the render of the same design.
   *
   * Reading the camera's own aspect once a frame is self-healing, and costs nothing on the frames
   * where nothing moved.
   */
  useFrame(() => {
    if (!(three instanceof THREE.PerspectiveCamera)) return;
    // The studio shell must remain inside the far plane even at long lenses or after orbit zoom.
    const far = three.position.length() + backdropRadiusMm * 1.1;
    if (Math.abs(three.far - far) > 1e-6) {
      three.far = far;
      three.updateProjectionMatrix();
    }
    const wanted = verticalFovDegForAspect(camera.focalMm, three.aspect);
    if (Math.abs(three.fov - wanted) < 1e-6) return;
    three.fov = wanted;
    three.updateProjectionMatrix();
  });

  return null;
}

export function Viewport3D({
  productOnly = false,
  meshUrl,
  bboxMm,
  zone,
  layers,
  materials,
  assignments,
  decoratedSlot,
  cameraPresets,
  presetKey,
  onPresetChange,
  customCamera,
  onCameraChange,
  environmentKey,
  environmentRotationDeg = 0,
  background,
  onFrame,
  crossSections = [],
  orientation,
  lightingOrientation,
  sceneOverlay,
  hideControls = false,
  lockedView = false,
  onModelReady,
  onDecorationTarget,
  onSurfacePick,
}: Viewport3DProps) {
  const sphere = useMemo(() => boundingSphere(bboxMm), [bboxMm]);
  const lightPose = useMemo(
    () =>
      lightingOrientation || orientation
        ? orientationQuaternion(lightingOrientation ?? orientation!)
        : undefined,
    [lightingOrientation, orientation],
  );
  const environment = useMemo(() => environmentFor(environmentKey), [environmentKey]);
  const subject = useMemo(() => subjectFromBbox(bboxMm), [bboxMm]);

  /**
   * The opening quality level, decided before the canvas exists (F-PREV-03).
   *
   * Antialiasing is fixed when the WebGL context is created, so it cannot be part of anything that
   * adapts later — which is why the device is asked about itself up front rather than only being
   * measured. Once there is a scene, `useAdaptiveQuality` takes over the part that can move.
   */
  const startQuality = useMemo(() => startingLevel(probeDeviceHints()), []);

  /**
   * The viewport's own background.
   *
   * A flat colour for the two cases that are flat, and nothing at all for the studio — which is a
   * gradient the renderer sweeps across the frame, and which `Backdrop` draws below.
   *
   * Transparent renders come out with alpha, which a canvas cannot show, so the preview draws the
   * dark grey every image editor uses for "nothing here" rather than pretending.
   */
  const backgroundHex =
    background.kind === 'solid'
      ? background.colorHex
      : background.kind === 'transparent'
        ? '#20242c'
        : environment.world.kind === 'solid'
          ? environment.world.colorHex
          : null;
  const preset = cameraPresets.find((p) => p.key === presetKey) ?? cameraPresets[0];
  // framePreset re-derives the distance from the bounding sphere, so a 38 mm cap and a 120 mm
  // carton occupy the same share of the frame.
  const framed = useMemo(
    () => (preset ? framePreset(preset, sphere, undefined, orientation) : null),
    [preset, sphere, orientation],
  );
  // The saved view wins over the preset's framing; the preset is what "Reset view" goes back to.
  const camera = customCamera ?? framed;
  /**
   * How far the preset actually stands off, which is what the orbit limits are built from.
   *
   * They used to be multiples of the bounding radius, and a long lens needs more room than that
   * allowed: an 85 mm preset frames a 38 mm cap from about nine and a half radii, so a ceiling of
   * eight quietly pulled the camera in and the preview drew the product a fifth larger than the
   * render of the same design. Anything derived from the framing distance cannot drift like that.
   */
  const framedDistanceMm = useMemo(
    () =>
      camera
        ? Math.hypot(
            camera.positionMm[0] - camera.targetMm[0],
            camera.positionMm[1] - camera.targetMm[1],
            camera.positionMm[2] - camera.targetMm[2],
          )
        : 1,
    [camera],
  );
  const [ready, setReady] = useState(false);
  const [eventHost, setEventHost] = useState<HTMLDivElement | null>(null);
  const [relief, setRelief] = useState<ReliefState>({ kind: 'shaded' });

  // Progress comes from three's loading manager, which the GLTF loader reports into (F-EDIT-02).
  const { active, progress } = useProgress();

  /**
   * Which cut is open and how far along its own normal it has been pushed.
   *
   * `null` is the whole product, and it is the default: a section is something you go and ask for.
   */
  const [section, setSection] = useState<{ key: string; offsetMm: number } | null>(null);
  const sectionPlane = useMemo(() => {
    const chosen = crossSections.find((plane) => plane.key === section?.key);
    if (!chosen) return null;
    const normal = new THREE.Vector3(...chosen.normal).normalize();
    // Distance from the origin to the plane, negated because three.js measures the constant against
    // the normal's own direction: material on the negative side is what goes.
    const through = new THREE.Vector3(...chosen.originMm).addScaledVector(
      normal,
      section!.offsetMm,
    );
    return new THREE.Plane(normal, -through.dot(normal));
  }, [crossSections, section]);

  if (!camera) return <div className="viewport-3d empty">This product has no camera presets.</div>;

  return (
    <div className="viewport-3d" data-testid="viewport-3d">
      {/*
       * A readout of what the relief is actually being drawn with, hidden from the customer and
       * visible to a test. The fallback from displaced geometry to shading is silent on purpose,
       * so without this there is no way to tell a preview that is displacing from one that quietly
       * decided not to — which is the difference the whole feature consists of.
       */}
      <span data-testid="relief-readout" hidden>
        {relief.kind === 'displaced'
          ? `displaced tris ${relief.triangles} grid ${relief.segmentsX}x${relief.segmentsY} spacing ${relief.spacingMm.toFixed(3)} fallback ${relief.fallbackVertices} clipped ${relief.clippedTriangles} body ${relief.bodyVertices}`
          : 'shaded'}
      </span>
      <ModelBoundary key={`${meshUrl}:${zone.key}:${zone.materialSlotKey ?? ''}`}>
        <div ref={setEventHost} style={{ width: '100%', height: '100%' }}>
          {eventHost && (
            <Canvas
              // Fiber initializes asynchronously; a retained element stays valid if setup closes first.
              eventSource={eventHost}
              frameloop="demand"
              dpr={QUALITY_LEVELS[startQuality]!.dpr}
              gl={{
                antialias: QUALITY_LEVELS[startQuality]!.antialias,
                preserveDrawingBuffer: true,
                // three defaults this off as of r163. The cross-section's cap is drawn from a stencil
                // count, so without it a section is a hole through the back of the product (F-EDIT-11).
                stencil: true,
              }}
              camera={{
                position: camera.positionMm,
                // A starting value only: the canvas has no size yet, so ApplyCamera sets the angle
                // that matches the frame's actual shape as soon as there is one.
                fov: verticalFovDeg(camera.focalMm), // three.js takes VERTICAL fov
                near: sphere.radiusMm * 0.05,
                far: sphere.radiusMm * 40,
              }}
              onCreated={({ gl }) => {
                // PBR preview with image-based lighting and a tone mapping matched to the offline
                // renderer's view transform (F-PREV-01) — the pairing the parity harness measures.
                configurePreviewColor(gl);
                // Per-material, not global: the studio and its backdrop are not part of the section.
                gl.localClippingEnabled = true;
                setReady(true);
              }}
              {...(onFrame ? { onPointerMissed: () => undefined } : {})}
            >
              {backgroundHex ? (
                <color attach="background" args={[backgroundHex]} />
              ) : (
                <Backdrop
                  world={environment.world}
                  strength={environment.backdropStrength}
                  radiusMm={sphere.radiusMm * 30}
                  upSource={(lightingOrientation ?? orientation)?.upSource}
                />
              )}
              <Environment
                environment={environment}
                subject={subject}
                rotationDeg={environmentRotationDeg}
                orientation={lightPose}
              />
              <Suspense fallback={null}>
                <group
                  onClick={(event) => {
                    if (!onSurfacePick || event.delta > 4 || !event.face) return;
                    event.stopPropagation();
                    const normal = event.face.normal
                      .clone()
                      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(event.object.matrixWorld))
                      .normalize();
                    onSurfacePick([normal.x, normal.y, normal.z]);
                  }}
                >
                  <Product
                    productOnly={productOnly}
                    meshUrl={meshUrl}
                    zone={zone}
                    layers={layers}
                    materials={materials}
                    assignments={assignments}
                    decoratedSlot={decoratedSlot}
                    sizeMm={subject.radiusMm * 2}
                    startQuality={startQuality}
                    clipPlane={sectionPlane}
                    onRelief={setRelief}
                    onDecorationTarget={onDecorationTarget}
                    onModelReady={onModelReady}
                  />
                </group>
                {sceneOverlay}
              </Suspense>
              <ApplyCamera camera={camera} backdropRadiusMm={sphere.radiusMm * 30} />
              {onFrame && <AfterFrame onFrame={onFrame} />}
              {/* Orbit, pan and zoom with damping (F-EDIT-01); quality adapts while interacting via
            `useAdaptiveQuality` inside Product. */}
              <OrbitControls
                enabled={!lockedView}
                makeDefault
                target={camera.targetMm}
                enableDamping
                dampingFactor={0.08}
                minDistance={framedDistanceMm * 0.35}
                maxDistance={framedDistanceMm * 3}
                // On end rather than on change: reporting every frame of a drag would put a hundred
                // entries in the undo history and ask the server to save each one.
                onEnd={(event) => {
                  const controls = event?.target as
                    | { object?: THREE.Camera; target?: THREE.Vector3 }
                    | undefined;
                  const object = controls?.object;
                  const target = controls?.target;
                  if (!object || !target) return;

                  onCameraChange({
                    positionMm: object.position.toArray() as [number, number, number],
                    targetMm: target.toArray() as [number, number, number],
                    upMm: object.up.toArray() as [number, number, number],
                    focalMm: camera.focalMm,
                    sensorMm: camera.sensorMm,
                  });
                }}
              />
            </Canvas>
          )}
        </div>
      </ModelBoundary>

      {!hideControls && (
        <div className="viewport-overlay">
          {cameraPresets.map((p) => (
            <button
              key={p.key}
              type="button"
              // No preset is current once the view has been framed by hand: showing one highlighted
              // would claim this is the "Top" view when it is no longer anything of the sort.
              className={!customCamera && p.key === presetKey ? 'active' : ''}
              onClick={() => onPresetChange(p.key)}
              data-testid={`camera-${p.key}`}
            >
              {p.label}
            </button>
          ))}

          {customCamera && (
            <button
              type="button"
              onClick={() => onPresetChange(presetKey)}
              data-testid="camera-reset"
            >
              Reset view
            </button>
          )}
        </div>
      )}
      {!hideControls && crossSections.length > 0 && (
        /*
          The cross-section (F-EDIT-11).

          Named cuts, not a plane picker. Everything here is derived from what the pack already
          declares — the axis the part turns about, the frame the artwork sits on, the bounding box
          — because "select a datum plane" is the interaction this is meant to avoid. One slider,
          in millimetres, because once the orientation is chosen the only thing left to say is how
          far in.
        */
        <div className="viewport-section" data-testid="cross-section">
          <div className="viewport-section-cuts">
            <button
              type="button"
              className={section ? '' : 'active'}
              onClick={() => setSection(null)}
              data-testid="section-off"
            >
              Whole
            </button>
            {crossSections.map((plane) => (
              <button
                key={plane.key}
                type="button"
                className={section?.key === plane.key ? 'active' : ''}
                onClick={() => setSection({ key: plane.key, offsetMm: 0 })}
                data-testid={`section-${plane.key}`}
              >
                {plane.label}
              </button>
            ))}
          </div>

          {section && (
            <label>
              Cut at {section.offsetMm.toFixed(1)} mm
              <input
                type="range"
                min={crossSections.find((p) => p.key === section.key)?.travelMm.min ?? -50}
                max={crossSections.find((p) => p.key === section.key)?.travelMm.max ?? 50}
                step="0.5"
                value={section.offsetMm}
                data-testid="section-offset"
                onChange={(e) => setSection({ key: section.key, offsetMm: Number(e.target.value) })}
              />
            </label>
          )}
        </div>
      )}

      {!hideControls && (
        <div className="viewport-lens">
          {/*
          The lens, in millimetres (F-SCENE-03). Real focal lengths rather than a "zoom" slider,
          because they mean something to the people who brief product photography: a long lens
          flattens a curved label, a short one makes a small closure look like a barrel.
        */}
          <label>
            Lens {Math.round(camera.focalMm)} mm
            <input
              type="range"
              min="24"
              max="200"
              step="1"
              value={Math.round(camera.focalMm)}
              data-testid="lens-focal"
              onChange={(event) =>
                onCameraChange({ ...camera, focalMm: Number(event.target.value) })
              }
            />
          </label>
        </div>
      )}

      {(!ready || active) && (
        <div className="viewport-loading" data-testid="viewport-loading">
          <LoadingSpinner />
          {active && (
            <div className="skeleton-bar" role="progressbar" aria-valuenow={Math.round(progress)}>
              <span style={{ width: `${progress}%` }} />
            </div>
          )}
          <small>{active ? 'Loading the product…' : 'Preparing the studio…'}</small>
        </div>
      )}
    </div>
  );
}

/**
 * Hands the drawn canvas back once the scene has settled.
 *
 * After a frame rather than during one: reading the drawing buffer mid-render costs a stall, and
 * the caller only wants an occasional picture.
 */
function AfterFrame({ onFrame }: { onFrame: (canvas: HTMLCanvasElement | null) => void }) {
  const { gl } = useThree();
  const { active } = useProgress();

  useEffect(() => {
    if (active) {
      delete gl.domElement.dataset.captureReady;
      onFrame(null);
      return;
    }
    // Keep the last drawn canvas usable while ordinary scene updates settle.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        onFrame(gl.domElement);
        gl.domElement.dataset.captureReady = 'true';
      });
    });
    return () => cancelAnimationFrame(frame);
  });

  return null;
}
