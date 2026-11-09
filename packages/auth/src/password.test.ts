import { describe, expect, it } from 'vitest';
import { assessPassword, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password.js';

/** Cheap parameters: these tests are about behaviour, not about the cost of the KDF. */
const FAST = { memorySizeKb: 8192, iterations: 1, parallelism: 1, hashLength: 32 };

describe('assessPassword', () => {
  const accepted = ['Torque-Bevel-92-Cap', 'chamfer ridge lantern moss', 'Sheen-Matte-Cap-7742'];
  const refused = [
    'short',
    'password1234',
    'Password123!',
    'qwertyuiop12',
    'aaaaaaaaaaaaaaa',
    '000000000000',
  ];

  it.each(accepted)('accepts %s', (password) => {
    expect(assessPassword(password).ok).toBe(true);
  });

  it.each(refused)('refuses %s', (password) => {
    expect(assessPassword(password).ok).toBe(false);
  });

  it('names the problem so the UI can be specific', () => {
    expect(assessPassword('short').problems).toContain('too_short');
    expect(assessPassword('password1234').problems).toContain('too_common');
    expect(assessPassword('aaaaaaaaaaaaaa').problems).toContain('repetitive');
    expect(assessPassword('abcdefghijklmn').problems).toContain('single_character_class');
  });

  it('refuses a password built from the address or the product name', () => {
    expect(assessPassword('brandmanager-2026', { email: 'brandmanager@acme.com' }).problems).toContain(
      'contains_email',
    );
    expect(assessPassword('3D-Product-Renderer-1', { siteName: 'product' }).problems).toContain('contains_site_name');
  });

  it('holds the documented minimum length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(assessPassword('Ab3!'.repeat(2)).problems).toContain('too_short');
  });
});

describe('hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('Torque-Bevel-92-Cap', FAST);
    expect(await verifyPassword(hash, 'Torque-Bevel-92-Cap')).toBe(true);
    expect(await verifyPassword(hash, 'Torque-Bevel-92-Cup')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('Torque-Bevel-92-Cap', FAST);
    const b = await hashPassword('Torque-Bevel-92-Cap', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword(b, 'Torque-Bevel-92-Cap')).toBe(true);
  });

  it('treats a corrupt stored hash as a failed login, not a crash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('encodes the parameters it used, so hashes can be upgraded later', async () => {
    expect(await hashPassword('Torque-Bevel-92-Cap', FAST)).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
  });
});
