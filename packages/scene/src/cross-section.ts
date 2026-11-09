import type { DecorationZoneDef, Vec3 } from '@pr/design-schema';

/** The variant's extents, as the pack states them: `[min, max]` in the part's own millimetres. */
export type BboxMm = readonly [Vec3, Vec3];

/**
 * Where to cut a product, derived rather than picked (F-EDIT-11).
 *
 * A CAD program asks for a datum plane because it knows nothing about what you are doing. This one
 * knows a great deal: which way the part turns, where its decoration sits, how big it is. So the
 * cuts are named — "through the axis", "through the artwork" — and the geometry is worked out from
 * what the pack already declares. Nobody picks a plane.
 *
 * That is not only kinder; it is the whole reason the feature is worth having here. In packaging
 * almost every question a section answers is one of two: how thick is that wall, and how deep does
 * that mark really go. Both have a canonical plane, and both are one click.
 *
 * Deliberately pure and renderer-neutral. The viewport turns a `CrossSectionPlane` into a
 * `THREE.Plane`; when the cut reaches Cycles (`F-EDIT-13`) the same struct becomes a boolean, and
 * the two cannot disagree about where the cut is because only one of them decides.
 */

export interface CrossSectionPlane {
  key: string;
  label: string;
  /** A point the plane passes through, in the part's own millimetres. */
  originMm: Vec3;
  /** Unit normal. Material on the negative side is what gets removed. */
  normal: Vec3;
  /**
   * How far the plane may travel along its own normal before it leaves the part, in millimetres.
   *
   * The slider's range. Expressed as a distance from `originMm` rather than as absolute bounds so
   * the control reads the same on every cut: zero is always "through the middle".
   */
  travelMm: { min: number; max: number };
}

const EPS = 1e-6;

const centre = ([min, max]: BboxMm): Vec3 => [
  (min[0] + max[0]) / 2,
  (min[1] + max[1]) / 2,
  (min[2] + max[2]) / 2,
];
const extent = ([min, max]: BboxMm): Vec3 => [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < EPS) return [0, 1, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Which axis a direction is most nearly along, as a unit vector. Keeps the cuts axis-aligned. */
function dominant(v: Vec3): Vec3 {
  const abs = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  const index = abs.indexOf(Math.max(...abs));
  return index === 0 ? [1, 0, 0] : index === 1 ? [0, 1, 0] : [0, 0, 1];
}

/**
 * The axis the part turns about, or its natural upright when it turns about nothing.
 *
 * Three sources, most authoritative first. A cylindrical zone states an axis outright, and a pack
 * that has one has been authored by somebody who knew. Failing that, a body of revolution shows
 * itself in its own bounding box: two extents equal and one different is a cylinder, a jar or a
 * closure, and the odd one out is the axis. Failing *that* — an oval bottle, a carton — there is no
 * axis of revolution, and the tallest dimension is the upright everyone would call "up".
 *
 * The bounding-box test matters more than it looks. A squat closure is 38 mm across and 18 mm tall,
 * so "the longest dimension" would call its axis horizontal and cut it the wrong way; equality of
 * the other two is what actually identifies it.
 */
export function partAxis(bboxMm: BboxMm, zones: readonly DecorationZoneDef[] = []): Vec3 {
  for (const zone of zones) {
    if (zone.type === 'cylindrical') return dominant(normalise(zone.frame.axisDir));
  }

  const size = extent(bboxMm);
  const tolerance = Math.max(...size) * 0.01;
  const pairs: [number, number, number][] = [
    [0, 1, 2],
    [1, 0, 2],
    [2, 0, 1],
  ];
  for (const [axis, a, b] of pairs) {
    if (Math.abs(size[a]! - size[b]!) <= tolerance) {
      return axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1];
    }
  }

  const tallest = size.indexOf(Math.max(...size));
  return tallest === 0 ? [1, 0, 0] : tallest === 1 ? [0, 1, 0] : [0, 0, 1];
}

/** How far a plane with this normal can travel from the part's centre before it clears the part. */
function travelFor(bboxMm: BboxMm, normal: Vec3): { min: number; max: number } {
  const size = extent(bboxMm);
  // Axis-aligned normals only, which is all this module produces: the reach along the normal is
  // half that axis' extent. A little past it, so the last slice of material can be cleared.
  const reach =
    (Math.abs(normal[0]) * size[0]! + Math.abs(normal[1]) * size[1]! + Math.abs(normal[2]) * size[2]!) / 2;
  const rounded = Math.round(reach * 10) / 10;
  return { min: -rounded, max: rounded };
}

const perpendicularTo = (axis: Vec3): [Vec3, Vec3] =>
  Math.abs(axis[1]) > 0.5
    ? [
        [1, 0, 0],
        [0, 0, 1],
      ]
    : Math.abs(axis[0]) > 0.5
      ? [
          [0, 1, 0],
          [0, 0, 1],
        ]
      : [
          [1, 0, 0],
          [0, 1, 0],
        ];

export interface CrossSectionInput {
  bboxMm: BboxMm;
  zones: readonly DecorationZoneDef[];
  /** The zone the design decorates, so "through the artwork" cuts through the right one. */
  decoratedZoneKey?: string;
}

/**
 * Every cut offered for a variant, in the order they should be shown.
 *
 * Ordered by how often the answer is the one wanted rather than alphabetically or by axis: down the
 * axis first, because that is the section anybody asking about a closure means; then the artwork,
 * because that is the other question this product exists to answer; then the flat planes, for a
 * carton that has neither.
 */
export function crossSectionPlanes(input: CrossSectionInput): CrossSectionPlane[] {
  const axis = partAxis(input.bboxMm, input.zones);
  const mid = centre(input.bboxMm);
  const [first, second] = perpendicularTo(axis);
  const planes: CrossSectionPlane[] = [];
  const seen = new Set<string>();

  /**
   * Adds a cut, unless the same cut is already there.
   *
   * Deduped on the *plane*, not on the name. A centred logo on a cap top sits on the axis, so
   * "through the artwork" and "lengthways" are one plane wearing two labels — and offering both as
   * buttons that produce an identical picture is worse than offering one, because the second
   * teaches the user the controls do not mean anything. First label to claim a plane keeps it,
   * which is why the specific cuts are added before the generic ones.
   */
  const push = (key: string, label: string, rawNormal: Vec3, originMm: Vec3 = mid) => {
    const normal = normalise(rawNormal);
    const distance = normal[0] * originMm[0] + normal[1] * originMm[1] + normal[2] * originMm[2];
    const identity = `${normal.map((n) => Math.round(n * 1000) / 1000).join(',')}@${Math.round(distance * 100) / 100}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    planes.push({ key, label, originMm, normal, travelMm: travelFor(input.bboxMm, normal) });
  };

  // Most specific first, so a plane that is both gets the more informative name. The artwork is the
  // question this product exists to answer — how deep does that mark actually go — and on a closure
  // it usually coincides with the lengthways cut anyway.
  const decorated =
    input.zones.find((zone) => zone.key === input.decoratedZoneKey) ?? input.zones[0];
  if (decorated) {
    const throughArtwork = artworkPlane(decorated, axis);
    if (throughArtwork) {
      push('artwork', 'Through the artwork', throughArtwork.normal, throughArtwork.originMm);
    }
  }

  // Two, because a plane "through the axis" is one of infinitely many and the pair perpendicular to
  // each other is what a person means by "cut it lengthways". Which reads as front and which as
  // side depends on where the camera is, so they are named for the geometry instead.
  push('axis-a', 'Lengthways', first);
  push('axis-b', 'Lengthways, turned 90°', second);

  // The canonical three, for a carton or anything the rules above found nothing to say about.
  push('bbox-x', 'Across width', [1, 0, 0]);
  push('bbox-y', 'Across height', [0, 1, 0]);
  push('bbox-z', 'Across depth', [0, 0, 1]);

  return planes;
}

/**
 * A plane through a zone's centre, cutting *into* the surface the artwork sits on.
 *
 * The useful section through a mark is the one that shows its depth, which means the plane has to
 * contain the surface normal rather than lie along it — cutting *on* the surface would shave the
 * mark off and show nothing. So the plane's own normal is perpendicular to both the surface normal
 * and the part's axis, which for a logo on a cap top is a vertical slice straight through it.
 */
function artworkPlane(zone: DecorationZoneDef, axis: Vec3): { originMm: Vec3; normal: Vec3 } | null {
  if (zone.type === 'planar') {
    const along = normalise(zone.frame.tangent);
    // Tangent, not the cross product: the tangent is the direction the artwork reads along, and a
    // section across the reading direction is the one that shows every stroke's depth at once.
    return { originMm: zone.frame.originMm, normal: dominant(along) };
  }

  if (zone.type === 'cylindrical') {
    // Through the axis and through the middle of the zone's arc: the slice a moulder would cut to
    // see the wall under the mark.
    const angle = (zone.frame.centerAngleDeg * Math.PI) / 180;
    const [a, b] = perpendicularTo(dominant(normalise(zone.frame.axisDir)));
    const normal: Vec3 = [
      a[0] * Math.cos(angle) + b[0] * Math.sin(angle),
      a[1] * Math.cos(angle) + b[1] * Math.sin(angle),
      a[2] * Math.cos(angle) + b[2] * Math.sin(angle),
    ];
    return { originMm: zone.frame.axisOriginMm, normal: dominant(normal) };
  }

  if (zone.type === 'conformal') {
    return { originMm: zone.frame.originMm, normal: dominant(normalise(zone.frame.tangent)) };
  }

  // A flat panel is a carton face; the bbox planes below already cut it the way anybody would.
  void axis;
  return null;
}
