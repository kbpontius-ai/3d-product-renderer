import { describe, expect, it } from 'vitest';
import type { Finish, MaterialDefinition } from '@pr/design-schema';
import { MaterialDefinition as MaterialSchema } from '@pr/design-schema';
import { LEGACY_INK, inkShading } from './ink.js';

// Loosely typed on purpose: zod fills the rest of `base` with its own defaults, and restating a
// dozen PBR fields per fixture would bury what each one is actually testing.
const material = (over: Record<string, unknown> & { key: string }): MaterialDefinition =>
  MaterialSchema.parse({
    name: over.key,
    family: 'ink',
    base: { baseColorHex: '#101010', roughness: 0.55, metallic: 0 },
    ...over,
  });

const LIBRARY: Record<string, MaterialDefinition> = {
  'ink-black': material({ key: 'ink-black' }),
  'foil-gold': material({
    key: 'foil-gold',
    family: 'foil',
    base: { baseColorHex: '#c9a227', roughness: 0.18, metallic: 1 },
  }),
  'varnish-gloss': material({
    key: 'varnish-gloss',
    family: 'coating',
    colorizable: false,
    base: { baseColorHex: '#ffffff', roughness: 0.04, metallic: 0 },
  }),
};

const relief = (over: Partial<Finish> = {}): Finish =>
  ({ kind: 'emboss', depthMm: 0.3, bevelDeg: 30, edgeRadiusMm: 0.05, ...over }) as Finish;

describe('inkShading', () => {
  it('is nothing at all for a blind relief', () => {
    // Depth in the part's own material: the default, and the "same as the part" the feature asks
    // for. Expressed as the absence of a choice rather than as a choice that means absence.
    expect(inkShading(relief(), LIBRARY)).toBeNull();
  });

  it('takes its numbers from the material the design chose', () => {
    const foil = inkShading(relief({ inkMaterialKey: 'foil-gold', tintHex: '#c9a227' }), LIBRARY)!;
    expect(foil.roughness).toBe(0.18);
    expect(foil.metallic).toBe(1);

    // The point of the change: two marks on the same part, shaded differently, because the design
    // named two different materials rather than because one is printed and one is not.
    const varnish = inkShading(relief({ inkMaterialKey: 'varnish-gloss' }), LIBRARY)!;
    expect(varnish.roughness).toBe(0.04);
    expect(varnish.metallic).toBe(0);
  });

  it('lets a clear coating gloss the mark without painting it', () => {
    // A matte part with a gloss-varnished emboss is the case this exists for. The varnish covers
    // the artwork and changes how it takes the light; it does not make the artwork white.
    const varnish = inkShading(relief({ inkMaterialKey: 'varnish-gloss' }), LIBRARY)!;
    expect(varnish.tintStrength).toBe(0);

    // Unless somebody asked for a colour, in which case they meant it.
    const tinted = inkShading(
      relief({ inkMaterialKey: 'varnish-gloss', tintHex: '#ff0000' }),
      LIBRARY,
    )!;
    expect(tinted.tintStrength).toBe(1);
    expect(tinted.colorHex).toBe('#ff0000');
  });

  it('paints with every family that is not a coating', () => {
    for (const key of ['ink-black', 'foil-gold']) {
      expect(inkShading(relief({ inkMaterialKey: key }), LIBRARY)!.tintStrength).toBe(1);
    }
  });

  it('reproduces the constants it replaced, for a design that named nothing', () => {
    // The two pairs were `ink-black` and `foil-gold` copied out of the fixture pack. Anything
    // stored before the picker did anything must render exactly as it always has, or this change
    // quietly restyles every design in the catalog.
    const print = inkShading({ kind: 'print', inkMaterialKey: 'gone', opacity: 1 } as Finish, {})!;
    expect(print.roughness).toBe(LEGACY_INK.print.roughness);
    expect(print.metallic).toBe(LEGACY_INK.print.metallic);

    const missing = inkShading(relief({ inkMaterialKey: 'gone', tintHex: '#101010' }), {})!;
    expect(missing.roughness).toBe(LEGACY_INK.relief.roughness);
    expect(missing.metallic).toBe(LEGACY_INK.relief.metallic);
    // And says it fell back, so a caller that wants to warn about a republished pack can.
    expect(missing.materialKey).toBeNull();
  });

  it('reads a Map and a record the same way', () => {
    // The render spec builds a Map of resolved materials; the editor holds a plain record. One
    // resolver serving both is the whole point, so it has to accept both.
    const asMap = new Map(Object.entries(LIBRARY));
    const finish = relief({ inkMaterialKey: 'varnish-gloss' });
    expect(inkShading(finish, asMap)).toEqual(inkShading(finish, LIBRARY));
  });

  it("carries a printed mark's opacity through", () => {
    const print = inkShading(
      { kind: 'print', inkMaterialKey: 'ink-black', opacity: 0.4 } as Finish,
      LIBRARY,
    )!;
    expect(print.opacity).toBe(0.4);
    // Relief is laid into a cut, not printed thin: there is no partial coverage to express.
    expect(inkShading(relief({ inkMaterialKey: 'ink-black' }), LIBRARY)!.opacity).toBe(1);
  });
});
