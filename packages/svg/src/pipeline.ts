import type { ArtworkReport } from '@pr/design-schema';
import { sanitizeSvg, SanitizeError, type SanitizeRemoval } from './sanitize.js';
import { normalizeSvg, serializeNormalized, type NormalizedArtwork } from './normalize.js';
import { validateArtwork, type ArtworkLimits } from './validate.js';

/**
 * Stages 2-4 of docs/14-artwork-pipeline.md as one call: sanitise (F-ART-02), normalise
 * (F-ART-03), validate (F-ART-04).
 *
 * Rasterisation and distance fields come after this, in the worker, and are deliberately not part
 * of this package — this half is pure and runs anywhere.
 */

export const PIPELINE_VERSION = '0.1.0';

export interface PrepareResult {
  status: 'ready' | 'rejected';
  report: ArtworkReport;
  /** Present only when the artwork survived: clean geometry, one coordinate system. */
  artwork?: NormalizedArtwork;
  /** A minimal SVG containing only that geometry, ready for the rasteriser. */
  svg?: string;
  removals: SanitizeRemoval[];
}

export interface PrepareOptions {
  limits?: ArtworkLimits;
  maxBytes?: number;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function prepareArtwork(source: string, options: PrepareOptions = {}): PrepareResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    return rejection('too_large', `File is larger than ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }

  if (!/<svg[\s>]/i.test(source)) {
    return rejection('not_svg', 'This file does not look like an SVG.');
  }

  let sanitized;
  try {
    sanitized = sanitizeSvg(source);
  } catch (error) {
    if (error instanceof SanitizeError) {
      return rejection(error.code, userMessageFor(error.code), error.message);
    }
    throw error;
  }

  const artwork = normalizeSvg(sanitized.root);
  const report = validateArtwork({
    artwork,
    removals: sanitized.removals,
    pipelineVersion: PIPELINE_VERSION,
    ...(options.limits ? { limits: options.limits } : {}),
  });

  if (report.status === 'rejected') {
    return { status: 'rejected', report, removals: sanitized.removals };
  }

  return {
    status: 'ready',
    report,
    artwork,
    svg: serializeNormalized(artwork),
    removals: sanitized.removals,
  };
}

function userMessageFor(code: ArtworkReport['errors'][number]['code']): string {
  switch (code) {
    case 'not_svg':
      return 'This file does not look like an SVG.';
    case 'parse_failed':
      return 'The file could not be read as valid SVG.';
    case 'empty_after_normalize':
      return 'No drawable shapes were found in this file.';
    case 'too_large':
      return 'The file is too large.';
    default:
      return 'The file could not be processed.';
  }
}

function rejection(
  code: ArtworkReport['errors'][number]['code'],
  message: string,
  hint?: string,
): PrepareResult {
  return {
    status: 'rejected',
    removals: [],
    report: {
      pipelineVersion: PIPELINE_VERSION,
      status: 'rejected',
      errors: [{ code, message, ...(hint ? { hint } : {}) }],
      warnings: [],
      stats: {
        pathCount: 0,
        nodeCount: 0,
        naturalSizeMm: { w: 1e-6, h: 1e-6 },
        contentBbox: { x: 0, y: 0, w: 0, h: 0 },
        minStrokeMm: null,
        coverage: 0,
        hasText: false,
        hasGradients: false,
        hasClipPaths: false,
      },
    },
  };
}
