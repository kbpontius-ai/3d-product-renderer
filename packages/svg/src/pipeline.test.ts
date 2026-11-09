import { describe, expect, it } from 'vitest';
import { prepareArtwork, PIPELINE_VERSION } from './pipeline.js';

const doc = (body: string, attrs = 'viewBox="0 0 100 50" width="100mm" height="50mm"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

const codes = (result: ReturnType<typeof prepareArtwork>) => ({
  errors: result.report.errors.map((e) => e.code),
  warnings: result.report.warnings.map((w) => w.code),
});

describe('prepareArtwork', () => {
  it('accepts ordinary vector artwork and reports its measurements', () => {
    const result = prepareArtwork(doc('<rect x="10" y="10" width="30" height="20" fill="#000"/>'));
    expect(result.status).toBe('ready');
    expect(result.report.pipelineVersion).toBe(PIPELINE_VERSION);
    expect(result.report.stats.pathCount).toBe(1);
    expect(result.report.stats.naturalSizeMm).toEqual({ w: 100, h: 50 });
    expect(result.report.stats.contentBbox).toEqual({ x: 10, y: 10, w: 30, h: 20 });
    expect(result.svg).toContain('<path');
  });

  it('cleans hostile content but still accepts the drawing underneath it', () => {
    const result = prepareArtwork(
      doc('<script>steal()</script><rect width="10" height="10" onclick="x()" fill="#000"/>'),
    );
    expect(result.status).toBe('ready');
    expect(result.svg).not.toContain('script');
    expect(codes(result).warnings).toContain('filters_dropped');
  });

  describe('rejections', () => {
    it('refuses files that are not SVG', () => {
      expect(codes(prepareArtwork('%PDF-1.7 …')).errors).toContain('not_svg');
      expect(codes(prepareArtwork('<html><body/></html>')).errors).toContain('not_svg');
    });

    it('refuses malformed XML with a readable message', () => {
      const result = prepareArtwork('<svg viewBox="0 0 1 1"><path d="M0 0"');
      expect(codes(result).errors).toContain('parse_failed');
      expect(result.report.errors[0]!.message).toMatch(/valid SVG/);
    });

    it('refuses entity-expansion attempts', () => {
      const bomb =
        '<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg"><desc>&b;</desc><rect width="1" height="1"/></svg>';
      expect(codes(prepareArtwork(bomb)).errors).toContain('parse_failed');
    });

    it('refuses external entity (XXE) attempts', () => {
      const xxe =
        '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg"><desc>&xxe;</desc></svg>';
      expect(codes(prepareArtwork(xxe)).errors).toContain('parse_failed');
    });

    it('tells the user to outline their text', () => {
      const result = prepareArtwork(doc('<text x="0" y="10">ACME</text><rect width="5" height="5"/>'));
      expect(codes(result).errors).toContain('text_not_outlined');
      expect(result.report.errors[0]!.hint).toMatch(/outline/i);
      expect(result.report.stats.hasText).toBe(true);
    });

    it('explains an embedded raster instead of failing silently', () => {
      const result = prepareArtwork(doc('<image href="https://example.com/logo.png" width="10" height="10"/>'));
      expect(codes(result).errors).toContain('empty_after_normalize');
      expect(result.report.errors[0]!.hint).toMatch(/vector original/i);
    });

    it('refuses artwork with nothing drawable in it', () => {
      expect(codes(prepareArtwork(doc('<defs><rect width="10" height="10"/></defs>'))).errors).toContain(
        'empty_after_normalize',
      );
    });

    it('refuses artwork past the complexity ceiling', () => {
      const many = '<path d="M0 0L1 1"/>'.repeat(40);
      const result = prepareArtwork(doc(many), { limits: { maxPaths: 10, maxNodes: 1000, maxAspect: 20 } });
      expect(codes(result).errors).toContain('complexity_exceeded');
      expect(result.report.errors[0]!.message).toMatch(/40 shapes/);
    });

    it('refuses files larger than the cap', () => {
      const big = doc(`<rect width="1" height="1"/><desc>${'x'.repeat(2000)}</desc>`);
      expect(codes(prepareArtwork(big, { maxBytes: 512 })).errors).toContain('too_large');
    });

    it('refuses a document with no usable size', () => {
      const result = prepareArtwork('<svg xmlns="http://www.w3.org/2000/svg"><rect width="0" height="0"/></svg>');
      expect(result.status).toBe('rejected');
    });
  });

  describe('warnings', () => {
    it('flags open filled paths', () => {
      const result = prepareArtwork(doc('<path d="M0 0L10 0L10 10" fill="#000"/>'));
      expect(result.status).toBe('ready');
      expect(codes(result).warnings).toContain('open_paths');
    });

    it('flags flattened gradients', () => {
      const result = prepareArtwork(
        doc(
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>' +
            '<rect width="20" height="10" fill="url(#g)"/>',
        ),
      );
      expect(codes(result).warnings).toContain('gradients_flattened');
    });

    it('flags extreme aspect ratios', () => {
      const result = prepareArtwork(doc('<rect x="0" y="0" width="90" height="1" fill="#000"/>'));
      expect(codes(result).warnings).toContain('aspect_extreme');
    });

    it('measures the thinnest stroke in millimetres', () => {
      const result = prepareArtwork(
        doc('<path d="M0 0L50 0" stroke="#000" stroke-width="0.6"/>', 'viewBox="0 0 200 100" width="100mm" height="50mm"'),
      );
      // 0.6 user units at 2 units/mm is 0.3 mm on the finished part.
      expect(result.report.stats.minStrokeMm).toBeCloseTo(0.3, 6);
    });
  });

  it('is deterministic', () => {
    const source = doc('<g transform="translate(5 5)"><circle cx="10" cy="10" r="5" fill="#000"/></g>');
    expect(prepareArtwork(source).svg).toBe(prepareArtwork(source).svg);
  });
});
