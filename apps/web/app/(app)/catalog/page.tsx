import { redirect } from 'next/navigation';
import { listProducts, summariseFacets } from '@pr/catalog';
import { NewDesignButton } from '@/components/new-design-button';
import { CatalogFilters } from './filters';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured, getSql } from '@/lib/server/db';
import { NotConfigured } from '../../(auth)/not-configured';
import { isSharedAsset, sharedAssetUrl } from '@/lib/server/storage';

/**
 * The catalog, read from the database rather than from fixtures (W-03).
 *
 * Every row here arrived through a Product Pack import, and is visible because the tenant's policies
 * allow it — there is no product-specific code between the pack and this page.
 */
export const dynamic = 'force-dynamic';

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!databaseConfigured()) return <NotConfigured />;

  const principal = await getPrincipal();
  if (!principal) redirect('/signin?next=/catalog');

  const params = await searchParams;
  const ctx = { orgId: principal.orgId, userId: principal.userId };
  const search = typeof params['q'] === 'string' ? params['q'] : undefined;

  // Facets are whatever the packs declare, so the filters are built from the unfiltered catalog:
  // narrowing to "38 mm" must not make every other neck size disappear from the list of choices.
  const everything = await listProducts(getSql(), ctx);
  // Facets the packs declare, not a hard-coded list (F-CAT-02): "neck size" means nothing to a
  // carton, so what can be filtered on comes out of the manifests themselves.
  const facets = summariseFacets(everything);

  const chosen: Record<string, string> = {};
  for (const facet of facets) {
    const value = params[`f_${facet.key}`];
    if (typeof value === 'string' && value) chosen[facet.key] = value;
  }

  const products = await listProducts(getSql(), ctx, {
    ...(search ? { search } : {}),
    ...(Object.keys(chosen).length > 0 ? { facets: chosen } : {}),
  });

  return (
    <main className="catalog" data-testid="catalog">
      <header className="catalog-head">
        <div>
          <h1>Catalog</h1>
          <p className="auth-sub">
            {products.length} product{products.length === 1 ? '' : 's'}
            {products.length === everything.length ? ' available to your team.' : ` of ${everything.length}.`}
          </p>
        </div>
      </header>

      <CatalogFilters facets={facets} chosen={chosen} search={search ?? ''} />

      {products.length === 0 ? (
        <p className="auth-sub" data-testid="catalog-empty">
          {everything.length === 0
            ? 'No products yet. An administrator imports a Product Pack to populate this list.'
            : 'Nothing matches those filters.'}
        </p>
      ) : (
        <ul className="catalog-grid">
          {products.map((product) => (
            <li
              key={`${product.packKey}/${product.productKey}`}
              data-testid={`product-${product.packKey}-${product.productKey}`}
            >
              <article>
                <h2>
                  <a
                    href={`/catalog/${product.packKey}/${product.productKey}`}
                    data-testid={`detail-${product.packKey}-${product.productKey}`}
                  >
                    {product.name}
                  </a>
                </h2>
                <p className="catalog-meta">
                  {product.category} · {product.packKey}@{product.packVersion}
                </p>

                {/*
                  Thumbnail and key dimensions (F-CAT-01).

                  Generated previews take precedence over supplied pack images. The placeholder
                  names the missing image rather than looking like a failed load. Dimensions come from
                  the variant bounding box, so they are true of the mesh that will actually be
                  rendered rather than a number typed into a manifest beside it.
                */}
                <ProductThumbnail
                  storageKey={product.variants.find((v) => v.assets.thumbnail)?.assets.thumbnail}
                  alt={product.name}
                />

                <p className="catalog-dimensions">{keyDimensions(product.variants)}</p>
                <ul className="catalog-variants">
                  {product.variants.map((variant) => (
                    <li key={variant.variantId}>
                      <strong>{variant.name}</strong>
                      <span>
                        {variant.zones.length} decoration zone{variant.zones.length === 1 ? '' : 's'}:{' '}
                        {variant.zones.map((z) => z.name).join(', ') || 'none'}
                      </span>
                      <NewDesignButton
                        variantId={variant.variantId}
                        testId={`start-${product.packKey}-${product.productKey}-${variant.key}`}
                      />
                    </li>
                  ))}
                </ul>
              </article>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * A pack's thumbnail, or an honest blank.
 *
 * Pack assets are the same for every organisation, so this URL needs no signature — but the helper
 * that says so refuses anything tenant-owned, which is what stops a thumbnail slot ever becoming a
 * way to serve somebody's artwork unsigned.
 */
function ProductThumbnail({ storageKey, alt }: { storageKey: string | undefined; alt: string }) {
  if (!storageKey || !isSharedAsset(storageKey)) {
    return <span className="product-thumb empty">Preview not available</span>;
  }
  return <img className="product-thumb" src={sharedAssetUrl(storageKey)} alt={alt} loading="lazy" />;
}

/**
 * The dimensions worth putting on a card, derived from the bounding box.
 *
 * One line for a single variant, a range across the family for several — "38-53 mm across" tells a
 * buyer more than the first variant's size does, and the card has no room for a table.
 */
function keyDimensions(variants: { bboxMm: readonly [readonly number[], readonly number[]] }[]): string {
  const spans = variants.map(({ bboxMm: [min, max] }) => ({
    w: (max[0] ?? 0) - (min[0] ?? 0),
    h: (max[1] ?? 0) - (min[1] ?? 0),
    d: (max[2] ?? 0) - (min[2] ?? 0),
  }));
  if (spans.length === 0) return 'no variants';

  const round = (n: number) => Math.round(n * 10) / 10;
  const range = (pick: (s: (typeof spans)[number]) => number) => {
    const values = spans.map(pick);
    const low = round(Math.min(...values));
    const high = round(Math.max(...values));
    return low === high ? `${low}` : `${low}–${high}`;
  };

  return `${range((s) => s.w)} × ${range((s) => s.h)} × ${range((s) => s.d)} mm`;
}
