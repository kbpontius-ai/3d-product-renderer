import { notFound, redirect } from 'next/navigation';
import { loadArtworkVersion } from '@pr/artworks';
import { getDesignProduct, listMaterials } from '@pr/catalog';
import { DesignError, loadDesign } from '@pr/designs';
import { Editor } from '@/components/editor';
import { COLORWAYS } from '@/lib/colorways';
import type { EditorArtwork } from '@/lib/editor-data';
import { loadArtwork } from '@/lib/fixtures';
import { getPrincipal } from '@/lib/server/auth';
import { editorZones, materialsByKey } from '@/lib/server/catalog-view';
import { databaseConfigured, getSql } from '@/lib/server/db';
import { assetUrl } from '@/lib/server/storage';
import { NotConfigured } from '../../(auth)/not-configured';

/**
 * A saved design (W-03, build order G2).
 *
 * The document is loaded on the server and handed to the editor as its starting state, so the first
 * paint is already the design the user left — no flash of defaults, and no client round trip before
 * the placement is right.
 */
export const dynamic = 'force-dynamic';

export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  if (!databaseConfigured()) return <NotConfigured />;

  const { id } = await params;
  const principal = await getPrincipal();
  if (!principal) redirect(`/signin?next=/design/${id}`);

  const ctx = { orgId: principal.orgId, userId: principal.userId };
  const sql = getSql();

  let design;
  try {
    design = await loadDesign(sql, ctx, id);
  } catch (error) {
    if (error instanceof DesignError && error.code === 'not_found') notFound();
    throw error;
  }

  // The design names its product by key *and version*, and opens on that version even after a newer
  // one has replaced it in the catalog. A pack taken back to draft, or withheld from this person,
  // lands here.
  const product = await getDesignProduct(sql, ctx, design.document.product);
  const variant = product?.variants.find((v) => v.key === design.document.product.variantKey);
  if (!product || !variant) notFound();

  return (
    <Editor
      zones={editorZones(product, variant)}
      materials={materialsByKey(await listMaterials(sql, ctx))}
      artwork={await placedArtwork(design.document.placements[0]?.artwork.versionId, ctx)}
      colorways={COLORWAYS}
      design={design}
      subtitle={`${product.name} · ${variant.name}`}
      siblings={product.variants.map((sibling) => ({
        variantId: sibling.variantId,
        key: sibling.key,
        name: sibling.name,
      }))}
    />
  );
}

/**
 * The artwork this design places, or the sample when it places none.
 *
 * A version that has been deleted since the design was saved falls back to the sample rather than
 * failing the page: the design is still openable, and the editor will say the mark is only a
 * sample.
 */
async function placedArtwork(
  versionId: string | undefined,
  ctx: { orgId: string; userId: string | null },
): Promise<EditorArtwork> {
  if (versionId) {
    try {
      const record = await loadArtworkVersion(getSql(), ctx, versionId);
      return {
        ref: { artworkId: record.artworkId, versionId: record.versionId },
        key: record.versionId,
        name: record.name,
        naturalSizeMm: record.naturalSizeMm,
        mmPerPx: record.mmPerPx,
        widthPx: record.widthPx,
        heightPx: record.heightPx,
        sdfRangeMm: record.sdfRangeMm,
        stats: record.stats,
        maskUrl: assetUrl(record.maskKey, ctx.userId ?? ctx.orgId),
      };
    } catch {
      // Fall through to the sample.
    }
  }
  return loadArtwork('monogram');
}
