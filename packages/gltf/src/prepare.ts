import { z } from 'zod';

const index = z.number().int().nonnegative();
const accessorSchema = z
  .object({
    count: index,
    bufferView: index.optional(),
    byteOffset: index.default(0),
    componentType: index,
    type: z.string(),
  })
  .passthrough();
const primitiveSchema = z
  .object({
    attributes: z.record(z.string(), index),
    indices: index.optional(),
    material: index.optional(),
    targets: z.array(z.record(z.string(), index)).optional(),
  })
  .passthrough();
const nodeSchema = z
  .object({
    mesh: index.optional(),
    children: z.array(index).optional(),
    matrix: z.array(z.number()).length(16).optional(),
    translation: z.tuple([z.number(), z.number(), z.number()]).optional(),
    rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    scale: z.tuple([z.number(), z.number(), z.number()]).optional(),
  })
  .passthrough();
const documentSchema = z
  .object({
    asset: z.object({ version: z.literal('2.0') }).passthrough(),
    accessors: z.array(accessorSchema),
    bufferViews: z.array(
      z
        .object({
          buffer: index,
          byteOffset: index.default(0),
          byteLength: index,
          byteStride: index.optional(),
        })
        .passthrough(),
    ),
    meshes: z.array(z.object({ primitives: z.array(primitiveSchema) }).passthrough()),
    nodes: z.array(nodeSchema),
    scenes: z.array(z.object({ nodes: z.array(index) }).passthrough()),
    scene: index.default(0),
    materials: z.array(z.object({ name: z.string().optional() }).passthrough()).default([]),
    images: z.array(z.object({ bufferView: index.optional() }).passthrough()).optional(),
  })
  .passthrough();

type Point = [number, number, number];
type Node = z.infer<typeof nodeSchema>;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 16 }, (_, at) => {
    const row = at % 4;
    const column = Math.floor(at / 4);
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row]! * b[column * 4 + k]!, 0);
  });
}

function nodeMatrix(node: Node): number[] {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

export interface PreparedGlb {
  bytes: Buffer;
  removedEmptyPrimitives: number;
  drawableSlots: string[];
  bboxMm: [Point, Point];
}

export function prepareGlb(bytes: Uint8Array): PreparedGlb {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    source.length < 20 ||
    source.readUInt32LE(0) !== 0x46546c67 ||
    source.readUInt32LE(4) !== 2 ||
    source.readUInt32LE(8) !== source.length
  ) {
    throw new Error('Invalid GLB header.');
  }
  const chunks: { kind: number; bytes: Buffer }[] = [];
  for (let at = 12; at < source.length; ) {
    if (at + 8 > source.length) throw new Error('Truncated GLB chunk.');
    const length = source.readUInt32LE(at);
    const end = at + 8 + length;
    if (end > source.length) throw new Error('Truncated GLB chunk.');
    chunks.push({ kind: source.readUInt32LE(at + 4), bytes: source.subarray(at + 8, end) });
    at = end;
  }
  if (chunks[0]?.kind !== 0x4e4f534a) throw new Error('GLB has no JSON chunk.');
  const binary = chunks.find((chunk) => chunk.kind === 0x004e4942)?.bytes;
  if (!binary) throw new Error('GLB has no geometry buffer.');
  const gltf = documentSchema.parse(JSON.parse(chunks[0].bytes.toString('utf8')));
  const drawable = (p: z.infer<typeof primitiveSchema>): boolean => {
    const positions = gltf.accessors[p.attributes['POSITION'] ?? -1];
    if (!positions) throw new Error('Mesh has no POSITION accessor.');
    return (
      positions.count > 0 &&
      (p.indices === undefined || (gltf.accessors[p.indices]?.count ?? 0) > 0)
    );
  };
  let removedEmptyPrimitives = 0;
  const drawableSlots = new Set<string>();
  const lo: Point = [Infinity, Infinity, Infinity];
  const hi: Point = [-Infinity, -Infinity, -Infinity];
  const visit = (
    nodeId: number,
    parent: readonly number[],
    ancestry: ReadonlySet<number>,
  ): void => {
    if (ancestry.has(nodeId)) throw new Error('GLB node cycle.');
    const node = gltf.nodes[nodeId];
    if (!node) throw new Error('GLB names a missing node.');
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh];
      if (!mesh) throw new Error('GLB names a missing mesh.');
      for (const p of mesh.primitives.filter(drawable)) {
        drawableSlots.add(gltf.materials[p.material ?? -1]?.name ?? 'body');
        const a = gltf.accessors[p.attributes['POSITION']!]!;
        const view = gltf.bufferViews[a.bufferView ?? -1];
        if (!view || view.buffer !== 0 || a.componentType !== 5126 || a.type !== 'VEC3')
          throw new Error('Unsupported CAD position buffer.');
        const stride = view.byteStride ?? 12;
        for (let v = 0; v < a.count; v++) {
          const at = view.byteOffset + a.byteOffset + v * stride;
          if (at + 12 > binary.length || at + 12 > view.byteOffset + view.byteLength)
            throw new Error('Position exceeds geometry buffer.');
          const x = binary.readFloatLE(at),
            y = binary.readFloatLE(at + 4),
            z = binary.readFloatLE(at + 8);
          for (let axis = 0; axis < 3; axis++) {
            const value =
              matrix[axis]! * x +
              matrix[axis + 4]! * y +
              matrix[axis + 8]! * z +
              matrix[axis + 12]!;
            if (!Number.isFinite(value)) throw new Error('Geometry has a non-finite position.');
            lo[axis] = Math.min(lo[axis]!, value);
            hi[axis] = Math.max(hi[axis]!, value);
          }
        }
      }
    }
    const next = new Set(ancestry).add(nodeId);
    for (const child of node.children ?? []) visit(child, matrix, next);
  };
  for (const node of gltf.scenes[gltf.scene]?.nodes ?? []) visit(node, identity, new Set());
  if (!Number.isFinite(lo[0])) throw new Error('GLB has no drawable geometry.');

  const meshMap = new Map<number, number>();
  gltf.meshes = gltf.meshes.flatMap((mesh, old) => {
    const primitives = mesh.primitives.filter(drawable);
    removedEmptyPrimitives += mesh.primitives.length - primitives.length;
    if (primitives.length === 0) return [];
    meshMap.set(old, meshMap.size);
    return [{ ...mesh, primitives }];
  });
  if (!removedEmptyPrimitives)
    return {
      bytes: source,
      removedEmptyPrimitives,
      drawableSlots: [...drawableSlots],
      bboxMm: [lo, hi],
    };
  if (gltf['animations'] || gltf['skins'])
    throw new Error('Empty-mesh repair does not support animated CAD.');
  for (const node of gltf.nodes) {
    if (node.mesh === undefined) continue;
    const mapped = meshMap.get(node.mesh);
    if (mapped === undefined) delete node.mesh;
    else node.mesh = mapped;
  }
  const accessorMap = new Map<number, number>();
  gltf.accessors = gltf.accessors.filter((a, old) => {
    if (!a.count) return false;
    accessorMap.set(old, accessorMap.size);
    return true;
  });
  const remapAccessor = (old: number): number => {
    const value = accessorMap.get(old);
    if (value === undefined) throw new Error('Drawable mesh references an empty accessor.');
    return value;
  };
  for (const mesh of gltf.meshes)
    for (const p of mesh.primitives) {
      for (const key of Object.keys(p.attributes))
        p.attributes[key] = remapAccessor(p.attributes[key]!);
      if (p.indices !== undefined) p.indices = remapAccessor(p.indices);
      for (const target of p.targets ?? [])
        for (const key of Object.keys(target)) target[key] = remapAccessor(target[key]!);
    }
  const viewMap = new Map<number, number>();
  gltf.bufferViews = gltf.bufferViews.filter((view, old) => {
    if (!view.byteLength) return false;
    viewMap.set(old, viewMap.size);
    return true;
  });
  for (const item of [...gltf.accessors, ...(gltf.images ?? [])]) {
    if (item.bufferView === undefined) continue;
    const mapped = viewMap.get(item.bufferView);
    if (mapped === undefined) throw new Error('Data references an empty buffer view.');
    item.bufferView = mapped;
  }
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc((json.length + 3) & ~3, 0x20);
  json.copy(padded);
  chunks[0].bytes = padded;
  const header = Buffer.from(source.subarray(0, 12));
  header.writeUInt32LE(12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.length, 0), 8);
  const result = Buffer.concat([
    header,
    ...chunks.flatMap((chunk) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(chunk.bytes.length, 0);
      h.writeUInt32LE(chunk.kind, 4);
      return [h, chunk.bytes];
    }),
  ]);
  return {
    bytes: result,
    removedEmptyPrimitives,
    drawableSlots: [...drawableSlots],
    bboxMm: [lo, hi],
  };
}
