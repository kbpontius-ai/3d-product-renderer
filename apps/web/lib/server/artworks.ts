import 'server-only';
import type { ArtworkRecord } from '@pr/artworks';
import type { StoredArtwork } from '@/lib/editor-data';
import { assetUrl } from './storage';

export const artworkForClient = (artwork: ArtworkRecord, viewer: string): StoredArtwork => ({
  ref: { artworkId: artwork.artworkId, versionId: artwork.versionId },
  key: artwork.versionId,
  name: artwork.name,
  naturalSizeMm: artwork.naturalSizeMm,
  mmPerPx: artwork.mmPerPx,
  widthPx: artwork.widthPx,
  heightPx: artwork.heightPx,
  sdfRangeMm: artwork.sdfRangeMm,
  stats: artwork.stats,
  maskUrl: assetUrl(artwork.maskKey, viewer),
  sourceUrl: assetUrl(artwork.sourceKey, viewer),
  report: artwork.report,
  createdAt: artwork.createdAt,
  archivedAt: artwork.archivedAt,
  selectionEditable: artwork.selectionEditable,
});
