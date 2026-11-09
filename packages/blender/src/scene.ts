import { resolve } from 'node:path';
import {
  zoneExtentMm,
  type DecorationZoneDef,
  type RenderSpec,
  type Vec3,
} from '@pr/design-schema';
import { inkShading } from '@pr/materials';
import {
  anyPerpendicular,
  cross,
  normalize,
  orthogonalize,
  resolveDecorationTarget,
} from '@pr/placement';
import { environmentFor, placeLights, subjectFromBbox } from '@pr/scene';
import type { BakedMapRef } from '@pr/render-backend';

/**
 * The generated Blender scene (docs/17 §"Generated Blender script").
 *
 * Blender is driven by a script this function writes, per job, from the spec — never by a
 * user-supplied `.blend` and never by user-supplied Python. Everything variable is passed as JSON
 * and read with `json.load`; nothing from a design is ever interpolated into code.
 *
 * The Python itself is fixed text. That is deliberate: it can be read, diffed and reasoned about
 * once, rather than reassembled differently for every product.
 */

export interface SceneInputs {
  spec: RenderSpec;
  /** Local paths, already fetched and digest-verified by the supervisor. */
  meshPath: string;
  drawableSlots?: string[];
  transportBboxMm?: [Vec3, Vec3];
  /**
   * Metadata for the maps in `bakedDir` — file name, kind, height range.
   *
   * Not the bytes: the scene names files, it does not carry them, which is what lets a backend
   * hand this to a process that never had the buffers.
   */
  baked: BakedMapRef[];
  bakedDir: string;
  outputDir: string;
  /** Blender builds without OpenImageDenoise exist; the supervisor probes and tells us. */
  denoiserAvailable: boolean;
  /** Material textures the supervisor fetched, by the storage key the material names. */
  texturePaths?: Record<string, string>;
  /**
   * The pack's own dimensions.
   *
   * Used twice: to check the import landed in the units we expect, and to size the light rig — a
   * studio built for a 38 mm closure is not the studio for a 300 mm carton.
   */
  bboxMm: [Vec3, Vec3];
}

export interface SceneJob {
  /** The JSON the script reads. Contains no code, and nothing the script executes. */
  data: SceneData;
  /** The Python source. Identical for every job. */
  script: string;
}

interface SceneData {
  meshPath: string;
  /** What the pack says this mesh measures, in millimetres. Checked after import. */
  expectedBboxMm: [Vec3, Vec3] | null;
  outputDir: string;
  bakedDir: string;
  units: { mmToMetres: number };
  materials: Record<string, MaterialData>;
  /** The slot the artwork sits on: by convention the pack's first, as the editor also assumes. */
  decoratedSlot: string;
  placements: PlacementData[];
  zones: Record<string, ZoneFrameData>;
  world: {
    kind: 'studio' | 'hdri';
    hdriPath?: string;
    rotationDeg: number;
    upSource?: [number, number, number];
    strength: number;
    /** How brightly the built-in backdrop photographs; the preview reads the same number. */
    backdropStrength: number;
    /** What the camera sees behind the product, from the environment and the design's choice. */
    background:
      | { kind: 'gradient'; topHex: string; bottomHex: string }
      | { kind: 'solid'; colorHex: string }
      | { kind: 'transparent' };
    /** Positions and powers in the mesh's own millimetres, aimed at the subject. */
    lights: LightData[];
  };
  view: { transform: 'AgX'; exposureEv: number };
  cycles: {
    samples: number;
    maxBounces: number;
    adaptiveThreshold: number;
    seed: number;
    denoise: boolean;
    timeLimitSec: number;
    displacement: 'bump' | 'displacement';
    dicingRate: number;
  };
  outputs: OutputData[];
}

/**
 * A zone reduced to what a shader needs: a rigid transform into zone space, plus whatever the zone
 * type adds on top of it.
 *
 * The vectors come from the same helpers `packages/placement` uses for the preview, so the two
 * renderers cannot drift apart on where a logo sits — the thing this whole project is about.
 */
interface ZoneFrameData {
  key: string;
  kind: 'planar' | 'cylindrical' | 'uv';
  /** Zone origin in millimetres, subtracted before rotating. */
  originMm: [number, number, number];
  /** Rows of the world → zone rotation: [tangent, bitangent, normal] or [u, v, axis]. */
  basisRows: [[number, number, number], [number, number, number], [number, number, number]];
  cylinder: { radiusMm: number; centerAngleDeg: number; centerHeightMm: number } | null;
  uv: {
    uvSet: string;
    rect: { u0: number; v0: number; u1: number; v1: number };
    widthMm: number;
    heightMm: number;
  } | null;
}

interface LightData {
  name: string;
  positionMm: [number, number, number];
  targetMm: [number, number, number];
  sizeMm: number;
  energyW: number;
  colorHex: string;
}

interface MaterialData {
  slot: string;
  baseColorLinear: [number, number, number];
  roughness: number;
  metallic: number;
  ior: number;
  clearcoat: number;
  clearcoatRoughness: number;
  transmission: number;
  emissionStrength: number;
  /** Tiled PBR set, if the material has one (F-MAT-04). Absent maps fall back to the numbers. */
  textures: TextureData | null;
}

interface TextureData {
  /** Local paths, already fetched. A slot with no file is simply not linked. */
  baseColor: string | null;
  roughness: string | null;
  metallic: string | null;
  normal: string | null;
  /** Millimetres covered by one tile of the texture, after the design's scale. */
  tilingMm: number;
  rotationDeg: number;
}

interface PlacementData {
  materialSlot: string;
  id: string;
  zoneKey: string;
  kind: 'emboss' | 'deboss' | 'print';
  mapFile: string | null;
  mapKind: 'height' | 'ink' | null;
  heightRangeMm: [number, number] | null;
  transform: {
    offsetMm: [number, number];
    sizeMm: [number, number];
    rotationDeg: number;
    flipX: boolean;
    flipY: boolean;
  };
  ink: {
    colorLinear: [number, number, number];
    opacity: number;
    metallic: number;
    roughness: number;
    /** 0 for a clear coating: it covers the mark without recolouring it. */
    tintStrength: number;
  } | null;
}

interface OutputData {
  index: number;
  widthPx: number;
  heightPx: number;
  format: 'png8' | 'png16' | 'jpeg' | 'webp';
  alpha: boolean;
  camera: {
    positionMm: [number, number, number];
    targetMm: [number, number, number];
    upMm: [number, number, number];
    focalMm: number;
    sensorMm: number;
    fStop: number | null;
    focusDistanceMm: number | null;
  };
}

export function buildSceneJob(inputs: SceneInputs): SceneJob {
  return { data: sceneData(inputs), script: SCENE_SCRIPT };
}

function sceneData(inputs: SceneInputs): SceneData {
  const { spec } = inputs;
  const lightingOrientation = spec.resolved.environment.orientation ?? spec.resolved.presentationOrientation;
  const bakedFor = new Map(inputs.baked.map((b) => [b.placementId, b]));
  const materials = new Map(spec.resolved.materials.map((m) => [m.key, m.definition]));
  const zones = Object.fromEntries(spec.resolved.zones.map((zone) => [zone.key, zoneFrame(zone)]));

  return {
    // Absolute, always: Blender runs with its own working directory, so a relative path here would
    // resolve against somewhere the caller never meant.
    meshPath: resolve(inputs.meshPath),
    expectedBboxMm: inputs.transportBboxMm ?? inputs.bboxMm,
    outputDir: resolve(inputs.outputDir),
    bakedDir: resolve(inputs.bakedDir),
    units: { mmToMetres: 0.001 },

    decoratedSlot: Object.keys(spec.document.materials)[0] ?? 'body',

    materials: Object.fromEntries(
      Object.entries(spec.document.materials).map(([slot, assignment]) => {
        const definition = materials.get(assignment.materialKey);
        const base = definition?.base;
        return [
          slot,
          {
            slot,
            baseColorLinear: srgbToLinear(assignment.colorHex ?? base?.baseColorHex ?? '#cccccc'),
            roughness: assignment.overrides?.roughness ?? base?.roughness ?? 0.4,
            metallic: assignment.overrides?.metallic ?? base?.metallic ?? 0,
            ior: base?.ior ?? 1.5,
            clearcoat: assignment.overrides?.clearcoat ?? base?.clearcoat ?? 0,
            clearcoatRoughness: base?.clearcoatRoughness ?? 0.05,
            transmission: base?.transmission ?? 0,
            emissionStrength: base?.emissiveStrength ?? 0,
            textures: definition ? textureData(definition, assignment, inputs.texturePaths) : null,
          } satisfies MaterialData,
        ];
      }),
    ),

    placements: spec.document.placements.map((placement) => {
      const baked = bakedFor.get(placement.id);
      // The mark's own material, resolved exactly as the editor resolves it. Both sides call the
      // same function so a gloss varnish cannot be glossy in the viewport and matte in the render.
      const ink = inkShading(placement.finish, materials);

      return {
        id: placement.id,
        materialSlot: resolveDecorationTarget(
          spec.resolved.zones.find((zone) => zone.key === placement.zoneKey)?.materialSlotKey,
          Object.keys(spec.document.materials)[0] ?? 'body',
          inputs.drawableSlots ?? Object.keys(spec.document.materials),
          Object.keys(spec.document.materials),
        ),
        zoneKey: placement.zoneKey,
        kind: placement.finish.kind,
        mapFile: baked?.fileName ?? null,
        mapKind: baked?.kind ?? null,
        heightRangeMm: baked?.rangeMm ? [baked.rangeMm[0], baked.rangeMm[1]] : null,
        transform: {
          offsetMm: [placement.transform.offsetMm.x, placement.transform.offsetMm.y],
          sizeMm: [placement.transform.sizeMm.w, placement.transform.sizeMm.h],
          rotationDeg: placement.transform.rotationDeg,
          flipX: placement.transform.flipX,
          flipY: placement.transform.flipY,
        },
        ink: ink
          ? {
              colorLinear: [ink.colorLinear[0], ink.colorLinear[1], ink.colorLinear[2]],
              opacity: ink.opacity,
              metallic: ink.metallic,
              roughness: ink.roughness,
              tintStrength: ink.tintStrength,
            }
          : null,
      } satisfies PlacementData;
    }),

    zones,

    world: {
      kind: spec.resolved.environment.hdriKey.startsWith('builtin:') ? 'studio' : 'hdri',
      ...(spec.resolved.environment.hdriKey.startsWith('builtin:')
        ? {}
        : { hdriPath: spec.resolved.environment.hdriKey }),
      rotationDeg: spec.resolved.environment.rotationDeg,
      ...(lightingOrientation
        ? { upSource: lightingOrientation.upSource }
        : spec.resolved.environment.key === 'studio-detail-v1'
          ? { upSource: [0, 1, 0] as [number, number, number] }
          : {}),
      strength: 1,
      backdropStrength: environmentFor(spec.resolved.environment.key).backdropStrength,
      background: backgroundFor(spec),
      // The same rig the preview builds, from the same definition: a comparison between them
      // measures the geometry and the materials, not two people's idea of a studio.
      lights: placeLights(
        environmentFor(spec.resolved.environment.key),
        subjectFromBbox(inputs.bboxMm),
        spec.resolved.environment.rotationDeg,
        lightingOrientation,
      ).map((light) => ({
        name: light.name,
        positionMm: [...light.positionMm] as [number, number, number],
        targetMm: [...light.targetMm] as [number, number, number],
        sizeMm: light.sizeMm,
        energyW: light.energyW,
        colorHex: light.colorHex,
      })),
    },

    view: { transform: 'AgX', exposureEv: spec.document.scene.exposureEv },

    cycles: {
      samples: spec.quality.samples,
      maxBounces: spec.quality.maxBounces,
      adaptiveThreshold: spec.quality.adaptiveThreshold,
      seed: spec.seed,
      // A build without a denoiser is a fact about the machine, not about the design.
      denoise: spec.quality.denoiser !== 'none' && inputs.denoiserAvailable,
      timeLimitSec: spec.limits.maxWallClockSec,
      displacement: spec.quality.displacement.mode,
      dicingRate: spec.quality.displacement.dicingRate,
    },

    outputs: spec.outputs.flatMap((output, index) => {
      if (output.kind !== 'image') return []; // v2: turntable video
      if (output.camera.kind !== 'custom') {
        throw new Error('cameras must be resolved to explicit positions before a job is submitted');
      }
      return [
        {
          index,
          widthPx: output.widthPx,
          heightPx: output.heightPx,
          format: output.format,
          alpha: output.alpha,
          camera: {
            positionMm: output.camera.positionMm,
            targetMm: output.camera.targetMm,
            upMm: output.camera.upMm,
            focalMm: output.camera.focalMm,
            sensorMm: output.camera.sensorMm,
            fStop: output.camera.fStop ?? null,
            focusDistanceMm: output.camera.focusDistanceMm ?? null,
          },
        } satisfies OutputData,
      ];
    }),
  };
}

/**
 * The tiled texture set for one slot (F-MAT-04).
 *
 * Returns null unless the material actually has maps and the supervisor fetched them: a material
 * whose textures could not be fetched renders from its numbers rather than failing, which is the
 * difference between a slightly plain product and no render at all.
 *
 * Tiling is in millimetres of product per tile, so a knurl looks the same on a closure and on a
 * drum. The design's scale multiplies that: 2 means each tile covers twice the distance.
 */
function textureData(
  definition: RenderSpec['resolved']['materials'][number]['definition'],
  assignment: RenderSpec['document']['materials'][string],
  texturePaths: Record<string, string> | undefined,
): TextureData | null {
  const maps = definition.maps;
  const at = (reference: { path: string } | undefined): string | null =>
    reference && texturePaths?.[reference.path] ? texturePaths[reference.path]! : null;

  const data: TextureData = {
    baseColor: at(maps.baseColor),
    roughness: at(maps.roughness),
    metallic: at(maps.metallic),
    normal: at(maps.normal),
    tilingMm: (maps.tilingMm || 50) * (assignment.textureScale || 1),
    rotationDeg: assignment.textureRotationDeg || 0,
  };

  return data.baseColor || data.roughness || data.metallic || data.normal ? data : null;
}

/**
 * What the camera sees behind the product (F-SCENE-04).
 *
 * The design decides: the environment's own backdrop, a flat colour, or nothing at all. Transparent
 * is not a colour — it turns the film transparent so the PNG carries alpha, which is what anyone
 * compositing the render onto their own background needs.
 */
function backgroundFor(spec: RenderSpec): SceneData['world']['background'] {
  const chosen = spec.document.scene.background;
  if (chosen.kind === 'solid') return { kind: 'solid', colorHex: chosen.colorHex };
  if (chosen.kind === 'transparent') return { kind: 'transparent' };

  const world = environmentFor(spec.resolved.environment.key).world;
  return world.kind === 'gradient'
    ? { kind: 'gradient', topHex: world.topHex, bottomHex: world.bottomHex }
    : { kind: 'solid', colorHex: world.colorHex };
}

function zoneFrame(zone: DecorationZoneDef): ZoneFrameData {
  const extent = zoneExtentMm(zone);

  if (zone.type === 'planar' || zone.type === 'conformal') {
    const n = normalize(zone.frame.normal);
    const t = orthogonalize(zone.frame.tangent, n);
    const b = cross(n, t);
    return {
      key: zone.key,
      kind: 'planar',
      originMm: [...zone.frame.originMm] as [number, number, number],
      basisRows: [[...t], [...b], [...n]] as ZoneFrameData['basisRows'],
      cylinder: null,
      uv: null,
    };
  }

  if (zone.type === 'cylindrical') {
    const a = normalize(zone.frame.axisDir);
    const u = anyPerpendicular(a);
    const v = cross(a, u);
    return {
      key: zone.key,
      kind: 'cylindrical',
      originMm: [...zone.frame.axisOriginMm] as [number, number, number],
      basisRows: [[...u], [...v], [...a]] as ZoneFrameData['basisRows'],
      cylinder: {
        radiusMm: zone.frame.radiusMm,
        centerAngleDeg: zone.frame.centerAngleDeg,
        centerHeightMm: zone.frame.centerHeightMm,
      },
      uv: null,
    };
  }

  // uv_rect and flat_panel: the pack authored a rectangle of the mesh's own UVs.
  const rect = zone.uvRect;
  return {
    key: zone.key,
    kind: 'uv',
    originMm: [0, 0, 0],
    basisRows: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    cylinder: null,
    uv: {
      uvSet: 'uvSet' in zone ? zone.uvSet : 'decor',
      rect: { u0: rect.u0, v0: rect.v0, u1: rect.u1, v1: rect.v1 },
      widthMm: extent.w,
      heightMm: extent.h,
    },
  };
}

/** sRGB hex to linear RGB, because Cycles inputs are linear and a hex code is not. */
export function srgbToLinear(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const channel = (offset: number): number => {
    const s = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [channel(0), channel(2), channel(4)];
}

/**
 * The script, verbatim.
 *
 * Written as one constant rather than assembled per job so that what runs inside Blender is
 * reviewable as a single artefact, and so a design can never contribute a character of it.
 */
export const SCENE_SCRIPT = String.raw`
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

DATA = json.load(open(sys.argv[sys.argv.index('--') + 1]))
MM = DATA['units']['mmToMetres']


def log(stage, fraction=0.0):
    """The supervisor parses these; nothing else is written to stdout on purpose."""
    print('PR_PROGRESS %s %.4f' % (stage, fraction), flush=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.objects):
        for item in list(block):
            block.remove(item)


def import_mesh(path):
    before = set(bpy.data.objects)
    if path.lower().endswith('.glb') or path.lower().endswith('.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        raise RuntimeError('unsupported mesh format: %s' % path)

    imported = [o for o in set(bpy.data.objects) - before if o.type == 'MESH']
    if not imported:
        raise RuntimeError('mesh file contained no geometry')

    for obj in imported:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = imported[0]
    if len(imported) > 1:
        bpy.ops.object.join()

    obj = bpy.context.view_layer.objects.active

    # Two corrections, both about staying in the pack's own coordinate system.
    #
    # The importer bakes glTF's Y-up into Blender's Z-up; we rotate it straight back, because every
    # zone frame, camera preset and bounding box in a pack is authored in the mesh's own axes, and
    # the preview reads them that way too. And glTF numbers are metres to Blender while packs are
    # authored in millimetres, so the mesh shrinks by a thousand.
    #
    # The mesh data is transformed directly rather than through the transform_apply operator: that
    # one depends on selection and parenting, and quietly applies some components and not others.
    correction = Matrix.Rotation(math.radians(-90.0), 4, 'X') @ Matrix.Scale(MM, 4)
    obj.data.transform(correction @ obj.matrix_world)
    obj.parent = None
    obj.matrix_world = Matrix.Identity(4)
    obj.data.update()

    # glTF transports TEXCOORD_0 as UVMap; the pack calls its authored decoration set decor.
    # Only translate that single known transport layer, never guess among multiple UV sets.
    if any(zone['kind'] == 'uv' and zone['uv']['uvSet'] == 'decor' for zone in DATA['zones'].values()):
        if len(obj.data.uv_layers) == 1 and obj.data.uv_layers[0].name == 'UVMap':
            layer = obj.data.uv_layers[0]
            layer.name = 'decor'
            # Blender flips glTF V for its image convention; zone rectangles use source UVs.
            for loop in layer.data:
                loop.uv.y = 1.0 - loop.uv.y

    check_dimensions(obj)
    return obj


def check_dimensions(obj):
    """Fails loudly if the import did not land where the pack says it should.

    An empty frame is the worst possible failure: it renders, it uploads, and nobody can tell why
    the product is missing. Comparing against the pack's declared bounding box turns a silent
    importer change into a job that says exactly what went wrong.
    """
    expected = DATA.get('expectedBboxMm')
    if not expected:
        return

    # From the vertices, not from obj.bound_box: that one is cached and can still describe the mesh
    # as it arrived rather than as it now is.
    points = [obj.matrix_world @ v.co for v in obj.data.vertices]
    if not points:
        raise RuntimeError('imported mesh has no vertices')
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))

    want_lo = Vector([v * MM for v in expected[0]])
    want_hi = Vector([v * MM for v in expected[1]])
    tolerance = max((want_hi - want_lo).length * 0.02, 1e-4)

    if (lo - want_lo).length > tolerance or (hi - want_hi).length > tolerance:
        raise RuntimeError(
            'imported mesh measures %s..%s but the pack declares %s..%s (metres)'
            % (tuple(round(v, 5) for v in lo), tuple(round(v, 5) for v in hi),
               tuple(round(v, 5) for v in want_lo), tuple(round(v, 5) for v in want_hi))
        )


def make_material(spec):
    mat = bpy.data.materials.new(name=spec['slot'])
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = tuple(spec['baseColorLinear']) + (1.0,)
    bsdf.inputs['Roughness'].default_value = spec['roughness']
    bsdf.inputs['Metallic'].default_value = spec['metallic']
    bsdf.inputs['IOR'].default_value = spec['ior']
    for name, key in (('Coat Weight', 'clearcoat'), ('Coat Roughness', 'clearcoatRoughness'),
                      ('Transmission Weight', 'transmission'), ('Emission Strength', 'emissionStrength')):
        if name in bsdf.inputs:
            bsdf.inputs[name].default_value = spec[key]

    textures = spec.get('textures')
    if textures:
        apply_textures(mat.node_tree, bsdf, textures)
    return mat


def apply_textures(nt, bsdf, textures):
    """Tiled PBR maps in object space (F-MAT-04).

    Generated coordinates rather than UVs: pack meshes carry decoration UVs, not tiling UVs, and a
    knurl or a linen weave has to repeat at a physical size — millimetres of product per tile —
    rather than at whatever density the mesh's unwrap happens to have.
    """
    coords = nt.nodes.new('ShaderNodeTexCoord')
    mapping = nt.nodes.new('ShaderNodeMapping')
    scale = 1000.0 / max(textures['tilingMm'], 0.001)  # tiles per metre
    mapping.inputs['Scale'].default_value = (scale, scale, scale)
    mapping.inputs['Rotation'].default_value = (0.0, 0.0, math.radians(textures['rotationDeg']))
    nt.links.new(coords.outputs['Object'], mapping.inputs['Vector'])

    def image(path, colorspace):
        node = nt.nodes.new('ShaderNodeTexImage')
        node.image = bpy.data.images.load(path)
        node.image.colorspace_settings.name = colorspace
        node.extension = 'REPEAT'
        nt.links.new(mapping.outputs['Vector'], node.inputs['Vector'])
        return node

    if textures.get('baseColor'):
        nt.links.new(image(textures['baseColor'], 'sRGB').outputs['Color'], bsdf.inputs['Base Color'])
    if textures.get('roughness'):
        nt.links.new(image(textures['roughness'], 'Non-Color').outputs['Color'], bsdf.inputs['Roughness'])
    if textures.get('metallic'):
        nt.links.new(image(textures['metallic'], 'Non-Color').outputs['Color'], bsdf.inputs['Metallic'])
    if textures.get('normal'):
        normal_map = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(image(textures['normal'], 'Non-Color').outputs['Color'], normal_map.inputs['Color'])
        nt.links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])


def assign_materials(obj):
    original_names = [m.name if m else '' for m in obj.data.materials]
    original_indices = [p.material_index for p in obj.data.polygons]
    obj.data.materials.clear()
    slots = {}
    for slot, spec in DATA['materials'].items():
        slots[slot] = len(obj.data.materials)
        obj.data.materials.append(make_material(spec))
    for polygon, old_index in zip(obj.data.polygons, original_indices):
        name = original_names[old_index] if old_index < len(original_names) else ''
        polygon.material_index = slots.get(name, slots.get(DATA['decoratedSlot'], 0))
    return slots


def zone_transform_nodes(nt, zone):
    """World metres → zone frame millimetres: scale, translate, rotate, in that order.

    The basis rows come from TypeScript, computed by the very helpers the preview's mappers use,
    so this is wiring rather than geometry.
    """
    geometry = nt.nodes.new('ShaderNodeNewGeometry')

    to_mm = nt.nodes.new('ShaderNodeMapping')
    to_mm.vector_type = 'POINT'
    to_mm.inputs['Scale'].default_value = (1.0 / MM, 1.0 / MM, 1.0 / MM)
    to_mm.inputs['Location'].default_value = tuple(-v for v in zone['originMm'])
    nt.links.new(geometry.outputs['Position'], to_mm.inputs['Vector'])

    rotate = nt.nodes.new('ShaderNodeMapping')
    rotate.vector_type = 'POINT'
    rotate.inputs['Rotation'].default_value = Matrix(zone['basisRows']).to_euler()
    nt.links.new(to_mm.outputs['Vector'], rotate.inputs['Vector'])
    return rotate.outputs['Vector']


def zone_coordinate_nodes(nt, zone):
    """(x, y) in zone millimetres for every shading point. Mirrors docs/15 §2."""
    if zone['kind'] == 'uv':
        uv = nt.nodes.new('ShaderNodeUVMap')
        uv.uv_map = zone['uv']['uvSet']
        rect = zone['uv']['rect']

        # UV rectangle → zone millimetres, origin at the centre.
        place = nt.nodes.new('ShaderNodeMapping')
        place.vector_type = 'POINT'
        place.inputs['Location'].default_value = (-rect['u0'], -rect['v0'], 0.0)
        nt.links.new(uv.outputs['UV'], place.inputs['Vector'])

        span = nt.nodes.new('ShaderNodeMapping')
        span.vector_type = 'POINT'
        span.inputs['Scale'].default_value = (
            zone['uv']['widthMm'] / max(rect['u1'] - rect['u0'], 1e-9),
            zone['uv']['heightMm'] / max(rect['v1'] - rect['v0'], 1e-9),
            1.0,
        )
        span.inputs['Location'].default_value = (
            -zone['uv']['widthMm'] / 2.0,
            -zone['uv']['heightMm'] / 2.0,
            0.0,
        )
        nt.links.new(place.outputs['Vector'], span.inputs['Vector'])
        return span.outputs['Vector']

    local = zone_transform_nodes(nt, zone)
    if zone['kind'] == 'planar':
        return local

    # Cylindrical: unroll the surface. x is arc length from the zone's centre angle, y is height.
    parts = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(local, parts.inputs['Vector'])

    angle = nt.nodes.new('ShaderNodeMath')
    angle.operation = 'ARCTAN2'
    nt.links.new(parts.outputs['Y'], angle.inputs[0])
    nt.links.new(parts.outputs['X'], angle.inputs[1])

    centred = nt.nodes.new('ShaderNodeMath')
    centred.operation = 'SUBTRACT'
    centred.inputs[1].default_value = math.radians(zone['cylinder']['centerAngleDeg'])
    nt.links.new(angle.outputs['Value'], centred.inputs[0])

    # Wrap to (-pi, pi], so a mark that straddles the seam does not tear.
    wrapped = nt.nodes.new('ShaderNodeMath')
    wrapped.operation = 'WRAP'
    wrapped.inputs[1].default_value = math.pi
    wrapped.inputs[2].default_value = -math.pi
    nt.links.new(centred.outputs['Value'], wrapped.inputs[0])

    arc = nt.nodes.new('ShaderNodeMath')
    arc.operation = 'MULTIPLY'
    arc.inputs[1].default_value = zone['cylinder']['radiusMm']
    nt.links.new(wrapped.outputs['Value'], arc.inputs[0])

    height = nt.nodes.new('ShaderNodeMath')
    height.operation = 'SUBTRACT'
    height.inputs[1].default_value = zone['cylinder']['centerHeightMm']
    nt.links.new(parts.outputs['Z'], height.inputs[0])

    combine = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(arc.outputs['Value'], combine.inputs['X'])
    nt.links.new(height.outputs['Value'], combine.inputs['Y'])
    return combine.outputs['Vector']


def placement_uv_nodes(nt, zone_vector, placement):
    """Zone millimetres → artwork UV, by inverting the placement transform (docs/15 §4)."""
    t = placement['transform']

    translate = nt.nodes.new('ShaderNodeMapping')
    translate.vector_type = 'POINT'
    translate.inputs['Location'].default_value = (-t['offsetMm'][0], -t['offsetMm'][1], 0.0)
    nt.links.new(zone_vector, translate.inputs['Vector'])

    rotate = nt.nodes.new('ShaderNodeMapping')
    rotate.vector_type = 'POINT'
    rotate.inputs['Rotation'].default_value = (0.0, 0.0, -math.radians(t['rotationDeg']))
    nt.links.new(translate.outputs['Vector'], rotate.inputs['Vector'])

    fit = nt.nodes.new('ShaderNodeMapping')
    fit.vector_type = 'POINT'
    sx = (-1.0 if t['flipX'] else 1.0) / max(t['sizeMm'][0], 1e-9)
    sy = (-1.0 if t['flipY'] else 1.0) / max(t['sizeMm'][1], 1e-9)
    fit.inputs['Scale'].default_value = (sx, sy, 1.0)
    # The image runs 0..1 with its origin at a corner; zone space has its origin at the centre.
    fit.inputs['Location'].default_value = (0.5, 0.5, 0.0)
    nt.links.new(rotate.outputs['Vector'], fit.inputs['Vector'])
    return fit.outputs['Vector']


def image_node(nt, path, uv, colorspace):
    image = bpy.data.images.load(path, check_existing=True)
    image.colorspace_settings.name = colorspace
    node = nt.nodes.new('ShaderNodeTexImage')
    node.image = image

    # EXTEND, not CLIP. Every baked map is padded with blank border pixels — no relief, no ink — so
    # extending the border says "nothing here" across the rest of the part. CLIP returns black
    # outside the image instead, and black decodes to the bottom of the height range: a five
    # millimetre cliff along the artwork's bounding box, in the shape of a rectangle nobody drew.
    node.extension = 'EXTEND'
    node.interpolation = 'Cubic'
    nt.links.new(uv, node.inputs['Vector'])
    return node


def apply_placement(obj, slots, placement):
    zone = DATA['zones'][placement['zoneKey']]
    slot_name = placement['materialSlot']
    mat = obj.data.materials[slots[slot_name]]
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    output = nt.nodes['Material Output']

    uv = placement_uv_nodes(nt, zone_coordinate_nodes(nt, zone), placement)

    if placement['mapKind'] == 'ink':
        ink = image_node(nt, os.path.join(DATA['bakedDir'], placement['mapFile']), uv, 'Non-Color')
        shade_ink(nt, bsdf, placement['ink'], ink.outputs['Color'])
        return

    height = image_node(nt, os.path.join(DATA['bakedDir'], placement['mapFile']), uv, 'Non-Color')

    # Decode the map back to millimetres, then to metres for the displacement node.
    decode = nt.nodes.new('ShaderNodeMapRange')
    decode.inputs['From Min'].default_value = 0.0
    decode.inputs['From Max'].default_value = 1.0
    decode.inputs['To Min'].default_value = placement['heightRangeMm'][0]
    decode.inputs['To Max'].default_value = placement['heightRangeMm'][1]
    nt.links.new(height.outputs['Color'], decode.inputs['Value'])

    displacement = nt.nodes.new('ShaderNodeDisplacement')
    displacement.inputs['Midlevel'].default_value = 0.0
    displacement.inputs['Scale'].default_value = MM
    nt.links.new(decode.outputs['Result'], displacement.inputs['Height'])
    nt.links.new(displacement.outputs['Displacement'], output.inputs['Displacement'])

    if DATA['cycles']['displacement'] == 'displacement':
        set_displacement_method(mat, 'BOTH')
        modifier = obj.modifiers.new('decor-subdiv', 'SUBSURF')
        modifier.subdivision_type = 'CATMULL_CLARK'
        enable_adaptive_subdivision(obj, modifier, DATA['cycles']['dicingRate'])
    else:
        set_displacement_method(mat, 'BUMP')

    if placement['ink'] is not None:
        # A filled relief: the mark carries foil, ink or varnish as well as depth.
        #
        # Coverage is measured in millimetres of relief, which is what the 0.02 below has always
        # been. It used to read the height image directly, and the height image is an encoding: mid
        # grey is zero relief, so every pixel outside the mark arrived as 0.5 and clamped to fully
        # covered. The whole part took the ink. Nothing caught it because the only filled relief in
        # any suite was checked for having pixels rather than for which pixels, and because base
        # colour was the one channel being mixed - a gold cap next to a gold mark on a dark plate
        # still reads as "the foil worked".
        #
        # Absolute, so a deboss counts too: the mark is filled whether it stands out of the surface
        # or is cut into it, and only its distance from the surface says how much of it there is.
        depth = nt.nodes.new('ShaderNodeMath')
        depth.operation = 'ABSOLUTE'
        nt.links.new(decode.outputs['Result'], depth.inputs[0])

        coverage = nt.nodes.new('ShaderNodeMapRange')
        coverage.inputs['From Min'].default_value = 0.0
        coverage.inputs['From Max'].default_value = 0.02
        coverage.clamp = True
        nt.links.new(depth.outputs['Value'], coverage.inputs['Value'])

        # Roughness and metallic as well as colour. Until the mark shaded from its own material
        # this branch mixed base colour alone, so a foil relief rendered gold and matte while the
        # preview — which has always blended all three — showed it gold and mirrored. Two renderers
        # disagreeing about the same design is the one thing the parity suite exists to catch, and
        # it only ever measured a blind emboss and a printed mark.
        shade_ink(nt, bsdf, placement['ink'], coverage.outputs['Result'])


def shade_ink(nt, bsdf, ink, coverage):
    """Lays a mark's own material over the part's, wherever the mark covers it.

    The coverage argument is a socket carrying 0..1: the ink map for a printed mark, the decoded
    height for a filled relief. The same three channels are blended in both cases, which is what
    makes a printed gloss and an embossed gloss the same material rather than two that merely look
    alike.

    A tint strength of 0 means a clear coating. A spot varnish covers the artwork and changes how it
    takes the light without changing its colour, and multiplying the colour mix by zero is how the
    graph says so - the roughness and metallic blends still run at full coverage.
    """
    tint = ink['tintStrength']
    if tint > 0.0:
        factor = coverage
        if tint < 1.0:
            scale = nt.nodes.new('ShaderNodeMath')
            scale.operation = 'MULTIPLY'
            scale.inputs[1].default_value = tint
            nt.links.new(coverage, scale.inputs[0])
            factor = scale.outputs['Value']

        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.inputs['A'].default_value = bsdf.inputs['Base Color'].default_value
        mix.inputs['B'].default_value = tuple(ink['colorLinear']) + (1.0,)
        nt.links.new(factor, mix.inputs['Factor'])
        nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])

    for name, key in (('Roughness', 'roughness'), ('Metallic', 'metallic')):
        blend = nt.nodes.new('ShaderNodeMix')
        blend.data_type = 'FLOAT'
        blend.inputs['A'].default_value = bsdf.inputs[name].default_value
        blend.inputs['B'].default_value = ink[key]
        nt.links.new(coverage, blend.inputs['Factor'])
        nt.links.new(blend.outputs['Result'], bsdf.inputs[name])


def set_displacement_method(mat, method):
    """The setting moved from material.cycles to the material itself in Blender 4.1."""
    if hasattr(mat, 'displacement_method'):
        mat.displacement_method = method
    else:
        mat.cycles.displacement_method = method


def enable_adaptive_subdivision(obj, modifier, dicing_rate):
    """Adaptive subdivision moved from the object onto the Subsurf modifier in Blender 5.

    Setting the old attribute on 5.x does not warn, it raises — so a renderer that assumed it was
    there failed every displacement render on that version with nothing but an exit code to say so.

    The rates line up: the old per-object dicing_rate scaled the scene's rate, which this never
    changes from its default of one pixel, so the effective target was dicing_rate pixels. The
    modifier's adaptive_pixel_size is that target directly.
    """
    if hasattr(obj.cycles, 'use_adaptive_subdivision'):
        obj.cycles.use_adaptive_subdivision = True
        obj.cycles.dicing_rate = dicing_rate
    else:
        modifier.use_adaptive_subdivision = True
        modifier.adaptive_space = 'PIXEL'
        modifier.adaptive_pixel_size = dicing_rate


def srgb_to_linear4(hex_color):
    """#rrggbb to a linear RGBA tuple. Blender wants linear; hex is always sRGB."""
    value = hex_color.lstrip('#')
    channels = [int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return (linear[0], linear[1], linear[2], 1.0)


def setup_world():
    world = bpy.data.worlds.new('studio')
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    background = nt.nodes['Background']

    if DATA['world']['kind'] == 'hdri':
        environment = nt.nodes.new('ShaderNodeTexEnvironment')
        environment.image = bpy.data.images.load(DATA['world']['hdriPath'])
        mapping = nt.nodes.new('ShaderNodeMapping')
        mapping.inputs['Rotation'].default_value = (0.0, 0.0, math.radians(DATA['world']['rotationDeg']))
        coords = nt.nodes.new('ShaderNodeTexCoord')
        nt.links.new(coords.outputs['Generated'], mapping.inputs['Vector'])
        nt.links.new(mapping.outputs['Vector'], environment.inputs['Vector'])
        nt.links.new(environment.outputs['Color'], background.inputs['Color'])
        background.inputs['Strength'].default_value = DATA['world']['strength']
        return

    # Built-in studio: the backdrop the design asked for, plus the area lights the shared rig sized
    # for this product. No HDRI file to ship, and identical on every machine.
    backdrop = DATA['world']['background']
    if backdrop['kind'] == 'gradient':
        # A vertical gradient in world space: the view direction's z (Blender's up) drives a ramp,
        # so the backdrop reads as a seamless sweep rather than a flat card.
        coords = nt.nodes.new('ShaderNodeTexCoord')
        separate = nt.nodes.new('ShaderNodeSeparateXYZ')
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = 0.35
        ramp.color_ramp.elements[0].color = srgb_to_linear4(backdrop['bottomHex'])
        ramp.color_ramp.elements[1].position = 0.85
        ramp.color_ramp.elements[1].color = srgb_to_linear4(backdrop['topHex'])
        nt.links.new(coords.outputs['Generated'], separate.inputs['Vector'])
        if DATA['world'].get('upSource'):
            dot = nt.nodes.new('ShaderNodeVectorMath')
            dot.operation = 'DOT_PRODUCT'
            dot.inputs[1].default_value = DATA['world']['upSource']
            remap = nt.nodes.new('ShaderNodeMath')
            remap.operation = 'MULTIPLY_ADD'
            remap.inputs[1].default_value = 0.5
            remap.inputs[2].default_value = 0.5
            nt.links.new(coords.outputs['Normal'], dot.inputs[0])
            nt.links.new(dot.outputs['Value'], remap.inputs[0])
            nt.links.new(remap.outputs[0], ramp.inputs['Fac'])
        else:
            nt.links.new(separate.outputs['Z'], ramp.inputs['Fac'])
        nt.links.new(ramp.outputs['Color'], background.inputs['Color'])
        background.inputs['Strength'].default_value = DATA['world']['backdropStrength']
    elif backdrop['kind'] == 'solid':
        background.inputs['Color'].default_value = srgb_to_linear4(backdrop['colorHex'])
        background.inputs['Strength'].default_value = DATA['world']['backdropStrength']
    else:
        # Transparent: the world still lights the product, it just is not photographed. Film
        # transparency is set per output, since only some formats can carry alpha.
        background.inputs['Color'].default_value = (0.05, 0.055, 0.06, 1.0)
        background.inputs['Strength'].default_value = DATA['world']['backdropStrength']

    for spec in DATA['world']['lights']:
        light = bpy.data.lights.new(spec['name'], type='AREA')
        light.shape = 'SQUARE'
        light.size = spec['sizeMm'] * MM
        light.energy = spec['energyW']
        light.color = srgb_to_linear4(spec.get('colorHex', '#ffffff'))[:3]

        obj = bpy.data.objects.new(spec['name'], light)
        position = Vector([c * MM for c in spec['positionMm']])
        target = Vector([c * MM for c in spec['targetMm']])
        obj.location = position
        obj.rotation_euler = (target - position).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.collection.objects.link(obj)


def setup_camera(camera_data):
    camera = bpy.data.cameras.new('camera')
    camera.lens = camera_data['focalMm']
    camera.sensor_width = camera_data['sensorMm']
    # Fit the sensor across the frame's width, always. Blender's default AUTO fits whichever
    # dimension is larger, so a portrait output would silently reframe; the preview anchors on the
    # horizontal angle too, and parity is only meaningful if both do the same thing at every aspect.
    camera.sensor_fit = 'HORIZONTAL'

    position = Vector([c * MM for c in camera_data['positionMm']])
    target = Vector([c * MM for c in camera_data['targetMm']])
    distance = max((target - position).length, 1e-4)

    # Clipping, scaled to the product rather than to Blender's architectural defaults. A 38 mm cap
    # photographed from 40 mm away sits entirely inside the default 0.1 m near plane, and every
    # frame comes back empty with nothing to say why.
    camera.clip_start = distance / 1000.0
    camera.clip_end = distance * 1000.0
    if camera_data['fStop'] is not None:
        camera.dof.use_dof = True
        camera.dof.aperture_fstop = camera_data['fStop']
        camera.dof.focus_distance = (camera_data['focusDistanceMm'] or 100.0) * MM

    obj = bpy.data.objects.new('camera', camera)
    bpy.context.collection.objects.link(obj)
    bpy.context.scene.camera = obj

    obj.matrix_world = look_at(position, target, Vector([c * MM for c in camera_data['upMm']]))
    return obj


def look_at(position, target, up):
    """The camera basis, built the same way three.js builds it.

    Not to_track_quat: that resolves roll by tracking an axis, and for a steeply angled view — a
    closure photographed from above, say — it settles on the opposite solution, which rolls the
    camera 180 degrees. Everything still renders; the product simply appears upside down, and the
    preview and the render disagree about a design nobody changed.
    """
    backward = (position - target)
    if backward.length == 0:
        raise RuntimeError('the camera is at its own target')
    backward.normalize()

    reference = up.normalized() if up.length > 0 else Vector((0.0, 1.0, 0.0))
    right = reference.cross(backward)
    if right.length < 1e-6:
        # Looking straight along the up axis: any perpendicular will do, and this one is stable.
        reference = Vector((1.0, 0.0, 0.0)) if abs(backward.x) < 0.9 else Vector((0.0, 0.0, 1.0))
        right = reference.cross(backward)
    right.normalize()

    basis = Matrix((right, backward.cross(right), backward)).transposed().to_4x4()
    basis.translation = position
    return basis


def setup_cycles():
    scene = bpy.context.scene
    settings = DATA['cycles']
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = settings['samples']
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = settings['adaptiveThreshold']
    scene.cycles.max_bounces = settings['maxBounces']
    scene.cycles.seed = settings['seed']
    scene.cycles.use_denoising = settings['denoise']
    scene.cycles.time_limit = settings['timeLimitSec']
    scene.view_settings.view_transform = DATA['view']['transform']
    scene.view_settings.exposure = DATA['view']['exposureEv']


def render_outputs():
    scene = bpy.context.scene
    total = len(DATA['outputs'])
    for n, output in enumerate(DATA['outputs']):
        setup_camera(output['camera'])
        scene.render.resolution_x = output['widthPx']
        scene.render.resolution_y = output['heightPx']
        scene.render.resolution_percentage = 100
        scene.render.film_transparent = output['alpha']
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_depth = '16' if output['format'] == 'png16' else '8'
        scene.render.image_settings.color_mode = 'RGBA' if output['alpha'] else 'RGB'
        scene.render.filepath = os.path.join(DATA['outputDir'], 'output-%d.png' % output['index'])

        log('trace', n / max(total, 1))
        bpy.ops.render.render(write_still=True)
    log('trace', 1.0)


def main():
    log('build', 0.0)
    reset_scene()
    obj = import_mesh(DATA['meshPath'])
    slots = assign_materials(obj)

    for placement in DATA['placements']:
        apply_placement(obj, slots, placement)

    setup_world()
    setup_cycles()
    log('build', 1.0)
    render_outputs()
    log('done', 1.0)


main()
`.trimStart();
