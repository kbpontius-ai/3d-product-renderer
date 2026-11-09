import { describe, expect, it } from 'vitest';
import {
  FRAME_BUDGET_MS,
  MIN_SAMPLES,
  QUALITY_LEVELS,
  nextLevel,
  readDeviceHints,
  startingLevel,
  type DeviceHints,
} from './quality';

const hints = (over: Partial<DeviceHints> = {}): DeviceHints => ({
  softwareRenderer: false,
  maxTextureSize: 16384,
  devicePixelRatio: 2,
  ...over,
});

/** `count` frames that all took `ms`. */
const frames = (ms: number, count = MIN_SAMPLES) => Array.from({ length: count }, () => ms);

describe('startingLevel', () => {
  it('starts at the bottom when WebGL is being emulated on the CPU', () => {
    expect(startingLevel(hints({ softwareRenderer: true }))).toBe(0);
    // Even when everything else about the device looks capable.
    expect(startingLevel(hints({ softwareRenderer: true, maxTextureSize: 16384 }))).toBe(0);
  });

  it('holds back on a device whose driver admits a low ceiling', () => {
    expect(startingLevel(hints({ maxTextureSize: 4096 }))).toBe(1);
  });

  it('starts high only on a capable device with a scaled display', () => {
    expect(startingLevel(hints())).toBe(2);
    expect(startingLevel(hints({ devicePixelRatio: 1 }))).toBe(1);
  });
});

describe('nextLevel', () => {
  it('waits for enough frames rather than judging a cold start', () => {
    // The frames right after a mesh loads are always slow; acting on them would punish every
    // product for being loaded at all.
    expect(nextLevel(2, frames(100, MIN_SAMPLES - 1))).toBe(2);
  });

  it('steps down when the frames are over budget', () => {
    expect(nextLevel(2, frames(FRAME_BUDGET_MS + 10))).toBe(1);
  });

  it('steps up when there is room to spare', () => {
    expect(nextLevel(0, frames(5))).toBe(1);
  });

  it('stays put in between, so it does not oscillate', () => {
    // Between the two thresholds: fast enough to keep, not fast enough to promise more.
    const between = (FRAME_BUDGET_MS + 1000 / 58) / 2;
    expect(nextLevel(1, frames(between))).toBe(1);
  });

  it('ignores a single slow frame among good ones', () => {
    const mostlyFine = [...frames(6, 20), 400];
    expect(nextLevel(1, mostlyFine)).toBe(2);
  });

  it('stops at both ends rather than running off the array', () => {
    expect(nextLevel(0, frames(500))).toBe(0);
    expect(nextLevel(QUALITY_LEVELS.length - 1, frames(1))).toBe(QUALITY_LEVELS.length - 1);
  });

  it('moves one step at a time, however bad it is', () => {
    // A cliff from high to low is more jarring than two steps, and the measurement after the first
    // step is what says whether the second is needed.
    expect(nextLevel(2, frames(2000))).toBe(1);
  });
});

describe('QUALITY_LEVELS', () => {
  it('gets cheaper going down, on every axis at once', () => {
    for (let i = 1; i < QUALITY_LEVELS.length; i++) {
      expect(QUALITY_LEVELS[i]!.dpr).toBeGreaterThan(QUALITY_LEVELS[i - 1]!.dpr);
      expect(QUALITY_LEVELS[i]!.anisotropy).toBeGreaterThanOrEqual(QUALITY_LEVELS[i - 1]!.anisotropy);
    }
  });
});

describe('readDeviceHints', () => {
  const context = (renderer: string | null, maxTextureSize = 16384) =>
    ({
      MAX_TEXTURE_SIZE: 0x0d33,
      getExtension: (name: string) =>
        name === 'WEBGL_debug_renderer_info' && renderer !== null
          ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
          : null,
      getParameter: (p: number) => (p === 0x9246 ? renderer : maxTextureSize),
    }) as unknown as WebGLRenderingContext;

  it('recognises the software rasterisers by name', () => {
    for (const name of ['Google SwiftShader', 'llvmpipe (LLVM 15.0.7)', 'Microsoft Basic Render Driver']) {
      expect(readDeviceHints(context(name)).softwareRenderer).toBe(true);
    }
  });

  it('does not mistake a real GPU for one', () => {
    expect(readDeviceHints(context('Apple M2 Pro')).softwareRenderer).toBe(false);
    expect(readDeviceHints(context('NVIDIA GeForce RTX 4070')).softwareRenderer).toBe(false);
  });

  it('assumes hardware when the browser will not say, rather than punishing the customer', () => {
    // Refusing the extension is a privacy measure, not a signal about the device.
    expect(readDeviceHints(context(null)).softwareRenderer).toBe(false);
  });

  it('reports the texture ceiling the driver gives', () => {
    expect(readDeviceHints(context('Apple M2 Pro', 4096)).maxTextureSize).toBe(4096);
  });
});
