/**
 * Rate limiting.
 *
 * The interface is what the auth service depends on; the in-memory implementation is for tests and
 * single-node deployments, and Redis backs it in production (docs/18-auth-impl.md). Auth limits
 * fail CLOSED: if the limiter is unavailable, sign-in is refused rather than left unprotected.
 */

export interface RateLimitRule {
  points: number;
  windowSec: number;
}

export interface RateLimiter {
  /** Throws {@link RateLimitedError} when the caller is over budget. */
  consume(key: string, rule: RateLimitRule): Promise<void>;
  reset(key: string): Promise<void>;
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`rate limited, retry in ${retryAfterSec}s`);
    this.name = 'RateLimitedError';
  }
}

/**
 * How many invitations one address may accept in ten minutes.
 *
 * Per IP, which is the whole reason this is adjustable. Ten is right for a deployment whose users
 * arrive from their own connections, and wrong for one behind a single corporate NAT — where a
 * team onboarding on a Monday morning shares one address and the eleventh person is told to come
 * back later. The e2e suite is the same shape of problem: one machine, legitimately accepting a
 * dozen invitations a run.
 *
 * The default is the safe number. Raising it is a decision an operator makes about their own
 * network, and lowering it is always allowed.
 */
function inviteAcceptPoints(): number {
  const configured = Number(process.env['AUTH_INVITE_ACCEPT_LIMIT']);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10;
}

export const AUTH_LIMITS = {
  loginPerIp: { points: 10, windowSec: 60 },
  loginPerAccount: { points: 5, windowSec: 300 },
  inviteAccept: { points: inviteAcceptPoints(), windowSec: 600 },
  resetRequest: { points: 5, windowSec: 600 },
} as const satisfies Record<string, RateLimitRule>;

export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, rule: RateLimitRule): Promise<void> {
    const now = this.now();
    const existing = this.counters.get(key);

    if (!existing || existing.expiresAt <= now) {
      this.counters.set(key, { count: 1, expiresAt: now + rule.windowSec * 1000 });
      return;
    }

    existing.count += 1;
    if (existing.count > rule.points) {
      throw new RateLimitedError(Math.ceil((existing.expiresAt - now) / 1000));
    }
  }

  async reset(key: string): Promise<void> {
    this.counters.delete(key);
  }
}

/** Lets tests and single-node runs share one limiter without ceremony. */
export const memoryRateLimiter = new MemoryRateLimiter();
