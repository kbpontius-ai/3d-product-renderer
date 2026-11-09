'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Uploading a CAD file.
 *
 * One press, unlike a pack upload: there is nothing to preview, because reading the file is the
 * expensive part and it happens on a worker rather than in the request. What the server does
 * synchronously is decide what the file *is* — by content, never by its name — and refuse it if it
 * is not something an importer reads, which is fast and is the part worth telling somebody about
 * immediately.
 */

interface Queued {
  job: { id: string; sourceName: string | null; format: string; profile: string };
  deduped: boolean;
  sniffed: { format: string; label: string | null; extensionMismatch: boolean };
}

/**
 * The extension list arrives as a prop rather than an import.
 *
 * `@pr/cad`'s entry point reaches node:fs — it carries an importer that writes files — and pulling
 * that into a client bundle is not something a file picker's `accept` attribute is worth. The
 * server page owns the list; this only narrows the dialog, and the sniffer is what decides.
 */
export function CadUpload({ accept }: { accept: readonly string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<Queued | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setQueued(null);
    try {
      const response = await fetch('/api/admin/cad', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': file.name },
        body: file,
      });
      const body = (await response.json()) as Queued & { error?: { code?: string; detail?: string } };
      if (!response.ok) {
        setError(body.error?.detail ?? body.error?.code ?? 'that file could not be queued');
        return;
      }
      setQueued(body);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-form" data-testid="cad-upload">
      <label>
        CAD file (STEP today; the format is decided by reading the file, not its name)
        <input
          type="file"
          accept={accept.join(',')}
          data-testid="cad-file"
          disabled={busy}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) void upload(chosen);
          }}
        />
      </label>

      {busy && <p className="auth-sub loading-inline"><LoadingSpinner compact />Uploading…</p>}
      {error && (
        <p className="admin-error" data-testid="cad-error">
          {error}
        </p>
      )}
      {queued && (
        <div data-testid="cad-queued">
          <p className="admin-ok">
            {queued.deduped
              ? `Already ingested at this pipeline version — showing the existing job.`
              : `Queued as ${queued.sniffed.label ?? queued.sniffed.format}, ${queued.job.profile} profile.`}
          </p>
          {queued.sniffed.extensionMismatch && (
            <p className="auth-sub" data-testid="cad-mismatch">
              Worth knowing: this file is {queued.sniffed.label}, which is not what its extension says. The
              content is what was used.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
