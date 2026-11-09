'use client';

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type { ArchivedArtwork } from '@pr/artworks';
import type { DesignBinding } from './use-design-save';

const ArchiveStatus = z.object({
  archivedArtworks: z
    .array(z.object({ artworkId: z.string().uuid(), name: z.string() }))
    .default([]),
});

export function useDesignArchive(binding: DesignBinding | undefined) {
  const [artworks, setArtworks] = useState(binding?.archivedArtworks ?? []);
  const [readOnly, setReadOnly] = useState(artworks.length > 0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!binding) return;
    try {
      const response = await fetch(`/api/designs/${binding.id}`, { cache: 'no-store' });
      if (!response.ok)
        throw new Error(
          'Archive status could not be refreshed. Reopen this design to check its status.',
        );
      const body = ArchiveStatus.parse(await response.json());
      const archived = body.archivedArtworks;
      setArtworks(archived);
      setReadOnly(archived.length > 0);
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Archive status could not be refreshed.',
      );
    }
  }, [binding]);

  useEffect(() => {
    const onFocus = () => void refresh();
    void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const onArchived = useCallback(
    (archived: ArchivedArtwork[]) => {
      setReadOnly(true);
      setArtworks(archived);
      void refresh();
    },
    [refresh],
  );

  return { artworks, readOnly, error, onArchived };
}
