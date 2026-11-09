import { describe, expect, it } from 'vitest';
import { containsScriptableContent, sanitizeSvg, SanitizeError } from './sanitize.js';
import { serializeXml, type XmlElement } from './xml.js';

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;
const clean = (body: string) => serializeXml(sanitizeSvg(svg(body)).root);
const removalsOf = (body: string) => sanitizeSvg(svg(body)).removals;
const names = (body: string) => removalsOf(body).map((r) => `${r.name}:${r.reason}`);

describe('sanitizeSvg', () => {
  it('keeps drawing elements and their geometry', () => {
    const output = clean('<path d="M0 0L10 10" fill="#ff0000" stroke-width="2"/>');
    expect(output).toContain('d="M0 0L10 10"');
    expect(output).toContain('fill="#ff0000"');
    expect(output).toContain('stroke-width="2"');
  });

  it('rejects a document whose root is not <svg>', () => {
    expect(() => sanitizeSvg('<html><body/></html>')).toThrow(SanitizeError);
  });

  it('leaves an empty document for validation to judge, rather than throwing', () => {
    const result = sanitizeSvg(svg('<script>alert(1)</script>'));
    expect(result.root.children).toHaveLength(0);
    expect(result.removals).toEqual([
      expect.objectContaining({ kind: 'element', name: 'script', reason: 'not_allowed' }),
    ]);
  });

  describe('active content', () => {
    it('drops <script>', () => {
      expect(names('<path d="M0 0"/><script>alert(1)</script>')).toContain('script:not_allowed');
      expect(clean('<path d="M0 0"/><script>alert(1)</script>')).not.toContain('script');
    });

    it('drops <foreignObject> and its subtree', () => {
      const body = '<path d="M0 0"/><foreignObject><div onclick="x()">hi</div></foreignObject>';
      expect(clean(body)).not.toContain('foreignObject');
      expect(clean(body)).not.toContain('div');
    });

    it('drops animation elements', () => {
      expect(names('<path d="M0 0"/><animate attributeName="x" to="5"/>')).toContain(
        'animate:not_allowed',
      );
    });

    it('strips every on* handler', () => {
      const result = removalsOf('<path d="M0 0" onload="x()" onclick="y()" ONMOUSEOVER="z()"/>');
      expect(result.filter((r) => r.reason === 'event_handler')).toHaveLength(3);
      expect(clean('<path d="M0 0" onload="x()"/>')).not.toContain('onload');
    });

    it('strips javascript: urls', () => {
      expect(names('<path d="M0 0" fill="javascript:alert(1)"/>')).toContain('fill:script_url');
    });
  });

  describe('external references', () => {
    it('drops remote images', () => {
      expect(names('<path d="M0 0"/><image href="https://evil/x.png"/>')).toContain(
        'image:not_allowed',
      );
    });

    it('drops url() pointing anywhere but this document', () => {
      expect(names('<path d="M0 0" fill="url(https://evil/x#a)"/>')).toContain(
        'fill:external_reference',
      );
      expect(clean('<path d="M0 0" fill="url(#grad)"/>')).toContain('url(#grad)');
    });

    it('drops data: payloads', () => {
      expect(names('<path d="M0 0" fill="url(data:image/png;base64,AAAA)"/>')).toContain(
        'fill:external_reference',
      );
    });

    it('requires <use href> to resolve inside the document', () => {
      expect(names('<use href="https://evil/x.svg#a"/><path d="M0 0"/>')).toContain(
        'href:external_reference',
      );
      expect(clean('<defs><path id="a" d="M0 0"/></defs><use href="#a"/>')).toContain('href="#a"');
    });

    it('drops protocol-relative references', () => {
      expect(names('<path d="M0 0" fill="//evil/x"/>')).toContain('fill:external_reference');
    });
  });

  describe('style attributes', () => {
    it('keeps presentational declarations', () => {
      expect(clean('<path d="M0 0" style="fill:#123456; stroke-width:2"/>')).toContain(
        'fill:#123456; stroke-width:2',
      );
    });

    it('drops @import and url() escapes', () => {
      const body = '<path d="M0 0" style="fill:url(https://evil/x); stroke:#000"/>';
      expect(clean(body)).toContain('stroke:#000');
      expect(clean(body)).not.toContain('evil');
    });

    it('drops properties outside the allow-list', () => {
      const body = '<path d="M0 0" style="behavior:url(#x); fill:#000"/>';
      expect(names(body).some((n) => n.startsWith('behavior'))).toBe(true);
    });
  });

  describe('namespaces', () => {
    it('drops foreign-namespace elements', () => {
      expect(names('<path d="M0 0"/><html:div/>')).toContain('html:div:unsupported_namespace');
    });

    it('keeps svg-prefixed elements', () => {
      expect(clean('<svg:path d="M0 0"/>')).toContain('path');
    });
  });

  it('leaves nothing scriptable behind', () => {
    const hostile = svg(
      '<script>a()</script><path d="M0 0" onclick="b()"/><foreignObject><iframe/></foreignObject>',
    );
    const root: XmlElement = sanitizeSvg(hostile).root;
    expect(containsScriptableContent(root)).toBe(false);
  });

  it('reports what it removed, so the user can be told', () => {
    const result = sanitizeSvg(svg('<path d="M0 0" onclick="x()"/><script>y()</script>'));
    expect(result.removals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attribute', reason: 'event_handler' }),
        expect.objectContaining({ kind: 'element', name: 'script' }),
      ]),
    );
  });
});
