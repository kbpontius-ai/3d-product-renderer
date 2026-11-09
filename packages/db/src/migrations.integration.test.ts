import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, withStaff, type Sql } from './client.js';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  type TestDatabase,
} from './testing.js';

/**
 * Migrations applied to a database that already holds data.
 *
 * Every other test migrates an empty database, where a migration that re-checks existing rows has
 * nothing to check. `0010` re-adds foreign keys to `users`, and the re-check runs under row-level
 * security: it could not see any users, but could see a published pack, so on the end-to-end database
 * it refused every published pack's author while every integration test passed. Deploys run against
 * data — including published packs — so this test does too.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

describe.skipIf(!hasDatabase)('migrations on a populated database', () => {
  let db: TestDatabase;
  let sql: Sql;
  let before: string;
  let legacyOrg: string;
  const legacyArtwork = '00000000-0000-7000-8000-0000000a0801';
  const legacyVersion = '00000000-0000-7000-8000-0000000a0802';

  beforeAll(async () => {
    before = mkdtempSync(join(tmpdir(), 'pr-migrations-'));
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < '0010')) {
      copyFileSync(join(MIGRATIONS, file), join(before, file));
    }
    db = await createTestDatabase('pr_migrations', before);
    sql = db.sql;
  }, 60_000);

  afterAll(async () => {
    if (before) rmSync(before, { recursive: true, force: true });
    await db?.drop();
  });

  it('keeps who made what through 0010, and lets the person go afterwards', async () => {
    const orgs = await seedOrganizations(sql);
    legacyOrg = orgs.alpha;
    await withStaff(sql, async (tx) => {
      await tx`insert into artworks (id, org_id, name) values (${legacyArtwork}, ${orgs.alpha}, 'Legacy synthetic artwork')`;
      await tx`insert into artwork_versions (id, artwork_id, org_id, version, status, source_key, digest, pipeline_version)
        values (${legacyVersion}, ${legacyArtwork}, ${orgs.alpha}, 1, 'ready', 'artwork/legacy/normalized.svg', '\\x02'::bytea, 'legacy')`;
      await tx`update artworks set current_version_id = ${legacyVersion} where id = ${legacyArtwork}`;
    });
    const author = '00000000-0000-7000-8000-0000000a0701';
    await withStaff(sql, async (tx) => {
      await tx`
        insert into users (id, org_id, email, role, status)
        values (${author}, ${orgs.alpha}, 'author@alpha.test', 'owner', 'active')`;
      await tx`
        insert into product_packs (id, key, version, name, status, manifest, digest, created_by, published_at)
        values (gen_random_uuid(), 'populated', '1.0.0', 'Populated', 'published', '{}'::jsonb, '\\x00'::bytea, ${author}, now())`;
      await tx`
        insert into invitations (id, org_id, email, token_hash, invited_by, expires_at)
        values (gen_random_uuid(), ${orgs.alpha}, 'next@alpha.test', '\\x01'::bytea, ${author}, now() + interval '1 day')`;
    });

    const result = await migrate(sql);
    expect(result.applied).toContain('0010_deleting_a_person_keeps_their_work.sql');
    expect(result.applied).toContain('0013_pp_material_cleanup.sql');
    expect((await migrate(sql)).applied).toEqual([]);

    const [kept] = await withStaff(
      sql,
      (tx) => tx`select created_by from product_packs where key = 'populated'`,
    );
    expect(kept!['created_by']).toBe(author);

    await withStaff(sql, (tx) => tx`delete from users where id = ${author}`);
    const [pack] = await withStaff(
      sql,
      (tx) => tx`select created_by from product_packs where key = 'populated'`,
    );
    expect(pack!['created_by']).toBeNull();
  });
  it('keeps populated legacy versions unchanged and enforces complete preparation metadata', async () => {
    const [version] = await withStaff(
      sql,
      (tx) => tx`select * from artwork_versions where id = ${legacyVersion}`,
    );
    expect(version!['source_key']).toBe('artwork/legacy/normalized.svg');
    expect(version!['original_key']).toBeNull();
    expect(version!['editable_key']).toBeNull();
    expect(version!['preparation_recipe']).toBeNull();
    const [artwork] = await withStaff(
      sql,
      (tx) => tx`select * from artworks where id = ${legacyArtwork}`,
    );
    expect(artwork!['current_version_id']).toBe(legacyVersion);
    expect(artwork!['org_id']).toBe(legacyOrg);
    await expect(
      withStaff(
        sql,
        (tx) =>
          tx`update artwork_versions set original_key = 'artwork-source/partial.bin' where id = ${legacyVersion}`,
      ),
    ).rejects.toThrow();
  });
});
