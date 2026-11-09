/**
 * Minimal glTF 2.0 / GLB writer.
 *
 * Product packs ship binary meshes; this produces them without pulling in a 3D toolchain, and keeps
 * full control over vertex layout — which matters because decoration zones depend on predictable
 * UVs and millimetre-accurate positions (docs/15-placement-math.md).
 */

export interface MeshData {
  name: string;
  /** Interleaved-free layout: xyz triples, in millimetres. */
  positions: Float32Array;
  normals: Float32Array;
  /** Optional; required only for zones defined in UV space. */
  uvs?: Float32Array;
  indices: Uint32Array;
  /** Index into the materials array supplied to {@link encodeGlb}. */
  material?: number;
}

export interface GlbMaterial {
  name: string;
  baseColorFactor?: [number, number, number, number];
  metallicFactor?: number;
  roughnessFactor?: number;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

const align4 = (n: number) => (n + 3) & ~3;

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3';
  min?: number[];
  max?: number[];
}

function bounds(values: Float32Array, stride: number): { min: number[]; max: number[] } {
  const min = new Array<number>(stride).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(stride).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < values.length; i += stride) {
    for (let c = 0; c < stride; c++) {
      const v = values[i + c]!;
      if (v < min[c]!) min[c] = v;
      if (v > max[c]!) max[c] = v;
    }
  }
  return { min, max };
}

export function encodeGlb(meshes: MeshData[], materials: GlbMaterial[] = []): Buffer {
  const bufferViews: Record<string, number>[] = [];
  const accessors: Accessor[] = [];
  const chunks: Buffer[] = [];
  let byteOffset = 0;

  const pushView = (data: ArrayBufferView, target: number): number => {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const padded = Buffer.alloc(align4(buf.length));
    buf.copy(padded);
    chunks.push(padded);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
    byteOffset += padded.length;
    return bufferViews.length - 1;
  };

  const drawable = meshes.filter((mesh) => mesh.positions.length > 0 && mesh.indices.length > 0);
  if (drawable.length === 0) throw new Error('A GLB needs drawable geometry.');
  const gltfMeshes = drawable.map((mesh) => {
    const positionView = pushView(mesh.positions, TARGET_ARRAY_BUFFER);
    const positionBounds = bounds(mesh.positions, 3);
    accessors.push({
      bufferView: positionView,
      componentType: COMPONENT_FLOAT,
      count: mesh.positions.length / 3,
      type: 'VEC3',
      min: positionBounds.min,
      max: positionBounds.max,
    });
    const positionAccessor = accessors.length - 1;

    const normalView = pushView(mesh.normals, TARGET_ARRAY_BUFFER);
    accessors.push({
      bufferView: normalView,
      componentType: COMPONENT_FLOAT,
      count: mesh.normals.length / 3,
      type: 'VEC3',
    });
    const normalAccessor = accessors.length - 1;

    let uvAccessor: number | undefined;
    if (mesh.uvs) {
      const uvView = pushView(mesh.uvs, TARGET_ARRAY_BUFFER);
      accessors.push({
        bufferView: uvView,
        componentType: COMPONENT_FLOAT,
        count: mesh.uvs.length / 2,
        type: 'VEC2',
      });
      uvAccessor = accessors.length - 1;
    }

    const indexView = pushView(mesh.indices, TARGET_ELEMENT_ARRAY_BUFFER);
    accessors.push({
      bufferView: indexView,
      componentType: COMPONENT_UINT,
      count: mesh.indices.length,
      type: 'SCALAR',
    });
    const indexAccessor = accessors.length - 1;

    return {
      name: mesh.name,
      primitives: [
        {
          attributes: {
            POSITION: positionAccessor,
            NORMAL: normalAccessor,
            ...(uvAccessor === undefined ? {} : { TEXCOORD_0: uvAccessor }),
          },
          indices: indexAccessor,
          ...(mesh.material === undefined ? {} : { material: mesh.material }),
          mode: 4, // triangles
        },
      ],
    };
  });

  const binary = Buffer.concat(chunks);

  const gltf = {
    asset: { version: '2.0', generator: '3d-product-renderer pack tooling' },
    scene: 0,
    scenes: [{ nodes: drawable.map((_, i) => i) }],
    nodes: gltfMeshes.map((mesh, i) => ({ name: mesh.name, mesh: i })),
    meshes: gltfMeshes,
    materials: materials.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColorFactor ?? [0.8, 0.8, 0.8, 1],
        metallicFactor: m.metallicFactor ?? 0,
        roughnessFactor: m.roughnessFactor ?? 0.5,
      },
      doubleSided: false,
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };

  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadded = Buffer.alloc(align4(json.length), 0x20); // JSON chunk pads with spaces
  json.copy(jsonPadded);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binary.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);

  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binary]);
}

export const GLB_CONSTANTS = { GLB_MAGIC, CHUNK_JSON, CHUNK_BIN };
