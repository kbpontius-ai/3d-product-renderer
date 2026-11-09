/**
 * Canonical JSON: the same logical value always serialises to the same bytes, so hashing it is a
 * meaningful identity. This is what makes render de-duplication and idempotency keys trustworthy.
 */

export class NonCanonicalValueError extends Error {
  constructor(what: string) {
    super(`value cannot be canonicalised: ${what}`);
    this.name = 'NonCanonicalValueError';
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NonCanonicalValueError(String(value));
    return value === 0 ? 0 : value; // collapse -0
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return undefined; // dropped by the callers below

  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalise(v)));

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === undefined) continue; // an absent key and an undefined key are the same thing
      out[key] = canonicalise(v);
    }
    return out;
  }

  throw new NonCanonicalValueError(typeof value);
}
