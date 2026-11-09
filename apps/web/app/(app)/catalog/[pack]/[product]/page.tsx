import { notFound, redirect } from 'next/navigation';
import { listMaterials, listProducts } from '@pr/catalog';
import { zoneExtentMm } from '@pr/design-schema';
import { NewDesignButton } from '@/components/new-design-button';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured, getSql } from '@/lib/server/db';
import { NotConfigured } from '../../../../(auth)/not-configured';

/**
 * One product, in full (F-CAT-03).
 *
 * What a person needs before starting a design: how big it is, where artwork can go and how much
 * room there is, what may be done to it, and which materials the pack allows on each part. All of
 * it read from the pack — this page has no idea what a closure is.
 */
export const dynamic = 'force-dynamic';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ pack: string; product: string }>;
}) {
  if (!databaseConfigured()) return <NotConfigured />;

  const principal = await getPrincipal();
  const { pack, product: productKey } = await params;
  if (!principal) redirect(`/signin?next=/catalog/${pack}/${productKey}`);

  const ctx = { orgId: principal.orgId, userId: principal.userId };
  const sql = getSql();
  const products = await listProducts(sql, ctx, { limit: 200 });
  const product = products.find((p) => p.packKey === pack && p.productKey === productKey);
  if (!product) notFound();

  const materials = await listMaterials(sql, ctx);
  const byKey = new Map(materials.map((material) => [material.key, material]));

  return (
    <main className="catalog" data-testid={`product-detail-${product.productKey}`}>
      <header className="catalog-head">
        <div>
          <h1>{product.name}</h1>
          <p className="auth-sub">
            {product.category} · {product.packKey}@{product.packVersion}
          </p>
        </div>
        <a className="auth-link" href="/catalog">
          All products
        </a>
      </header>

      {Object.keys(product.facets).length > 0 && (
        <ul className="facet-list" data-testid="product-facets">
          {Object.entries(product.facets).map(([key, value]) => (
            <li key={key}>
              <small>{key.replace(/_/g, ' ')}</small>
              <strong>{String(value)}</strong>
            </li>
          ))}
        </ul>
      )}

      {product.variants.map((variant) => {
        const [min, max] = variant.bboxMm;
        const size = {
          w: (max[0] - min[0]).toFixed(1),
          h: (max[1] - min[1]).toFixed(1),
          d: (max[2] - min[2]).toFixed(1),
        };

        return (
          <section key={variant.variantId} className="variant-detail" data-testid={`variant-${variant.key}`}>
            <header className="admin-head">
              <div>
                <h2>{variant.name}</h2>
                <p className="auth-sub">
                  {size.w} × {size.h} × {size.d} mm
                </p>
              </div>
              <NewDesignButton variantId={variant.variantId} testId={`start-${product.packKey}-${product.productKey}-${variant.key}`} />
            </header>

            <h3>Decoration zones</h3>
            {variant.zones.length === 0 ? (
              <p className="auth-sub">This variant declares no zones, so nothing can be placed on it.</p>
            ) : (
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Zone</th>
                      <th>Type</th>
                      <th>Area</th>
                      <th>Safe margin</th>
                      <th>Finishes</th>
                      <th>Max depth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variant.zones.map((zone) => {
                      const extent = zoneExtentMm(zone);
                      return (
                        <tr key={zone.key} data-testid={`zone-row-${zone.key}`}>
                          <td>
                            <strong>{zone.name}</strong>
                          </td>
                          <td>{zone.type}</td>
                          <td>
                            {extent.w.toFixed(1)} × {extent.h.toFixed(1)} mm
                          </td>
                          <td>{extent.safeMarginMm.toFixed(1)} mm</td>
                          <td>{zone.constraints.finishes.join(', ')}</td>
                          <td>{zone.constraints.maxDepthMm.toFixed(2)} mm</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <h3>Materials</h3>
            <ul className="slot-list" data-testid={`slots-${variant.key}`}>
              {variant.materialSlots.map((slot) => (
                <li key={slot.key}>
                  <strong>{slot.label}</strong>
                  <span>
                    default {byKey.get(slot.defaultMaterialKey)?.name ?? slot.defaultMaterialKey}
                    {slot.colorizable ? ' · color can be chosen' : ' · fixed color'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
