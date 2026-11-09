import { createHash } from 'node:crypto';

/**
 * Has this password already been leaked? (F-AUTH-03)
 *
 * The single most useful check there is: strength estimation reasons about how a password is built,
 * and this knows whether the exact string is already in a wordlist someone is running right now. A
 * long, well-formed passphrase from a breached account is weaker than a mediocre one nobody has.
 *
 * k-anonymity, as the API intends: the first five hex characters of the SHA-1 go over the wire and
 * the rest is matched locally, so the service never learns the password and neither does anyone
 * reading the request. SHA-1 is not a security choice here — it is the index the corpus is keyed by.
 */

export interface BreachCheck {
  breached: boolean;
  /** How many times it appears in the corpus, when the source says. */
  count: number;
  /** False when the lookup could not be made; the caller then decides what to do about it. */
  checked: boolean;
}

export interface BreachOptions {
  /** Swapped in tests, and by a self-hoster pointing at their own mirror. */
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  timeoutMs?: number;
  /**
   * Turn the lookup off entirely.
   *
   * For deployments with no outbound network, and for test runs that should not depend on a third
   * party being up. Reported as unchecked, never as safe.
   */
  enabled?: boolean;
}

const ENDPOINT = 'https://api.pwnedpasswords.com/range';
const TIMEOUT_MS = 2500;

export async function checkBreached(
  password: string,
  options: BreachOptions = {},
): Promise<BreachCheck> {
  const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  const doFetch = options.fetch ?? globalThis.fetch;
  if (options.enabled === false || !doFetch) return { breached: false, count: 0, checked: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);

  try {
    const response = await doFetch(`${options.endpoint ?? ENDPOINT}/${prefix}`, {
      signal: controller.signal,
      headers: { 'Add-Padding': 'true' },
    });
    if (!response.ok) return { breached: false, count: 0, checked: false };

    const body = await response.text();
    for (const line of body.split('\n')) {
      const [candidate, count] = line.trim().split(':');
      if (candidate === suffix) {
        // Padding entries come back with a count of zero and are not real hits.
        const times = Number(count ?? 0);
        return { breached: times > 0, count: times, checked: true };
      }
    }

    return { breached: false, count: 0, checked: true };
  } catch {
    // Timed out, offline, or blocked. Reported as unchecked rather than as safe: whether that
    // stops a password being set is a decision for the caller, not for a network error.
    return { breached: false, count: 0, checked: false };
  } finally {
    clearTimeout(timer);
  }
}
