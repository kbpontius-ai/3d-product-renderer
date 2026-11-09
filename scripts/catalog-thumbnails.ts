import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@pr/db';
import { listPacks, listThumbnailVariants, saveCatalogThumbnail } from '@pr/catalog';
import { localStorage, defaultStorageRoot } from '../packages/storage/src/index.js';
async function main() {
  const directory = process.argv[2];
  const url = process.env['DATABASE_URL'];
  if (!directory || !url)
    throw new Error(
      'Usage: pnpm catalog:thumbnails <viewer-capture folder>, with DATABASE_URL set.',
    );
  const sql = connect({ url });
  const storage = localStorage(defaultStorageRoot());
  let saved = 0;
  try {
    for (const pack of (await listPacks(sql)).filter((p) => p.status === 'published')) {
      for (const variant of await listThumbnailVariants(sql, pack.id)) {
        const path = join(directory, `${pack.key}--${variant.key}.png`);
        let png: Uint8Array;
        try {
          png = new Uint8Array(await readFile(path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await saveCatalogThumbnail(sql, storage, {
          packId: pack.id,
          variantId: variant.id,
          png,
          actorId: null,
        });
        console.log(`${pack.key}@${pack.version} / ${variant.name}: viewer preview saved`);
        saved++;
      }
    }
    if (!saved)
      throw new Error('No matching captures found. Name each PNG <pack-key>--<variant-key>.png.');
    console.log(`${saved} Catalog preview(s) saved. No render worker is needed.`);
  } finally {
    await sql.end();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Backfill failed.');
  process.exitCode = 1;
});
