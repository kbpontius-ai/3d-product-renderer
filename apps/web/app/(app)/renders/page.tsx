import { redirect } from 'next/navigation';
import { RenderActions } from '@/components/render-actions';
import { listJobs } from '@pr/render-jobs';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured, getSql } from '@/lib/server/db';
import { assetUrl } from '@/lib/server/storage';
import { NotConfigured } from '../../(auth)/not-configured';

/** Every render this organisation has asked for, newest first (F-REND-07). */
export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Rendering',
  succeeded: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
};

export default async function RendersPage() {
  if (!databaseConfigured()) return <NotConfigured />;

  const principal = await getPrincipal();
  if (!principal) redirect('/signin?next=/renders');

  const jobs = await listJobs(getSql(), { orgId: principal.orgId, userId: principal.userId }, 50);
  const viewer = principal.userId ?? principal.orgId;

  return (
    <main className="catalog" data-testid="renders">
      <header className="catalog-head">
        <div>
          <h1>Renders</h1>
          <p className="auth-sub">
            Your latest {jobs.length} render{jobs.length === 1 ? '' : 's'}.
          </p>
        </div>
      </header>

      {jobs.length === 0 ? (
        <p className="auth-sub" data-testid="renders-empty">
          Nothing rendered yet. Open a design and press Render.
        </p>
      ) : (
        <ul className="render-grid">
          {jobs.map((job) => (
            <li key={job.id} data-testid={`render-${job.id}`} data-status={job.status}>
              <article>
                {job.outputs[0] ? (
                  <a href={assetUrl(job.outputs[0].storageKey, viewer)} download>
                    {/*
                      The web-sized copy in the tile, the original behind the link (F-EXP-01). A
                      gallery of 4K sixteen-bit PNGs is a page that costs a hundred megabytes to
                      look at; renders from before there were small copies fall back to the full
                      one rather than showing nothing.
                    */}
                    <img
                      src={assetUrl(job.outputs[0].webStorageKey ?? job.outputs[0].storageKey, viewer)}
                      alt="Rendered product"
                      loading="lazy"
                    />
                  </a>
                ) : (
                  <div className="render-placeholder">{STATUS_LABELS[job.status] ?? job.status}</div>
                )}

                <p className="catalog-meta">
                  {STATUS_LABELS[job.status] ?? job.status} ·{' '}
                  {new Date(job.queuedAt).toLocaleString()}
                </p>
                {job.error && <p className="issue error">{job.error.message}</p>}
                <div className="render-actions">
                  {job.outputs[0] && (
                    <a className="auth-link" href={assetUrl(job.outputs[0].storageKey, viewer)} download>
                      Download {job.outputs[0].width}px
                    </a>
                  )}
                  <RenderActions
                    jobId={job.id}
                    live={job.status === 'queued' || job.status === 'running'}
                  />
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
