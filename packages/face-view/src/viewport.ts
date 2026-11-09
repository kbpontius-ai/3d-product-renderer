import type { Vec2 } from '@pr/design-schema';
import type { ZoneExtent } from '@pr/placement';

/**
 * The 2D face view's coordinate plumbing (F-PLACE-01).
 *
 * One scalar — `pxPerMm` — ties screen pixels to millimetres, and everything else (rulers, snap
 * thresholds, handle sizes, readouts) is derived from it. Zone space has +y up; screen space has
 * +y down, and this module is the only place that flip happens.
 */

export interface Viewport {
  canvasPx: { w: number; h: number };
  zone: ZoneExtent;
  /** 1 = the zone fits the canvas with `marginFactor` breathing room. */
  zoom: number;
  /** Pan expressed in zone millimetres: the zone point at the centre of the canvas. */
  panMm: Vec2;
  marginFactor: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 40;
export const DEFAULT_MARGIN_FACTOR = 1.15;

export function fitViewport(
  canvasPx: { w: number; h: number },
  zone: ZoneExtent,
  marginFactor = DEFAULT_MARGIN_FACTOR,
): Viewport {
  return { canvasPx, zone, zoom: 1, panMm: { x: 0, y: 0 }, marginFactor };
}

export function pxPerMm(vp: Viewport): number {
  const base = Math.min(
    vp.canvasPx.w / (vp.zone.w * vp.marginFactor),
    vp.canvasPx.h / (vp.zone.h * vp.marginFactor),
  );
  return base * vp.zoom;
}

export function zoneToScreen(vp: Viewport, p: Vec2): Vec2 {
  const k = pxPerMm(vp);
  return {
    x: vp.canvasPx.w / 2 + (p.x - vp.panMm.x) * k,
    y: vp.canvasPx.h / 2 - (p.y - vp.panMm.y) * k, // y flips here and nowhere else
  };
}

export function screenToZone(vp: Viewport, p: Vec2): Vec2 {
  const k = pxPerMm(vp);
  return {
    x: vp.panMm.x + (p.x - vp.canvasPx.w / 2) / k,
    y: vp.panMm.y - (p.y - vp.canvasPx.h / 2) / k,
  };
}

export const clampZoom = (zoom: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

/** Zooms about a screen point, keeping whatever is under the cursor exactly where it is. */
export function zoomAt(vp: Viewport, screenPoint: Vec2, factor: number): Viewport {
  const anchor = screenToZone(vp, screenPoint);
  const zoom = clampZoom(vp.zoom * factor);
  const next: Viewport = { ...vp, zoom };
  const k = pxPerMm(next);
  return {
    ...next,
    panMm: {
      x: anchor.x - (screenPoint.x - vp.canvasPx.w / 2) / k,
      y: anchor.y + (screenPoint.y - vp.canvasPx.h / 2) / k,
    },
  };
}

export function panByPx(vp: Viewport, deltaPx: Vec2): Viewport {
  const k = pxPerMm(vp);
  return { ...vp, panMm: { x: vp.panMm.x - deltaPx.x / k, y: vp.panMm.y + deltaPx.y / k } };
}

export function resize(vp: Viewport, canvasPx: { w: number; h: number }): Viewport {
  return { ...vp, canvasPx };
}

/** Millimetre step between ruler ticks that stays readable at the current zoom. */
export function rulerStepMm(vp: Viewport, minSpacingPx = 48): number {
  const k = pxPerMm(vp);
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  return candidates.find((step) => step * k >= minSpacingPx) ?? candidates[candidates.length - 1]!;
}
