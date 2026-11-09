import type { Transform, Vec2 } from '@pr/design-schema';
import {
  applySnap,
  clampToZone,
  isCornerHandle,
  quantize,
  rotateTo,
  scaleFromHandle,
  type ActiveSnap,
  type ActiveSnapState,
  type Guide,
  type HandleId,
  type ZoneExtent,
} from '@pr/placement';
import type { HitTarget } from './hit.js';
import { pxPerMm, screenToZone, type Viewport } from './viewport.js';

/**
 * Pointer gestures for the 2D face view: one command per gesture, snapping applied live, and the
 * user always able to override (Alt suspends snapping, Shift frees aspect/rotation).
 *
 * Framework-agnostic on purpose — React just forwards pointer events and draws the result.
 */

export interface GestureContext {
  zone: ZoneExtent;
  snapEnabled: boolean;
  guides?: Guide[];
  neighbours?: Transform[];
}

export interface Modifiers {
  alt?: boolean;
  shift?: boolean;
}

export type Gesture =
  | { mode: 'move'; start: Transform; grabMm: Vec2; active: ActiveSnapState }
  | { mode: 'scale'; start: Transform; handle: HandleId; active: ActiveSnapState }
  | { mode: 'rotate'; start: Transform; active: ActiveSnapState };

export interface GestureUpdate {
  transform: Transform;
  guides: ActiveSnap[];
  gesture: Gesture;
  /** True when the placement was held back by the zone boundary — the UI flashes the edge. */
  hitBoundary: boolean;
}

export function beginGesture(
  vp: Viewport,
  transform: Transform,
  screenPoint: Vec2,
  target: HitTarget,
): Gesture | null {
  const p = screenToZone(vp, screenPoint);
  switch (target.kind) {
    case 'move':
      return {
        mode: 'move',
        start: transform,
        grabMm: { x: p.x - transform.offsetMm.x, y: p.y - transform.offsetMm.y },
        active: {},
      };
    case 'scale':
      return { mode: 'scale', start: transform, handle: target.handle, active: {} };
    case 'rotate':
      return { mode: 'rotate', start: transform, active: {} };
    default:
      return null;
  }
}

export function updateGesture(
  gesture: Gesture,
  vp: Viewport,
  screenPoint: Vec2,
  ctx: GestureContext,
  mods: Modifiers = {},
): GestureUpdate {
  const pointer = screenToZone(vp, screenPoint);

  if (gesture.mode === 'rotate') {
    const rotated = rotateTo(gesture.start, pointer, mods.shift === true);
    const clamped = clampToZone(rotated, ctx.zone);
    return { transform: clamped.transform, guides: [], gesture, hitBoundary: clamped.hitBoundary };
  }

  if (gesture.mode === 'scale') {
    const proportional = isCornerHandle(gesture.handle) ? !mods.shift : mods.shift === true;
    const scaled = scaleFromHandle(gesture.start, gesture.handle, pointer, { proportional });
    const clamped = clampToZone(scaled, ctx.zone);
    return { transform: clamped.transform, guides: [], gesture, hitBoundary: clamped.hitBoundary };
  }

  const proposed: Transform = {
    ...gesture.start,
    offsetMm: { x: pointer.x - gesture.grabMm.x, y: pointer.y - gesture.grabMm.y },
  };

  const snapped = applySnap(
    proposed,
    {
      zone: ctx.zone,
      pxPerMm: pxPerMm(vp),
      enabled: ctx.snapEnabled,
      ...(ctx.guides ? { guides: ctx.guides } : {}),
      ...(ctx.neighbours ? { neighbours: ctx.neighbours } : {}),
      active: gesture.active,
    },
    { suspend: mods.alt === true },
  );

  const clamped = clampToZone(snapped.transform, ctx.zone);
  return {
    transform: clamped.transform,
    guides: snapped.guides,
    gesture: { ...gesture, active: snapped.active },
    hitBoundary: clamped.hitBoundary,
  };
}

/** Quantises on release: the document only ever stores committed, tidy numbers. */
export const commitGesture = (update: GestureUpdate): Transform => quantize(update.transform);

export const NUDGE_MM = 0.5;
export const NUDGE_FINE_MM = 0.1;

/** Keyboard nudging, so placement never requires a mouse (F-PLACE-09). */
export function nudge(
  transform: Transform,
  direction: 'up' | 'down' | 'left' | 'right',
  zone: ZoneExtent,
  fine = false,
): Transform {
  const step = fine ? NUDGE_FINE_MM : NUDGE_MM;
  const delta: Vec2 = {
    x: direction === 'left' ? -step : direction === 'right' ? step : 0,
    y: direction === 'down' ? -step : direction === 'up' ? step : 0,
  };
  const moved: Transform = {
    ...transform,
    offsetMm: { x: transform.offsetMm.x + delta.x, y: transform.offsetMm.y + delta.y },
  };
  return quantize(clampToZone(moved, zone).transform);
}
