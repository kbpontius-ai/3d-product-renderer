'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PackIssue } from '@pr/design-schema';

/**
 * Uploading a pack, in two steps.
 *
 * The first upload only looks: what the pack contains, what is wrong with it, which declared files
 * are missing. Nothing is written. Importing is a second, deliberate press — because a pack that
 * lands half-formed in the catalog is visible to customers before anyone notices.
 */

interface Preview {
  key: string | null;
  version: string | null;
  name: string | null;
  products: number;
  variants: number;
  zones: number;
  materials: number;
  issues: PackIssue[];
  missing: string[];
  unused: string[];
  publishable: boolean;
  /** This key and version already in the catalog, and its state; null when it is new. */
  existing: 'draft' | 'published' | 'deprecated' | null;
}

export function PackUpload() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'inspecting' | 'importing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const send = async (headers: Record<string, string>) => {
    if (!file) return null;
    const response = await fetch('/api/admin/packs', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', ...headers },
      body: file,
    });
    const body = (await response.json()) as {
      preview?: Preview;
      result?: { key: string; version: string; status: string };
      error?: { code?: string; detail?: string };
    };
    if (!response.ok) {
      setError(body.error?.detail ?? body.error?.code ?? 'that did not work');
      return null;
    }
    return body;
  };

  const inspect = async (chosen: File) => {
    setFile(chosen);
    setPreview(null);
    setDone(null);
    setError(null);
    setBusy('inspecting');
    try {
      const response = await fetch('/api/admin/packs', {
        method: 'POST',
        headers: { 'content-type': 'application/zip', 'x-dry-run': 'true' },
        body: chosen,
      });
      const body = (await response.json()) as { preview?: Preview; error?: { detail?: string } };
      if (!response.ok) {
        setError(body.error?.detail ?? 'that archive could not be read');
        return;
      }
      setPreview(body.preview ?? null);
    } finally {
      setBusy(null);
    }
  };

  const load = async (publish: boolean) => {
    setBusy('importing');
    setError(null);
    try {
      const body = await send(publish ? { 'x-publish': 'true' } : {});
      if (!body?.result) return;
      setDone(`${body.result.key}@${body.result.version}: ${body.result.status}`);
      setPreview(null);
      setFile(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    /*
      Pack ingestion, admin side (F-ADM-01 in part, F-GEN-02 in part).
      
      This accepts a pack that has already been built: a zip carrying manifest.json and its glTF and
      texture assets, inspected and reported on before anything is published. The other way in is
      `/admin/cad`, which builds one from the file a supplier actually sends.
    */
    <div className="admin-form" data-testid="pack-upload">
      <label>
        Pack archive (.zip containing manifest.json and its assets)
        <input
          type="file"
          accept=".zip,application/zip"
          data-testid="pack-file"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) void inspect(chosen);
          }}
        />
      </label>

      {busy === 'inspecting' && (
        <p className="auth-sub loading-inline">
          <LoadingSpinner compact />
          Reading the archive…
        </p>
      )}
      {error && (
        <p className="admin-error" data-testid="pack-error">
          {error}
        </p>
      )}
      {done && (
        <p className="admin-ok" data-testid="pack-done">
          {done}
        </p>
      )}

      {preview && (
        <div data-testid="pack-preview">
          <p>
            <strong>
              {preview.name} — {preview.key}@{preview.version}
            </strong>
            <br />
            {preview.products} product(s), {preview.variants} variant(s), {preview.zones} zone(s),{' '}
            {preview.materials} material(s).
          </p>
          {preview.existing === 'draft' && (
            <p className="auth-sub" data-testid="pack-existing">
              {preview.key}@{preview.version} is already here as a draft; importing replaces that
              draft.
            </p>
          )}
          {preview.existing && preview.existing !== 'draft' && (
            <p className="admin-error" data-testid="pack-existing">
              {preview.key}@{preview.version} is already {preview.existing}. If these contents
              differ, the import will be refused — designs are built on that version, so it is never
              rewritten. Give the pack a new version number.
            </p>
          )}

          {preview.missing.length > 0 && (
            <p className="admin-error" data-testid="pack-missing">
              Missing files: {preview.missing.join(', ')}
            </p>
          )}
          {preview.unused.length > 0 && (
            <p className="auth-sub" data-testid="pack-unused">
              Not referenced by the manifest: {preview.unused.join(', ')}
            </p>
          )}
          {preview.issues.length > 0 && (
            <ul className="admin-audit" data-testid="pack-issues">
              {preview.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <code className={issue.severity === 'error' ? 'admin-error' : ''}>
                    {issue.code}
                  </code>
                  <span>
                    {issue.path ? `${issue.path}: ` : ''}
                    {issue.message}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="admin-form-actions">
            <button
              type="button"
              disabled={!preview.publishable || busy !== null}
              onClick={() => void load(false)}
              data-testid="pack-import-draft"
            >
              <span className="loading-inline">
                {busy === 'importing' && <LoadingSpinner compact />}Import as draft
              </span>
            </button>
            <button
              type="button"
              disabled={!preview.publishable || busy !== null}
              onClick={() => void load(true)}
              data-testid="pack-import-publish"
            >
              <span className="loading-inline">
                {busy === 'importing' && <LoadingSpinner compact />}Import and publish
              </span>
            </button>
            {!preview.publishable && (
              <span className="admin-error">
                This pack cannot be imported until the errors above are fixed.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
