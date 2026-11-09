import { NextResponse } from 'next/server';
import { route } from '@/lib/server/observability';
import { readFixtureArtworkFile } from '@/lib/fixtures';

/**
 * Serves fixture artwork assets. Production replaces this with short-lived signed URLs issued after
 * an authorization check (docs/05-security.md); the client contract — fetch a URL, get a coverage
 * mask — is identical.
 */
async function handleGet(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  try {
    const file = readFixtureArtworkFile(path);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        'content-type': path.at(-1)?.endsWith('.json') ? 'application/json' : 'image/png',
        'cache-control': 'public, max-age=300',
      },
    });
  } catch {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
}

export const GET = route('fixtures/artwork/:path', handleGet);
