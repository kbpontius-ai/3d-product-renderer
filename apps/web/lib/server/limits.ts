import 'server-only';
import { MemoryRateLimiter, RateLimitedError, type RateLimitRule } from '@pr/auth';
import { currentLog } from '@pr/observability';
import { HttpError } from './http.js';

/**
 * Rate limits on the things that cost us money or storage (F-PLAT-03).
 *
 * Quotas answer "how much may this organisation have"; these answer "how fast". A daily render
 * quota does not stop a loop submitting fifty in a second and holding every worker, and nothing at
 * all stopped a script uploading artwork until the disk filled.
 *
 * The counters live in this process. That is honest for a single node and wrong for a fleet — the
 * limiter is an interface for exactly that reason, and a deployment behind more than one server
 * swaps in a shared one without touching any of the call sites.
 */

const globalForLimits = globalThis as unknown as { __prLimiter?: MemoryRateLimiter };
const limiter = (): MemoryRateLimiter => (globalForLimits.__prLimiter ??= new MemoryRateLimiter());

/**
 * How many artwork uploads one account may make in five minutes.
 *
 * Adjustable for the reason `AUTH_INVITE_ACCEPT_LIMIT` is. The e2e suite shares one account across
 * every spec and uploads more than thirty files in a run, so whichever specs came last were refused
 * — "the upload did not reach the server" — depending only on how fast the machine got there. The
 * default is the safe number; raising it is an operator's decision about their own users.
 */
function artworkUploadPoints(): number {
  const configured = Number(process.env['ARTWORK_UPLOAD_LIMIT']);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 30;
}

/**
 * Budgets, chosen against what a person doing the work actually does.
 *
 * Uploading a brand's whole logo set is a dozen files in a minute; nobody places forty renders in
 * one. Each is generous enough that the limit is invisible until something is wrong.
 */
export const API_LIMITS = {
  artworkUpload: { points: artworkUploadPoints(), windowSec: 300 },
  artworkPrepare: {
    points:
      Number(process.env['ARTWORK_PREPARE_LIMIT']) > 0
        ? Math.floor(Number(process.env['ARTWORK_PREPARE_LIMIT']))
        : 120,
    windowSec: 60,
  },
  renderSubmit: { points: 20, windowSec: 60 },
  thumbnail: { points: 60, windowSec: 300 },
  packUpload: { points: 10, windowSec: 600 },
  // An ingestion is minutes of CPU on a big container, and the upload itself can be hundreds
  // of megabytes. Staff-only already, so this is a guard against a script, not a person.
  cadUpload: { points: 10, windowSec: 600 },
  designWrite: { points: 240, windowSec: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type LimitName = keyof typeof API_LIMITS;

/**
 * Charges one point against a limit, or refuses with a 429 that says how long to wait.
 *
 * Keyed per account rather than per IP: everyone in an office shares an address, and the thing
 * being protected is per-account work anyway.
 */
export async function enforceLimit(name: LimitName, subject: string): Promise<void> {
  try {
    await limiter().consume(`${name}:${subject}`, API_LIMITS[name]);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      currentLog().warn('rate limited', { limit: name, retryAfterSec: error.retryAfterSec });
      throw new HttpError(
        429,
        'rate_limited',
        `Too many requests. Try again in ${error.retryAfterSec}s.`,
      );
    }
    throw error;
  }
}
