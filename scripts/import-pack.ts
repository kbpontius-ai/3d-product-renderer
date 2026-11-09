/**
 * Imports a Product Pack into the catalog (W-15).
 *
 *   pnpm import:pack fixtures/packs/cap-basic --publish [--replace]
 *
 * Packs are the only way products enter the system; this is the command-line half of what the admin
 * console will do through the browser.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '@pr/db';
import { importPack } from '@pr/catalog';
import { contentTypeFor, defaultStorageRoot, localStorage } from '@pr/storage';

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const dir = process.argv[2];
  if (!dir) throw new Error('usage: import:pack <pack directory> [--publish] [--replace]');
  const publish = process.argv.includes('--publish');
  // Overwrites a published version whose contents changed. Without it that import is refused.
  const replace = process.argv.includes('--replace');

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const sql = connect({ url });
  const storage = localStorage(defaultStorageRoot());

  try {
    const result = await importPack(sql, manifest, {
      publish,
      replace,
      // A pack is its manifest and its files; both go in, together, or the catalog is describing
      // assets nobody can fetch.
      assets: {
        read: async (path) => new Uint8Array(await readFile(join(dir, path))),
        write: (key, bytes) => storage.put(key, bytes, contentTypeFor(key)),
      },
    });
    console.log(
      `${result.key}@${result.version}: ${result.status} — ` +
        `${result.products} product(s), ${result.variants} variant(s), ${result.zones} zone(s)`,
    );
    for (const issue of result.issues) {
      console.warn(`  ${issue.severity}: ${issue.code} at ${issue.path} — ${issue.message}`);
    }
    if (!publish) console.log('  (draft — pass --publish to make it visible)');
  } finally {
    await sql.end();
  }
}

void main();
