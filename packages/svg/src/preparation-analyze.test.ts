import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeArtworkSource } from './preparation-analyze.js';
import { preparationSubpaths } from './preparation-repairs.js';

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../../fixtures/artwork/preparation/${name}.svg`, import.meta.url),
    'utf8',
  );
const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="30mm" viewBox="0 0 40 30">${body}</svg>`;

describe('safe styled source analysis', () => {
  it('resolves embedded styles, preserves structure, and emits inert computed paint', async () => {
    const source = fixture('monogram');
    const analysis = await analyzeArtworkSource(source);
    expect(analysis.objects.map((object) => object.fill)).toEqual([
      '#101010',
      '#ffffff',
      '#101010',
      '#fdfdfd',
    ]);
    expect(analysis.groups[0]!.objectIds).toEqual(['o1', 'o2', 'o3']);
    expect(analysis.sourceSvg).not.toContain('<style');
    expect(analysis.sourceSvg).toContain('data-preparation-id="o1"');
    expect(analysis.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await analyzeArtworkSource(source)).objects).toEqual(analysis.objects);
  });
  it('honors the cascade, currentColor, specificity, importance, and inline inheritance', async () => {
    const analysis = await analyzeArtworkSource(
      svg(
        `<style>path{fill:blue}.ink{fill:green}g > path.ink{fill:white!important} #mark{fill:yellow}</style><g color="red"><path id="mark" class="ink" style="fill:black" d="M0 0H5V5Z"/><path fill="currentColor" d="M10 0H15V5Z"/></g>`,
      ),
    );
    expect(analysis.objects.map((object) => object.fill)).toEqual(['#ffffff', '#0000ff']);
    const inherited = await analyzeArtworkSource(
      svg('<g color="red" fill="currentColor"><path d="M0 0H5V5Z"/></g>'),
    );
    expect(inherited.objects[0]!.fill).toBe('#ff0000');
    const childColor = await analyzeArtworkSource(
      svg('<g color="red" fill="currentColor"><path color="blue" d="M0 0H5V5Z"/></g>'),
    );
    expect(childColor.objects[0]!.fill).toBe('#0000ff');
  });
  it('expands reusable objects per instance and keeps clipping dependencies', async () => {
    const analysis = await analyzeArtworkSource(fixture('compound-and-reuse'));
    expect(analysis.objects).toHaveLength(3);
    expect(new Set(analysis.objects.map((object) => object.id)).size).toBe(3);
    expect(analysis.objects.map((object) => object.fillRule)).toEqual([
      'evenodd',
      'evenodd',
      'evenodd',
    ]);
    expect(analysis.objects[2]!.clips).toHaveLength(1);
    expect(analysis.objects[2]!.clips[0]![0]!.matrix.e).toBe(4);
  });
  it('keeps formal open flags and hidden/unpainted objects in the manifest', async () => {
    const open = await analyzeArtworkSource(fixture('open-paths'));
    expect(open.objects.flatMap(preparationSubpaths).every((path) => !path.closed)).toBe(true);
    const hidden = await analyzeArtworkSource(fixture('ambiguous-and-empty'));
    expect(hidden.objects.some((object) => object.hidden)).toBe(true);
    expect(hidden.objects.some((object) => !object.fill && !object.stroke)).toBe(true);
  });
  it.each([
    [
      'unsupported CSS',
      '<style>@import url(https://example.test/style.css);</style><rect width="5" height="5"/>',
    ],
    ['unsupported selector', '<style>path:hover{fill:red}</style><path d="M0 0H5V5Z"/>'],
    ['active content', '<script>alert(1)</script><rect width="5" height="5"/>'],
    ['external reuse', '<use href="https://example.test/mark.svg#p"/>'],
    ['recursive reuse', '<defs><g id="loop"><use href="#loop"/></g></defs><use href="#loop"/>'],
    ['duplicate IDs', '<rect id="x" width="5" height="5"/><rect id="x" width="5" height="5"/>'],
    ['incomplete path', '<path d="M0 0C1 2 3 4"/>'],
    ['mismatched XML', '<g><path d="M0 0H5V5Z"/></wrong>'],
    ['unsafe style', '<path style="fill:url(https://example.test/paint)" d="M0 0H5V5Z"/>'],
    ['partial paint', '<rect width="5" height="5" fill="#ffffff80"/>'],
    [
      'nested viewport',
      '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><rect width="5" height="5"/></svg>',
    ],
  ])('blocks %s rather than showing an altered original', async (_name, body) => {
    await expect(analyzeArtworkSource(svg(body))).rejects.toThrow();
  });
  it('blocks ambiguous effects with a recovery hint', async () => {
    await expect(analyzeArtworkSource(fixture('unsupported-effects'))).rejects.toThrow(
      /gradient|opacity/,
    );
  });
  it('removes display:none clip groups from clipping while preserving visible siblings', async () => {
    const analysis = await analyzeArtworkSource(
      svg(
        '<defs><clipPath id="clip"><g style="display:none"><rect width="20" height="20"/></g><rect width="3" height="4"/></clipPath></defs><rect width="20" height="20" clip-path="url(#clip)"/>',
      ),
    );
    expect(analysis.objects[0]!.clips[0]).toHaveLength(1);
  });
  it.each([
    ['<text>Example</text>', 'Convert text to outlines'],
    [
      '<style media="print">rect{fill:red}</style><rect width="5" height="5"/>',
      'Export static inline solid paint',
    ],
    [
      '<style type="application/x-css">rect{fill:red}</style><rect width="5" height="5"/>',
      'Export static inline solid paint',
    ],
    ['<image href="data:image/png;base64,AA=="/>', 'Trace it into vector shapes'],
    ['<rect width="10" height="10" opacity="0.5"/>', 'Export opaque vectors'],
    ['<path d="M0 0H10" style="vector-effect:non-scaling-stroke"/>', 'vector-effect'],
  ])('explains unsupported input and its recovery step: %s', async (body, hint) => {
    await expect(analyzeArtworkSource(svg(body))).rejects.toThrow(hint);
  });
  it('rejects stylesheet processing instructions instead of ignoring a visual dependency', async () => {
    await expect(
      analyzeArtworkSource(
        '<?xml-stylesheet href="https://example.test/art.css"?>' +
          svg('<rect width="5" height="5"/>'),
      ),
    ).rejects.toThrow('external stylesheet');
  });
  it('uses case-sensitive XML geometry and presentation attributes', async () => {
    const analysis = await analyzeArtworkSource(
      svg('<rect X="20" Fill="white" width="5" height="5"/>'),
    );
    expect(analysis.objects[0]!.fill).toBe('#000000');
    expect(analysis.objects[0]!.bounds!.x).toBe(0);
  });
  it('rejects missing or foreign element namespaces rather than inventing visible objects', async () => {
    await expect(
      analyzeArtworkSource('<svg width="10" height="10"><rect width="10" height="10"/></svg>'),
    ).rejects.toThrow('namespace');
    await expect(
      analyzeArtworkSource(svg('<other:rect xmlns:other="urn:other" width="5" height="5"/>')),
    ).rejects.toThrow('namespace');
    await expect(
      analyzeArtworkSource(svg('<g xmlns="urn:other"><rect width="5" height="5"/></g>')),
    ).rejects.toThrow('namespace');
  });

  it('compares CSS specificity as a tuple without carrying class counts into the ID tier', async () => {
    const classes = '.mark'.repeat(1001);
    const analysis = await analyzeArtworkSource(
      svg(
        `<style>#chosen {fill:red} ${classes} {fill:blue}</style><rect id="chosen" class="mark" width="5" height="5"/>`,
      ),
    );
    expect(analysis.objects[0]!.fill).toBe('#ff0000');
    await expect(
      analyzeArtworkSource(svg('<rect width="5" height="5" fill="red;stroke:blue"/>')),
    ).rejects.toThrow('presentation attribute');
    await expect(
      analyzeArtworkSource(svg('<rect width="5" height="5" fill="red!important"/>')),
    ).rejects.toThrow('presentation attribute');
  });
});

it('accepts explicitly declared static all-media CSS', async () => {
  const analysis = await analyzeArtworkSource(
    svg('<style media="all" type="text/css">rect{fill:blue}</style><rect width="5" height="5"/>'),
  );
  expect(analysis.objects[0]!.fill).toBe('#0000ff');
});
it('bounds expanded source labels before returning a huge reusable-object manifest', async () => {
  const source = svg(
    `<defs><g id="template"><path id="${'x'.repeat(160_000)}" d="M0 0H5V5Z"/></g></defs>${'<use href="#template"/>'.repeat(100)}`,
  );
  await expect(analyzeArtworkSource(source)).rejects.toThrow(
    /duplicated source data.*vector editor/,
  );
});
it('charges duplicated clip geometry to the expanded segment budget', async () => {
  const outline =
    'M0 0' +
    Array.from({ length: 2000 }, (_, index) => `L${index % 40} ${index % 30}`).join('') +
    'Z';
  const source = svg(
    `<defs><clipPath id="clip"><path d="${outline}"/></clipPath></defs><g clip-path="url(#clip)">${'<rect width="5" height="5"/>'.repeat(100)}</g>`,
  );
  await expect(analyzeArtworkSource(source)).rejects.toThrow(/expanded path or clipping segments/);
});
it('rejects excessive class attributes with an understandable recovery step', async () => {
  await expect(
    analyzeArtworkSource(svg(`<path class="${'x'.repeat(4097)}" d="M0 0H5V5Z"/>`)),
  ).rejects.toThrow(/attribute.*Simplify/);
});

it.each(['revert', 'revert-layer'])('explains unsupported CSS rollback: %s', async (value) => {
  await expect(
    analyzeArtworkSource(svg(`<path style="fill-rule:${value}" d="M0 0H5V5Z"/>`)),
  ).rejects.toThrow(/rollback.*Export/);
});
