import type { ArtworkEndpoint, ArtworkRepair } from '@pr/design-schema';
import {
  applyMatrix,
  multiply,
  serializePathData,
  transformSegments,
  type Matrix,
  type Segment,
} from './path.js';
import { PreparationError, type PreparationObject } from './preparation-types.js';

export interface PreparationSubpath {
  id: string;
  segments: Segment[];
  closed: boolean;
  start: readonly [number, number];
  end: readonly [number, number];
}

export function preparationSubpaths(object: PreparationObject): PreparationSubpath[] {
  const paths: Segment[][] = [];
  for (const segment of object.segments) {
    if (segment.command === 'M') paths.push([]);
    paths.at(-1)?.push(segment);
  }
  return paths.map((segments, index) => {
    const first = segments[0]!;
    const last = [...segments].reverse().find((segment) => segment.command !== 'Z')!;
    const start = applyMatrix(object.matrix, first.values[0]!, first.values[1]!);
    const end = applyMatrix(object.matrix, last.values.at(-2)!, last.values.at(-1)!);
    return {
      id: object.subpathIds?.[index] ?? `${object.id}:s${index}`,
      segments,
      closed: segments.at(-1)?.command === 'Z',
      start,
      end,
    };
  });
}

function locate(
  objects: PreparationObject[],
  endpoint: Pick<ArtworkEndpoint, 'objectId' | 'subpathId'>,
) {
  const object = objects.find((item) => item.id === endpoint.objectId);
  const subpath =
    object && preparationSubpaths(object).find((item) => item.id === endpoint.subpathId);
  if (!object || !subpath)
    throw new PreparationError(
      'That path no longer exists. Undo dependent repairs or reopen the source.',
    );
  if (subpath.closed) throw new PreparationError('This outline is already closed.');
  return { object, subpath };
}

function replaceSubpath(object: PreparationObject, subpathId: string, segments: Segment[]) {
  const paths = preparationSubpaths(object)
    .map((path) => (path.id === subpathId ? { ...path, segments } : path))
    .filter((path) => path.segments.length > 0);
  object.segments = paths.flatMap((path) => path.segments);
  object.subpathIds = paths.map((path) => path.id);
  delete object.sourceShape;
}

function reverseOpen(segments: Segment[]): Segment[] {
  const starts: [number, number][] = [];
  let cursor: [number, number] = [0, 0];
  for (const segment of segments) {
    starts.push(cursor);
    cursor = [segment.values.at(-2)!, segment.values.at(-1)!];
  }
  const result: Segment[] = [{ command: 'M', values: cursor }];
  for (let i = segments.length - 1; i > 0; i--) {
    const segment = segments[i]!;
    const before = starts[i]!;
    result.push(
      segment.command === 'C'
        ? {
            command: 'C',
            values: [
              segment.values[2],
              segment.values[3],
              segment.values[0],
              segment.values[1],
              ...before,
            ],
          }
        : { command: 'L', values: before },
    );
  }
  return result;
}

function inverse(matrix: Matrix): Matrix {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 1e-12)
    throw new PreparationError('This transform has no usable area.');
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

export function uniformPreparationScale(object: PreparationObject): number | null {
  const { a, b, c, d } = object.matrix;
  const x = Math.hypot(a, b),
    y = Math.hypot(c, d);
  return x > 0 && Math.abs(x - y) < 1e-8 && Math.abs(a * c + b * d) < 1e-8 ? x : null;
}

export function compatiblePreparationJoin(a: PreparationObject, b: PreparationObject): boolean {
  const scaleA = uniformPreparationScale(a),
    scaleB = uniformPreparationScale(b);
  return (
    !a.fill &&
    !b.fill &&
    Boolean(a.stroke) &&
    a.stroke === b.stroke &&
    scaleA !== null &&
    scaleB !== null &&
    Math.abs(a.strokeWidth * scaleA - b.strokeWidth * scaleB) < 1e-8 &&
    a.linecap === b.linecap &&
    a.linejoin === b.linejoin &&
    a.miterLimit === b.miterLimit &&
    a.dashArray.length === 0 &&
    b.dashArray.length === 0 &&
    !a.clips.length &&
    !b.clips.length &&
    !a.hidden &&
    !b.hidden
  );
}

export function applyPreparationRepairs(
  source: PreparationObject[],
  repairs: ArtworkRepair[],
): PreparationObject[] {
  const objects = structuredClone(source);
  for (const repair of repairs) {
    if (repair.kind === 'stroke-width') {
      const object = objects.find((item) => item.id === repair.objectId);
      const scale = object && uniformPreparationScale(object);
      if (!object || !scale)
        throw new PreparationError('Stroke width repair needs an object with a uniform scale.');
      object.stroke = object.stroke ?? '#000000';
      object.strokeWidth = repair.widthMm / scale;
      continue;
    }
    if (repair.kind === 'close') {
      const { object, subpath } = locate(objects, repair);
      replaceSubpath(object, subpath.id, [...subpath.segments, { command: 'Z', values: [] }]);
      continue;
    }
    const a = locate(objects, repair.a),
      b = locate(objects, repair.b);
    if (a.subpath.id === b.subpath.id)
      throw new PreparationError('Use Close loop to connect the two ends of one outline.');
    if (!compatiblePreparationJoin(a.object, b.object))
      throw new PreparationError(
        'These strokes have incompatible widths, styles, dashes, or clipping. Repair them in the source editor.',
      );
    const first = repair.a.end === 'start' ? reverseOpen(a.subpath.segments) : a.subpath.segments;
    const second = repair.b.end === 'end' ? reverseOpen(b.subpath.segments) : b.subpath.segments;
    const mapped = transformSegments(second, multiply(inverse(a.object.matrix), b.object.matrix));
    const bridge: Segment = {
      command: 'L',
      values: [mapped[0]!.values[0]!, mapped[0]!.values[1]!],
    };
    replaceSubpath(a.object, a.subpath.id, [...first, bridge, ...mapped.slice(1)]);
    replaceSubpath(b.object, b.subpath.id, []);
  }
  return objects;
}

export function preparationGeometryKey(object: PreparationObject): string {
  return serializePathData(object.segments);
}
