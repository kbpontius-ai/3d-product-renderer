/**
 * The restore drill (F-PLAT-05).
 *
 *   pnpm backup:drill
 *
 * A backup nobody has restored is a hope. This takes a real backup of the development database and
 * object store, restores it into a scratch database and a scratch directory, and then compares the
 * two: every table's row count, and every stored file's digest.
 *
 * It is a script rather than a unit test because it shells out to pg_dump and pg_restore — the
 * things that would actually be used at three in the morning — and because it is meant to be run
 * against a real deployment's snapshot, not only against fixtures.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connect, withStaff } from '@pr/db';
import { defaultStorageRoot } from '@pr/storage';

const run = promisify(execFile);

const TABLES = [
  'organizations',
  'users',
  'invitations',
  'product_packs',
  'products',
  'product_variants',
  'decoration_zones',
  'materials',
  'artworks',
  'artwork_versions',
  'artwork_assets',
  'designs',
  'design_versions',
  'render_jobs',
  'render_outputs',
  'notifications',
  'audit_log',
];

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join('.tmp', 'backups', `drill-${stamp}`);
  const restoredStorage = join('.tmp', `restored-storage-${stamp}`);
  const scratchName = `pr_restore_drill_${stamp.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-16)}`;
  const scratchUrl = replaceDatabase(url, scratchName);

  const before = await census(url);
  console.log(`before: ${total(before)} rows across ${Object.keys(before).length} tables`);

  console.log('taking a backup…');
  await run('./scripts/backup.sh', [backupDir], { env: process.env });

  console.log(`creating ${scratchName}…`);
  const admin = connect({ url, max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${scratchName}`);
    await admin.unsafe(`create database ${scratchName}`);
  } finally {
    await admin.end();
  }

  console.log('restoring…');
  await run('./scripts/restore.sh', [backupDir], {
    env: { ...process.env, TARGET_DATABASE_URL: scratchUrl, TARGET_STORAGE_ROOT: restoredStorage },
  });

  const after = await census(scratchUrl);
  const differences: string[] = [];
  for (const table of TABLES) {
    if ((before[table] ?? 0) !== (after[table] ?? 0)) {
      differences.push(`${table}: ${before[table] ?? 0} before, ${after[table] ?? 0} after`);
    }
  }

  console.log('comparing the object store…');
  const storageDifferences = await compareTrees(defaultStorageRoot(), restoredStorage);

  // The scratch database has served its purpose either way; leaving it would fill the volume with
  // one per drill.
  const cleanup = connect({ url, max: 1 });
  try {
    await cleanup.unsafe(`drop database if exists ${scratchName}`);
  } finally {
    await cleanup.end();
  }
  await rm(restoredStorage, { recursive: true, force: true });

  if (differences.length > 0 || storageDifferences.length > 0) {
    console.error('the restore did not match what was backed up:');
    for (const line of [...differences, ...storageDifferences]) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }

  console.log(`restore verified: ${total(after)} rows and every stored file matched.`);
  console.log(`backup kept at ${backupDir}`);
}

async function census(url: string): Promise<Record<string, number>> {
  const sql = connect({ url, max: 2 });
  try {
    const counts: Record<string, number> = {};
    await withStaff(sql, async (tx) => {
      for (const table of TABLES) {
        const [row] = await tx.unsafe(`select count(*)::int as n from ${table}`);
        counts[table] = Number(row?.['n'] ?? 0);
      }
    });
    return counts;
  } finally {
    await sql.end();
  }
}

/** Every file under both roots, by digest: a backup that lost bytes is worse than one that failed. */
async function compareTrees(source: string, restored: string): Promise<string[]> {
  const [left, right] = await Promise.all([digests(source), digests(restored)]);
  const problems: string[] = [];

  for (const [path, digest] of left) {
    const other = right.get(path);
    if (!other) problems.push(`missing from the restore: ${path}`);
    else if (other !== digest) problems.push(`different after restore: ${path}`);
  }
  for (const path of right.keys()) {
    if (!left.has(path)) problems.push(`unexpected in the restore: ${path}`);
  }
  return problems;
}

async function digests(root: string, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  let entries: string[];
  try {
    entries = await readdir(join(root, prefix));
  } catch {
    return out;
  }

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const info = await stat(join(root, relative));
    if (info.isDirectory()) {
      for (const [path, digest] of await digests(root, relative)) out.set(path, digest);
    } else {
      out.set(relative, createHash('sha256').update(await readFile(join(root, relative))).digest('hex'));
    }
  }
  return out;
}

const total = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

function replaceDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
