import { describe, expect, it } from 'vitest';
import { KNOWN_EXTENSIONS, sniffFormat } from './formats.js';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

const STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('a closure'),'2;1');
ENDSEC;
DATA;
ENDSEC;
END-ISO-10303-21;
`;

/** An IGES line is 80 columns with the section letter in column 73. */
const igesLine = (letter: string, index: number): string =>
  'IGES file made by hand'.padEnd(72, ' ') + letter + String(index).padStart(7, ' ');

function binaryStl(triangles: number): Uint8Array {
  const buffer = Buffer.alloc(84 + triangles * 50);
  buffer.write('a binary stl, which has no magic at all', 0, 'ascii');
  buffer.writeUInt32LE(triangles, 80);
  return new Uint8Array(buffer);
}

describe('sniffFormat', () => {
  it('recognises a STEP file by its opening token', () => {
    expect(sniffFormat(bytes(STEP))).toMatchObject({ format: 'step', extensionMismatch: false });
  });

  it('tolerates the byte-order mark and leading whitespace real exporters emit', () => {
    // A real UTF-8 BOM, as bytes. Decoded as latin1 it is three characters of noise, which is
    // exactly why the sniffer has to step over it rather than allow it in a pattern.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`\r\n  ${STEP}`, 'latin1')]);
    expect(sniffFormat(new Uint8Array(withBom)).format).toBe('step');
  });

  it('recognises IGES by the section letter in column 73', () => {
    const file = [igesLine('S', 1), igesLine('G', 2), igesLine('D', 3)].join('\n');
    expect(sniffFormat(bytes(file)).format).toBe('iges');
  });

  it('recognises both encodings of STL', () => {
    const ascii = 'solid part\n facet normal 0 0 1\n endfacet\nendsolid part\n';
    expect(sniffFormat(bytes(ascii)).format).toBe('stl');
    expect(sniffFormat(binaryStl(3)).format).toBe('stl');
  });

  it('does not mistake a truncated binary STL for one', () => {
    // The triangle count and the file length are the only agreement there is to check; a file
    // whose count promises more triangles than it carries is not a file to hand to a parser.
    const truncated = binaryStl(10).subarray(0, 84 + 5 * 50);
    expect(sniffFormat(truncated).format).toBeNull();
  });

  it('returns nothing for a file that is not CAD at all', () => {
    expect(sniffFormat(bytes('#!/bin/sh\nrm -rf /\n'))).toEqual({
      format: null,
      label: null,
      extensionMismatch: false,
    });
  });

  it('decides on content and only reports the extension disagreeing', () => {
    // The whole point of the rule: a STEP file named .stl is still STEP, and the operator is told
    // the name lied rather than the parser being handed the wrong grammar.
    const result = sniffFormat(bytes(STEP), 'closure.stl');
    expect(result.format).toBe('step');
    expect(result.extensionMismatch).toBe(true);
  });

  it('does not flag an extension that merely appears mid-name', () => {
    expect(sniffFormat(bytes(STEP), 'cap.stl.step').extensionMismatch).toBe(false);
  });

  it('is case-insensitive about the extension', () => {
    expect(sniffFormat(bytes(STEP), 'CLOSURE.STP').extensionMismatch).toBe(false);
  });

  it('reads only the head of a large file', () => {
    // A signature that needed the whole file would make sniffing cost as much as parsing, which is
    // the opposite of why it exists.
    const padded = Buffer.concat([Buffer.from(STEP, 'latin1'), Buffer.alloc(4 * 1024 * 1024, 0x20)]);
    expect(sniffFormat(new Uint8Array(padded)).format).toBe('step');
  });

  it('offers every known extension for an upload control', () => {
    expect(KNOWN_EXTENSIONS).toContain('.step');
    expect(KNOWN_EXTENSIONS).toContain('.stp');
    expect(new Set(KNOWN_EXTENSIONS).size).toBe(KNOWN_EXTENSIONS.length);
  });
});
