import { uuidv7, withSystem, withTenant, type Sql, type Tx } from '@pr/db';
import type { Mailer, MailMessage, SendResult } from '@pr/mail';
import { log } from '@pr/observability';
import { AuthError } from './errors.js';
import {
  assessPasswordFully,
  dummyPasswordHash,
  hashPassword,
  PASSWORD_ALGO,
  verifyPassword,
  type Argon2Params,
} from './password.js';
import type { BreachOptions } from './breach.js';
import { AUTH_LIMITS, memoryRateLimiter, RateLimitedError, type RateLimiter } from './rate-limit.js';
import { DEFAULT_TTLS, hashToken, newToken, type TokenTtls } from './tokens.js';
import type { Role } from './policy.js';

/**
 * The account lifecycle from docs/18-auth-impl.md: invite, verify, set password, sign in, reset.
 *
 * Invite-only by construction — there is no method here that creates an account without a
 * consumed invitation.
 */

/**
 * Re-exported, not redeclared.
 *
 * This interface existed here and in `@pr/notifications` with identical shapes and no relationship,
 * so a change to one was a silent divergence from the other. `@pr/mail` owns it now.
 */
export type { Mailer } from '@pr/mail';

export interface AuthServiceOptions {
  sql: Sql;
  mailer: Mailer;
  /** Absolute URL of the app, used to build invite and reset links. */
  appUrl: string;
  rateLimiter?: RateLimiter;
  ttls?: Partial<TokenTtls>;
  argon2?: Argon2Params;
  /** Where the breached-password lookup goes. Tests point it at a stub; production at the API. */
  breach?: BreachOptions;
  now?: () => Date;
}

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  orgId: string;
  role: Role;
  email: string;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export class AuthService {
  private readonly sql: Sql;
  private readonly mailer: Mailer;

  /**
   * Sends, and never lets the sending decide what the caller returns.
   *
   * A reset request answers the same way whether or not the address exists — that is the whole
   * point of `F-AUTH-05`, and the route's "always 204" comment says so. Letting a mailer failure
   * propagate broke exactly that: the unknown-address path returns before ever reaching the mailer,
   * so a throw here meant 204 for an address with no account and 500 for one with an account. Every
   * deployment without a configured provider was answering the question it refuses to answer.
   *
   * Invitations get the same treatment: a failed send costs the email, not the invitation. What
   * happened is returned, so the console can say "created, but not emailed" instead of "sent".
   */
  private async sendMail(message: MailMessage): Promise<SendResult> {
    try {
      return (await this.mailer.send(message)) ?? { delivered: true };
    } catch (error) {
      log.warn('could not send a message', { template: message.template, error: String(error) });
      return { delivered: false, reason: 'failed' };
    }
  }
  private readonly appUrl: string;
  private readonly limiter: RateLimiter;
  private readonly ttls: TokenTtls;
  private readonly argon2: Argon2Params | undefined;
  private readonly breach: BreachOptions | undefined;
  private readonly now: () => Date;

  constructor(options: AuthServiceOptions) {
    this.sql = options.sql;
    this.mailer = options.mailer;
    this.appUrl = options.appUrl.replace(/\/$/, '');
    this.limiter = options.rateLimiter ?? memoryRateLimiter;
    this.ttls = { ...DEFAULT_TTLS, ...options.ttls };
    this.argon2 = options.argon2;
    this.breach = options.breach;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The password gate, in one place (F-AUTH-03).
   *
   * Both doors that set a password — accepting an invitation and completing a reset — go through
   * here, so a rule added for one cannot be missing from the other.
   */
  private assessPassword(password: string, email: string) {
    return assessPasswordFully(password, {
      email,
      siteName: 'product',
      ...(this.breach ? { breach: this.breach } : {}),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------------------------

  /**
   * Issues an invitation and emails the link. Resending revokes the previous invitation for that
   * address, so only one link is ever live.
   */
  /**
   * Admin-issued invitation (F-AUTH-01). Resending is inviting again: it revokes the previous
   * invitation for that address, so only one link is ever live.
   */
  async createInvitation(input: {
    orgId: string;
    email: string;
    role: Exclude<Role, 'staff'>;
    invitedBy: string | null;
    isStaff?: boolean;
  }): Promise<{ invitationId: string; token: string; delivery: SendResult }> {
    const email = normalizeEmail(input.email);
    const token = newToken();
    const expiresAt = new Date(this.now().getTime() + this.ttls.inviteMs);

    const invitationId = await withTenant(
      this.sql,
      { orgId: input.orgId, userId: input.invitedBy, ...(input.isStaff ? { isStaff: true } : {}) },
      async (tx) => {
        await tx`
          update invitations set revoked_at = now()
          where org_id = ${input.orgId} and email = ${email}
            and consumed_at is null and revoked_at is null`;

        const id = uuidv7();
        await tx`
          insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
          values (${id}, ${input.orgId}, ${email}, ${input.role}, ${hashToken(token)},
                  ${input.invitedBy}, ${expiresAt})`;

        // The account exists in an invited state so the org can see who has been asked.
        await tx`
          insert into users (id, org_id, email, role, status)
          values (${uuidv7()}, ${input.orgId}, ${email}, ${input.role}, 'invited')
          on conflict (email) do nothing`;

        await tx`
          insert into audit_log (org_id, actor_user_id, action, target_type, target_id)
          values (${input.orgId}, ${input.invitedBy}, 'invite.created', 'email', ${email})`;

        return id;
      },
    );

    const delivery = await this.sendMail({
      to: email,
      template: 'invite',
      vars: { url: `${this.appUrl}/invite/accept?token=${token}`, expiresAt: expiresAt.toISOString() },
    });

    return { invitationId, token, delivery };
  }

  /**
   * Sends a fresh link to somebody who has not accepted yet (F-AUTH-01, F-ORG-02).
   *
   * Inviting again, with the role they were first invited with: the old link dies, so only one is
   * ever live. Null for an address with no invitation outstanding, so "resend" can never quietly
   * become "invite a new person".
   */
  async resendInvitation(input: {
    orgId: string;
    email: string;
    invitedBy: string | null;
    isStaff?: boolean;
  }): Promise<{ invitationId: string; token: string; delivery: SendResult } | null> {
    const email = normalizeEmail(input.email);
    const pending = await withTenant(
      this.sql,
      { orgId: input.orgId, userId: input.invitedBy, ...(input.isStaff ? { isStaff: true } : {}) },
      async (tx) => {
        const [row] = await tx`
          select i.role from invitations i
          join users u on u.email = i.email and u.org_id = i.org_id and u.status = 'invited'
          where i.org_id = ${input.orgId} and i.email = ${email} and i.consumed_at is null
          order by i.created_at desc limit 1`;
        return row;
      },
    );
    if (!pending) return null;

    return this.createInvitation({
      orgId: input.orgId,
      email,
      role: pending['role'] as Exclude<Role, 'staff'>,
      invitedBy: input.invitedBy,
      ...(input.isStaff ? { isStaff: true } : {}),
    });
  }

  /**
   * Withdraws an invitation that has not been accepted: its link stops working, and the placeholder
   * account created with it goes, so the person no longer shows as invited. Audited.
   */
  async revokeInvitation(
    orgId: string,
    email: string,
    actorId: string | null,
    options: { isStaff?: boolean } = {},
  ): Promise<void> {
    const address = normalizeEmail(email);
    await withTenant(
      this.sql,
      { orgId, userId: actorId, ...(options.isStaff ? { isStaff: true } : {}) },
      async (tx) => {
        await tx`
          update invitations set revoked_at = now()
          where org_id = ${orgId} and email = ${address}
            and consumed_at is null and revoked_at is null`;
        await tx`delete from users where org_id = ${orgId} and email = ${address} and status = 'invited'`;
        await tx`
          insert into audit_log (org_id, actor_user_id, action, target_type, target_id)
          values (${orgId}, ${actorId}, 'invite.revoked', 'email', ${address})`;
      },
    );
  }

  /** Consumes an invitation, sets the password, and signs the new user in. */
  /**
   * Accepting an invitation (F-AUTH-02, F-AUTH-03).
   *
   * Holding the link is the proof of mailbox control, which is why the token is single-use and
   * stored only as a hash; the password set here goes through the strength gate and the breach
   * check before the account becomes active.
   */
  async acceptInvitation(
    input: { token: string; password: string },
    meta: RequestMeta = {},
  ): Promise<{ token: string; principal: SessionPrincipal }> {
    await this.limit(`invite:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.inviteAccept);

    const tokenHash = hashToken(input.token);
    const now = this.now();

    const invitation = await withSystem(this.sql, async (tx) => {
      const [row] = await tx`
        select i.id, i.org_id, i.email, i.role, i.expires_at, i.consumed_at, i.revoked_at,
               o.status as org_status
        from invitations i
        join organizations o on o.id = i.org_id
        where i.token_hash = ${tokenHash}`;
      return row;
    });

    if (
      !invitation ||
      invitation['consumed_at'] ||
      invitation['revoked_at'] ||
      new Date(invitation['expires_at'] as string) < now ||
      invitation['org_status'] !== 'active'
    ) {
      throw new AuthError('invite_invalid');
    }

    const assessment = await this.assessPassword(input.password, invitation['email'] as string);
    if (!assessment.ok) {
      throw new AuthError('password_weak', 'password is too weak', { problems: assessment.problems });
    }

    const passwordHash = await hashPassword(input.password, this.argon2);
    const orgId = invitation['org_id'] as string;

    return withTenant(this.sql, { orgId, userId: null }, async (tx) => {
      // Single use is enforced by the database, not by checking first and writing after.
      const consumed = await tx`
        update invitations set consumed_at = now()
        where id = ${invitation['id']} and consumed_at is null
        returning id`;
      if (consumed.length === 0) throw new AuthError('invite_invalid');

      const [user] = await tx`
        insert into users (id, org_id, email, password_hash, password_algo, role, status, email_verified_at)
        values (${uuidv7()}, ${orgId}, ${invitation['email']}, ${passwordHash}, ${PASSWORD_ALGO},
                ${invitation['role']}, 'active', now())
        on conflict (email) do update
          set password_hash = excluded.password_hash,
              password_algo = excluded.password_algo,
              role = excluded.role,
              status = 'active',
              email_verified_at = now(),
              -- Setting a password clears any lockout: someone who proves control of their mailbox
              -- should not also have to wait out a stranger's failed guesses.
              failed_logins = 0,
              locked_until = null
        returning id, org_id, email, role`;

      await tx`
        insert into audit_log (org_id, actor_user_id, action)
        values (${orgId}, ${user!['id']}, 'invite.accepted')`;

      const session = await this.insertSession(tx, user!, meta);
      return session;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------

  /**
   * Email and password sign-in (F-AUTH-04, F-AUTH-06).
   *
   * Enumeration-safe: the same error and the same amount of work whether or not the address
   * exists. The session it returns carries the cookie settings in `tokens.ts` — `__Host-`,
   * HttpOnly, Secure, SameSite — and both an idle and an absolute expiry.
   */
  async login(
    input: { email: string; password: string },
    meta: RequestMeta = {},
  ): Promise<{ token: string; principal: SessionPrincipal }> {
    const email = normalizeEmail(input.email);
    await this.limit(`login:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.loginPerIp);
    await this.limit(`login:email:${email}`, AUTH_LIMITS.loginPerAccount);

    const user = await withSystem(this.sql, async (tx) => {
      const [row] = await tx`
        select u.id, u.org_id, u.email, u.role, u.status, u.password_hash, u.locked_until,
               u.failed_logins, o.status as org_status
        from users u join organizations o on o.id = u.org_id
        where u.email = ${email}`;
      return row;
    });

    // Always verify something, so the response takes the same time either way.
    const hash = (user?.['password_hash'] as string | null) ?? (await dummyPasswordHash(this.argon2));
    const passwordOk = await verifyPassword(hash, input.password);

    const lockedUntil = user?.['locked_until'] ? new Date(user['locked_until'] as string) : null;
    const usable =
      user &&
      passwordOk &&
      user['status'] === 'active' &&
      user['org_status'] === 'active' &&
      (!lockedUntil || lockedUntil <= this.now());

    if (!usable) {
      if (user) await this.noteFailedLogin(user['id'] as string);
      throw new AuthError('invalid_credentials');
    }

    const orgId = user['org_id'] as string;
    return withTenant(this.sql, { orgId, userId: user['id'] as string }, async (tx) => {
      await tx`
        update users
        set failed_logins = 0, locked_until = null, last_login_at = now()
        where id = ${user['id']}`;
      await tx`
        insert into audit_log (org_id, actor_user_id, action, ip)
        values (${orgId}, ${user['id']}, 'auth.login', ${meta.ip ?? null})`;
      return this.insertSession(tx, user, meta);
    });
  }

  async validateSession(token: string): Promise<SessionPrincipal | null> {
    const now = this.now();
    const [row] = await withSystem(
      this.sql,
      async (tx) => tx`
        select s.id, s.user_id, s.org_id, s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
               u.role, u.email, u.status
        from sessions s join users u on u.id = s.user_id
        where s.token_hash = ${hashToken(token)}`,
    );

    if (
      !row ||
      row['revoked_at'] ||
      row['status'] !== 'active' ||
      new Date(row['idle_expires_at'] as string) < now ||
      new Date(row['absolute_expires_at'] as string) < now
    ) {
      return null;
    }

    // Slide the idle window, but never past the absolute expiry.
    const idleExpiresAt = new Date(
      Math.min(
        now.getTime() + this.ttls.sessionIdleMs,
        new Date(row['absolute_expires_at'] as string).getTime(),
      ),
    );
    await withSystem(
      this.sql,
      async (tx) => tx`
        update sessions set last_seen_at = ${now}, idle_expires_at = ${idleExpiresAt}
        where id = ${row['id']}`,
    );

    return {
      sessionId: row['id'] as string,
      userId: row['user_id'] as string,
      orgId: row['org_id'] as string,
      role: row['role'] as Role,
      email: row['email'] as string,
    };
  }

  async logout(token: string): Promise<void> {
    await withSystem(
      this.sql,
      async (tx) => tx`update sessions set revoked_at = now() where token_hash = ${hashToken(token)}`,
    );
  }

  /** "Sign out everywhere" (F-AUTH-06): every session for the user, not just this one. */
  async logoutEverywhere(userId: string): Promise<void> {
    await withSystem(
      this.sql,
      async (tx) =>
        tx`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------------------------

  /** Always resolves the same way, whether or not the address exists. */
  /**
   * Forgot and reset password (F-AUTH-05).
   *
   * The same token mechanics as an invitation, and completing one revokes every session the user
   * has — a reset is what someone does when they think an account is compromised, so leaving the
   * intruder's session alive would defeat the point.
   */
  async requestPasswordReset(email: string, meta: RequestMeta = {}): Promise<void> {
    await this.limit(`reset:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.resetRequest);
    const normalized = normalizeEmail(email);

    const user = await withSystem(this.sql, async (tx) => {
      const [row] = await tx`select id, status from users where email = ${normalized}`;
      return row;
    });
    if (!user || user['status'] !== 'active') return;

    const token = newToken();
    const expiresAt = new Date(this.now().getTime() + this.ttls.resetMs);
    await withSystem(
      this.sql,
      async (tx) => tx`
        insert into password_resets (id, user_id, token_hash, expires_at)
        values (${uuidv7()}, ${user['id']}, ${hashToken(token)}, ${expiresAt})`,
    );

    await this.sendMail({
      to: normalized,
      template: 'password-reset',
      vars: { url: `${this.appUrl}/reset?token=${token}`, expiresAt: expiresAt.toISOString() },
    });
  }

  /** Completing a reset signs every device out; a stolen session must not survive it. */
  async completePasswordReset(input: { token: string; password: string }): Promise<void> {
    const [row] = await withSystem(
      this.sql,
      async (tx) => tx`
        select r.id, r.user_id, r.expires_at, r.consumed_at, u.email, u.org_id
        from password_resets r join users u on u.id = r.user_id
        where r.token_hash = ${hashToken(input.token)}`,
    );

    if (!row || row['consumed_at'] || new Date(row['expires_at'] as string) < this.now()) {
      throw new AuthError('reset_invalid');
    }

    const assessment = await this.assessPassword(input.password, row['email'] as string);
    if (!assessment.ok) {
      throw new AuthError('password_weak', 'password is too weak', { problems: assessment.problems });
    }

    const passwordHash = await hashPassword(input.password, this.argon2);

    await withSystem(this.sql, async (tx) => {
      const consumed = await tx`
        update password_resets set consumed_at = now()
        where id = ${row['id']} and consumed_at is null returning id`;
      if (consumed.length === 0) throw new AuthError('reset_invalid');

      await tx`
        update users set password_hash = ${passwordHash}, password_algo = ${PASSWORD_ALGO},
                         failed_logins = 0, locked_until = null
        where id = ${row['user_id']}`;
      await tx`update sessions set revoked_at = now() where user_id = ${row['user_id']} and revoked_at is null`;
      await tx`
        insert into audit_log (org_id, actor_user_id, action)
        values (${row['org_id']}, ${row['user_id']}, 'auth.password_reset')`;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async insertSession(
    tx: Tx,
    user: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<{ token: string; principal: SessionPrincipal }> {
    const token = newToken();
    const id = uuidv7();
    const now = this.now();

    await tx`
      insert into sessions (id, user_id, org_id, token_hash, ip, user_agent,
                            idle_expires_at, absolute_expires_at)
      values (${id}, ${user['id']}, ${user['org_id']}, ${hashToken(token)},
              ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 512) ?? null},
              ${new Date(now.getTime() + this.ttls.sessionIdleMs)},
              ${new Date(now.getTime() + this.ttls.sessionAbsoluteMs)})`;

    return {
      token,
      principal: {
        sessionId: id,
        userId: user['id'] as string,
        orgId: user['org_id'] as string,
        role: user['role'] as Role,
        email: user['email'] as string,
      },
    };
  }

  /**
   * Exponential lockout: five failures buys a pause that doubles with each further attempt.
   *
   * The deadline is computed from the service clock rather than the database's, so time is a single
   * injectable thing — otherwise tests (and anything that runs on a clock-skewed host) would compare
   * two different "now"s.
   */
  private async noteFailedLogin(userId: string): Promise<void> {
    const now = this.now();
    await withSystem(this.sql, async (tx) => {
      const [row] = await tx`select failed_logins from users where id = ${userId}`;
      const failures = Number(row?.['failed_logins'] ?? 0) + 1;
      const lockedUntil =
        failures >= 5
          ? new Date(now.getTime() + Math.min(2 ** (failures - 5), 60) * 60_000)
          : null;

      await tx`
        update users
        set failed_logins = ${failures},
            locked_until = coalesce(${lockedUntil}, locked_until)
        where id = ${userId}`;
    });
  }

  private async limit(key: string, rule: { points: number; windowSec: number }): Promise<void> {
    try {
      await this.limiter.consume(key, rule);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        throw new AuthError('rate_limited', error.message, { retryAfterSec: error.retryAfterSec });
      }
      // Auth limits fail closed: an unavailable limiter must not become an open door.
      throw new AuthError('rate_limited', 'rate limiter unavailable');
    }
  }
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
