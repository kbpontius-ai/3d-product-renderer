import { differenceMap, resizeGray, ssim, toGray, type Gray, type SsimResult } from './ssim.js';

/**
 * The parity budget (I1).
 *
 * Two numbers, doing two different jobs.
 *
 * `mean` is a sanity floor. It is dominated by the backdrop — most of a product shot is empty — so
 * it cannot tell a well-placed logo from a badly placed one, and it is not asked to: what it
 * catches is the whole frame going wrong, an exposure or a tone transform or a background that
 * stopped matching. A measured pair sits near 0.90, and the floor leaves room for the difference
 * between a rasteriser and a path tracer without leaving room for a blow-out.
 *
 * `local` is the one about placement. Averaged over the worst one per cent of windows, a matching
 * pair measures 0.57 and the same render against a mark six millimetres out of place measures
 * 0.10; the floor sits between them with room on both sides.
 *
 * Both are floors that regressions break, not targets. The preview is a raster approximation of a
 * path trace, so perfect agreement was never the goal; what these protect is the placement — the
 * logo's position, size and orientation — which is the promise the product makes.
 */
export const PARITY_BUDGET = { mean: 0.8, local: 0.35 } as const;

export type ParityBudget = { mean: number; local: number };

export interface ParityReport extends SsimResult {
  /** Where the comparison was made, once both images were brought to the same size. */
  width: number;
  height: number;
  ok: boolean;
  budget: ParityBudget;
  difference: Gray;
}

export interface RenderImage {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/**
 * Compares a preview against a render.
 *
 * The smaller image decides the resolution: upsampling the smaller one would invent detail and
 * flatter the score.
 */
export function compareRenders(
  preview: RenderImage,
  render: RenderImage,
  budget: ParityBudget = PARITY_BUDGET,
): ParityReport {
  const width = Math.min(preview.width, render.width);
  const height = Math.min(preview.height, render.height);

  const a = resizeGray(toGray(preview.rgba, preview.width, preview.height), width, height);
  const b = resizeGray(toGray(render.rgba, render.width, render.height), width, height);

  const result = ssim(a, b);
  return {
    ...result,
    width,
    height,
    budget,
    ok: result.ssim >= budget.mean && result.local >= budget.local,
    difference: differenceMap(a, b),
  };
}
