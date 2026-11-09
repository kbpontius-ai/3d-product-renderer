import { NextResponse } from 'next/server';
import { getSql } from '@/lib/server/db';
import { getStorage } from '@/lib/server/storage';

/**
 * What a supervisor restarts on and a deploy waits for (`F-SHIP-05`).
 *
 * A process that is listening is not the same as a process that is serving. This one is up the
 * moment Next.js is, but it cannot answer a single page without the database, and it cannot serve a
 * mesh or a finished render without the object store — so both are checked, and either failing is a
 * 503. A health check that only proves the port is open would keep a broken container in rotation.
 *
 * Deliberately says nothing an anonymous caller should not know: no versions, no connection
 * strings, no error text from the driver. `ok` or the name of the part that is not.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Check = { name: string; ok: boolean };

async function checkDatabase(): Promise<Check> {
  try {
    // Cheapest possible round trip: proves the socket, the credentials and the database, and takes
    // no locks and no row.
    await getSql()`select 1`;
    return { name: 'database', ok: true };
  } catch {
    return { name: 'database', ok: false };
  }
}

async function checkStorage(): Promise<Check> {
  try {
    // `has` rather than `get`: a miss is a healthy answer, because what is being tested is that the
    // adapter is configured and its root is reachable — not that any particular object exists.
    await getStorage().has('health/probe');
    return { name: 'storage', ok: true };
  } catch {
    return { name: 'storage', ok: false };
  }
}

export async function GET(): Promise<NextResponse> {
  const checks = await Promise.all([checkDatabase(), checkStorage()]);
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);

  return NextResponse.json(
    failed.length === 0 ? { status: 'ok' } : { status: 'degraded', failed },
    { status: failed.length === 0 ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
