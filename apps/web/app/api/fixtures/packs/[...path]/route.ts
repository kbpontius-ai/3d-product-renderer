import { NextResponse } from 'next/server';
import { route } from '@/lib/server/observability';
import { readFixturePackFile } from '@/lib/fixtures';

/**
 * Serves product pack assets (meshes, textures). Production replaces this with signed, short-lived
 * URLs and never exposes source CAD at all (docs/05-security.md).
 */
async function handleGet(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  try {
    const file = readFixturePackFile(path);
    const name = path.at(-1) ?? '';
    const contentType = name.endsWith('.glb')
      ? 'model/gltf-binary'
      : name.endsWith('.json')
        ? 'application/json'
        : 'application/octet-stream';
    return new NextResponse(new Uint8Array(file), {
      headers: { 'content-type': contentType, 'cache-control': 'public, max-age=300' },
    });
  } catch {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
}

export const GET = route('fixtures/packs/:path', handleGet);
