import {
  IDENTITY,
  matrixScale,
  multiply,
  parseNumbers,
  parsePathData,
  parseTransform,
  pathBBox,
  serializePathData,
  transformSegments,
  countNodes,
  isClosed,
  type BBox,
  type Matrix,
  type Segment,
  type PathParseOptions,
} from './path.js';
import { attributeValue, escapeAttribute, type XmlElement } from './xml.js';

/**
 * Stage 3 of the artwork pipeline: turn a sanitised SVG into a flat list of filled paths in one
 * coordinate system, with a known physical size.
 *
 * Everything downstream — rasterisation, distance fields, emboss profiles — works on geometry, so
 * this is where the document's structure (groups, transforms, shapes, uses) is resolved away.
 */

export interface NormalizedPath {
  segments: Segment[];
  fill: string | null;
  stroke: string | null;
  /** Stroke width in user units after transforms. */
  strokeWidth: number;
  opacity: number;
  closed: boolean;
}

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormalizedArtwork {
  paths: NormalizedPath[];
  viewBox: ViewBox;
  /** Physical size the document declares, in millimetres. */
  naturalSizeMm: { w: number; h: number };
  /** User units per millimetre — the bridge between the document and the real world. */
  unitsPerMm: number;
  contentBBox: BBox | null;
  usedGradient: boolean;
  unresolvedReferences: number;
}

const NON_RENDERED = new Set(['defs', 'clipPath', 'mask', 'symbol', 'title', 'desc', 'metadata']);
const PX_PER_MM = 96 / 25.4;

/** Parses an SVG length into millimetres. Unitless values are CSS pixels at 96 dpi. */
export function lengthToMm(value: string | undefined, fallbackMm: number): number {
  if (!value) return fallbackMm;
  const match = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
  if (!match) return fallbackMm;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return fallbackMm;

  switch ((match[2] ?? '').toLowerCase()) {
    case 'mm':
      return n;
    case 'cm':
      return n * 10;
    case 'in':
      return n * 25.4;
    case 'pt':
      return (n * 25.4) / 72;
    case 'pc':
      return (n * 25.4) / 6;
    case 'q':
      return n / 4;
    case '%':
      return fallbackMm; // percentages need a viewport we do not have; fall back
    case 'px':
    case '':
      return n / PX_PER_MM;
    default:
      return fallbackMm;
  }
}

export function normalizeSvg(root: XmlElement): NormalizedArtwork {
  const ids = indexIds(root);
  const paths: NormalizedPath[] = [];
  let usedGradient = false;
  let unresolvedReferences = 0;

  const viewBoxAttr = parseNumbers(attributeValue(root, 'viewBox') ?? '');
  const widthMm = lengthToMm(attributeValue(root, 'width'), NaN);
  const heightMm = lengthToMm(attributeValue(root, 'height'), NaN);

  const viewBox: ViewBox =
    viewBoxAttr.length === 4
      ? { x: viewBoxAttr[0]!, y: viewBoxAttr[1]!, w: viewBoxAttr[2]!, h: viewBoxAttr[3]! }
      : {
          x: 0,
          y: 0,
          w: Number.isFinite(widthMm) ? widthMm * PX_PER_MM : 100,
          h: Number.isFinite(heightMm) ? heightMm * PX_PER_MM : 100,
        };

  // Physical size: declared width/height if present, otherwise the viewBox read as CSS pixels.
  const naturalSizeMm = {
    w: Number.isFinite(widthMm) ? widthMm : viewBox.w / PX_PER_MM,
    h: Number.isFinite(heightMm) ? heightMm : viewBox.h / PX_PER_MM,
  };
  const unitsPerMm = naturalSizeMm.w > 0 ? viewBox.w / naturalSizeMm.w : PX_PER_MM;

  const visit = (
    element: XmlElement,
    parentMatrix: Matrix,
    inherited: Style,
    depth: number,
  ): void => {
    if (depth > 32) return;
    if (NON_RENDERED.has(element.name)) return;

    const matrix = multiply(parentMatrix, parseTransform(attributeValue(element, 'transform')));
    const style = resolveStyle(element, inherited);

    if (style.display === 'none' || style.opacity === 0) return;

    if (element.name === 'use') {
      const href = attributeValue(element, 'href') ?? attributeValue(element, 'xlink:href');
      const target = href?.startsWith('#') ? ids.get(href.slice(1)) : undefined;
      if (!target) {
        unresolvedReferences++;
        return;
      }
      const x = Number(attributeValue(element, 'x') ?? 0);
      const y = Number(attributeValue(element, 'y') ?? 0);
      visit(target, multiply(matrix, { ...IDENTITY, e: x, f: y }), style, depth + 1);
      return;
    }

    const segments = shapeToSegments(element);
    if (segments) {
      if (style.fill?.startsWith('url(')) usedGradient = true;
      paths.push({
        segments: transformSegments(segments, matrix),
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth * matrixScale(matrix),
        opacity: style.opacity,
        closed: isClosed(segments),
      });
    }

    for (const child of element.children) {
      if (child.type === 'element') visit(child, matrix, style, depth + 1);
    }
  };

  for (const child of root.children) {
    if (child.type === 'element') visit(child, IDENTITY, DEFAULT_STYLE, 0);
  }

  // Stroked geometry occupies area beyond its centreline: a horizontal hairline is not empty.
  const contentBBox = unionBBoxes(
    paths.map((path) => {
      const box = pathBBox(path.segments);
      if (!box) return null;
      const grow = path.stroke && path.strokeWidth > 0 ? path.strokeWidth / 2 : 0;
      return { x: box.x - grow, y: box.y - grow, w: box.w + grow * 2, h: box.h + grow * 2 };
    }),
  );

  return {
    paths,
    viewBox,
    naturalSizeMm,
    unitsPerMm,
    contentBBox,
    usedGradient,
    unresolvedReferences,
  };
}

function unionBBoxes(boxes: (BBox | null)[]): BBox | null {
  let result: BBox | null = null;
  for (const box of boxes) {
    if (!box) continue;
    if (!result) {
      result = box;
      continue;
    }
    const x = Math.min(result.x, box.x);
    const y = Math.min(result.y, box.y);
    const right = Math.max(result.x + result.w, box.x + box.w);
    const bottom = Math.max(result.y + result.h, box.y + box.h);
    result = { x, y, w: right - x, h: bottom - y };
  }
  return result;
}

interface Style {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  opacity: number;
  display: string | null;
}

const DEFAULT_STYLE: Style = {
  fill: '#000000',
  stroke: null,
  strokeWidth: 1,
  opacity: 1,
  display: null,
};

function resolveStyle(element: XmlElement, inherited: Style): Style {
  const declarations = parseStyleAttribute(attributeValue(element, 'style'));
  const read = (name: string): string | undefined =>
    declarations[name] ?? attributeValue(element, name);

  const fillRaw = read('fill');
  const strokeRaw = read('stroke');
  const widthRaw = read('stroke-width');
  const opacityRaw = read('opacity');

  return {
    fill: fillRaw === undefined ? inherited.fill : fillRaw === 'none' ? null : fillRaw,
    stroke: strokeRaw === undefined ? inherited.stroke : strokeRaw === 'none' ? null : strokeRaw,
    strokeWidth:
      widthRaw === undefined ? inherited.strokeWidth : Number(parseNumbers(widthRaw)[0]) || 0,
    opacity:
      opacityRaw === undefined ? inherited.opacity : inherited.opacity * (Number(opacityRaw) || 0),
    display: read('display') ?? inherited.display,
  };
}

function parseStyleAttribute(style: string | undefined): Record<string, string> {
  if (!style) return {};
  const out: Record<string, string> = {};
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    out[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim();
  }
  return out;
}

function indexIds(root: XmlElement): Map<string, XmlElement> {
  const ids = new Map<string, XmlElement>();
  const visit = (element: XmlElement) => {
    const id = attributeValue(element, 'id');
    if (id && !ids.has(id)) ids.set(id, element);
    for (const child of element.children) if (child.type === 'element') visit(child);
  };
  visit(root);
  return ids;
}

/** Basic shapes become path data, so downstream code only ever sees paths. */
export function shapeToSegments(
  element: XmlElement,
  options: PathParseOptions = {},
): Segment[] | null {
  const parse = (data: string) => parsePathData(data, options);
  const num = (name: string, fallback = 0): number => {
    const raw = attributeValue(element, name);
    if (raw === undefined) return fallback;
    const value = Number(parseNumbers(raw)[0]);
    return Number.isFinite(value) ? value : fallback;
  };

  switch (element.name) {
    case 'path': {
      const d = attributeValue(element, 'd');
      return d ? parse(d) : null;
    }

    case 'rect': {
      const x = num('x');
      const y = num('y');
      const w = num('width');
      const h = num('height');
      if (w <= 0 || h <= 0) return null;
      const rx = Math.min(num('rx', num('ry')), w / 2);
      const ry = Math.min(num('ry', num('rx')), h / 2);
      if (rx > 0 && ry > 0) {
        return parse(
          `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
            `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
            `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
            `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`,
        );
      }
      return parse(`M${x} ${y}H${x + w}V${y + h}H${x}Z`);
    }

    case 'circle': {
      const r = num('r');
      if (r <= 0) return null;
      const cx = num('cx');
      const cy = num('cy');
      return parse(
        `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`,
      );
    }

    case 'ellipse': {
      const rx = num('rx');
      const ry = num('ry');
      if (rx <= 0 || ry <= 0) return null;
      const cx = num('cx');
      const cy = num('cy');
      return parse(
        `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`,
      );
    }

    case 'line':
      return parse(`M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`);

    case 'polyline':
    case 'polygon': {
      const points = parseNumbers(attributeValue(element, 'points') ?? '');
      if (points.length < 4) return null;
      const parts = [`M${points[0]} ${points[1]}`];
      for (let i = 2; i + 1 < points.length; i += 2) parts.push(`L${points[i]} ${points[i + 1]}`);
      if (element.name === 'polygon') parts.push('Z');
      return parse(parts.join(''));
    }

    default:
      return null;
  }
}

/** Emits a minimal SVG containing only the normalised geometry. */
export function serializeNormalized(artwork: NormalizedArtwork, precision = 4): string {
  const paths = artwork.paths
    .map((path) => {
      const fill = escapeAttribute(path.fill ?? 'none');
      const stroke = path.stroke
        ? ` stroke="${escapeAttribute(path.stroke)}" stroke-width="${path.strokeWidth}"`
        : '';
      return `<path d="${serializePathData(path.segments, precision)}" fill="${fill}"${stroke}/>`;
    })
    .join('');

  const { x, y, w, h } = artwork.viewBox;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" ` +
    `width="${artwork.naturalSizeMm.w}mm" height="${artwork.naturalSizeMm.h}mm">${paths}</svg>`
  );
}

export const totalNodeCount = (artwork: NormalizedArtwork): number =>
  artwork.paths.reduce((sum, path) => sum + countNodes(path.segments), 0);
