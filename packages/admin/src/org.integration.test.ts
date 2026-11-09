import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  withTenant,
  type Sql,
  type TestDatabase,
} from '@pr/db';

import { AdminError } from './errors.js';
import { listAudit } from './audit.js';
import {
  getMember,
  listMembers,
  listOrgPacks,
  orgOverview,
  setMemberRole,
  setMemberStatus,
  setPackAccess,
  type OrgActor,
} from './org.js';

/**
 * Organisation self-service (F-ORG-01..05).
 *
 * The interesting cases are all refusals, and most of them are refusals row-level security will not
 * make on its own: the `users` policy is tenancy only, so the database is perfectly willing to let
 * a member suspend an owner of the same organisation. Everything that stops that lives in the code
 * under test.
 */

describe.skipIf(!hasDatabase)('organisation administration', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let capPack: string;
  let boxPack: string;

  const owner = '00000000-0000-7000-8000-0000000000a1';
  const second = '00000000-0000-7000-8000-0000000000a2';
  const member = '00000000-0000-7000-8000-0000000000b1';
  const outsider = '00000000-0000-7000-8000-0000000000c1';
  const staffer = '00000000-0000-7000-8000-00000000005f';

  const asOwner: OrgActor = { userId: owner, orgId: '', role: 'owner' };
  const asMember: OrgActor = { userId: member, orgId: '', role: 'member' };
  const asOutsider: OrgActor = { userId: outsider, orgId: '', role: 'owner' };

  beforeAll(async () => {
    db = await createTestDatabase('pr_org');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
    asOwner.orgId = orgs.alpha;
    asMember.orgId = orgs.alpha;
    asOutsider.orgId = orgs.beta;

    const manifest = (key: string) =>
      JSON.parse(
        readFileSync(fileURLToPath(new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url)), 'utf8'),
      ) as { key: string; version: string; name: string };
    const cap = manifest('cap-basic');
    const box = manifest('box-basic');

    await withStaff(sql, async (tx) => {
      await tx`
        insert into users (id, org_id, email, role, status) values
          (${owner},    ${orgs.alpha}, 'owner@alpha.test',  'owner',  'active'),
          (${second},   ${orgs.alpha}, 'second@alpha.test', 'owner',  'active'),
          (${member},   ${orgs.alpha}, 'member@alpha.test', 'member', 'active'),
          (${staffer},  ${orgs.alpha}, 'staff@alpha.test',  'staff',  'active'),
          (${outsider}, ${orgs.beta},  'owner@beta.test',   'owner',  'active')`;

      const rows = (await tx`
        insert into product_packs (id, key, version, name, status, manifest, digest, published_at)
        values
          (gen_random_uuid(), ${cap.key}, ${cap.version}, ${cap.name}, 'published', ${tx.json(cap)}, '\\x00'::bytea, now()),
          (gen_random_uuid(), ${box.key}, ${box.version}, ${box.name}, 'published', ${tx.json(box)}, '\\x01'::bytea, now())
        returning id, key`) as unknown as { id: string; key: string }[];
      capPack = rows.find((r) => r.key === cap.key)!.id;
      boxPack = rows.find((r) => r.key === box.key)!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('who may administer', () => {
    it('lets an owner list their own organisation', async () => {
      const members = await listMembers(sql, asOwner);
      expect(members.map((m) => m.email)).toContain('member@alpha.test');
      expect(members.map((m) => m.email)).not.toContain('owner@beta.test');
    });

    it('refuses a member, whom the database would have allowed', async () => {
      // The `users` policy is `org_id = app_current_org()`. A member of Alpha updating an Alpha
      // owner is a legal row write; only this check stops it.
      await expect(listMembers(sql, asMember)).rejects.toThrow(AdminError);
      await expect(setMemberStatus(sql, asMember, owner, 'suspended')).rejects.toThrow(/only an owner/);
    });

    it('shows another organisation nothing, by id', async () => {
      await expect(getMember(sql, asOutsider, member)).rejects.toThrow(/no such member/);
    });

    it('refuses to change somebody in another organisation', async () => {
      await expect(setMemberStatus(sql, asOutsider, member, 'suspended')).rejects.toThrow(/no such member/);
      await expect(setMemberRole(sql, asOutsider, member, 'owner')).rejects.toThrow(/no such member/);
    });
  });

  describe('suspension', () => {
    it('locks the account and kills its sessions in the same transaction', async () => {
      await withStaff(sql, async (tx) => {
        await tx`insert into sessions (id, user_id, org_id, token_hash, idle_expires_at, absolute_expires_at)
                 values (gen_random_uuid(), ${member}, ${orgs.alpha}, '\\x99'::bytea,
                         now() + interval '1 day', now() + interval '7 days')`;
      });

      const after = await setMemberStatus(sql, asOwner, member, 'suspended');
      expect(after.status).toBe('suspended');

      const live = await withTenant(sql, { orgId: orgs.alpha, userId: owner }, async (tx) => {
        return (await tx`select count(*)::int as n from sessions
                         where user_id = ${member} and revoked_at is null`) as unknown as { n: number }[];
      });
      expect(live[0]!.n).toBe(0);
    });

    it('reinstates without touching anything else', async () => {
      const after = await setMemberStatus(sql, asOwner, member, 'active');
      expect(after.status).toBe('active');
    });

    it('refuses to suspend the last active owner', async () => {
      await setMemberStatus(sql, asOwner, second, 'suspended');
      await expect(setMemberStatus(sql, { ...asOwner, userId: second }, owner, 'suspended')).rejects.toThrow(
        /without an active owner/,
      );
      await setMemberStatus(sql, asOwner, second, 'active');
    });

    it('refuses to suspend yourself', async () => {
      await expect(setMemberStatus(sql, asOwner, owner, 'suspended')).rejects.toThrow(/your own account/);
    });

    it('refuses to touch a staff account', async () => {
      await expect(setMemberStatus(sql, asOwner, staffer, 'suspended')).rejects.toThrow(/administered by staff/);
    });

    it('audits the change with the actor', async () => {
      const entries = await listAudit(sql, { orgId: orgs.alpha });
      const suspension = entries.find((e) => e.action === 'org.member.suspended');
      expect(suspension?.actorUserId).toBe(owner);
    });
  });

  describe('roles', () => {
    it('promotes and demotes between owner and member', async () => {
      expect((await setMemberRole(sql, asOwner, member, 'owner')).role).toBe('owner');
      expect((await setMemberRole(sql, asOwner, member, 'member')).role).toBe('member');
    });

    it('refuses to mint staff, whatever the request says', async () => {
      await expect(
        setMemberRole(sql, asOwner, member, 'staff' as unknown as 'member'),
      ).rejects.toThrow(/owner or member/);
    });

    it('refuses to demote the last active owner', async () => {
      await setMemberStatus(sql, asOwner, second, 'suspended');
      await expect(setMemberRole(sql, asOwner, owner, 'member')).rejects.toThrow(/without an active owner/);
      await setMemberStatus(sql, asOwner, second, 'active');
    });
  });

  describe('product access', () => {
    it('lists the organisation catalog', async () => {
      const packs = await listOrgPacks(sql, asOwner);
      expect(packs.map((p) => p.key).sort()).toEqual(['box-basic', 'cap-basic']);
    });

    it('withholds a product and says so on the member', async () => {
      await setPackAccess(sql, asOwner, member, boxPack, false);
      expect((await getMember(sql, asOwner, member)).withheldPackIds).toEqual([boxPack]);
    });

    it('takes it out of that member’s catalog, in the database', async () => {
      const keys = await withTenant(sql, { orgId: orgs.alpha, userId: member }, async (tx) => {
        const rows = (await tx`select key from product_packs`) as unknown as { key: string }[];
        return rows.map((r) => r.key);
      });
      expect(keys).toEqual(['cap-basic']);
    });

    it('leaves the owner’s own catalog whole', async () => {
      const keys = await withTenant(sql, { orgId: orgs.alpha, userId: owner }, async (tx) => {
        const rows = (await tx`select key from product_packs`) as unknown as { key: string }[];
        return rows.map((r) => r.key);
      });
      expect(keys.sort()).toEqual(['box-basic', 'cap-basic']);
    });

    it('gives it back', async () => {
      await setPackAccess(sql, asOwner, member, boxPack, true);
      expect((await getMember(sql, asOwner, member)).withheldPackIds).toEqual([]);
    });

    it('refuses to withhold anything from an owner', async () => {
      await expect(setPackAccess(sql, asOwner, second, capPack, false)).rejects.toThrow(/whole catalog/);
    });

    it('refuses a product that is not the organisation’s', async () => {
      await expect(
        setPackAccess(sql, asOwner, member, '00000000-0000-7000-8000-0000000000fa', false),
      ).rejects.toThrow(/no such product/);
    });

    it('refuses a member of another organisation', async () => {
      await expect(setPackAccess(sql, asOutsider, member, capPack, false)).rejects.toThrow(/no such member/);
    });

    it('audits both directions', async () => {
      const actions = (await listAudit(sql, { orgId: orgs.alpha })).map((e) => e.action);
      expect(actions).toContain('org.access.withheld');
      expect(actions).toContain('org.access.granted');
    });
  });

  describe('overview', () => {
    it('counts seats and quota for this organisation only', async () => {
      const overview = await orgOverview(sql, asOwner);
      expect(overview.name).toBe('Alpha Organisation');
      expect(overview.seats.total).toBe(4); // owner, second, member, staffer
      expect(overview.quotas.rendersPerDay).toBeGreaterThan(0);
    });

    it('is refused to a member', async () => {
      await expect(orgOverview(sql, asMember)).rejects.toThrow(/only an owner/);
    });
  });
});
