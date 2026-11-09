import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, hasDatabase, seedOrganizations, type TestDatabase } from './testing.js';
import { withStaff, withSystem, withTenant, type Sql } from './client.js';

/**
 * Per-member product access, at the only layer that counts (F-ORG-03, docs/25-org-admin.md).
 *
 * Withholding a product is a policy or it is decoration. These tests never call application code:
 * they open a transaction as a person and ask the database what that person can see, which is the
 * same question the catalog page asks and the same question somebody typing a URL asks.
 */

const CAP = fileURLToPath(new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url));
const BOX = fileURLToPath(new URL('../../../fixtures/packs/box-basic/manifest.json', import.meta.url));

describe.skipIf(!hasDatabase)('per-member product access', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };

  /** Two members of Alpha, one of Beta, and two published packs visible to everyone. */
  const alice = '00000000-0000-7000-8000-0000000a11ce';
  const bob = '00000000-0000-7000-8000-00000000b0b0';
  const carol = '00000000-0000-7000-8000-0000000ca401';
  let capPack: string;
  let boxPack: string;

  beforeAll(async () => {
    db = await createTestDatabase('pr_access');
    sql = db.sql;
    orgs = await seedOrganizations(sql);

    const manifest = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { key: string; version: string; name: string };
    const cap = manifest(CAP);
    const box = manifest(BOX);

    await withStaff(sql, async (tx) => {
      await tx`
        insert into users (id, org_id, email, role, status) values
          (${alice}, ${orgs.alpha}, 'alice@alpha.test', 'member', 'active'),
          (${bob},   ${orgs.alpha}, 'bob@alpha.test',   'owner',  'active'),
          (${carol}, ${orgs.beta},  'carol@beta.test',  'member', 'active')`;

      // Published, with no visibility rows: available to every organisation, which is the state a
      // denial has to be able to override.
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

  /** What this person can see in the catalog, as the database will answer it. */
  async function visible(orgId: string, userId: string | null): Promise<string[]> {
    return withTenant(sql, { orgId, userId }, async (tx) => {
      const rows = (await tx`select key from product_packs order by key`) as unknown as { key: string }[];
      return rows.map((r) => r.key);
    });
  }

  async function withhold(userId: string, packId: string, actor: string, orgId: string): Promise<void> {
    await withTenant(sql, { orgId, userId: actor }, async (tx) => {
      await tx`insert into user_pack_denials (user_id, pack_id, denied_by) values (${userId}, ${packId}, ${actor})`;
    });
  }

  it('shows everything to a member with nothing withheld', async () => {
    expect(await visible(orgs.alpha, alice)).toEqual(['cap-basic', 'box-basic'].sort());
  });

  it('hides a withheld pack from that member, in the database', async () => {
    await withhold(alice, boxPack, bob, orgs.alpha);
    expect(await visible(orgs.alpha, alice)).toEqual(['cap-basic']);
  });

  it('leaves every other member of the same organisation alone', async () => {
    expect(await visible(orgs.alpha, bob)).toEqual(['cap-basic', 'box-basic'].sort());
  });

  it('leaves other organisations alone', async () => {
    expect(await visible(orgs.beta, carol)).toEqual(['cap-basic', 'box-basic'].sort());
  });

  it('restores access when the denial is removed', async () => {
    await withTenant(sql, { orgId: orgs.alpha, userId: bob }, async (tx) => {
      await tx`delete from user_pack_denials where user_id = ${alice} and pack_id = ${boxPack}`;
    });
    expect(await visible(orgs.alpha, alice)).toEqual(['cap-basic', 'box-basic'].sort());
  });

  describe('transactions with no person in them', () => {
    it('denies nothing to a worker', async () => {
      // The render and CAD workers run as `withSystem` with no user. A denial is a statement about
      // somebody, and there is nobody here — a worker that could not read a pack because of who
      // was withheld from it would fail a render for a reason that has nothing to do with the job.
      await withhold(alice, boxPack, bob, orgs.alpha);

      const keys = await withSystem(sql, async (tx) => {
        const rows = (await tx`select key from product_packs order by key`) as unknown as { key: string }[];
        return rows.map((r) => r.key);
      });
      expect(keys).toEqual(['cap-basic', 'box-basic'].sort());
    });

    it('denies nothing to a tenant transaction with no user', async () => {
      expect(await visible(orgs.alpha, null)).toEqual(['cap-basic', 'box-basic'].sort());
    });

    it('denies nothing to staff', async () => {
      const keys = await withStaff(sql, async (tx) => {
        const rows = (await tx`select key from product_packs order by key`) as unknown as { key: string }[];
        return rows.map((r) => r.key);
      });
      expect(keys).toEqual(['cap-basic', 'box-basic'].sort());
    });
  });

  describe('the denial rows themselves', () => {
    it('are visible to the organisation the member belongs to', async () => {
      const rows = await withTenant(sql, { orgId: orgs.alpha, userId: bob }, async (tx) => {
        return (await tx`select user_id from user_pack_denials`) as unknown as { user_id: string }[];
      });
      expect(rows.map((r) => r.user_id)).toContain(alice);
    });

    it('are invisible to another organisation', async () => {
      const rows = await withTenant(sql, { orgId: orgs.beta, userId: carol }, async (tx) => {
        return (await tx`select user_id from user_pack_denials`) as unknown as { user_id: string }[];
      });
      expect(rows).toEqual([]);
    });

    it('cannot be written for a member of another organisation', async () => {
      // The attack this refuses: Beta withholding a product from an Alpha employee.
      //
      // Asserting on the reason, not just on the throw. A bare `toThrow()` would pass if the insert
      // failed for a foreign key, a typo in a column name, or anything else — which would leave the
      // test green while the policy it exists to prove had been dropped.
      await expect(
        withTenant(sql, { orgId: orgs.beta, userId: carol }, async (tx) => {
          await tx`insert into user_pack_denials (user_id, pack_id, denied_by) values (${alice}, ${capPack}, ${carol})`;
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('cannot be deleted by another organisation', async () => {
      await withTenant(sql, { orgId: orgs.beta, userId: carol }, async (tx) => {
        await tx`delete from user_pack_denials where user_id = ${alice}`;
      });
      // Still there: the delete matched no rows rather than removing somebody else's.
      expect(await visible(orgs.alpha, alice)).toEqual(['cap-basic']);
    });

    it('goes away with the member', async () => {
      await withStaff(sql, async (tx) => {
        await tx`insert into users (id, org_id, email, role, status)
                 values (${'00000000-0000-7000-8000-00000000dead'}, ${orgs.alpha}, 'temp@alpha.test', 'member', 'active')`;
        await tx`insert into user_pack_denials (user_id, pack_id) values (${'00000000-0000-7000-8000-00000000dead'}, ${capPack})`;
        await tx`delete from users where id = ${'00000000-0000-7000-8000-00000000dead'}`;
        const [left] = (await tx`select count(*)::int as n from user_pack_denials
                                 where user_id = ${'00000000-0000-7000-8000-00000000dead'}`) as unknown as { n: number }[];
        expect(left!.n).toBe(0);
      });
    });
  });
});
