import 'server-only';
import { cyclesLocal } from '@pr/blender';
import { fakeBackend, type RenderBackend } from '@pr/render-backend';

/**
 * What renderer this deployment has (F-GEN-04).
 *
 * The web side needs it for one thing — the version string that becomes part of a job's identity,
 * so two renders submitted a second apart cannot disagree about what will draw them. It asks the
 * backend rather than Blender, which is the whole point of there being a contract.
 */

const globalForRenderer = globalThis as unknown as {
  __prBackend?: RenderBackend;
  __prRenderer?: Promise<string>;
};

/**
 * The backend this deployment renders with.
 *
 * `RENDER_BACKEND=fake` swaps in the stand-in: it produces flat images through the real queue and
 * the real download path, which is how the workflow can be exercised on a machine with no renderer.
 */
export function getRenderBackend(): RenderBackend {
  return (globalForRenderer.__prBackend ??=
    process.env['RENDER_BACKEND'] === 'fake'
      ? fakeBackend()
      : cyclesLocal({ ...(process.env['BLENDER_PATH'] ? { blenderPath: process.env['BLENDER_PATH'] } : {}) }));
}

export function rendererVersion(): Promise<string> {
  return (globalForRenderer.__prRenderer ??= getRenderBackend()
    .probe()
    .then((probe) => (probe.available ? (probe.version ?? 'unknown') : 'unavailable')));
}
