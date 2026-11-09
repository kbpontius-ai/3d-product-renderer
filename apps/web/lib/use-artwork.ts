'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ArtworkReport } from '@pr/design-schema';
import type { Gray, SignedDistanceField } from '@pr/artwork';
import { prepareArtwork } from '@pr/svg';
import { choosePitchMm, rasterizeArtwork } from '@pr/raster';
import type { EditorArtwork, StoredArtwork } from '@/lib/editor-data';
import { fieldFromMask, loadMask } from '@/lib/shade';

/**
 * Artwork state for the editor: whatever is currently being placed, plus how it got there.
 *
 * Saved designs adopt an immutable version chosen from the library. Upload preparation owns
 * confirmation and persistence; merely saving a new artwork cannot change a design placement.
 *
 * The demo route has nowhere to save to, so it runs the identical pure functions in the tab
 * instead. `@pr/svg` and `@pr/raster` have no idea where they are running, which is why both paths
 * can exist without either being a special case.
 */

export interface ActiveArtwork {
  /** Present when this artwork is stored and can therefore be placed in a saved design. */
  ref: { artworkId: string; versionId: string } | null;
  name: string;
  mask: Gray;
  field: SignedDistanceField;
  mmPerPx: number;
  naturalSizeMm: { w: number; h: number };
  minStrokeMm: number | null;
  coverage: number;
  report: ArtworkReport | null;
  source: 'sample' | 'library';
}

export interface UploadRejection {
  fileName: string;
  report: ArtworkReport;
}

export interface UseArtworkResult {
  artwork: ActiveArtwork | null;
  rejection: UploadRejection | null;
  busy: boolean;
  adoptPrepared: (svg: string, name: string) => Promise<void>;
  /** Places something already in the library, without processing it again. */
  choose: (record: StoredArtwork) => Promise<void>;
  reset: () => void;
}

export function useArtwork(initial: EditorArtwork): UseArtworkResult {
  const [artwork, setArtwork] = useState<ActiveArtwork | null>(null);
  const [rejection, setRejection] = useState<UploadRejection | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = useCallback(async (record: EditorArtwork, report: ArtworkReport | null) => {
    const mask = await loadMask(record.maskUrl);
    setArtwork({
      ref: record.ref ?? null,
      name: record.name,
      mask,
      field: fieldFromMask(mask, record.mmPerPx),
      mmPerPx: record.mmPerPx,
      naturalSizeMm: record.naturalSizeMm,
      minStrokeMm: record.stats.minStrokeMm,
      coverage: record.stats.coverage,
      report,
      source: record.ref ? 'library' : 'sample',
    });
  }, []);

  useEffect(() => {
    void adopt(initial, null);
  }, [adopt, initial]);

  /** The demo path: the same pipeline, in the tab, with nowhere to put the result. */
  const uploadInTab = useCallback(async (source: string, name: string) => {
    const prepared = prepareArtwork(source);
    if (prepared.status === 'rejected' || !prepared.artwork) {
      setRejection({ fileName: name, report: prepared.report });
      return;
    }

    const longestSideMm = Math.max(
      prepared.report.stats.contentBbox.w,
      prepared.report.stats.contentBbox.h,
    );
    // 2048 px keeps the in-tab distance field responsive; the server rasters at full pitch.
    const raster = rasterizeArtwork(prepared.artwork, {
      mmPerPx: choosePitchMm(longestSideMm),
      maxSidePx: 2048,
    });
    if (!raster) {
      setRejection({ fileName: name, report: prepared.report });
      return;
    }

    setArtwork({
      ref: null,
      name,
      mask: raster.mask,
      field: fieldFromMask(raster.mask, raster.mmPerPx),
      mmPerPx: raster.mmPerPx,
      naturalSizeMm: raster.contentSizeMm,
      minStrokeMm: prepared.report.stats.minStrokeMm,
      coverage: prepared.report.stats.coverage,
      report: prepared.report,
      source: 'sample',
    });
  }, []);

  const adoptPrepared = useCallback(
    async (svg: string, name: string) => {
      setBusy(true);
      setRejection(null);
      try {
        await uploadInTab(svg, name);
      } finally {
        setBusy(false);
      }
    },
    [uploadInTab],
  );

  const choose = useCallback(
    async (record: StoredArtwork) => {
      setBusy(true);
      setRejection(null);
      try {
        await adopt(record, record.report);
      } finally {
        setBusy(false);
      }
    },
    [adopt],
  );

  const reset = useCallback(() => {
    setRejection(null);
    void adopt(initial, null);
  }, [adopt, initial]);

  return { artwork, rejection, busy, adoptPrepared, choose, reset };
}
