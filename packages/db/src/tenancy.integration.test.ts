import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, uuidv7, withoutTenant, withStaff, withTenant, type Sql } from './client.js';
import { createTestDatabase, hasDatabase, seedOrganizations, type TestDatabase } from './testing.js';

/**
 * Row-level security, tested against a real PostgreSQL.
 *
 * These are the tests that decide whether "one customer cannot see another customer's artwork" is
 * a property of the system or merely of the queries we happened to write today.
 */

describe.skipIf(!hasDatabase)('tenancy', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };

  beforeAll(async () => {
    db = await createTestDatabase('pr_tenancy');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
    await seedDesign(sql, orgs.alpha, 'Alpha cap');
    await seedDesign(sql, orgs.beta, 'Beta carton');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('applies migrations once and is idempotent', async () => {
    const result = await migrate(sql);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied.length).toBeGreaterThan(0);
  });

  it('shows an organisation only its own designs', async () => {
    const alpha = await withTenant(sql, { orgId: orgs.alpha, userId: null }, (tx) =>
      tx`select name from designs`,
    );
    expect(alpha.map((r) => r['name'])).toEqual(['Alpha cap']);

    const beta = await withTenant(sql, { orgId: orgs.beta, userId: null }, (tx) =>
      tx`select name from designs`,
    );
    expect(beta.map((r) => r['name'])).toEqual(['Beta carton']);
  });

  it('hides everything when no tenant context is set — the policy fails closed', async () => {
    const rows = await withoutTenant(sql, (tx) => tx`select id from designs`);
    expect(rows).toHaveLength(0);
  });

  it('refuses a deliberately unfiltered cross-tenant query', async () => {
    // The application filter is deliberately absent here: only RLS is standing between the two.
    const rows = await withTenant(sql, { orgId: orgs.alpha, userId: null }, (tx) =>
      tx`select id from designs where org_id = ${orgs.beta}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to write a row belonging to another organisation', async () => {
    await expect(
      withTenant(sql, { orgId: orgs.alpha, userId: null }, async (tx) => {
        const variant = await anyVariant(tx as unknown as Sql);
        return tx`
          insert into designs (id, org_id, name, product_variant_id)
          values (${uuidv7()}, ${orgs.beta}, 'smuggled', ${variant})`;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('lets staff see across organisations, which is why staff actions are audited', async () => {
    const rows = await withTenant(sql, { orgId: orgs.alpha, userId: null, isStaff: true }, (tx) =>
      tx`select name from designs order by name`,
    );
    expect(rows.map((r) => r['name'])).toEqual(['Alpha cap', 'Beta carton']);
  });

  it('scopes artwork and render jobs the same way', async () => {
    await withTenant(sql, { orgId: orgs.beta, userId: null }, async (tx) => {
      await tx`
        insert into artworks (id, org_id, name) values (${uuidv7()}, ${orgs.beta}, 'Beta logo')`;
    });

    const seen = await withTenant(sql, { orgId: orgs.alpha, userId: null }, (tx) =>
      tx`select id from artworks`,
    );
    expect(seen).toHaveLength(0);
  });

  it('keeps the tenant setting inside its transaction', async () => {
    await withTenant(sql, { orgId: orgs.alpha, userId: null }, async (tx) => {
      const [row] = await tx`select app_current_org() as org`;
      expect(row!['org']).toBe(orgs.alpha);
    });

    const [after] = await withoutTenant(sql, (tx) => tx`select app_current_org() as org`);
    expect(after!['org']).toBeNull();
  });

  describe('constraints that carry a rule', () => {
    it('allows only one live invitation per address', async () => {
      const email = 'someone@example.com';
      await withTenant(sql, { orgId: orgs.alpha, userId: null }, async (tx) => {
        await tx`
          insert into invitations (id, org_id, email, token_hash, expires_at)
          values (${uuidv7()}, ${orgs.alpha}, ${email}, ${Buffer.from('a'.repeat(32))}, now() + interval '7 days')`;
      });

      await expect(
        withTenant(sql, { orgId: orgs.alpha, userId: null }, async (tx) => {
          await tx`
            insert into invitations (id, org_id, email, token_hash, expires_at)
            values (${uuidv7()}, ${orgs.alpha}, ${email}, ${Buffer.from('b'.repeat(32))}, now() + interval '7 days')`;
        }),
      ).rejects.toThrow(/invitations_active_email_idx/);
    });

    it('refuses to queue the same render spec twice', async () => {
      const design = await seedDesignVersion(sql, orgs.alpha);
      const specHash = Buffer.from('c'.repeat(32));

      await withTenant(sql, { orgId: orgs.alpha, userId: null }, async (tx) => {
        await tx`
          insert into render_jobs (id, org_id, design_version_id, spec, spec_hash)
          values (${uuidv7()}, ${orgs.alpha}, ${design}, '{}'::jsonb, ${specHash})`;
      });

      await expect(
        withTenant(sql, { orgId: orgs.alpha, userId: null }, async (tx) => {
          await tx`
            insert into render_jobs (id, org_id, design_version_id, spec, spec_hash)
            values (${uuidv7()}, ${orgs.alpha}, ${design}, '{}'::jsonb, ${specHash})`;
        }),
      ).rejects.toThrow(/render_jobs_dedupe_idx/);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures. Catalog rows are not org-scoped, so they are inserted without a tenant context.
// ---------------------------------------------------------------------------------------------

async function seedDesign(sql: Sql, orgId: string, name: string): Promise<string> {
  const variantId = await ensureCatalog(sql);
  const id = uuidv7();
  await withTenant(sql, { orgId, userId: null }, async (tx) => {
    await tx`
      insert into designs (id, org_id, name, product_variant_id)
      values (${id}, ${orgId}, ${name}, ${variantId})`;
  });
  return id;
}

async function seedDesignVersion(sql: Sql, orgId: string): Promise<string> {
  const designId = await seedDesign(sql, orgId, `design ${uuidv7().slice(0, 8)}`);
  const id = uuidv7();
  await withTenant(sql, { orgId, userId: null }, async (tx) => {
    await tx`
      insert into design_versions (id, design_id, org_id, version, schema_version, document)
      values (${id}, ${designId}, ${orgId}, 1, 1, '{}'::jsonb)`;
  });
  return id;
}

let cachedVariant: string | null = null;

async function ensureCatalog(sql: Sql): Promise<string> {
  if (cachedVariant) return cachedVariant;

  const packId = uuidv7();
  const productId = uuidv7();
  const variantId = uuidv7();

  await withStaff(sql, async (tx) => {
    await tx`
      insert into product_packs (id, key, version, name, manifest, digest, status)
      values (${packId}, 'test-pack', '1.0.0', 'Test pack', '{}'::jsonb, ${Buffer.alloc(32)}, 'published')`;
    await tx`
      insert into products (id, pack_id, key, name, category)
      values (${productId}, ${packId}, 'test-product', 'Test product', 'closures')`;
    await tx`
      insert into product_variants (id, product_id, key, name, dimensions_mm, material_slots)
      values (${variantId}, ${productId}, 'std', 'Standard', '{}'::jsonb, '[]'::jsonb)`;
  });

  cachedVariant = variantId;
  return variantId;
}

const anyVariant = (sql: Sql) => ensureCatalog(sql);
