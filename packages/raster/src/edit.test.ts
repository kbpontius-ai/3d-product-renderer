import { describe, expect, it } from 'vitest';
import { normalizeSvg, sanitizeSvg } from '@pr/svg';
import { transformArtworkSvg } from './edit.js';
import { ArtworkEdit } from '@pr/design-schema';

const normalize = (source: string) => normalizeSvg(sanitizeSvg(source).root);
const triangle = normalize(
  '<svg width="60mm" height="40mm" viewBox="0 0 60 40"><path d="M10 5 L40 5 L10 25 Z"/></svg>',
);
const base = { widthMm: 30, heightMm: 20, rotationDeg: 0, flipX: false, flipY: false };

describe('whole-artwork edits', () => {
  it('sizes the visible artwork rather than the document padding', () => {
    const result = normalize(transformArtworkSvg(triangle, { ...base, widthMm: 24, heightMm: 16 }));
    expect(result.naturalSizeMm.w).toBeCloseTo(24, 4);
    expect(result.naturalSizeMm.h).toBeCloseTo(16, 4);
    expect(result.contentBBox?.w).toBeCloseTo(24, 4);
    expect(result.contentBBox?.h).toBeCloseTo(16, 4);
    expect(result.unitsPerMm).toBe(1);
  });

  it('rotates around the centre and expands the canvas without clipping', () => {
    const result = normalize(transformArtworkSvg(triangle, { ...base, rotationDeg: 90 }));
    expect(result.naturalSizeMm.w).toBeCloseTo(20, 4);
    expect(result.naturalSizeMm.h).toBeCloseTo(30, 4);
    for (const key of ['x', 'y', 'w', 'h'] as const)
      expect(result.viewBox[key]).toBeCloseTo(result.contentBBox![key], 4);
    expect(result.paths[0]?.segments[0]).toEqual({ command: 'M', values: [10, -15] });
  });

  it('flips the geometry, and flipping the saved result again restores it', () => {
    const once = normalize(transformArtworkSvg(triangle, { ...base, flipX: true }));
    const twice = normalize(transformArtworkSvg(once, { ...base, flipX: true }));
    const original = normalize(transformArtworkSvg(triangle, base));
    expect(once.paths).not.toEqual(original.paths);
    expect(twice.paths).toEqual(original.paths);
    const both = normalize(transformArtworkSvg(triangle, { ...base, flipX: true, flipY: true }));
    const restored = normalize(transformArtworkSvg(both, { ...base, flipX: true, flipY: true }));
    expect(restored.paths).toEqual(original.paths);
  });

  it('supports curves, and preserves stroke geometry through a proportional resize', () => {
    const source = normalize(
      '<svg width="20mm" height="20mm" viewBox="0 0 20 20"><path d="M5 5 C5 0 15 0 15 5 L15 15 L5 15Z" fill="none" stroke="black" stroke-width="2"/></svg>',
    );
    const result = normalize(
      transformArtworkSvg(source, { ...base, widthMm: 24, heightMm: source.contentBBox!.h * 2 }),
    );
    expect(result.paths.every((path) => path.stroke === null)).toBe(true);
    expect(result.paths.some((path) => path.fill !== null)).toBe(true);
    expect(result.naturalSizeMm.w).toBeCloseTo(24);
  });

  it('stretches stroked artwork to the requested visible dimensions', () => {
    const source = normalize(
      '<svg width="20mm" height="20mm" viewBox="0 0 20 20"><path d="M5 5L15 5L15 15L5 15Z" fill="none" stroke="black" stroke-width="2"/></svg>',
    );
    const result = normalize(transformArtworkSvg(source, { ...base, widthMm: 48, heightMm: 12 }));
    expect(result.naturalSizeMm.w).toBeCloseTo(48, 3);
    expect(result.naturalSizeMm.h).toBeCloseTo(12, 3);
  });

  it('refuses invalid edits at the HTTP/domain boundary', () => {
    const edit = { ...base, name: 'Logo', versionId: '00000000-0000-7000-8000-000000000001' };
    expect(ArtworkEdit.safeParse(edit).success).toBe(true);
    for (const patch of [
      { widthMm: 0 },
      { heightMm: -1 },
      { widthMm: Infinity },
      { rotationDeg: NaN },
      { name: ' ' },
      { versionId: 'bad' },
      { flipX: 'yes' },
    ]) {
      expect(ArtworkEdit.safeParse({ ...edit, ...patch }).success).toBe(false);
    }
  });
});
