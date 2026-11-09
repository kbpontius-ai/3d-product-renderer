import { redirect } from 'next/navigation';
import { listArtworks, loadCurrentArtwork } from '@pr/artworks';
import { ArtworkEdit } from '@pr/design-schema';
import { ArtworkPage } from '@/components/artwork-page';
import { artworkForClient } from '@/lib/server/artworks';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured, getSql } from '@/lib/server/db';
import { NotConfigured } from '../../(auth)/not-configured';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ artworkId?: string; state?: string }>;
}) {
  if (!databaseConfigured()) return <NotConfigured />;
  const principal = await getPrincipal();
  if (!principal) redirect('/signin?next=/artwork');
  const ctx = { orgId: principal.orgId, userId: principal.userId };
  const query = await searchParams;
  const selected =
    query.artworkId && ArtworkEdit.shape.versionId.safeParse(query.artworkId).success
      ? await loadCurrentArtwork(getSql(), ctx, query.artworkId)
      : null;
  const state = selected
    ? selected.archivedAt
      ? 'archived'
      : 'active'
    : query.state === 'archived'
      ? 'archived'
      : 'active';
  const artworks = await listArtworks(getSql(), ctx, null, state);
  return (
    <ArtworkPage
      initialState={state}
      initialSelected={selected ? artworkForClient(selected, principal.userId) : null}
      initial={artworks.map((artwork) => artworkForClient(artwork, principal.userId))}
    />
  );
}
