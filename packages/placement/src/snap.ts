import type { Transform, Vec2 } from '@pr/design-schema';
import type { ZoneExtent } from './mappers.js';
import { aabb, boxCentre, translate, type Box } from './transform.js';

/**
 * Snapping assists; it never decides. Every snap can be suspended (Alt), broken by pulling away,
 * or switched off entirely — see F-PLACE-05/06 and docs/15-placement-math.md.
 */

export type Axis = 'x' | 'y';
export type AnchorRole = 'min' | 'center' | 'max';

export type SnapKind =
  | 'zoneCenter'
  | 'guide'
  | 'safeEdge'
  | 'zoneEdge'
  | 'neighborCenter'
  | 'neighborEdge';

/**
 * Snap target priority (F-PLACE-05).
 *
 * Lower wins ties: the zone's centre and middle lines beat everything else.
 */
export const SNAP_PRIORITY: Record<SnapKind, number> = {
  zoneCenter: 0,
  guide: 1,
  safeEdge: 2,
  zoneEdge: 3,
  neighborCenter: 4,
  neighborEdge: 5,
};

/** Threshold is in SCREEN pixels, so snapping feels identical at any zoom level. */
export const SNAP_THRESHOLD_PX = 6;
/** How far past the threshold you must pull to break an established snap. */
export const SNAP_BREAK_FACTOR = 1.5;

export interface Guide {
  axis: Axis;
  valueMm: number;
}

export interface SnapTarget {
  axis: Axis;
  valueMm: number;
  kind: SnapKind;
}

export interface ActiveSnap extends SnapTarget {
  anchor: AnchorRole;
}

export type ActiveSnapState = Partial<Record<Axis, ActiveSnap>>;

export interface SnapContext {
  zone: ZoneExtent;
  pxPerMm: number;
  enabled: boolean;
  guides?: Guide[];
  /** Other placements in the same zone; their edges and centres are snap targets too. */
  neighbours?: Transform[];
  /** Snap held from the previous pointer event, for sticky release. */
  active?: ActiveSnapState;
}

export interface SnapInput {
  /** Alt held: suspend snapping for this gesture without changing the user's preference. */
  suspend?: boolean;
}

export interface SnapResult {
  transform: Transform;
  /** Guides to draw right now — only the ones that actually fired. */
  guides: ActiveSnap[];
  active: ActiveSnapState;
}

export function snapTargets(ctx: SnapContext): SnapTarget[] {
  const halfW = ctx.zone.w / 2;
  const halfH = ctx.zone.h / 2;
  const m = ctx.zone.safeMarginMm;

  const targets: SnapTarget[] = [
    { axis: 'x', valueMm: 0, kind: 'zoneCenter' },
    { axis: 'y', valueMm: 0, kind: 'zoneCenter' },
    { axis: 'x', valueMm: -(halfW - m), kind: 'safeEdge' },
    { axis: 'x', valueMm: halfW - m, kind: 'safeEdge' },
    { axis: 'y', valueMm: -(halfH - m), kind: 'safeEdge' },
    { axis: 'y', valueMm: halfH - m, kind: 'safeEdge' },
    { axis: 'x', valueMm: -halfW, kind: 'zoneEdge' },
    { axis: 'x', valueMm: halfW, kind: 'zoneEdge' },
    { axis: 'y', valueMm: -halfH, kind: 'zoneEdge' },
    { axis: 'y', valueMm: halfH, kind: 'zoneEdge' },
  ];

  for (const g of ctx.guides ?? []) targets.push({ axis: g.axis, valueMm: g.valueMm, kind: 'guide' });

  for (const other of ctx.neighbours ?? []) {
    const b = aabb(other);
    const c = boxCentre(b);
    targets.push(
      { axis: 'x', valueMm: c.x, kind: 'neighborCenter' },
      { axis: 'y', valueMm: c.y, kind: 'neighborCenter' },
      { axis: 'x', valueMm: b.min.x, kind: 'neighborEdge' },
      { axis: 'x', valueMm: b.max.x, kind: 'neighborEdge' },
      { axis: 'y', valueMm: b.min.y, kind: 'neighborEdge' },
      { axis: 'y', valueMm: b.max.y, kind: 'neighborEdge' },
    );
  }

  return targets;
}

function anchorValue(box: Box, axis: Axis, role: AnchorRole): number {
  const min = axis === 'x' ? box.min.x : box.min.y;
  const max = axis === 'x' ? box.max.x : box.max.y;
  if (role === 'min') return min;
  if (role === 'max') return max;
  return (min + max) / 2;
}

const ANCHOR_ROLES: AnchorRole[] = ['center', 'min', 'max'];
const EPS = 1e-9;

/**
 * Applies snapping to a proposed transform. Pure: the caller owns the sticky state and passes it
 * back in on the next pointer event.
 */
export function applySnap(
  proposed: Transform,
  ctx: SnapContext,
  input: SnapInput = {},
): SnapResult {
  if (!ctx.enabled || input.suspend) {
    return { transform: proposed, guides: [], active: {} };
  }

  const thresholdMm = SNAP_THRESHOLD_PX / ctx.pxPerMm;
  const box = aabb(proposed);
  const targets = snapTargets(ctx);

  const delta: Vec2 = { x: 0, y: 0 };
  const guides: ActiveSnap[] = [];
  const active: ActiveSnapState = {};

  for (const axis of ['x', 'y'] as const) {
    let best: { delta: number; target: SnapTarget; anchor: AnchorRole } | null = null;

    for (const target of targets) {
      if (target.axis !== axis) continue;
      for (const role of ANCHOR_ROLES) {
        const d = target.valueMm - anchorValue(box, axis, role);
        if (Math.abs(d) > thresholdMm) continue;
        if (
          !best ||
          Math.abs(d) < Math.abs(best.delta) - EPS ||
          (Math.abs(Math.abs(d) - Math.abs(best.delta)) <= EPS &&
            SNAP_PRIORITY[target.kind] < SNAP_PRIORITY[best.target.kind])
        ) {
          best = { delta: d, target, anchor: role };
        }
      }
    }

    // Sticky release: an established snap survives until pulled clearly away from it.
    const held = ctx.active?.[axis];
    if (!best && held) {
      const d = held.valueMm - anchorValue(box, axis, held.anchor);
      if (Math.abs(d) <= thresholdMm * SNAP_BREAK_FACTOR) {
        best = { delta: d, target: held, anchor: held.anchor };
      }
    }

    if (best) {
      delta[axis] = best.delta;
      const fired: ActiveSnap = { ...best.target, anchor: best.anchor };
      guides.push(fired);
      active[axis] = fired;
    }
  }

  const transform = delta.x !== 0 || delta.y !== 0 ? translate(proposed, delta) : proposed;
  return { transform, guides, active };
}
