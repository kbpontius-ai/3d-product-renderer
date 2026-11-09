import { DecorationZoneDef, zoneExtentMm, type FinishKind, type Vec3 } from '@pr/design-schema';
import {
  add,
  anyPerpendicular,
  cross,
  DEG2RAD,
  dot,
  length,
  mapperFor,
  normalize,
  orthogonalize,
  RAD2DEG,
  scale,
  sub,
} from '@pr/placement';

/**
 * The Zones page's form, and the arithmetic behind its buttons (F-ADM-13, F-ADM-14).
 *
 * Kept out of the component so it can be tested without a DOM, and because every function here is
 * a place a zone could silently end up mirrored or upside down — which is exactly what the tests
 * pin.
 *
 * Nothing here proposes where a zone goes. A new form starts with its placement empty, and the only
 * numbers ever written into it come from the author: typed, chosen from the axis buttons, or
 * measured off the point they clicked on the part.
 */

export type AuthorableZoneType = 'planar' | 'cylindrical' | 'conformal';
export type Triple = [string, string, string];

export interface ZoneForm {
  type: DecorationZoneDef['type'];
  name: string;
  /** planar and conformal */
  materialSlotKey: string;
  originMm: Triple;
  normal: Triple;
  tangent: Triple;
  /** conformal only */
  maxProjectionDepthMm: string;
  /** cylindrical */
  axisOriginMm: Triple;
  axisDir: Triple;
  radiusMm: string;
  centerAngleDeg: string;
  centerHeightMm: string;
  /** Arc width for a cylinder, flat width otherwise. */
  widthMm: string;
  heightMm: string;
  safeMarginMm: string;
  maxDepthMm: string;
  minStrokeMm: string;
  maxCoverage: string;
  wrapWarnDeg: string;
  finishes: FinishKind[];
}

export const ZONE_TYPE_LABELS: Record<AuthorableZoneType, string> = {
  planar: 'Flat surface',
  cylindrical: 'Around the side',
  conformal: 'Follow surface',
};

export const isAuthorable = (type: DecorationZoneDef['type']): type is AuthorableZoneType =>
  type === 'planar' || type === 'cylindrical' || type === 'conformal';

/** The six directions offered as one-click choices. Named by axis, because "up" is the part's call. */
export const AXIS_CHOICES: { label: string; value: Vec3 }[] = [
  { label: '+X', value: [1, 0, 0] },
  { label: '−X', value: [-1, 0, 0] },
  { label: '+Y', value: [0, 1, 0] },
  { label: '−Y', value: [0, -1, 0] },
  { label: '+Z', value: [0, 0, 1] },
  { label: '−Z', value: [0, 0, -1] },
];

const EMPTY: Triple = ['', '', ''];

/**
 * A new zone with nothing placed.
 *
 * The constraints start at the schema's own defaults — they are tooling limits, not a claim about
 * where anything goes. Placement and size start empty and cannot be saved empty.
 */
export function emptyZoneForm(type: AuthorableZoneType): ZoneForm {
  return {
    type,
    name: '',
    materialSlotKey: '',
    originMm: [...EMPTY],
    normal: [...EMPTY],
    tangent: [...EMPTY],
    maxProjectionDepthMm: '',
    axisOriginMm: [...EMPTY],
    axisDir: [...EMPTY],
    radiusMm: '',
    centerAngleDeg: '',
    centerHeightMm: '',
    widthMm: '',
    heightMm: '',
    safeMarginMm: '1',
    maxDepthMm: '0.6',
    minStrokeMm: '0.25',
    maxCoverage: '0.9',
    wrapWarnDeg: '120',
    finishes: ['emboss', 'deboss', 'print'],
  };
}

export function changeZoneMapping(form: ZoneForm, type: 'planar' | 'conformal'): ZoneForm {
  return { ...form, type, maxProjectionDepthMm: form.maxProjectionDepthMm || '1' };
}

export function formFromZone(zone: DecorationZoneDef): ZoneForm {
  const extent = zoneExtentMm(zone);
  const form: ZoneForm = {
    ...emptyZoneForm('planar'),
    type: zone.type,
    name: zone.name,
    materialSlotKey: zone.materialSlotKey ?? '',
    widthMm: fmt(extent.w),
    heightMm: fmt(extent.h),
    safeMarginMm: fmt(extent.safeMarginMm),
    maxDepthMm: fmt(zone.constraints.maxDepthMm),
    minStrokeMm: fmt(zone.constraints.minStrokeMm),
    maxCoverage: fmt(zone.constraints.maxCoverage),
    wrapWarnDeg: fmt(zone.constraints.wrapWarnDeg),
    finishes: [...zone.constraints.finishes],
  };

  if (zone.type === 'planar' || zone.type === 'conformal') {
    form.originMm = triple(zone.frame.originMm);
    form.normal = triple(zone.frame.normal);
    form.tangent = triple(zone.frame.tangent);
    if (zone.type === 'conformal') form.maxProjectionDepthMm = fmt(zone.frame.maxProjectionDepthMm);
  }
  if (zone.type === 'cylindrical') {
    form.axisOriginMm = triple(zone.frame.axisOriginMm);
    form.axisDir = triple(zone.frame.axisDir);
    form.radiusMm = fmt(zone.frame.radiusMm);
    form.centerAngleDeg = fmt(zone.frame.centerAngleDeg);
    form.centerHeightMm = fmt(zone.frame.centerHeightMm);
  }
  return form;
}

export type FormResult =
  | { zone: DecorationZoneDef; problems: [] }
  | { zone: null; problems: string[] };

/**
 * The zone a form describes, or what is missing from it.
 *
 * Problems are worded for the person filling it in, field by field. The server validates again —
 * the whole pack, not just this zone — so this is about saying *which box* is wrong before a round
 * trip, not about being the last line.
 */
export function zoneFromForm(form: ZoneForm, key: string): FormResult {
  if (!isAuthorable(form.type))
    return { zone: null, problems: [`a ${form.type} zone is edited through its manifest`] };

  const problems: string[] = [];
  const num = (value: string, label: string, check?: (n: number) => string | null): number => {
    if (value.trim() === '') {
      problems.push(`${label} is empty`);
      return Number.NaN;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      problems.push(`${label} is not a number`);
      return Number.NaN;
    }
    const complaint = check?.(parsed);
    if (complaint) problems.push(`${label} ${complaint}`);
    return parsed;
  };
  const positive = (n: number) => (n > 0 ? null : 'must be more than 0');
  const vec = (values: Triple, label: string): Vec3 => [
    num(values[0], `${label} X`),
    num(values[1], `${label} Y`),
    num(values[2], `${label} Z`),
  ];
  const direction = (values: Triple, label: string): Vec3 => {
    const v = vec(values, label);
    if (v.every(Number.isFinite) && length(v) < 1e-9) problems.push(`${label} cannot be zero`);
    return v;
  };

  if (!form.name.trim()) problems.push('Name is empty');

  const sizeMm = {
    height: num(form.heightMm, 'Height', positive),
    safeMarginMm: num(form.safeMarginMm, 'Safe margin', (n) =>
      n >= 0 ? null : 'cannot be negative',
    ),
  };
  const width = num(form.widthMm, form.type === 'cylindrical' ? 'Arc width' : 'Width', positive);
  const constraints = {
    finishes: form.finishes,
    maxDepthMm: num(form.maxDepthMm, 'Max depth', positive),
    minStrokeMm: num(form.minStrokeMm, 'Min stroke', positive),
    maxCoverage: num(form.maxCoverage, 'Max coverage', (n) =>
      n >= 0 && n <= 1 ? null : 'must be between 0 and 1',
    ),
    wrapWarnDeg: num(form.wrapWarnDeg, 'Wrap warning', positive),
  };
  if (form.finishes.length === 0) problems.push('Pick at least one finish');

  let raw: Record<string, unknown>;
  if (form.type === 'cylindrical') {
    raw = {
      type: 'cylindrical',
      frame: {
        axisOriginMm: vec(form.axisOriginMm, 'Axis point'),
        axisDir: direction(form.axisDir, 'Axis direction'),
        radiusMm: num(form.radiusMm, 'Radius', positive),
        centerAngleDeg: num(form.centerAngleDeg, 'Centre angle'),
        centerHeightMm: num(form.centerHeightMm, 'Centre height'),
      },
      sizeMm: { arcWidthMm: width, ...sizeMm },
    };
  } else {
    const normal = direction(form.normal, 'Facing direction');
    const tangent = direction(form.tangent, 'Artwork direction');
    if (
      normal.every(Number.isFinite) &&
      tangent.every(Number.isFinite) &&
      length(normal) > 1e-9 &&
      length(tangent) > 1e-9
    ) {
      if (Math.abs(dot(normalize(normal), normalize(tangent))) > 0.999) {
        problems.push('Artwork direction cannot point the same way as the facing direction');
      }
    }
    const frame: Record<string, unknown> = {
      originMm: vec(form.originMm, 'Centre'),
      normal,
      tangent,
    };
    if (form.type === 'conformal')
      frame['maxProjectionDepthMm'] = num(form.maxProjectionDepthMm, 'Projection depth', positive);
    raw = { type: form.type, frame, sizeMm: { width, ...sizeMm } };
  }

  if (problems.length > 0) return { zone: null, problems };

  const parsed = DecorationZoneDef.safeParse({
    ...raw,
    key,
    name: form.name.trim(),
    constraints,
    ...(form.materialSlotKey ? { materialSlotKey: form.materialSlotKey } : {}),
  });
  if (!parsed.success) {
    return {
      zone: null,
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  return { zone: parsed.data, problems: [] };
}

/** The frame as the API takes it, for moving a zone that already exists. */
export const frameOf = (zone: DecorationZoneDef): unknown =>
  'frame' in zone ? zone.frame : undefined;

/**
 * Face the other way: the same spot, seen from the other side.
 *
 * Only the normal turns. The artwork's right stays where it was and its up follows the new normal
 * (`up = normal × tangent`), so from the side it now faces it reads correctly rather than mirrored.
 */
export function flipFacing(form: ZoneForm): ZoneForm {
  const normal = readVec(form.normal);
  if (!normal) return form;
  return { ...form, normal: triple(scale(normal, -1)) };
}

/** Turns the artwork a quarter-turn anticlockwise about the facing direction. */
export function rotateArtwork90(form: ZoneForm): ZoneForm {
  const normal = readVec(form.normal);
  const tangent = readVec(form.tangent);
  if (!normal || !tangent || length(normal) < 1e-9 || length(tangent) < 1e-9) return form;
  const n = normalize(normal);
  return { ...form, tangent: triple(cross(n, orthogonalize(tangent, n))) };
}

/**
 * Turns a band's artwork upside down without moving the band.
 *
 * Reversing the axis alone would move it: height is measured along the axis and angle from a
 * reference that depends on the axis, so both are re-expressed for the reversed axis to keep the
 * centre on the same point of the part. Up and right both reverse, which is a half-turn — not a
 * mirror.
 */
export function flipCylinderAxis(form: ZoneForm): ZoneForm {
  const axis = readVec(form.axisDir);
  const height = Number(form.centerHeightMm);
  const angle = Number(form.centerAngleDeg);
  if (!axis || length(axis) < 1e-9 || !Number.isFinite(height) || !Number.isFinite(angle))
    return form;

  const a = normalize(axis);
  const radial = radialAt(a, angle);
  const reversed = scale(a, -1);
  return {
    ...form,
    axisDir: triple(reversed),
    centerHeightMm: fmt(-height),
    centerAngleDeg: fmt(angleOf(reversed, radial)),
  };
}

/** Which way 0° points for a band around this axis, so the angle field means something. */
export function zeroAngleDirection(axisDir: Triple): Vec3 | null {
  const axis = readVec(axisDir);
  if (!axis || length(axis) < 1e-9) return null;
  return anyPerpendicular(axis);
}

export type PickResult = { form: ZoneForm; problem: null } | { form: null; problem: string };

/**
 * Places a zone at the point the author clicked on the part (F-ADM-14).
 *
 * A measurement, not a suggestion: the author chose the spot, and this only reads what is under the
 * cursor. A flat or curved face takes the point as its centre and the surface there as its facing
 * direction, keeping the artwork's direction as close to what it was as the new face allows. A band
 * takes the point's height, angle and distance from the axis the author already entered — the axis
 * is not something a click can tell apart from the surface, so it has to come first.
 */
export function applySurfacePick(form: ZoneForm, pointMm: Vec3, surfaceNormal: Vec3): PickResult {
  if (form.type === 'cylindrical') {
    const origin = readVec(form.axisOriginMm);
    const axis = readVec(form.axisDir);
    if (!origin || !axis || length(axis) < 1e-9) {
      return {
        form: null,
        problem: 'Enter the axis point and direction first, then click the side of the part',
      };
    }
    const a = normalize(axis);
    const offset = sub(pointMm, origin);
    const height = dot(offset, a);
    const radial = sub(offset, scale(a, height));
    const radius = length(radial);
    if (radius < 1e-6)
      return { form: null, problem: 'That point is on the axis; click the side of the part' };
    return {
      form: {
        ...form,
        radiusMm: fmt(radius),
        centerHeightMm: fmt(height),
        centerAngleDeg: fmt(angleOf(a, radial)),
      },
      problem: null,
    };
  }

  if (form.type !== 'planar' && form.type !== 'conformal') {
    return { form: null, problem: `a ${form.type} zone cannot be placed by clicking` };
  }
  if (length(surfaceNormal) < 1e-9)
    return { form: null, problem: 'The surface there has no direction; click nearby' };

  const n = normalize(surfaceNormal);
  const previous = readVec(form.tangent);
  const keepsDirection =
    previous && length(previous) > 1e-9 && Math.abs(dot(normalize(previous), n)) < 0.999;
  const tangent = keepsDirection ? orthogonalize(previous, n) : anyPerpendicular(n);
  return {
    form: { ...form, originMm: triple(pointMm), normal: triple(n), tangent: triple(tangent) },
    problem: null,
  };
}

/** A circle in space: centre, radius, and the unit normal of its plane. */
export interface Circle {
  centre: Vec3;
  radius: number;
  normal: Vec3;
}

/** The circle through three points, or null when they lie on a line and so on no circle. */
export function circleThrough(a: Vec3, b: Vec3, c: Vec3): Circle | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-12 * Math.max(1, dot(ab, ab) * dot(ac, ac))) return null;

  // The circumcentre, written in the triangle's own plane.
  const offset = scale(
    add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab))),
    1 / (2 * nn),
  );
  const centre = add(a, offset);
  return { centre, radius: length(offset), normal: normalize(n) };
}

/**
 * Places a zone from three points clicked on a round edge (F-ADM-14).
 *
 * The centre of a cap's top, or the axis of its skirt, is exactly what a person cannot click on —
 * it is in the middle of nothing — and the part's measured box is not a reliable guide to it. Three
 * points on the rim fix the circle, and the circle fixes both. This measures the author's clicks; it
 * does not look for circles itself. A flat or curved face takes the circle's centre and plane, facing
 * the way the surface under the clicks does; a band takes the circle as its axis and radius, keeping
 * the direction its axis already had so the artwork does not turn over.
 */
export function applyRimPick(
  form: ZoneForm,
  points: readonly [Vec3, Vec3, Vec3],
  surfaceNormal: Vec3,
): PickResult {
  const circle = circleThrough(points[0], points[1], points[2]);
  if (!circle) {
    return {
      form: null,
      problem:
        'Those three points are in a line, not on a circle — click three points spread around a round edge',
    };
  }

  if (form.type === 'cylindrical') {
    const previous = readVec(form.axisDir);
    const keepsDirection = previous && length(previous) > 1e-9 && dot(previous, circle.normal) < 0;
    return {
      form: {
        ...form,
        axisOriginMm: triple(circle.centre),
        axisDir: triple(keepsDirection ? scale(circle.normal, -1) : circle.normal),
        radiusMm: fmt(circle.radius),
      },
      problem: null,
    };
  }

  if (form.type !== 'planar' && form.type !== 'conformal') {
    return { form: null, problem: `a ${form.type} zone cannot be placed by clicking` };
  }
  const facing = dot(circle.normal, surfaceNormal) < 0 ? scale(circle.normal, -1) : circle.normal;
  const previous = readVec(form.tangent);
  const tangent =
    previous && length(previous) > 1e-9 && Math.abs(dot(normalize(previous), facing)) < 0.999
      ? orthogonalize(previous, facing)
      : anyPerpendicular(facing);
  return {
    form: {
      ...form,
      originMm: triple(circle.centre),
      normal: triple(facing),
      tangent: triple(tangent),
    },
    problem: null,
  };
}

/**
 * Where a zone will sit, as soon as that much is known — before it has a size.
 *
 * So a click on the part, or a centre typed in, shows up straight away rather than only once every
 * field is filled. Null until the position and the facing are both readable.
 */
export function placementMarker(form: ZoneForm): { point: Vec3; normal: Vec3 } | null {
  if (form.type === 'cylindrical') {
    const origin = readVec(form.axisOriginMm);
    const axis = readVec(form.axisDir);
    const radius = Number(form.radiusMm);
    const angle = Number(form.centerAngleDeg);
    const height = Number(form.centerHeightMm);
    if (!origin || !axis || length(axis) < 1e-9) return null;
    if ([form.radiusMm, form.centerAngleDeg, form.centerHeightMm].some((v) => v.trim() === ''))
      return null;
    if (![radius, angle, height].every(Number.isFinite) || radius <= 0) return null;
    const a = normalize(axis);
    const radial = radialAt(a, angle);
    return { point: add(origin, add(scale(a, height), scale(radial, radius))), normal: radial };
  }
  if (form.type !== 'planar' && form.type !== 'conformal') return null;
  const origin = readVec(form.originMm);
  const normal = readVec(form.normal);
  if (!origin || !normal || length(normal) < 1e-9) return null;
  return { point: origin, normal: normalize(normal) };
}

/**
 * Whether two forms say the same thing, so "unsaved changes" means a change and not a reformat.
 *
 * "30" and "30.0" are the same width; a name with a trailing space is the same name.
 */
export function formsMatch(a: ZoneForm, b: ZoneForm): boolean {
  const same = (x: string, y: string) => {
    const nx = Number(x);
    const ny = Number(y);
    if (x.trim() !== '' && y.trim() !== '' && Number.isFinite(nx) && Number.isFinite(ny))
      return Math.abs(nx - ny) < 1e-9;
    return x.trim() === y.trim();
  };
  for (const field of Object.keys(a) as (keyof ZoneForm)[]) {
    const x = a[field];
    const y = b[field];
    if (field === 'finishes') {
      if ([...(x as string[])].sort().join() !== [...(y as string[])].sort().join()) return false;
    } else if (Array.isArray(x)) {
      if (!(x as string[]).every((value, i) => same(value, (y as string[])[i] ?? ''))) return false;
    } else if (!same(x as string, y as string)) {
      return false;
    }
  }
  return true;
}

/** How far off the surface a point may be before it is worth telling the author, in mm. */
export const SURFACE_TOLERANCE_MM = 1;

/** Just what `surfaceReport` needs of a mesh index, so it can be tested on a surface drawn by hand. */
export interface SurfaceProbe {
  nearestSurface(p: Vec3, maxDistanceMm?: number): { position: Vec3; normal: Vec3 } | null;
}

export interface SurfaceReport {
  /** Centre to the nearest surface, or null when nothing is within reach. */
  centreMm: number | null;
  /** Corners more than `SURFACE_TOLERANCE_MM` from the part: a zone hanging off an edge. */
  cornersOff: number;
  unsupportedVertices?: number;
  surfaceVertices?: number;
  /** The zone faces into the part — an emboss there would press inwards. */
  facesInto: boolean;
}

/**
 * Where the zone the author entered sits against the actual part (F-ADM-13).
 *
 * A measurement, never a suggestion: it reports what is wrong with the numbers as typed and proposes
 * nothing in their place. The centre alone is not enough — a band can be centred on the skirt and
 * still run two millimetres past its end, and a face turned the wrong way sits exactly on the
 * surface — so the corners are measured too, and the zone's facing is compared with the surface's
 * own at the centre.
 */
export function surfaceReport(
  zone: DecorationZoneDef,
  probe: SurfaceProbe,
  reachMm = Infinity,
): SurfaceReport {
  const mapper = mapperFor(zone);
  const { w, h } = zoneExtentMm(zone);
  const measure = (point: Vec3) => {
    const surface = probe.nearestSurface(point, reachMm);
    return surface
      ? { distanceMm: length(sub(surface.position, point)), normal: surface.normal }
      : null;
  };

  const centre = mapper.toWorld({ x: 0, y: 0 });
  const atCentre = measure(centre.position);
  const corners = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((corner) => measure(mapper.toWorld(corner).position));

  // Only where the centre is actually on the surface: the nearest surface to a point in mid-air may
  // be any face of the part, and its normal says nothing about this zone.
  const onSurface = atCentre !== null && atCentre.distanceMm <= SURFACE_TOLERANCE_MM;
  const facesInto =
    onSurface &&
    length(atCentre.normal) > 1e-9 &&
    dot(normalize(atCentre.normal), normalize(centre.normal)) < -0.5;

  return {
    centreMm: atCentre?.distanceMm ?? null,
    cornersOff: corners.filter((corner) => !corner || corner.distanceMm > SURFACE_TOLERANCE_MM)
      .length,
    facesInto,
  };
}

/** The zone's centre on the part, in the part's millimetres. */
export const zoneCentreMm = (zone: DecorationZoneDef): Vec3 =>
  mapperFor(zone).toWorld({ x: 0, y: 0 }).position;

/**
 * The zone's boundary and its safe area as closed loops, for drawing on the part.
 *
 * Sampled along each edge rather than taken at the corners, so a band's outline follows the
 * cylinder instead of cutting across it. Lifted a hair off the surface along its own normal so it
 * does not flicker in and out of the mesh it lies on.
 */
export function zoneOutlinesMm(
  zone: DecorationZoneDef,
  perEdge = 24,
): { boundary: Vec3[]; safe: Vec3[] } {
  const mapper = mapperFor(zone);
  const { w, h, safeMarginMm } = zoneExtentMm(zone);
  const lift = 0.05;

  const loop = (halfW: number, halfH: number): Vec3[] => {
    const corners = [
      { x: -halfW, y: -halfH },
      { x: halfW, y: -halfH },
      { x: halfW, y: halfH },
      { x: -halfW, y: halfH },
    ];
    const points: Vec3[] = [];
    for (let edge = 0; edge < 4; edge++) {
      const from = corners[edge]!;
      const to = corners[(edge + 1) % 4]!;
      for (let step = 0; step < perEdge; step++) {
        const t = step / perEdge;
        const surface = mapper.toWorld({
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        });
        points.push(add(surface.position, scale(surface.normal, lift)));
      }
    }
    points.push(points[0]!);
    return points;
  };

  return {
    boundary: loop(w / 2, h / 2),
    safe: loop(Math.max(0, w / 2 - safeMarginMm), Math.max(0, h / 2 - safeMarginMm)),
  };
}

/** Reads a vector field; null while any component is empty or not a number. */
export function readVec(values: Triple): Vec3 | null {
  if (values.some((value) => value.trim() === '')) return null;
  const v = values.map(Number) as Vec3;
  return v.every(Number.isFinite) ? v : null;
}

/** Numbers as the form shows them: enough places to be exact at the scale of a moulded part. */
export function fmt(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

const triple = (v: Vec3): Triple => [fmt(v[0]), fmt(v[1]), fmt(v[2])];

/** The same reference `mapperFor` measures angles from, so a picked angle lands where it was picked. */
function radialAt(axis: Vec3, angleDeg: number): Vec3 {
  const u = anyPerpendicular(axis);
  const v = cross(axis, u);
  const theta = angleDeg * DEG2RAD;
  return add(scale(u, Math.cos(theta)), scale(v, Math.sin(theta)));
}

function angleOf(axis: Vec3, radial: Vec3): number {
  const u = anyPerpendicular(axis);
  const v = cross(axis, u);
  return Math.atan2(dot(radial, v), dot(radial, u)) * RAD2DEG;
}
