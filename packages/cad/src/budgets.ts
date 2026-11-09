/**
 * How dense each mesh is allowed to be (docs/23-cad-ingestion.md, stages 5 and 7).
 *
 * Three meshes come out of an import and they answer three different questions:
 *
 * - `lod0` is what the editor shows first. Its budget is a time budget in disguise — docs/19 gives
 *   first pixels 1.5 s, and a mesh is one of two things on that path.
 * - `lod1` swaps in silently once it arrives, and is what the user actually looks at.
 * - `render` is never streamed to a browser. It is fed to adaptive displacement, so it wants to be
 *   dense enough that a 0.2 mm emboss has geometry to push around.
 *
 * Deflection, not triangle count, is the control. Triangles are the *ceiling* — a shape that blows
 * through it at its target deflection is refused rather than silently coarsened, because coarsening
 * a mesh a zone was authored against is how a logo ends up 0.3 mm off the surface it is meant to
 * lie on.
 */

import type { LodRequest } from './contract.js';

export interface MeshBudget extends LodRequest {
  /**
   * Ceiling on the written GLB as `@pr/gltf` writes it: indexed float32 positions, normals and UVs,
   * uncompressed. This comment used to say "Draco-compressed", which the encoder has never done —
   * so the number was written as a compressed size and has always been enforced against a raw one.
   *
   * Streaming budget, not a storage one.
   */
  maxBytes: number;
}

/**
 * The default ladder, for a part measured in tens of millimetres — a closure, a carton, a jar.
 *
 * The byte ceilings were originally set about 4× above the fixture packs, because those were the
 * only meshes anyone had measured. The fixtures are parametric solids of revolution, and a real
 * supplier part turns out to be roughly a hundred times heavier at the same deflection — the ribs,
 * the knurling and the relief on a moulded closure are all hard edges, and a hard edge splits a
 * vertex. Measured, in kB, as this encoder writes them:
 *
 *     closure-38.step   (fixture, smooth)          10      15      25
 *     58-400 Ribbed     (Shapr3D, ribs + logo)    743   1,594   4,115
 *     89-400 - NF-0001  (supplier)                946   2,247   8,079
 *     89-400 - PNP-0001 (supplier)                971   2,286   8,189
 *     89-400 Ribbed     (supplier, full ribs)   ~3,360 ~20,500 ~45,300
 *
 * The ceilings sit just above the heaviest of these, the 89-400 Ribbed, at 100 k / 707 k / 1.58 M
 * triangles. That part was refused on every rung, triangles and bytes both, and the ladder was
 * raised to admit it: a deliberate choice to let a real part in today over holding the editor's
 * loading targets. The cost is real — `lod1` for that part is about 20 MB, which the editor
 * downloads before the part looks right. The fix that keeps both is simplifying a mesh that
 * overruns its rung rather than refusing it (`F-CADX-08`); until then these numbers are a stopgap,
 * not a calibration.
 *
 * `lod0` at 4 MB is still inside what docs/03-gui asks of it ("LOD0 model visible < 3 s on cable
 * broadband"): about 1.3 s of transfer at 25 Mbit/s. At 10 Mbit/s it is not.
 */
export const DEFAULT_BUDGETS: readonly MeshBudget[] = [
  { name: 'lod0', deflectionMm: 0.08, angularDeg: 25, maxTriangles: 120_000, maxBytes: 4 * 1024 * 1024 },
  { name: 'lod1', deflectionMm: 0.03, angularDeg: 12, maxTriangles: 800_000, maxBytes: 24 * 1024 * 1024 },
  { name: 'render', deflectionMm: 0.01, angularDeg: 6, maxTriangles: 2_000_000, maxBytes: 56 * 1024 * 1024 },
] as const;

/**
 * The same ladder, loosened for something large.
 *
 * Deflection is absolute, so a 400 mm display carton tessellated at 0.01 mm produces a mesh nobody
 * asked for. Scaling the target with the part's size keeps the *visible* error constant, which is
 * what the number is a proxy for: a chord error is only ever seen relative to how big the thing is
 * on screen.
 */
export function budgetsForSize(longestEdgeMm: number): readonly MeshBudget[] {
  // Reference size is the fixture cap's skirt diameter. Below it, nothing is gained by going finer
  // than the defaults — the triangles land inside a pixel.
  const scale = Math.max(1, longestEdgeMm / 38);
  return DEFAULT_BUDGETS.map((budget) => ({
    ...budget,
    deflectionMm: round(budget.deflectionMm * scale, 4),
  }));
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * What each mesh is *for*, in the words an operator would use.
 *
 * `lod0` says nothing to somebody who did not write the pipeline, and the person reading a refused
 * ingestion is an operator rather than its author. The internal name is kept alongside rather than
 * replaced, because it is what they will find if they search the docs for it.
 */
export const MESH_LABELS: Readonly<Record<string, string>> = {
  lod0: 'the mesh the editor loads first',
  lod1: 'the mesh the editor swaps in once it arrives',
  render: 'the mesh renders are displaced from',
};

/** A size somebody can compare against a file on their desk. Bytes are not that. */
export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} kB`;
}

export interface BudgetBreach {
  lod: string;
  measure: 'triangles' | 'bytes';
  actual: number;
  limit: number;
}

/** What, if anything, came back too heavy. Empty means the meshes may become a pack. */
export function checkBudgets(
  meshes: readonly { lod: string; triangles: number; bytes: number }[],
  budgets: readonly MeshBudget[] = DEFAULT_BUDGETS,
): BudgetBreach[] {
  const breaches: BudgetBreach[] = [];

  for (const mesh of meshes) {
    const budget = budgets.find((candidate) => candidate.name === mesh.lod);
    // An unbudgeted LOD is not a breach here; `validate.ts` is where an unexpected mesh is caught,
    // and reporting it twice in two vocabularies helps nobody.
    if (!budget) continue;

    if (mesh.triangles > budget.maxTriangles) {
      breaches.push({ lod: mesh.lod, measure: 'triangles', actual: mesh.triangles, limit: budget.maxTriangles });
    }
    if (mesh.bytes > budget.maxBytes) {
      breaches.push({ lod: mesh.lod, measure: 'bytes', actual: mesh.bytes, limit: budget.maxBytes });
    }
  }

  return breaches;
}
