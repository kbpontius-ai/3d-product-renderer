/**
 * Which CAD format a file actually is (docs/23-cad-ingestion.md).
 *
 * By content, never by extension. The extension is a hint from whoever named the file, and the
 * parser this feeds is a large native C++ library reading a stranger's input — the last place in
 * the system that should be trusting a hint.
 *
 * Adding a format here is deliberately small: a signature and an entry in the union. What it takes
 * to *import* one is a new `CadImporter`; nothing in the pipeline above learns a new name.
 */

export type CadFormat = 'step' | 'iges' | 'brep' | 'stl' | 'parasolid' | 'jt';

export interface FormatSignature {
  format: CadFormat;
  /** Human name, for messages an operator reads. */
  label: string;
  /** True when these bytes look like this format. Given the first few kilobytes, never the lot. */
  matches(head: string, bytes: Uint8Array): boolean;
  /** Extensions this format is usually given. Used for messages and filtering, never for deciding. */
  extensions: readonly string[];
}

/** How much of a file is enough to recognise it. Headers live at the front, by construction. */
export const SNIFF_BYTES = 4096;

/** UTF-8's byte-order mark. Real exporters emit it in front of a format that has no business
 * carrying one, and three stray bytes should not make a file unrecognisable. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

const text = (bytes: Uint8Array): string => {
  const start = UTF8_BOM.every((byte, index) => bytes[index] === byte) ? UTF8_BOM.length : 0;
  return Buffer.from(bytes.subarray(start, start + SNIFF_BYTES)).toString('latin1');
};

export const FORMAT_SIGNATURES: readonly FormatSignature[] = [
  {
    format: 'step',
    label: 'STEP (ISO 10303)',
    extensions: ['.step', '.stp'],
    // Every conforming exchange file starts with this token. Leading whitespace is tolerated, and
    // a byte-order mark has already been stepped over by the time this sees the text.
    matches: (head) => /^\s*ISO-10303-21\s*;/.test(head),
  },
  {
    format: 'iges',
    label: 'IGES',
    extensions: ['.iges', '.igs'],
    // IGES is a fixed-column format: the section letter sits in column 73 of every line.
    matches: (head) =>
      head
        .split(/\r?\n/, 8)
        .filter((line) => line.length >= 73)
        .some((line) => 'SGDPT'.includes(line[72] ?? '')),
  },
  {
    format: 'brep',
    label: 'OpenCascade BREP',
    extensions: ['.brep'],
    matches: (head) => /^\s*DBRep_DrawableShape|^\s*CASCADE Topology V\d/.test(head),
  },
  {
    format: 'stl',
    label: 'STL',
    extensions: ['.stl'],
    // Two encodings of the same format. Binary STL has no magic at all — an 80-byte comment header
    // followed by a triangle count — so it is recognised by that count agreeing with the file size,
    // which is the only reliable test there is.
    matches: (head, bytes) => {
      if (/^\s*solid\s/.test(head) && /facet\s+normal/.test(head)) return true;
      if (bytes.byteLength < 84) return false;
      const triangles = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32LE(80);
      return bytes.byteLength === 84 + triangles * 50;
    },
  },
];

export interface SniffResult {
  format: CadFormat | null;
  label: string | null;
  /** Set when the extension disagrees with the content, which is worth telling the operator. */
  extensionMismatch: boolean;
}

/**
 * What this file is.
 *
 * A binary STL needs the whole file to check its own length, so this takes all the bytes and only
 * reads the head of them for the text formats.
 */
export function sniffFormat(bytes: Uint8Array, fileName?: string): SniffResult {
  const head = text(bytes);
  const signature = FORMAT_SIGNATURES.find((candidate) => candidate.matches(head, bytes));

  if (!signature) return { format: null, label: null, extensionMismatch: false };

  const extension = fileName ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null;
  return {
    format: signature.format,
    label: signature.label,
    extensionMismatch: extension !== null && !signature.extensions.includes(extension),
  };
}

/** Every extension any known format uses, for an upload control's `accept` and for messages. */
export const KNOWN_EXTENSIONS: readonly string[] = FORMAT_SIGNATURES.flatMap((s) => s.extensions);
