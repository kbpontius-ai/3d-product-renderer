import { DEFAULT_MAX_BYTES } from './pipeline.js';
import { lengthToMm, shapeToSegments } from './normalize.js';
import {
  IDENTITY,
  multiply,
  parseNumbers,
  parseTransform,
  pathBBox,
  serializePathData,
  transformSegments,
  type BBox,
  type Matrix,
} from './path.js';
import {
  attributeValue as readAttribute,
  escapeAttribute,
  parseXml,
  type XmlElement,
} from './xml.js';
import { preparationStyleResolver } from './preparation-style.js';
import { preparationPaint } from './preparation-paint.js';
import {
  PreparationError,
  type ArtworkAnalysis,
  type PreparationClip,
  type PreparationObject,
} from './preparation-types.js';

export const PREPARATION_ANALYZER_VERSION = '1';
const attributeValue = (element: XmlElement, name: string) => readAttribute(element, name, true);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const NON_RENDERED = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'clipPath']);
const GEOMETRY_ATTRIBUTES = new Set([
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
]);
const sourceShape = (element: XmlElement): NonNullable<PreparationObject['sourceShape']> => ({
  name: element.name,
  attributes: Object.fromEntries(
    element.attributes
      .filter((attribute) => GEOMETRY_ATTRIBUTES.has(attribute.name))
      .map((attribute) => [attribute.name, attribute.value]),
  ),
});

export function preparationMaximumScale(matrix: Matrix): number {
  const a = matrix.a * matrix.a + matrix.b * matrix.b,
    b = matrix.c * matrix.c + matrix.d * matrix.d;
  const c = matrix.a * matrix.c + matrix.b * matrix.d;
  return Math.sqrt((a + b + Math.sqrt((a - b) ** 2 + 4 * c * c)) / 2);
}

export function precisePreparationSegments(
  object: Pick<PreparationObject, 'segments' | 'matrix' | 'sourceShape'>,
  toleranceMm: number,
) {
  if (!object.sourceShape) return object.segments;
  const element: XmlElement = {
    type: 'element',
    name: object.sourceShape.name,
    prefix: null,
    children: [],
    attributes: Object.entries(object.sourceShape.attributes).map(([name, value]) => ({
      name,
      value,
    })),
  };
  const scale = preparationMaximumScale(object.matrix);
  try {
    return scale
      ? (shapeToSegments(element, { arcToleranceUnits: toleranceMm / scale }) ?? [])
      : object.segments;
  } catch {
    throw new PreparationError(
      'An arc exceeds the vector detail limit. Simplify or outline it in the source editor.',
    );
  }
}

function coordinate(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
    throw new PreparationError(
      'Shape coordinates must be finite user-unit numbers. Export outlined geometry with resolved lengths.',
    );
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e7)
    throw new PreparationError(
      'The SVG coordinates are too large or invalid. Export a bounded drawing.',
    );
  return number;
}

function checkedTransform(element: XmlElement): Matrix {
  const value = attributeValue(element, 'transform');
  if (value) {
    const rest = value.replace(
      /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g,
      (_match, name: string, args: string) => {
        const values = args
          .trim()
          .split(/[\s,]+/)
          .map((part) => coordinate(part));
        const allowed =
          name === 'matrix'
            ? [6]
            : name === 'translate' || name === 'scale'
              ? [1, 2]
              : name === 'rotate'
                ? [1, 3]
                : [1];
        if (!allowed.includes(values.length))
          throw new PreparationError('Malformed SVG transform. Re-export the drawing.');
        return '';
      },
    );
    if (rest.replace(/[\s,]/g, ''))
      throw new PreparationError('Unsupported SVG transform. Export resolved static geometry.');
  }
  const matrix = parseTransform(value);
  if (Object.values(matrix).some((n) => !Number.isFinite(n) || Math.abs(n) > 1e7))
    throw new PreparationError('SVG transform exceeds the supported bounds.');
  return matrix;
}

function checkedShape(element: XmlElement) {
  for (const attribute of element.attributes) {
    if (
      ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height'].includes(
        attribute.name,
      )
    ) {
      const value = coordinate(attribute.value);
      if (['r', 'rx', 'ry', 'width', 'height'].includes(attribute.name) && value < 0)
        throw new PreparationError('Negative shape sizes are invalid. Re-export the drawing.');
    }
  }
  if (element.name === 'path') {
    const data = attributeValue(element, 'd') ?? '';
    if (data.replace(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[\s,]/g, ''))
      throw new PreparationError('Malformed path data. Repair it in the source editor.');
    if (data && !/^\s*[Mm]/.test(data))
      throw new PreparationError('SVG paths must start with a move command.');
    for (const match of data.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
      const counts: Record<string, number> = {
        M: 2,
        L: 2,
        H: 1,
        V: 1,
        C: 6,
        S: 4,
        Q: 4,
        T: 2,
        A: 7,
        Z: 0,
      };
      const count = counts[match[1]!.toUpperCase()]!;
      const numbers = parseNumbers(match[2]!);
      if (count === 0 ? numbers.length !== 0 : numbers.length === 0 || numbers.length % count !== 0)
        throw new PreparationError('A path command is incomplete. Repair it in the source editor.');
      if (numbers.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e7))
        throw new PreparationError('Path coordinates exceed the supported bounds.');
      if (count === 7)
        for (let i = 0; i < numbers.length; i += 7) {
          if (
            numbers[i]! < 0 ||
            numbers[i + 1]! < 0 ||
            ![0, 1].includes(numbers[i + 3]!) ||
            ![0, 1].includes(numbers[i + 4]!)
          )
            throw new PreparationError('Invalid arc radii or flags. Re-export the path.');
        }
    }
  }
  if (element.name === 'polygon' || element.name === 'polyline') {
    const points = attributeValue(element, 'points') ?? '';
    const numbers = parseNumbers(points);
    if (
      points.replace(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[\s,]/gi, '') ||
      numbers.length % 2 ||
      numbers.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e7)
    )
      throw new PreparationError(
        'Incomplete or unbounded polygon coordinates. Re-export the drawing.',
      );
  }
  return (
    shapeToSegments({
      ...element,
      attributes: element.attributes.filter((attribute) => GEOMETRY_ATTRIBUTES.has(attribute.name)),
    }) ?? []
  );
}

function userLength(value: string): number {
  const mm = lengthToMm(value, NaN);
  const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
    ? Number(value)
    : (mm * 96) / 25.4;
  if (!Number.isFinite(number))
    throw new PreparationError(
      'Percentage and unresolved stroke lengths are unsupported. Export resolved strokes.',
    );
  return number;
}

export async function analyzeArtworkSource(source: string): Promise<ArtworkAnalysis> {
  if (/<\?xml-stylesheet\b/i.test(source))
    throw new PreparationError(
      'This SVG links an external stylesheet. Embed solid paint styles in the SVG or export inline paint, then upload it again.',
    );
  const bytes = new TextEncoder().encode(source);
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== source)
    throw new PreparationError('The source contains invalid Unicode. Export a UTF-8 SVG.');
  if (bytes.length > DEFAULT_MAX_BYTES)
    throw new PreparationError('This SVG exceeds the 5 MB limit. Export a simpler file.');
  let root: XmlElement;
  try {
    root = parseXml(source, {
      maxDepth: 32,
      maxNodes: 10_000,
      maxAttributesPerElement: 64,
      strict: true,
    });
  } catch (error) {
    throw new PreparationError(error instanceof Error ? error.message : 'The SVG is malformed.');
  }
  if (root.name !== 'svg') throw new PreparationError('This file is not an SVG drawing.');
  if (
    attributeValue(root, 'xmlns') &&
    attributeValue(root, 'xmlns') !== 'http://www.w3.org/2000/svg'
  )
    throw new PreparationError(
      'The drawing has an unsupported XML namespace. Export standard SVG.',
    );
  const ids = new Map<string, XmlElement>();
  const ancestry = new Map<XmlElement, XmlElement[]>();
  const index = (
    element: XmlElement,
    parents: XmlElement[],
    inheritedNamespaces: Record<string, string> = {},
  ) => {
    for (const attribute of element.attributes) {
      const limit =
        attribute.name === 'class' ? 4096 : attribute.name === 'style' ? 16_000 : 200_000;
      if (attribute.value.length > limit)
        throw new PreparationError(
          'An SVG attribute exceeds the supported detail limit. Simplify the drawing or export resolved inline paint and upload again.',
        );
    }
    const namespaces = { ...inheritedNamespaces };
    for (const attribute of element.attributes) {
      if (attribute.name === 'xmlns') namespaces[''] = attribute.value;
      else if (attribute.name.startsWith('xmlns:'))
        namespaces[attribute.name.slice(6)] = attribute.value;
    }
    if (namespaces[element.prefix ?? ''] !== 'http://www.w3.org/2000/svg')
      throw new PreparationError(
        'The SVG namespace is missing or unsupported. Export a standard SVG file from your vector editor and upload it again.',
      );
    if (
      attributeValue(element, 'xlink:href') &&
      namespaces['xlink'] !== 'http://www.w3.org/1999/xlink'
    )
      throw new PreparationError(
        'This SVG has an invalid linked-object namespace. Export standard SVG with resolved vector objects.',
      );
    ancestry.set(element, [...parents, element]);
    const id = attributeValue(element, 'id');
    if (id && ids.has(id))
      throw new PreparationError(
        'Duplicate SVG IDs make references ambiguous. Export a drawing with unique IDs.',
      );
    if (id) ids.set(id, element);
    if (element !== root && element.name === 'svg')
      throw new PreparationError(
        'Nested SVG viewports are unsupported. Expand them in the source editor.',
      );
    if (
      element.attributes.some((attribute) =>
        ['marker-start', 'marker-mid', 'marker-end', 'pathLength'].includes(attribute.name),
      )
    )
      throw new PreparationError(
        'Markers and custom path lengths must be outlined in the source editor.',
      );
    if (element.attributes.some((attribute) => attribute.name.toLowerCase().startsWith('on')))
      throw new PreparationError(
        'Active SVG event handlers are not accepted. Export a static drawing.',
      );
    if (
      element.name === 'style' &&
      ((attributeValue(element, 'media') ?? 'all').trim().toLowerCase() !== 'all' ||
        (attributeValue(element, 'type') ?? 'text/css').trim().toLowerCase() !== 'text/css')
    )
      throw new PreparationError(
        'This SVG uses a media-dependent or non-CSS stylesheet. Export static inline solid paint and upload it again.',
      );
    if (element.name === 'text')
      throw new PreparationError(
        'This SVG contains live text. Convert text to outlines in your vector editor and upload it again.',
      );
    if (element.name === 'image')
      throw new PreparationError(
        'This SVG contains an embedded or linked image. Trace it into vector shapes in your source editor and upload it again.',
      );
    if (['script', 'foreignObject', 'animate', 'animateTransform', 'set'].includes(element.name))
      throw new PreparationError(
        'This SVG contains active content or animation. Export a static vector drawing and upload it again.',
      );
    if (element.name === 'metadata') return;
    for (const child of element.children)
      if (child.type === 'element') index(child, [...parents, element], namespaces);
  };
  index(root, []);
  const resolve = preparationStyleResolver(root);
  const vb = parseNumbers(attributeValue(root, 'viewBox') ?? '');
  const width = lengthToMm(attributeValue(root, 'width'), vb[2] ? (vb[2] * 25.4) / 96 : NaN);
  const height = lengthToMm(attributeValue(root, 'height'), vb[3] ? (vb[3] * 25.4) / 96 : NaN);
  const view =
    vb.length === 4
      ? { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]! }
      : { x: 0, y: 0, w: (width * 96) / 25.4, h: (height * 96) / 25.4 };
  if (
    ![width, height, view.w, view.h].every((n) => Number.isFinite(n) && n > 0) ||
    Math.max(width, height) > 1000
  )
    throw new PreparationError('Declare a positive SVG canvas up to 1,000 mm per side.');
  const aspect = attributeValue(root, 'preserveAspectRatio') ?? 'xMidYMid meet';
  if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(aspect))
    throw new PreparationError('Unsupported SVG aspect ratio. Re-export with a standard viewport.');
  const sx = width / view.w,
    sy = height / view.h;
  const scale = aspect.endsWith('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
  const matrix: Matrix =
    aspect === 'none'
      ? { a: sx, b: 0, c: 0, d: sy, e: -view.x * sx, f: -view.y * sy }
      : {
          a: scale,
          b: 0,
          c: 0,
          d: scale,
          e:
            -view.x * scale +
            (width - view.w * scale) *
              (aspect.includes('xMax') ? 1 : aspect.includes('xMid') ? 0.5 : 0),
          f:
            -view.y * scale +
            (height - view.h * scale) *
              (aspect.includes('YMax') ? 1 : aspect.includes('YMid') ? 0.5 : 0),
        };
  const objects: PreparationObject[] = [];
  const groups: ArtworkAnalysis['groups'] = [];
  let segmentsCount = 0;
  let expandedCharacters = 0;
  const chargeText = (size: number) => {
    expandedCharacters += size;
    if (expandedCharacters > 8_000_000)
      throw new PreparationError(
        'The SVG expands into too much duplicated source data. Expand reusable objects or simplify clipping in your vector editor and upload again.',
      );
  };
  const clips = (reference: string, world: Matrix, localBox: BBox | null): PreparationClip[] => {
    const match = /^url\(["']?#([\w.-]+)["']?\)$/.exec(reference);
    const target = match && ids.get(match[1]!);
    if (!target || target.name !== 'clipPath')
      throw new PreparationError(
        'A required clip path is missing or unsupported. Re-export resolved vector clipping.',
      );
    const units = attributeValue(target, 'clipPathUnits') ?? 'userSpaceOnUse';
    if (units !== 'userSpaceOnUse' && units !== 'objectBoundingBox')
      throw new PreparationError('Unsupported clip coordinate system.');
    if (units === 'objectBoundingBox' && !localBox)
      throw new PreparationError(
        'Bounding-box clips on groups are unsupported. Apply the clip in your source editor.',
      );
    const base =
      units === 'objectBoundingBox'
        ? multiply(world, {
            a: localBox!.w,
            b: 0,
            c: 0,
            d: localBox!.h,
            e: localBox!.x,
            f: localBox!.y,
          })
        : world;
    const result: PreparationClip[] = [];
    const visit = (
      node: XmlElement,
      parent: Matrix,
      inherited: Record<string, string>,
      refs: Set<XmlElement>,
    ) => {
      const style = resolve(ancestry.get(node)!, inherited);
      if (style['display'] === 'none') return;
      if (style['clip-path'] !== 'none' || style['mask'] !== 'none')
        throw new PreparationError(
          'Nested clip definitions and masks are unsupported. Apply them in the source editor.',
        );
      const next = multiply(parent, checkedTransform(node));
      if (node.name === 'use') {
        const href = attributeValue(node, 'href') ?? attributeValue(node, 'xlink:href');
        const ref = href?.startsWith('#') ? ids.get(href.slice(1)) : undefined;
        if (!ref || refs.has(ref) || refs.size > 16)
          throw new PreparationError('A clip reference is missing, circular, or too deep.');
        visit(
          ref,
          multiply(next, {
            ...IDENTITY,
            e: coordinate(attributeValue(node, 'x')),
            f: coordinate(attributeValue(node, 'y')),
          }),
          style,
          new Set([...refs, ref]),
        );
      } else if (SHAPES.has(node.name)) {
        if (style['display'] !== 'none' && style['visibility'] === 'visible')
          result.push({
            segments: checkedShape(node),
            sourceShape: sourceShape(node),
            matrix: next,
            fillRule: style['clip-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
          });
      } else if (node.name === 'g' || node.name === 'clipPath') {
        for (const child of node.children)
          if (child.type === 'element') visit(child, next, style, refs);
      } else
        throw new PreparationError(
          'A clip contains unsupported content. Apply it in the source editor.',
        );
    };
    visit(target, base, resolve(ancestry.get(target)!.slice(0, -1)), new Set([target]));
    return result;
  };
  const visit = (
    element: XmlElement,
    parent: Matrix,
    inherited: Record<string, string>,
    groupIds: string[],
    inheritedClips: PreparationClip[][],
    hidden: boolean,
    refs: Set<XmlElement>,
  ) => {
    if (NON_RENDERED.has(element.name)) return;
    if (objects.length >= 5000 || refs.size > 16)
      throw new PreparationError(
        'This drawing expands into too many objects or references. Export a simpler SVG.',
      );
    const style = resolve(ancestry.get(element)!, inherited);
    const world = multiply(parent, checkedTransform(element));
    const alpha = (value: string): number =>
      value.endsWith('%') ? Number.parseFloat(value) / 100 : Number(value);
    const opacity = alpha(style['opacity']!);
    if (
      ![opacity, alpha(style['fill-opacity']!), alpha(style['stroke-opacity']!)].every(
        (n) => n === 0 || n === 1,
      )
    )
      throw new PreparationError(
        'Partial opacity cannot define an exact solid mark. Export opaque vectors.',
      );
    for (const property of ['mask', 'filter', 'vector-effect'])
      if (style[property] !== 'none')
        throw new PreparationError(
          `Unsupported ${property}. Apply the effect in your source editor and export outlined vectors.`,
        );
    if (style['mix-blend-mode'] !== 'normal' || style['paint-order'] !== 'normal')
      throw new PreparationError(
        'Custom blend modes or paint order are unsupported. Export resolved vectors.',
      );
    const segments = SHAPES.has(element.name) ? checkedShape(element) : null;
    if (
      !['butt', 'round', 'square'].includes(style['stroke-linecap']!) ||
      !['miter', 'round', 'bevel'].includes(style['stroke-linejoin']!)
    )
      throw new PreparationError(
        'This stroke uses unsupported caps or joins. Outline it in the source editor.',
      );
    const nextClips =
      style['clip-path'] === 'none'
        ? inheritedClips
        : [
            ...inheritedClips,
            clips(style['clip-path']!, world, segments ? pathBBox(segments) : null),
          ];
    const nextHidden = hidden || style['display'] === 'none' || opacity === 0;
    let nextGroups = groupIds;
    if (element.name === 'g' || element.name === 'use' || element.name === 'symbol') {
      if (groups.length >= 5000)
        throw new PreparationError(
          'This SVG expands into too many groups. Simplify or expand reusable objects in your vector editor.',
        );
      chargeText((attributeValue(element, 'id') ?? '').length);
      const group = {
        id: `g${groups.length}`,
        label: attributeValue(element, 'id') ?? `Group ${groups.length + 1}`,
        objectIds: [] as string[],
      };
      groups.push(group);
      nextGroups = [...groupIds, group.id];
    }
    if (element.name === 'use') {
      const href = attributeValue(element, 'href') ?? attributeValue(element, 'xlink:href');
      const target = href?.startsWith('#') ? ids.get(href.slice(1)) : undefined;
      if (!target || refs.has(target))
        throw new PreparationError(
          'A reusable object is missing, external, or circular. Export resolved vector objects.',
        );
      if (target.name === 'symbol' && attributeValue(target, 'viewBox'))
        throw new PreparationError(
          'Reusable symbols with their own viewports must be expanded in the source editor.',
        );
      visit(
        target,
        multiply(world, {
          ...IDENTITY,
          e: coordinate(attributeValue(element, 'x')),
          f: coordinate(attributeValue(element, 'y')),
        }),
        style,
        nextGroups,
        nextClips,
        nextHidden,
        new Set([...refs, target]),
      );
      return;
    }
    if (segments) {
      segmentsCount +=
        segments.length +
        nextClips.reduce(
          (sum, group) => sum + group.reduce((count, shape) => count + shape.segments.length, 0),
          0,
        );
      if (segmentsCount > 100_000)
        throw new PreparationError(
          'This drawing has too many expanded path or clipping segments. Simplify clipping and reusable objects in your vector editor.',
        );
      const shape = sourceShape(element);
      chargeText(
        (attributeValue(element, 'id') ?? '').length +
          Object.values(shape.attributes).reduce((sum, value) => sum + value.length, 0),
      );
      for (const group of nextClips)
        for (const clip of group)
          if (clip.sourceShape)
            chargeText(
              Object.values(clip.sourceShape.attributes).reduce(
                (sum, value) => sum + value.length,
                0,
              ),
            );
      const strokeWidth = userLength(style['stroke-width']!);
      const dashArray =
        style['stroke-dasharray'] === 'none'
          ? []
          : style['stroke-dasharray']!.split(/[\s,]+/).map((value) => userLength(value));
      if (
        strokeWidth < 0 ||
        dashArray.some((n) => n < 0) ||
        dashArray.length > 100 ||
        Number(style['stroke-miterlimit']) < 1
      )
        throw new PreparationError('Invalid or excessive stroke width, dashes, or miter limit.');
      const id = `o${objects.length}`;
      objects.push({
        id,
        label:
          attributeValue(element, 'id') ??
          `${element.name === 'path' ? 'Path' : element.name} ${objects.length + 1}`,
        groups: nextGroups,
        segments,
        sourceShape: shape,
        matrix: world,
        fill:
          alpha(style['fill-opacity']!) === 0
            ? null
            : preparationPaint(style['fill'] === 'currentcolor' ? style['color']! : style['fill']!),
        stroke:
          alpha(style['stroke-opacity']!) === 0
            ? null
            : preparationPaint(
                style['stroke'] === 'currentcolor' ? style['color']! : style['stroke']!,
              ),
        strokeWidth,
        fillRule: style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
        linecap: style['stroke-linecap'] as PreparationObject['linecap'],
        linejoin: style['stroke-linejoin'] as PreparationObject['linejoin'],
        miterLimit: Number(style['stroke-miterlimit']),
        dashArray,
        dashOffset: userLength(style['stroke-dashoffset']!),
        hidden: nextHidden || style['visibility'] !== 'visible',
        clips: nextClips,
        bounds: pathBBox(transformSegments(segments, world)),
      });
      for (const group of groups) if (nextGroups.includes(group.id)) group.objectIds.push(id);
    } else if (!['svg', 'g', 'symbol'].includes(element.name))
      throw new PreparationError(
        `Unsupported SVG element: ${element.name}. Export static outlined vectors.`,
      );
    for (const child of element.children)
      if (child.type === 'element')
        visit(child, world, style, nextGroups, nextClips, nextHidden, refs);
  };
  const rootStyle = resolve([root]);
  if (
    !['1', '1.0', '100%'].includes(rootStyle['opacity']!) ||
    rootStyle['filter'] !== 'none' ||
    rootStyle['mask'] !== 'none' ||
    rootStyle['clip-path'] !== 'none'
  )
    throw new PreparationError(
      'Root opacity, effects, or clipping must be resolved in the source editor.',
    );
  const world = multiply(matrix, checkedTransform(root));
  for (const child of root.children)
    if (child.type === 'element')
      visit(child, world, rootStyle, [], [], rootStyle['display'] === 'none', new Set());
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const analysis: ArtworkAnalysis = {
    sourceDigest: [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join(''),
    analyzerVersion: PREPARATION_ANALYZER_VERSION,
    sourceSvg: '',
    viewBox: { x: 0, y: 0, w: width, h: height },
    unitsConfirmed: Boolean(
      attributeValue(root, 'width')?.match(/(?:mm|cm|in|pt|pc|q)$/i) &&
        attributeValue(root, 'height')?.match(/(?:mm|cm|in|pt|pc|q)$/i),
    ),
    objects,
    groups,
    issues: [],
  };
  if (!analysis.unitsConfirmed)
    analysis.issues.push({
      id: 'confirm-size',
      severity: 'review',
      code: 'confirm_size',
      message:
        'The source does not declare a physical size. Confirm width and height in millimetres before saving.',
    });
  analysis.sourceSvg = preparationSourceSvg(analysis, objects);
  return analysis;
}

export function preparationSourceSvg(
  analysis: Pick<ArtworkAnalysis, 'viewBox'>,
  objects: PreparationObject[],
): string {
  const definitions: string[] = [];
  const paths = objects
    .filter((object) => !object.hidden)
    .map((object) => {
      const transform = (matrix: Matrix): string =>
        `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
      const geometry = object.sourceShape
        ? Object.entries(object.sourceShape.attributes)
            .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
            .join('')
        : ` d="${escapeAttribute(serializePathData(object.segments, 12))}"`;
      let path = `<${object.sourceShape?.name ?? 'path'} data-preparation-id="${escapeAttribute(object.id)}"${geometry} transform="${transform(object.matrix)}" fill="${escapeAttribute(object.fill ?? 'none')}" fill-rule="${object.fillRule}" stroke="${escapeAttribute(object.stroke ?? 'none')}" stroke-width="${object.strokeWidth}" stroke-linecap="${object.linecap}" stroke-linejoin="${object.linejoin}" stroke-miterlimit="${object.miterLimit}" stroke-dasharray="${object.dashArray.join(' ') || 'none'}" stroke-dashoffset="${object.dashOffset}"/>`;
      for (const [index, clip] of object.clips.entries()) {
        const id = `${object.id}c${index}`;
        definitions.push(
          `<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${clip
            .map(
              (item) =>
                `<${item.sourceShape?.name ?? 'path'}${
                  item.sourceShape
                    ? Object.entries(item.sourceShape.attributes)
                        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
                        .join('')
                    : ` d="${escapeAttribute(serializePathData(item.segments, 12))}"`
                } transform="${transform(item.matrix)}" clip-rule="${item.fillRule}"/>`,
            )
            .join('')}</clipPath>`,
        );
        path = `<g clip-path="url(#${id})">${path}</g>`;
      }
      return path;
    });
  const { w, h } = analysis.viewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><defs>${definitions.join('')}</defs>${paths.join('')}</svg>`;
}
