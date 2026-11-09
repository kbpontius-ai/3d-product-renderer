import { createHash } from 'node:crypto';
import type { RenderSpec } from '@pr/design-schema';
import { canonicalJson } from './canonical.js';

/**
 * The spec hash is simultaneously the idempotency key, the de-duplication key, and the proof that
 * two renders had identical inputs. Any change to any input — a millimetre of offset, a sample
 * count, a renderer version — changes it.
 */
export function specHash(spec: RenderSpec): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

export const shortHash = (hash: string): string => hash.slice(0, 12);
