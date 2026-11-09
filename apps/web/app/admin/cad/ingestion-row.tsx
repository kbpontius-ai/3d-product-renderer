'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DraftedPack } from '@pr/catalog';
import type { CadJob } from '@pr/cad-jobs';
import { JobLog } from '@/components/job-log';
// The subpath, not the barrel. `@pr/cad`'s index reaches the validator, which reads `node:crypto`
// to check a mesh digest — and webpack pulling that into a browser bundle is a build failure, not a
// warning. `reporting.ts` imports nothing but types, which is what makes it safe on this side.
import {
  AUDIENCE_SUMMARY,
  failureAudience,
  hasOpaqueMessage,
  issueAudience,
  operatorMessage,
  type FailureAudience,
} from '@pr/cad/reporting';

/**
 * One ingestion: what it was, what it turned into, and what to do with it next.
 *
 * A finished one offers to draft a pack, which is the only route from a supplier's file to the
 * catalog. What it asks for is exactly what geometry cannot answer for itself — what the product is
 * called and where it is filed — and nothing here supplies a default for those, because a pack that
 * named itself is a pack somebody published without reading.
 */
export function IngestionRow({
  job,
  drafts = [],
}: {
  job: CadJob;
  drafts?: readonly DraftedPack[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState<{ id: string; label: string } | null>(null);
  const [todos, setTodos] = useState<{ code: string; message: string }[]>([]);

  const [form, setForm] = useState({
    packKey: '',
    packName: '',
    productKey: '',
    productName: '',
    category: '',
    variantKey: '',
    variantName: '',
  });

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        error?: { detail?: string; code?: string };
        result?: { packId: string; key: string; version: string; status: string };
        todos?: { code: string; message: string }[];
      };
      if (!response.ok) {
        setError(payload.error?.detail ?? payload.error?.code ?? 'that did not work');
        return null;
      }
      return payload;
    } finally {
      setBusy(false);
    }
  };

  const draft = async () => {
    const payload = await post(`/api/admin/cad/${job.id}/pack`, form);
    if (!payload?.result) return;
    setDrafted({
      id: payload.result.packId,
      label: `${payload.result.key}@${payload.result.version}`,
    });
    setTodos(payload.todos ?? []);
    setDrafting(false);
    router.refresh();
  };

  const result = job.result;
  const dimensions = result ? size(result.bboxMm) : null;

  return (
    <>
      <tr data-testid={`cad-${job.id}`} data-status={job.status}>
        <td>
          <strong>{job.sourceName ?? 'unnamed'}</strong>
          <small>{job.profile} profile</small>
          {error && <small className="admin-error">{error}</small>}
        </td>
        <td>
          <small>{job.format.toUpperCase()}</small>
        </td>
        <td>
          <small>{megabytes(job.sourceBytes)}</small>
        </td>
        <td>
          {result ? (
            <small data-testid={`cad-${job.id}-result`}>
              {dimensions} · {result.parts.length} part(s) ·{' '}
              {result.meshes.reduce((sum, mesh) => sum + mesh.triangles, 0).toLocaleString()}{' '}
              triangles
              {result.repairs.length > 0 && <> · {result.repairs.length} repair(s)</>}
            </small>
          ) : job.error ? (
            <IngestionFailure jobId={job.id} error={job.error} />
          ) : (
            <small className="auth-sub">—</small>
          )}
        </td>
        <td>
          <span data-testid={`cad-${job.id}-status`}>{job.status}</span>
          {job.status === 'running' && (
            <small>
              {Math.round(job.progress * 100)}% · {job.stage}
            </small>
          )}
        </td>
        <td>
          {(job.status === 'queued' || job.status === 'running') && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void post(`/api/admin/cad/${job.id}`, { action: 'cancel' }).then(() =>
                  router.refresh(),
                )
              }
              data-testid={`cad-${job.id}-cancel`}
            >
              Cancel
            </button>
          )}
          <JobLog endpoint={`/api/admin/cad/${job.id}`} testId={`cad-${job.id}-log`} />
          {/* The packs already drafted from this file, straight to where they are finished: without
              this, a drafted pack was a line of text and the next step was a hunt through Packs. */}
          {drafts.length > 0 && !drafted && (
            <small className="cad-drafts" data-testid={`cad-${job.id}-drafts`}>
              Drafted:{' '}
              {drafts.map((pack, index) => (
                <span key={pack.id}>
                  {index > 0 && ', '}
                  <a className="auth-link" href={`/admin/packs/${pack.id}/setup`}>
                    {pack.key}@{pack.version}
                  </a>{' '}
                  ({pack.status})
                </span>
              ))}
            </small>
          )}
          {job.status === 'succeeded' && !drafted && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDrafting(!drafting)}
              data-testid={`cad-${job.id}-draft`}
            >
              {drafting ? 'Close' : drafts.length > 0 ? 'Draft another pack' : 'Draft a pack'}
            </button>
          )}
          {drafted && (
            <small className="admin-ok">
              {drafted.label} drafted ·{' '}
              <a
                className="auth-link"
                href={`/admin/packs/${drafted.id}/setup`}
                data-testid={`cad-${job.id}-zones`}
              >
                Continue setup
              </a>
            </small>
          )}
        </td>
      </tr>

      {drafting && (
        <tr>
          <td colSpan={6}>
            <div className="admin-form" data-testid={`cad-${job.id}-draft-form`}>
              <p className="auth-sub">
                Geometry cannot name a product or say where it belongs in a catalog. The pack is
                created as a draft with no zones; the zone authoring step finishes it.
              </p>
              {FIELDS.map((field) => (
                <label key={field.name}>
                  {field.label}
                  <input
                    value={form[field.name]}
                    placeholder={field.placeholder}
                    data-testid={`cad-draft-${field.name}`}
                    onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
                  />
                </label>
              ))}
              <div className="admin-form-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void draft()}
                  data-testid={`cad-${job.id}-draft-go`}
                >
                  Create draft pack
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}

      {todos.length > 0 && (
        <tr>
          <td colSpan={6}>
            <ul className="admin-audit" data-testid={`cad-${job.id}-todos`}>
              {todos.map((todo) => (
                <li key={todo.code}>
                  <code>{todo.code}</code>
                  <span>{todo.message}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Why an ingestion failed, in a form somebody can act on.
 *
 * Three things this does that printing `error.message` did not. It leads with a sentence written
 * for a person rather than whatever the importer threw — a real operator once met
 * `TypeError: GetReferredShape_s(): incompatible function arguments` here, and a one-line binding
 * bug read as a broken product. It shows every finding rather than the first, because each one
 * hidden is another re-export and another wait to discover it. And it sorts them by who can fix
 * them, since "re-export the file" and "somebody decides whether to raise a limit" are not the
 * same next step and do not belong in one undifferentiated list.
 */
function IngestionFailure({
  jobId,
  error,
}: {
  jobId: string;
  error: NonNullable<CadJob['error']>;
}) {
  const findings = error.findings ?? [];
  const audiences = findings.length
    ? ([...new Set(findings.map((finding) => issueAudience(finding.code)))] as FailureAudience[])
    : [failureAudience(error.code)];

  return (
    <div className="ingestion-failure" data-testid={`cad-${jobId}-failure`}>
      <small className="admin-error">{operatorMessage(error)}</small>

      {audiences.map((audience) => (
        <div key={audience} data-testid={`cad-${jobId}-audience-${audience}`}>
          {findings
            .filter((finding) => issueAudience(finding.code) === audience)
            .map((finding, index) => (
              <small
                key={`${finding.code}-${finding.subject ?? index}`}
                className="ingestion-finding"
              >
                {finding.message}
              </small>
            ))}
          <small className="auth-sub">{AUDIENCE_SUMMARY[audience]}</small>
        </div>
      ))}

      {hasOpaqueMessage(error.code) && (
        <details>
          {/* Everyone reading this page is staff, so the detail is not withheld — only demoted.
              It is what gets pasted into a bug report, and it is not what to lead with. */}
          <summary>Technical detail</summary>
          <code>
            {error.code}: {error.message}
          </code>
        </details>
      )}
    </div>
  );
}

const FIELDS = [
  { name: 'packKey', label: 'Pack key', placeholder: 'northfield-closures' },
  { name: 'packName', label: 'Pack name', placeholder: 'Northfield closures' },
  { name: 'productKey', label: 'Product key', placeholder: 'cap-flat' },
  { name: 'productName', label: 'Product name', placeholder: 'Flat-top closure' },
  { name: 'category', label: 'Category', placeholder: 'closures' },
  { name: 'variantKey', label: 'Variant key', placeholder: '38mm' },
  { name: 'variantName', label: 'Variant name (optional)', placeholder: '38 mm' },
] as const satisfies readonly { name: keyof DraftForm; label: string; placeholder: string }[];

interface DraftForm {
  packKey: string;
  packName: string;
  productKey: string;
  productName: string;
  category: string;
  variantKey: string;
  variantName: string;
}

const megabytes = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} kB`;

/** The dimension a person actually quotes, rather than two corners of a box. */
const size = ([min, max]: readonly [
  readonly [number, number, number],
  readonly [number, number, number],
]): string =>
  [0, 1, 2].map((axis) => Math.round((max[axis]! - min[axis]!) * 10) / 10).join(' × ') + ' mm';
