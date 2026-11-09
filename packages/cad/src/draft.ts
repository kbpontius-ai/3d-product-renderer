/**
 * Scaffolding a Product Pack from an import (docs/23-cad-ingestion.md, stage 10).
 *
 * The last stage of ingestion and the first of authoring. It fills in what geometry can answer for
 * itself — the dimensions, one material slot per assembly part, camera presets that frame the thing
 * — and leaves conspicuously empty everything that needs a person: the zones, the real materials,
 * the product's name in a catalog.
 *
 * The empties are the point. A draft that guessed at a decoration zone would be a draft somebody
 * published without reading, and a zone in the wrong place is a logo in the wrong place on a real
 * product. So every gap is a `DraftTodo` with a reason attached, and the manifest that comes out is
 * deliberately one that `checkPackInvariants` warns about until a human has been through it.
 */

import { PP_MATERIALS, type PackManifest, type ProductVariantDef } from '@pr/design-schema';
import type { CadImportResult, CadMeshFile, CadPart, Vec3Mm } from './contract.js';

export interface DraftOptions {
  packKey: string;
  packName: string;
  /** Starts at 0.1.0: a draft is not a first release, and pack versions are immutable once they are. */
  version?: string;
  productKey: string;
  productName: string;
  /** The catalog facet everything is filed under. No default: nothing here can guess it. */
  category: string;
  variantKey: string;
  variantName?: string;
  author?: string;
  license?: string;
}

export type DraftTodoCode =
  | 'zones_missing'
  | 'slots_many'
  | 'axis_not_vertical'
  | 'no_authored_uvs'
  | 'repairs_applied'
  | 'unit_assumed'
  | 'not_watertight'
  | 'no_thumbnail';

export interface DraftTodo {
  code: DraftTodoCode;
  /** What a person has to do, and why it was not done for them. */
  message: string;
}

export interface PackDraft {
  manifest: PackManifest;
  /** Everything a human must decide before this is publishable. Never empty in practice. */
  todos: DraftTodo[];
}

/** More slots than this is a list rather than a set of choices, and worth telling someone about. */
export const MANY_SLOTS = 12;

/**
 * The material slots a set of parts implies — the one function both ends of this must agree on.
 *
 * The render path assigns a pack's slots to the imported object *in declaration order* and lets the
 * mesh's own material indices choose between them. So the manifest's slot list and the GLB's
 * material list are the same list, seen from two sides: if they disagree in order or in length, a
 * render binds the wrong material to a part, or indexes past the end of the slots entirely.
 *
 * Exported so an importer can group its geometry by exactly this, rather than by something that
 * happens to agree today. `validateImportResult` checks that it did.
 */
export function slotKeysFor(parts: readonly CadPart[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();

  for (const part of parts) {
    if (part.triangles === 0) continue;
    // First appearance wins, and two parts with the same name share a slot — which is what a person
    // means by naming them the same thing.
    if (!seen.has(slotKeyFor(part))) seen.set(slotKeyFor(part), part.name?.trim() || 'Body');
  }
  if (seen.size === 0) seen.set('body', 'Body');

  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

/**
 * Which slot one part belongs to.
 *
 * The single-part half of `slotKeysFor`, exported for the same reason: an importer grouping its
 * geometry has to ask this question one part at a time, and a second implementation of it is how
 * the two lists drift apart.
 */
export function slotKeyFor(part: Pick<CadPart, 'name'>): string {
  const label = part.name?.trim();
  return label ? slug(label) : 'body';
}

export function draftPack(result: CadImportResult, options: DraftOptions): PackDraft {
  const todos: DraftTodo[] = [];
  const slots = materialSlots(result.parts, todos);
  const axis = dominantAxis(result.symmetryAxis);

  if (result.repairs.length > 0) {
    const repaired = result.repairs.reduce((sum, repair) => sum + repair.count, 0);
    todos.push({
      code: 'repairs_applied',
      message:
        `The kernel made ${repaired} repair(s) to this shape — ` +
        `${result.repairs.map((repair) => repair.kind).join(', ')}. A healed shape is not the shape ` +
        'the supplier sent; check it against their drawing before publishing.',
    });
  }

  /*
   * Parts that are surfaces rather than solids.
   *
   * A todo and not a refusal, because an open shell is a legitimate thing for a supplier to send —
   * a sleeve, a label, a formed liner. What is not legitimate is publishing one without anybody
   * noticing, because a single-sided material culls whatever faces away and a customer orbiting
   * underneath sees through the product. The fixture closure was exactly this shape for months.
   *
   * The importer already measures it: `watertight` has been on every part since the contract was
   * written, and until now nothing read it.
   */
  // Indexed before filtering: an unnamed part has nothing to call it but its position, and the
  // position that helps is the one in the file the importer read, not the one in this list.
  const open = result.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => !part.watertight);
  if (open.length > 0) {
    const named = open.map(({ part, index }) => part.name ?? `part ${index}`).join(', ');
    todos.push({
      code: 'not_watertight',
      message:
        `${open.length} of ${result.parts.length} part(s) are open shells rather than closed ` +
        `solids: ${named}. That is fine for something genuinely open — a sleeve, a label — and a ` +
        'defect for anything moulded: the preview culls back faces, so a customer who orbits ' +
        'underneath one sees straight through it. Check it against the supplier’s drawing before ' +
        'publishing.',
    });
  }

  if (result.unitAssumed) {
    todos.push({
      code: 'unit_assumed',
      message:
        `The file declared no unit, so millimetres were assumed and it measures ${describe(result.bboxMm)}. ` +
        'Check that against the supplier: a file read in the wrong unit produces a pack that is ' +
        'wrong by a constant factor in every render.',
    });
  }

  if (!result.meshes.some((mesh) => mesh.uvSets.includes('decor'))) {
    todos.push({
      code: 'no_authored_uvs',
      message:
        'No mesh carries an authored "decor" UV set, so a uv_rect zone cannot be drafted from this ' +
        'import. Frame-based zones — planar, cylindrical, conformal, flat_panel — are unaffected: ' +
        'they address the surface in millimetres and do not depend on the unwrap.',
    });
  }

  todos.push({
    code: 'zones_missing',
    message:
      'No decoration zones. Geometry cannot tell you where a customer may put a logo, and a zone ' +
      'in the wrong place is a logo in the wrong place on a real product — so this is left for the ' +
      'zone authoring step rather than guessed at.',
  });

  todos.push({
    code: 'no_thumbnail',
    message:
      'No catalog thumbnail. Open Admin → Packs → Catalog previews, frame the product in the web viewer and capture its preview.',
  });

  if (axis && axis.name !== 'y') {
    todos.push({
      code: 'axis_not_vertical',
      message:
        `This part's axis of revolution runs along ${axis.name.toUpperCase()}, not up. Camera presets ` +
        'need explicit Front and Up confirmation. Continue product setup to orient the presentation; ' +
        'source geometry and physical measurements will stay unchanged.',
    });
  }

  // `dimensionsMm` is a bbox plus a catch-all of numbers, which Zod types as an index signature the
  // bbox itself cannot satisfy. The runtime shape is right and the schema is what proves it.
  const dimensionsMm = {
    bbox: [[...result.bboxMm[0]], [...result.bboxMm[1]]],
    ...derivedDimensions(result, axis),
  } as ProductVariantDef['dimensionsMm'];

  const variant: ProductVariantDef = {
    key: options.variantKey,
    name: options.variantName ?? options.variantKey,
    dimensionsMm,
    assets: assets(result.meshes, options),
    materialSlots: slots,
    // Left empty on purpose. See the todo above.
    zones: [],
    cameraPresets: cameraPresets(axis !== null),
    presentationOrientation: {
      version: 1,
      frontSource: [0, 0, 1],
      upSource: [0, 1, 0],
      confirmed: false,
    },
    capabilities: { transmission: false, video: true, deformable: false },
  };

  const manifest: PackManifest = {
    manifestVersion: 1,
    key: options.packKey,
    version: options.version ?? '0.1.0',
    name: options.packName,
    description: `Drafted from a ${result.format.toUpperCase()} import by ${result.importerId} ${result.importerVersion}.`,
    ...(options.author ? { author: options.author } : {}),
    ...(options.license ? { license: options.license } : {}),
    materials: PP_MATERIALS,
    environments: [],
    products: [
      {
        key: options.productKey,
        name: options.productName,
        category: options.category,
        facets: {},
        variants: [variant],
      },
    ],
  };

  return { manifest, todos };
}

/**
 * One slot per named part.
 *
 * A STEP assembly already names its parts, and that maps onto material slots directly — it is free
 * here and tedious by hand. Unnamed parts are folded into one `body` slot rather than becoming
 * `part-7`, because a name nobody chose is worse than no name.
 */
function materialSlots(
  parts: readonly CadPart[],
  todos: DraftTodo[],
): ProductVariantDef['materialSlots'] {
  const slots = slotKeysFor(parts);

  if (slots.length > MANY_SLOTS) {
    // Deliberately not truncated. A shorter list would be prettier and would also mean the mesh's
    // material indices ran past the end of the slots — a wrong material on a real product, or a
    // render that fails. Ugly beats wrong; the operator folds them together upstream.
    todos.push({
      code: 'slots_many',
      message:
        `This assembly has ${slots.length} distinctly named parts, so the pack has ${slots.length} ` +
        'material slots — a list rather than a set of choices. Give the parts that share a material ' +
        'the same name in CAD, or split the assembly into variants.',
    });
  }

  return slots.map(({ key, label }) => ({
    key,
    label,
    defaultMaterialKey: 'pp-matte',
    // Unrestricted on both axes: geometry cannot tell you what a part is made of or how it should
    // be finished, and a draft that guessed would narrow the author's choices for no reason.
    allowedFamilies: [],
    allowedFinishes: [],
    colorizable: true,
  }));
}

/**
 * Presets that frame the product, seeded by whether it has an axis.
 *
 * A body of revolution wants a three-quarter, a front and a top; a box wants a side as well,
 * because its fourth face is a different face rather than the same one turned. Beyond that these
 * are the fixture packs' angles, which are the only ones in the system anybody has actually looked
 * through.
 */
function cameraPresets(hasAxis: boolean): ProductVariantDef['cameraPresets'] {
  const presets: ProductVariantDef['cameraPresets'] = [
    {
      key: 'three-quarter',
      label: 'Three-quarter',
      azimuthDeg: 35,
      elevationDeg: 25,
      radiusScale: 2.4,
      focalMm: 85,
      targetOffsetMm: [0, 0, 0],
    },
    {
      key: 'front',
      label: 'Front',
      azimuthDeg: 0,
      elevationDeg: 5,
      radiusScale: 2.6,
      focalMm: 100,
      targetOffsetMm: [0, 0, 0],
    },
    {
      key: 'top',
      label: 'Top',
      azimuthDeg: 0,
      elevationDeg: 88,
      radiusScale: 2.2,
      focalMm: 85,
      targetOffsetMm: [0, 0, 0],
    },
  ];

  if (!hasAxis) {
    presets.splice(2, 0, {
      key: 'side',
      label: 'Side',
      azimuthDeg: 90,
      elevationDeg: 5,
      radiusScale: 2.6,
      focalMm: 100,
      targetOffsetMm: [0, 0, 0],
    });
  }

  return presets;
}

/**
 * Where a mesh lives inside the pack.
 *
 * Exported because whoever feeds the pack importer has to map these paths back to wherever the
 * files actually are, and two copies of this template in two packages is a runtime failure waiting
 * for somebody to rename a directory.
 */
export const meshPath = (
  options: Pick<DraftOptions, 'productKey' | 'variantKey'>,
  fileName: string,
): string => `meshes/${options.productKey}/${options.variantKey}/${fileName}`;

/** Which mesh goes in which slot. The digests carry through from the import. */
function assets(
  meshes: readonly CadMeshFile[],
  options: DraftOptions,
): ProductVariantDef['assets'] {
  const at = (lod: string) => meshes.find((mesh) => mesh.lod === lod);
  const ref = (mesh: CadMeshFile) => ({
    path: meshPath(options, mesh.fileName),
    digest: mesh.digest,
    bytes: mesh.bytes,
  });

  const lod0 = at('lod0');
  const render = at('render');
  if (!lod0 || !render) {
    // `validateImportResult` refuses a result without these, so reaching here means the caller
    // skipped it — which is worth saying plainly rather than producing half a manifest.
    throw new Error('cannot draft a pack from an import with no lod0 or render mesh');
  }

  const lod1 = at('lod1');
  return {
    lod0: ref(lod0),
    ...(lod1 ? { lod1: ref(lod1) } : {}),
    renderMesh: ref(render),
  };
}

/**
 * The dimensions a person actually quotes.
 *
 * A bounding box is not how anyone describes a closure. `dimensionsMm` is a catch-all of numbers
 * precisely so a pack can carry the ones its category uses, and the catalog card reads them back.
 */
function derivedDimensions(result: CadImportResult, axis: Axis | null): Record<string, number> {
  const [min, max] = result.bboxMm;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as const;

  if (axis) {
    const across = [0, 1, 2].filter((index) => index !== axis.index).map((index) => size[index]!);
    return {
      diameter: round(Math.max(...across)),
      height: round(size[axis.index]!),
    };
  }

  return { width: round(size[0]!), height: round(size[1]!), depth: round(size[2]!) };
}

interface Axis {
  name: 'x' | 'y' | 'z';
  index: 0 | 1 | 2;
}

/** Which world axis a symmetry direction is closest to, when it is close to one at all. */
function dominantAxis(direction: Vec3Mm | null): Axis | null {
  if (!direction) return null;

  const names = ['x', 'y', 'z'] as const;
  let best: Axis = { name: 'x', index: 0 };
  let bestValue = -1;

  for (const index of [0, 1, 2] as const) {
    const value = Math.abs(direction[index]);
    if (value > bestValue) {
      bestValue = value;
      best = { name: names[index], index };
    }
  }

  const length = Math.hypot(direction[0], direction[1], direction[2]);
  // A direction that is not close to an axis is one nothing here can reason about, and pretending
  // otherwise would put "diameter" on something that does not have one.
  return length > 0 && bestValue / length > 0.98 ? best : null;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

const describe = ([min, max]: readonly [Vec3Mm, Vec3Mm]): string =>
  `${round(max[0] - min[0])} × ${round(max[1] - min[1])} × ${round(max[2] - min[2])} mm`;

/** A CAD part name into a manifest key: lowercase, and only what `Key` allows. */
export function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // `Key` requires an alphanumeric first character, and a part called "_1" is a real thing a CAD
  // system emits. A name with nothing usable left in it becomes `body` rather than a bare prefix.
  if (cleaned === '') return 'body';
  return /^[a-z0-9]/.test(cleaned) ? cleaned : `part-${cleaned}`;
}
