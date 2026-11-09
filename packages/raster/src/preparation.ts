import Clipper from 'clipper-lib';
import {
  canonicalArtworkPreparationRecipe,
  type ArtworkPreparationRecipe,
} from '@pr/design-schema';
import {
  applyMatrix,
  applyPreparationRepairs,
  normalizeSvg,
  prepareArtwork,
  preparationSourceSvg,
  preparationSubpaths,
  sanitizeSvg,
  PreparationError,
  type ArtworkAnalysis,
  type BBox,
  type Matrix,
  type PreparationClip,
  type PreparationObject,
  type PreparationPreview,
} from '@pr/svg';
import { precisePreparationSegments, preparationMaximumScale } from '@pr/svg';
import { flattenSegments, polygonBounds, type Polygon } from './flatten.js';
import { transformArtworkSvg } from './edit.js';
import { preparationDashes, preparationStroke } from './preparation-stroke.js';

export const PREPARATION_TOLERANCE_MM = 0.001;
export const PREPARATION_GRID_MM = 0.00001;
const MAX_POINTS = 50_000;
// About four seconds of Clipper work on a developer laptop; the heaviest fixture needs 80,000.
const MAX_CLIPPER_STEPS = 200_000;
// The upstream browser error handler calls alert and continues; preparation must fail atomically.
(Clipper as typeof Clipper & { Error: (message: string) => never }).Error = (message) => {
  throw new PreparationError(`Vector compilation failed: ${message}. Simplify the source drawing.`);
};

const maximumScale = preparationMaximumScale;

/*
 * The geometry budget counts work rather than time. A clock made the same drawing pass on an idle
 * machine and fail on a busy one, and it could only be read between Clipper calls, so a runaway call
 * had already finished by the time it was noticed. The two methods below are where Clipper's
 * StrictlySimple clean-up spends its time; counting them is repeatable, and throwing from them stops
 * the call while it is still running.
 */
let clipperStep: (() => void) | undefined;
const clipperInternals = Clipper.Clipper.prototype as unknown as Record<
  'PointInPolygon' | 'UpdateOutPtIdxs',
  (...args: unknown[]) => unknown
>;
for (const method of ['PointInPolygon', 'UpdateOutPtIdxs'] as const) {
  const original = clipperInternals[method];
  clipperInternals[method] = function (this: unknown, ...args: unknown[]) {
    clipperStep?.();
    return original.apply(this, args);
  };
}

function geometryBudget() {
  let points = 0;
  let steps = 0;
  const exceeded = () =>
    new PreparationError(
      'The vector result exceeds the detail or processing limit. Simplify the drawing and retry.',
    );
  const check = (paths: Clipper.Paths = [], accumulate = false) => {
    const count = paths.reduce((sum, path) => sum + path.length, 0);
    if (accumulate) points += count;
    if (count > MAX_POINTS || points > MAX_POINTS) throw exceeded();
  };
  return Object.assign(check, {
    step() {
      if (++steps > MAX_CLIPPER_STEPS) throw exceeded();
    },
  });
}

function boundedIntersections(paths: Clipper.Paths) {
  const edges = paths
    .flatMap((path) =>
      path.map((point, index) => {
        const next = path[(index + 1) % path.length]!;
        return {
          left: Math.min(point.X, next.X),
          right: Math.max(point.X, next.X),
          top: Math.min(point.Y, next.Y),
          bottom: Math.max(point.Y, next.Y),
        };
      }),
    )
    .sort((a, b) => a.left - b.left);
  let active: typeof edges = [],
    comparisons = 0,
    candidates = 0;
  for (const edge of edges) {
    active = active.filter((other) => other.right >= edge.left);
    for (const other of active) {
      if (
        ++comparisons > 1_000_000 ||
        (other.top <= edge.bottom && other.bottom >= edge.top && ++candidates > 50_000)
      )
        throw new PreparationError(
          'Too many potentially intersecting edges. Simplify overlapping or self-intersecting geometry in the source editor.',
        );
    }
    active.push(edge);
  }
}

function integers(polygons: Polygon[], scale: number): Clipper.Paths {
  return polygons
    .map((polygon) =>
      polygon
        .map(([x, y]) => {
          if (![x, y].every((n) => Number.isFinite(n) && Math.abs(n) <= 10_000))
            throw new PreparationError(
              'Resolved geometry exceeds the supported coordinate bounds. Re-export a bounded drawing.',
            );
          if (Math.max(Math.abs(x), Math.abs(y)) * scale > 1e14)
            throw new PreparationError(
              'This enlargement exceeds the supported vector precision. Use a larger source drawing.',
            );
          return { X: Math.round(x * scale), Y: Math.round(y * scale) };
        })
        .filter(
          (point, index, path) =>
            index === 0 || point.X !== path[index - 1]!.X || point.Y !== path[index - 1]!.Y,
        ),
    )
    .map((path) =>
      path.length > 1 && path[0]!.X === path.at(-1)!.X && path[0]!.Y === path.at(-1)!.Y
        ? path.slice(0, -1)
        : path,
    )
    .filter((path) => path.length >= 3);
}

function booleanRegion(
  subject: Clipper.Paths,
  clip: Clipper.Paths,
  kind: Clipper.ClipType,
  check: ReturnType<typeof geometryBudget>,
  rule: 'nonzero' | 'evenodd' = 'nonzero',
): Clipper.Paths {
  check([...subject, ...clip]);
  if (!subject.length && kind !== Clipper.ClipType.ctUnion) return [];
  if (!clip.length && kind === Clipper.ClipType.ctIntersection) return [];
  boundedIntersections([...subject, ...clip]);
  const engine = new Clipper.Clipper();
  engine.StrictlySimple = true;
  engine.AddPaths(subject, Clipper.PolyType.ptSubject, true);
  engine.AddPaths(clip, Clipper.PolyType.ptClip, true);
  const output: Clipper.Paths = [];
  const fill =
    rule === 'evenodd' ? Clipper.PolyFillType.pftEvenOdd : Clipper.PolyFillType.pftNonZero;
  clipperStep = check.step;
  try {
    if (!engine.Execute(kind, output, fill, Clipper.PolyFillType.pftNonZero))
      throw new PreparationError(
        'This geometry could not be compiled reliably. Re-export outlined vectors.',
      );
  } finally {
    clipperStep = undefined;
  }
  check(output);
  return output;
}

function flatten(
  segments: PreparationObject['segments'],
  matrix: Matrix,
  tolerance: number,
): Polygon[] {
  try {
    return flattenSegments(segments, {
      matrix,
      toleranceUnits: tolerance,
      maxPoints: MAX_POINTS,
      strictTolerance: true,
    });
  } catch {
    throw new PreparationError(
      'A curve exceeds the vector tolerance or point limit. Simplify the drawing in the source editor.',
    );
  }
}

function clipRegion(
  clip: PreparationClip[],
  tolerance: number,
  check: ReturnType<typeof geometryBudget>,
  scale: number,
): Clipper.Paths {
  let result: Clipper.Paths = [];
  for (const shape of clip) {
    const region = booleanRegion(
      integers(
        flatten(precisePreparationSegments(shape, tolerance), shape.matrix, tolerance),
        scale,
      ),
      [],
      Clipper.ClipType.ctUnion,
      check,
      shape.fillRule,
    );
    result = booleanRegion(result, region, Clipper.ClipType.ctUnion, check);
  }
  return result;
}

function paintRegions(
  object: PreparationObject,
  tolerance: number,
  check: ReturnType<typeof geometryBudget>,
  scale: number,
): { fill: Clipper.Paths; stroke: Clipper.Paths } {
  if (object.hidden || !object.segments.length || maximumScale(object.matrix) === 0)
    return { fill: [], stroke: [] };
  const paths = preparationSubpaths(object);
  let fill = object.fill
    ? booleanRegion(
        integers(flatten(object.segments, object.matrix, tolerance), scale),
        [],
        Clipper.ClipType.ctUnion,
        check,
        object.fillRule,
      )
    : [];
  let stroke: Clipper.Paths = [];
  if (object.stroke && object.strokeWidth > 0) {
    const localTolerance = tolerance / maximumScale(object.matrix);
    const polygons: Polygon[] = [];
    for (const path of paths) {
      const points = flatten(
        path.segments,
        { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        localTolerance,
      )[0];
      if (!points) continue;
      for (const fragment of preparationDashes(
        points,
        path.closed,
        object.dashArray,
        object.dashOffset,
      )) {
        polygons.push(
          ...preparationStroke(fragment.points, fragment.closed, object, localTolerance).map(
            (polygon) => polygon.map(([x, y]) => applyMatrix(object.matrix, x, y)),
          ),
        );
        if (polygons.reduce((sum, polygon) => sum + polygon.length, 0) > MAX_POINTS)
          throw new PreparationError(
            'Stroke expansion exceeds the vector detail limit. Outline or simplify the strokes.',
          );
      }
    }
    stroke = booleanRegion(integers(polygons, scale), [], Clipper.ClipType.ctUnion, check);
  }
  for (const clip of object.clips) {
    const region = clipRegion(clip, tolerance, check, scale);
    fill = booleanRegion(fill, region, Clipper.ClipType.ctIntersection, check);
    stroke = booleanRegion(stroke, region, Clipper.ClipType.ctIntersection, check);
  }
  check([...fill, ...stroke], true);
  return { fill, stroke };
}

function compile(
  analysis: ArtworkAnalysis,
  objects: PreparationObject[],
  recipe: ArtworkPreparationRecipe,
  tolerance: number,
): Polygon[] {
  const check = geometryBudget();
  const scale = 1 / Math.min(PREPARATION_GRID_MM, tolerance / 100);
  const selected = new Map(recipe.selected.map((item) => [item.objectId, item.paint]));
  const { w, h } = analysis.viewBox;
  const viewport = integers(
    [
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
    ],
    scale,
  );
  let output: Clipper.Paths = [];
  for (const object of objects) {
    const regions = paintRegions(object, tolerance, check, scale);
    const choice = selected.get(object.id);
    for (const paint of ['fill', 'stroke'] as const) {
      const region = booleanRegion(
        regions[paint],
        viewport,
        Clipper.ClipType.ctIntersection,
        check,
      );
      if (!region.length) continue;
      if (output.length)
        output = booleanRegion(output, region, Clipper.ClipType.ctDifference, check);
      if (choice && (choice === 'both' || choice === paint))
        output = booleanRegion(output, region, Clipper.ClipType.ctUnion, check);
    }
  }
  return output.map((path) => path.map((point) => [point.X / scale, point.Y / scale] as const));
}

function repairObjects(
  analysis: ArtworkAnalysis,
  recipe: ArtworkPreparationRecipe,
  tolerance: number,
  activeOnly: boolean,
): PreparationObject[] {
  const selected = new Set(recipe.selected.map((item) => item.objectId));
  const objects = analysis.objects.map((object) => ({
    ...object,
    segments: precisePreparationSegments(object, tolerance),
  }));
  return applyPreparationRepairs(
    objects,
    activeOnly
      ? recipe.repairs.filter((repair) =>
          repair.kind === 'join'
            ? selected.has(repair.a.objectId) && selected.has(repair.b.objectId)
            : selected.has(repair.objectId),
        )
      : recipe.repairs,
  );
}

function canonicalSvg(polygons: Polygon[], bounds: BBox): string {
  const number = (n: number): string => Number(n.toPrecision(15)).toString();
  const d = polygons
    .map(
      (path) =>
        path
          .map(([x, y], i) => `${i ? 'L' : 'M'}${number(x - bounds.x)} ${number(y - bounds.y)}`)
          .join(' ') + ' Z',
    )
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(bounds.w)}mm" height="${number(bounds.h)}mm" viewBox="0 0 ${number(bounds.w)} ${number(bounds.h)}"><path fill="#000000" fill-rule="nonzero" d="${d}"/></svg>`;
}

function issueFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

function repairPaintChanges(before: Polygon[], after: Polygon[], tolerance: number) {
  const scale = 1 / Math.min(PREPARATION_GRID_MM, tolerance / 100);
  const check = geometryBudget();
  const oldPaths = integers(before, scale),
    newPaths = integers(after, scale);
  const removed = booleanRegion(oldPaths, newPaths, Clipper.ClipType.ctDifference, check);
  const added = booleanRegion(newPaths, oldPaths, Clipper.ClipType.ctDifference, check);
  if (!removed.length && !added.length) return null;
  const oldCounters = oldPaths.filter((path) => Clipper.Clipper.Area(path) < 0);
  const newCounters = newPaths.filter((path) => Clipper.Clipper.Area(path) < 0);
  const oldCounterArea = booleanRegion(oldCounters, oldPaths, Clipper.ClipType.ctDifference, check);
  const newCounterArea = booleanRegion(newCounters, newPaths, Clipper.ClipType.ctDifference, check);
  const changedCounters =
    booleanRegion(oldCounterArea, newCounterArea, Clipper.ClipType.ctDifference, check).length >
      0 ||
    booleanRegion(newCounterArea, oldCounterArea, Clipper.ClipType.ctDifference, check).length > 0;
  const bounds = polygonBounds([...before, ...after]);
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;
  const paths = (region: Clipper.Paths) =>
    canonicalSvg(
      region.map((path) => path.map((point) => [point.X / scale, point.Y / scale] as const)),
      bounds,
    )
      .replace(/^.*?<path/, '<path')
      .replace(/<\/svg>$/, '');
  const number = (n: number) => Number(n.toPrecision(15)).toString();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(bounds.w)} ${number(bounds.h)}">${paths(oldPaths).replace('fill="#000000"', 'fill="#d6d6d6"')}${paths(removed).replace('fill="#000000"', 'fill="#ba3048"')}${paths(added).replace('fill="#000000"', 'fill="#127b70"')}</svg>`;
  return {
    svg,
    countersBefore: oldCounters.length,
    countersAfter: newCounters.length,
    changedCounters,
  };
}

export function previewArtworkPreparation(
  analysis: ArtworkAnalysis,
  input: ArtworkPreparationRecipe,
): PreparationPreview {
  const recipe = canonicalArtworkPreparationRecipe(input);
  if (
    recipe.sourceDigest !== analysis.sourceDigest ||
    recipe.analyzerVersion !== analysis.analyzerVersion
  )
    throw new PreparationError(
      'This selection belongs to a different source or analyzer. Reopen the original file.',
    );
  const selected = new Set(recipe.selected.map((item) => item.objectId));
  if (
    recipe.selected.some((item) => !analysis.objects.some((object) => object.id === item.objectId))
  )
    throw new PreparationError(
      'The selection contains an unknown object. Reopen the original file.',
    );
  const issues = [...analysis.issues];
  for (const repair of recipe.repairs)
    if (repair.kind === 'join') {
      if (selected.has(repair.a.objectId) !== selected.has(repair.b.objectId))
        throw new PreparationError(
          'Joined outlines must be kept or excluded together. Undo the join to select them separately.',
        );
      const a = analysis.objects.findIndex((object) => object.id === repair.a.objectId),
        b = analysis.objects.findIndex((object) => object.id === repair.b.objectId);
      if (a !== b && Math.abs(a - b) !== 1)
        throw new PreparationError(
          'These outlines have intervening paint layers. Join them in the source editor to preserve their appearance.',
        );
    }
  const objects = repairObjects(analysis, recipe, PREPARATION_TOLERANCE_MM, false);
  const active = repairObjects(analysis, recipe, PREPARATION_TOLERANCE_MM, true);
  const sourceSvg = preparationSourceSvg(analysis, active);
  const fingerprint = issueFingerprint(
    JSON.stringify({ ...recipe, acknowledged: [], transforms: [] }),
  );
  for (const repair of recipe.repairs) {
    if (repair.kind !== 'close' || !selected.has(repair.objectId)) continue;
    const object = active.find((item) => item.id === repair.objectId);
    const path = object && preparationSubpaths(object).find((item) => item.id === repair.subpathId);
    if (!object || !path) continue;
    const line = flatten(
      path.segments.filter((segment) => segment.command !== 'Z'),
      object.matrix,
      PREPARATION_TOLERANCE_MM,
    )[0];
    if (!line || line.length < 4) continue;
    const first = line[0]!,
      last = line.at(-1)!;
    const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
      (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
    const crosses = line.slice(1, -2).some((point, index) => {
      const next = line[index + 2]!;
      if (
        Math.max(first[0], last[0]) < Math.min(point[0], next[0]) ||
        Math.min(first[0], last[0]) > Math.max(point[0], next[0]) ||
        Math.max(first[1], last[1]) < Math.min(point[1], next[1]) ||
        Math.min(first[1], last[1]) > Math.max(point[1], next[1])
      )
        return false;
      return (
        cross(first, last, point) * cross(first, last, next) <= 0 &&
        cross(point, next, first) * cross(point, next, last) <= 0
      );
    });
    if (crosses)
      issues.push({
        id: `${repair.subpathId}-crossing-${fingerprint}`,
        code: 'repair_crossing',
        severity: 'review',
        objectId: object.id,
        subpathId: path.id,
        message:
          'This straight closure crosses or touches another segment of its outline. Inspect the painted result and keep this appearance, or undo the repair.',
      });
  }
  for (const object of active) {
    const choice = recipe.selected.find((item) => item.objectId === object.id)?.paint;
    if (!choice) continue;
    if (object.hidden)
      issues.push({
        id: `${object.id}-hidden`,
        code: 'hidden',
        severity: 'info',
        objectId: object.id,
        message:
          'This object is hidden in the source and contributes no visible paint. Exclude it or edit the source.',
      });
    if (object.fill && choice !== 'stroke')
      for (const path of preparationSubpaths(object)) {
        if (!path.closed && path.segments.length > 2)
          issues.push({
            id: `${path.id}-implicit-${fingerprint}`,
            code: 'implicit_fill',
            severity: 'review',
            objectId: object.id,
            subpathId: path.id,
            message:
              'This open outline already fills across a straight implicit edge. Keep this appearance, exclude it, or explicitly enter Repair paths.',
          });
      }
  }
  let polygons: Polygon[],
    boundsMm: BBox | null,
    keptBoundsMm: BBox | null = null,
    svg: string | null = null;
  let repairChanges: PreparationPreview['repairChanges'];
  let comparisonTolerance = PREPARATION_TOLERANCE_MM;
  try {
    polygons = compile(analysis, active, recipe, PREPARATION_TOLERANCE_MM);
    boundsMm = polygonBounds(polygons);
    if (boundsMm && boundsMm.w > 0 && boundsMm.h > 0) {
      let scale = 1;
      let size = boundsMm;
      for (const transform of recipe.transforms) {
        scale *= Math.max(transform.widthMm / size.w, transform.heightMm / size.h);
        const angle = (transform.rotationDeg * Math.PI) / 180;
        size = {
          x: 0,
          y: 0,
          w:
            Math.abs(transform.widthMm * Math.cos(angle)) +
            Math.abs(transform.heightMm * Math.sin(angle)),
          h:
            Math.abs(transform.widthMm * Math.sin(angle)) +
            Math.abs(transform.heightMm * Math.cos(angle)),
        };
      }
      if (scale > 1.01) {
        const tolerance = PREPARATION_TOLERANCE_MM / scale;
        comparisonTolerance = tolerance;
        polygons = compile(
          analysis,
          repairObjects(analysis, recipe, tolerance, true),
          recipe,
          tolerance,
        );
        boundsMm = polygonBounds(polygons);
      }
      if (boundsMm) {
        if (recipe.repairs.length) {
          const prior = { ...recipe, repairs: recipe.repairs.slice(0, -1) };
          const before = compile(
            analysis,
            repairObjects(analysis, prior, comparisonTolerance, true),
            prior,
            comparisonTolerance,
          );
          const changes = repairPaintChanges(before, polygons, comparisonTolerance);
          if (changes) {
            repairChanges = {
              svg: changes.svg,
              countersBefore: changes.countersBefore,
              countersAfter: changes.countersAfter,
            };
            if (changes.changedCounters)
              issues.push({
                id: `repair-counters-${fingerprint}`,
                code: 'repair_counters',
                severity: 'review',
                message: `This repair changes transparent counters (${changes.countersBefore} before, ${changes.countersAfter} after). Inspect the highlighted paint changes and keep this appearance, or undo the repair.`,
              });
          }
        }
        keptBoundsMm = boundsMm;
        svg = canonicalSvg(polygons, boundsMm);
        for (const transform of recipe.transforms)
          svg = transformArtworkSvg(normalizeSvg(sanitizeSvg(svg).root), transform, 12);
        const prepared = prepareArtwork(svg);
        if (prepared.status === 'rejected')
          for (const error of prepared.report.errors)
            issues.push({
              id: error.code,
              severity: 'error',
              code: error.code,
              message: [error.message, error.hint].filter(Boolean).join(' '),
            });
        if (prepared.artwork) boundsMm = prepared.artwork.contentBBox;
      }
    } else {
      boundsMm = null;
      issues.push({
        id: 'empty-result',
        code: 'empty_result',
        severity: 'error',
        message:
          'No visible area is kept. Select visible fill or a usable stroke, exclude hidden objects, or enter Repair paths to set a stroke width.',
      });
    }
  } catch (error) {
    boundsMm = null;
    issues.push({
      id: 'compilation',
      code: 'compilation_failed',
      severity: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'Preparation failed. Retry or re-export a simpler drawing.',
    });
  }
  return {
    svg,
    sourceSvg,
    objects,
    issues,
    boundsMm,
    keptBoundsMm,
    ...(repairChanges ? { repairChanges } : {}),
    recipe,
    canSave:
      Boolean(svg) &&
      !issues.some(
        (issue) =>
          issue.severity === 'error' ||
          (issue.severity === 'review' && !recipe.acknowledged.includes(issue.id)),
      ),
  };
}
