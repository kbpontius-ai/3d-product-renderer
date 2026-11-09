import { describe, expect, it } from 'vitest';
import { decodeXmlText, parseXml, serializeXml, XmlParseError, type XmlElement } from './xml.js';

const el = (node: unknown) => node as XmlElement;

describe('parseXml', () => {
  it('parses elements, attributes and nesting', () => {
    const root = parseXml('<svg width="10"><g id="a"><path d="M0 0"/></g></svg>');
    expect(root.name).toBe('svg');
    expect(root.attributes).toEqual([{ name: 'width', value: '10' }]);
    expect(el(root.children[0]).name).toBe('g');
    expect(el(el(root.children[0]).children[0]).name).toBe('path');
  });

  it('handles self-closing tags and single quotes', () => {
    const root = parseXml("<svg><rect x='1' y='2'/></svg>");
    expect(el(root.children[0]).attributes).toEqual([
      { name: 'x', value: '1' },
      { name: 'y', value: '2' },
    ]);
  });

  it('does not treat a > inside an attribute value as the end of the tag', () => {
    const root = parseXml('<svg><path d="M0 0" data-note="a > b"/></svg>');
    expect(el(root.children[0]).attributes).toHaveLength(2);
  });

  it('keeps namespace prefixes separate from local names', () => {
    const root = parseXml('<svg><svg:rect/><html:div/></svg>');
    expect(el(root.children[0]).prefix).toBe('svg');
    expect(el(root.children[1]).prefix).toBe('html');
    expect(el(root.children[1]).name).toBe('div');
  });

  it('skips comments and keeps CDATA as text', () => {
    const root = parseXml('<svg><!-- hi --><desc><![CDATA[raw <not-a-tag>]]></desc></svg>');
    expect(root.children).toHaveLength(1);
    expect(el(root.children[0]).children[0]).toEqual({ type: 'text', value: 'raw <not-a-tag>' });
  });

  it('accepts the XML declaration but refuses other processing instructions', () => {
    expect(() => parseXml('<?xml version="1.0"?><svg/>')).not.toThrow();
    expect(() => parseXml('<?php echo 1; ?><svg/>')).toThrow(XmlParseError);
  });

  describe('hostile input', () => {
    it('refuses DOCTYPE declarations outright', () => {
      const attempt = () => parseXml('<!DOCTYPE svg SYSTEM "http://evil/x.dtd"><svg/>');
      expect(attempt).toThrow(XmlParseError);
      expect(attempt).toThrow(/DOCTYPE/);
    });

    it('refuses entity declarations, so billion laughs cannot be expressed', () => {
      const bomb =
        '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><svg>&lol2;</svg>';
      expect(() => parseXml(bomb)).toThrow(XmlParseError);
    });

    it('leaves unknown entity references inert instead of resolving them', () => {
      const root = parseXml('<svg><desc>&xxe;</desc></svg>');
      expect(el(root.children[0]).children[0]).toEqual({ type: 'text', value: '&xxe;' });
    });

    it('enforces a depth limit', () => {
      const deep = '<svg>' + '<g>'.repeat(64) + '</g>'.repeat(64) + '</svg>';
      expect(() => parseXml(deep)).toThrow(/deep/);
    });

    it('enforces a node limit', () => {
      const many = `<svg>${'<path/>'.repeat(50)}</svg>`;
      expect(() => parseXml(many, { maxDepth: 32, maxNodes: 10, maxAttributesPerElement: 64 })).toThrow(
        /too many nodes/,
      );
    });

    it('rejects a stray closing tag', () => {
      expect(() => parseXml('</svg>')).toThrow(XmlParseError);
    });
  });
});

describe('decodeXmlText', () => {
  it('resolves the five built-in entities and numeric references', () => {
    expect(decodeXmlText('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;')).toBe(`<a> & "b" 'c'`);
    expect(decodeXmlText('&#65;&#x42;')).toBe('AB');
  });

  it('leaves anything else untouched', () => {
    expect(decodeXmlText('&custom; &file;')).toBe('&custom; &file;');
  });
});

describe('serializeXml', () => {
  it('round-trips a simple document', () => {
    const source = '<svg viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>';
    expect(serializeXml(parseXml(source))).toBe(source);
  });

  it('escapes text and attribute values', () => {
    const root = parseXml('<svg><desc>a &amp; b</desc></svg>');
    expect(serializeXml(root)).toContain('a &amp; b');
  });
});
