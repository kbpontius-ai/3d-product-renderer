import { Editor } from '@/components/editor';
import { COLORWAYS } from '@/lib/colorways';
import { FIXTURE_PACK_KEYS, loadArtwork, loadEditorData } from '@/lib/fixtures';

/**
 * Rendered per request so the Content-Security-Policy nonce can exist (docs/05-security.md).
 *
 * A nonce is a per-request value and this page's HTML would otherwise be generated once at build
 * time, which leaves its script tags unnonced and — under a policy naming a nonce and
 * `strict-dynamic` — blocked outright. The page then serves, renders, and does nothing when
 * clicked, which is a worse failure than a slow one because it looks like it worked.
 *
 * The cost is one server render of a page with no per-user content in it. That is a fair price for
 * a policy with no `unsafe-inline` in it.
 */
export const dynamic = 'force-dynamic';

/**
 * Demo design route. Everything it hands the client mirrors the shape of the real endpoints in
 * docs/13-api.md, so swapping fixtures for the catalog API is a data-source change, not a rewrite.
 */
export default function DemoDesignPage() {
  const { zones, materials } = loadEditorData(FIXTURE_PACK_KEYS);
  const artwork = loadArtwork('monogram');

  return <Editor zones={zones} materials={materials} artwork={artwork} colorways={COLORWAYS} />;
}
