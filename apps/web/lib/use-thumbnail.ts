'use client';

import { useCallback, useRef } from 'react';

const MIN_INTERVAL_MS = 45_000;
const WIDTH = 480;

export function useDesignThumbnail(designId: string | null) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastAt = useRef(0);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const leaving = useRef(false);
  const nextFrame = useRef<(() => void) | null>(null);

  const upload = useCallback(async (canvas: HTMLCanvasElement): Promise<boolean> => {
    if (!designId || !canvas.isConnected || canvas.width === 0 || canvas.height === 0) return false;

    try {
      const scaled = document.createElement('canvas');
      scaled.width = WIDTH;
      scaled.height = Math.max(1, Math.round(WIDTH * canvas.height / canvas.width));
      const context = scaled.getContext('2d');
      if (!context) return false;
      context.drawImage(canvas, 0, 0, scaled.width, scaled.height);
      const blob = await new Promise<Blob | null>((resolve) => scaled.toBlob(resolve, 'image/png'));
      if (!blob) return false;

      const response = await fetch(`/api/designs/${designId}/thumbnail`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: blob,
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) lastAt.current = Date.now();
      return response.ok;
    } catch {
      return false;
    }
  }, [designId]);

  const onFrame = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (!canvas) return;
    nextFrame.current?.();
    nextFrame.current = null;
    if (!designId || leaving.current || inFlight.current) return;
    if (Date.now() - lastAt.current < MIN_INTERVAL_MS) return;
    const request = upload(canvas);
    inFlight.current = request;
    void request.finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
  }, [designId, upload]);

  const captureNow = useCallback(async (): Promise<boolean> => {
    leaving.current = true;
    try {
      // An older background upload must finish before it can overwrite the exit screenshot.
      await inFlight.current;
      if (!canvasRef.current?.isConnected) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            nextFrame.current = null;
            resolve();
          }, 5000);
          nextFrame.current = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      // React's updated scene must have reached the drawing buffer before GPU readback.
      await new Promise<void>((resolve) => {
        let frame = 0;
        const finish = () => {
          clearTimeout(timer);
          cancelAnimationFrame(frame);
          resolve();
        };
        // Browsers pause animation frames if the tab is hidden during navigation.
        const timer = setTimeout(finish, 1000);
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
      });
      const canvas = canvasRef.current;
      if (!canvas) return false;
      return await upload(canvas);
    } finally {
      leaving.current = false;
    }
  }, [upload]);

  return { onFrame, captureNow };
}
