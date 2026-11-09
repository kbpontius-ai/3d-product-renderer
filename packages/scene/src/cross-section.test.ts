import { describe, expect, it } from 'vitest';
import type { DecorationZoneDef } from '@pr/design-schema';
import { crossSectionPlanes, partAxis, type BboxMm } from './cross-section.js';

/** The three fixture packs' real extents, so these are the parts the product actually ships. */
const CAP: BboxMm = [
  [-19, 0, -19],
  [19, 18, 19],
];
const BOTTLE: BboxMm = [
  [-30, 0, -20],
  [30, 110, 20],
];
const CARTON: BboxMm = [
  [-40, 0, -20],
  [40, 120, 20],
];

const skirt = {
  type: 'cylindrical',
  key: 'skirt',
  name: 'Skirt',
  frame: { axisOriginMm: [0, 0, 0], axisDir: [0, 1, 0], radiusMm: 19, centerAngleDeg: 0, centerHeightMm: 8 },
} as unknown as DecorationZoneDef;

const top = {
  type: 'planar',
  key: 'top',
  name: 'Top face',
  frame: { originMm: [0, 18, 0], normal: [0, 1, 0], tangent: [1, 0, 0] },
} as unknown as DecorationZoneDef;

describe('partAxis', () => {
  it('takes a cylindrical zone at its word', () => {
    // A pack that declares an axis was authored by somebody who knew. Nothing derived should
    // second-guess it.
    expect(partAxis(CARTON, [skirt])).toEqual([0, 1, 0]);
  });

  it('finds a closure\'s axis from the two extents that match', () => {
    // The case that makes "longest dimension" wrong: the cap is 38 mm across and 18 mm tall, so the
    // longest axis is horizontal and cutting along it would slice the cap into a disc rather than
    // showing its wall. Equality of the other two is what identifies a body of revolution.
    expect(partAxis(CAP)).toEqual([0, 1, 0]);
  });

  it('falls back to the upright for a part that turns about nothing', () => {
    // An oval bottle and a carton have no axis of revolution. "Up" is still the answer anybody
    // means by lengthways.
    expect(partAxis(BOTTLE)).toEqual([0, 1, 0]);
    expect(partAxis(CARTON)).toEqual([0, 1, 0]);
  });
});

describe('crossSectionPlanes', () => {
  it('offers the artwork cut first, then the lengthways pair', () => {
    // Most specific first, so a plane that is several things at once gets the informative name.
    const keys = crossSectionPlanes({ bboxMm: CAP, zones: [top, skirt], decoratedZoneKey: 'top' }).map(
      (p) => p.key,
    );
    expect(keys[0]).toBe('artwork');
    expect(keys).toContain('axis-b');
  });

  it('never offers one plane under two names', () => {
    // A centred logo on a cap top lies on the axis, so "through the artwork" and "lengthways" are
    // the same plane. Two buttons producing an identical picture teach the user that the controls
    // do not mean anything, so the second one is dropped rather than shown.
    const planes = crossSectionPlanes({ bboxMm: CAP, zones: [top, skirt], decoratedZoneKey: 'top' });
    const geometry = planes.map(
      (p) => `${p.normal.join(',')}@${(p.normal[0] * p.originMm[0] + p.normal[1] * p.originMm[1] + p.normal[2] * p.originMm[2]).toFixed(2)}`,
    );
    expect(new Set(geometry).size).toBe(geometry.length);
    expect(planes.some((p) => p.key === 'axis-a')).toBe(false);
  });

  it('cuts across the artwork, not along it', () => {
    // A plane lying *on* the decorated surface would shave the mark off and show nothing. The
    // useful section contains the surface normal, so for a logo on a cap top it is a vertical
    // slice — its own normal horizontal.
    const planes = crossSectionPlanes({ bboxMm: CAP, zones: [top, skirt], decoratedZoneKey: 'top' });
    const artwork = planes.find((p) => p.key === 'artwork')!;

    expect(artwork.normal).not.toEqual([0, 1, 0]);
    expect(Math.abs(artwork.normal[1])).toBeLessThan(0.5);
    expect(artwork.originMm).toEqual([0, 18, 0]);
  });

  it('never offers the same plane twice', () => {
    // The lengthways pair and the bounding-box planes overlap on an axis-aligned part; the second
    // one to claim a key is dropped rather than shown as a duplicate button.
    for (const bbox of [CAP, BOTTLE, CARTON]) {
      const keys = crossSectionPlanes({ bboxMm: bbox, zones: [] }).map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('gives every cut a travel range that clears the part', () => {
    // The slider's range. Too short and the last slice of material cannot be cut away; the range is
    // half the extent along the plane's own normal, so zero is always the middle.
    for (const plane of crossSectionPlanes({ bboxMm: BOTTLE, zones: [] })) {
      expect(plane.travelMm.min).toBeLessThan(0);
      expect(plane.travelMm.max).toBeGreaterThan(0);
      expect(plane.travelMm.max).toBe(-plane.travelMm.min);
    }

    // 110 mm tall, so a cut across the height reaches 55 mm either way.
    const acrossHeight = crossSectionPlanes({ bboxMm: BOTTLE, zones: [] }).find((p) => p.key === 'bbox-y')!;
    expect(acrossHeight.travelMm.max).toBeCloseTo(55, 1);
  });

  it('still cuts a carton on all three axes, whatever the buttons end up called', () => {
    // Flat panels carry a uv rect and no frame, so there is no artwork plane to derive. What is
    // left has to still cover the box in every direction — asserted on the geometry rather than on
    // the keys, because the lengthways pair and two of the bounding-box cuts *are* the same planes
    // on an axis-aligned part and only one of each survives the dedupe. Which name wins is a
    // labelling decision; that all three directions are reachable is the promise.
    const planes = crossSectionPlanes({ bboxMm: CARTON, zones: [] });
    const directions = planes.map((p) => p.normal.findIndex((n) => Math.abs(n) > 0.5));

    expect(new Set(directions)).toEqual(new Set([0, 1, 2]));
    expect(planes.every((p) => Math.hypot(...p.normal) > 0.99)).toBe(true);
  });
});
