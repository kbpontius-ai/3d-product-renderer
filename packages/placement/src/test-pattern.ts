/**
 * The zone test pattern (F-ADM-02).
 *
 * Authoring a zone means claiming that a rectangle of millimetres on an unrolled surface maps to a
 * particular patch of a mesh, the right way up and the right way round. Nothing checks that claim
 * but eyes, so this generates something whose every symmetry is broken: an arrow that can only
 * point up, four corner marks that are four different shapes, and a grid whose squares reveal
 * stretch the moment the mapping is wrong.
 *
 * It is deliberately an SVG, so it goes through the same sanitiser, rasteriser and distance field
 * as a customer's logo — the QA path is the product path, and a pattern that needed its own
 * pipeline would prove things about that pipeline instead.
 *
 * No `<text>`: the artwork pipeline turns text into paths or rejects it, and a QA asset should not
 * be the thing that trips over that policy. The corner marks carry the orientation instead.
 */

export interface TestPatternOptions {
  widthMm: number;
  heightMm: number;
  /** Grid pitch. 5 mm on a small zone, 10 mm on a large one, unless told otherwise. */
  gridMm?: number;
}

export function testPatternSvg(options: TestPatternOptions): string {
  const w = round(options.widthMm);
  const h = round(options.heightMm);
  const grid = options.gridMm ?? (Math.min(w, h) <= 30 ? 5 : 10);

  const short = Math.min(w, h);
  const stroke = round(Math.max(0.35, short / 120));
  const mark = round(Math.max(1.2, short / 14));
  const inset = round(mark * 1.1);

  const lines: string[] = [];
  for (let x = grid; x < w; x += grid) {
    lines.push(`<line x1="${round(x)}" y1="0" x2="${round(x)}" y2="${h}"/>`);
  }
  for (let y = grid; y < h; y += grid) {
    lines.push(`<line x1="0" y1="${round(y)}" x2="${w}" y2="${round(y)}"/>`);
  }

  // The arrow: tall, asymmetric about the horizontal axis, so an upside-down mapping is obvious.
  const cx = round(w / 2);
  const arrowTop = round(h * 0.2);
  const arrowBottom = round(h * 0.72);
  const arrowHalf = round(Math.min(w, h) * 0.11);
  const arrow =
    `<polygon points="${cx},${arrowTop} ${round(cx + arrowHalf)},${round(arrowTop + arrowHalf)} ` +
    `${round(cx + arrowHalf / 2)},${round(arrowTop + arrowHalf)} ${round(cx + arrowHalf / 2)},${arrowBottom} ` +
    `${round(cx - arrowHalf / 2)},${arrowBottom} ${round(cx - arrowHalf / 2)},${round(arrowTop + arrowHalf)} ` +
    `${round(cx - arrowHalf)},${round(arrowTop + arrowHalf)}"/>`;

  // Four corners, four shapes: filled square, circle, triangle, hollow square (clockwise from
  // top-left). A mirrored mapping swaps two of them, which no amount of squinting at a grid shows.
  const corners = [
    `<rect x="${inset}" y="${inset}" width="${mark}" height="${mark}"/>`,
    `<circle cx="${round(w - inset - mark / 2)}" cy="${round(inset + mark / 2)}" r="${round(mark / 2)}"/>`,
    `<polygon points="${round(w - inset - mark)},${round(h - inset - mark)} ${round(w - inset)},${round(h - inset - mark)} ${round(w - inset - mark / 2)},${round(h - inset)}"/>`,
    `<rect x="${inset}" y="${round(h - inset - mark)}" width="${mark}" height="${mark}" fill="none" stroke-width="${round(stroke * 2)}"/>`,
  ];

  const crossArm = round(short * 0.06);
  const cross =
    `<line x1="${round(w / 2 - crossArm)}" y1="${round(h / 2)}" x2="${round(w / 2 + crossArm)}" y2="${round(h / 2)}"/>` +
    `<line x1="${round(w / 2)}" y1="${round(h / 2 - crossArm)}" x2="${round(w / 2)}" y2="${round(h / 2 + crossArm)}"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
    `<g fill="none" stroke="#000" stroke-width="${round(stroke)}">`,
    `<rect x="${round(stroke / 2)}" y="${round(stroke / 2)}" width="${round(w - stroke)}" height="${round(h - stroke)}"/>`,
    lines.join(''),
    cross,
    `</g>`,
    `<g fill="#000" stroke="#000" stroke-width="${round(stroke)}">`,
    arrow,
    corners.join(''),
    `</g>`,
    `</svg>`,
  ].join('');
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
