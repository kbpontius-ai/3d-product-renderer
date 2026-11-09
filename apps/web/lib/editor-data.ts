import type { ArtworkReport, DecorationZoneDef, FinishFamily, Vec3 } from '@pr/design-schema';
import type { CameraPresetDef } from '@pr/scene';

/**
 * What the editor needs to draw a product, independent of where it came from.
 *
 * The demo route fills these from pack fixtures on disk and the design route fills them from the
 * catalog; the editor cannot tell the difference, which is the point — it is a client of the data,
 * not of the database.
 */

export interface EditorZone {
  /** Unique within the list the rail shows. Not the pack's zone key — see `definition.key`. */
  key: string;
  name: string;
  type: DecorationZoneDef['type'];
  widthMm: number;
  heightMm: number;
  safeMarginMm: number;
  definition: DecorationZoneDef;
  packKey: string;
  productKey: string;
  variantKey: string;
  meshUrl: string;
  bboxMm: [Vec3, Vec3];
  cameraPresets: CameraPresetDef[];
  presentationOrientation?: import('@pr/design-schema').PresentationOrientation;
  defaultMaterialKey: string;
  /**
   * The material slots this variant declares (F-MAT-01).
   *
   * A pack decides what parts a product has and what may go on each of them; the editor renders
   * whatever it is told, which is the whole reason a cap and a carton need no separate code.
   */
  materialSlots: MaterialSlot[];
}

export interface MaterialSlot {
  key: string;
  label: string;
  defaultMaterialKey: string;
  /** Empty means any family; otherwise the picker offers only these. */
  allowedFamilies: string[];
  /** Empty means any finish; otherwise the picker offers only these (F-MAT-03). */
  allowedFinishes: FinishFamily[];
  colorizable: boolean;
}

/**
 * An artwork the editor can draw and place.
 *
 * `ref` is what separates the two kinds: a stored artwork has one, and placing it writes a
 * placement into the design. The bundled sample has none, so it can be looked at but not saved —
 * a design references artwork that exists, or it references nothing.
 */
export interface EditorArtwork {
  ref?: { artworkId: string; versionId: string };
  key: string;
  name: string;
  naturalSizeMm: { w: number; h: number };
  mmPerPx: number;
  widthPx: number;
  heightPx: number;
  sdfRangeMm: [number, number];
  stats: { coverage: number; minStrokeMm: number | null };
  /** Same-origin URL for the coverage mask; production issues a short-lived signed URL instead. */
  maskUrl: string;
}

/** What `GET`/`POST /api/artworks` returns: an artwork plus why the pipeline accepted it. */
export type StoredArtwork = EditorArtwork & {
  ref: { artworkId: string; versionId: string };
  sourceUrl: string;
  report: ArtworkReport;
  createdAt: string;
  selectionEditable?: boolean;
  archivedAt?: string | null;
};
