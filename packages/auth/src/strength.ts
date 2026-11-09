/**
 * Password strength, estimated the way zxcvbn estimates it (F-AUTH-03).
 *
 * Not character-class rules. "P@ssw0rd1" satisfies every rule anyone has ever written and is
 * cracked instantly; "correct horse battery staple" satisfies none of them and is not. So this
 * counts guesses instead: the password is split into the cheapest sequence of patterns an attacker
 * would try — dictionary words with the usual decorations, keyboard runs, repeats, dates — and
 * whatever is left over is charged at brute force.
 *
 * It is a smaller model than zxcvbn's: a few hundred bases rather than tens of thousands, and a
 * greedy split rather than the optimal one. It is deliberately paired with a breached-password
 * lookup, which is the check that actually catches a reused password — no local model can know
 * that a passphrase turned up in a dump last year.
 */

export interface StrengthEstimate {
  /** Order-of-magnitude guesses an attacker would need. */
  guesses: number;
  /** zxcvbn's scale: 0 unusable, 3 good, 4 strong. */
  score: 0 | 1 | 2 | 3 | 4;
  /** Which patterns were found, for saying why rather than just no. */
  patterns: PatternKind[];
}

export type PatternKind = 'dictionary' | 'sequence' | 'keyboard' | 'repeat' | 'date' | 'brute';

/**
 * The bases that appear at the top of every leak, plus the ones specific to this product.
 *
 * Short by design: the long tail is what the breach lookup is for, and a list nobody maintains
 * gives false confidence. What these catch is the password someone picks in ten seconds.
 */
const DICTIONARY = [
  'password', 'passwd', 'pass', 'qwerty', 'qwertz', 'azerty', 'letmein', 'welcome', 'monkey',
  'dragon', 'sunshine', 'princess', 'football', 'baseball', 'basketball', 'superman', 'batman',
  'trustno', 'iloveyou', 'admin', 'administrator', 'root', 'login', 'master', 'shadow', 'michael',
  'jennifer', 'jordan', 'harley', 'ranger', 'hunter', 'buster', 'soccer', 'hockey', 'killer',
  'george', 'charlie', 'andrew', 'thomas', 'robert', 'daniel', 'joshua', 'matthew', 'access',
  'flower', 'summer', 'winter', 'spring', 'autumn', 'freedom', 'whatever', 'secret', 'purple',
  'orange', 'yellow', 'silver', 'golden', 'diamond', 'phoenix', 'ginger', 'cookie', 'chocolate',
  'computer', 'internet', 'samsung', 'google', 'facebook', 'amazon', 'apple', 'microsoft',
  'packaging', 'product', 'renderer', 'render', 'design', 'designer', 'artwork', 'bottle', 'carton', 'label',
  'closure', 'emboss', 'deboss', 'company', 'business', 'manager', 'office', 'server', 'database',
  'welcome1', 'starwars', 'pokemon', 'minecraft', 'liverpool', 'chelsea', 'arsenal', 'united',
];

/** Ordinary keyboard runs, both directions, as an attacker would generate them. */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'azertyuiop', 'qwertzuiop'];

/** The substitutions people believe make a word unguessable. */
const LEET: Record<string, string> = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't',
};

interface Match {
  start: number;
  end: number;
  guesses: number;
  kind: PatternKind;
}

export function estimateStrength(password: string): StrengthEstimate {
  if (password.length === 0) return { guesses: 1, score: 0, patterns: [] };

  const matches = [
    ...dictionaryMatches(password),
    ...sequenceMatches(password),
    ...keyboardMatches(password),
    ...repeatMatches(password),
    ...dateMatches(password),
  ].sort((a, b) => b.end - b.start - (a.end - a.start));

  // Greedy: take the longest non-overlapping patterns, then charge the gaps at brute force.
  const taken: Match[] = [];
  const covered = new Array<boolean>(password.length).fill(false);
  for (const match of matches) {
    if (covered.slice(match.start, match.end).some(Boolean)) continue;
    for (let i = match.start; i < match.end; i++) covered[i] = true;
    taken.push(match);
  }

  let guesses = 1;
  const patterns = new Set<PatternKind>();

  for (const match of taken) {
    guesses *= match.guesses;
    patterns.add(match.kind);
  }

  const leftover = password
    .split('')
    .filter((_, index) => !covered[index])
    .join('');
  if (leftover.length > 0) {
    guesses *= Math.pow(alphabetSize(leftover), leftover.length);
    patterns.add('brute');
  }

  // Each pattern is a choice about where the boundaries are; an attacker pays a little for that.
  guesses *= factorial(Math.max(1, taken.length + (leftover ? 1 : 0)));

  return { guesses, score: scoreFor(guesses), patterns: [...patterns] };
}

function dictionaryMatches(password: string): Match[] {
  const lower = password.toLowerCase();
  const unleet = lower.replace(/[013456789@$!|+]/g, (c) => LEET[c] ?? c);
  const found: Match[] = [];

  for (const word of DICTIONARY) {
    for (const haystack of [lower, unleet]) {
      let at = haystack.indexOf(word);
      while (at !== -1) {
        found.push({
          start: at,
          end: at + word.length,
          // Rank in the list, times a small factor for capitalisation and substitution: neither
          // doubles the search space in practice, because everyone does the same ones.
          guesses: (DICTIONARY.indexOf(word) + 1) * 12,
          kind: 'dictionary',
        });
        at = haystack.indexOf(word, at + 1);
      }
    }
  }
  return found;
}

function sequenceMatches(password: string): Match[] {
  const found: Match[] = [];
  let start = 0;

  for (let i = 1; i <= password.length; i++) {
    const step = i < password.length ? password.charCodeAt(i) - password.charCodeAt(i - 1) : 0;
    const previous = i > 1 ? password.charCodeAt(i - 1) - password.charCodeAt(i - 2) : step;

    if (i === password.length || step !== previous || Math.abs(step) !== 1) {
      if (i - start >= 4 && Math.abs(previous) === 1) {
        // A run of ordinary characters: an attacker enumerates these before anything else.
        found.push({ start, end: i, guesses: 30 * (i - start), kind: 'sequence' });
      }
      start = i - 1;
    }
  }
  return found;
}

function keyboardMatches(password: string): Match[] {
  const lower = password.toLowerCase();
  const found: Match[] = [];

  for (const row of KEYBOARD_ROWS) {
    const reversed = [...row].reverse().join('');
    for (const line of [row, reversed]) {
      for (let length = line.length; length >= 4; length--) {
        for (let offset = 0; offset + length <= line.length; offset++) {
          const run = line.slice(offset, offset + length);
          const at = lower.indexOf(run);
          if (at !== -1) found.push({ start: at, end: at + length, guesses: 60 * length, kind: 'keyboard' });
        }
      }
    }
  }
  return found;
}

function repeatMatches(password: string): Match[] {
  const found: Match[] = [];

  // aaaa, abab, abcabcabc: a repeated unit costs the unit plus the repeat count.
  for (const match of password.matchAll(/(.+?)\1+/g)) {
    const whole = match[0];
    const unit = match[1] ?? '';
    if (whole.length < 4 || match.index === undefined) continue;

    found.push({
      start: match.index,
      end: match.index + whole.length,
      guesses: Math.pow(alphabetSize(unit), unit.length) * (whole.length / unit.length),
      kind: 'repeat',
    });
  }
  return found;
}

function dateMatches(password: string): Match[] {
  const found: Match[] = [];

  for (const match of password.matchAll(/(19|20)\d{2}/g)) {
    if (match.index === undefined) continue;
    // A year: about a century of them, and everyone picks from the same few decades.
    found.push({ start: match.index, end: match.index + 4, guesses: 120, kind: 'date' });
  }
  return found;
}

function alphabetSize(text: string): number {
  let size = 0;
  if (/[a-z]/.test(text)) size += 26;
  if (/[A-Z]/.test(text)) size += 26;
  if (/\d/.test(text)) size += 10;
  if (/[^A-Za-z0-9]/.test(text)) size += 33;
  return Math.max(size, 2);
}

function factorial(n: number): number {
  let out = 1;
  for (let i = 2; i <= Math.min(n, 12); i++) out *= i;
  return out;
}

/**
 * zxcvbn's thresholds, which are chosen against real attack rates rather than taste.
 *
 * 1e10 is roughly a day of offline guessing against a fast hash; 1e8 is an afternoon of throttled
 * online guessing. Below 1e6 is not a password.
 */
function scoreFor(guesses: number): StrengthEstimate['score'] {
  if (guesses < 1e3) return 0;
  if (guesses < 1e6) return 1;
  if (guesses < 1e8) return 2;
  if (guesses < 1e10) return 3;
  return 4;
}
