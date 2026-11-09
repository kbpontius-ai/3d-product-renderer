import type { Transform, Vec2 } from '@pr/design-schema';
import type { ZoneExtent } from './mappers.js';
import { DEG2RAD } from './vec.js';

/** Millimetres are committed at 0.01 mm and degrees at 0.1 deg — fine enough to be invisible,
 *  coarse enough that documents diff cleanly and undo steps are meaningful. */
export const MM_QUANTUM = 0.01;
export const DEG_QUANTUM = 0.1;

export const quantizeMm = (v: number): number => Math.round(v / MM_QUANTUM) * MM_QUANTUM;
export const quantizeDeg = (v: number): number => Math.round(v / DEG_QUANTUM) * DEG_QUANTUM;

export interface Box {
  min: Vec2;
  max: Vec2;
}

/** The four corners of a placement in zone space, in order TL, TR, BR, BL before rotation. */
export function corners(t: Transform): [Vec2, Vec2, Vec2, Vec2] {
  const hw = (t.sizeMm.w / 2) * (t.flipX ? -1 : 1);
  const hh = (t.sizeMm.h / 2) * (t.flipY ? -1 : 1);
  const rad = t.rotationDeg * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const local: Vec2[] = [
    { x: -hw, y: hh },
    { x: hw, y: hh },
    { x: hw, y: -hh },
    { x: -hw, y: -hh },
  ];

  return local.map((p) => ({
    x: t.offsetMm.x + p.x * cos - p.y * sin,
    y: t.offsetMm.y + p.x * sin + p.y * cos,
  })) as [Vec2, Vec2, Vec2, Vec2];
}

/** Rotation-aware axis-aligned bounding box in zone space. */
export function aabb(t: Transform): Box {
  const pts = corners(t);
  return {
    min: { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) },
    max: { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) },
  };
}

export const boxWidth = (b: Box): number => b.max.x - b.min.x;
export const boxHeight = (b: Box): number => b.max.y - b.min.y;
export const boxCentre = (b: Box): Vec2 => ({
  x: (b.min.x + b.max.x) / 2,
  y: (b.min.y + b.max.y) / 2,
});

export function translate(t: Transform, delta: Vec2): Transform {
  return { ...t, offsetMm: { x: t.offsetMm.x + delta.x, y: t.offsetMm.y + delta.y } };
}

export function quantize(t: Transform): Transform {
  return {
    ...t,
    offsetMm: { x: quantizeMm(t.offsetMm.x), y: quantizeMm(t.offsetMm.y) },
    sizeMm: { w: quantizeMm(t.sizeMm.w), h: quantizeMm(t.sizeMm.h) },
    rotationDeg: quantizeDeg(t.rotationDeg),
  };
}

export type FitMode = 'contain' | 'cover' | 'natural';

/** Default drop size: big enough to look deliberate, small enough that nobody's first move is to shrink it. */
export const DEFAULT_FILL = 0.8;

export function fitSize(
  naturalMm: { w: number; h: number },
  zone: ZoneExtent,
  mode: FitMode,
  fill = 1,
): { w: number; h: number } {
  if (mode === 'natural') return { ...naturalMm };
  const availW = zone.w - 2 * zone.safeMarginMm;
  const availH = zone.h - 2 * zone.safeMarginMm;
  const k =
    mode === 'contain'
      ? Math.min(availW / naturalMm.w, availH / naturalMm.h)
      : Math.max(availW / naturalMm.w, availH / naturalMm.h);
  return { w: naturalMm.w * k * fill, h: naturalMm.h * k * fill };
}

/** Transform for freshly dropped artwork: centred, contained in the safe area. */
/**
 * Where dropped artwork lands (F-PLACE-03): centred on the zone, contained inside its safe area,
 * at a size that fills a sensible share of it rather than whatever the file happened to be.
 */
export function initialTransform(
  naturalMm: { w: number; h: number },
  zone: ZoneExtent,
): Transform {
  return quantize({
    offsetMm: { x: 0, y: 0 },
    sizeMm: fitSize(naturalMm, zone, 'contain', DEFAULT_FILL),
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    lockAspect: true,
  });
}

export interface ClampResult {
  transform: Transform;
  hitBoundary: boolean;
}

/** Keeps a placement inside the zone. The UI flashes the edge rather than snapping back silently. */
/** Artwork stops at the zone boundary (F-PLACE-14); the safe margin is a warning, not a wall. */
export function clampToZone(t: Transform, zone: ZoneExtent): ClampResult {
  const box = aabb(t);
  const halfW = zone.w / 2;
  const halfH = zone.h / 2;

  let dx = 0;
  let dy = 0;
  if (boxWidth(box) <= zone.w) {
    if (box.min.x < -halfW) dx = -halfW - box.min.x;
    else if (box.max.x > halfW) dx = halfW - box.max.x;
  } else {
    dx = -boxCentre(box).x; // too wide to fit: centre it rather than pinning an edge
  }
  if (boxHeight(box) <= zone.h) {
    if (box.min.y < -halfH) dy = -halfH - box.min.y;
    else if (box.max.y > halfH) dy = halfH - box.max.y;
  } else {
    dy = -boxCentre(box).y;
  }

  return { transform: dx || dy ? translate(t, { x: dx, y: dy }) : t, hitBoundary: dx !== 0 || dy !== 0 };
}

export const isInsideZone = (t: Transform, zone: ZoneExtent): boolean => {
  const b = aabb(t);
  return (
    b.min.x >= -zone.w / 2 - 1e-9 &&
    b.max.x <= zone.w / 2 + 1e-9 &&
    b.min.y >= -zone.h / 2 - 1e-9 &&
    b.max.y <= zone.h / 2 + 1e-9
  );
};

export const isInsideSafeArea = (t: Transform, zone: ZoneExtent): boolean => {
  const m = zone.safeMarginMm;
  return isInsideZone(t, { w: zone.w - 2 * m, h: zone.h - 2 * m, safeMarginMm: 0 });
};

/** Scales around the anchor opposite the dragged handle, in the placement's own rotated basis. */
export function scaleFromHandle(
  start: Transform,
  handle: HandleId,
  pointerZone: Vec2,
  opts: { proportional: boolean; minSizeMm?: number },
): Transform {
  const minSize = opts.minSizeMm ?? 0.5;
  const rad = start.rotationDeg * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toLocal = (p: Vec2): Vec2 => {
    const dx = p.x - start.offsetMm.x;
    const dy = p.y - start.offsetMm.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  };

  const local = toLocal(pointerZone);
  const anchor = anchorForHandle(handle, start); // in local coordinates
  const rawW = Math.abs(local.x - anchor.x);
  const rawH = Math.abs(local.y - anchor.y);

  let w = handleScalesX(handle) ? rawW : start.sizeMm.w;
  let h = handleScalesY(handle) ? rawH : start.sizeMm.h;

  if (opts.proportional) {
    const k = Math.max(w / start.sizeMm.w, h / start.sizeMm.h);
    w = start.sizeMm.w * k;
    h = start.sizeMm.h * k;
  }

  w = Math.max(minSize, w);
  h = Math.max(minSize, h);

  // Keep the anchor corner/edge fixed: shift the centre by the size change, in world orientation.
  const shiftLocal: Vec2 = {
    x: (Math.sign(-anchor.x) * (w - start.sizeMm.w)) / 2,
    y: (Math.sign(-anchor.y) * (h - start.sizeMm.h)) / 2,
  };
  const offsetMm: Vec2 = {
    x: start.offsetMm.x + shiftLocal.x * cos - shiftLocal.y * sin,
    y: start.offsetMm.y + shiftLocal.x * sin + shiftLocal.y * cos,
  };

  return { ...start, sizeMm: { w, h }, offsetMm };
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const isCornerHandle = (h: HandleId): boolean => h.length === 2;
const handleScalesX = (h: HandleId): boolean => h.includes('e') || h.includes('w');
const handleScalesY = (h: HandleId): boolean => h.includes('n') || h.includes('s');

/** Anchor point (local, unrotated) that stays fixed while `handle` is dragged. */
export function anchorForHandle(handle: HandleId, t: Transform): Vec2 {
  const hw = t.sizeMm.w / 2;
  const hh = t.sizeMm.h / 2;
  const x = handle.includes('w') ? hw : handle.includes('e') ? -hw : 0;
  const y = handle.includes('n') ? -hh : handle.includes('s') ? hh : 0;
  return { x, y };
}

export const ROTATION_SNAP_DEG = 15;

export function rotateTo(start: Transform, pointerZone: Vec2, freeform: boolean): Transform {
  const deg =
    Math.atan2(pointerZone.y - start.offsetMm.y, pointerZone.x - start.offsetMm.x) * (180 / Math.PI);
  const snapped = freeform ? deg : Math.round(deg / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
  return { ...start, rotationDeg: normalizeDeg(snapped) };
}

export const NUDGE_MM = 0.5;
export const NUDGE_FINE_MM = 0.1;

export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d > 180 ? d - 360 : d <= -180 ? d + 360 : d;
}
