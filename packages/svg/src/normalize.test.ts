import { describe, expect, it } from 'vitest';
import { lengthToMm, normalizeSvg, serializeNormalized, totalNodeCount } from './normalize.js';
import { pathBBox } from './path.js';
import { sanitizeSvg } from './sanitize.js';

const prepare = (body: string, attrs = 'viewBox="0 0 100 50" width="100mm" height="50mm"') =>
  normalizeSvg(sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`).root);

describe('lengthToMm', () => {
  it('converts every unit we accept', () => {
    expect(lengthToMm('10mm', 0)).toBe(10);
    expect(lengthToMm('1cm', 0)).toBe(10);
    expect(lengthToMm('1in', 0)).toBeCloseTo(25.4, 9);
    expect(lengthToMm('72pt', 0)).toBeCloseTo(25.4, 9);
    expect(lengthToMm('96px', 0)).toBeCloseTo(25.4, 9);
    expect(lengthToMm('96', 0)).toBeCloseTo(25.4, 9); // unitless is CSS pixels
  });

  it('falls back when the value is missing or relative', () => {
    expect(lengthToMm(undefined, 42)).toBe(42);
    expect(lengthToMm('50%', 42)).toBe(42);
    expect(lengthToMm('banana', 42)).toBe(42);
  });
});

describe('normalizeSvg', () => {
  it('reads the physical size and derives user units per millimetre', () => {
    const artwork = prepare('<path d="M0 0L10 10"/>');
    expect(artwork.naturalSizeMm).toEqual({ w: 100, h: 50 });
    expect(artwork.unitsPerMm).toBeCloseTo(1, 9);
  });

  it('handles a viewBox that is not one-to-one with millimetres', () => {
    const artwork = prepare('<path d="M0 0L10 10"/>', 'viewBox="0 0 200 100" width="100mm" height="50mm"');
    expect(artwork.unitsPerMm).toBeCloseTo(2, 9);
  });

  it('falls back to CSS pixels when no physical size is declared', () => {
    const artwork = prepare('<path d="M0 0L10 10"/>', 'viewBox="0 0 96 96"');
    expect(artwork.naturalSizeMm.w).toBeCloseTo(25.4, 6);
  });

  describe('shapes become paths', () => {
    it('converts a rect', () => {
      const artwork = prepare('<rect x="10" y="5" width="20" height="10"/>');
      expect(artwork.paths).toHaveLength(1);
      expect(pathBBox(artwork.paths[0]!.segments)).toEqual({ x: 10, y: 5, w: 20, h: 10 });
    });

    it('converts a rounded rect without exceeding its bounds', () => {
      const artwork = prepare('<rect x="0" y="0" width="20" height="10" rx="3"/>');
      const box = pathBBox(artwork.paths[0]!.segments)!;
      expect(box.x).toBeCloseTo(0, 3);
      expect(box.w).toBeCloseTo(20, 3);
      expect(box.h).toBeCloseTo(10, 3);
    });

    it('converts a circle', () => {
      const artwork = prepare('<circle cx="20" cy="20" r="8"/>');
      const box = pathBBox(artwork.paths[0]!.segments)!;
      expect(box.x).toBeCloseTo(12, 2);
      expect(box.w).toBeCloseTo(16, 2);
    });

    it('converts polygons and polylines, closing only the polygon', () => {
      const polygon = prepare('<polygon points="0,0 10,0 10,10"/>');
      const polyline = prepare('<polyline points="0,0 10,0 10,10"/>');
      expect(polygon.paths[0]!.closed).toBe(true);
      expect(polyline.paths[0]!.closed).toBe(false);
    });

    it('drops degenerate shapes', () => {
      expect(prepare('<rect width="0" height="10"/>').paths).toHaveLength(0);
      expect(prepare('<circle r="0"/>').paths).toHaveLength(0);
    });
  });

  describe('transforms', () => {
    it('bakes group transforms into the geometry', () => {
      const artwork = prepare('<g transform="translate(10 10)"><rect width="10" height="10"/></g>');
      expect(pathBBox(artwork.paths[0]!.segments)).toEqual({ x: 10, y: 10, w: 10, h: 10 });
    });

    it('composes nested transforms', () => {
      const artwork = prepare(
        '<g transform="translate(10 0)"><g transform="scale(2)"><rect width="5" height="5"/></g></g>',
      );
      expect(pathBBox(artwork.paths[0]!.segments)).toEqual({ x: 10, y: 0, w: 10, h: 10 });
    });

    it('scales stroke widths with the transform', () => {
      const artwork = prepare('<g transform="scale(4)"><path d="M0 0L1 0" stroke="#000" stroke-width="0.5"/></g>');
      expect(artwork.paths[0]!.strokeWidth).toBeCloseTo(2, 6);
    });
  });

  describe('references and visibility', () => {
    it('resolves <use> against elements in the document', () => {
      const artwork = prepare(
        '<defs><rect id="tile" width="10" height="10"/></defs><use href="#tile" x="20" y="5"/>',
      );
      expect(artwork.paths).toHaveLength(1);
      expect(pathBBox(artwork.paths[0]!.segments)).toEqual({ x: 20, y: 5, w: 10, h: 10 });
    });

    it('counts references it could not resolve instead of drawing nothing silently', () => {
      const artwork = prepare('<use href="#missing"/><rect width="4" height="4"/>');
      expect(artwork.unresolvedReferences).toBe(1);
      expect(artwork.paths).toHaveLength(1);
    });

    it('skips defs, masks and clip paths as drawable content', () => {
      const artwork = prepare('<defs><rect width="10" height="10"/></defs><clipPath><circle r="5"/></clipPath>');
      expect(artwork.paths).toHaveLength(0);
    });

    it('honours display:none and zero opacity', () => {
      expect(prepare('<rect width="10" height="10" style="display:none"/>').paths).toHaveLength(0);
      expect(prepare('<rect width="10" height="10" opacity="0"/>').paths).toHaveLength(0);
    });

    it('inherits fill down the tree', () => {
      const artwork = prepare('<g fill="#123456"><rect width="4" height="4"/></g>');
      expect(artwork.paths[0]!.fill).toBe('#123456');
    });

    it('notices gradient fills', () => {
      const artwork = prepare(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>' +
          '<rect width="10" height="10" fill="url(#g)"/>',
      );
      expect(artwork.usedGradient).toBe(true);
    });
  });

  it('measures the content bounding box across all paths', () => {
    const artwork = prepare('<rect x="0" y="0" width="10" height="10"/><rect x="30" y="5" width="10" height="10"/>');
    expect(artwork.contentBBox).toEqual({ x: 0, y: 0, w: 40, h: 15 });
    expect(totalNodeCount(artwork)).toBeGreaterThan(0);
  });

  it('emits a minimal svg containing only geometry', () => {
    const artwork = prepare('<g transform="translate(5 5)"><rect width="10" height="10" fill="#abcdef"/></g>');
    const output = serializeNormalized(artwork);
    expect(output).toContain('<path d=');
    expect(output).toContain('fill="#abcdef"');
    expect(output).toContain('width="100mm"');
    expect(output).not.toContain('<g');
    expect(output).not.toContain('transform');
  });

  it('keeps decoded paint values inside their XML attributes', () => {
    const artwork = prepare(
      '<rect width="10" height="10" fill="black&quot; onload=&quot;alert(1)" stroke="black&quot; onclick=&quot;alert(1)"/>',
    );
    const output = serializeNormalized(artwork);
    expect(output).not.toContain(' onload="');
    expect(output).not.toContain(' onclick="');
    expect(output).toContain('&quot;');
  });
});
