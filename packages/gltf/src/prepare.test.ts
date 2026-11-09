import { describe, expect, it } from 'vitest';
import { buildCap, encodeGlb, type MeshData } from './index.js';
import { prepareGlb } from './prepare.js';

type GlbJson = {
  nodes: {
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  scenes: { nodes: number[] }[];
  accessors: {
    count: number;
    bufferView: number;
    componentType: number;
    type: string;
    min?: (number | null)[];
    max?: (number | null)[];
  }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
};
const cap = { ...buildCap({ radiusMm: 19, heightMm: 18, segments: 32 }), material: 1 };
const materials = [{ name: 'empty-assembly' }, { name: 'cap' }];

function unpack(bytes: Buffer): { json: GlbJson; binaryChunk: Buffer } {
  const jsonLength = bytes.readUInt32LE(12);
  return {
    json: JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)) as GlbJson,
    binaryChunk: bytes.subarray(20 + jsonLength),
  };
}
function rewrite(bytes: Buffer, edit: (json: GlbJson) => void): Buffer {
  const { json, binaryChunk } = unpack(bytes);
  edit(json);
  const source = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc((source.length + 3) & ~3, 0x20);
  source.copy(padded);
  const head = Buffer.from(bytes.subarray(0, 20));
  head.writeUInt32LE(20 + padded.length + binaryChunk.length, 8);
  head.writeUInt32LE(padded.length, 12);
  return Buffer.concat([head, padded, binaryChunk]);
}
function legacyEmptyMesh(): Buffer {
  return rewrite(encodeGlb([cap], materials), (json) => {
    json.accessors.unshift({
      count: 0,
      bufferView: 0,
      componentType: 5126,
      type: 'VEC3',
      min: [null, null, null],
      max: [null, null, null],
    });
    json.bufferViews.unshift({ buffer: 0, byteOffset: 0, byteLength: 0 });
    for (const a of json.accessors.slice(1)) a.bufferView++;
    for (const p of json.meshes.flatMap((m) => m.primitives)) {
      for (const key of Object.keys(p.attributes)) p.attributes[key]!++;
      p.indices++;
    }
    json.meshes.unshift({ primitives: [{ attributes: { POSITION: 0 }, indices: 0, material: 0 }] });
    json.nodes = [{ mesh: 0 }, { mesh: 1, translation: [5, 2, -3] }];
    json.scenes[0]!.nodes = [0, 1];
  });
}

describe('CAD GLB transport', () => {
  it('omits empty meshes in new files without changing surviving material indices', () => {
    const empty: MeshData = {
      name: 'empty',
      positions: new Float32Array(),
      normals: new Float32Array(),
      indices: new Uint32Array(),
      material: 0,
    };
    const { json } = unpack(encodeGlb([empty, cap], materials));
    expect(json.meshes).toHaveLength(1);
    expect(json.meshes[0]!.primitives[0]!.material).toBe(1);
    expect(json.accessors.every((a) => a.count > 0)).toBe(true);
    expect(() => encodeGlb([empty], materials)).toThrow('drawable');
  });
  it('leaves healthy source files byte-for-byte unchanged', () => {
    const source = encodeGlb([cap], materials);
    const prepared = prepareGlb(source);
    expect(prepared.bytes).toEqual(source);
    expect(prepared.drawableSlots).toEqual(['cap']);
    expect(prepared.bboxMm).toEqual([
      [-19, 0, -19],
      [19, 18, 19],
    ]);
  });
  it('repairs historical empty accessors while preserving binary geometry and transforms', () => {
    const source = legacyEmptyMesh();
    const original = Buffer.from(source);
    const prepared = prepareGlb(source);
    const before = unpack(source),
      after = unpack(prepared.bytes);
    expect(source).toEqual(original);
    expect(prepared.removedEmptyPrimitives).toBe(1);
    expect(prepared.drawableSlots).toEqual(['cap']);
    expect(prepared.bboxMm).toEqual([
      [-14, 2, -22],
      [24, 20, 16],
    ]);
    expect(after.binaryChunk).toEqual(before.binaryChunk);
    expect(after.json.nodes).toEqual([{}, { mesh: 0, translation: [5, 2, -3] }]);
    expect(after.json.meshes[0]!.primitives[0]!.indices).toBe(
      before.json.meshes[1]!.primitives[0]!.indices - 1,
    );
    expect(after.json.accessors).toHaveLength(before.json.accessors.length - 1);
    expect(prepareGlb(prepared.bytes).removedEmptyPrimitives).toBe(0);
  });
  it('measures nested rotated and scaled geometry in scene space', () => {
    const source = rewrite(encodeGlb([cap], materials), (json) => {
      json.nodes = [
        { translation: [5, 2, -3], children: [1] },
        { mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 1, 1] },
      ];
      json.scenes[0]!.nodes = [0];
    });
    const { bboxMm } = prepareGlb(source);
    expect(bboxMm[0][0]).toBeCloseTo(-13);
    expect(bboxMm[1][0]).toBeCloseTo(5);
    expect(bboxMm[0][1]).toBeCloseTo(-36);
    expect(bboxMm[1][1]).toBeCloseTo(40);
  });
  it('rejects malformed geometry and headers without manufacturing dimensions', () => {
    expect(() => prepareGlb(Buffer.alloc(24))).toThrow('header');
    expect(() =>
      prepareGlb(
        rewrite(encodeGlb([cap], materials), (j) => {
          j.accessors[0]!.count = 1000000;
        }),
      ),
    ).toThrow('exceeds');
    expect(() =>
      prepareGlb(
        rewrite(encodeGlb([cap], materials), (j) => {
          j.scenes[0]!.nodes = [];
        }),
      ),
    ).toThrow('no drawable');
  });
});
