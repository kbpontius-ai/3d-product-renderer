/**
 * The contract a CAD importer has to satisfy, the formats it may be handed, and the checks that
 * judge what it sends back.
 *
 * The conformance suite is deliberately not re-exported here: it imports vitest, and this entry
 * point is loaded by the CAD worker in production, where importing vitest is a crash rather than a
 * nuisance. Test files reach it at `@pr/cad/testing`.
 */
export {
  CAD_STAGES,
  DEFAULT_LIMITS,
  PERMANENT_FAILURES,
  isPermanentFailure,
  type BboxMm,
  type CadFailureCode,
  type CadImportFailure,
  type CadImportOutcome,
  type CadImportRequest,
  type CadImportResult,
  type CadImporter,
  type CadLimits,
  type CadMeshFile,
  type CadPart,
  type CadProbe,
  type CadRepair,
  type CadStage,
  type LodRequest,
  type Mm,
  type Vec3Mm,
} from './contract.js';
export {
  FORMAT_SIGNATURES,
  KNOWN_EXTENSIONS,
  SNIFF_BYTES,
  sniffFormat,
  type CadFormat,
  type FormatSignature,
  type SniffResult,
} from './formats.js';
export {
  SUPPORTED_SCHEMAS,
  parseStepHeader,
  schemaSupported,
  type StepHeader,
} from './step-header.js';
export {
  DEFAULT_BUDGETS,
  MESH_LABELS,
  budgetsForSize,
  checkBudgets,
  formatBytes,
  type BudgetBreach,
  type MeshBudget,
} from './budgets.js';
export {
  AUDIENCE_SUMMARY,
  failureAudience,
  hasOpaqueMessage,
  issueAudience,
  operatorMessage,
  type FailureAudience,
} from './reporting.js';
export {
  ALLOWED_MESHES,
  PLAUSIBLE_SIZE_MM,
  REQUIRED_MESHES,
  validateImportResult,
  type CadIssue,
  type CadIssueCode,
  type ValidateOptions,
} from './validate.js';
export { referenceImporter, segmentsFor, type ReferenceImporterOptions } from './reference.js';
export {
  MANY_SLOTS,
  draftPack,
  meshPath,
  slotKeyFor,
  slotKeysFor,
  slug,
  type DraftOptions,
  type DraftTodo,
  type DraftTodoCode,
  type PackDraft,
} from './draft.js';
