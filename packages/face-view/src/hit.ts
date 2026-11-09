import type { Transform, Vec2 } from '@pr/design-schema';
import { corners, type HandleId } from '@pr/placement';
import { pxPerMm, screenToZone, zoneToScreen, type Viewport } from './viewport.js';

/** Hit targets on the transform box, in the order the pointer should prefer them. */
export type HitTarget =
  | { kind: 'scale'; handle: HandleId }
  | { kind: 'rotate' }
  | { kind: 'move' }
  | { kind: 'none' };

export const HANDLE_RADIUS_PX = 8;
export const ROTATE_HANDLE_OFFSET_PX = 26;

const HANDLE_ORDER: HandleId[] = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'];

/** Screen positions of the eight scale handles, keyed by handle id. */
export function handlePositions(vp: Viewport, t: Transform): Record<HandleId, Vec2> {
  const [tl, tr, br, bl] = corners(t).map((c) => zoneToScreen(vp, c)) as [Vec2, Vec2, Vec2, Vec2];
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return {
    nw: tl,
    ne: tr,
    se: br,
    sw: bl,
    n: mid(tl, tr),
    e: mid(tr, br),
    s: mid(br, bl),
    w: mid(bl, tl),
  };
}

/** Screen position of the rotation handle, offset outward from the top edge. */
export function rotateHandlePosition(vp: Viewport, t: Transform): Vec2 {
  const h = handlePositions(vp, t);
  const dx = h.n.x - h.s.x;
  const dy = h.n.y - h.s.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: h.n.x + (dx / len) * ROTATE_HANDLE_OFFSET_PX, y: h.n.y + (dy / len) * ROTATE_HANDLE_OFFSET_PX };
}

const near = (a: Vec2, b: Vec2, radius: number) => Math.hypot(a.x - b.x, a.y - b.y) <= radius;

/** Is a screen point inside the placement, accounting for rotation and flips? */
export function isInsidePlacement(vp: Viewport, t: Transform, screenPoint: Vec2): boolean {
  const p = screenToZone(vp, screenPoint);
  const rad = (t.rotationDeg * Math.PI) / 180;
  const dx = p.x - t.offsetMm.x;
  const dy = p.y - t.offsetMm.y;
  const localX = dx * Math.cos(rad) + dy * Math.sin(rad);
  const localY = -dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(localX) <= t.sizeMm.w / 2 && Math.abs(localY) <= t.sizeMm.h / 2;
}

export function hitTest(
  vp: Viewport,
  t: Transform,
  screenPoint: Vec2,
  handleRadiusPx = HANDLE_RADIUS_PX,
): HitTarget {
  const handles = handlePositions(vp, t);
  for (const handle of HANDLE_ORDER) {
    if (near(screenPoint, handles[handle], handleRadiusPx)) return { kind: 'scale', handle };
  }
  if (near(screenPoint, rotateHandlePosition(vp, t), handleRadiusPx)) return { kind: 'rotate' };
  if (isInsidePlacement(vp, t, screenPoint)) return { kind: 'move' };
  return { kind: 'none' };
}

/** Cursor hint for a hit target; rotated boxes need rotated resize cursors. */
export function cursorFor(target: HitTarget, t: Transform): string {
  if (target.kind === 'move') return 'move';
  if (target.kind === 'rotate') return 'grab';
  if (target.kind === 'none') return 'default';

  const base: Record<HandleId, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
  const angle = (base[target.handle] + t.rotationDeg + 360) % 360;
  const octant = Math.round(angle / 45) % 8;
  return ['ns', 'nesw', 'ew', 'nwse', 'ns', 'nesw', 'ew', 'nwse'][octant] + '-resize';
}

/** Snap threshold expressed in millimetres at the current zoom — the UI's one true feel constant. */
export const snapThresholdMm = (vp: Viewport, thresholdPx: number): number =>
  thresholdPx / pxPerMm(vp);
