import 'server-only';
import { connect, type Sql } from '@pr/db';

/**
 * One connection pool per server process.
 *
 * Next.js re-evaluates modules on hot reload, so the pool is stashed on globalThis to avoid
 * accumulating pools (and connections) during development.
 */

const globalForDb = globalThis as unknown as { __prSql?: Sql };

export function getSql(): Sql {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  globalForDb.__prSql ??= connect({ url });
  return globalForDb.__prSql;
}

export const databaseConfigured = (): boolean => Boolean(process.env['DATABASE_URL']);
