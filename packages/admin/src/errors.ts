/**
 * What the admin operations refuse to do, in the vocabulary the routes turn into status codes.
 *
 * Deliberately coarse, and deliberately not the auth vocabulary: these are staff actions, where a
 * precise message ("that would leave the org without an owner") is useful rather than an
 * enumeration risk.
 */
export class AdminError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'conflict' | 'forbidden',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}
