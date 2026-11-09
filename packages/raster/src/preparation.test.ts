import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeArtworkSource,
  normalizeSvg,
  preparationSubpaths,
  sanitizeSvg,
  type ArtworkAnalysis,
} from '@pr/svg';
import type { ArtworkPreparationRecipe } from '@pr/design-schema';
import { previewArtworkPreparation } from './preparation.js';
import { rasterizeArtwork } from './artwork.js';
import { flattenSegments, signedArea } from './flatten.js';

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../../fixtures/artwork/preparation/${name}.svg`, import.meta.url),
    'utf8',
  );
const recipe = (analysis: ArtworkAnalysis, selected: string[]): ArtworkPreparationRecipe => ({
  sourceDigest: analysis.sourceDigest,
  analyzerVersion: analysis.analyzerVersion,
  selected: selected.map((objectId) => ({ objectId, paint: 'both' })),
  repairs: [],
  acknowledged: [],
  transforms: [],
});
const area = (svg: string): number =>
  normalizeSvg(sanitizeSvg(svg).root).paths.reduce(
    (sum, path) =>
      sum + flattenSegments(path.segments).reduce((total, ring) => total + signedArea(ring), 0),
    0,
  );
const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="30mm" viewBox="0 0 40 30">${body}</svg>`;

describe('selected visible vector coverage', () => {
  it('highlights paint changes and requires review when a repair fills or creates a counter', async () => {
    const analysis = await analyzeArtworkSource(
      svg('<path fill="none" stroke="black" stroke-width="2" d="M5 5H15V15H5Z"/>'),
    );
    const selected = recipe(analysis, ['o0']);
    selected.repairs = [{ kind: 'stroke-width', objectId: 'o0', widthMm: 12 }];
    const filled = previewArtworkPreparation(analysis, selected);
    expect(filled.repairChanges).toMatchObject({ countersBefore: 1, countersAfter: 0 });
    expect(filled.repairChanges?.svg).toContain('#127b70');
    expect(filled.issues.some((issue) => issue.code === 'repair_counters')).toBe(true);
    expect(filled.canSave).toBe(false);
    selected.acknowledged = filled.issues.map((issue) => issue.id);
    expect(previewArtworkPreparation(analysis, selected).canSave).toBe(true);
    selected.repairs.push({ kind: 'stroke-width', objectId: 'o0', widthMm: 2 });
    const reopened = previewArtworkPreparation(analysis, selected);
    expect(reopened.repairChanges).toMatchObject({ countersBefore: 0, countersAfter: 1 });
    expect(reopened.repairChanges?.svg).toContain('#ba3048');
    expect(reopened.canSave).toBe(false);
  });
  it('reports a changed counter boundary even when the counter count stays the same', async () => {
    const analysis = await analyzeArtworkSource(
      svg('<path fill="none" stroke="black" stroke-width="2" d="M5 5H15V15H5Z"/>'),
    );
    const selected = recipe(analysis, ['o0']);
    selected.repairs = [{ kind: 'stroke-width', objectId: 'o0', widthMm: 4 }];
    const changed = previewArtworkPreparation(analysis, selected);
    expect(changed.repairChanges).toMatchObject({ countersBefore: 1, countersAfter: 1 });
    expect(changed.issues.some((issue) => issue.code === 'repair_counters')).toBe(true);
  });
  it('reports paint growing inside a counter without changing its outer boundary', async () => {
    const analysis = await analyzeArtworkSource(
      svg(
        '<path fill-rule="evenodd" d="M2 2H22V22H2Z M4 4H20V20H4Z"/><path fill="none" stroke="black" stroke-width="1" d="M10 10H14V14H10Z"/>',
      ),
    );
    const selected = recipe(analysis, ['o0', 'o1']);
    selected.repairs = [{ kind: 'stroke-width', objectId: 'o1', widthMm: 2 }];
    const changed = previewArtworkPreparation(analysis, selected);
    expect(changed.issues.some((issue) => issue.code === 'repair_counters')).toBe(true);
    expect(changed.canSave).toBe(false);
  });
  it('starts empty and retains contrasting monogram paint with overlaid counters', async () => {
    const analysis = await analyzeArtworkSource(fixture('monogram'));
    const empty = previewArtworkPreparation(analysis, recipe(analysis, []));
    expect(empty.canSave).toBe(false);
    expect(empty.svg).toBeNull();
    const result = previewArtworkPreparation(analysis, recipe(analysis, ['o1', 'o3']));
    expect(result.issues).toEqual([]);
    expect(result.canSave).toBe(true);
    expect(area(result.svg!)).toBeCloseTo(13 * 20 - 5 * 6 + 4 * 20 + 9 * 4, 4);
    expect(result.boundsMm).toMatchObject({ w: 30, h: 20 });
    const artwork = normalizeSvg(sanitizeSvg(result.svg!).root);
    const mask = rasterizeArtwork(artwork, { mmPerPx: 0.05 })!;
    const x = Math.round((10 - 5) / mask.mmPerPx) + mask.paddingPx;
    const y = Math.round((11 - 5) / mask.mmPerPx) + mask.paddingPx;
    expect(mask.mask.data[y * mask.mask.width + x]).toBe(0);
  });
  it('retains only the visible rim without repainting the unselected occluder', async () => {
    const analysis = await analyzeArtworkSource(fixture('occluded-rim'));
    const result = previewArtworkPreparation(analysis, recipe(analysis, ['o0']));
    expect(result.canSave).toBe(true);
    expect(area(result.svg!)).toBeCloseTo(Math.PI * (13 ** 2 - 10 ** 2), 0);
    const mask = rasterizeArtwork(normalizeSvg(sanitizeSvg(result.svg!).root), { mmPerPx: 0.05 })!;
    expect(
      mask.mask.data[
        Math.floor(mask.mask.height / 2) * mask.mask.width + Math.floor(mask.mask.width / 2)
      ],
    ).toBe(0);
  });
  it('keeps compound fill rules and independently selected clipped reuse instances', async () => {
    const analysis = await analyzeArtworkSource(fixture('compound-and-reuse'));
    const first = previewArtworkPreparation(analysis, recipe(analysis, ['o0']));
    expect(first.canSave).toBe(true);
    expect(area(first.svg!)).toBeCloseTo(48, 4);
    const clipped = previewArtworkPreparation(analysis, recipe(analysis, ['o2']));
    expect(clipped.canSave).toBe(true);
    expect(area(clipped.svg!)).toBeCloseTo(28, 4);
    expect(analysis.objects[0]!.segments).toEqual(analysis.objects[1]!.segments);
  });
  it('honors each object fill rule before compositing and clips to the source canvas', async () => {
    const analysis = await analyzeArtworkSource(
      svg('<path fill-rule="evenodd" d="M-5 -5H20V20H-5ZM2 2H10V10H2Z"/>'),
    );
    const result = previewArtworkPreparation(analysis, recipe(analysis, ['o0']));
    expect(result.canSave).toBe(true);
    expect(area(result.svg!)).toBeCloseTo(400 - 64, 4);
  });
  it('preserves source open flags through ordinary stroke selection and preparation', async () => {
    const analysis = await analyzeArtworkSource(fixture('open-paths'));
    const result = previewArtworkPreparation(analysis, recipe(analysis, ['o0']));
    expect(result.canSave).toBe(true);
    expect(result.recipe.repairs).toEqual([]);
    expect(preparationSubpaths(result.objects[0]!)[0]!.closed).toBe(false);
    expect(result.sourceSvg).toContain('stroke-linecap="round"');
    expect(area(result.svg!)).toBeGreaterThan(16);
    expect(preparationSubpaths(analysis.objects[0]!)[0]!.closed).toBe(false);
  });
  it('requires explicit acceptance of implicit open fill and expires it after a repair', async () => {
    const analysis = await analyzeArtworkSource(svg('<path d="M2 2H12V12"/>'));
    const selected = recipe(analysis, ['o0']);
    const before = previewArtworkPreparation(analysis, selected);
    expect(before.canSave).toBe(false);
    expect(before.issues[0]!.code).toBe('implicit_fill');
    selected.acknowledged = before.issues.map((issue) => issue.id);
    expect(previewArtworkPreparation(analysis, selected).canSave).toBe(true);
    selected.repairs = [{ kind: 'stroke-width', objectId: 'o0', widthMm: 1 }];
    expect(previewArtworkPreparation(analysis, selected).canSave).toBe(false);
    selected.repairs = [{ kind: 'close', objectId: 'o0', subpathId: 'o0:s0' }];
    const closed = previewArtworkPreparation(analysis, selected);
    expect(closed.canSave).toBe(true);
    expect(closed.issues).toEqual([]);
    expect(preparationSubpaths(closed.objects[0]!)[0]!.closed).toBe(true);
  });
  it('distinguishes fill and stroke and preserves nonuniform stroke scaling', async () => {
    const analysis = await analyzeArtworkSource(
      svg(
        '<path fill="white" stroke="black" stroke-width="2" transform="scale(2 1)" d="M2 2H8V8H2Z"/>',
      ),
    );
    const selected = recipe(analysis, ['o0']);
    selected.selected[0]!.paint = 'fill';
    const fill = previewArtworkPreparation(analysis, selected);
    expect(fill.canSave).toBe(true);
    expect(area(fill.svg!)).toBeCloseTo(4 * 4 * 2, 4);
    selected.selected[0]!.paint = 'stroke';
    const stroke = previewArtworkPreparation(analysis, selected);
    expect(stroke.canSave).toBe(true);
    expect(area(stroke.svg!)).toBeCloseTo((8 * 8 - 4 * 4) * 2, 4);
  });
  it('keeps formal closure separate from coincident endpoint cap appearance', async () => {
    const analysis = await analyzeArtworkSource(
      svg(
        '<path fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" d="M5 5H15V15H5L5 5"/>',
      ),
    );
    const selected = recipe(analysis, ['o0']);
    const open = previewArtworkPreparation(analysis, selected);
    selected.repairs = [{ kind: 'close', objectId: 'o0', subpathId: 'o0:s0' }];
    const closed = previewArtworkPreparation(analysis, selected);
    expect(open.canSave).toBe(true);
    expect(closed.canSave).toBe(true);
    expect(area(open.svg!)).toBeGreaterThan(area(closed.svg!));
  });
  it('keeps joined outlines dependent and does not change occlusion when an applied repair is excluded', async () => {
    const analysis = await analyzeArtworkSource(
      svg(
        '<path fill="none" stroke="white" d="M2 5H8"/><path fill="none" stroke="white" d="M10 5H16"/>',
      ),
    );
    const selected = recipe(analysis, ['o0', 'o1']);
    selected.repairs = [
      {
        kind: 'join',
        a: { objectId: 'o0', subpathId: 'o0:s0', end: 'end' },
        b: { objectId: 'o1', subpathId: 'o1:s0', end: 'start' },
      },
    ];
    expect(previewArtworkPreparation(analysis, selected).canSave).toBe(true);
    selected.selected.pop();
    expect(() => previewArtworkPreparation(analysis, selected)).toThrow(
      'kept or excluded together',
    );
    const layered = await analyzeArtworkSource(
      svg('<rect fill="white" width="20" height="20"/><path fill="black" d="M0 0H10V10"/>'),
    );
    const chosen = recipe(layered, ['o0']);
    const before = previewArtworkPreparation(layered, chosen);
    chosen.repairs = [{ kind: 'close', objectId: 'o1', subpathId: 'o1:s0' }];
    expect(previewArtworkPreparation(layered, chosen).svg).toBe(before.svg);
  });
  it('binds recipes to the analyzed source and rejects stale or invented IDs', async () => {
    const analysis = await analyzeArtworkSource(fixture('monogram'));
    expect(() =>
      previewArtworkPreparation(analysis, {
        ...recipe(analysis, ['o1']),
        sourceDigest: '0'.repeat(64),
      }),
    ).toThrow('different source');
    expect(() => previewArtworkPreparation(analysis, recipe(analysis, ['invented']))).toThrow(
      'unknown object',
    );
  });
  it('expands dashed strokes at exact offsets, including odd patterns and round dots', async () => {
    const analysis = await analyzeArtworkSource(
      svg(
        '<path fill="none" stroke="black" stroke-width="2" stroke-dasharray="2 3" stroke-dashoffset="1" d="M2 5H18"/>',
      ),
    );
    expect(area(previewArtworkPreparation(analysis, recipe(analysis, ['o0'])).svg!)).toBeCloseTo(
      14,
      4,
    );
    const dots = await analyzeArtworkSource(
      svg(
        '<path fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-dasharray="0 5" d="M2 5H18"/>',
      ),
    );
    expect(area(previewArtworkPreparation(dots, recipe(dots, ['o0'])).svg!)).toBeCloseTo(
      4 * Math.PI,
      1,
    );
    const odd = await analyzeArtworkSource(
      svg('<path fill="none" stroke="black" stroke-width="2" stroke-dasharray="2" d="M2 5H18"/>'),
    );
    expect(area(previewArtworkPreparation(odd, recipe(odd, ['o0'])).svg!)).toBeCloseTo(16, 4);
  });
  it('preserves a small arc after enlargement within the output detail budget', async () => {
    const analysis = await analyzeArtworkSource(svg('<circle cx="5" cy="5" r="0.05"/>'));
    const selected = recipe(analysis, ['o0']);
    selected.transforms = [
      { widthMm: 100, heightMm: 100, rotationDeg: 0, flipX: false, flipY: false },
    ];
    const result = previewArtworkPreparation(analysis, selected);
    expect(result.canSave).toBe(true);
    expect(result.boundsMm!.w).toBeCloseTo(100, 4);
    expect(area(result.svg!)).toBeCloseTo(Math.PI * 50 ** 2, 0);
  });
  it('reports a closure crossing before its painted appearance can be accepted', async () => {
    const analysis = await analyzeArtworkSource(
      svg('<path fill="none" stroke="black" d="M2 2L2 12L12 2L12 12"/>'),
    );
    const selected = recipe(analysis, ['o0']);
    expect(previewArtworkPreparation(analysis, selected).issues).toEqual([]);
    selected.repairs = [{ kind: 'close', objectId: 'o0', subpathId: 'o0:s0' }];
    const after = previewArtworkPreparation(analysis, selected);
    expect(after.issues.some((issue) => issue.code === 'repair_crossing')).toBe(true);
    expect(after.canSave).toBe(false);
    selected.acknowledged = after.issues.map((issue) => issue.id);
    expect(previewArtworkPreparation(analysis, selected).canSave).toBe(true);
  });
});

describe('the geometry budget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives a drawing the same answer however slow the machine is', async () => {
    const analysis = await analyzeArtworkSource(fixture('styled-strokes'));
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 10_000));
    const result = previewArtworkPreparation(analysis, recipe(analysis, ['o0', 'o1', 'o2', 'o3']));
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.canSave).toBe(true);
  });

  it('stops clean-up that runs away, with the reason, instead of hanging', async () => {
    const wave = (y: number) =>
      `<path d="M3 ${y}C20 ${y - 30} 40 ${y + 30} 60 ${y}S80 ${y - 20} 97 ${y}" fill="none" ` +
      `stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    const analysis = await analyzeArtworkSource(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">` +
        `${wave(20)}${wave(50)}${wave(80)}</svg>`,
    );
    const result = previewArtworkPreparation(
      analysis,
      recipe(
        analysis,
        analysis.objects.map((object) => object.id),
      ),
    );
    expect(result.canSave).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContainEqual(
      expect.stringContaining('processing limit'),
    );
  }, 60_000);
});
