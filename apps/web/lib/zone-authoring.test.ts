import { describe, expect, it } from 'vitest';
import type { DecorationZoneDef, Vec3 } from '@pr/design-schema';
import { cross, length, mapperFor, sub } from '@pr/placement';
import {
  applyRimPick,
  changeZoneMapping,
  applySurfacePick,
  circleThrough,
  emptyZoneForm,
  formsMatch,
  placementMarker,
  flipCylinderAxis,
  flipFacing,
  formFromZone,
  rotateArtwork90,
  surfaceReport,
  zoneCentreMm,
  zoneFromForm,
  zoneOutlinesMm,
  type ZoneForm,
} from './zone-authoring';

const constraints = {
  finishes: ['emboss'],
  maxDepthMm: 0.6,
  minStrokeMm: 0.25,
  maxCoverage: 0.9,
  wrapWarnDeg: 120,
};

type Planar = Extract<DecorationZoneDef, { type: 'planar' }>;

const top: Planar = {
  type: 'planar',
  key: 'top',
  name: 'Top',
  frame: { originMm: [0, 15, 0], normal: [0, 1, 0], tangent: [1, 0, 0] },
  sizeMm: { width: 30, height: 20, safeMarginMm: 1 },
  constraints,
} as Planar;

const skirt = {
  type: 'cylindrical',
  key: 'skirt',
  name: 'Skirt',
  frame: {
    axisOriginMm: [0, 0, 0],
    axisDir: [0, 0, 1],
    radiusMm: 46,
    centerAngleDeg: 30,
    centerHeightMm: 7,
  },
  sizeMm: { arcWidthMm: 40, height: 8, safeMarginMm: 1 },
  constraints,
} as DecorationZoneDef;

const zoneOf = (form: ZoneForm, key = 'k'): DecorationZoneDef => {
  const result = zoneFromForm(form, key);
  expect(result.problems).toEqual([]);
  return result.zone!;
};

const close = (a: Vec3, b: Vec3, digits = 3) =>
  a.forEach((value, i) => expect(value).toBeCloseTo(b[i]!, digits));

describe('a new zone', () => {
  it('starts with nothing placed, and cannot be saved that way', () => {
    // The feature's one rule: the app never guesses where a zone goes. An empty field is honest; a
    // plausible number is a guess somebody accepts without reading.
    for (const type of ['planar', 'cylindrical', 'conformal'] as const) {
      const form = emptyZoneForm(type);
      expect([
        ...form.originMm,
        ...form.normal,
        ...form.tangent,
        ...form.axisOriginMm,
        ...form.axisDir,
      ]).toEqual(Array(15).fill(''));
      expect([
        form.radiusMm,
        form.centerAngleDeg,
        form.centerHeightMm,
        form.widthMm,
        form.heightMm,
      ]).toEqual(Array(5).fill(''));

      const result = zoneFromForm({ ...form, name: 'Logo' }, 'logo');
      expect(result.zone).toBeNull();
      expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it('names the field that is wrong', () => {
    const form = { ...formFromZone(top), normal: ['0', '0', '0'] as ZoneForm['normal'] };
    expect(zoneFromForm(form, 'top').problems).toContain('Facing direction cannot be zero');

    const parallel = { ...formFromZone(top), tangent: ['0', '2', '0'] as ZoneForm['tangent'] };
    expect(zoneFromForm(parallel, 'top').problems).toContain(
      'Artwork direction cannot point the same way as the facing direction',
    );
  });
});

describe('an existing zone', () => {
  it('survives the round trip through the form unchanged', () => {
    for (const zone of [top, skirt]) {
      expect(zoneOf(formFromZone(zone), zone.key)).toEqual(zone);
    }
  });
});

describe('flipFacing', () => {
  it('turns the zone to face the other way without moving it', () => {
    const flipped = zoneOf(flipFacing(formFromZone(top)));
    close(zoneCentreMm(flipped), zoneCentreMm(top));
    expect((flipped as Planar).frame.normal).toEqual([0, -1, 0]);
  });

  it('reads correctly from the side it now faces, rather than mirrored', () => {
    // Right × up has to point out of the face, towards whoever is reading it. A mirrored zone has
    // it pointing into the part.
    const flipped = zoneOf(flipFacing(formFromZone(top)));
    const at = mapperFor(flipped);
    const centre = at.toWorld({ x: 0, y: 0 });
    const right = sub(at.toWorld({ x: 1, y: 0 }).position, centre.position);
    const up = sub(at.toWorld({ x: 0, y: 1 }).position, centre.position);
    close(cross(right, up), centre.normal);
  });
});

describe('rotateArtwork90', () => {
  it('turns the artwork a quarter, and four quarters bring it home', () => {
    const once = rotateArtwork90(formFromZone(top));
    // A quarter turn anticlockwise puts the artwork's right where its up was.
    close(mapperFor(zoneOf(once)).toWorld({ x: 0, y: 0 }).tangent, [0, 0, -1]);

    let form = formFromZone(top);
    for (let i = 0; i < 4; i++) form = rotateArtwork90(form);
    expect(zoneOf(form, 'top')).toEqual(top);
  });
});

describe('flipCylinderAxis', () => {
  it('turns a band upside down without moving it', () => {
    // Reversing the axis alone moves the band: height and angle are both measured relative to it.
    const flipped = zoneOf(flipCylinderAxis(formFromZone(skirt)));
    close(zoneCentreMm(flipped), zoneCentreMm(skirt));

    // Up and right both reverse — a half turn, which reads correctly, not a mirror.
    const before = mapperFor(skirt).toWorld({ x: 0, y: 0 });
    const after = mapperFor(flipped).toWorld({ x: 0, y: 0 });
    close(after.tangent, before.tangent.map((v) => -v) as Vec3);
    close(after.normal, before.normal);
  });
});

describe('applySurfacePick', () => {
  it('centres a face on the clicked point, facing the way the surface does there', () => {
    const picked = applySurfacePick(emptyZoneForm('planar'), [3, 15, -2], [0, 2, 0]);
    expect(picked.problem).toBeNull();
    const zone = zoneOf({ ...picked.form!, name: 'Top', widthMm: '10', heightMm: '10' });
    close(zoneCentreMm(zone), [3, 15, -2]);
    close((zone as Planar).frame.normal, [0, 1, 0]);
  });

  it('keeps the artwork pointing the way it was when the new face allows it', () => {
    const picked = applySurfacePick(formFromZone(top), [0, 15, 0], [0, 1, 0.1]);
    const tangent = (zoneOf(picked.form!) as Planar).frame.tangent;
    close(tangent, [1, 0, 0]);
  });

  it('puts a band exactly where it was clicked, around the axis already entered', () => {
    const form = {
      ...emptyZoneForm('cylindrical'),
      axisOriginMm: ['0', '0', '0'],
      axisDir: ['0', '0', '1'],
    } as ZoneForm;
    const point: Vec3 = [20, -30, 9];
    const picked = applySurfacePick(form, point, [1, 0, 0]);
    expect(picked.problem).toBeNull();

    const zone = zoneOf({ ...picked.form!, name: 'Skirt', widthMm: '20', heightMm: '6' });
    close(zoneCentreMm(zone), point);
    expect(Number(picked.form!.radiusMm)).toBeCloseTo(length([20, -30, 0]), 3);
  });

  it('asks for the axis before a band can be clicked into place', () => {
    const picked = applySurfacePick(emptyZoneForm('cylindrical'), [20, 0, 0], [1, 0, 0]);
    expect(picked.form).toBeNull();
    expect(picked.problem).toMatch(/axis/);
  });
});

describe('zoneOutlinesMm', () => {
  it('draws a closed loop that hugs the surface', () => {
    const { boundary, safe } = zoneOutlinesMm(skirt);
    expect(boundary[0]).toEqual(boundary.at(-1));
    expect(safe[0]).toEqual(safe.at(-1));

    // Every point of a band's outline sits at the band's radius, not on a chord across it.
    for (const point of boundary) expect(Math.hypot(point[0], point[1])).toBeCloseTo(46.05, 2);
  });
});

describe('surfaceReport', () => {
  // A flat 20 x 20 mm face at z = 0, facing +z: the smallest surface on which a zone can hang off an
  // edge, or face the wrong way.
  const face = {
    nearestSurface(p: Vec3, maxDistanceMm = Infinity) {
      const position: Vec3 = [
        Math.max(-10, Math.min(10, p[0])),
        Math.max(-10, Math.min(10, p[1])),
        0,
      ];
      if (length(sub(p, position)) > maxDistanceMm) return null;
      return { position, normal: [0, 0, 1] as Vec3, tangent: [1, 0, 0] as Vec3 };
    },
  };
  const onFace = (widthMm: number, normal: Vec3 = [0, 0, 1]): DecorationZoneDef =>
    ({
      ...top,
      frame: { originMm: [0, 0, 0], normal, tangent: [1, 0, 0] },
      sizeMm: { width: widthMm, height: widthMm, safeMarginMm: 1 },
    }) as DecorationZoneDef;

  it('passes a zone that sits on the face', () => {
    const report = surfaceReport(onFace(12), face);
    expect(report.centreMm).toBeCloseTo(0, 6);
    expect(report.cornersOff).toBe(0);
    expect(report.facesInto).toBe(false);
  });

  it('counts the corners that hang off the part, though the centre is on it', () => {
    // 30 mm on a 20 mm face: every corner is 5 mm past both edges.
    const report = surfaceReport(onFace(30), face);
    expect(report.centreMm).toBeCloseTo(0, 6);
    expect(report.cornersOff).toBe(4);
  });

  it('notices a zone facing into the part', () => {
    expect(surfaceReport(onFace(12, [0, 0, -1]), face).facesInto).toBe(true);
  });

  it('notices a band that runs off the end of the part', () => {
    // A band on a cylinder of radius 10, 20 mm long, placed so its top edge is 4 mm past the end.
    const cylinder = {
      nearestSurface(p: Vec3) {
        const radial = Math.hypot(p[0], p[1]) || 1;
        const z = Math.max(0, Math.min(20, p[2]));
        const position: Vec3 = [(p[0] / radial) * 10, (p[1] / radial) * 10, z];
        return {
          position,
          normal: [p[0] / radial, p[1] / radial, 0] as Vec3,
          tangent: [0, 0, 1] as Vec3,
        };
      },
    };
    const band = {
      ...skirt,
      frame: {
        axisOriginMm: [0, 0, 0],
        axisDir: [0, 0, 1],
        radiusMm: 10,
        centerAngleDeg: 0,
        centerHeightMm: 16,
      },
      sizeMm: { arcWidthMm: 10, height: 16, safeMarginMm: 1 },
    } as DecorationZoneDef;
    const report = surfaceReport(band, cylinder);
    expect(report.centreMm).toBeCloseTo(0, 3);
    expect(report.cornersOff).toBe(2);
    expect(report.facesInto).toBe(false);
  });
});

describe('circleThrough', () => {
  it('finds the centre, radius and plane of a circle from three points on it', () => {
    // Three points on a 46 mm circle around (1, 2, 15), in the plane z = 15.
    const at = (deg: number): Vec3 => [
      1 + 46 * Math.cos((deg * Math.PI) / 180),
      2 + 46 * Math.sin((deg * Math.PI) / 180),
      15,
    ];
    const circle = circleThrough(at(10), at(130), at(250))!;
    close(circle.centre, [1, 2, 15]);
    expect(circle.radius).toBeCloseTo(46, 6);
    expect(Math.abs(circle.normal[2])).toBeCloseTo(1, 6);
  });

  it('refuses three points in a line, which lie on no circle', () => {
    expect(circleThrough([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull();
  });
});

describe('applyRimPick', () => {
  const rim: [Vec3, Vec3, Vec3] = [
    [46, 0, 15],
    [0, 46, 15],
    [-46, 0, 15],
  ];

  it('centres a flat face on the circle, facing the way the surface does', () => {
    const picked = applyRimPick(emptyZoneForm('planar'), rim, [0, 0, 1]);
    const zone = zoneOf({ ...picked.form!, name: 'Lid', widthMm: '20', heightMm: '20' });
    close(zoneCentreMm(zone), [0, 0, 15]);
    close((zone as Planar).frame.normal, [0, 0, 1]);

    // Clicked from underneath, the same rim gives the same face turned the other way.
    const below = applyRimPick(emptyZoneForm('planar'), rim, [0, 0, -1]);
    expect(below.form!.normal).toEqual(['0', '0', '-1']);
  });

  it('gives a band its axis and radius, keeping the direction it already had', () => {
    const form = { ...emptyZoneForm('cylindrical'), axisDir: ['0', '0', '-1'] } as ZoneForm;
    const picked = applyRimPick(form, rim, [0, 0, 1]);
    expect(picked.form!.axisOriginMm).toEqual(['0', '0', '15']);
    expect(picked.form!.axisDir).toEqual(['0', '0', '-1']);
    expect(Number(picked.form!.radiusMm)).toBeCloseTo(46, 3);
  });

  it('says so when the points do not make a circle', () => {
    const picked = applyRimPick(
      emptyZoneForm('planar'),
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      [0, 0, 1],
    );
    expect(picked.form).toBeNull();
    expect(picked.problem).toMatch(/circle/);
  });
});

describe('placementMarker', () => {
  it('shows where a zone will sit before it has a size', () => {
    const form = {
      ...emptyZoneForm('planar'),
      originMm: ['1', '2', '3'],
      normal: ['0', '0', '2'],
    } as ZoneForm;
    expect(placementMarker(form)).toEqual({ point: [1, 2, 3], normal: [0, 0, 1] });
  });

  it('shows where a band will sit once its axis, radius, angle and height are known', () => {
    const band = formFromZone(skirt);
    const marker = placementMarker({ ...band, widthMm: '' })!;
    close(marker.point, zoneCentreMm(skirt));
  });

  it('shows nothing until the position is known', () => {
    expect(placementMarker(emptyZoneForm('planar'))).toBeNull();
  });
});

describe('formsMatch', () => {
  it('treats the same numbers written differently as the same', () => {
    const a = formFromZone(top);
    expect(formsMatch(a, { ...a, widthMm: '30.0', originMm: ['0', '15.00', '0'] })).toBe(true);
    expect(formsMatch(a, { ...a, widthMm: '31' })).toBe(false);
    expect(formsMatch(a, { ...a, finishes: [] })).toBe(false);
  });
});

describe('mapping choices', () => {
  it('preserves placement and constraints through a round trip', () => {
    const original = formFromZone(top);
    const curved = changeZoneMapping(original, 'conformal');
    expect(curved.maxProjectionDepthMm).toBe('1');
    expect(zoneOf(curved).type).toBe('conformal');
    const flat = changeZoneMapping(curved, 'planar');
    expect(zoneOf(flat, 'top')).toEqual(top);
    expect(curved.originMm).toEqual(original.originMm);
    expect(curved.tangent).toEqual(original.tangent);
    expect(curved.finishes).toEqual(original.finishes);
  });
  it('retains an explicit projection depth when switching back', () => {
    const form = { ...formFromZone(top), maxProjectionDepthMm: '12' };
    expect(
      changeZoneMapping(changeZoneMapping(form, 'planar'), 'conformal').maxProjectionDepthMm,
    ).toBe('12');
  });
});
