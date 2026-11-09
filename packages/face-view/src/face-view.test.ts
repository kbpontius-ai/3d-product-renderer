import { describe, expect, it } from 'vitest';
import type { Transform } from '@pr/design-schema';
import { aabb, initialTransform } from '@pr/placement';
import {
  fitViewport,
  panByPx,
  pxPerMm,
  resize,
  rulerStepMm,
  screenToZone,
  zoneToScreen,
  zoomAt,
  MAX_ZOOM,
  MIN_ZOOM,
} from './viewport.js';
import { cursorFor, handlePositions, hitTest, isInsidePlacement, rotateHandlePosition } from './hit.js';
import { beginGesture, commitGesture, nudge, updateGesture } from './gesture.js';

const zone = { w: 30, h: 30, safeMarginMm: 1.5 };
const canvas = { w: 800, h: 600 };
const vp = fitViewport(canvas, zone);

const tf = (over: Partial<Transform> = {}): Transform => ({
  offsetMm: { x: 0, y: 0 },
  sizeMm: { w: 10, h: 10 },
  rotationDeg: 0,
  flipX: false,
  flipY: false,
  lockAspect: true,
  ...over,
});

describe('viewport', () => {
  it('fits the zone inside the canvas with margin', () => {
    // 600 px over 30 mm x 1.15 margin => 17.39 px/mm, limited by the shorter axis.
    expect(pxPerMm(vp)).toBeCloseTo(600 / (30 * 1.15), 6);
  });

  it('puts the zone centre at the canvas centre with +y up', () => {
    expect(zoneToScreen(vp, { x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
    expect(zoneToScreen(vp, { x: 0, y: 5 }).y).toBeLessThan(300);
    expect(zoneToScreen(vp, { x: 5, y: 0 }).x).toBeGreaterThan(400);
  });

  it('round-trips screen and zone coordinates', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 7.5, y: -3.25 },
      { x: -14, y: 12 },
    ]) {
      const back = screenToZone(vp, zoneToScreen(vp, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const cursor = { x: 620, y: 180 };
    const before = screenToZone(vp, cursor);
    const zoomed = zoomAt(vp, cursor, 2.5);
    const after = screenToZone(zoomed, cursor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.zoom).toBeCloseTo(2.5, 9);
  });

  it('clamps zoom to sane limits', () => {
    expect(zoomAt(vp, { x: 400, y: 300 }, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(vp, { x: 400, y: 300 }, 0.0001).zoom).toBe(MIN_ZOOM);
  });

  it('pans in millimetres derived from pixels', () => {
    const panned = panByPx(vp, { x: pxPerMm(vp), y: 0 });
    expect(panned.panMm.x).toBeCloseTo(-1, 6);
    expect(zoneToScreen(panned, { x: 0, y: 0 }).x).toBeCloseTo(400 + pxPerMm(vp), 6);
  });

  it('re-fits when the canvas resizes', () => {
    const wide = resize(vp, { w: 1600, h: 600 });
    expect(pxPerMm(wide)).toBeCloseTo(pxPerMm(vp), 9); // height still the limiting axis
  });

  it('picks ruler steps that stay readable', () => {
    expect(rulerStepMm(vp)).toBeGreaterThan(0);
    const zoomed = { ...vp, zoom: 10 };
    expect(rulerStepMm(zoomed)).toBeLessThan(rulerStepMm(vp));
  });
});

describe('hit testing', () => {
  const t = tf();

  it('finds the eight scale handles', () => {
    const handles = handlePositions(vp, t);
    for (const [id, pos] of Object.entries(handles)) {
      expect(hitTest(vp, t, pos)).toEqual({ kind: 'scale', handle: id });
    }
  });

  it('finds the rotation handle outside the box', () => {
    expect(hitTest(vp, t, rotateHandlePosition(vp, t))).toEqual({ kind: 'rotate' });
  });

  it('reports a move for the interior', () => {
    expect(hitTest(vp, t, { x: 400, y: 300 })).toEqual({ kind: 'move' });
  });

  it('reports nothing outside the placement', () => {
    expect(hitTest(vp, t, { x: 60, y: 60 })).toEqual({ kind: 'none' });
  });

  it('accounts for rotation when testing the interior', () => {
    const rotated = tf({ sizeMm: { w: 20, h: 4 }, rotationDeg: 90 });
    expect(isInsidePlacement(vp, rotated, zoneToScreen(vp, { x: 0, y: 8 }))).toBe(true);
    expect(isInsidePlacement(vp, rotated, zoneToScreen(vp, { x: 8, y: 0 }))).toBe(false);
  });

  it('rotates the resize cursor with the box', () => {
    expect(cursorFor({ kind: 'scale', handle: 'n' }, tf())).toBe('ns-resize');
    expect(cursorFor({ kind: 'scale', handle: 'n' }, tf({ rotationDeg: 90 }))).toBe('ew-resize');
    expect(cursorFor({ kind: 'move' }, tf())).toBe('move');
  });
});

describe('gestures', () => {
  const ctx = { zone, snapEnabled: true };

  it('moves the placement by the pointer delta, keeping the grab point under the cursor', () => {
    const start = tf({ offsetMm: { x: 4, y: 4 } });
    const grabScreen = zoneToScreen(vp, { x: 6, y: 5 });
    const gesture = beginGesture(vp, start, grabScreen, { kind: 'move' })!;
    const target = zoneToScreen(vp, { x: 9, y: 2 });
    const update = updateGesture(gesture, vp, target, ctx);
    expect(update.transform.offsetMm.x).toBeCloseTo(7, 6);
    expect(update.transform.offsetMm.y).toBeCloseTo(1, 6);
  });

  it('snaps to the zone centre and reports the guide', () => {
    const start = tf({ offsetMm: { x: 5, y: 5 } });
    const gesture = beginGesture(vp, start, zoneToScreen(vp, { x: 5, y: 5 }), { kind: 'move' })!;
    const update = updateGesture(gesture, vp, zoneToScreen(vp, { x: 0.2, y: 0.2 }), ctx);
    expect(update.transform.offsetMm.x).toBeCloseTo(0, 6);
    expect(update.guides.map((g) => g.kind)).toContain('zoneCenter');
  });

  it('suspends snapping while Alt is held', () => {
    const start = tf({ offsetMm: { x: 5, y: 5 } });
    const gesture = beginGesture(vp, start, zoneToScreen(vp, { x: 5, y: 5 }), { kind: 'move' })!;
    const update = updateGesture(gesture, vp, zoneToScreen(vp, { x: 0.2, y: 0.2 }), ctx, { alt: true });
    expect(update.transform.offsetMm.x).toBeCloseTo(0.2, 6);
    expect(update.guides).toHaveLength(0);
  });

  it('clamps at the zone boundary and says so', () => {
    const start = tf();
    const gesture = beginGesture(vp, start, zoneToScreen(vp, { x: 0, y: 0 }), { kind: 'move' })!;
    const update = updateGesture(gesture, vp, zoneToScreen(vp, { x: 40, y: 0 }), ctx);
    expect(update.hitBoundary).toBe(true);
    expect(aabb(update.transform).max.x).toBeCloseTo(15, 6);
  });

  it('scales from a corner handle keeping the opposite corner anchored', () => {
    const start = tf();
    const gesture = beginGesture(vp, start, zoneToScreen(vp, { x: 5, y: -5 }), {
      kind: 'scale',
      handle: 'se',
    })!;
    const update = updateGesture(gesture, vp, zoneToScreen(vp, { x: 8, y: -8 }), ctx);
    expect(aabb(update.transform).min.x).toBeCloseTo(-5, 6);
    expect(update.transform.sizeMm.w).toBeCloseTo(13, 6);
  });

  it('rotates with 15 degree snapping unless Shift is held', () => {
    const start = tf();
    const gesture = beginGesture(vp, start, rotateHandlePosition(vp, start), { kind: 'rotate' })!;
    const snapped = updateGesture(gesture, vp, zoneToScreen(vp, { x: 10, y: 1.5 }), ctx);
    expect(snapped.transform.rotationDeg % 15).toBeCloseTo(0, 9);

    const free = updateGesture(gesture, vp, zoneToScreen(vp, { x: 10, y: 1.5 }), ctx, { shift: true });
    expect(free.transform.rotationDeg % 15).not.toBeCloseTo(0, 6);
  });

  it('returns null for a gesture that started on nothing', () => {
    expect(beginGesture(vp, tf(), { x: 5, y: 5 }, { kind: 'none' })).toBeNull();
  });

  it('quantises only on commit', () => {
    const start = tf();
    const gesture = beginGesture(vp, start, zoneToScreen(vp, { x: 0, y: 0 }), { kind: 'move' })!;
    const update = updateGesture(gesture, vp, { x: 401.37, y: 300 }, { zone, snapEnabled: false });
    const committed = commitGesture(update);
    expect(committed.offsetMm.x).toBeCloseTo(Math.round(update.transform.offsetMm.x * 100) / 100, 9);
  });
});

describe('keyboard nudging', () => {
  it('moves half a millimetre, or a tenth with the fine modifier', () => {
    const t = initialTransform({ w: 40, h: 16 }, zone);
    expect(nudge(t, 'right', zone).offsetMm.x).toBeCloseTo(0.5, 9);
    expect(nudge(t, 'up', zone, true).offsetMm.y).toBeCloseTo(0.1, 9);
    expect(nudge(t, 'down', zone).offsetMm.y).toBeCloseTo(-0.5, 9);
  });

  it('stops at the zone edge', () => {
    let t = tf({ offsetMm: { x: 9.9, y: 0 } });
    for (let i = 0; i < 10; i++) t = nudge(t, 'right', zone);
    expect(aabb(t).max.x).toBeLessThanOrEqual(15 + 1e-9);
  });
});
