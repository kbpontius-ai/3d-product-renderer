import { encodeGray8Png, encodeGray16Png, encodeRgbaPng } from '@pr/artwork/png';
import { describe, expect, it } from 'vitest';
import { grayToBytes, rgbaFromPng } from './image.js';

describe('rgbaFromPng', () => {
  it('reads an 8-bit colour render', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]);
    const image = rgbaFromPng(encodeRgbaPng(rgba, 2, 1));

    expect(image.width).toBe(2);
    expect(Array.from(image.rgba)).toEqual([255, 0, 0, 255, 0, 0, 255, 128]);
  });

  it('widens a 16-bit render rather than refusing it', () => {
    // The default render format is png16; comparing it must not need a second render.
    const image = rgbaFromPng(encodeGray16Png(new Uint16Array([0, 32768, 65535, 65535]), 2, 2));

    expect(image.rgba[0]).toBe(0);
    expect(image.rgba[4]).toBeCloseTo(128, -1);
    expect(image.rgba[8]).toBe(255);
  });

  it('spreads a greyscale PNG across all three channels, so it greys back to itself', () => {
    const image = rgbaFromPng(encodeGray8Png(new Uint8Array([40, 200]), 2, 1));

    expect(Array.from(image.rgba.subarray(0, 4))).toEqual([40, 40, 40, 255]);
    expect(Array.from(image.rgba.subarray(4, 8))).toEqual([200, 200, 200, 255]);
  });
});

describe('grayToBytes', () => {
  it('inverts, so agreement is white and the eye goes to the disagreement', () => {
    const bytes = grayToBytes({ width: 2, height: 1, data: new Float32Array([0, 1]) });
    expect(Array.from(bytes)).toEqual([255, 0]);
  });

  it('clamps rather than wrapping around', () => {
    const bytes = grayToBytes({ width: 2, height: 1, data: new Float32Array([-0.5, 2]) }, { invert: false });
    expect(Array.from(bytes)).toEqual([0, 255]);
  });
});
