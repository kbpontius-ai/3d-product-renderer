import type { Vec3 } from '@pr/design-schema';

export interface BoundingSphere {
  centerMm: Vec3;
  radiusMm: number;
}

export type Bbox = readonly [Vec3, Vec3];

/**
 * Framing is always derived from the product's bounding sphere, never from per-product tuning.
 * That is what lets one set of camera presets — and one turntable path — serve a cap, a bottle and
 * a carton without a single product-specific line (F-SCENE-02, F-REND-10).
 */
export function boundingSphere(bbox: Bbox): BoundingSphere {
  const [min, max] = bbox;
  const centerMm: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radiusMm =
    Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || Number.EPSILON;
  return { centerMm, radiusMm };
}

/** Height of the product, used to keep the horizon and the sweep line sensible. */
export const bboxHeightMm = (bbox: Bbox): number => bbox[1][1] - bbox[0][1];
