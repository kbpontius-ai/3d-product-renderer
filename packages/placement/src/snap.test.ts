import { describe, expect, it } from 'vitest';
import type { Transform } from '@pr/design-schema';
import { aabb } from './transform.js';
import {
  applySnap,
  SNAP_BREAK_FACTOR,
  SNAP_THRESHOLD_PX,
  snapTargets,
  type ActiveSnapState,
  type SnapContext,
} from './snap.js';

const zone = { w: 30, h: 30, safeMarginMm: 1.5 };

const tf = (over: Partial<Transform> = {}): Transform => ({
  offsetMm: { x: 0, y: 0 },
  sizeMm: { w: 10, h: 10 },
  rotationDeg: 0,
  flipX: false,
  flipY: false,
  lockAspect: true,
  ...over,
});

/** 10 px per mm => a 0.6 mm snap threshold. */
const ctx = (over: Partial<SnapContext> = {}): SnapContext => ({
  zone,
  pxPerMm: 10,
  enabled: true,
  ...over,
});

describe('snapTargets', () => {
  it('always offers the zone centre on both axes', () => {
    const targets = snapTargets(ctx());
    expect(targets.filter((t) => t.kind === 'zoneCenter')).toHaveLength(2);
  });

  it('includes safe-margin and zone edges', () => {
    const targets = snapTargets(ctx());
    expect(targets.some((t) => t.kind === 'safeEdge' && Math.abs(t.valueMm - 13.5) < 1e-9)).toBe(true);
    expect(targets.some((t) => t.kind === 'zoneEdge' && Math.abs(t.valueMm - 15) < 1e-9)).toBe(true);
  });

  it('includes neighbour centres and edges', () => {
    const targets = snapTargets(ctx({ neighbours: [tf({ offsetMm: { x: 5, y: 0 } })] }));
    expect(targets.some((t) => t.kind === 'neighborCenter' && Math.abs(t.valueMm - 5) < 1e-9)).toBe(true);
    expect(targets.some((t) => t.kind === 'neighborEdge' && Math.abs(t.valueMm - 10) < 1e-9)).toBe(true);
  });
});

describe('applySnap', () => {
  it('snaps the centre to the zone centre inside the threshold', () => {
    const r = applySnap(tf({ offsetMm: { x: 0.3, y: 0 } }), ctx());
    expect(r.transform.offsetMm.x).toBeCloseTo(0, 9);
    expect(r.guides.some((g) => g.kind === 'zoneCenter' && g.axis === 'x')).toBe(true);
  });

  it('leaves the placement alone outside the threshold', () => {
    const r = applySnap(tf({ offsetMm: { x: 1.5, y: 0 } }), ctx());
    expect(r.transform.offsetMm.x).toBeCloseTo(1.5, 9);
    expect(r.guides.some((g) => g.axis === 'x')).toBe(false);
  });

  it('scales the threshold with zoom, so it feels the same at any scale', () => {
    const zoomedOut = applySnap(tf({ offsetMm: { x: 1.5, y: 0 } }), ctx({ pxPerMm: 1 }));
    expect(zoomedOut.transform.offsetMm.x).toBeCloseTo(0, 9);
  });

  it('is suspended while Alt is held', () => {
    const r = applySnap(tf({ offsetMm: { x: 0.3, y: 0 } }), ctx(), { suspend: true });
    expect(r.transform.offsetMm.x).toBeCloseTo(0.3, 9);
    expect(r.guides).toHaveLength(0);
  });

  it('does nothing when the user has turned snapping off', () => {
    const r = applySnap(tf({ offsetMm: { x: 0.3, y: 0 } }), ctx({ enabled: false }));
    expect(r.transform.offsetMm.x).toBeCloseTo(0.3, 9);
  });

  it('prefers the zone centre over a neighbour at the same distance', () => {
    const r = applySnap(
      tf({ offsetMm: { x: 0.3, y: 0 } }),
      ctx({ neighbours: [tf({ offsetMm: { x: 0.6, y: 0 } })] }),
    );
    expect(r.transform.offsetMm.x).toBeCloseTo(0, 9);
    expect(r.guides.find((g) => g.axis === 'x')?.kind).toBe('zoneCenter');
  });

  it('snaps a bounding-box edge to the safe margin', () => {
    const r = applySnap(tf({ offsetMm: { x: 8.9, y: 0 } }), ctx());
    expect(aabb(r.transform).max.x).toBeCloseTo(13.5, 6);
    const fired = r.guides.find((g) => g.axis === 'x');
    expect(fired?.kind).toBe('safeEdge');
    expect(fired?.anchor).toBe('max');
  });

  it('snaps to a custom guide', () => {
    const r = applySnap(
      tf({ offsetMm: { x: 4.2, y: 0 } }),
      ctx({ guides: [{ axis: 'x', valueMm: 4 }] }),
    );
    expect(r.transform.offsetMm.x).toBeCloseTo(4, 9);
    expect(r.guides.find((g) => g.axis === 'x')?.kind).toBe('guide');
  });

  it('snaps both axes independently', () => {
    const r = applySnap(tf({ offsetMm: { x: 0.2, y: -0.4 } }), ctx());
    expect(r.transform.offsetMm.x).toBeCloseTo(0, 9);
    expect(r.transform.offsetMm.y).toBeCloseTo(0, 9);
    expect(r.guides).toHaveLength(2);
  });

  it('reports the active snap so the caller can hold it', () => {
    // y = 7 keeps every y anchor (min 2, centre 7, max 12) clear of the targets.
    const r = applySnap(tf({ offsetMm: { x: 0.3, y: 7 } }), ctx());
    expect(r.active.x).toMatchObject({ kind: 'zoneCenter', valueMm: 0, anchor: 'center' });
    expect(r.active.y).toBeUndefined();
  });

  it('snaps an edge to the zone middle line, not just the centre', () => {
    // Bottom edge resting on the middle line is a real alignment users ask for.
    const r = applySnap(tf({ offsetMm: { x: 7, y: 5.3 } }), ctx());
    expect(aabb(r.transform).min.y).toBeCloseTo(0, 9);
    expect(r.guides.find((g) => g.axis === 'y')?.anchor).toBe('min');
  });

  describe('sticky release', () => {
    const held: ActiveSnapState = {
      x: { axis: 'x', valueMm: 0, kind: 'zoneCenter', anchor: 'center' },
    };

    it('holds a snap slightly past the threshold', () => {
      const drift = (SNAP_THRESHOLD_PX / 10) * 1.2; // inside break distance
      const r = applySnap(tf({ offsetMm: { x: drift, y: 7 } }), ctx({ active: held }));
      expect(r.transform.offsetMm.x).toBeCloseTo(0, 9);
    });

    it('breaks once the user pulls clearly away', () => {
      const drift = (SNAP_THRESHOLD_PX / 10) * (SNAP_BREAK_FACTOR + 0.2);
      const r = applySnap(tf({ offsetMm: { x: drift, y: 7 } }), ctx({ active: held }));
      expect(r.transform.offsetMm.x).toBeCloseTo(drift, 9);
      expect(r.active.x).toBeUndefined();
    });

    it('never holds a snap while suspended', () => {
      const r = applySnap(tf({ offsetMm: { x: 0.1, y: 7 } }), ctx({ active: held }), { suspend: true });
      expect(r.transform.offsetMm.x).toBeCloseTo(0.1, 9);
    });
  });
});
