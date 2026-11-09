import 'server-only';

/**
 * Which version of the ingestion pipeline is running (docs/23-cad-ingestion.md, "Determinism").
 *
 * Ingestion dedupes on the source file's digest *together with this*, because the same file is only
 * the same work while the pipeline reading it has not changed. Bump it whenever the kernel, its
 * options, or the tessellation parameters change — every mesh digest downstream depends on them,
 * and render dedupe and the parity baselines are keyed on those.
 */
export const PIPELINE_VERSION = process.env['CAD_PIPELINE_VERSION'] ?? '2026.08.1';
