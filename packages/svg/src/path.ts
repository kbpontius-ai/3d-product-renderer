/**
 * Path data: parse, normalise, transform, measure.
 *
 * Everything is reduced to absolute move/line/cubic/close segments at parse time. Arcs become
 * cubics and shorthand commands are expanded, which makes transforming a path a matter of
 * transforming its points — no special cases, and no way for a transform to silently distort an
 * arc's rotation.
 */

export type Segment =
  | { command: 'M'; values: [number, number] }
  | { command: 'L'; values: [number, number] }
  | { command: 'C'; values: [number, number, number, number, number, number] }
  | { command: 'Z'; values: [] };

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const multiply = (m: Matrix, n: Matrix): Matrix => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});

export const applyMatrix = (m: Matrix, x: number, y: number): [number, number] => [
  m.a * x + m.c * y + m.e,
  m.b * x + m.d * y + m.f,
];

/** Average scale factor of a matrix; used to convert stroke widths into user units. */
export const matrixScale = (m: Matrix): number =>
  Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || Math.hypot(m.a, m.b);

const TRANSFORM_RE = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export function parseNumbers(input: string): number[] {
  return (input.match(NUMBER_RE) ?? []).map(Number);
}

export function parseTransform(input: string | undefined): Matrix {
  if (!input) return IDENTITY;
  let result = IDENTITY;
  TRANSFORM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TRANSFORM_RE.exec(input)) !== null) {
    const args = parseNumbers(match[2] ?? '');
    const kind = match[1];
    const deg = Math.PI / 180;

    let step: Matrix = IDENTITY;
    if (kind === 'matrix' && args.length >= 6) {
      step = { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! };
    } else if (kind === 'translate') {
      step = { ...IDENTITY, e: args[0] ?? 0, f: args[1] ?? 0 };
    } else if (kind === 'scale') {
      const sx = args[0] ?? 1;
      step = { ...IDENTITY, a: sx, d: args[1] ?? sx };
    } else if (kind === 'rotate') {
      const angle = (args[0] ?? 0) * deg;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (args.length >= 3) {
        const [cx, cy] = [args[1]!, args[2]!];
        step = multiply(multiply({ ...IDENTITY, e: cx, f: cy }, rotation), {
          ...IDENTITY,
          e: -cx,
          f: -cy,
        });
      } else {
        step = rotation;
      }
    } else if (kind === 'skewX') {
      step = { ...IDENTITY, c: Math.tan((args[0] ?? 0) * deg) };
    } else if (kind === 'skewY') {
      step = { ...IDENTITY, b: Math.tan((args[0] ?? 0) * deg) };
    }

    result = multiply(result, step);
  }

  return result;
}

const COMMAND_RE = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;

export interface PathParseOptions {
  arcToleranceUnits?: number;
}

export function parsePathData(d: string, options: PathParseOptions = {}): Segment[] {
  const segments: Segment[] = [];
  let current: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let lastCubicControl: [number, number] | null = null;
  let lastQuadControl: [number, number] | null = null;

  COMMAND_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = COMMAND_RE.exec(d)) !== null) {
    const command = match[1]!;
    const args = parseNumbers(match[2] ?? '');
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    const consume = (count: number): number[][] => {
      if (count === 0) return [[]];
      const groups: number[][] = [];
      for (let i = 0; i + count <= args.length; i += count) groups.push(args.slice(i, i + count));
      return groups;
    };

    const rel = (x: number, y: number): [number, number] =>
      relative ? [current[0] + x, current[1] + y] : [x, y];

    switch (upper) {
      case 'M': {
        consume(2).forEach((group, i) => {
          const point = rel(group[0]!, group[1]!);
          // Extra coordinate pairs after a moveto are implicit linetos.
          segments.push({ command: i === 0 ? 'M' : 'L', values: point });
          current = point;
          if (i === 0) start = point;
        });
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'L': {
        for (const group of consume(2)) {
          const point = rel(group[0]!, group[1]!);
          segments.push({ command: 'L', values: point });
          current = point;
        }
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'H': {
        for (const group of consume(1)) {
          const x = relative ? current[0] + group[0]! : group[0]!;
          const point: [number, number] = [x, current[1]];
          segments.push({ command: 'L', values: point });
          current = point;
        }
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'V': {
        for (const group of consume(1)) {
          const y = relative ? current[1] + group[0]! : group[0]!;
          const point: [number, number] = [current[0], y];
          segments.push({ command: 'L', values: point });
          current = point;
        }
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'C': {
        for (const group of consume(6)) {
          const c1 = rel(group[0]!, group[1]!);
          const c2 = rel(group[2]!, group[3]!);
          const end = rel(group[4]!, group[5]!);
          segments.push({
            command: 'C',
            values: [...c1, ...c2, ...end] as Segment['values'] as never,
          });
          current = end;
          lastCubicControl = c2;
          lastQuadControl = null;
        }
        break;
      }

      case 'S': {
        for (const group of consume(4)) {
          const reflected: [number, number] = lastCubicControl
            ? [2 * current[0] - lastCubicControl[0], 2 * current[1] - lastCubicControl[1]]
            : [...current];
          const c2 = rel(group[0]!, group[1]!);
          const end = rel(group[2]!, group[3]!);
          segments.push({ command: 'C', values: [...reflected, ...c2, ...end] as never });
          current = end;
          lastCubicControl = c2;
          lastQuadControl = null;
        }
        break;
      }

      case 'Q': {
        for (const group of consume(4)) {
          const control = rel(group[0]!, group[1]!);
          const end = rel(group[2]!, group[3]!);
          segments.push(quadToCubic(current, control, end));
          current = end;
          lastQuadControl = control;
          lastCubicControl = null;
        }
        break;
      }

      case 'T': {
        for (const group of consume(2)) {
          const control: [number, number] = lastQuadControl
            ? [2 * current[0] - lastQuadControl[0], 2 * current[1] - lastQuadControl[1]]
            : [...current];
          const end = rel(group[0]!, group[1]!);
          segments.push(quadToCubic(current, control, end));
          current = end;
          lastQuadControl = control;
          lastCubicControl = null;
        }
        break;
      }

      case 'A': {
        for (const group of consume(7)) {
          const end = relative
            ? ([current[0] + group[5]!, current[1] + group[6]!] as [number, number])
            : ([group[5]!, group[6]!] as [number, number]);
          segments.push(
            ...arcToCubics(
              current,
              group[0]!,
              group[1]!,
              group[2]!,
              group[3]! !== 0,
              group[4]! !== 0,
              end,
              options.arcToleranceUnits,
            ),
          );
          current = end;
          lastCubicControl = lastQuadControl = null;
        }
        break;
      }

      case 'Z': {
        segments.push({ command: 'Z', values: [] });
        current = [...start];
        lastCubicControl = lastQuadControl = null;
        break;
      }
    }
  }

  return segments;
}

function quadToCubic(
  from: [number, number],
  control: [number, number],
  to: [number, number],
): Segment {
  const c1: [number, number] = [
    from[0] + (2 / 3) * (control[0] - from[0]),
    from[1] + (2 / 3) * (control[1] - from[1]),
  ];
  const c2: [number, number] = [
    to[0] + (2 / 3) * (control[0] - to[0]),
    to[1] + (2 / 3) * (control[1] - to[1]),
  ];
  return { command: 'C', values: [...c1, ...c2, ...to] as never };
}

/** Endpoint-parameterised arc to a chain of cubics (SVG implementation notes, F.6.5). */
export function arcToCubics(
  from: [number, number],
  rxInput: number,
  ryInput: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: [number, number],
  toleranceUnits?: number,
): Segment[] {
  let rx = Math.abs(rxInput);
  let ry = Math.abs(ryInput);
  if (rx === 0 || ry === 0) return [{ command: 'L', values: to }];
  if (from[0] === to[0] && from[1] === to[1]) return [];

  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Scale the radii up if they are too small to span the endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p);
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = sign * Math.sqrt(denominator === 0 ? 0 : numerator / denominator);

  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (from[0] + to[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from[1] + to[1]) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const value = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    return ux * vy - uy * vx < 0 ? -value : value;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  // The chord and tangent controls bound the cubic in a sagitta-wide annulus; resolving that
  // bound before the affine transform avoids a radius-dependent error in enlarged artwork.
  const maximumStep =
    toleranceUnits === undefined
      ? Math.PI / 2
      : Math.min(
          Math.PI / 2,
          2 * Math.acos(Math.max(-1, Math.min(1, 1 - toleranceUnits / Math.max(rx, ry)))),
        );
  const count = Math.max(1, Math.ceil(Math.abs(delta) / maximumStep));
  if (!Number.isFinite(count) || count > 20_000)
    throw new Error('Arc conversion exceeds the detail limit.');
  const step = delta / count;
  const alpha = (4 / 3) * Math.tan(step / 4);

  const segments: Segment[] = [];
  let theta = theta1;
  let point = from;

  for (let i = 0; i < count; i++) {
    const next = theta + step;
    const [cosT, sinT] = [Math.cos(theta), Math.sin(theta)];
    const [cosN, sinN] = [Math.cos(next), Math.sin(next)];

    const onEllipse = (t: number, u: number): [number, number] => [
      cx + cosPhi * rx * t - sinPhi * ry * u,
      cy + sinPhi * rx * t + cosPhi * ry * u,
    ];
    const derivative = (t: number, u: number): [number, number] => [
      cosPhi * rx * -u - sinPhi * ry * t,
      sinPhi * rx * -u + cosPhi * ry * t,
    ];

    const end = onEllipse(cosN, sinN);
    const d1 = derivative(cosT, sinT);
    const d2 = derivative(cosN, sinN);

    segments.push({
      command: 'C',
      values: [
        point[0] + alpha * d1[0],
        point[1] + alpha * d1[1],
        end[0] - alpha * d2[0],
        end[1] - alpha * d2[1],
        end[0],
        end[1],
      ] as never,
    });

    theta = next;
    point = end;
  }

  return segments;
}

export function transformSegments(segments: Segment[], matrix: Matrix): Segment[] {
  return segments.map((segment) => {
    if (segment.command === 'Z') return segment;
    const values: number[] = [];
    for (let i = 0; i < segment.values.length; i += 2) {
      const [x, y] = applyMatrix(matrix, segment.values[i]!, segment.values[i + 1]!);
      values.push(x, y);
    }
    return { command: segment.command, values } as Segment;
  });
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tight bounding box: cubic extremes are solved, not sampled. */
export function pathBBox(segments: Segment[]): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let current: [number, number] | null = null;
  let start: [number, number] | null = null;

  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const segment of segments) {
    if (segment.command === 'M' || segment.command === 'L') {
      current = [segment.values[0]!, segment.values[1]!];
      if (segment.command === 'M') start = current;
      include(current[0], current[1]);
    } else if (segment.command === 'C' && current) {
      const [x1, y1, x2, y2, x, y] = segment.values;
      include(x, y);
      for (const t of cubicExtremeParameters(current[0], x1, x2, x)) {
        include(cubicAt(current[0], x1, x2, x, t), cubicAt(current[1], y1, y2, y, t));
      }
      for (const t of cubicExtremeParameters(current[1], y1, y2, y)) {
        include(cubicAt(current[0], x1, x2, x, t), cubicAt(current[1], y1, y2, y, t));
      }
      current = [x, y];
    } else if (segment.command === 'Z' && start) {
      current = [...start];
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};

/** Parameters where a cubic's derivative vanishes, clamped to the curve's own domain. */
function cubicExtremeParameters(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;

  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrt = Math.sqrt(discriminant);
      roots.push((-b + sqrt) / (2 * a), (-b - sqrt) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

export function serializePathData(segments: Segment[], precision = 4): string {
  const round = (n: number) => Number(n.toFixed(precision));
  return segments
    .map((segment) =>
      segment.command === 'Z' ? 'Z' : `${segment.command}${segment.values.map(round).join(' ')}`,
    )
    .join(' ');
}

export const countNodes = (segments: Segment[]): number =>
  segments.filter((s) => s.command !== 'Z').length;

/** True when every subpath is explicitly closed — open paths cannot be filled predictably. */
export function isClosed(segments: Segment[]): boolean {
  let open = false;
  for (const segment of segments) {
    if (segment.command === 'M') {
      if (open) return false;
      open = true;
    } else if (segment.command === 'Z') {
      open = false;
    }
  }
  return !open;
}
