import { attributeValue, parseXml, XmlParseError, type XmlElement, type XmlNode } from './xml.js';

/**
 * Stage 2 of the artwork pipeline: make an uploaded SVG safe to process.
 *
 * Allow-list, never deny-list. Anything not explicitly permitted is dropped, so a novel attribute
 * or element cannot smuggle behaviour through. Runs server-side inside the sandbox described in
 * docs/05-security.md; the client's own sanitizer is defence in depth, never the boundary.
 */

export const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
  'symbol',
  'title',
  'desc',
  'metadata',
]);

export const ALLOWED_ATTRIBUTES = new Set([
  'd',
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
  'points',
  'width',
  'height',
  'viewbox',
  'transform',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'clip-path',
  'clip-rule',
  'mask',
  'maskunits',
  'id',
  'class',
  'style',
  'xmlns',
  'preserveaspectratio',
  'vector-effect',
  'href',
]);

/**
 * Attributes whose values may carry a URL. Only same-document `#fragment` references survive.
 * `style` is handled declaration by declaration instead, so one bad property does not cost the
 * user their fill and stroke as well.
 */
const URL_ATTRIBUTES = new Set(['href', 'clip-path', 'mask', 'fill', 'stroke']);

/** CSS declarations we accept inside a `style` attribute; everything else is dropped. */
const ALLOWED_STYLE_PROPERTIES = new Set([
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'display',
  'visibility',
  'color',
  'stop-color',
  'stop-opacity',
]);

export interface SanitizeRemoval {
  kind: 'element' | 'attribute' | 'style-declaration';
  name: string;
  reason:
    | 'not_allowed'
    | 'event_handler'
    | 'external_reference'
    | 'script_url'
    | 'unsupported_namespace';
}

export interface SanitizeResult {
  root: XmlElement;
  removals: SanitizeRemoval[];
}

export class SanitizeError extends Error {
  constructor(
    message: string,
    readonly code: 'not_svg' | 'parse_failed',
  ) {
    super(message);
    this.name = 'SanitizeError';
  }
}

export function sanitizeSvg(source: string): SanitizeResult {
  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch (error) {
    if (error instanceof XmlParseError) {
      throw new SanitizeError(`could not parse SVG: ${error.message}`, 'parse_failed');
    }
    throw error;
  }

  if (root.name.toLowerCase() !== 'svg') {
    throw new SanitizeError(`root element is <${root.name}>, expected <svg>`, 'not_svg');
  }

  const removals: SanitizeRemoval[] = [];
  sanitizeElement(root, removals);

  // An empty result is not an error here: sanitising is about safety, and judging whether what
  // survived is usable artwork — and telling the user why it is not — belongs to validation, which
  // can see what was removed and explain it.
  return { root, removals };
}

function sanitizeElement(element: XmlElement, removals: SanitizeRemoval[]): void {
  element.attributes = element.attributes.filter((attribute) =>
    keepAttribute(element, attribute.name, attribute.value, removals),
  );

  element.attributes = element.attributes.map((attribute) =>
    attribute.name.toLowerCase() === 'style'
      ? { ...attribute, value: filterStyle(attribute.value, removals) }
      : attribute,
  );

  const kept: XmlNode[] = [];
  for (const child of element.children) {
    if (child.type === 'text') {
      kept.push(child);
      continue;
    }

    // Foreign namespaces (xhtml, MathML, …) never carry drawing instructions we support.
    if (child.prefix && child.prefix.toLowerCase() !== 'svg') {
      removals.push({ kind: 'element', name: `${child.prefix}:${child.name}`, reason: 'unsupported_namespace' });
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(child.name) && !ALLOWED_ELEMENTS.has(child.name.toLowerCase())) {
      // <script>, <foreignObject>, <image>, <animate>, <font-face>, <filter>, … all land here.
      removals.push({ kind: 'element', name: child.name, reason: 'not_allowed' });
      continue;
    }

    sanitizeElement(child, removals);
    kept.push(child);
  }
  element.children = kept;
}

function keepAttribute(
  element: XmlElement,
  name: string,
  value: string,
  removals: SanitizeRemoval[],
): boolean {
  const lower = name.toLowerCase();
  const local = lower.includes(':') ? lower.slice(lower.indexOf(':') + 1) : lower;

  if (local.startsWith('on')) {
    removals.push({ kind: 'attribute', name, reason: 'event_handler' });
    return false;
  }

  if (lower.startsWith('xmlns')) return true; // namespace declarations are inert

  if (!ALLOWED_ATTRIBUTES.has(local)) {
    removals.push({ kind: 'attribute', name, reason: 'not_allowed' });
    return false;
  }

  if (URL_ATTRIBUTES.has(local) && containsForbiddenUrl(value)) {
    removals.push({
      kind: 'attribute',
      name,
      reason: /javascript\s*:/i.test(value) ? 'script_url' : 'external_reference',
    });
    return false;
  }

  // <use href="…"> must resolve inside this document.
  if (local === 'href' && element.name === 'use' && !value.trim().startsWith('#')) {
    removals.push({ kind: 'attribute', name, reason: 'external_reference' });
    return false;
  }

  return true;
}

const URL_FUNCTION_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

function containsForbiddenUrl(value: string): boolean {
  if (/javascript\s*:/i.test(value) || /vbscript\s*:/i.test(value)) return true;
  if (/data\s*:/i.test(value)) return true; // no embedded payloads of any kind
  if (/@import/i.test(value)) return true;

  URL_FUNCTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_FUNCTION_RE.exec(value)) !== null) {
    const target = (match[2] ?? '').trim();
    if (!target.startsWith('#')) return true; // remote or protocol-relative reference
  }

  // Bare remote references outside url(), e.g. href="https://…"
  return /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value);
}

function filterStyle(style: string, removals: SanitizeRemoval[]): string {
  return style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const colon = declaration.indexOf(':');
      if (colon === -1) return false;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();

      if (!ALLOWED_STYLE_PROPERTIES.has(property)) {
        removals.push({ kind: 'style-declaration', name: property, reason: 'not_allowed' });
        return false;
      }
      if (containsForbiddenUrl(value)) {
        removals.push({ kind: 'style-declaration', name: property, reason: 'external_reference' });
        return false;
      }
      return true;
    })
    .join('; ');
}

/** True when the tree still contains anything that could execute or fetch. */
export function containsScriptableContent(root: XmlElement): boolean {
  const scriptable = ['script', 'foreignObject', 'iframe', 'animate', 'set', 'handler'];
  let found = false;
  const visit = (node: XmlNode) => {
    if (node.type !== 'element') return;
    if (scriptable.includes(node.name)) found = true;
    if (node.attributes.some((a) => a.name.toLowerCase().startsWith('on'))) found = true;
    if (node.attributes.some((a) => /javascript\s*:/i.test(a.value))) found = true;
    node.children.forEach(visit);
  };
  visit(root);
  return found;
}

export { attributeValue };
