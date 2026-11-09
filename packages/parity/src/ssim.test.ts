import { describe, expect, it } from 'vitest';
import { compareRenders, PARITY_BUDGET } from './compare.js';
import { resizeGray, ssim, toGray, type Gray } from './ssim.js';

/**
 * The measure has to be right before the budget means anything, so this checks it against images
 * whose answer is known — and, more importantly, against the two failure modes it exists to tell
 * apart: an image that is uniformly darker (which nobody minds) and an image with the logo in the
 * wrong place (which is the whole product).
 */

function gray(width: number, height: number, at: (x: number, y: number) => number): Gray {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = at(x, y);
  }
  return { width, height, data };
}

/** A "product": a bright disc on a dark ground, with a dark mark on it. */
const product = (markX: number, markY: number, brightness = 1) =>
  gray(96, 96, (x, y) => {
    const onDisc = Math.hypot(x - 48, y - 48) < 34;
    const onMark = Math.hypot(x - markX, y - markY) < 8;
    if (!onDisc) return 0.08 * brightness;
    return (onMark ? 0.25 : 0.75) * brightness;
  });

describe('ssim', () => {
  it('is 1 for an image against itself', () => {
    const image = product(48, 48);
    expect(ssim(image, image).ssim).toBeCloseTo(1, 6);
  });

  it('barely moves when the whole image is a little darker', () => {
    // A tone-mapping difference between two renderers looks like this, and it is not a parity bug.
    const result = ssim(product(48, 48), product(48, 48, 0.92));

    expect(result.ssim).toBeGreaterThan(0.95);
    expect(result.local).toBeGreaterThan(PARITY_BUDGET.local);
    expect(result.meanAbsolute).toBeGreaterThan(0.01);
  });

  it('drops hard when the mark moves, which is the failure that matters', () => {
    const moved = ssim(product(48, 48), product(66, 48));

    // The mean hardly notices — most of the frame is background — which is exactly why the
    // worst-windows average is the number the budget is set on.
    expect(moved.ssim).toBeGreaterThan(0.85);
    expect(moved.local).toBeLessThan(PARITY_BUDGET.local);
    // And it says where: the worst window is near the mark, not in the empty corner.
    expect(moved.worst.x).toBeGreaterThan(20);
    expect(moved.worst.x).toBeLessThan(80);
  });

  it('drops when the mark is mirrored, which a mean-error check would miss', () => {
    const mirrored = ssim(product(34, 48), product(62, 48));
    expect(mirrored.local).toBeLessThan(PARITY_BUDGET.local);
  });

  it('refuses to compare images of different sizes rather than guessing', () => {
    expect(() => ssim(product(48, 48), resizeGray(product(48, 48), 48, 48))).toThrow(/cannot compare/);
  });
});

describe('toGray', () => {
  it('weights the channels the way an eye does', () => {
    const green = toGray(new Uint8Array([0, 255, 0, 255]), 1, 1);
    const blue = toGray(new Uint8Array([0, 0, 255, 255]), 1, 1);

    expect(green.data[0]).toBeGreaterThan(blue.data[0]!);
  });

  it('composites transparency onto grey, so an alpha render is comparable', () => {
    const transparent = toGray(new Uint8Array([255, 255, 255, 0]), 1, 1);
    expect(transparent.data[0]).toBeCloseTo(0.5, 6);
  });
});

describe('compareRenders', () => {
  const rgba = (image: Gray): Uint8Array => {
    const out = new Uint8Array(image.width * image.height * 4);
    for (let i = 0; i < image.data.length; i++) {
      const value = Math.round(image.data[i]! * 255);
      out[i * 4] = value;
      out[i * 4 + 1] = value;
      out[i * 4 + 2] = value;
      out[i * 4 + 3] = 255;
    }
    return out;
  };

  it('compares at the smaller resolution rather than inventing detail', () => {
    const preview = product(48, 48);
    const report = compareRenders(
      { rgba: rgba(preview), width: 96, height: 96 },
      { rgba: rgba(resizeGray(preview, 48, 48)), width: 48, height: 48 },
    );

    expect(report.width).toBe(48);
    expect(report.height).toBe(48);
    expect(report.ok).toBe(true);
  });

  it('fails a placement that moved, and says by how much', () => {
    const report = compareRenders(
      { rgba: rgba(product(48, 48)), width: 96, height: 96 },
      { rgba: rgba(product(70, 48)), width: 96, height: 96 },
    );

    expect(report.ok).toBe(false);
    expect(report.local).toBeLessThan(report.budget.local);
    expect(report.difference.data.some((value) => value > 0.3)).toBe(true);
  });
});
