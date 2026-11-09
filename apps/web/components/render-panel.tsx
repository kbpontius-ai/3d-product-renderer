'use client';

import type { RenderLighting } from '@pr/design-schema';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Submitting a render and watching it happen (W-08, build order H7).
 *
 * Polling rather than SSE for now: a job's whole state is one row, the tray only matters while a
 * render is in flight, and a poll that stops when nothing is running costs nothing when nothing is.
 */

export interface RenderJobView {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  stage: string | null;
  progress: number;
  estimateSeconds: number;
  error: { code: string; message: string } | null;
  /** `url` downloads the original; `previewUrl` is the web-sized copy to show (F-EXP-01). */
  outputs: { url: string; previewUrl: string; width?: number; height?: number; bytes?: number }[];
}

const PRESETS = [
  { key: 'draft', label: 'Draft', note: 'quick look' },
  { key: 'standard', label: 'Standard', note: 'presentation' },
  { key: 'final', label: 'Final', note: 'print' },
] as const;

const SIZES = [
  { key: '1k', label: '1K' },
  { key: '2k', label: '2K' },
  { key: '4k', label: '4K' },
  { key: 'custom', label: 'Custom' },
] as const;

const FORMATS = [
  { key: 'png16', label: 'PNG 16' },
  { key: 'png8', label: 'PNG 8' },
  { key: 'webp', label: 'WebP' },
  { key: 'jpeg', label: 'JPEG' },
] as const;

const POLL_MS = 1500;

const STAGE_LABELS: Record<string, string> = {
  claimed: 'Starting',
  assets: 'Fetching assets',
  bake: 'Baking relief',
  build: 'Building the scene',
  trace: 'Tracing',
  upload: 'Saving',
  done: 'Done',
  requeued: 'Retrying',
};

export function RenderPanel({
  designId,
  blocked,
  lighting,
  beforeSubmit,
  inspectionActive = false,
  onReturnToProduct,
}: {
  designId: string;
  blocked: boolean;
  lighting: RenderLighting;
  beforeSubmit: () => Promise<boolean>;
  inspectionActive?: boolean;
  onReturnToProduct?: () => void;
}) {
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['key']>('standard');
  const [size, setSize] = useState<(typeof SIZES)[number]['key']>('2k');
  const [format, setFormat] = useState<(typeof FORMATS)[number]['key']>('png16');
  const [custom, setCustom] = useState({ widthPx: 1600, heightPx: 1200 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [job, setJob] = useState<RenderJobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async (jobId: string) => {
    const response = await fetch(`/api/renders/${jobId}`);
    if (!response.ok) return;
    setJob((await response.json()) as RenderJobView);
  }, []);

  // Poll only while something is actually happening.
  useEffect(() => {
    if (
      !job ||
      job.status === 'succeeded' ||
      job.status === 'failed' ||
      job.status === 'canceled'
    ) {
      return;
    }
    timer.current = setTimeout(() => void poll(job.id), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [job, poll]);

  const submit = async () => {
    if (blocked) return;
    const lightingAtSubmit = structuredClone(lighting);
    setBusy(true);
    setError(null);
    try {
      if (!await beforeSubmit()) {
        setError('Save your changes successfully before rendering.');
        return;
      }
      const response = await fetch(`/api/designs/${designId}/renders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preset,
          size,
          format,
          lighting: lightingAtSubmit,
          ...(size === 'custom' ? custom : {}),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { code: string } };
        setError(messageFor(body.error?.code, response.status));
        return;
      }
      setJob((await response.json()) as RenderJobView);
      setStartedAt(Date.now());
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    await fetch(`/api/renders/${job.id}`, { method: 'DELETE' });
    await poll(job.id);
  };

  const running = job?.status === 'queued' || job?.status === 'running';

  return (
    <section data-testid="render-panel">
      <h2>Render</h2>
      {inspectionActive && (
        <div className="inspection-export-note">
          <p className="inspection-note">Render will use the current Inspection lighting and rotation.</p>
          <button type="button" className="wide" onClick={onReturnToProduct}>
            Use design lighting
          </button>
        </div>
      )}

      <div className="segmented">
        {PRESETS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={preset === option.key ? 'active' : ''}
            title={option.note}
            onClick={() => setPreset(option.key)}
            data-testid={`preset-${option.key}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="segmented">
        {SIZES.map((option) => (
          <button
            key={option.key}
            type="button"
            className={size === option.key ? 'active' : ''}
            onClick={() => setSize(option.key)}
            data-testid={`size-${option.key}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {size === 'custom' && (
        <div className="grid2">
          <label>
            Width (px)
            <input
              type="number"
              min="64"
              step="16"
              value={custom.widthPx}
              data-testid="size-width"
              onChange={(e) => setCustom((c) => ({ ...c, widthPx: Number(e.target.value) || 0 }))}
            />
          </label>
          <label>
            Height (px)
            <input
              type="number"
              min="64"
              step="16"
              value={custom.heightPx}
              data-testid="size-height"
              onChange={(e) => setCustom((c) => ({ ...c, heightPx: Number(e.target.value) || 0 }))}
            />
          </label>
        </div>
      )}

      <div className="segmented">
        {FORMATS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={format === option.key ? 'active' : ''}
            onClick={() => setFormat(option.key)}
            data-testid={`format-${option.key}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="primary wide"
        disabled={blocked || busy || running}
        onClick={() => void submit()}
        data-testid="render-button"
      >
        {running ? 'Rendering…' : busy ? 'Submitting…' : 'Render'}
      </button>

      {blocked && <p className="readout">Fix the problems on the design before rendering it.</p>}
      {error && (
        <p className="issue error" data-testid="render-error">
          {error}
        </p>
      )}

      {job && (
        <div className="render-job" data-testid="render-job" data-status={job.status}>
          <p className="readout">
            {job.status === 'succeeded'
              ? 'Ready'
              : job.status === 'failed'
                ? (job.error?.message ?? 'The render failed.')
                : job.status === 'canceled'
                  ? 'Canceled'
                  : `${STAGE_LABELS[job.stage ?? ''] ?? 'Queued'} · ${remaining(job, startedAt)}`}
          </p>

          {running && (
            <>
              <div
                className="progress"
                role="progressbar"
                aria-valuenow={Math.round(job.progress * 100)}
              >
                <span style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
              </div>
              <button type="button" onClick={() => void cancel()} data-testid="render-cancel">
                Cancel
              </button>
            </>
          )}

          {job.outputs.map((output) => (
            <a
              key={output.url}
              href={output.url}
              download
              className="render-output"
              data-testid="render-output"
            >
              {/* The small copy to look at; the link around it still downloads the original. */}
              <img src={output.previewUrl} alt="Rendered product" />
              <span>Download {output.width && `${output.width}px`}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function messageFor(code: string | undefined, status: number): string {
  switch (code) {
    case 'invalid_lighting':
      return 'The viewer lighting is invalid. Choose a supported lighting preset and try again.';
    case 'invalid_size':
      return 'A custom size needs a width and a height of at least 64 px.';
    case 'size_over_quota':
      return 'That is larger than this organization may render. Ask an administrator to raise the limit.';
    case 'quota_exceeded':
      return 'You have used today’s renders. They reset tomorrow.';
    case 'too_many_running':
      return 'Too many renders are already in flight. Wait for one to finish.';
    case 'nothing_to_render':
      return 'Place your artwork before rendering.';
    case 'product_unavailable':
    case 'product_not_renderable':
      return 'This product cannot be rendered right now.';
    default:
      return status === 401 ? 'Your session expired.' : 'The render could not be submitted.';
  }
}

/**
 * How long is left (F-REND-03).
 *
 * Measured against what this render has actually done rather than against the estimate alone: a
 * job that is halfway after twenty seconds has twenty to go, whatever the estimate said before it
 * started. The estimate is only used until there is progress to measure.
 */
function remaining(job: RenderJobView, startedAt: number | null): string {
  if (job.status === 'queued' || !startedAt || job.progress <= 0.02) {
    return `about ${format(job.estimateSeconds)}`;
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  const projected = elapsed / job.progress - elapsed;
  return `about ${format(Math.max(1, projected))} left`;
}

function format(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
