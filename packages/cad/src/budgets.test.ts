import { describe, expect, it } from 'vitest';
import { budgetsForSize, checkBudgets, DEFAULT_BUDGETS } from './budgets.js';

const budget = (name: string) => DEFAULT_BUDGETS.find((b) => b.name === name)!;

describe('DEFAULT_BUDGETS', () => {
  it('gets finer and heavier as it goes', () => {
    // The ladder only makes sense if each rung is denser than the last: lod0 is what arrives first,
    // lod1 is what is looked at, render is what displacement needs geometry for.
    const names = DEFAULT_BUDGETS.map((b) => b.name);
    expect(names).toEqual(['lod0', 'lod1', 'render']);
    for (let i = 1; i < DEFAULT_BUDGETS.length; i++) {
      expect(DEFAULT_BUDGETS[i]!.deflectionMm).toBeLessThan(DEFAULT_BUDGETS[i - 1]!.deflectionMm);
      expect(DEFAULT_BUDGETS[i]!.maxTriangles).toBeGreaterThan(DEFAULT_BUDGETS[i - 1]!.maxTriangles);
    }
  });

  it('keeps the first mesh inside a streaming budget', () => {
    // docs/03-gui gives lod0 three seconds on cable broadband. 4 MB of uncompressed GLB is about
    // 1.3 s of that at 25 Mbit/s, which leaves the HDRI and the editor their share.
    //
    // Raised from 1.5 MB to admit the 89-400 Ribbed (~3.4 MB), knowingly and as a stopgap until an
    // overrunning mesh is simplified instead of refused (F-CADX-08). It is still a ceiling — raising
    // it again is a decision, not a fix.
    expect(budget('lod0').maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('has room for the parts that are actually imported', () => {
    // The measurements in budgets.ts, as a test rather than as a comment: the ladder is worth
    // nothing if the next ribbed closure through the door is refused the way the last one was.
    const heaviestMeasured = { lod0: 3360 * 1024, lod1: 20_500 * 1024, render: 45_300 * 1024 };
    for (const [name, bytes] of Object.entries(heaviestMeasured)) {
      expect(budget(name).maxBytes).toBeGreaterThan(bytes);
    }
    const heaviestTriangles = { lod0: 100_782, lod1: 707_238, render: 1_575_612 };
    for (const [name, triangles] of Object.entries(heaviestTriangles)) {
      expect(budget(name).maxTriangles).toBeGreaterThan(triangles);
    }
  });
});

describe('budgetsForSize', () => {
  it('leaves a small part alone', () => {
    expect(budgetsForSize(20)).toEqual(DEFAULT_BUDGETS);
    expect(budgetsForSize(38)).toEqual(DEFAULT_BUDGETS);
  });

  it('loosens deflection in proportion to a larger part', () => {
    // A 380 mm display carton tessellated at the closure's 0.01 mm produces a mesh nobody asked
    // for. Chord error is only ever seen relative to how big the thing is on screen.
    const large = budgetsForSize(380);
    expect(large.find((b) => b.name === 'render')!.deflectionMm).toBeCloseTo(0.1, 4);
    expect(large.find((b) => b.name === 'lod0')!.deflectionMm).toBeCloseTo(0.8, 4);
  });

  it('does not move the triangle ceilings', () => {
    // The ceiling is what a browser can stream, which does not care how big the part is.
    for (const scaled of budgetsForSize(1_000)) {
      expect(scaled.maxTriangles).toBe(budget(scaled.name).maxTriangles);
    }
  });
});

describe('checkBudgets', () => {
  it('passes meshes inside their budgets', () => {
    expect(checkBudgets([{ lod: 'lod0', triangles: 12_000, bytes: 200 * 1024 }])).toEqual([]);
  });

  it('names what was over and by how much', () => {
    const breaches = checkBudgets([{ lod: 'lod0', triangles: 150_000, bytes: 5_000 * 1024 }]);
    expect(breaches.map((b) => b.measure).sort()).toEqual(['bytes', 'triangles']);
    expect(breaches[0]!.limit).toBeGreaterThan(0);
  });

  it('says nothing about a mesh it has no budget for', () => {
    // `validate.ts` is where an unexpected mesh is caught; reporting it here as well would give an
    // operator the same finding in two vocabularies.
    expect(checkBudgets([{ lod: 'preview', triangles: 9_000_000, bytes: 1 }])).toEqual([]);
  });
});
