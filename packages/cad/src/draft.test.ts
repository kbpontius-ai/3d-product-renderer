import { describe, expect, it } from 'vitest';
import { PackManifest, checkPackInvariants, validatePack } from '@pr/design-schema';
import type { CadImportResult, CadPart } from './contract.js';
import { MANY_SLOTS, draftPack, slotKeysFor, slug } from './draft.js';

/** The slots the default parts below imply. The mesh and the manifest must agree on these. */
const SLOTS = ['cap-body', 'liner'];

const bbox = [
  [-19, 0, -19],
  [19, 18, 19],
] as const;

const part = (name: string | null, parentIndex: number | null = null): CadPart => ({
  name,
  parentIndex,
  bboxMm: bbox,
  triangles: 2_000,
  volumeMm3: 20_000,
  watertight: true,
});

function result(over: Partial<CadImportResult> = {}): CadImportResult {
  return {
    status: 'ok',
    importerId: 'reference',
    importerVersion: 'reference-1',
    format: 'step',
    declaredUnit: 'mm',
    unitAssumed: false,
    bboxMm: bbox,
    parts: [part('Cap body'), part('Liner', 0)],
    repairs: [],
    meshes: [
      {
        lod: 'lod0',
        fileName: 'lod0.glb',
        triangles: 2_400,
        bytes: 46_096,
        digest: 'a'.repeat(64),
        uvSets: ['auto'],
        materialKeys: SLOTS,
      },
      {
        lod: 'lod1',
        fileName: 'lod1.glb',
        triangles: 4_800,
        bytes: 91_028,
        digest: 'b'.repeat(64),
        uvSets: ['auto'],
        materialKeys: SLOTS,
      },
      {
        lod: 'render',
        fileName: 'render.glb',
        triangles: 12_800,
        bytes: 240_792,
        digest: 'c'.repeat(64),
        uvSets: ['auto'],
        materialKeys: SLOTS,
      },
    ],
    symmetryAxis: [0, 1, 0],
    seconds: 42,
    ...over,
  };
}

const options = {
  packKey: 'northfield-closures',
  packName: 'Northfield closures',
  productKey: 'cap-flat',
  productName: 'Flat-top closure',
  category: 'closures',
  variantKey: '38mm',
  variantName: '38 mm',
};

const codes = (todos: { code: string }[]) => todos.map((todo) => todo.code);

describe('draftPack', () => {
  it('produces a manifest the schema accepts and the checker finds no errors in', () => {
    const { manifest } = draftPack(result(), options);

    expect(PackManifest.safeParse(manifest).success).toBe(true);
    expect(validatePack(manifest).errors).toEqual([]);
  });

  it('produces a manifest the checker still has warnings about', () => {
    // Structurally sound is not the same as ready. The empties are deliberate, and the warnings are
    // what stop a draft being published by somebody who only checked whether it parsed.
    const { manifest } = draftPack(result(), options);
    expect(validatePack(manifest).issues.length).toBeGreaterThan(0);
  });

  it('makes a slot out of every named part', () => {
    // A STEP assembly already names its parts, and that maps onto material slots directly. Free
    // here, tedious by hand.
    const { manifest } = draftPack(result(), options);
    const slots = manifest.products[0]!.variants[0]!.materialSlots;

    expect(slots.map((slot) => slot.key)).toEqual(['cap-body', 'liner']);
    expect(slots.map((slot) => slot.label)).toEqual(['Cap body', 'Liner']);
    expect(slots.every((slot) => slot.defaultMaterialKey === 'pp-matte')).toBe(true);
  });

  it('folds unnamed parts into one body slot rather than inventing names', () => {
    // A name nobody chose — `part-7` — is worse than no name: it reads like it means something.
    const { manifest } = draftPack(
      result({ parts: [part(null), part(null), part(null)] }),
      options,
    );

    expect(manifest.products[0]!.variants[0]!.materialSlots.map((slot) => slot.key)).toEqual([
      'body',
    ]);
  });

  it('always leaves at least one slot, even with no parts at all', () => {
    const { manifest } = draftPack(result({ parts: [] }), options);
    expect(manifest.products[0]!.variants[0]!.materialSlots).toHaveLength(1);
  });

  it('keeps a slot for every part even when that is too many, and says so', () => {
    // Truncating would be prettier and would also mean the mesh's material indices ran past the end
    // of the slot list — a wrong material on a real product. Ugly beats wrong.
    const many = Array.from({ length: 40 }, (_, index) => part(`Component ${index}`));
    const { manifest, todos } = draftPack(result({ parts: many }), options);

    expect(manifest.products[0]!.variants[0]!.materialSlots).toHaveLength(40);
    expect(codes(todos)).toContain('slots_many');
    expect(MANY_SLOTS).toBeLessThan(40);
  });

  it('omits empty assembly material slots while preserving drawable children and diagnostics', () => {
    const empty = { ...part('Assembly'), triangles: 0, volumeMm3: 0 };
    const parts = [empty, part('Cap body', 0)];
    const meshes = result().meshes.map((mesh) => ({ ...mesh, materialKeys: ['cap-body'] }));
    const imported = result({ parts, meshes });
    const { manifest } = draftPack(imported, options);
    expect(slotKeysFor(parts)).toEqual([{ key: 'cap-body', label: 'Cap body' }]);
    expect(manifest.products[0]!.variants[0]!.materialSlots.map((slot) => slot.key)).toEqual([
      'cap-body',
    ]);
    expect(imported.parts[0]).toEqual(empty);
  });

  it('derives its slots from the same function an importer groups geometry by', () => {
    // The renderer matches the pack's slots to the mesh's materials by position. Two independent
    // derivations of "which parts are one material" is how a skirt comes back in the liner's
    // colour, so there is only one.
    const parts = [part('Cap body'), part('Liner'), part('Cap body'), part(null)];
    const { manifest } = draftPack(result({ parts }), options);

    expect(manifest.products[0]!.variants[0]!.materialSlots.map((slot) => slot.key)).toEqual(
      slotKeysFor(parts).map((slot) => slot.key),
    );
    // Parts sharing a name share a slot, which is what somebody means by naming them the same.
    expect(slotKeysFor(parts).map((slot) => slot.key)).toEqual(['cap-body', 'liner', 'body']);
  });

  it('quotes a body of revolution as diameter and height', () => {
    const { manifest } = draftPack(result(), options);
    expect(manifest.products[0]!.variants[0]!.dimensionsMm).toMatchObject({
      diameter: 38,
      height: 18,
    });
  });

  it('quotes a box as width, height and depth', () => {
    const { manifest } = draftPack(
      result({
        symmetryAxis: null,
        bboxMm: [
          [-40, 0, -20],
          [40, 120, 20],
        ],
      }),
      options,
    );
    expect(manifest.products[0]!.variants[0]!.dimensionsMm).toMatchObject({
      width: 80,
      height: 120,
      depth: 40,
    });
  });

  it('gives a box a side preset and a closure none', () => {
    // A box's fourth face is a different face; a cylinder's is the same one turned.
    const closure = draftPack(result(), options).manifest.products[0]!.variants[0]!.cameraPresets;
    const box = draftPack(result({ symmetryAxis: null }), options).manifest.products[0]!
      .variants[0]!.cameraPresets;

    expect(closure.map((preset) => preset.key)).not.toContain('side');
    expect(box.map((preset) => preset.key)).toContain('side');
  });

  it('flags a part that would orbit lying on its side', () => {
    // Camera presets are spherical around world up. A part whose axis runs along Z is not wrong,
    // but every preset drafted for it would be.
    const { todos } = draftPack(result({ symmetryAxis: [0, 0, 1] }), options);
    expect(codes(todos)).toContain('axis_not_vertical');
  });

  it('ignores a symmetry direction that is not close to an axis', () => {
    const { manifest } = draftPack(result({ symmetryAxis: [0.6, 0.6, 0.5] }), options);
    // Nothing here can reason about it, and "diameter" on a thing that has none is worse than
    // three numbers that are merely blunt.
    expect(manifest.products[0]!.variants[0]!.dimensionsMm).toMatchObject({ width: 38 });
  });

  it('carries the mesh digests into the manifest', () => {
    // Render dedupe and the parity budget are keyed on these; retyping them by hand is how a pack
    // ends up pointing at a mesh nobody rendered against.
    const { manifest } = draftPack(result(), options);
    const assets = manifest.products[0]!.variants[0]!.assets;

    expect(assets.lod0).toMatchObject({
      path: 'meshes/cap-flat/38mm/lod0.glb',
      digest: 'a'.repeat(64),
      bytes: 46_096,
    });
    expect(assets.renderMesh.digest).toBe('c'.repeat(64));
    expect(assets.lod1?.path).toBe('meshes/cap-flat/38mm/lod1.glb');
  });

  it('omits lod1 when the import did not produce one', () => {
    const withoutLod1 = result({ meshes: result().meshes.filter((mesh) => mesh.lod !== 'lod1') });
    expect(
      draftPack(withoutLod1, options).manifest.products[0]!.variants[0]!.assets.lod1,
    ).toBeUndefined();
  });

  it('refuses to draft half a manifest from an import with no render mesh', () => {
    const withoutRender = result({
      meshes: result().meshes.filter((mesh) => mesh.lod !== 'render'),
    });
    expect(() => draftPack(withoutRender, options)).toThrow(/no lod0 or render mesh/);
  });

  it('leaves the zones empty, and says why', () => {
    // Geometry cannot tell you where a customer may put a logo. A draft that guessed would be a
    // draft somebody published without reading.
    const { manifest, todos } = draftPack(result(), options);

    expect(manifest.products[0]!.variants[0]!.zones).toEqual([]);
    expect(codes(todos)).toContain('zones_missing');
    // Which is exactly what the invariant checker warns about, and it should keep warning until a
    // person has been through it.
    expect(checkPackInvariants(manifest).map((issue) => issue.code)).toContain('no_zones');
  });

  it('says a uv_rect zone cannot come from this import when nothing carries authored UVs', () => {
    expect(codes(draftPack(result(), options).todos)).toContain('no_authored_uvs');

    const authored = result({
      meshes: result().meshes.map((mesh) => ({ ...mesh, uvSets: ['decor' as const] })),
    });
    expect(codes(draftPack(authored, options).todos)).not.toContain('no_authored_uvs');
  });

  it('surfaces the repairs the kernel made', () => {
    // A healed shape is not the shape the supplier sent, and somebody will eventually need to know
    // that — usually the person holding a tool trial that does not match.
    const healed = result({
      repairs: [
        { kind: 'sewed_shell', count: 4 },
        { kind: 'dropped_free_edge', count: 11 },
      ],
    });
    const todo = draftPack(healed, options).todos.find((entry) => entry.code === 'repairs_applied');

    expect(todo?.message).toContain('15');
    expect(todo?.message).toContain('sewed_shell');
  });

  it('surfaces parts that are open shells rather than closed solids', () => {
    /*
     * The defect this catches, in the words of the thing that had it: a closure with no bore, no
     * ceiling and no bottom rim looks perfect from every angle above the equator, and from below a
     * single-sided material culls it away and you see through the product. Nothing refused it,
     * because nothing read `watertight`.
     */
    const base = result();
    const open = result({
      parts: base.parts.map((part, index) => (index === 0 ? { ...part, watertight: false } : part)),
    });

    const todo = draftPack(open, options).todos.find((entry) => entry.code === 'not_watertight');
    expect(todo?.message).toContain('open shells');
    expect(todo?.message).toContain(base.parts[0]!.name ?? 'part 0');
  });

  it('names an unnamed open part by its place in the file, not its place in the list', () => {
    // The only handle a nameless part has is its index, and the index that helps somebody open the
    // file and look is the one the importer read it at — not the one it landed on after filtering.
    const open = result({ parts: [part('Cap body'), { ...part(null, 0), watertight: false }] });

    const todo = draftPack(open, options).todos.find((entry) => entry.code === 'not_watertight');
    expect(todo?.message).toContain('part 1');
  });

  it('says nothing about watertightness when every part is a solid', () => {
    // A todo nobody has to act on is noise, and this file already produces enough of them.
    expect(codes(draftPack(result(), options).todos)).not.toContain('not_watertight');
  });

  it('surfaces a unit that was assumed rather than declared', () => {
    const assumed = result({ declaredUnit: null, unitAssumed: true });
    const todo = draftPack(assumed, options).todos.find((entry) => entry.code === 'unit_assumed');

    expect(todo?.message).toContain('38 × 18 × 38 mm');
  });

  it('starts at 0.1.0, because a draft is not a release', () => {
    // Pack versions are immutable once published; starting at 1.0.0 would spend the number a
    // finished pack wants on something nobody has read yet.
    expect(draftPack(result(), options).manifest.version).toBe('0.1.0');
    expect(draftPack(result(), { ...options, version: '2.3.0' }).manifest.version).toBe('2.3.0');
  });

  it('records what produced the meshes', () => {
    expect(draftPack(result(), options).manifest.description).toContain('reference reference-1');
  });
});

describe('slug', () => {
  it('turns a CAD part name into a manifest key', () => {
    expect(slug('Cap Body')).toBe('cap-body');
    expect(slug('SHELL_OUTER (rev B)')).toBe('shell_outer-rev-b');
    expect(slug('  spacer  ')).toBe('spacer');
  });

  it('handles the names CAD systems actually emit', () => {
    // A part called `_1` is a real thing, and `Key` requires an alphanumeric first character.
    expect(slug('_1')).toBe('part-_1');
    expect(slug('---')).toBe('body');
  });

  it('only ever produces something the schema accepts as a key', () => {
    for (const name of ['Cap Body', '_1', '---', 'Ünïcödé Pärt', '4.5mm insert', 'a'.repeat(200)]) {
      expect(slug(name)).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    }
  });
});
