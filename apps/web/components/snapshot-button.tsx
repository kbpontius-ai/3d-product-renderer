'use client';

import { Camera } from 'lucide-react';
import { useState, type RefObject } from 'react';
import { snapshotFilename } from '@/lib/snapshot-filename';

export function SnapshotButton({
  canvas,
  name,
  disabled,
  placeMode,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  name: string;
  disabled: boolean;
  placeMode: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capture = async () => {
    if (busy || disabled) return;
    setError(null);
    const source = canvas.current;
    if (!source?.isConnected || !source.width || !source.height) {
      setError('The viewer is still loading. Try Snapshot again when the product appears.');
      return;
    }
    setBusy(true);
    const filename = snapshotFilename(name, new Date());
    try {
      // toBlob snapshots the buffer when called, before asynchronous encoding or later viewer edits.
      const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG encoding failed');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        // Revoking in the same task can race the browser starting its download.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      setError('Could not capture the viewer. Please try Snapshot again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="snapshot-action">
      <button
        type="button"
        className="snapshot-button"
        disabled={disabled || busy}
        title={placeMode ? 'Switch to Viewer or Split to take a snapshot' : 'Download the current viewer as a PNG'}
        onClick={() => void capture()}
        data-testid="snapshot-button"
      >
        <Camera size={16} strokeWidth={1.75} aria-hidden="true" />
        {busy ? 'Capturing…' : 'Snapshot'}
      </button>
      {error && !placeMode && (
        <p className="snapshot-error" data-testid="snapshot-error">{error}</p>
      )}
    </div>
  );
}
