/**
 * Judging what the importer sent back (docs/23-cad-ingestion.md, "Trust nothing that comes back").
 *
 * The importer is a large native parser that has just finished reading a stranger's file. It is
 * inside the blast radius; this file is not. So its output is treated the way the SVG sanitiser
 * treats an upload — as a claim to be checked, not a result to be used.
 *
 * Everything here is structural and cheap: magic bytes, digests, finite numbers, counts that agree
 * with each other. It cannot tell a beautiful mesh from an ugly one, and does not try. What it can
 * do is refuse a result that would put a NaN into a bounding box, a `../` into a storage key, or a
 * 90 MB GLB in front of a browser.
 */

import { createHash } from 'node:crypto';
import type { BboxMm, CadImportResult, CadMeshFile, CadPart, Vec3Mm } from './contract.js';
import { checkBudgets, DEFAULT_BUDGETS, formatBytes, MESH_LABELS, type MeshBudget } from './budgets.js';
import { slotKeysFor } from './draft.js';

export type CadIssueCode =
  | 'mesh_missing'
  | 'mesh_unexpected'
  | 'mesh_not_gltf'
  | 'mesh_digest_mismatch'
  | 'mesh_size_mismatch'
  | 'unsafe_file_name'
  | 'budget_exceeded'
  | 'bbox_not_finite'
  | 'bbox_inverted'
  | 'bbox_implausible'
  | 'part_empty'
  | 'part_tree_broken'
  | 'part_count_mismatch'
  | 'no_parts'
  | 'uv_missing_for_decor'
  | 'material_keys_mismatch'
  | 'unit_unresolved';

export interface CadIssue {
  code: CadIssueCode;
  message: string;
  /** Which mesh or part this is about, when it is about one. */
  subject?: string;
}

/** LODs a result must contain to become a pack. `lod1` is optional — `pack.ts` says so too. */
export const REQUIRED_MESHES = ['lod0', 'render'] as const;
/** Nothing else may be written into the output directory. An unexpected file is a finding. */
export const ALLOWED_MESHES = ['lod0', 'lod1', 'render'] as const;

/**
 * The largest and smallest a real packaging part is.
 *
 * Not a taste judgement — a unit mistake detector. A 38 mm closure read as metres is 38 000 mm and
 * a 400 mm carton read as inches is 15.7 mm, and both land outside this range while every genuine
 * part lands inside it. This catches the failure docs/23 stage 3 exists to prevent, after the fact,
 * for the case where nobody looked at the dimensions.
 */
export const PLAUSIBLE_SIZE_MM = { min: 1, max: 3_000 } as const;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const vecFinite = (v: Vec3Mm): boolean => v.length === 3 && v.every(isFiniteNumber);

/** A name that is only ever a name. No separators, no traversal, no leading dot. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ValidateOptions {
  budgets?: readonly MeshBudget[];
  /** Reads a written mesh back, so its magic, length and digest can be checked against the claim. */
  readMesh?: (fileName: string) => Promise<Uint8Array>;
  /** True when a `uv_rect` zone is intended, which requires an authored `decor` UV set. */
  requiresDecorUv?: boolean;
}

/**
 * Everything wrong with this result, or an empty array.
 *
 * Returns all findings rather than the first: an operator looking at a failed ingestion wants the
 * list, and the cost of a second pass over a dozen structs is nothing next to a second import.
 */
export async function validateImportResult(
  result: CadImportResult,
  options: ValidateOptions = {},
): Promise<CadIssue[]> {
  const issues: CadIssue[] = [];

  issues.push(...checkBbox(result.bboxMm, 'result'));
  issues.push(...checkParts(result.parts));
  issues.push(...(await checkMeshes(result.meshes, options)));
  issues.push(...checkMaterialKeys(result));

  if (result.declaredUnit === null && !result.unitAssumed) {
    issues.push({
      code: 'unit_unresolved',
      message:
        'The file declared no unit and none was assumed. A mesh whose scale nobody established is ' +
        'wrong by some factor nobody knows.',
    });
  }

  if (options.requiresDecorUv) {
    for (const mesh of result.meshes) {
      if (!mesh.uvSets.includes('decor')) {
        issues.push({
          code: 'uv_missing_for_decor',
          subject: mesh.lod,
          message:
            `"${mesh.lod}" carries no authored "decor" UV set. A uv_rect zone cannot be drafted ` +
            'from an auto-unwrapped mesh (docs/23, decision 1).',
        });
      }
    }
  }

  return issues;
}

/**
 * That every mesh names the same materials the pack's slots will, in the same order.
 *
 * This is the one invariant nothing else would catch until a render came back with the skirt in the
 * liner's colour — or with a material index past the end of the slot list. The check is a string
 * comparison; the bug it prevents is a product photograph that is quietly wrong.
 */
function checkMaterialKeys(result: CadImportResult): CadIssue[] {
  const expected = slotKeysFor(result.parts).map((slot) => slot.key);
  const issues: CadIssue[] = [];

  for (const mesh of result.meshes) {
    const actual = [...mesh.materialKeys];
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      issues.push({
        code: 'material_keys_mismatch',
        subject: mesh.lod,
        message:
          `"${mesh.lod}" names materials [${actual.join(', ')}], but this import's parts imply slots ` +
          `[${expected.join(', ')}]. The renderer matches them by position, so a disagreement here ` +
          'puts the wrong material on a part.',
      });
    }
  }

  return issues;
}

function checkBbox(bbox: BboxMm, subject: string): CadIssue[] {
  const [min, max] = bbox;

  if (!vecFinite(min) || !vecFinite(max)) {
    return [{ code: 'bbox_not_finite', subject, message: `Bounding box of "${subject}" contains a non-finite number.` }];
  }

  const issues: CadIssue[] = [];
  const size: number[] = [];

  for (let axis = 0; axis < 3; axis++) {
    const extent = max[axis]! - min[axis]!;
    if (extent < 0) {
      issues.push({
        code: 'bbox_inverted',
        subject,
        message: `Bounding box of "${subject}" has max below min on axis ${axis}.`,
      });
    }
    size.push(extent);
  }

  if (issues.length > 0) return issues;

  const longest = Math.max(...size);

  // Nothing at all, which is a different thing from the wrong size and has a different cause and a
  // different fix. Told apart here because one rule reporting both taught an operator that their
  // empty sketch was a unit conversion problem, and they went looking in the wrong place.
  if (longest === 0) {
    issues.push({
      code: 'part_empty',
      subject,
      message:
        `"${subject}" contains no geometry at all. That is usually a sketch, a construction curve ` +
        'or a hidden body that came along with the export; re-exporting with only the solid bodies ' +
        'selected normally removes it.',
    });
    return issues;
  }

  if (longest < PLAUSIBLE_SIZE_MM.min || longest > PLAUSIBLE_SIZE_MM.max) {
    // The two classic unit mistakes, and what the part would measure under each. A ratio is what
    // somebody recognises their own part in — "38.00 mm" lands where "off by 1000" does not.
    const reading =
      longest > PLAUSIBLE_SIZE_MM.max
        ? `Read as metres rather than millimetres the same numbers give ${(longest / 1000).toFixed(2)} mm.`
        : `Read as inches rather than millimetres the same numbers give ${(longest * 25.4).toFixed(2)} mm.`;
    issues.push({
      code: 'bbox_implausible',
      subject,
      message:
        `"${subject}" measures ${longest.toFixed(2)} mm across, outside the ${PLAUSIBLE_SIZE_MM.min}–` +
        `${PLAUSIBLE_SIZE_MM.max} mm a packaging part occupies. ${reading}`,
    });
  }

  return issues;
}

function checkParts(parts: readonly CadPart[]): CadIssue[] {
  if (parts.length === 0) {
    return [{ code: 'no_parts', message: 'The import produced no parts. There is nothing to make a pack from.' }];
  }

  const issues: CadIssue[] = [];

  for (const [index, part] of parts.entries()) {
    const subject = part.name ?? `part ${index}`;
    issues.push(...checkBbox(part.bboxMm, subject));

    if (!Number.isInteger(part.triangles) || part.triangles < 0) {
      issues.push({ code: 'part_count_mismatch', subject, message: `"${subject}" reports ${part.triangles} triangles.` });
    }
    if (part.volumeMm3 !== null && !isFiniteNumber(part.volumeMm3)) {
      issues.push({ code: 'part_count_mismatch', subject, message: `"${subject}" reports a non-finite volume.` });
    }

    const parent = part.parentIndex;
    if (parent !== null && (!Number.isInteger(parent) || parent < 0 || parent >= parts.length || parent === index)) {
      issues.push({
        code: 'part_tree_broken',
        subject,
        message: `"${subject}" names parent index ${parent}, which is not another part in this result.`,
      });
    }
  }

  if (!issues.some((issue) => issue.code === 'part_tree_broken') && hasCycle(parts)) {
    issues.push({ code: 'part_tree_broken', message: 'The assembly tree contains a cycle.' });
  }

  return issues;
}

/** Walks each part to a root. A tree with N nodes cannot need more than N steps to get there. */
function hasCycle(parts: readonly CadPart[]): boolean {
  for (let index = 0; index < parts.length; index++) {
    let cursor: number | null = index;
    for (let steps = 0; cursor !== null; steps++) {
      if (steps > parts.length) return true;
      cursor = parts[cursor]?.parentIndex ?? null;
    }
  }
  return false;
}

async function checkMeshes(meshes: readonly CadMeshFile[], options: ValidateOptions): Promise<CadIssue[]> {
  const issues: CadIssue[] = [];
  const present = new Set(meshes.map((mesh) => mesh.lod));

  for (const required of REQUIRED_MESHES) {
    if (!present.has(required)) {
      issues.push({ code: 'mesh_missing', subject: required, message: `No "${required}" mesh was written.` });
    }
  }

  for (const mesh of meshes) {
    if (!(ALLOWED_MESHES as readonly string[]).includes(mesh.lod)) {
      issues.push({
        code: 'mesh_unexpected',
        subject: mesh.lod,
        message: `"${mesh.lod}" is not a mesh this pipeline asked for.`,
      });
    }
    if (!SAFE_FILE_NAME.test(mesh.fileName)) {
      issues.push({
        code: 'unsafe_file_name',
        subject: mesh.lod,
        message: `"${mesh.fileName}" is not a plain file name and will not be used as a storage key.`,
      });
      // Reading it back is exactly what must not happen with a name like that.
      continue;
    }

    if (!options.readMesh) continue;

    const bytes = await options.readMesh(mesh.fileName);

    // 'glTF' — a GLB and nothing else. `pack-validate.ts` already refuses to serve anything but
    // glTF by extension; this is the same rule enforced on content, one layer earlier.
    if (bytes.byteLength < 12 || Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'glTF') {
      issues.push({ code: 'mesh_not_gltf', subject: mesh.lod, message: `"${mesh.fileName}" is not a GLB.` });
      continue;
    }
    if (bytes.byteLength !== mesh.bytes) {
      issues.push({
        code: 'mesh_size_mismatch',
        subject: mesh.lod,
        message: `"${mesh.fileName}" is ${bytes.byteLength} bytes; the result claims ${mesh.bytes}.`,
      });
    }

    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== mesh.digest) {
      issues.push({
        code: 'mesh_digest_mismatch',
        subject: mesh.lod,
        message:
          `"${mesh.fileName}" hashes to ${digest.slice(0, 12)}…, not the ${mesh.digest.slice(0, 12)}… claimed. ` +
          'Render dedupe is keyed on this digest, so a wrong one is not a cosmetic problem.',
      });
    }
  }

  for (const breach of checkBudgets(meshes, options.budgets ?? DEFAULT_BUDGETS)) {
    // Sizes, and nothing else. What makes a particular part heavy is a question about the model
    // that this code cannot see the answer to, and a plausible guess printed as a diagnosis sends
    // somebody to change the wrong thing.
    const label = MESH_LABELS[breach.lod];
    const named = label ? `"${breach.lod}" — ${label} — ` : `"${breach.lod}" `;
    const [actual, limit] =
      breach.measure === 'bytes'
        ? [formatBytes(breach.actual), formatBytes(breach.limit)]
        : [`${breach.actual.toLocaleString()} triangles`, `${breach.limit.toLocaleString()} triangles`];
    issues.push({
      code: 'budget_exceeded',
      subject: breach.lod,
      message: `${named}is ${actual}, over the ${limit} this pipeline allows.`,
    });
  }

  return issues;
}
