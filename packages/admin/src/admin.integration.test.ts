import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { AdminError } from './errors.js';
import { countAudit, listAudit } from './audit.js';
import {
  createOrganization,
  getOrganization,
  listOrganizations,
  setOrgStatus,
  setQuotas,
} from './orgs.js';
import {
  countUsers,
  invitationExpiry,
  deleteUser,
  getUser,
  listUsers,
  setUserRole,
  setUserStatus,
} from './users.js';

/**
 * Staff administration (F-ADM-06).
 *
 * The interesting cases are the refusals: an organisation that can no longer be administered, an
 * account still signed in after being suspended, a quota that would take the render farm out.
 */

describe.skipIf(!hasDatabase)('admin', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };

  beforeAll(async () => {
    db = await createTestDatabase('pr_admin');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  /** A user with a live session, which is what makes suspension observable. */
  async function makeUser(
    orgId: string,
    email: string,
    role: 'owner' | 'member' | 'staff' = 'member',
    status: 'active' | 'invited' = 'active',
  ): Promise<string> {
    const id = crypto.randomUUID();
    await withStaff(sql, async (tx) => {
      await tx`
        insert into users (id, org_id, email, role, status, password_hash)
        values (${id}, ${orgId}, ${email}, ${role}, ${status}, 'x')`;
      await tx`
        insert into sessions (id, user_id, org_id, token_hash, idle_expires_at, absolute_expires_at)
        values (${crypto.randomUUID()}, ${id}, ${orgId}, ${Buffer.from(crypto.randomUUID())},
                now() + interval '1 day', now() + interval '14 days')`;
    });
    return id;
  }

  describe('organisations', () => {
    it('lists them with the numbers an administrator is actually looking for', async () => {
      const all = await listOrganizations(sql);
      const alpha = all.find((o) => o.id === orgs.alpha);

      expect(alpha).toBeDefined();
      expect(alpha?.quotas.rendersPerDay).toBe(50);
      expect(alpha?.users).toBeGreaterThanOrEqual(0);
      expect(alpha?.rendersToday).toBe(0);
    });

    it('creates one with quotas already in place', async () => {
      const created = await createOrganization(sql, {
        name: 'Third Co',
        slug: 'Third Co!',
        actorId: null,
      });

      expect(created.slug).toBe('third-co');
      expect(created.quotas.maxConcurrentJobs).toBe(3);
    });

    it('refuses a slug that is taken', async () => {
      await createOrganization(sql, { name: 'Dup', slug: 'dup', actorId: null });
      await expect(
        createOrganization(sql, { name: 'Dup again', slug: 'dup', actorId: null }),
      ).rejects.toThrow(AdminError);
    });

    it('changes quotas without disturbing the ones left alone', async () => {
      const before = await getOrganization(sql, orgs.beta);
      const after = await setQuotas(sql, orgs.beta, { rendersPerDay: 500 }, null);

      expect(after.quotas.rendersPerDay).toBe(500);
      expect(after.quotas.maxConcurrentJobs).toBe(before.quotas.maxConcurrentJobs);
    });

    it('refuses a quota outside the range the platform can honour', async () => {
      await expect(setQuotas(sql, orgs.beta, { maxResolutionPx: 100_000 }, null)).rejects.toThrow(
        /between/,
      );
      await expect(setQuotas(sql, orgs.beta, { rendersPerDay: -1 }, null)).rejects.toThrow(
        AdminError,
      );
    });

    it('ends every session when an organisation is suspended', async () => {
      const org = await createOrganization(sql, {
        name: 'Suspendable',
        slug: 'suspendable',
        actorId: null,
      });
      await makeUser(org.id, 'sessioned@example.com');

      await setOrgStatus(sql, org.id, 'suspended', null);

      const [user] = await listUsers(sql, { orgId: org.id });
      expect(user?.sessions).toBe(0);
    });
  });

  describe('users', () => {
    it('finds them by email across organisations', async () => {
      await makeUser(orgs.alpha, 'findme@example.com');
      const found = await listUsers(sql, { query: 'FINDME' });

      expect(found.map((u) => u.email)).toContain('findme@example.com');
      expect(found[0]?.orgName).toBeTruthy();
    });

    it('paginates every account and filters within the selected organization', async () => {
      const org = await createOrganization(sql, { name: 'Large', slug: 'large', actorId: null });
      await withStaff(sql, async (tx) => {
        await tx`
          insert into users (id, org_id, email, role, status)
          select gen_random_uuid(), ${org.id}, 'page-' || n || '@example.com',
                 case when n % 2 = 0 then 'owner'::user_role else 'member'::user_role end,
                 case when n % 2 = 0 then 'invited'::user_status else 'active'::user_status end
          from generate_series(1, 205) n`;
      });
      const first = await listUsers(sql, { orgId: org.id, limit: 50 });
      const second = await listUsers(sql, { orgId: org.id, limit: 50, offset: 50 });
      const last = await listUsers(sql, { orgId: org.id, limit: 50, offset: 200 });
      expect(first).toHaveLength(50);
      expect(second).toHaveLength(50);
      expect(last).toHaveLength(5);
      expect(new Set([...first, ...second].map((user) => user.id)).size).toBe(100);
      expect(await countUsers(sql, { orgId: org.id })).toBe(205);
      const filters = {
        orgId: org.id,
        query: ' PAGE- ',
        role: 'owner' as const,
        status: 'invited' as const,
      };
      expect(await countUsers(sql, filters)).toBe(102);
      expect(
        (await listUsers(sql, filters)).every(
          (user) => user.orgId === org.id && user.role === 'owner' && user.status === 'invited',
        ),
      ).toBe(true);
      expect(await listUsers(sql, { orgId: orgs.beta, query: 'page-' })).toEqual([]);
    });

    it('rejects organization mismatches on reads and every account mutation', async () => {
      const id = await makeUser(orgs.alpha, 'scoped@example.com');
      await expect(getUser(sql, id, orgs.beta)).rejects.toMatchObject({ code: 'not_found' });
      await expect(setUserRole(sql, id, 'staff', null, orgs.beta)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(setUserStatus(sql, id, 'suspended', null, orgs.beta)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(deleteUser(sql, id, null, orgs.beta)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(await getUser(sql, id, orgs.alpha)).toMatchObject({
        role: 'member',
        status: 'active',
        sessions: 1,
      });
      expect(
        (await listAudit(sql, { orgId: orgs.alpha })).some((entry) => entry.targetId === id),
      ).toBe(false);
      expect(await setUserStatus(sql, id, 'suspended', null, orgs.alpha)).toMatchObject({
        status: 'suspended',
      });
    });

    it('reports only outstanding invitation expiry in the selected organization', async () => {
      const email = 'expiry@example.com';
      await makeUser(orgs.alpha, email, 'member', 'invited');
      const invitation = crypto.randomUUID();
      await withStaff(
        sql,
        (tx) => tx`
        insert into invitations (id, org_id, email, role, token_hash, expires_at)
        values (${invitation}, ${orgs.alpha}, ${email}, 'member', ${Buffer.from(crypto.randomUUID())}, now() - interval '1 day')`,
      );
      const expires = await invitationExpiry(sql, orgs.alpha, email);
      expect(expires).not.toBeNull();
      expect(new Date(expires!).getTime()).toBeLessThan(Date.now());
      expect(await invitationExpiry(sql, orgs.beta, email)).toBeNull();
      await withStaff(
        sql,
        (tx) => tx`update invitations set revoked_at = now() where id = ${invitation}`,
      );
      expect(await invitationExpiry(sql, orgs.alpha, email)).toBeNull();
    });

    it('suspending signs them out', async () => {
      const id = await makeUser(orgs.alpha, 'suspendme@example.com');
      expect((await getUser(sql, id)).sessions).toBe(1);

      const after = await setUserStatus(sql, id, 'suspended', null);
      expect(after.status).toBe('suspended');
      expect(after.sessions).toBe(0);
    });

    it('counts only sessions that are usable, including idle expiry', async () => {
      const id = await makeUser(orgs.alpha, 'idle-expiry@example.com');
      await withStaff(
        sql,
        (tx) => tx`
        update sessions set idle_expires_at = now() - interval '1 minute' where user_id = ${id}`,
      );
      expect((await getUser(sql, id)).sessions).toBe(0);
      expect((await listUsers(sql, { orgId: orgs.alpha, query: 'idle-expiry' }))[0]?.sessions).toBe(
        0,
      );
    });

    it('will not reactivate an invitation that was never accepted', async () => {
      const id = await makeUser(orgs.alpha, 'pending@example.com', 'member', 'invited');
      await expect(setUserStatus(sql, id, 'active', null)).rejects.toThrow(/not been accepted/);
    });

    it('refuses to remove the last owner, by suspension, demotion or deletion', async () => {
      const org = await createOrganization(sql, { name: 'Solo', slug: 'solo', actorId: null });
      const owner = await makeUser(org.id, 'only-owner@example.com', 'owner');

      await expect(setUserStatus(sql, owner, 'suspended', null)).rejects.toThrow(
        /without an active owner/,
      );
      await expect(setUserRole(sql, owner, 'member', null)).rejects.toThrow(
        /without an active owner/,
      );
      await expect(deleteUser(sql, owner, null)).rejects.toThrow(/without an active owner/);

      // With a second owner, the first may go.
      await makeUser(org.id, 'second-owner@example.com', 'owner');
      await expect(setUserStatus(sql, owner, 'suspended', null)).resolves.toMatchObject({
        status: 'suspended',
      });
    });

    it('will not let an administrator delete themselves', async () => {
      const id = await makeUser(orgs.alpha, 'self@example.com');
      await expect(deleteUser(sql, id, id)).rejects.toThrow(/your own account/);
    });

    it('will not let an administrator change their own role or suspend themselves', async () => {
      // A staff member once made themselves an organisation's owner from the console, which in a
      // single role column means they stopped being staff and lost the console mid-session.
      const me = await makeUser(orgs.alpha, 'self-role@example.com', 'staff');
      await expect(setUserRole(sql, me, 'owner', me)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(setUserStatus(sql, me, 'suspended', me)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(await getUser(sql, me)).toMatchObject({ role: 'staff', status: 'active' });

      // Somebody else still can.
      const colleague = await makeUser(orgs.alpha, 'colleague@example.com', 'staff');
      await expect(setUserRole(sql, me, 'member', colleague)).resolves.toMatchObject({
        role: 'member',
      });
    });

    it('keeps the work when the person goes', async () => {
      // Staff "Delete" answered 500 for anybody who had ever saved a design: the design's versions
      // still named them, and nothing let that reference go. This used to be tested against a
      // database with no products in it, so the design it meant to create never existed.
      const org = await createOrganization(sql, {
        name: 'Leavers',
        slug: 'leavers',
        actorId: null,
      });
      await makeUser(org.id, 'stays@example.com', 'owner');
      const leaver = await makeUser(org.id, 'leaves@example.com');

      const designId = crypto.randomUUID();
      const artworkId = crypto.randomUUID();
      await withStaff(sql, async (tx) => {
        const packId = crypto.randomUUID();
        const productId = crypto.randomUUID();
        const variantId = crypto.randomUUID();
        await tx`
          insert into product_packs (id, key, version, name, status, manifest, digest, created_by)
          values (${packId}, 'leaver-pack', '1.0.0', 'Leaver pack', 'published', '{}'::jsonb,
                  ${Buffer.alloc(32)}, ${leaver})`;
        await tx`
          insert into products (id, pack_id, key, name, category, facets, sort, status)
          values (${productId}, ${packId}, 'thing', 'Thing', 'things', '{}'::jsonb, 0, 'published')`;
        await tx`
          insert into product_variants (id, product_id, key, name, dimensions_mm, material_slots,
                                        camera_presets, capabilities)
          values (${variantId}, ${productId}, 'one', 'One', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`;
        await tx`
          insert into designs (id, org_id, name, product_variant_id, created_by)
          values (${designId}, ${org.id}, 'theirs', ${variantId}, ${leaver})`;
        const versionId = crypto.randomUUID();
        await tx`
          insert into design_versions (id, design_id, org_id, version, schema_version, document, created_by)
          values (${versionId}, ${designId}, ${org.id}, 1, 1, '{}'::jsonb, ${leaver})`;
        await tx`update designs set current_version_id = ${versionId} where id = ${designId}`;
        await tx`
          insert into artworks (id, org_id, name, created_by)
          values (${artworkId}, ${org.id}, 'their logo', ${leaver})`;
        await tx`
          insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
          values (${crypto.randomUUID()}, ${org.id}, 'friend@example.com', 'member',
                  ${Buffer.from(crypto.randomUUID())}, ${leaver}, now() + interval '1 day')`;
      });

      await deleteUser(sql, leaver, null);

      await expect(getUser(sql, leaver)).rejects.toThrow(AdminError);
      const kept = await withStaff(
        sql,
        (tx) => tx`
        select
          (select created_by from designs where id = ${designId}) as design_author,
          (select count(*)::int from design_versions where design_id = ${designId}) as versions,
          (select created_by from artworks where id = ${artworkId}) as artwork_author`,
      );
      expect(kept[0]).toEqual({ design_author: null, versions: 1, artwork_author: null });
    });

    it('lets go of a person everywhere they are referenced', async () => {
      // The structural half of the test above: every reference to a user either goes with them or
      // forgets them. A new table that names a user with a plain foreign key fails here, before it
      // can make somebody undeletable again.
      const blocking = await withStaff(
        sql,
        (tx) => tx`
        select conrelid::regclass::text as tbl, conname
        from pg_constraint
        where confrelid = 'users'::regclass and contype = 'f' and confdeltype not in ('c', 'n')`,
      );
      expect(blocking).toEqual([]);
    });
  });

  describe('audit log', () => {
    it('resolves actor and subject labels, with stable organization-scoped pagination', async () => {
      const org = await createOrganization(sql, {
        name: 'History',
        slug: 'history',
        actorId: null,
      });
      const actor = await makeUser(org.id, 'history-staff@example.com', 'staff');
      const subject = await makeUser(org.id, 'history-member@example.com');
      await setUserRole(sql, subject, 'staff', actor, org.id);
      await setUserStatus(sql, subject, 'suspended', actor, org.id);
      expect(await countAudit(sql, org.id)).toBe(3);
      const first = await listAudit(sql, { orgId: org.id, limit: 1 });
      const next = await listAudit(sql, { orgId: org.id, limit: 1, offset: 1 });
      expect(first[0]).toMatchObject({
        action: 'user.suspended',
        actorEmail: 'history-staff@example.com',
        targetEmail: 'history-member@example.com',
      });
      expect(next[0]?.action).toBe('user.role_changed');
      expect(next[0]?.id).not.toBe(first[0]?.id);
    });

    it('records what staff did, and to whom', async () => {
      const org = await createOrganization(sql, {
        name: 'Audited',
        slug: 'audited',
        actorId: null,
      });
      await setQuotas(sql, org.id, { rendersPerDay: 7 }, null);

      const entries = await listAudit(sql, { orgId: org.id });
      expect(entries.map((e) => e.action)).toEqual(['org.quotas_changed', 'org.created']);
      expect(entries[0]?.metadata).toMatchObject({ rendersPerDay: 7 });
    });
  });
});
