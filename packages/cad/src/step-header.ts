/**
 * The HEADER section of a STEP file, read without a CAD kernel.
 *
 * ISO 10303-21 puts a short, plain-text header in front of the geometry: what produced the file,
 * when, and which application protocol it claims to follow. That is worth having before the kernel
 * is involved at all — it goes in the ingestion provenance, it tells an operator which CAD system a
 * troublesome file came from, and an unsupported protocol can be refused in milliseconds rather
 * than after a minute of parsing.
 *
 * Deliberately not a STEP parser. It reads a header and stops at `DATA;`. Geometry is OCCT's job.
 */

export interface StepHeader {
  /** FILE_DESCRIPTION's first argument: free text from the exporter. */
  description: string[];
  /** FILE_NAME's first argument — often the original path on the author's machine. */
  name: string | null;
  /** FILE_NAME's timestamp, as written. Not parsed into a Date: exporters emit odd offsets. */
  timeStamp: string | null;
  author: string[];
  organization: string[];
  /** The CAD system that wrote the file, when it says. */
  originatingSystem: string | null;
  /** FILE_SCHEMA: which application protocol this claims to be. */
  schemas: string[];
}

/** The protocols worth accepting: solids with product structure. Anything else is refused early. */
export const SUPPORTED_SCHEMAS = [
  'AUTOMOTIVE_DESIGN', // AP214
  'AP214',
  'CONFIG_CONTROL_DESIGN', // AP203
  'AP203',
  'AP242',
  'MANAGED_MODEL_BASED_3D_ENGINEERING', // AP242
] as const;

const HEADER_LIMIT = 64 * 1024;

/**
 * Strips comments and collapses the header to something a regular expression can be trusted on.
 *
 * STEP allows `/* … *\/` comments anywhere and line breaks inside any argument list, which is how a
 * naive `FILE_NAME\(([^)]*)\)` ends up matching half a header.
 */
function headerText(source: string): string {
  const upTo = source.indexOf('DATA;');
  const header = source.slice(0, upTo === -1 ? Math.min(source.length, HEADER_LIMIT) : upTo);
  return header.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Splits a STEP argument list on commas that are not inside a quoted string. */
function splitArguments(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';

  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      // '' is an escaped quote inside a STEP string, not the end of one.
      if (c === "'" && body[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      if (c === "'") quoted = false;
      current += c;
      continue;
    }
    if (c === "'") {
      quoted = true;
      current += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** `'a text'` → `a text`, undoing STEP's doubled-quote escape. `$` means "not supplied". */
function unquote(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '$' || trimmed === '*') return null;
  const match = /^'([\s\S]*)'$/.exec(trimmed);
  return match ? match[1]!.replace(/''/g, "'") : null;
}

/** A `('a', 'b')` list → its strings. */
function stringList(value: string | undefined): string[] {
  if (!value) return [];
  const inner = /^\(([\s\S]*)\)$/.exec(value.trim());
  if (!inner) {
    const single = unquote(value);
    return single === null ? [] : [single];
  }
  return splitArguments(inner[1]!)
    .map(unquote)
    .filter((s): s is string => s !== null);
}

function entity(header: string, name: string): string[] | null {
  const start = header.toUpperCase().indexOf(`${name}(`);
  if (start === -1) return null;

  let depth = 0;
  for (let i = start + name.length; i < header.length; i++) {
    const c = header[i]!;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return splitArguments(header.slice(start + name.length + 1, i));
    }
  }
  return null;
}

export function parseStepHeader(source: string): StepHeader {
  const header = headerText(source);
  const description = entity(header, 'FILE_DESCRIPTION');
  const fileName = entity(header, 'FILE_NAME');
  const schema = entity(header, 'FILE_SCHEMA');

  return {
    description: stringList(description?.[0]),
    name: fileName?.[0] ? unquote(fileName[0]) : null,
    timeStamp: fileName?.[1] ? unquote(fileName[1]) : null,
    author: stringList(fileName?.[2]),
    organization: stringList(fileName?.[3]),
    originatingSystem: fileName?.[5] ? unquote(fileName[5]) : null,
    schemas: stringList(schema?.[0]),
  };
}

/**
 * Whether a header claims a protocol carrying solid geometry with product structure.
 *
 * Matched loosely on purpose: real schema strings carry version and conformance-class suffixes —
 * `AUTOMOTIVE_DESIGN { 1 0 10303 214 ... }` — and refusing a file over a suffix would reject most
 * of the industry.
 */
export function schemaSupported(header: StepHeader): boolean {
  return header.schemas.some((declared) =>
    SUPPORTED_SCHEMAS.some((known) => declared.toUpperCase().includes(known)),
  );
}
