/** Applies migrations to DATABASE_URL. Usage: pnpm db:migrate */
import { connect, migrate } from '@pr/db';

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set (try: export DATABASE_URL=$(scripts/dev-db.sh url))');

  const sql = connect({ url });
  try {
    const result = await migrate(sql);
    console.log(`applied: ${result.applied.join(', ') || 'none'}`);
    console.log(`already applied: ${result.alreadyApplied.length}`);
  } finally {
    await sql.end();
  }
}

void main();
