/**
 * A deliberately small XML reader for the SVG subset.
 *
 * Hand-written rather than delegated to a library because the security posture is the point: this
 * parser has no DTD support, no entity table beyond the five XML built-ins, and no external
 * resolution, so XXE and entity-expansion attacks are not mitigated here — they are unrepresentable
 * (docs/05-security.md, docs/14-artwork-pipeline.md).
 */

export interface XmlAttribute {
  name: string;
  value: string;
}

export interface XmlElement {
  type: 'element';
  name: string;
  /** Namespace prefix stripped from the tag name, e.g. `svg` in `<svg:rect>`. */
  prefix: string | null;
  attributes: XmlAttribute[];
  children: XmlNode[];
}

export interface XmlText {
  type: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

export class XmlParseError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'malformed'
      | 'doctype_forbidden'
      | 'entity_forbidden'
      | 'processing_instruction'
      | 'depth_exceeded'
      | 'nodes_exceeded'
      | 'unbalanced',
  ) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export interface XmlLimits {
  maxDepth: number;
  maxNodes: number;
  maxAttributesPerElement: number;
  strict?: boolean;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxDepth: 32,
  maxNodes: 200_000,
  maxAttributesPerElement: 64,
};

/** The five entities XML defines itself. Anything else is a rejection, never an expansion. */
const BUILT_IN_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const code = Number.parseInt(ref.slice(2), 16);
      return Number.isFinite(code) ? safeCodePoint(code) : match;
    }
    if (ref.startsWith('#')) {
      const code = Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? safeCodePoint(code) : match;
    }
    const builtIn = BUILT_IN_ENTITIES[ref];
    if (builtIn !== undefined) return builtIn;
    // Unknown entity: leave the reference inert rather than resolving anything.
    return match;
  });
}

function safeCodePoint(code: number): string {
  if (code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function parseXml(source: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlElement {
  let index = 0;
  let nodeCount = 0;

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const fail = (message: string, code: XmlParseError['code']): never => {
    throw new XmlParseError(`${message} at offset ${index}`, code);
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);

    if (lt === -1) {
      if (limits.strict && stack.length === 0 && source.slice(index).trim())
        fail('text outside root element', 'malformed');
      break;
    }

    if (lt > index) {
      const text = source.slice(index, lt);
      if (limits.strict && stack.length === 0 && text.trim())
        fail('text outside root element', 'malformed');
      if (text.trim().length > 0 && stack.length > 0) {
        stack[stack.length - 1]!.children.push({ type: 'text', value: decodeXmlText(text) });
      }
    }

    index = lt;

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end === -1) fail('unterminated comment', 'malformed');
      index = end + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end === -1) fail('unterminated CDATA', 'malformed');
      // CDATA is only ever text; scripts inside it are removed later by the sanitizer's allow-list.
      if (stack.length > 0) {
        stack[stack.length - 1]!.children.push({
          type: 'text',
          value: source.slice(index + 9, end),
        });
      }
      index = end + 3;
      continue;
    }

    if (/^<!doctype/i.test(source.slice(index, index + 9))) {
      fail('DOCTYPE declarations are not accepted', 'doctype_forbidden');
    }

    if (/^<!entity/i.test(source.slice(index, index + 8))) {
      fail('entity declarations are not accepted', 'entity_forbidden');
    }

    if (source.startsWith('<?', index)) {
      // XML declarations are ignored; any other processing instruction is refused.
      const end = source.indexOf('?>', index + 2);
      if (end === -1) fail('unterminated processing instruction', 'malformed');
      const body = source.slice(index + 2, end);
      if (!/^xml[\s?]/i.test(body) && body.toLowerCase() !== 'xml') {
        fail('processing instructions are not accepted', 'processing_instruction');
      }
      index = end + 2;
      continue;
    }

    if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index);
      if (end === -1) fail('unterminated close tag', 'malformed');
      const name = source.slice(index + 2, end).trim();
      const open = stack.pop();
      if (!open) fail(`unexpected closing tag ${name}`, 'unbalanced');
      if (
        limits.strict &&
        open &&
        name !== (open.prefix ? `${open.prefix}:${open.name}` : open.name)
      )
        fail(`mismatched closing tag ${name}`, 'unbalanced');
      index = end + 1;
      continue;
    }

    // Opening tag
    const tagEnd = findTagEnd(source, index);
    if (tagEnd === -1) fail('unterminated tag', 'malformed');
    const raw = source.slice(index + 1, tagEnd);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;

    const element = parseTag(body, limits, fail);
    nodeCount++;
    if (nodeCount > limits.maxNodes) fail('too many nodes', 'nodes_exceeded');

    if (stack.length === 0) {
      if (root) fail('multiple root elements', 'malformed');
      root = element;
    } else {
      stack[stack.length - 1]!.children.push(element);
    }

    if (!selfClosing) {
      stack.push(element);
      if (stack.length > limits.maxDepth) fail('nesting too deep', 'depth_exceeded');
    }

    index = tagEnd + 1;
  }

  if (!root) throw new XmlParseError('no root element', 'malformed');
  if (limits.strict && stack.length > 0)
    throw new XmlParseError('unclosed root element', 'unbalanced');
  return root;
}

/** Finds the `>` that ends a tag, skipping any inside quoted attribute values. */
function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i;
  }
  return -1;
}

const NAME_RE = /^[^\s/>]+/;
const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseTag(
  body: string,
  limits: XmlLimits,
  fail: (message: string, code: XmlParseError['code']) => never,
): XmlElement {
  const nameMatch = NAME_RE.exec(body);
  if (!nameMatch) fail('tag without a name', 'malformed');
  const qualified = nameMatch[0]!;
  const colon = qualified.indexOf(':');
  const prefix = colon === -1 ? null : qualified.slice(0, colon);
  const name = colon === -1 ? qualified : qualified.slice(colon + 1);

  const attributes: XmlAttribute[] = [];
  ATTR_RE.lastIndex = qualified.length;
  let cursor = qualified.length;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(body)) !== null) {
    if (
      limits.strict &&
      (body.slice(cursor, match.index).trim() || match[5] !== undefined || names.has(match[1]!))
    )
      fail('invalid or duplicate XML attribute', 'malformed');
    cursor = ATTR_RE.lastIndex;
    names.add(match[1]!);
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attributes.push({ name: match[1]!, value: decodeXmlText(value) });
    if (attributes.length > limits.maxAttributesPerElement) {
      fail('too many attributes', 'nodes_exceeded');
    }
  }
  if (limits.strict && body.slice(cursor).trim()) fail('invalid XML attributes', 'malformed');

  return { type: 'element', name, prefix, attributes, children: [] };
}

/** Depth-first walk, parents before children. */
export function walk(
  node: XmlNode,
  visit: (node: XmlNode, parent: XmlElement | null) => void,
): void {
  const recurse = (current: XmlNode, parent: XmlElement | null) => {
    visit(current, parent);
    if (current.type === 'element') {
      for (const child of [...current.children]) recurse(child, current);
    }
  };
  recurse(node, null);
}

export const attributeValue = (element: XmlElement, name: string, caseSensitive = false): string | undefined =>
  element.attributes.find((a) => caseSensitive ? a.name === name : a.name.toLowerCase() === name.toLowerCase())?.value;

export function serializeXml(node: XmlNode): string {
  if (node.type === 'text') return escapeText(node.value);
  const attributes = node.attributes
    .map((a) => ` ${a.name}="${escapeAttribute(a.value)}"`)
    .join('');
  if (node.children.length === 0) return `<${node.name}${attributes}/>`;
  return `<${node.name}${attributes}>${node.children.map(serializeXml).join('')}</${node.name}>`;
}

const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
export const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
