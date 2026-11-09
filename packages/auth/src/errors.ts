/**
 * Auth failures.
 *
 * The codes are deliberately coarse on the way out: "invalid_credentials" covers a wrong password,
 * an unknown address, a suspended account and an unverified one, because telling them apart tells
 * an attacker which addresses are worth attacking (docs/05-security.md).
 */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'account_locked'
  | 'invite_invalid'
  | 'reset_invalid'
  | 'password_weak'
  | 'rate_limited'
  | 'forbidden'
  | 'session_invalid';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AuthError {
  constructor(action: string) {
    super('forbidden', `not permitted: ${action}`);
    this.name = 'ForbiddenError';
  }
}
