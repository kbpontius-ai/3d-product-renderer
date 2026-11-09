import type { ArtworkReport, ArtworkStats } from '@pr/design-schema';
import { isClosed } from './path.js';
import type { NormalizedArtwork } from './normalize.js';
import { totalNodeCount } from './normalize.js';
import type { SanitizeRemoval } from './sanitize.js';

/**
 * Stage 4: decide whether the artwork can be used, and say why in terms a designer can act on.
 *
 * Zone-dependent limits (minimum stroke in millimetres on a given product, coverage, depth) are NOT
 * checked here — the same artwork can be legal on one product and not another, so those live in
 * `packages/placement` and run at placement time.
 */

export interface ArtworkLimits {
  maxPaths: number;
  maxNodes: number;
  /** Aspect ratios beyond this (or its inverse) are flagged as probably wrong. */
  maxAspect: number;
}

export const DEFAULT_ARTWORK_LIMITS: ArtworkLimits = {
  maxPaths: 5_000,
  maxNodes: 200_000,
  maxAspect: 20,
};

const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textPath', 'textpath', 'altGlyph']);
const RASTER_ELEMENTS = new Set(['image']);

export interface ValidateInput {
  artwork: NormalizedArtwork;
  removals: SanitizeRemoval[];
  pipelineVersion: string;
  limits?: ArtworkLimits;
}

export function validateArtwork({
  artwork,
  removals,
  pipelineVersion,
  limits = DEFAULT_ARTWORK_LIMITS,
}: ValidateInput): ArtworkReport {
  const errors: ArtworkReport['errors'] = [];
  const warnings: ArtworkReport['warnings'] = [];

  const removedNames = removals.filter((r) => r.kind === 'element').map((r) => r.name);
  const hasText = removedNames.some((name) => TEXT_ELEMENTS.has(name));
  const hadRaster = removedNames.some((name) => RASTER_ELEMENTS.has(name));
  const externalReferences = removals.filter((r) => r.reason === 'external_reference').length;
  const scriptUrls = removals.filter(
    (r) => r.reason === 'script_url' || r.reason === 'event_handler',
  ).length;

  const nodeCount = totalNodeCount(artwork);
  const bbox = artwork.contentBBox;

  if (hasText) {
    errors.push({
      code: 'text_not_outlined',
      message: 'The artwork contains live text.',
      hint: 'Convert text to outlines in your design tool and upload again — that way the logo renders with your exact typeface.',
    });
  }

  if (artwork.paths.length === 0 || !bbox || bbox.w <= 0 || bbox.h <= 0) {
    errors.push({
      code: 'empty_after_normalize',
      message: 'No drawable shapes were found in this file.',
      ...(hadRaster
        ? { hint: 'This looks like an embedded image rather than vector artwork. Upload the vector original.' }
        : {}),
    });
  }

  if (artwork.paths.length > limits.maxPaths || nodeCount > limits.maxNodes) {
    errors.push({
      code: 'complexity_exceeded',
      message: `Artwork is too complex (${artwork.paths.length} shapes, ${nodeCount} points).`,
      hint: 'Simplify or flatten the artwork before uploading.',
    });
  }

  if (!Number.isFinite(artwork.naturalSizeMm.w) || artwork.naturalSizeMm.w <= 0) {
    errors.push({
      code: 'unsupported_units',
      message: 'The file does not declare a usable size.',
      hint: 'Add a width, height and viewBox to the SVG.',
    });
  }

  // Warnings: things we handled, but the designer should know about.
  const openPaths = artwork.paths.filter((p) => p.fill && !isClosed(p.segments)).length;
  if (openPaths > 0) {
    warnings.push({
      code: 'open_paths',
      message: `${openPaths} filled shape${openPaths === 1 ? '' : 's'} are not closed; they will be closed automatically.`,
      detail: { count: openPaths },
    });
  }

  if (artwork.usedGradient) {
    warnings.push({
      code: 'gradients_flattened',
      message: 'Gradients are flattened for relief finishes — the shape is used, the shading is not.',
    });
  }

  if (externalReferences > 0 || scriptUrls > 0) {
    warnings.push({
      code: 'filters_dropped',
      message: 'Some effects or external references were removed while cleaning the file.',
      detail: { externalReferences, scriptUrls },
    });
  }

  if (bbox && bbox.h > 0) {
    const aspect = bbox.w / bbox.h;
    if (aspect > limits.maxAspect || aspect < 1 / limits.maxAspect) {
      warnings.push({
        code: 'aspect_extreme',
        message: `The artwork is unusually ${aspect > 1 ? 'wide' : 'tall'} (${aspect.toFixed(1)}:1).`,
        detail: { aspect: Number(aspect.toFixed(2)) },
      });
    }
  }

  return {
    pipelineVersion,
    status: errors.length > 0 ? 'rejected' : 'ready',
    errors,
    warnings,
    stats: buildStats(artwork, nodeCount, hasText),
  };
}

function buildStats(artwork: NormalizedArtwork, nodeCount: number, hasText: boolean): ArtworkStats {
  const bbox = artwork.contentBBox ?? { x: 0, y: 0, w: 0, h: 0 };
  const perMm = artwork.unitsPerMm || 1;

  const strokes = artwork.paths.filter((p) => p.stroke && p.strokeWidth > 0).map((p) => p.strokeWidth);
  const minStrokeMm = strokes.length > 0 ? Math.min(...strokes) / perMm : null;

  return {
    pathCount: artwork.paths.length,
    nodeCount,
    naturalSizeMm: {
      w: Math.max(artwork.naturalSizeMm.w, 1e-6),
      h: Math.max(artwork.naturalSizeMm.h, 1e-6),
    },
    contentBbox: {
      x: bbox.x / perMm,
      y: bbox.y / perMm,
      w: bbox.w / perMm,
      h: bbox.h / perMm,
    },
    minStrokeMm,
    // Coverage is measured properly during rasterisation; the bounding-box ratio is a placeholder
    // the pipeline overwrites once the mask exists.
    coverage: Math.min(1, (bbox.w * bbox.h) / Math.max(1e-9, artwork.viewBox.w * artwork.viewBox.h)),
    hasText,
    hasGradients: artwork.usedGradient,
    hasClipPaths: false,
  };
}
