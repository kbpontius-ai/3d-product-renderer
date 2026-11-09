import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { checkBreached, type BreachOptions } from './breach.js';
import { estimateStrength } from './strength.js';

/**
 * Password hashing and strength.
 *
 * argon2id with tuned parameters, versioned so hashes can be upgraded on the next successful login
 * rather than by asking everyone to reset. The wasm implementation keeps the dependency portable —
 * the same code runs in the app server, in tests, and anywhere a self-hoster puts it.
 */

export interface Argon2Params {
  memorySizeKb: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

/** Production defaults: ~64 MiB, t=3. Tests lower these deliberately and say so. */
export const DEFAULT_ARGON2: Argon2Params = {
  memorySizeKb: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};

export const PASSWORD_ALGO = 'argon2id-v1';

export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySizeKb,
    hashLength: params.hashLength,
    outputType: 'encoded',
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false; // a malformed stored hash is a failed login, never a crash
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * A real hash to verify against when the account does not exist.
 *
 * Verifying it costs the same as verifying a genuine one, so an attacker cannot tell registered
 * addresses from unregistered ones by timing the response. It is computed once, from random input,
 * rather than hard-coded — a literal would eventually drift from the current parameters and stop
 * costing the same thing.
 */
export function dummyPasswordHash(params: Argon2Params = DEFAULT_ARGON2): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'), params);
  return dummyHash;
}

export interface PasswordAssessment {
  ok: boolean;
  score: 0 | 1 | 2 | 3 | 4;
  problems: PasswordProblem[];
}

export type PasswordProblem =
  | 'too_short'
  | 'too_common'
  | 'contains_email'
  | 'contains_site_name'
  | 'single_character_class'
  | 'repetitive'
  | 'guessable'
  | 'breached';

export const MIN_PASSWORD_LENGTH = 12;

/**
 * The obvious bases, refused before any estimation happens.
 *
 * Kept alongside the strength estimator rather than replaced by it: these are the ones worth naming
 * in the error, because "that is a common password" is advice and "guesses: 4.2e5" is not.
 */
const COMMON_BASES = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'iloveyou',
  'welcome',
  'admin',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'trustno1',
  'abc123',
  '123456',
  '111111',
  'packaging',
  'product',
  'renderer',
];

/**
 * Length alone is not strength: "password1234" clears twelve characters and is still the first
 * thing anyone tries. Common bases are matched as substrings so the usual decorations — a year, a
 * bang, a capital first letter — do not rescue them.
 */
function usesCommonBase(lower: string): boolean {
  return COMMON_BASES.some((base) => lower.includes(base));
}

/**
 * The local half of the password gate: everything that can be decided without a network call.
 *
 * Strength is estimated the way zxcvbn does it — by counting the guesses an attacker needs — rather
 * than by counting character classes, which is a rule that passes "P@ssw0rd1" and fails a
 * passphrase. The breached-password lookup is the other half, and it is async, so it lives in
 * {@link assessPasswordFully}.
 */
export function assessPassword(
  password: string,
  context: { email?: string; siteName?: string } = {},
): PasswordAssessment {
  const problems: PasswordProblem[] = [];
  const lower = password.toLowerCase();

  if (password.length < MIN_PASSWORD_LENGTH) problems.push('too_short');
  if (usesCommonBase(lower)) problems.push('too_common');

  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 3 && lower.includes(localPart)) problems.push('contains_email');
  if (context.siteName && lower.includes(context.siteName.toLowerCase())) problems.push('contains_site_name');

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes <= 1) problems.push('single_character_class');

  const distinct = new Set(password).size;
  if (password.length > 0 && distinct <= Math.max(2, password.length / 6)) problems.push('repetitive');

  const estimate = estimateStrength(password);
  if (estimate.score < MIN_SCORE && !problems.includes('too_common')) problems.push('guessable');

  return {
    // Three of four: a passphrase clears it comfortably, a decorated dictionary word does not.
    ok: problems.length === 0 && estimate.score >= MIN_SCORE,
    score: estimate.score,
    problems,
  };
}

/** Below this, a determined attacker gets there in an afternoon. */
export const MIN_SCORE = 3;

export interface FullAssessmentOptions {
  email?: string;
  siteName?: string;
  breach?: BreachOptions;
  /**
   * Whether an unreachable breach service should stop a password being set.
   *
   * Default false. Refusing every sign-up because a third party is down trades a small, uncertain
   * risk for a certain outage, and the local checks still apply.
   */
  requireBreachCheck?: boolean;
}

/**
 * The whole gate: local estimation plus the breached-password lookup.
 *
 * A password that is well-formed and already in a dump is worse than a mediocre one nobody has, so
 * this is the check that actually decides — and it is the reason the local model can stay small.
 */
export async function assessPasswordFully(
  password: string,
  options: FullAssessmentOptions = {},
): Promise<PasswordAssessment & { breachCount: number; breachChecked: boolean }> {
  const local = assessPassword(password, {
    ...(options.email ? { email: options.email } : {}),
    ...(options.siteName ? { siteName: options.siteName } : {}),
  });

  const breach = await checkBreached(password, options.breach ?? {});
  const problems = [...local.problems];

  if (breach.breached) problems.push('breached');
  const unavailable = !breach.checked && options.requireBreachCheck === true;

  return {
    ok: local.ok && !breach.breached && !unavailable,
    score: breach.breached ? 0 : local.score,
    problems,
    breachCount: breach.count,
    breachChecked: breach.checked,
  };
}
