import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SCENE_SCRIPT, srgbToLinear } from './scene.js';

/**
 * The generated scene is Python that runs inside another process, hours after it was written, on a
 * machine nobody is watching. Compiling it here turns "the render failed at 90%" into a failing
 * unit test.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pr-scene-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the generated scene script', () => {
  it('is syntactically valid Python', () => {
    const path = join(scratch, 'scene.py');
    writeFileSync(path, SCENE_SCRIPT, 'utf8');

    expect(() => execFileSync('python3', ['-m', 'py_compile', path], { stdio: 'pipe' })).not.toThrow();
  });

  it('never executes anything from the job it is given', () => {
    // The design is data. If any of these appear, a customer's file could become code.
    for (const forbidden of ['eval(', 'exec(', '__import__', 'subprocess', 'os.system']) {
      expect(SCENE_SCRIPT).not.toContain(forbidden);
    }
  });

  it('reads its input as JSON and nothing else', () => {
    expect(SCENE_SCRIPT).toContain('json.load(open(sys.argv[sys.argv.index');
  });

  it('shades a filled relief and a printed mark through the same path', () => {
    // The relief branch used to mix base colour alone while the print branch mixed roughness and
    // metallic too, so a foil emboss rendered gold and matte where the preview — which has always
    // blended all three — showed it gold and mirrored. The parity suite never caught it because it
    // only measures a blind emboss and a printed mark, and neither goes through this branch.
    //
    // One helper called from both is what stops that returning. Asserted structurally, because the
    // failure mode of the version this replaced was silence.
    expect(SCENE_SCRIPT).toContain('def shade_ink(nt, bsdf, ink, coverage):');
    const calls = SCENE_SCRIPT.match(/shade_ink\(nt, bsdf, placement\['ink'\]/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it('blends roughness and metallic wherever a mark covers the part', () => {
    for (const channel of ["bsdf.inputs['Base Color']", "('Roughness', 'roughness')", "('Metallic', 'metallic')"]) {
      expect(SCENE_SCRIPT).toContain(channel);
    }
  });
});

describe('srgbToLinear', () => {
  it('maps the ends exactly', () => {
    expect(srgbToLinear('#000000')).toEqual([0, 0, 0]);
    expect(srgbToLinear('#ffffff')).toEqual([1, 1, 1]);
  });

  it('lands mid-grey where the transfer function says, not at 0.5', () => {
    const [r] = srgbToLinear('#808080');
    expect(r).toBeCloseTo(0.2158, 3);
  });

  it('keeps channels independent', () => {
    expect(srgbToLinear('#ff0000')).toEqual([1, 0, 0]);
    expect(srgbToLinear('#0000ff')).toEqual([0, 0, 1]);
  });
});
