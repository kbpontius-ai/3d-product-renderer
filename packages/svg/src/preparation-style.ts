import {
  generate,
  ident,
  lexer,
  parse,
  type CssNode,
  type Declaration,
  type Selector,
} from 'css-tree';
import { attributeValue as readAttribute, type XmlElement } from './xml.js';
import { PreparationError } from './preparation-types.js';

const attributeValue = (element: XmlElement, name: string) => readAttribute(element, name, true);

const DEFAULTS: Record<string, string> = {
  color: '#000000',
  fill: '#000000',
  stroke: 'none',
  'fill-rule': 'nonzero',
  'clip-rule': 'nonzero',
  'fill-opacity': '1',
  'stroke-opacity': '1',
  'stroke-width': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0',
  visibility: 'visible',
  display: 'inline',
  opacity: '1',
  'clip-path': 'none',
  mask: 'none',
  filter: 'none',
  'mix-blend-mode': 'normal',
  'paint-order': 'normal',
  'vector-effect': 'none',
};
const NON_INHERITED = new Set([
  'display',
  'opacity',
  'clip-path',
  'mask',
  'filter',
  'mix-blend-mode',
  'vector-effect',
]);
type SimpleSelector = { kind: 'type' | 'class' | 'id'; name: string };
interface SelectorPart {
  tests: SimpleSelector[];
  relation: ' ' | '>' | null;
}
type Specificity = [number, number, number, number];

function higherSpecificity(a: Specificity, b: Specificity): boolean {
  for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

interface StyleRule {
  parts: SelectorPart[];
  specificity: Specificity;
  declarations: Declaration[];
}

function selectorParts(selector: Selector): { parts: SelectorPart[]; specificity: Specificity } {
  const parts: SelectorPart[] = [{ tests: [], relation: null }];
  const specificity: Specificity = [0, 0, 0, 0];
  for (const node of selector.children) {
    if (node.type === 'Combinator' && (node.name === ' ' || node.name === '>')) {
      parts.push({ tests: [], relation: node.name });
    } else if (
      node.type === 'TypeSelector' ||
      node.type === 'ClassSelector' ||
      node.type === 'IdSelector'
    ) {
      const kind =
        node.type === 'TypeSelector' ? 'type' : node.type === 'ClassSelector' ? 'class' : 'id';
      const name = ident.decode(node.name);
      if (kind === 'type' && name.includes('|'))
        throw new PreparationError(
          'Namespaced CSS selectors are unsupported. Re-export with inline solid paint.',
        );
      parts.at(-1)!.tests.push({ kind, name });
      if (name !== '*') specificity[kind === 'id' ? 1 : kind === 'class' ? 2 : 3]++;
    } else {
      throw new PreparationError(
        'This stylesheet uses an unsupported selector. Use class, ID, element, child, or descendant selectors, or export inline paint.',
      );
    }
  }
  if (parts.some((part) => part.tests.length === 0))
    throw new PreparationError('Invalid SVG stylesheet selector.');
  return { parts, specificity };
}

function matches(parts: SelectorPart[], ancestry: XmlElement[]): boolean {
  const test = (part: SelectorPart, element: XmlElement): boolean =>
    part.tests.every(({ kind, name }) =>
      kind === 'type'
        ? name === '*' || name === element.name
        : kind === 'id'
          ? attributeValue(element, 'id') === name
          : (attributeValue(element, 'class') ?? '').split(/\s+/).includes(name),
    );
  const match = (partIndex: number, elementIndex: number): boolean => {
    if (elementIndex < 0 || !test(parts[partIndex]!, ancestry[elementIndex]!)) return false;
    if (partIndex === 0) return true;
    if (parts[partIndex]!.relation === '>') return match(partIndex - 1, elementIndex - 1);
    for (let i = elementIndex - 1; i >= 0; i--) if (match(partIndex - 1, i)) return true;
    return false;
  };
  return match(parts.length - 1, ancestry.length - 1);
}

function parseCss(source: string, context: 'stylesheet' | 'declarationList'): CssNode {
  if (source.length > 200_000)
    throw new PreparationError('The stylesheet is too complex. Export inline paint.');
  try {
    return parse(source, {
      context,
      onParseError: () => {
        throw new Error('Invalid CSS');
      },
    });
  } catch {
    throw new PreparationError(
      'The SVG stylesheet could not be parsed faithfully. Re-export with inline solid paint.',
    );
  }
}

function declarations(nodes: Iterable<CssNode>): Declaration[] {
  const result: Declaration[] = [];
  for (const node of nodes) {
    if (node.type !== 'Declaration' || !(node.property in DEFAULTS)) {
      throw new PreparationError(
        node.type === 'Declaration'
          ? `The SVG uses the unsupported CSS property “${node.property}”. Export static outlined vectors with inline solid paint and upload again.`
          : 'The SVG uses an unsupported style rule. Export static outlined vectors with inline solid paint and upload again.',
      );
    }
    const value = generate(node.value);
    if (['revert', 'revert-layer'].includes(value.toLowerCase()))
      throw new PreparationError(
        'CSS cascade rollback values are unsupported. Export resolved inline solid paint and upload again.',
      );
    if (
      !['inherit', 'initial', 'unset'].includes(value) &&
      !lexer.matchProperty(node.property, node.value).matched
    ) {
      throw new PreparationError(
        `Unsupported ${node.property} value. Export solid, self-contained vector paint.`,
      );
    }
    if (/url\(/i.test(value) && !/^url\(["']?#[\w.-]+["']?\)$/i.test(value)) {
      throw new PreparationError(
        'External SVG style references are not accepted. Embed outlined vectors instead.',
      );
    }
    result.push(node);
  }
  return result;
}

export function preparationStyleResolver(
  root: XmlElement,
): (ancestry: XmlElement[], inherited?: Record<string, string>) => Record<string, string> {
  const rules: StyleRule[] = [];
  const collect = (element: XmlElement) => {
    if (element.name === 'style') {
      if (
        attributeValue(element, 'type') &&
        attributeValue(element, 'type')!.trim().toLowerCase() !== 'text/css'
      )
        throw new PreparationError('Only static CSS stylesheets are supported.');
      if (
        attributeValue(element, 'media') &&
        attributeValue(element, 'media')!.trim().toLowerCase() !== 'all'
      )
        throw new PreparationError(
          'Media-dependent SVG styles are unsupported. Export inline paint.',
        );
      const sheet = parseCss(
        element.children.map((child) => (child.type === 'text' ? child.value : '')).join(''),
        'stylesheet',
      );
      if (sheet.type !== 'StyleSheet') throw new PreparationError('Invalid stylesheet.');
      for (const rule of sheet.children) {
        if (rule.type !== 'Rule' || rule.prelude.type !== 'SelectorList')
          throw new PreparationError(
            'CSS imports, conditional rules, and animations are unsupported. Export a self-contained static SVG.',
          );
        const values = declarations(rule.block.children);
        for (const selector of rule.prelude.children) {
          if (selector.type !== 'Selector') throw new PreparationError('Invalid selector.');
          rules.push({ ...selectorParts(selector), declarations: values });
        }
      }
    }
    for (const child of element.children) if (child.type === 'element') collect(child);
  };
  collect(root);
  if (rules.length > 500)
    throw new PreparationError('Too many stylesheet rules. Export inline paint.');
  return (ancestry, inherited = DEFAULTS) => {
    const element = ancestry.at(-1)!;
    const style: Record<string, string> = { ...DEFAULTS };
    for (const property of Object.keys(DEFAULTS))
      if (!NON_INHERITED.has(property))
        style[property] = inherited[property] ?? DEFAULTS[property]!;
    const winners = new Map<string, { important: boolean; specificity: Specificity }>();
    const assign = (
      property: string,
      value: string,
      important: boolean,
      specificity: Specificity,
    ) => {
      if (!/url\(/i.test(value)) value = value.toLowerCase();
      const previous = winners.get(property);
      if (
        previous &&
        ((previous.important && !important) ||
          (previous.important === important &&
            higherSpecificity(previous.specificity, specificity)))
      )
        return;
      winners.set(property, { important, specificity });
      style[property] =
        value === 'inherit' || (value === 'unset' && !NON_INHERITED.has(property))
          ? (inherited[property] ?? DEFAULTS[property]!)
          : value === 'initial' || value === 'unset'
            ? DEFAULTS[property]!
            : value;
    };
    for (const property of Object.keys(DEFAULTS)) {
      const value = attributeValue(element, property);
      if (value !== undefined) {
        const list = parseCss(`${property}:${value}`, 'declarationList');
        if (list.type !== 'DeclarationList') throw new PreparationError('Invalid paint attribute.');
        const parsed = declarations(list.children);
        const declaration = parsed[0];
        if (
          parsed.length !== 1 ||
          !declaration ||
          declaration.property !== property ||
          declaration.important
        )
          throw new PreparationError(
            `The ${property} presentation attribute is invalid. Put valid paint declarations in a stylesheet or inline style and re-export.`,
          );
        assign(property, generate(declaration.value), false, [0, 0, 0, 0]);
      }
    }
    for (const rule of rules)
      if (matches(rule.parts, ancestry)) {
        for (const declaration of rule.declarations)
          assign(
            declaration.property,
            generate(declaration.value),
            Boolean(declaration.important),
            rule.specificity,
          );
      }
    const inline = attributeValue(element, 'style');
    if (inline) {
      const list = parseCss(inline, 'declarationList');
      if (list.type !== 'DeclarationList') throw new PreparationError('Invalid inline style.');
      for (const declaration of declarations(list.children))
        assign(
          declaration.property,
          generate(declaration.value),
          Boolean(declaration.important),
          [1, 0, 0, 0],
        );
    }
    if (style['color']?.toLowerCase() === 'currentcolor')
      style['color'] = inherited['color'] ?? '#000000';
    // currentColor remains inherited paint until its used value is resolved on a painted leaf.
    return style;
  };
}
