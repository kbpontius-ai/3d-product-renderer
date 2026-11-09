/**
 * The CAD importer contract (docs/23-cad-ingestion.md, "Formats").
 *
 * The same seam `@pr/render-backend` draws around Cycles, drawn around OCCT: a kernel is the
 * implementation ingestion ships with, not the definition of what importing is. Adding Parasolid
 * means registering an importer; nothing upstream of this file learns a new format name.
 *
 * Everything crossing this boundary is JSON or a path on disk, so an importer may run in this
 * process, in a subprocess, or in a container on another machine — which matters more here than it
 * does for rendering, because the real implementation is a large native C++ parser being fed a
 * stranger's file and belongs behind as many walls as can be arranged.
 */

import type { CadFormat } from './formats.js';

/** Millimetres, always. Units are normalised at the boundary so nothing downstream converts. */
export type Mm = number;
export type Vec3Mm = readonly [Mm, Mm, Mm];
export type BboxMm = readonly [Vec3Mm, Vec3Mm];

/**
 * A level of detail the importer was asked to produce.
 *
 * Deflection is in millimetres rather than a ratio of the bounding box: an operator can reason
 * about "chords within 0.05 mm of the surface", and the same number means the same thing on a
 * 20 mm closure and a 400 mm carton.
 */
export interface LodRequest {
  name: string;
  /** Maximum chord deviation from the true surface, in mm. Smaller is denser. */
  deflectionMm: Mm;
  /** Maximum angular deviation between adjacent facet normals, in degrees. */
  angularDeg: number;
  /** Refuse the result above this many triangles rather than emitting a mesh nothing can stream. */
  maxTriangles: number;
}

export interface CadImportRequest {
  /** Local path to the source file, already sniffed and size-capped by the supervisor. */
  sourcePath: string;
  /** What the sniffer decided it is. An importer may verify, but must not re-decide. */
  format: CadFormat;
  /**
   * Unit to assume when the file does not declare one.
   *
   * STEP always declares; STL never does. Guessing silently is how a pack ends up wrong by 25.4×
   * in every render, so the caller states the assumption and the result says whether it was used.
   */
  assumeUnit?: 'mm' | 'cm' | 'm' | 'in';
  lods: readonly LodRequest[];
  /** Where meshes must be written. One file per LOD plus the render mesh, and nothing else. */
  outputDir: string;
  /** Scratch space the importer may use and the supervisor will delete. */
  scratchDir: string;
  /** Wall-clock cap. A malformed shape can spin in tessellation with no exploit involved. */
  timeoutSec: number;
  /** Cores the importer may use. Absent means all of them. */
  threads?: number;
  /** Refuse files whose shape count, entity count or nesting depth exceed these. */
  limits?: CadLimits;
  onProgress?: (stage: CadStage, fraction: number) => void;
  /** Polled while working; returning true means stop, because the job is no longer ours. */
  shouldCancel?: () => Promise<boolean> | boolean;
}

/**
 * Caps applied while parsing, not after.
 *
 * "Refuse rather than attempt" — a 4 GB assembly is not a thing to be brave about, and the point of
 * a limit is that it is hit before the memory is allocated.
 */
export interface CadLimits {
  maxShapes: number;
  maxAssemblyDepth: number;
  maxTrianglesTotal: number;
}

export const DEFAULT_LIMITS: CadLimits = {
  maxShapes: 2_000,
  maxAssemblyDepth: 16,
  maxTrianglesTotal: 8_000_000,
};

/** The stages a caller may be told about. Ordered, and progress only moves forward within one. */
export const CAD_STAGES = [
  'parse',
  'heal',
  'analyse',
  'tessellate',
  'uv',
  'decimate',
  'write',
] as const;
export type CadStage = (typeof CAD_STAGES)[number];

/**
 * A repair the kernel made to the supplier's shape.
 *
 * Recorded rather than hidden: a healed shape is not the shape the supplier sent, and somebody will
 * eventually need to know that — usually the person holding a tool trial that does not match.
 */
export interface CadRepair {
  kind: 'sewed_shell' | 'fixed_orientation' | 'dropped_free_edge' | 'removed_degenerate' | 'other';
  count: number;
  detail?: string;
}

/** One part of the assembly, flattened. The tree is carried by `parentIndex`. */
export interface CadPart {
  /** The name the CAD system gave it, when it gave one. Becomes a material slot's default label. */
  name: string | null;
  /** Index into the same array, or null at the root. */
  parentIndex: number | null;
  bboxMm: BboxMm;
  triangles: number;
  /** Cubic millimetres, when the shape is a closed solid. Null for open shells and surfaces. */
  volumeMm3: number | null;
  /** A closed, orientable solid — the precondition for volume, thickness and boolean work. */
  watertight: boolean;
}

/** One written mesh file. Named, not pathed: the supervisor decides where the directory lives. */
export interface CadMeshFile {
  bboxMm?: BboxMm;
  /** Which LOD this satisfies, or 'render' for the dense displacement mesh. */
  lod: string;
  fileName: string;
  triangles: number;
  bytes: number;
  /** sha256 of the file, hex. Determinism is checked by comparing these across two runs. */
  digest: string;
  /**
   * Where the supervisor put it, once it has.
   *
   * Absent from what an importer returns, and filled in afterwards: an importer writes files into a
   * directory it was handed and has no business knowing about storage keys, let alone credentials.
   */
  storageKey?: string;
  /**
   * Which UV sets the mesh carries.
   *
   * `decor` is the authored set a `uv_rect` zone needs; `auto` is xatlas output, usable for base
   * material texturing and never for a decoration zone (docs/23, decision 1).
   */
  uvSets: readonly ('decor' | 'auto')[];
  /**
   * The mesh's materials, in the order its primitives index them.
   *
   * The pack's material slots are assigned to the object in declaration order and the mesh's own
   * indices choose between them, so this list and the manifest's slot list are the same list seen
   * from two sides. An importer produces it with `slotKeysFor`, and the validator checks it did.
   */
  materialKeys: readonly string[];
}

export interface CadImportResult {
  status: 'ok';
  /** Which importer produced this, recorded in the pack's ingestion provenance. */
  importerId: string;
  /** The kernel's version string. Pinned, and recorded, because determinism depends on it. */
  importerVersion: string;
  format: CadFormat;
  /** The unit the file declared, or null when it declared none and `assumeUnit` was used. */
  declaredUnit: string | null;
  unitAssumed: boolean;
  /** Overall dimensions, in mm, after normalisation. Shown to the operator before anything else. */
  bboxMm: BboxMm;
  parts: readonly CadPart[];
  repairs: readonly CadRepair[];
  meshes: readonly CadMeshFile[];
  /** The dominant rotational symmetry axis, when there is one. Seeds the pack's camera presets. */
  symmetryAxis: Vec3Mm | null;
  seconds: number;
  /** Last lines of whatever the importer said, kept for the job's record. */
  tail?: readonly string[];
}

/**
 * Why an import produced nothing.
 *
 * The queue's failure vocabulary, so the supervisor records what it is told without translating and
 * losing the distinction between "this file is bad" and "this worker is bad" — only the second is
 * worth retrying.
 */
export type CadFailureCode =
  | 'unsupported_format'
  | 'unsupported_schema'
  | 'corrupt_file'
  | 'no_solids'
  | 'too_complex'
  | 'too_large'
  | 'source_missing'
  | 'invalid_result'
  | 'timeout'
  | 'canceled'
  | 'oom'
  | 'importer_crash'
  | 'importer_unavailable'
  | 'internal';

/**
 * Failures that describe the file rather than the worker. Retrying one of these wastes a lease.
 *
 * `invalid_result` belongs here even though it is the *importer's* misbehaviour: the same importer
 * reading the same file produces the same rejected result, and a retry only spends another hour of
 * a container finding that out.
 */
export const PERMANENT_FAILURES: readonly CadFailureCode[] = [
  'unsupported_format',
  'unsupported_schema',
  'corrupt_file',
  'no_solids',
  'too_complex',
  'too_large',
  'source_missing',
  'invalid_result',
];

export const isPermanentFailure = (code: CadFailureCode): boolean =>
  PERMANENT_FAILURES.includes(code);

export interface CadImportFailure {
  status: 'failed';
  importerId: string;
  failure: CadFailureCode;
  /** Safe to show an operator: says what is wrong with the file, never where it sat on disk. */
  message: string;
  seconds: number;
  tail?: readonly string[];
}

export type CadImportOutcome = CadImportResult | CadImportFailure;

export interface CadProbe {
  available: boolean;
  version?: string;
  /**
   * What this build can do, by name.
   *
   * Asked rather than assumed, exactly as with render backends: an OCCT build without the mesh
   * simplification module should degrade to "no decimation" rather than fail a job.
   */
  features: Record<string, boolean>;
  /** Why it is unavailable, when it is. */
  reason?: string;
}

export interface CadImporter {
  /** Recorded in every pack's provenance, so a mesh can be attributed to what produced it. */
  readonly id: string;
  readonly formats: readonly CadFormat[];
  probe(): Promise<CadProbe>;
  import(request: CadImportRequest): Promise<CadImportOutcome>;
}
