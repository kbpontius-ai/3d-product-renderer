import { decode16, encode16, heightMm, type FinishParams } from '@pr/artwork';
import { decodeGrayPng, encodeGray16Png, encodeGray8Png } from '@pr/artwork/png';
import type { Placement, RenderSpec } from '@pr/design-schema';

/**
 * The parity hand-off (docs/17 §"Artwork baking").
 *
 * The preview shades a distance field in GLSL; Cycles displaces a height map. Both come from the
 * same `heightMm` — this is where that promise is kept, by turning the stored distance field into
 * millimetres of relief here rather than reimplementing the profile in Python.
 */

/**
 * The fixed millimetre range a baked height map encodes.
 *
 * Fixed, not per-artwork: Blender decodes with a constant so a map can be inspected, cached and
 * compared without carrying its own scale. It spans the schema's maximum relief in both directions.
 */
export const HEIGHT_ENCODE_RANGE_MM: readonly [number, number] = [-5, 5];

export interface BakedMap {
  placementId: string;
  kind: 'height' | 'ink';
  fileName: string;
  png: Buffer;
  width: number;
  height: number;
  /** Present for height maps: what 0 and 65535 mean, in millimetres. */
  rangeMm?: readonly [number, number];
}

export interface ArtworkSource {
  /** 16-bit signed distance field, as written by the artwork pipeline. */
  sdfPng: Uint8Array;
  sdfRangeMm: readonly [number, number];
  /** 8-bit coverage mask, used for printed finishes. */
  maskPng: Uint8Array;
}

export function bakePlacement(placement: Placement, source: ArtworkSource): BakedMap {
  if (placement.finish.kind === 'print') {
    const mask = decodeGrayPng(source.maskPng);
    return {
      placementId: placement.id,
      kind: 'ink',
      fileName: `ink-${placement.id}.png`,
      png: encodeGray8Png(Uint8Array.from(mask.data), mask.width, mask.height, [
        { key: 'placement', value: placement.id },
      ]),
      width: mask.width,
      height: mask.height,
    };
  }

  const sdf = decodeGrayPng(source.sdfPng);
  if (sdf.bitDepth !== 16) throw new Error('a distance field must be 16-bit');

  const params: FinishParams = {
    kind: placement.finish.kind,
    depthMm: placement.finish.depthMm,
    bevelDeg: placement.finish.bevelDeg,
    edgeRadiusMm: placement.finish.edgeRadiusMm,
  };

  const encoded = new Uint16Array(sdf.data.length);
  for (let i = 0; i < encoded.length; i++) {
    // The field is positive inside the mark, and `heightMm` is zero outside it — the same call the
    // preview shader makes, with the same sign, which is the whole point of baking here.
    const distanceMm = decode16(sdf.data[i]!, source.sdfRangeMm as [number, number]);
    encoded[i] = encode16(heightMm(distanceMm, params), HEIGHT_ENCODE_RANGE_MM as [number, number]);
  }

  return {
    placementId: placement.id,
    kind: 'height',
    fileName: `height-${placement.id}.png`,
    png: encodeGray16Png(encoded, sdf.width, sdf.height, [
      { key: 'placement', value: placement.id },
      { key: 'heightRangeMm', value: HEIGHT_ENCODE_RANGE_MM.join(',') },
    ]),
    width: sdf.width,
    height: sdf.height,
    rangeMm: HEIGHT_ENCODE_RANGE_MM,
  };
}

/** Bakes every placement in a spec, in document order. */
export function bakeSpec(spec: RenderSpec, sources: Map<string, ArtworkSource>): BakedMap[] {
  return spec.document.placements.map((placement) => {
    const source = sources.get(placement.artwork.versionId);
    if (!source) throw new Error(`no artwork assets for version ${placement.artwork.versionId}`);
    return bakePlacement(placement, source);
  });
}
