import { describe, expect, it } from 'vitest';
import { prepareArtwork } from '@pr/svg';
import { testPatternSvg } from './test-pattern.js';

/**
 * The QA pattern is only useful if the real pipeline accepts it: a zone check that failed because
 * the checking asset was rejected would say nothing about the zone.
 */

describe('testPatternSvg', () => {
  it('is accepted by the artwork pipeline, like any uploaded logo', () => {
    const prepared = prepareArtwork(testPatternSvg({ widthMm: 30, heightMm: 30 }));

    expect(prepared.status).not.toBe('rejected');
    expect(prepared.report.stats.hasText).toBe(false);
    expect(prepared.report.stats.pathCount).toBeGreaterThan(5);
  });

  it('measures in millimetres, so a placed pattern is a ruler', () => {
    const prepared = prepareArtwork(testPatternSvg({ widthMm: 40, heightMm: 25 }));

    expect(prepared.report.stats.naturalSizeMm.w).toBeCloseTo(40, 1);
    expect(prepared.report.stats.naturalSizeMm.h).toBeCloseTo(25, 1);
  });

  it('breaks every symmetry, so a flip or a rotation cannot hide', () => {
    const svg = testPatternSvg({ widthMm: 30, heightMm: 30 });

    // Four different corner shapes, and an arrow that only points one way.
    expect(svg).toContain('<circle');
    expect(svg).toContain('<polygon');
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(svg).toContain('fill="none"');
  });

  it('chooses a grid pitch that suits the zone rather than one fixed number', () => {
    const small = testPatternSvg({ widthMm: 20, heightMm: 20 });
    const large = testPatternSvg({ widthMm: 200, heightMm: 120 });

    const count = (svg: string) => (svg.match(/<line/g) ?? []).length;
    // A 20 mm zone at 5 mm and a 200x120 zone at 10 mm: both readable, neither a solid black square.
    expect(count(small)).toBeLessThan(count(large));
    expect(count(small)).toBeGreaterThan(4);
  });
});
