# 18 — Auth Implementation

Hand-rolled sessions over Postgres/Redis: ~400 lines, fully auditable, no framework surprises.
Design rationale and threat model in [05](05-security.md); tables in [11](11-data-model.md).

---

## Primitives

```ts
const TOKEN_BYTES = 32;                                   // 256-bit
const newToken   = () => base64url(crypto.randomBytes(TOKEN_BYTES));
const hashToken  = (t: string) => crypto.createHash('sha256').update(t).digest();   // stored form

const argon2Params = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };
const hashPassword   = (p: string) => argon2.hash(p, argon2Params);
const verifyPassword = (h: string, p: string) => argon2.verify(h, p);

const INVITE_TTL_MS  = 7 * 24 * 3600_000;
const RESET_TTL_MS   = 60 * 60_000;
const IDLE_TTL_MS    = 14 * 24 * 3600_000;
const ABSOLUTE_TTL_MS= 30 * 24 * 3600_000;
```

## Invitation (F-AUTH-01 / W-01)

```ts
async function createInvitation(actor: Session, input: { email: string; orgId: string; role: Role }) {
  authorize(actor, 'invite.create', { orgId: input.orgId });          // staff, or owner of that org

  const token = newToken();
  await db.tx(async (tx) => {
    await tx.invitations.revokeActive(input.orgId, input.email);      // resend invalidates the old link
    await tx.invitations.insert({
      orgId: input.orgId, email: normalizeEmail(input.email), role: input.role,
      tokenHash: hashToken(token), invitedBy: actor.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    await tx.users.upsertInvited({ orgId: input.orgId, email: input.email, role: input.role });
    await tx.audit.write({ orgId: input.orgId, actor: actor.userId, action: 'invite.created', target: input.email });
  });

  await mailer.send({ to: input.email, template: 'invite',
                      vars: { url: `${APP_URL}/invite/accept?token=${token}`, org: orgName, expiresInDays: 7 } });
  // The raw token exists only in this email. It is never logged, never stored, never returned.
}
```

## Acceptance: verify email + set password (F-AUTH-02/03)

```ts
async function acceptInvitation(input: { token: string; password: string }, req: Req) {
  await rateLimit(`invite:${req.ip}`, { points: 10, windowSec: 600 });

  const invite = await db.invitations.findByHash(hashToken(input.token));
  if (!invite || invite.consumedAt || invite.revokedAt || invite.expiresAt < new Date())
    throw new AuthError('invite_invalid');                            // one neutral error for all cases

  const strength = zxcvbn(input.password, [invite.email, orgSlug]);
  if (input.password.length < 12 || strength.score < 3) throw new AuthError('password_weak', strength.feedback);
  if (await isBreached(input.password)) throw new AuthError('password_breached');   // k-anonymity range query

  const session = await db.tx(async (tx) => {
    const consumed = await tx.invitations.consumeIfUnused(invite.id);  // UPDATE … WHERE consumed_at IS NULL
    if (!consumed) throw new AuthError('invite_invalid');              // single-use enforced by the DB, not by app logic

    const user = await tx.users.activate({
      orgId: invite.orgId, email: invite.email, role: invite.role,
      passwordHash: await hashPassword(input.password),
      emailVerifiedAt: new Date(),                                     // clicking the link IS the verification
      status: 'active',
    });
    await tx.audit.write({ orgId: invite.orgId, actor: user.id, action: 'invite.accepted' });
    return createSession(tx, user, req);
  });

  return setSessionCookie(session);
}
```

## Sign-in (F-AUTH-04)

```ts
async function login(input: { email: string; password: string }, req: Req) {
  await rateLimit(`login:ip:${req.ip}`,        { points: 10, windowSec: 60 });
  await rateLimit(`login:email:${input.email}`,{ points: 5,  windowSec: 300 });

  const user = await db.users.findByEmail(normalizeEmail(input.email));
  const hash = user?.passwordHash ?? DUMMY_ARGON2_HASH;                // constant-time-ish: always verify
  const ok   = await verifyPassword(hash, input.password);

  if (!user || !ok || user.status !== 'active' || user.lockedUntil > new Date()) {
    if (user) await db.users.noteFailedLogin(user.id);                 // exponential lockout after 5
    await sleepJitter(50, 150);
    throw new AuthError('invalid_credentials');                        // identical for every failure mode
  }

  if (needsRehash(user.passwordAlgo)) await db.users.setPasswordHash(user.id, await hashPassword(input.password));
  await db.users.noteSuccessfulLogin(user.id);
  const session = await createSession(db, user, req);
  await db.audit.write({ orgId: user.orgId, actor: user.id, action: 'auth.login' });
  return setSessionCookie(session);
}
```

## Sessions

```ts
async function createSession(tx, user, req) {
  const token = newToken();
  await tx.sessions.insert({
    userId: user.id, orgId: user.orgId, tokenHash: hashToken(token),
    ip: req.ip, userAgent: req.ua.slice(0, 512),
    idleExpiresAt: new Date(Date.now() + IDLE_TTL_MS),
    absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_TTL_MS),
  });
  return { token, user };
}

const cookie = {
  name: '__Host-session', httpOnly: true, secure: true, sameSite: 'lax', path: '/',
  maxAge: IDLE_TTL_MS / 1000,
};

// Request middleware — the single place tenancy is established.
export async function withSession(req): Promise<Ctx | null> {
  const raw = req.cookies.get('__Host-session'); if (!raw) return null;

  const cached = await redis.get(`sess:${hashToken(raw).toString('hex')}`);   // hot path avoids Postgres
  const s = cached ?? await db.sessions.findValidByHash(hashToken(raw));
  if (!s || s.revokedAt || s.idleExpiresAt < now || s.absoluteExpiresAt < now) return null;

  if (now - s.lastSeenAt > 60_000) await db.sessions.touch(s.id, now);        // slide idle window
  return { userId: s.userId, orgId: s.orgId, role: s.role, sessionId: s.id };
}

// Every DB access runs inside this, so RLS is always armed (11 §RLS).
export function withTenant<T>(ctx: Ctx, fn: (tx) => Promise<T>) {
  return db.tx(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id',  ${ctx.userId}, true),
                                set_config('app.org_id',   ${ctx.orgId},  true),
                                set_config('app.is_staff', ${ctx.role === 'staff' ? 'on' : 'off'}, true)`);
    return fn(tx);
  });
}
```

CSRF: `SameSite=Lax` plus an `Origin` check on every state-changing request; a double-submit token
is added for any endpoint that must accept cross-site POSTs (none today).

## Password reset (F-AUTH-05)

```ts
async function requestReset(email: string, req: Req) {
  await rateLimit(`reset:ip:${req.ip}`, { points: 5, windowSec: 600 });
  const user = await db.users.findByEmail(normalizeEmail(email));
  if (user?.status === 'active') {
    const token = newToken();
    await db.passwordResets.insert({ userId: user.id, tokenHash: hashToken(token),
                                     expiresAt: new Date(Date.now() + RESET_TTL_MS) });
    await mailer.send({ to: email, template: 'reset', vars: { url: `${APP_URL}/reset?token=${token}` } });
  }
  return { status: 204 };                                   // identical response either way
}

async function completeReset(input: { token: string; password: string }) {
  const row = await db.passwordResets.findByHash(hashToken(input.token));
  if (!row || row.consumedAt || row.expiresAt < new Date()) throw new AuthError('reset_invalid');
  assertPasswordPolicy(input.password);

  await db.tx(async (tx) => {
    await tx.passwordResets.consumeIfUnused(row.id);
    await tx.users.setPasswordHash(row.userId, await hashPassword(input.password));
    await tx.sessions.revokeAllForUser(row.userId);          // reset ⇒ every device signs out
    await tx.audit.write({ actor: row.userId, action: 'auth.password_reset' });
  });
}
```

## Authorization

```ts
type Action = 'design.read' | 'design.write' | 'render.submit' | 'invite.create' | 'admin.*' | …;

export function can(ctx: Ctx, action: Action, resource?: { orgId?: string }): boolean {
  if (ctx.role === 'staff') return !action.startsWith('billing.');      // staff is broad but audited
  if (resource?.orgId && resource.orgId !== ctx.orgId) return false;    // never cross tenants
  switch (action) {
    case 'invite.create': case 'member.remove': case 'quota.read': return ctx.role === 'owner';
    default: return true;                                              // members do design work
  }
}
export const authorize = (ctx, action, res?) => { if (!can(ctx, action, res)) throw new ForbiddenError(); };
```

Every route handler calls `authorize` explicitly *and* runs inside `withTenant` — the policy module
is the intent, RLS is the safety net. A test asserts that every route does both.

## Signed asset URLs

```ts
async function signAssetUrl(ctx: Ctx, key: string, ttlSec = 300) {
  assertKeyBelongsTo(ctx, key);                    // packs → visibility check; org prefixes → org match
  const url = await storage.presignGet(key, ttlSec);
  await audit.maybeSample({ orgId: ctx.orgId, action: 'asset.read', target: key });
  return url;
}
```

Rules: quarantine keys are never signable; source CAD prefixes are not signable by any user-facing
route; TTL never exceeds 15 minutes; render downloads are always audited (not sampled).

## Rate limiting

```ts
// Redis token bucket, per (class, subject). Fails CLOSED for auth, OPEN for reads.
async function rateLimit(key: string, { points, windowSec }: Limit) {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  if (n > points) throw new RateLimitError(await redis.ttl(key));
}
```

Classes: `auth` (login/reset/invite), `upload`, `render`, `read`. Limits live in config so they can
be tightened without a deploy, and 429s are counted as a security metric, not just an error.

## Security headers (Next.js middleware)

```ts
const nonce = base64(crypto.randomBytes(16));
headers.set('Content-Security-Policy', [
  `default-src 'self'`,
  `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,     // WASM decoders (Draco/KTX2/Basis)
  `style-src 'self' 'nonce-${nonce}'`,
  `img-src 'self' blob: data: ${ASSET_ORIGIN}`,
  `connect-src 'self' ${ASSET_ORIGIN}`,
  `worker-src 'self' blob:`,                                    // three.js loaders use blob workers
  `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
].join('; '));
headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
headers.set('X-Content-Type-Options', 'nosniff');
headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
headers.set('Cross-Origin-Opener-Policy', 'same-origin');
headers.set('Cross-Origin-Resource-Policy', 'same-origin');
```

## Test matrix (must exist before launch)

| Case | Expectation |
|---|---|
| Invite token replay | Second use fails; DB-enforced, not app-enforced |
| Invite expiry / revoke | Neutral failure, no mailbox disclosure |
| Login enumeration | Identical response + timing for unknown vs wrong password |
| Lockout | Backoff after 5 failures; unlock after window; owner-visible |
| Reset revokes sessions | Every prior session 401s immediately |
| Cross-tenant access | Direct ID access to another org 404s (RLS proven with app filter removed) |
| Session fixation | New session ID issued on privilege change |
| CSRF | Cross-origin POST rejected on every mutating route |
| Signed URL scope | Quarantine and source-CAD keys are never signable |
| Rate limit | 429 with `Retry-After` on auth, upload, and render classes |
