import type {
  ArtworkStats,
  DecorationZoneDef,
  DesignDocument,
  Placement,
} from '@pr/design-schema';
import { zoneExtentMm } from '@pr/design-schema';
import { wrapAngleDeg } from './mappers.js';
import { aabb, isInsideSafeArea, isInsideZone } from './transform.js';

/**
 * Validation runs identically in the editor (on every change) and on the server
 * (PATCH /api/designs/:id). Blocking issues can never be persisted, so a design in the database is
 * always renderable. Warnings are surfaced but never block.
 */

export type IssueSeverity = 'error' | 'warning';

export type IssueCode =
  | 'zone_unknown'
  | 'placement_outside_zone'
  | 'finish_not_allowed'
  | 'depth_exceeds_max'
  | 'artwork_unknown'
  | 'material_slot_unknown'
  | 'material_family_not_allowed'
  | 'material_not_colorizable'
  | 'outside_safe_margin'
  | 'thin_strokes'
  | 'coverage_high'
  | 'wrap_angle_high';

export interface Issue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  placementId?: string;
  slotKey?: string;
  detail?: Record<string, number | string>;
}

export interface DesignValidationContext {
  zones: Record<string, DecorationZoneDef>;
  materialSlots: Record<string, { allowedFamilies: string[]; colorizable: boolean }>;
  materials: Record<string, { family: string; colorizable: boolean }>;
  /** Artwork statistics keyed by artwork version id. */
  artwork: Record<string, ArtworkStats>;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
}

const error = (code: IssueCode, message: string, extra: Partial<Issue> = {}): Issue => ({
  severity: 'error',
  code,
  message,
  ...extra,
});

const warn = (code: IssueCode, message: string, extra: Partial<Issue> = {}): Issue => ({
  severity: 'warning',
  code,
  message,
  ...extra,
});

export function validatePlacement(
  placement: Placement,
  zone: DecorationZoneDef,
  stats: ArtworkStats | undefined,
): Issue[] {
  const issues: Issue[] = [];
  const extent = zoneExtentMm(zone);
  const c = zone.constraints;
  const id = placement.id;

  if (!isInsideZone(placement.transform, extent)) {
    issues.push(
      error('placement_outside_zone', 'Artwork extends past the decoration area.', {
        placementId: id,
      }),
    );
  } else if (!isInsideSafeArea(placement.transform, extent)) {
    issues.push(
      warn('outside_safe_margin', 'Artwork sits inside the safe margin.', { placementId: id }),
    );
  }

  if (!c.finishes.includes(placement.finish.kind)) {
    issues.push(
      error('finish_not_allowed', `This area does not support a ${placement.finish.kind} finish.`, {
        placementId: id,
      }),
    );
  }

  if (placement.finish.kind !== 'print' && placement.finish.depthMm > c.maxDepthMm) {
    issues.push(
      error('depth_exceeds_max', `Maximum depth for this area is ${c.maxDepthMm} mm.`, {
        placementId: id,
        detail: { requested: placement.finish.depthMm, max: c.maxDepthMm },
      }),
    );
  }

  if (!stats) {
    issues.push(error('artwork_unknown', 'Artwork is still processing or unavailable.', { placementId: id }));
    return issues;
  }

  const scaleK = placement.transform.sizeMm.w / stats.naturalSizeMm.w;
  if (stats.minStrokeMm !== null) {
    const strokeMm = stats.minStrokeMm * scaleK;
    if (strokeMm < c.minStrokeMm) {
      issues.push(
        warn('thin_strokes', `Thinnest line is ${strokeMm.toFixed(2)} mm; ${c.minStrokeMm} mm reproduces reliably.`, {
          placementId: id,
          detail: { actual: Number(strokeMm.toFixed(3)), min: c.minStrokeMm },
        }),
      );
    }
  }

  const box = aabb(placement.transform);
  const artworkArea = (box.max.x - box.min.x) * (box.max.y - box.min.y) * stats.coverage;
  const zoneArea = extent.w * extent.h;
  if (artworkArea > c.maxCoverage * zoneArea) {
    issues.push(
      warn('coverage_high', 'Artwork covers most of the decoration area.', {
        placementId: id,
        detail: { coverage: Number((artworkArea / zoneArea).toFixed(3)), max: c.maxCoverage },
      }),
    );
  }

  const wrapDeg = wrapAngleDeg(zone, placement.transform.sizeMm.w);
  if (wrapDeg !== null && wrapDeg > c.wrapWarnDeg) {
    issues.push(
      warn('wrap_angle_high', `Artwork wraps ${wrapDeg.toFixed(0)}° around the product and will not be readable in one view.`, {
        placementId: id,
        detail: { wrapDeg: Number(wrapDeg.toFixed(1)), warnAt: c.wrapWarnDeg },
      }),
    );
  }

  return issues;
}

export function validateDesign(
  doc: DesignDocument,
  ctx: DesignValidationContext,
): ValidationResult {
  const issues: Issue[] = [];

  for (const [slotKey, assignment] of Object.entries(doc.materials)) {
    const slot = ctx.materialSlots[slotKey];
    if (!slot) {
      issues.push(error('material_slot_unknown', `Unknown material slot "${slotKey}".`, { slotKey }));
      continue;
    }
    const material = ctx.materials[assignment.materialKey];
    if (!material) {
      issues.push(
        error('material_family_not_allowed', `Unknown material "${assignment.materialKey}".`, { slotKey }),
      );
      continue;
    }
    if (slot.allowedFamilies.length > 0 && !slot.allowedFamilies.includes(material.family)) {
      issues.push(
        error('material_family_not_allowed', `${material.family} materials are not available for this part.`, {
          slotKey,
        }),
      );
    }
    if (assignment.colorHex && !(material.colorizable && slot.colorizable)) {
      issues.push(
        warn('material_not_colorizable', 'This material ignores custom colour.', { slotKey }),
      );
    }
  }

  for (const placement of doc.placements) {
    const zone = ctx.zones[placement.zoneKey];
    if (!zone) {
      issues.push(
        error('zone_unknown', `Unknown decoration area "${placement.zoneKey}".`, {
          placementId: placement.id,
        }),
      );
      continue;
    }
    issues.push(...validatePlacement(placement, zone, ctx.artwork[placement.artwork.versionId]));
  }

  return {
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

export const isRenderable = (result: ValidationResult): boolean => result.errors.length === 0;
