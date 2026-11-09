import { describe, expect, it } from 'vitest';
import { estimateStrength } from './strength.js';
import { assessPassword, assessPasswordFully, MIN_SCORE } from './password.js';
import { checkBreached } from './breach.js';

/**
 * The claim being tested is the one that matters: a rule-satisfying password is not automatically
 * strong, and a rule-breaking passphrase is not automatically weak. Every case here is a password a
 * real person has actually chosen.
 */

describe('estimateStrength', () => {
  it('sees through the decorations on a dictionary word', () => {
    // Every one of these passes an upper/lower/digit/symbol rule.
    for (const password of ['P@ssw0rd1', 'Password123!', 'Welcome2024!', 'Dr@gon99!']) {
      expect(estimateStrength(password).score).toBeLessThan(MIN_SCORE);
      expect(estimateStrength(password).patterns).toContain('dictionary');
    }
  });

  it('rates a passphrase highly, whatever character classes it lacks', () => {
    for (const password of [
      'chamfer ridge lantern quarry',
      'seventeen brass hinges rattled',
      'the quiet kiln in autumn',
    ]) {
      expect(estimateStrength(password).score).toBeGreaterThanOrEqual(MIN_SCORE);
    }
  });

  it('charges almost nothing for a keyboard run', () => {
    expect(estimateStrength('qwertyuiop').patterns).toContain('keyboard');
    expect(estimateStrength('qwertyuiop').score).toBeLessThan(2);
  });

  it('charges almost nothing for a sequence or a repeat', () => {
    expect(estimateStrength('abcdefghijkl').patterns).toContain('sequence');
    expect(estimateStrength('abcabcabcabc').patterns).toContain('repeat');
    expect(estimateStrength('aaaaaaaaaaaa').score).toBe(0);
  });

  it('notices a year, because everyone uses the same hundred', () => {
    expect(estimateStrength('lantern1998').patterns).toContain('date');
  });

  it('rewards length in unpredictable characters', () => {
    const short = estimateStrength('Tq7#z');
    const long = estimateStrength('Tq7#zLm2$vRx9!');

    expect(long.guesses).toBeGreaterThan(short.guesses);
    expect(long.score).toBe(4);
  });

  it('says nothing costs nothing', () => {
    expect(estimateStrength('')).toMatchObject({ guesses: 1, score: 0 });
  });
});

describe('assessPassword', () => {
  it('refuses a guessable password with a reason worth showing', () => {
    const assessment = assessPassword('Password2024!');

    expect(assessment.ok).toBe(false);
    expect(assessment.problems).toContain('too_common');
  });

  it('refuses one built from the address it belongs to', () => {
    const assessment = assessPassword('jenniferbrass hinge', { email: 'jennifer@example.com' });

    expect(assessment.ok).toBe(false);
    expect(assessment.problems).toContain('contains_email');
  });

  it('accepts a passphrase', () => {
    expect(assessPassword('chamfer ridge lantern quarry').ok).toBe(true);
  });
});

describe('the breached-password lookup', () => {
  /** The API's shape: suffixes and counts, one per line, for a five-character prefix. */
  const service = (body: string, status = 200): typeof globalThis.fetch =>
    (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

  it('sends only a prefix, and matches the rest locally', async () => {
    let asked = '';
    const fetcher = (async (url: string) => {
      asked = String(url);
      // SHA-1 of "correct horse battery staple" — the suffix is matched, never sent.
      return new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2\n', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await checkBreached('correct horse battery staple', { fetch: fetcher });

    expect(asked).toMatch(/\/[0-9A-F]{5}$/);
    expect(asked).not.toContain('correct');
  });

  it('finds a password that is in the corpus', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha1').update('hunter2hunter2', 'utf8').digest('hex').toUpperCase();

    const result = await checkBreached('hunter2hunter2', {
      fetch: service(`${digest.slice(5)}:4113\nFFFF:1\n`),
    });

    expect(result).toMatchObject({ breached: true, count: 4113, checked: true });
  });

  it('ignores the padding entries the API adds to hide the real answer', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha1').update('quiet kiln autumn brass', 'utf8').digest('hex').toUpperCase();

    const result = await checkBreached('quiet kiln autumn brass', {
      fetch: service(`${digest.slice(5)}:0\n`),
    });

    expect(result).toMatchObject({ breached: false, checked: true });
  });

  it('reports being unable to check rather than reporting safe', async () => {
    const down = (async () => {
      throw new Error('network is down');
    }) as unknown as typeof globalThis.fetch;

    expect(await checkBreached('anything at all here', { fetch: down })).toMatchObject({
      breached: false,
      checked: false,
    });
    expect(await checkBreached('anything at all here', { fetch: service('', 503) })).toMatchObject({
      checked: false,
    });
  });
});

describe('assessPasswordFully', () => {
  const notBreached = (async () => new Response('FFFF:1\n', { status: 200 })) as unknown as typeof globalThis.fetch;

  it('refuses a strong password that has already leaked', async () => {
    const { createHash } = await import('node:crypto');
    const password = 'chamfer ridge lantern quarry';
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();

    const assessment = await assessPasswordFully(password, {
      breach: {
        fetch: (async () => new Response(`${digest.slice(5)}:12\n`, { status: 200 })) as unknown as typeof globalThis.fetch,
      },
    });

    expect(assessment.ok).toBe(false);
    expect(assessment.problems).toContain('breached');
    expect(assessment.breachCount).toBe(12);
  });

  it('accepts a strong password that has not', async () => {
    const assessment = await assessPasswordFully('chamfer ridge lantern quarry', {
      breach: { fetch: notBreached },
    });

    expect(assessment.ok).toBe(true);
    expect(assessment.breachChecked).toBe(true);
  });

  it('still lets people in when the breach service is down', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof globalThis.fetch;

    // A third party being unreachable must not become an outage of our own.
    const assessment = await assessPasswordFully('chamfer ridge lantern quarry', {
      breach: { fetch: down },
    });

    expect(assessment.ok).toBe(true);
    expect(assessment.breachChecked).toBe(false);
  });

  it('can be told to insist, where that trade is the right one', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof globalThis.fetch;

    const assessment = await assessPasswordFully('chamfer ridge lantern quarry', {
      breach: { fetch: down },
      requireBreachCheck: true,
    });

    expect(assessment.ok).toBe(false);
  });
});
