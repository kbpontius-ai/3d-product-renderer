import { describe, expect, it } from 'vitest';
import { decode16, encode16, heightMm, signedDistanceFieldMm, type FinishParams } from '@pr/artwork';
import { decodeGrayPng, encodeGray16Png, encodeGray8Png } from '@pr/artwork/png';
import { placementFixture } from '@pr/design-schema/fixtures';
import { bakePlacement, HEIGHT_ENCODE_RANGE_MM } from './bake.js';

/**
 * The bake is the parity hand-off: what Cycles displaces must be what the preview shades.
 *
 * So the test that matters is not "does it produce a PNG" but "does every sample equal `heightMm`
 * of the same distance" — the one function both renderers are supposed to agree on.
 */

const WIDTH = 24;
const HEIGHT = 16;
const MM_PER_PX = 0.05;

/** A filled disc, the simplest mark with a real edge. */
function discMask(): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const dx = x - WIDTH / 2;
      const dy = y - HEIGHT / 2;
      data[y * WIDTH + x] = Math.hypot(dx, dy) < 5 ? 255 : 0;
    }
  }
  return { data, width: WIDTH, height: HEIGHT };
}

const source = () => {
  const mask = discMask();
  const field = signedDistanceFieldMm(mask, MM_PER_PX);
  const range: [number, number] = [field.minMm, field.maxMm];
  const encoded = new Uint16Array(field.data.length);
  for (let i = 0; i < encoded.length; i++) encoded[i] = encode16(field.data[i]!, range);

  return {
    field,
    sdfRangeMm: range,
    sdfPng: encodeGray16Png(encoded, field.width, field.height),
    maskPng: encodeGray8Png(mask.data, mask.width, mask.height),
  };
};

describe('bakePlacement', () => {
  const finish: FinishParams = { kind: 'deboss', depthMm: 0.35, bevelDeg: 30, edgeRadiusMm: 0.05 };
  const placement = placementFixture({ finish: { ...finish, kind: 'deboss' } });

  it('bakes exactly the profile the preview shades', () => {
    const src = source();
    const baked = bakePlacement(placement, src);
    const decoded = decodeGrayPng(baked.png);

    let worstMm = 0;
    for (let i = 0; i < decoded.data.length; i++) {
      const expected = heightMm(src.field.data[i]!, finish);
      const actual = decode16(decoded.data[i]!, HEIGHT_ENCODE_RANGE_MM as [number, number]);
      worstMm = Math.max(worstMm, Math.abs(actual - expected));
    }

    // The only loss is the 16-bit encoding of a 10 mm span: half a step is 76 nanometres.
    expect(worstMm).toBeLessThan(1e-4);
  });

  it('carries the range it encoded with, so Blender decodes it exactly', () => {
    const baked = bakePlacement(placement, source());
    expect(baked.rangeMm).toEqual(HEIGHT_ENCODE_RANGE_MM);
    expect(decodeGrayPng(baked.png).text['heightRangeMm']).toBe('-5,5');
  });

  it('is flat outside the mark, to within one encoding step', () => {
    const src = source();
    const decoded = decodeGrayPng(bakePlacement(placement, src).png);
    const corner = decode16(decoded.data[0]!, HEIGHT_ENCODE_RANGE_MM as [number, number]);

    // Zero lands between two 16-bit codes across a 10 mm range, so "flat" is 76 nanometres of
    // displacement — six orders of magnitude below anything a bevel or a wavelength cares about.
    const halfStep = (HEIGHT_ENCODE_RANGE_MM[1] - HEIGHT_ENCODE_RANGE_MM[0]) / 65535 / 2;
    expect(Math.abs(corner)).toBeLessThanOrEqual(halfStep);
  });

  it('cuts inwards for a deboss and outwards for an emboss', () => {
    const src = source();
    const centre = (HEIGHT / 2) * WIDTH + WIDTH / 2;
    const read = (kind: 'emboss' | 'deboss') =>
      decode16(
        decodeGrayPng(bakePlacement(placementFixture({ finish: { ...finish, kind } }), src).png)
          .data[centre]!,
        HEIGHT_ENCODE_RANGE_MM as [number, number],
      );

    expect(read('deboss')).toBeLessThan(0);
    expect(read('emboss')).toBeGreaterThan(0);
    expect(read('emboss')).toBeCloseTo(-read('deboss'), 6);
  });

  it('bakes a printed finish as coverage, not as relief', () => {
    const printed = placementFixture({
      finish: { kind: 'print', inkMaterialKey: 'ink-black', opacity: 1 },
    });
    const baked = bakePlacement(printed, source());

    expect(baked.kind).toBe('ink');
    expect(decodeGrayPng(baked.png).bitDepth).toBe(8);
    expect(baked.rangeMm).toBeUndefined();
  });
});
