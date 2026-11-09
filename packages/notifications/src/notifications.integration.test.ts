import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { listNotifications, markRead, notify, unreadCount } from './notifications.js';
import { EMAIL_AFTER_SECONDS, notifyRenderFinished, type Mailer } from './render.js';

/**
 * Notifications (F-REND-08).
 *
 * Two things to get right: one person's bell is theirs alone, and mail is rare enough that people
 * still read it.
 */

describe.skipIf(!hasDatabase)('notifications', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    db = await createTestDatabase('pr_notify');
    sql = db.sql;
    orgs = await seedOrganizations(sql);

    alice = crypto.randomUUID();
    bob = crypto.randomUUID();
    await withStaff(sql, async (tx) => {
      await tx`insert into users (id, org_id, email, status) values (${alice}, ${orgs.alpha}, 'alice@example.com', 'active')`;
      await tx`insert into users (id, org_id, email, status) values (${bob}, ${orgs.beta}, 'bob@example.com', 'active')`;
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await withStaff(sql, (tx) => tx`delete from notifications`);
  });

  const ctxFor = (orgId: string, userId: string) => ({ orgId, userId });

  it('reaches the person it was addressed to', async () => {
    await notify(sql, {
      orgId: orgs.alpha,
      userId: alice,
      kind: 'render.succeeded',
      title: 'Your render is ready',
      link: '/design/abc',
    });

    const mine = await listNotifications(sql, ctxFor(orgs.alpha, alice));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Your render is ready', link: '/design/abc', readAt: null });
  });

  it('is not another organisation’s business', async () => {
    await notify(sql, { orgId: orgs.alpha, userId: alice, kind: 'render.succeeded', title: 'Mine' });

    expect(await listNotifications(sql, ctxFor(orgs.beta, bob))).toHaveLength(0);
    expect(await unreadCount(sql, ctxFor(orgs.beta, bob))).toBe(0);
  });

  it('is not another colleague’s business either', async () => {
    const carol = crypto.randomUUID();
    await withStaff(sql, (tx) =>
      tx`insert into users (id, org_id, email, status) values (${carol}, ${orgs.alpha}, 'carol@example.com', 'active')`,
    );
    await notify(sql, { orgId: orgs.alpha, userId: alice, kind: 'render.succeeded', title: 'Alice only' });

    expect(await listNotifications(sql, ctxFor(orgs.alpha, carol))).toHaveLength(0);
  });

  it('counts and clears what is unread', async () => {
    for (const title of ['one', 'two', 'three']) {
      await notify(sql, { orgId: orgs.alpha, userId: alice, kind: 'render.succeeded', title });
    }
    const ctx = ctxFor(orgs.alpha, alice);
    expect(await unreadCount(sql, ctx)).toBe(3);

    const [first] = await listNotifications(sql, ctx);
    expect(await markRead(sql, ctx, [first!.id])).toBe(1);
    expect(await unreadCount(sql, ctx)).toBe(2);

    expect(await markRead(sql, ctx)).toBe(2);
    expect(await unreadCount(sql, ctx)).toBe(0);
    // Marking again changes nothing rather than counting the same rows twice.
    expect(await markRead(sql, ctx)).toBe(0);
  });

  describe('a finished render', () => {
    const mailer = (): Mailer & { sent: { to: string; template: string }[] } => {
      const sent: { to: string; template: string }[] = [];
      return { sent, async send(message) { sent.push({ to: message.to, template: message.template }); } };
    };

    const outcome = (over: Partial<Parameters<typeof notifyRenderFinished>[1]> = {}) => ({
      jobId: crypto.randomUUID(),
      orgId: orgs.alpha,
      designId: 'design-1',
      userId: alice,
      status: 'succeeded' as const,
      seconds: 12,
      ...over,
    });

    it('always rings the bell', async () => {
      const mail = mailer();
      await notifyRenderFinished(sql, outcome(), { mailer: mail });

      const [item] = await listNotifications(sql, ctxFor(orgs.alpha, alice));
      expect(item).toMatchObject({ kind: 'render.succeeded', link: '/design/design-1' });
      expect(item?.body).toContain('12 seconds');
    });

    it('does not email about a render nobody had time to walk away from', async () => {
      const mail = mailer();
      await notifyRenderFinished(sql, outcome({ seconds: 9 }), { mailer: mail });

      expect(mail.sent).toHaveLength(0);
    });

    it('emails when the render was slow enough that they left', async () => {
      const mail = mailer();
      await notifyRenderFinished(sql, outcome({ seconds: EMAIL_AFTER_SECONDS + 1 }), {
        mailer: mail,
        appUrl: 'https://example.test',
      });

      expect(mail.sent).toEqual([{ to: 'alice@example.com', template: 'render-ready' }]);
    });

    it('emails about a failure however quick it was', async () => {
      const mail = mailer();
      await notifyRenderFinished(
        sql,
        outcome({ status: 'failed', seconds: 3, failure: { code: 'asset_missing', message: 'no mesh' } }),
        { mailer: mail },
      );

      expect(mail.sent).toEqual([{ to: 'alice@example.com', template: 'render-failed' }]);
      const [item] = await listNotifications(sql, ctxFor(orgs.alpha, alice));
      expect(item).toMatchObject({ kind: 'render.failed', body: 'no mesh' });
    });

    it('says nothing by mail about a cancellation, which was their own decision', async () => {
      const mail = mailer();
      await notifyRenderFinished(sql, outcome({ status: 'canceled', seconds: 300 }), { mailer: mail });

      expect(mail.sent).toHaveLength(0);
      expect(await listNotifications(sql, ctxFor(orgs.alpha, alice))).toHaveLength(1);
    });

    it('respects someone who asked not to be emailed', async () => {
      await withStaff(sql, (tx) => tx`update users set notify_email = false where id = ${alice}`);
      const mail = mailer();

      await notifyRenderFinished(sql, outcome({ seconds: 600 }), { mailer: mail });

      expect(mail.sent).toHaveLength(0);
      expect(await unreadCount(sql, ctxFor(orgs.alpha, alice))).toBe(1);
      await withStaff(sql, (tx) => tx`update users set notify_email = true where id = ${alice}`);
    });

    it('survives a mail provider that is down, because the render did not fail', async () => {
      const broken: Mailer = {
        async send() {
          throw new Error('smtp is on fire');
        },
      };

      await expect(
        notifyRenderFinished(sql, outcome({ seconds: 600 }), { mailer: broken }),
      ).resolves.toBeUndefined();
      expect(await unreadCount(sql, ctxFor(orgs.alpha, alice))).toBe(1);
    });

    it('says nothing at all when the account that asked has since gone', async () => {
      const mail = mailer();
      await notifyRenderFinished(sql, outcome({ userId: null }), { mailer: mail });

      expect(mail.sent).toHaveLength(0);
      expect(await listNotifications(sql, ctxFor(orgs.alpha, alice))).toHaveLength(0);
    });
  });
});
