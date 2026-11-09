'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useState } from 'react';
import type { JobLogLine } from '@pr/job-queue';

/**
 * A job's own log, fetched when asked for (F-ADM-07, W-13: "read worker diagnostics").
 *
 * Fetched on demand rather than sent with the queue: a hundred jobs of two hundred lines each is a
 * page nobody asked to download, and the question "what happened to this one" is asked of one job.
 */
export function JobLog({ endpoint, testId }: { endpoint: string; testId: string }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<JobLogLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError(null);
    const response = await fetch(endpoint);
    if (!response.ok) {
      setError('the log could not be loaded');
      return;
    }
    const body = (await response.json()) as { log?: JobLogLine[] };
    setLines(body.log ?? []);
  };

  return (
    <>
      <button type="button" onClick={() => void toggle()} data-testid={`${testId}-toggle`}>
        {open ? 'Hide log' : 'Log'}
      </button>
      {open && (
        <div className="job-log" data-testid={testId}>
          {error && <small className="admin-error">{error}</small>}
          {lines === null && !error && <small className="auth-sub loading-inline"><LoadingSpinner compact />Loading…</small>}
          {lines?.length === 0 && <small className="auth-sub">No worker has logged anything for this job yet.</small>}
          {lines && lines.length > 0 && (
            <ol>
              {lines.map((line, index) => (
                <li key={index} className={`job-log-${line.level}`}>
                  <time>{new Date(line.at).toLocaleTimeString()}</time>
                  <span>{line.message}</span>
                  {line.fields && (
                    <code>
                      {Object.entries(line.fields)
                        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                        .join(' ')}
                    </code>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </>
  );
}
