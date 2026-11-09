'use client';

import { useState } from 'react';
import type { MaterialRecord } from '@pr/catalog';
import { MaterialCard } from './material-card';

/**
 * The library, with at most one live preview.
 *
 * Every preview is a WebGL context, and browsers hand out about sixteen before they start taking
 * them back — so a library of fifty materials cannot each keep one. Only the material being looked
 * at gets a canvas, which is also what an operator is doing: judging one material at a time.
 */
export function MaterialGrid({ materials }: { materials: MaterialRecord[] }) {
  const [previewing, setPreviewing] = useState<string | null>(null);

  return (
    <div className="material-grid">
      {materials.map((material) => (
        <MaterialCard
          key={material.id}
          material={material}
          previewOpen={previewing === material.id}
          onTogglePreview={() => setPreviewing((current) => (current === material.id ? null : material.id))}
        />
      ))}
    </div>
  );
}
