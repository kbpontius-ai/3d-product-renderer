import { describe, expect, it } from 'vitest';
import { sanitizeSvg, containsScriptableContent, SanitizeError } from './sanitize.js';
import { serializeXml, walk, type XmlElement } from './xml.js';

/**
 * The hostile corpus (docs/05-security.md, "SVG fuzz corpus passes with zero escapes").
 *
 * The other tests in this package check that specific removals happen. This one checks the property
 * those removals exist to produce, against a body of inputs nobody wrote a targeted test for: after
 * sanitising, *nothing* executes and *nothing* reaches the network. That difference matters. A
 * targeted test tells you the case you thought of is handled; this tells you the ones you did not
 * think of are handled too, and it is the second kind that gets you.
 *
 * Every case here is an escape someone has actually used on a real sanitiser: case-folded scheme
 * names, control characters inside a scheme, entity indirection, namespace prefixes, CDATA, and
 * attributes that only become dangerous once a browser normalises them.
 */

/** Wraps a fragment in a document the parser will accept, so the fragment is what is under test. */
const doc = (body: string, attrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${body}</svg>`;

/**
 * The corpus.
 *
 * Grouped only for reading; every one of them is held to the same invariant below.
 */
const HOSTILE: { name: string; svg: string }[] = [
  // --- executable content, spelled every way it can be spelled ------------------------------
  { name: 'script element', svg: doc('<script>alert(1)</script>') },
  { name: 'script, mixed case', svg: doc('<ScRiPt>alert(1)</ScRiPt>') },
  { name: 'script via namespace prefix', svg: doc('<svg:script>alert(1)</svg:script>') },
  { name: 'script inside a group', svg: doc('<g><script>alert(1)</script></g>') },
  { name: 'script inside defs', svg: doc('<defs><script>alert(1)</script></defs>') },
  { name: 'script with CDATA', svg: doc('<script><![CDATA[alert(1)]]></script>') },
  { name: 'foreignObject with markup', svg: doc('<foreignObject><div onclick="x()">hi</div></foreignObject>') },
  { name: 'handler on a shape', svg: doc('<rect width="1" height="1" onload="alert(1)"/>') },
  { name: 'handler, mixed case', svg: doc('<rect width="1" height="1" OnLoAd="alert(1)"/>') },
  { name: 'handler on the root', svg: doc('<rect width="1" height="1"/>', ' onload="alert(1)"') },
  { name: 'handler that is not on*', svg: doc('<rect width="1" height="1" formaction="javascript:alert(1)"/>') },
  { name: 'animation element', svg: doc('<animate attributeName="x" to="10"/>') },
  { name: 'set element', svg: doc('<set attributeName="x" to="10"/>') },

  // --- schemes that fetch or execute ---------------------------------------------------------
  { name: 'javascript: href', svg: doc('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>') },
  { name: 'javascript:, uppercase', svg: doc('<a href="JAVASCRIPT:alert(1)"><rect width="1" height="1"/></a>') },
  { name: 'javascript:, spaced', svg: doc('<a href="  javascript:alert(1)"><rect width="1" height="1"/></a>') },
  { name: 'javascript:, tab inside scheme', svg: doc('<a href="java\tscript:alert(1)"><rect width="1" height="1"/></a>') },
  { name: 'javascript:, newline inside scheme', svg: doc('<a href="java\nscript:alert(1)"><rect width="1" height="1"/></a>') },
  { name: 'javascript:, entity encoded', svg: doc('<a href="&#106;avascript:alert(1)"><rect width="1" height="1"/></a>') },
  { name: 'vbscript:', svg: doc('<a href="vbscript:msgbox(1)"><rect width="1" height="1"/></a>') },
  { name: 'data: html payload', svg: doc('<image href="data:text/html,<script>alert(1)</script>"/>') },
  { name: 'data: svg payload', svg: doc('<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>') },

  // --- anything that would make the browser go and fetch something ---------------------------
  { name: 'remote image', svg: doc('<image href="https://example.invalid/x.png"/>') },
  { name: 'remote image, xlink', svg: doc('<image xlink:href="https://example.invalid/x.png"/>') },
  { name: 'protocol-relative', svg: doc('<image href="//example.invalid/x.png"/>') },
  { name: 'remote use', svg: doc('<use href="https://example.invalid/x.svg#a"/>') },
  { name: 'remote filter via url()', svg: doc('<rect width="1" height="1" filter="url(https://example.invalid/f.svg#f)"/>') },
  { name: 'remote fill via url()', svg: doc('<rect width="1" height="1" fill="url(//example.invalid/p.svg#p)"/>') },
  { name: 'style with @import', svg: doc('<style>@import url("https://example.invalid/x.css");</style><rect width="1" height="1"/>') },
  { name: 'style attribute with url()', svg: doc('<rect width="1" height="1" style="fill:url(https://example.invalid/p.svg#p)"/>') },
  { name: 'style attribute with expression', svg: doc('<rect width="1" height="1" style="width:expression(alert(1))"/>') },
  { name: 'style attribute with behavior', svg: doc('<rect width="1" height="1" style="behavior:url(#default#time2)"/>') },
  { name: 'font-face src', svg: doc('<defs><font-face><font-face-src><font-face-uri href="https://example.invalid/f.woff"/></font-face-src></font-face></defs>') },

  // --- structural oddities that have broken parsers before -----------------------------------
  { name: 'foreign namespace element', svg: doc('<html:iframe xmlns:html="http://www.w3.org/1999/xhtml" src="https://example.invalid"/>') },
  { name: 'nested svg', svg: doc('<svg><script>alert(1)</script></svg>') },
  { name: 'comment hiding a handler', svg: doc('<!-- <rect onload="alert(1)"/> --><rect width="1" height="1"/>') },
  { name: 'attribute with control characters', svg: doc('<rect width="1" height="1" fill="&#1;&#2;red"/>') },
  { name: 'empty document', svg: doc('') },
  { name: 'text content that looks like markup', svg: doc('<desc>&lt;script&gt;alert(1)&lt;/script&gt;</desc><rect width="1" height="1"/>') },
];

/** Schemes and shapes that mean "go and fetch this", none of which may survive. */
const EGRESS = [/https?:/i, /\/\//, /data:/i, /\bfile:/i, /ftp:/i];

/**
 * Namespace declarations, which are identifiers and not addresses.
 *
 * `xmlns="http://www.w3.org/2000/svg"` is how a document says what it is; no browser fetches it.
 * They are removed before the egress scan and checked separately, rather than the scan being
 * loosened — a weaker pattern would also stop noticing a real `http:` somewhere it matters.
 */
const KNOWN_NAMESPACES = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
]);

const withoutNamespaceDeclarations = (serialized: string): string =>
  serialized.replace(/\sxmlns(:[a-zA-Z0-9_-]+)?="[^"]*"/g, '');
const EXECUTABLE = [/javascript/i, /vbscript/i, /\bon[a-z]+\s*=/i, /expression\s*\(/i, /@import/i];

/**
 * The invariant.
 *
 * Applied to the serialised output rather than to the tree, because the serialised output is what
 * would actually reach a browser, and a check that reads the tree can miss something the serialiser
 * puts back.
 */
function assertInert(name: string, svg: string): void {
  let root: XmlElement;
  try {
    root = sanitizeSvg(svg).root;
  } catch (error) {
    // Refusing the document outright is a perfectly good outcome — nothing escapes a rejection.
    expect(error, `${name}: threw something other than SanitizeError`).toBeInstanceOf(SanitizeError);
    return;
  }

  expect(containsScriptableContent(root), `${name}: something scriptable survived`).toBe(false);

  const out = serializeXml(root);
  const addresses = withoutNamespaceDeclarations(out);
  for (const pattern of EXECUTABLE) {
    expect(pattern.test(addresses), `${name}: ${pattern} survived in ${out}`).toBe(false);
  }
  for (const pattern of EGRESS) {
    expect(pattern.test(addresses), `${name}: ${pattern} survived in ${out}`).toBe(false);
  }

  // And any namespace that did survive is one of the three this format legitimately uses, so the
  // exclusion above cannot become a hiding place.
  for (const declaration of out.matchAll(/xmlns(?::[a-zA-Z0-9_-]+)?="([^"]*)"/g)) {
    expect(KNOWN_NAMESPACES.has(declaration[1]!), `${name}: unexpected namespace ${declaration[1]}`).toBe(true);
  }

  // And nothing that names a remote resource, whatever it is called.
  walk(root, (node) => {
    if (node.type !== 'element') return;
    for (const attribute of node.attributes) {
      const value = attribute.value.trim();
      const local = attribute.name.split(':').pop() ?? attribute.name;
      if (['href', 'src', 'from', 'to', 'values'].includes(local.toLowerCase())) {
        expect(
          value === '' || value.startsWith('#'),
          `${name}: ${attribute.name}="${value}" points outside the document`,
        ).toBe(true);
      }
    }
  });
}

describe('hostile SVG corpus', () => {
  it('has enough cases to be worth calling a corpus', () => {
    expect(HOSTILE.length).toBeGreaterThanOrEqual(35);
  });

  for (const { name, svg } of HOSTILE) {
    it(`is inert after sanitising: ${name}`, () => assertInert(name, svg));
  }
});

/**
 * Mutations, so the corpus covers arrangements nobody wrote down.
 *
 * Deterministic on purpose: a seeded generator gives the same thousand documents on every machine
 * and every run, so a failure is reproducible and CI cannot flake. A random fuzzer that finds a bug
 * once and never again is worse than no fuzzer, because it teaches people to re-run the build.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = HOSTILE.map((c) => c.svg.replace(/^<svg[^>]*>|<\/svg>$/g, ''));
const CARRIERS = [
  (payload: string) => doc(payload),
  (payload: string) => doc(`<g>${payload}</g>`),
  (payload: string) => doc(`<defs>${payload}</defs><rect width="1" height="1"/>`),
  (payload: string) => doc(`<g><g><g>${payload}</g></g></g>`),
  (payload: string) => doc(`<rect width="1" height="1"/>${payload}<circle r="1"/>`),
];

describe('mutated hostile documents', () => {
  it('are inert however the pieces are combined', () => {
    const random = mulberry32(0x5eed);

    for (let i = 0; i < 600; i++) {
      const count = 1 + Math.floor(random() * 3);
      const payload = Array.from(
        { length: count },
        () => FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]!,
      ).join('');
      const carrier = CARRIERS[Math.floor(random() * CARRIERS.length)]!;

      assertInert(`mutation ${i}`, carrier(payload));
    }
  });
});
