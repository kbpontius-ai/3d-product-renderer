import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CadImportResult, CadMeshFile } from './contract.js';
import { validateImportResult } from './validate.js';

const glb = (padding = 64): Uint8Array =>
  new Uint8Array(Buffer.concat([Buffer.from('glTF', 'ascii'), Buffer.alloc(padding)]));

const meshOf = (lod: string, bytes: Uint8Array, triangles = 1_000): CadMeshFile => ({
  lod,
  fileName: `${lod}.glb`,
  triangles,
  bytes: bytes.byteLength,
  digest: createHash('sha256').update(bytes).digest('hex'),
  uvSets: ['auto'],
  materialKeys: ['body'],
});

function result(overrides: Partial<CadImportResult> = {}): CadImportResult {
  return {
    status: 'ok',
    importerId: 'test',
    importerVersion: 'test-1',
    format: 'step',
    declaredUnit: 'mm',
    unitAssumed: false,
    bboxMm: [
      [-19, 0, -19],
      [19, 18, 19],
    ],
    parts: [
      {
        name: 'body',
        parentIndex: null,
        bboxMm: [
          [-19, 0, -19],
          [19, 18, 19],
        ],
        triangles: 1_000,
        volumeMm3: 20_000,
        watertight: true,
      },
    ],
    repairs: [],
    meshes: [meshOf('lod0', glb()), meshOf('render', glb(128))],
    symmetryAxis: [0, 1, 0],
    seconds: 1,
    ...overrides,
  };
}

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

describe('validateImportResult', () => {
  it('accepts a plausible result', async () => {
    const bytes: Record<string, Uint8Array> = { 'lod0.glb': glb(), 'render.glb': glb(128) };
    expect(await validateImportResult(result(), { readMesh: async (name) => bytes[name]! })).toEqual([]);
  });

  it('refuses a result missing a mesh the pack needs', async () => {
    const only = result({ meshes: [meshOf('lod0', glb())] });
    expect(codes(await validateImportResult(only))).toContain('mesh_missing');
  });

  it('refuses a file name that is a path', async () => {
    // The name becomes part of a storage key. A `../` in it is not a naming problem.
    const escaped = result();
    const meshes = [{ ...escaped.meshes[0]!, fileName: '../../etc/passwd' }, escaped.meshes[1]!];
    const issues = await validateImportResult({ ...escaped, meshes }, { readMesh: async () => glb() });
    expect(codes(issues)).toContain('unsafe_file_name');
  });

  it('does not read back a mesh whose name it refused', async () => {
    // Reading it is the thing the check exists to prevent, so the check has to come first.
    const escaped = result();
    const meshes = [{ ...escaped.meshes[0]!, fileName: '../secrets' }, escaped.meshes[1]!];
    const read: string[] = [];
    await validateImportResult(
      { ...escaped, meshes },
      {
        readMesh: async (name) => {
          read.push(name);
          return glb();
        },
      },
    );
    expect(read).not.toContain('../secrets');
  });

  it('refuses a mesh that is not a GLB, whatever it is named', async () => {
    const issues = await validateImportResult(result(), {
      readMesh: async () => new Uint8Array(Buffer.from('<?xml version="1.0"?>')),
    });
    expect(codes(issues)).toContain('mesh_not_gltf');
  });

  it('refuses a digest that does not match the bytes on disk', async () => {
    // Render dedupe keys on this digest, so a wrong one silently serves the wrong render.
    const issues = await validateImportResult(result(), { readMesh: async () => glb(96) });
    expect(codes(issues)).toContain('mesh_digest_mismatch');
  });

  it('catches a bounding box with a NaN in it', async () => {
    const broken = result({ bboxMm: [[-19, 0, Number.NaN], [19, 18, 19]] });
    expect(codes(await validateImportResult(broken))).toContain('bbox_not_finite');
  });

  it('catches a bounding box whose max is below its min', async () => {
    const inverted = result({ bboxMm: [[19, 0, -19], [-19, 18, 19]] });
    expect(codes(await validateImportResult(inverted))).toContain('bbox_inverted');
  });

  it('catches the unit mistake, in both directions', async () => {
    // A 38 mm closure read as metres, and a 400 mm carton read as inches. Both produce a mesh that
    // looks perfectly reasonable until it is rendered next to something real.
    const metres = result({ bboxMm: [[-19_000, 0, -19_000], [19_000, 18_000, 19_000]] });
    const inches = result({ bboxMm: [[0, 0, 0], [0.4, 0.5, 0.2]] });
    expect(codes(await validateImportResult(metres))).toContain('bbox_implausible');
    expect(codes(await validateImportResult(inches))).toContain('bbox_implausible');
  });

  it('shows the unit mistake as a size somebody would recognise', async () => {
    // "Off by a factor of 1000" is arithmetic the reader has to do. "38.00 mm" is their part.
    const metres = result({ bboxMm: [[-19_000, 0, -19_000], [19_000, 18_000, 19_000]] });
    const [issue] = (await validateImportResult(metres)).filter((i) => i.code === 'bbox_implausible');
    expect(issue!.message).toContain('38000.00 mm');
    expect(issue!.message).toContain('38.00 mm');
  });

  it('tells an empty part from one that is the wrong size', async () => {
    // A sketch or a construction curve exported alongside the solids has no extent at all. Reported
    // as a unit mistake it sent an operator to check their export units, which were never wrong.
    const empty = { ...result().parts[0]!, name: 'logo_outline', bboxMm: [[0, 0, 0], [0, 0, 0]] as const };
    const issues = await validateImportResult(result({ parts: [result().parts[0]!, empty] }));
    const found = issues.filter((issue) => issue.subject === 'logo_outline');
    expect(codes(found)).toEqual(['part_empty']);
    expect(found[0]!.message).not.toContain('millimetres');
  });

  it('catches a part naming a parent that is not there', async () => {
    const parts = [{ ...result().parts[0]!, parentIndex: 7 }];
    expect(codes(await validateImportResult(result({ parts })))).toContain('part_tree_broken');
  });

  it('catches an assembly tree that loops', async () => {
    const body = result().parts[0]!;
    const parts = [
      { ...body, name: 'a', parentIndex: 1 },
      { ...body, name: 'b', parentIndex: 0 },
    ];
    expect(codes(await validateImportResult(result({ parts })))).toContain('part_tree_broken');
  });

  it('refuses a result with no parts at all', async () => {
    expect(codes(await validateImportResult(result({ parts: [] })))).toContain('no_parts');
  });

  it('refuses a mesh over its streaming budget', async () => {
    const heavy = result({ meshes: [meshOf('lod0', glb(), 2_000_000), meshOf('render', glb(128))] });
    expect(codes(await validateImportResult(heavy))).toContain('budget_exceeded');
  });

  it('reports a breach as sizes, and does not speculate about the cause', async () => {
    // What makes a particular part heavy is a question about the model this code cannot see the
    // answer to. Naming a likely cause reads as a diagnosis and sends somebody to change the wrong
    // thing, so the finding states the two numbers and stops.
    const heavy = result({ meshes: [meshOf('lod0', glb(), 2_000_000), meshOf('render', glb(128))] });
    const [issue] = (await validateImportResult(heavy)).filter((i) => i.code === 'budget_exceeded');
    expect(issue!.message).toContain('triangles');
    expect(issue!.message).toContain('the mesh the editor loads first');
    for (const guess of ['rib', 'fillet', 'detail', 'usually', 'probably', 'simplif']) {
      expect(issue!.message.toLowerCase()).not.toContain(guess);
    }
  });

  it('refuses a scale nobody established', async () => {
    const unresolved = result({ declaredUnit: null, unitAssumed: false });
    expect(codes(await validateImportResult(unresolved))).toContain('unit_unresolved');
  });

  it('refuses an auto-unwrapped mesh for a uv_rect zone', async () => {
    // docs/23, decision 1: auto-UV is for base material texturing. A chart seam in the middle of a
    // texture tile is invisible; a chart seam in the middle of a logo is the product failing.
    const issues = await validateImportResult(result(), { requiresDecorUv: true });
    expect(codes(issues)).toContain('uv_missing_for_decor');

    const authored = result({ meshes: result().meshes.map((mesh) => ({ ...mesh, uvSets: ['decor' as const] })) });
    expect(codes(await validateImportResult(authored, { requiresDecorUv: true }))).not.toContain(
      'uv_missing_for_decor',
    );
  });

  it('reports everything wrong at once, not the first thing', async () => {
    // An operator staring at a failed ingestion wants the list. A second import costs minutes; a
    // second pass over a dozen structs costs nothing.
    const broken = result({
      parts: [],
      bboxMm: [[0, 0, 0], [0.4, 0.5, 0.2]],
      meshes: [meshOf('lod0', glb())],
    });
    expect(new Set(codes(await validateImportResult(broken))).size).toBeGreaterThanOrEqual(3);
  });
});
