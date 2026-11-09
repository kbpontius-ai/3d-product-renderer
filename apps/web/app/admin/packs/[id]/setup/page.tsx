import { findIngestionByMeshDigest } from '@pr/cad-jobs';
import { notFound } from 'next/navigation';
import { getPackAuthoring, listMaterialsForStaff } from '@pr/catalog';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { sharedAssetUrl } from '@/lib/server/storage';
import { NewVersionButton } from '../zones/new-version-button';
import { PackSetup } from './pack-setup';

export const dynamic = 'force-dynamic';
export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ product?: string; variant?: string; step?: string }>;
}) {
  const principal = await requireStaff();
  const { id } = await params;
  const query = await searchParams;
  const pack = await getPackAuthoring(getSql(), id);
  const variant = pack.variants.find(
    (v) =>
      (!query.product || query.product === v.productKey) &&
      (!query.variant || query.variant === v.variantKey),
  );
  if (!variant) notFound();
  if (pack.status !== 'draft')
    return (
      <section className="setup-summary">
        <h1>Reorient {variant.productName}</h1>
        <p>
          This version is {pack.status}. Create a draft so existing designs keep their current
          orientation.
        </p>
        {pack.openDraft ? (
          <a className="primary button" href={`/admin/packs/${pack.openDraft.id}/setup`}>
            Continue existing draft
          </a>
        ) : (
          <NewVersionButton packId={pack.id} next="setup" />
        )}
        <p>
          <a href={`/admin/packs/${id}/zones`}>Back to product zones</a>
        </p>
      </section>
    );
  const records = await listMaterialsForStaff(getSql());
  const ingestion = variant.meshDigest
    ? await findIngestionByMeshDigest(
        getSql(),
        { orgId: principal.orgId, userId: principal.userId },
        variant.meshDigest,
      )
    : null;
  const materials = Object.fromEntries(
    records.filter((m) => m.status === 'published').map((m) => [m.key, m.definition]),
  );
  return (
    <PackSetup
      ingestion={ingestion}
      pack={pack}
      variant={variant}
      materials={materials}
      meshUrl={variant.meshKey ? sharedAssetUrl(variant.meshKey) : ''}
      initialStep={
        query.step === 'import'
          ? 0
          : query.step === 'zones'
            ? 2
            : query.step === 'review'
              ? 3
              : query.step === 'orientation'
                ? 1
                : variant.presentationOrientation?.confirmed
                  ? 2
                  : 1
      }
    />
  );
}
