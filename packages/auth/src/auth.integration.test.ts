import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, hasDatabase, seedOrganizations, withStaff, type Sql, type TestDatabase } from '@pr/db';
import { AuthError } from './errors.js';
import { MemoryRateLimiter, type RateLimiter } from './rate-limit.js';
import { AuthService, type Mailer } from './service.js';
import type { Argon2Params } from './password.js';

/**
 * The account lifecycle against a real database (docs/18-auth-impl.md "Test matrix").
 *
 * Single-use tokens, lockout and session revocation are all enforced by SQL, so testing them
 * without PostgreSQL would test something else entirely.
 */

/** Deliberately weak parameters: these tests exercise the flow, not the cost of the KDF. */
const FAST_ARGON2: Argon2Params = { memorySizeKb: 8192, iterations: 1, parallelism: 1, hashLength: 32 };

/**
 * A limiter that never limits.
 *
 * Lockout and rate limiting are separate defences with separate tests; the lockout tests need many
 * failed attempts, so they run against this rather than against a limiter nudged with random clocks
 * — which could, and did, accumulate a count and fail the wrong assertion.
 */
const unlimited: RateLimiter = {
  consume: async () => {},
  reset: async () => {},
};

const GOOD_PASSWORD = 'Torque-Bevel-92-Cap';

class RecordingMailer implements Mailer {
  readonly sent: { to: string; template: string; vars: Record<string, unknown> }[] = [];

  async send(message: { to: string; template: string; vars: Record<string, unknown> }) {
    this.sent.push(message);
    return { delivered: true } as const;
  }

  last(template: string) {
    return [...this.sent].reverse().find((m) => m.template === template);
  }

  clear() {
    this.sent.length = 0;
  }
}

describe.skipIf(!hasDatabase)('auth', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let mailer: RecordingMailer;
  let now: Date;
  let auth: AuthService;

  const build = (overrides: Partial<ConstructorParameters<typeof AuthService>[0]> = {}) =>
    new AuthService({
      sql,
      mailer,
      appUrl: 'https://app.example.com',
      argon2: FAST_ARGON2,
      rateLimiter: new MemoryRateLimiter(() => now.getTime()),
      // No third party in the loop: whether haveibeenpwned is up says nothing about this code.
      breach: { enabled: false },
      now: () => now,
      ...overrides,
    });

  beforeAll(async () => {
    db = await createTestDatabase('pr_auth');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    mailer = new RecordingMailer();
    now = new Date('2026-03-01T10:00:00Z');
    auth = build();
  });

  const invite = async (email: string, role: 'owner' | 'member' = 'member') =>
    auth.createInvitation({ orgId: orgs.alpha, email, role, invitedBy: null });

  // -------------------------------------------------------------------------------------------

  describe('invitation', () => {
    it('emails a link and creates an invited user', async () => {
      const { token } = await invite('first@example.com');

      const mail = mailer.last('invite')!;
      expect(mail.to).toBe('first@example.com');
      expect(mail.vars['url']).toContain(token);

      const [user] = await withStaff(sql, (tx) => tx`select status from users where email = 'first@example.com'`);
      expect(user!['status']).toBe('invited');
    });

    it('never stores the raw token', async () => {
      const { token } = await invite('hashed@example.com');
      const rows = await withStaff(sql, (tx) => tx`select token_hash::text as hash from invitations`);
      expect(rows.every((r) => !String(r['hash']).includes(token))).toBe(true);
    });

    it('activates the account and signs the user in', async () => {
      const { token } = await invite('accept@example.com');
      const session = await auth.acceptInvitation({ token, password: GOOD_PASSWORD });

      expect(session.principal.orgId).toBe(orgs.alpha);
      expect(session.principal.role).toBe('member');

      const [user] = await withStaff(
        sql,
        (tx) => tx`select status, email_verified_at from users where email = 'accept@example.com'`,
      );
      expect(user!['status']).toBe('active');
      expect(user!['email_verified_at']).not.toBeNull();
    });

    it('refuses a token that has already been used', async () => {
      const { token } = await invite('replay@example.com');
      await auth.acceptInvitation({ token, password: GOOD_PASSWORD });

      await expect(auth.acceptInvitation({ token, password: GOOD_PASSWORD })).rejects.toMatchObject({
        code: 'invite_invalid',
      });
    });

    it('refuses an expired token', async () => {
      const { token } = await invite('expired@example.com');
      now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
      auth = build();

      await expect(auth.acceptInvitation({ token, password: GOOD_PASSWORD })).rejects.toMatchObject({
        code: 'invite_invalid',
      });
    });

    it('refuses a revoked token', async () => {
      const { token } = await invite('revoked@example.com');
      await auth.revokeInvitation(orgs.alpha, 'revoked@example.com', null);

      await expect(auth.acceptInvitation({ token, password: GOOD_PASSWORD })).rejects.toMatchObject({
        code: 'invite_invalid',
      });
    });

    it('invalidates the previous link when an invitation is resent', async () => {
      const first = await invite('resent@example.com');
      const second = await invite('resent@example.com');

      await expect(
        auth.acceptInvitation({ token: first.token, password: GOOD_PASSWORD }),
      ).rejects.toMatchObject({ code: 'invite_invalid' });
      await expect(
        auth.acceptInvitation({ token: second.token, password: GOOD_PASSWORD }),
      ).resolves.toBeTruthy();
    });

    it('reports whether the email actually went', async () => {
      expect((await invite('delivered@example.com')).delivery).toEqual({ delivered: true });

      const quiet = build({ mailer: { send: async () => ({ delivered: false, reason: 'no_provider' }) } });
      const issued = await quiet.createInvitation({
        orgId: orgs.alpha,
        email: 'unsent@example.com',
        role: 'member',
        invitedBy: null,
      });
      expect(issued.delivery).toEqual({ delivered: false, reason: 'no_provider' });
    });

    it('resends with the original role, and only the new link works', async () => {
      const first = await invite('again@example.com', 'owner');
      mailer.clear();

      const resent = await auth.resendInvitation({ orgId: orgs.alpha, email: 'Again@Example.com', invitedBy: null });
      expect(resent).not.toBeNull();
      expect(mailer.last('invite')!.vars['url']).toContain(resent!.token);

      await expect(
        auth.acceptInvitation({ token: first.token, password: GOOD_PASSWORD }),
      ).rejects.toMatchObject({ code: 'invite_invalid' });
      const session = await auth.acceptInvitation({ token: resent!.token, password: GOOD_PASSWORD });
      expect(session.principal.role).toBe('owner');
    });

    it('will not resend to somebody who was never invited, or who already accepted', async () => {
      expect(await auth.resendInvitation({ orgId: orgs.alpha, email: 'stranger@example.com', invitedBy: null })).toBeNull();

      const { token } = await invite('joined@example.com');
      await auth.acceptInvitation({ token, password: GOOD_PASSWORD });
      mailer.clear();
      expect(await auth.resendInvitation({ orgId: orgs.alpha, email: 'joined@example.com', invitedBy: null })).toBeNull();
      expect(mailer.sent).toHaveLength(0);
    });

    it('revoking removes the invited placeholder and is audited', async () => {
      await invite('withdrawn@example.com');
      await auth.revokeInvitation(orgs.alpha, 'withdrawn@example.com', null);

      const users = await withStaff(sql, (tx) => tx`select 1 from users where email = 'withdrawn@example.com'`);
      expect(users).toHaveLength(0);
      const audit = await withStaff(
        sql,
        (tx) => tx`select action from audit_log where target_id = 'withdrawn@example.com'`,
      );
      expect(audit.map((r) => r['action'])).toContain('invite.revoked');
      // Nothing left to resend, and the address can be invited afresh.
      expect(await auth.resendInvitation({ orgId: orgs.alpha, email: 'withdrawn@example.com', invitedBy: null })).toBeNull();
      await expect(invite('withdrawn@example.com')).resolves.toBeTruthy();
    });

    it('revoking never touches somebody who has already joined', async () => {
      const { token } = await invite('member-now@example.com');
      await auth.acceptInvitation({ token, password: GOOD_PASSWORD });
      await auth.revokeInvitation(orgs.alpha, 'member-now@example.com', null);

      const [user] = await withStaff(sql, (tx) => tx`select status from users where email = 'member-now@example.com'`);
      expect(user!['status']).toBe('active');
    });

    it('refuses a weak password and says what is wrong with it', async () => {
      const { token } = await invite('weak@example.com');
      await expect(auth.acceptInvitation({ token, password: 'password123' })).rejects.toMatchObject({
        code: 'password_weak',
      });

      // The invitation survives a rejected attempt, so the user can simply try again.
      await expect(
        auth.acceptInvitation({ token, password: GOOD_PASSWORD }),
      ).resolves.toBeTruthy();
    });

    it('refuses a password built from the invited address', async () => {
      const { token } = await invite('brandmanager@example.com');
      await expect(
        auth.acceptInvitation({ token, password: 'brandmanager-2026' }),
      ).rejects.toMatchObject({ code: 'password_weak' });
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('sign in', () => {
    const email = 'signin@example.com';

    beforeEach(async () => {
      const { token } = await invite(email);
      await auth.acceptInvitation({ token, password: GOOD_PASSWORD });
    });

    it('accepts the right password', async () => {
      const session = await auth.login({ email, password: GOOD_PASSWORD });
      expect(session.principal.email).toBe(email);
      expect(await auth.validateSession(session.token)).toMatchObject({ email });
    });

    it('is case- and whitespace-insensitive about the address', async () => {
      await expect(auth.login({ email: `  ${email.toUpperCase()} `, password: GOOD_PASSWORD })).resolves.toBeTruthy();
    });

    it('gives the same answer for a wrong password and an unknown address', async () => {
      const wrong = await auth.login({ email, password: 'Wrong-Password-123' }).catch((e: AuthError) => e);
      const unknown = await auth
        .login({ email: 'nobody@example.com', password: GOOD_PASSWORD })
        .catch((e: AuthError) => e);

      expect((wrong as AuthError).code).toBe('invalid_credentials');
      expect((unknown as AuthError).code).toBe('invalid_credentials');
      expect((wrong as AuthError).message).toBe((unknown as AuthError).message);
    });

    it('locks the account after repeated failures and unlocks with time', async () => {
      const loose = build({ rateLimiter: unlimited });
      for (let i = 0; i < 5; i++) {
        await loose.login({ email, password: 'Wrong-Password-123' }).catch(() => undefined);
      }

      // Correct password, but the account is locked.
      await expect(loose.login({ email, password: GOOD_PASSWORD })).rejects.toMatchObject({
        code: 'invalid_credentials',
      });

      now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const later = build({ rateLimiter: new MemoryRateLimiter(() => now.getTime()) });
      await expect(later.login({ email, password: GOOD_PASSWORD })).resolves.toBeTruthy();
    });

    it('rate limits by address before the password is even checked', async () => {
      for (let i = 0; i < 5; i++) {
        await auth.login({ email, password: 'Wrong-Password-123' }).catch(() => undefined);
      }
      await expect(auth.login({ email, password: GOOD_PASSWORD })).rejects.toMatchObject({
        code: 'rate_limited',
      });
    });

    it('writes an audit entry', async () => {
      await auth.login({ email, password: GOOD_PASSWORD });
      const rows = await withStaff(
        sql,
        (tx) => tx`select action from audit_log where action = 'auth.login' order by created_at desc limit 1`,
      );
      expect(rows[0]!['action']).toBe('auth.login');
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('sessions', () => {
    const email = 'session@example.com';
    let token: string;

    beforeEach(async () => {
      const invitation = await invite(email);
      const session = await auth.acceptInvitation({ token: invitation.token, password: GOOD_PASSWORD });
      token = session.token;
    });

    it('rejects an unknown token', async () => {
      expect(await auth.validateSession('not-a-real-token')).toBeNull();
    });

    it('expires on the idle window', async () => {
      now = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);
      expect(await build().validateSession(token)).toBeNull();
    });

    it('expires on the absolute window even if used constantly', async () => {
      for (let day = 1; day <= 31; day++) {
        now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const result = await build().validateSession(token);
        // The 30-day deadline is inclusive: the session dies once the clock passes it.
        if (day > 30) expect(result).toBeNull();
        else expect(result).not.toBeNull();
      }
    });

    it('ends on sign out', async () => {
      await auth.logout(token);
      expect(await auth.validateSession(token)).toBeNull();
    });

    it('ends everywhere on request', async () => {
      const second = await auth.login({ email, password: GOOD_PASSWORD });
      const principal = await auth.validateSession(token);
      await auth.logoutEverywhere(principal!.userId);

      expect(await auth.validateSession(token)).toBeNull();
      expect(await auth.validateSession(second.token)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('password reset', () => {
    const email = 'reset@example.com';

    beforeEach(async () => {
      const invitation = await invite(email);
      await auth.acceptInvitation({ token: invitation.token, password: GOOD_PASSWORD });
      mailer.clear();
    });

    it('says nothing about whether an address exists', async () => {
      await expect(auth.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
      expect(mailer.sent).toHaveLength(0);

      await auth.requestPasswordReset(email);
      expect(mailer.last('password-reset')).toBeDefined();
    });

    /**
     * The same question, asked of a deployment whose mail provider is refusing.
     *
     * This is how the guarantee was actually broken in production. The unknown-address path returns
     * before it reaches the mailer, so only the *existing* address could throw — which turned "the
     * same answer either way" into 204 for an address with no account and 500 for one with an
     * account. Nothing about a mailer may reach the caller.
     */
    it('says nothing about whether an address exists, even when mail is broken', async () => {
      const broken = build({
        mailer: {
          send: async () => {
            throw new Error('the development mailer is disabled; configure a real mail provider');
          },
        },
      });

      await expect(broken.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
      await expect(broken.requestPasswordReset(email)).resolves.toBeUndefined();
    });

    it('still issues an invitation when the message cannot be sent', async () => {
      const broken = build({
        mailer: {
          send: async () => {
            throw new Error('provider down');
          },
        },
      });

      // A failed send costs the email, not the invitation — and says so, so the console does not
      // claim it was sent.
      const issued = await broken.createInvitation({
        orgId: orgs.alpha,
        email: 'unreachable@example.com',
        role: 'member',
        invitedBy: null,
      });
      expect(issued.token).toBeTruthy();
      expect(issued.delivery).toEqual({ delivered: false, reason: 'failed' });
    });

    it('changes the password and refuses the old one', async () => {
      await auth.requestPasswordReset(email);
      const token = tokenFromUrl(mailer.last('password-reset')!.vars['url'] as string);

      await auth.completePasswordReset({ token, password: 'Sheen-Matte-Cap-77' });

      await expect(auth.login({ email, password: GOOD_PASSWORD })).rejects.toMatchObject({
        code: 'invalid_credentials',
      });
      const fresh = build();
      await expect(fresh.login({ email, password: 'Sheen-Matte-Cap-77' })).resolves.toBeTruthy();
    });

    it('signs every device out', async () => {
      const session = await auth.login({ email, password: GOOD_PASSWORD });
      await auth.requestPasswordReset(email);
      const token = tokenFromUrl(mailer.last('password-reset')!.vars['url'] as string);

      await auth.completePasswordReset({ token, password: 'Sheen-Matte-Cap-77' });
      expect(await auth.validateSession(session.token)).toBeNull();
    });

    it('refuses a reused or expired token', async () => {
      await auth.requestPasswordReset(email);
      const token = tokenFromUrl(mailer.last('password-reset')!.vars['url'] as string);
      await auth.completePasswordReset({ token, password: 'Sheen-Matte-Cap-77' });

      await expect(
        auth.completePasswordReset({ token, password: 'Another-Good-One-42' }),
      ).rejects.toMatchObject({ code: 'reset_invalid' });

      await auth.requestPasswordReset(email);
      const second = tokenFromUrl(mailer.last('password-reset')!.vars['url'] as string);
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      await expect(
        build().completePasswordReset({ token: second, password: 'Another-Good-One-42' }),
      ).rejects.toMatchObject({ code: 'reset_invalid' });
    });

    it('clears a lockout, so a locked-out user can recover without support', async () => {
      const loose = build({ rateLimiter: unlimited });
      for (let i = 0; i < 6; i++) {
        await loose.login({ email, password: 'Wrong-Password-123' }).catch(() => undefined);
      }

      await auth.requestPasswordReset(email);
      const token = tokenFromUrl(mailer.last('password-reset')!.vars['url'] as string);
      await auth.completePasswordReset({ token, password: 'Sheen-Matte-Cap-77' });

      await expect(build().login({ email, password: 'Sheen-Matte-Cap-77' })).resolves.toBeTruthy();
    });
  });
});

const tokenFromUrl = (url: string) => new URL(url).searchParams.get('token')!;
