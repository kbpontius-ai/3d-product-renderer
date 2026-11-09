import { getPack, getPackAuthoring, listThumbnailVariants, thumbnailMaterials } from '@pr/catalog';
import { effectiveOrientation } from '@pr/scene';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { sharedAssetUrl } from '@/lib/server/storage';
import { ThumbnailControls } from './thumbnail-controls';
export default async function ThumbnailsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  const sql = getSql();
  const [pack, variants, materials, authoring] = await Promise.all([
    getPack(sql, id),
    listThumbnailVariants(sql, id),
    thumbnailMaterials(sql),
    getPackAuthoring(sql, id),
  ]);
  return (
    <main className="admin-page">
      <a className="auth-link" href="/admin/packs">
        Back to packs
      </a>
      <h1>{pack.name} — Catalog previews</h1>
      <p className="auth-sub">
        Capture a product image from the web viewer. Rotate or zoom to frame it; saved designs and
        product geometry stay unchanged.
      </p>
      <ThumbnailControls
        packId={id}
        initial={variants.map(({ meshKey, thumbnailKey, ...variant }) => ({
          ...variant,
          orientation: effectiveOrientation(
            authoring.variants.find((entry) => entry.variantId === variant.id)
              ?.presentationOrientation,
          ),
          meshUrl: meshKey ? sharedAssetUrl(meshKey) : null,
          thumbnailUrl: thumbnailKey ? sharedAssetUrl(thumbnailKey) : null,
        }))}
        materials={materials}
      />
    </main>
  );
}
