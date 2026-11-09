/**
 * Object storage (build order A5).
 *
 * The interface is what everything else depends on; the local implementation is for development and
 * tests, and S3-compatible storage backs it in production. Keys follow docs/11-data-model.md so an
 * asset is addressable without a lookup table, and nothing above this layer ever learns whether it
 * is talking to a disk or a bucket.
 */

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface Storage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix. Used by cleanup, never on a request path. */
  list(prefix: string): Promise<string[]>;
}

export class ObjectNotFound extends Error {
  constructor(readonly key: string) {
    super(`no object at ${key}`);
    this.name = 'ObjectNotFound';
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Rejects anything that could escape the key space.
 *
 * Keys arrive from request paths, so this is a boundary check rather than a tidiness one: a key is
 * a sequence of plain segments, and `..`, absolute paths, backslashes and control characters are
 * not segments.
 */
export function assertValidKey(key: string): void {
  const invalid =
    key.length === 0 ||
    key.length > 512 ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\\') ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    CONTROL_CHARACTERS.test(key);

  if (invalid) throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
}

const CONTENT_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  json: 'application/json',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export const contentTypeFor = (key: string): string =>
  CONTENT_TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
