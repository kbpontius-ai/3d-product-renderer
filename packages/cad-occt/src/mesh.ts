import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeGlb, prepareGlb, type MeshData } from '@pr/gltf';
import { slotKeyFor, slotKeysFor, type CadMeshFile, type CadPart } from '@pr/cad';

/**
 * Turning the sidecar's buffers into the GLB a pack ships.
 *
 * The kernel writes flat arrays and stops there. The glTF is encoded here, by the same encoder the
 * fixture meshes and the reference importer use, because the mesh digest is what render dedupe and
 * every parity baseline are keyed on — one encoder means one set of bytes for a given tessellation,
 * on any machine.
 *
 * The grouping is the part worth reading twice. The render path assigns a pack's material slots to
 * the object in declaration order and lets the mesh's own material indices choose between them, so
 * the GLB's material list and the manifest's slot list have to be the same list. Both are built
 * from `slotKeysFor`, and `validateImportResult` checks that they came out equal.
 */

const MAGIC = 'PRMESH01';

export interface PartBlock {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Reads what `occt_import.py` wrote. Deliberately dull; this is the only place that knows it. */
export function readPartBuffer(bytes: Uint8Array): PartBlock[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Buffer.from(bytes.subarray(0, 8)).toString('ascii') !== MAGIC) {
    throw new Error('the importer wrote a buffer this build does not recognise');
  }

  const blocks: PartBlock[] = [];
  let offset = 8;
  const count = view.getUint32(offset, true);
  offset += 4;

  for (let block = 0; block < count; block++) {
    const vertices = view.getUint32(offset, true);
    const indexCount = view.getUint32(offset + 4, true);
    offset += 8;

    // Copied rather than viewed: the source is one big buffer, and a view would keep all of it
    // alive for as long as any one part's geometry is referenced.
    const take = (length: number): Float32Array => {
      const out = new Float32Array(length);
      for (let i = 0; i < length; i++) out[i] = view.getFloat32(offset + i * 4, true);
      offset += length * 4;
      return out;
    };

    const positions = take(vertices * 3);
    const normals = take(vertices * 3);
    const uvs = take(vertices * 2);

    const indices = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) indices[i] = view.getUint32(offset + i * 4, true);
    offset += indexCount * 4;

    blocks.push({ positions, normals, uvs, indices });
  }

  if (offset !== bytes.byteLength) {
    throw new Error(`the importer's buffer has ${bytes.byteLength - offset} trailing bytes`);
  }
  return blocks;
}

/** Concatenates the parts that share a material slot into one mesh, keeping index bases right. */
export function weld(blocks: readonly PartBlock[], name: string, material: number): MeshData {
  const vertexCount = blocks.reduce((sum, block) => sum + block.positions.length / 3, 0);
  const indexCount = blocks.reduce((sum, block) => sum + block.indices.length, 0);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(indexCount);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const block of blocks) {
    positions.set(block.positions, vertexOffset * 3);
    normals.set(block.normals, vertexOffset * 3);
    uvs.set(block.uvs, vertexOffset * 2);
    for (let i = 0; i < block.indices.length; i++)
      indices[indexOffset + i] = block.indices[i]! + vertexOffset;

    vertexOffset += block.positions.length / 3;
    indexOffset += block.indices.length;
  }

  return { name, positions, normals, uvs, indices, material };
}

export interface WriteMeshOptions {
  lod: string;
  outputDir: string;
  parts: readonly CadPart[];
  /** One block per leaf part, in the order the sidecar reported them. */
  blocks: readonly PartBlock[];
  /** Which entry in `parts` each block belongs to. */
  partIndices: readonly number[];
}

/**
 * Writes one LOD's GLB, one material per slot the parts imply.
 *
 * Slot indices come from the same drawable-part list used by draft authoring.
 */
export async function writeMesh(options: WriteMeshOptions): Promise<CadMeshFile> {
  const slots = slotKeysFor(options.parts);
  const bySlot = new Map<string, PartBlock[]>(slots.map((slot) => [slot.key, []]));

  for (const [position, partIndex] of options.partIndices.entries()) {
    const block = options.blocks[position];
    if (!block || block.indices.length === 0 || block.positions.length === 0) continue;
    const part = options.parts[partIndex];
    const key = keyFor(part, slots);
    bySlot.get(key)!.push(block);
  }

  const meshes = slots.map((slot, index) => weld(bySlot.get(slot.key) ?? [], slot.key, index));
  const glb = encodeGlb(
    meshes,
    slots.map((slot) => ({ name: slot.key, roughnessFactor: 0.5 })),
  );

  const fileName = `${options.lod}.glb`;
  await writeFile(join(options.outputDir, fileName), glb);

  return {
    lod: options.lod,
    bboxMm: prepareGlb(glb).bboxMm,
    fileName,
    triangles: meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    bytes: glb.byteLength,
    digest: createHash('sha256').update(glb).digest('hex'),
    // OCCT's UVs are the surface's own parameters, which is what a `conformal` or `flat_panel` zone
    // never looks at and what a `uv_rect` zone cannot rely on: a cylinder's u runs 0..2π, not 0..1,
    // and a trimmed face's range is whatever the trim left. Authored UVs are a separate step
    // (docs/23, decision 1), so this claims only what it has.
    uvSets: ['auto'],
    materialKeys: slots.map((slot) => slot.key),
  };
}

/**
 * Which slot a part's geometry belongs in.
 *
 * `slotKeyFor` is the shared derivation rather than a copy of it. The fallback exists only for a
 * part index the sidecar reported and the parts list does not contain, which would be a bug in the
 * sidecar — putting the geometry in the first slot loses a material assignment, where dropping it
 * would lose the geometry.
 */
function keyFor(part: CadPart | undefined, slots: readonly { key: string }[]): string {
  const key = part ? slotKeyFor(part) : 'body';
  return slots.some((slot) => slot.key === key) ? key : slots[0]!.key;
}
