import 'server-only';
import type { RenderJob } from '@pr/render-jobs';

/**
 * A job as the browser sees it: storage keys become URLs it may actually fetch.
 *
 * Two of them, because they are for different things (F-EXP-01). `url` is the original — what the
 * download link points at, and what a printer is given. `previewUrl` is the web-sized copy, which
 * is what goes in an `img` tag; without it the gallery downloads a 4K sixteen-bit PNG per tile.
 * Renders finished before there were small copies fall back to the original, so the caller never
 * has to decide whether one exists.
 */
export type ClientRenderJob = Omit<RenderJob, 'outputs'> & {
  outputs: (RenderJob['outputs'][number] & { url: string; previewUrl: string })[];
};

export const withDownloadUrls = (
  job: RenderJob,
  toUrl: (storageKey: string) => string,
): ClientRenderJob => ({
  ...job,
  outputs: job.outputs.map((output) => ({
    ...output,
    url: toUrl(output.storageKey),
    previewUrl: toUrl(output.webStorageKey ?? output.storageKey),
  })),
});
