'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { JobConcern } from '@pr/job-queue';
import type { QueueJobView } from '@pr/render-jobs';
import { JobLog } from '@/components/job-log';
import { useConfirm } from '@/components/confirm-dialog';

/**
 * One job, with the two things staff can do to it and the reason it needs doing.
 *
 * The failure message is shown in full rather than summarised: it is the renderer's own words, and
 * an operator deciding whether to retry needs them exactly. Cancelling asks first — it stops a
 * customer's render — and Retry is offered only for what failed or was cancelled: a succeeded job
 * run again renders the same pixels and charges for them.
 */
export function JobRow({
  job,
  concerns,
  concernText,
}: {
  job: QueueJobView;
  concerns: JobConcern[];
  concernText: Record<JobConcern, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const act = async (action: 'retry' | 'cancel') => {
    if (
      action === 'cancel' &&
      !(await confirm({
        title: `Cancel this render for ${job.orgName}?`,
        consequences: [
          job.status === 'running' ? 'It stops now; the work done so far is lost.' : 'It leaves the queue before it starts.',
          'They see it as cancelled, and can submit it again.',
        ],
        confirmLabel: 'Cancel render',
        cancelLabel: 'Keep it',
        tone: 'danger',
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/queue/${job.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { code?: string; detail?: string } };
        setError(body.error?.detail ?? body.error?.code ?? 'that did not work');
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const live = job.status === 'queued' || job.status === 'running';
  const retryable = job.status === 'failed' || job.status === 'canceled';
  const stages = Object.entries(job.stages);

  return (
    <tr data-testid={`job-${job.id}`} data-status={job.status}>
      <td>
        <strong>{job.id.slice(0, 8)}</strong>
        <small>
          {job.stage ?? '—'}
          {job.workerId ? ` · ${job.workerId}` : ''}
        </small>
        {job.error && (
          <small className="admin-error" data-testid={`job-error-${job.id}`}>
            {job.error.code}: {job.error.message}
          </small>
        )}
        {concerns.map((concern) => (
          <small key={concern} className="admin-warn" data-testid={`job-concern-${job.id}`}>
            {concernText[concern]}
          </small>
        ))}
        {error && <small className="admin-error">{error}</small>}
        {dialog}
      </td>
      <td>{job.orgName}</td>
      <td>
        <span className={`pill ${pillFor(job.status)}`}>{job.status}</span>
        {concerns.length > 0 && <span className="pill bad">stuck</span>}
        {job.status === 'running' && <small>{Math.round(job.progress * 100)}%</small>}
      </td>
      <td>{job.attempts}</td>
      <td>
        <small>
          {job.gpuSeconds !== null ? `${job.gpuSeconds.toFixed(1)}s render` : `~${job.estimateSeconds}s est`}
        </small>
        {stages.length > 0 && (
          <small data-testid={`job-stages-${job.id}`}>
            {stages.map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(' · ')}
          </small>
        )}
      </td>
      <td className="admin-row-actions">
        {live && (
          <button type="button" disabled={busy} data-testid={`cancel-${job.id}`} onClick={() => void act('cancel')}>
            Cancel
          </button>
        )}
        {retryable && (
          <button type="button" disabled={busy} data-testid={`retry-${job.id}`} onClick={() => void act('retry')}>
            Retry
          </button>
        )}
        <JobLog endpoint={`/api/admin/queue/${job.id}`} testId={`job-log-${job.id}`} />
      </td>
    </tr>
  );
}

const pillFor = (status: QueueJobView['status']): string =>
  status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : status === 'running' ? 'warn' : '';
