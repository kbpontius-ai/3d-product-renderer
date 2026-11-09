import { PreparationError, type PreparationObject } from '@pr/svg';
import { ensureOrientation, type Point, type Polygon } from './flatten.js';

const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];

export function preparationDashes(
  points: Polygon,
  closed: boolean,
  pattern: number[],
  offset: number,
): { points: Polygon; closed: boolean }[] {
  if (!pattern.length || pattern.every((n) => n === 0)) return [{ points, closed }];
  const lengths = pattern.length % 2 ? [...pattern, ...pattern] : pattern;
  const period = lengths.reduce((sum, n) => sum + n, 0);
  let phase = ((offset % period) + period) % period;
  let index = 0;
  while (phase > 0 && phase >= lengths[index]!) {
    phase -= lengths[index]!;
    index = (index + 1) % lengths.length;
  }
  let remaining = lengths[index]! - phase;
  const fragments: Polygon[] = [];
  let current: Polygon = [];
  const line = closed && !same(points[0]!, points.at(-1)!) ? [...points, points[0]!] : points;
  const flush = () => {
    if (current.length) fragments.push(current);
    current = [];
  };
  const advance = (point: Point) => {
    let count = 0;
    while (remaining <= 1e-12) {
      if (index % 2 === 0 && lengths[index] === 0) fragments.push([point, point]);
      if (index % 2 === 0) flush();
      index = (index + 1) % lengths.length;
      remaining = lengths[index]!;
      if (++count > lengths.length) throw new PreparationError('Invalid dash pattern.');
    }
  };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!,
      b = line[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let position = 0;
    while (position < length - 1e-12) {
      const start: Point = [
        a[0] + ((b[0] - a[0]) * position) / length,
        a[1] + ((b[1] - a[1]) * position) / length,
      ];
      advance(start);
      const step = Math.min(remaining, length - position);
      const end: Point = [
        a[0] + ((b[0] - a[0]) * (position + step)) / length,
        a[1] + ((b[1] - a[1]) * (position + step)) / length,
      ];
      if (index % 2 === 0) {
        if (!current.length) current.push(start);
        current.push(end);
      }
      position += step;
      remaining -= step;
      if (remaining <= 1e-12) advance(end);
      if (fragments.length > 10_000)
        throw new PreparationError(
          'The dash pattern produces too many fragments. Increase its spacing or outline it in the source editor.',
        );
    }
  }
  flush();
  if (
    closed &&
    fragments.length > 1 &&
    same(fragments[0]![0]!, line[0]!) &&
    same(fragments.at(-1)!.at(-1)!, line[0]!)
  ) {
    const first = fragments.shift()!,
      last = fragments.pop()!;
    fragments.unshift([...last, ...first.slice(1)]);
  }
  return fragments.map((fragment) => ({
    points: fragment,
    closed: closed && fragment.length > 2 && same(fragment[0]!, fragment.at(-1)!),
  }));
}

export function preparationStroke(
  points: Polygon,
  closed: boolean,
  style: Pick<PreparationObject, 'strokeWidth' | 'linecap' | 'linejoin' | 'miterLimit'>,
  tolerance: number,
): Polygon[] {
  if (style.strokeWidth <= 0 || !points.length) return [];
  const radius = style.strokeWidth / 2;
  const line = points.filter((point, i) => i === 0 || !same(point, points[i - 1]!));
  if (closed && line.length > 1 && same(line[0]!, line.at(-1)!)) line.pop();
  const polygons: Polygon[] = [];
  const circle = (point: Point) => {
    const sides = Math.max(
      12,
      Math.ceil(Math.PI / Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)))),
    );
    if (sides > 20_000)
      throw new PreparationError(
        'This stroke cannot be resolved within the vector detail limit. Reduce its width or outline it in the source editor.',
      );
    polygons.push(
      Array.from({ length: sides }, (_item, i) => [
        point[0] + radius * Math.cos((i * 2 * Math.PI) / sides),
        point[1] + radius * Math.sin((i * 2 * Math.PI) / sides),
      ]),
    );
  };
  if (line.length === 1) {
    if (!closed && style.linecap === 'round') circle(line[0]!);
    if (!closed && style.linecap === 'square') {
      const [x, y] = line[0]!;
      polygons.push([
        [x - radius, y - radius],
        [x + radius, y - radius],
        [x + radius, y + radius],
        [x - radius, y + radius],
      ]);
    }
    return ensureOrientation(polygons);
  }
  const count = closed ? line.length : line.length - 1;
  const vectors: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = line[i]!,
      b = line[(i + 1) % line.length]!;
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.hypot(dx, dy);
    const v: Point = [dx / length, dy / length];
    vectors.push(v);
    const n: Point = [-v[1] * radius, v[0] * radius];
    const start = !closed && i === 0 && style.linecap === 'square' ? radius : 0;
    const end = !closed && i === count - 1 && style.linecap === 'square' ? radius : 0;
    polygons.push([
      [a[0] - v[0] * start + n[0], a[1] - v[1] * start + n[1]],
      [b[0] + v[0] * end + n[0], b[1] + v[1] * end + n[1]],
      [b[0] + v[0] * end - n[0], b[1] + v[1] * end - n[1]],
      [a[0] - v[0] * start - n[0], a[1] - v[1] * start - n[1]],
    ]);
  }
  for (let i = closed ? 0 : 1; i < (closed ? line.length : line.length - 1); i++) {
    const vertex = line[i]!,
      before = vectors[(i - 1 + count) % count]!,
      after = vectors[i % count]!;
    const turn = cross(before, after);
    if (Math.abs(turn) < 1e-12) {
      if (style.linejoin === 'round' && before[0] * after[0] + before[1] * after[1] < 0)
        circle(vertex);
      continue;
    }
    const side = turn > 0 ? -1 : 1;
    const p: Point = [vertex[0] - before[1] * radius * side, vertex[1] + before[0] * radius * side];
    const q: Point = [vertex[0] - after[1] * radius * side, vertex[1] + after[0] * radius * side];
    if (style.linejoin === 'round') {
      const start = Math.atan2(p[1] - vertex[1], p[0] - vertex[0]);
      const angle = Math.atan2(turn, before[0] * after[0] + before[1] * after[1]);
      const steps = Math.max(
        1,
        Math.ceil(
          Math.abs(angle) / (2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)))),
        ),
      );
      if (steps > 20_000)
        throw new PreparationError(
          'This join exceeds the vector detail limit. Outline it in the source editor.',
        );
      polygons.push([
        vertex,
        ...Array.from(
          { length: steps + 1 },
          (_item, step): Point => [
            vertex[0] + radius * Math.cos(start + (angle * step) / steps),
            vertex[1] + radius * Math.sin(start + (angle * step) / steps),
          ],
        ),
      ]);
      continue;
    }
    const distance = cross(subtract(q, p), after) / turn;
    const miter: Point = [p[0] + before[0] * distance, p[1] + before[1] * distance];
    polygons.push(
      style.linejoin === 'miter' &&
        Math.hypot(miter[0] - vertex[0], miter[1] - vertex[1]) <= style.miterLimit * radius
        ? [vertex, p, miter, q]
        : [vertex, p, q],
    );
  }
  if (!closed && style.linecap === 'round') {
    circle(line[0]!);
    circle(line.at(-1)!);
  }
  return ensureOrientation(polygons);
}
