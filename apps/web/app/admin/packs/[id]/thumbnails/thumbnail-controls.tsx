'use client';

import { LoadingSpinner } from '@/components/loading-spinner';
import { Component, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { ThumbnailVariant } from '@pr/catalog';
import type { MaterialDefinition, DecorationZoneDef, OrientationFrame } from '@pr/design-schema';
import type { ResolvedCamera } from '@pr/scene';
import type { ZoneLayers } from '@/components/viewport-3d';
const Viewport3D = dynamic(
  () => import('@/components/viewport-3d').then((module) => module.Viewport3D),
  { ssr: false },
);
export type CaptureVariant = Omit<ThumbnailVariant, 'thumbnailKey' | 'meshKey'> & {
  meshUrl: string | null;
  thumbnailUrl: string | null;
  orientation?: OrientationFrame;
};
// The shared viewport's relief inputs are inert in product-only mode, including packs with no zones.
const INERT_ZONE: DecorationZoneDef = {
  type: 'planar',
  key: 'catalog-preview',
  name: 'Catalog preview',
  frame: { originMm: [0, 0, 0], normal: [0, 1, 0], tangent: [1, 0, 0] },
  sizeMm: { width: 1, height: 1, safeMarginMm: 0 },
  constraints: {
    finishes: ['print'],
    maxDepthMm: 0.6,
    minStrokeMm: 0.25,
    maxCoverage: 0.9,
    wrapWarnDeg: 120,
  },
};
const EMPTY_LAYERS: ZoneLayers = {
  height: null,
  ink: null,
  texelMm: { x: 1, y: 1 },
  heightRangeMm: 0,
  inkRoughness: 0.4,
  inkMetalness: 0,
  inkTint: 0,
  inkFromHeight: 0,
};
class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p className="admin-error">
        This product could not load in the viewer. Check its mesh and browser graphics support, then
        reopen the preview.
      </p>
    ) : (
      this.props.children
    );
  }
}
function CaptureViewer({
  variant,
  materials,
  onSave,
}: {
  variant: CaptureVariant;
  materials: Record<string, MaterialDefinition>;
  onSave: (png: Blob) => Promise<void>;
}) {
  const [preset, setPreset] = useState(
    variant.cameraPresets.find((p) => p.key === 'three-quarter')?.key ??
      variant.cameraPresets[0]?.key ??
      '',
  );
  const [camera, setCamera] = useState<ResolvedCamera | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLCanvasElement | null>(null);
  const captureFrame = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    frame.current ??= document.createElement('canvas');
    const copy = frame.current;
    if (copy.width !== 768 || copy.height !== 576) {
      copy.width = 768;
      copy.height = 576;
    }
    const context = copy.getContext('2d');
    if (!context) return;
    context.drawImage(canvas, 0, 0, 768, 576);
    setReady(true);
  }, []);
  const save = async () => {
    if (!frame.current) return;
    setBusy(true);
    setError(null);
    try {
      const png = await new Promise<Blob>((resolve, reject) =>
        frame.current!.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Could not capture this frame.'))),
          'image/png',
        ),
      );
      await onSave(png);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save this preview.');
    } finally {
      setBusy(false);
    }
  };
  const assignments = useMemo(
    () =>
      Object.fromEntries(
        variant.materialSlots.map((slot) => [
          slot.key,
          {
            materialKey: slot.defaultMaterialKey,
            colorHex: materials[slot.defaultMaterialKey]?.base.baseColorHex ?? '#cccccc',
            textureScale: 1,
            textureRotationDeg: 0,
          },
        ]),
      ),
    [variant.materialSlots, materials],
  );
  const decoratedSlot = variant.materialSlots[0]?.key;
  if (!variant.meshUrl || !preset || !decoratedSlot || Object.keys(materials).length === 0)
    return (
      <p className="admin-error">
        This product needs a mesh, material and camera preset before a preview can be captured.
      </p>
    );
  return (
    <>
      <p className="auth-sub">
        Choose a view, or drag to rotate and scroll to zoom. Capture saves only the product image.
      </p>
      <div className="catalog-capture">
        <ViewerBoundary>
          <Viewport3D
            productOnly
            orientation={variant.orientation}
            meshUrl={variant.meshUrl}
            bboxMm={variant.bboxMm}
            zone={INERT_ZONE}
            layers={EMPTY_LAYERS}
            materials={materials}
            assignments={assignments}
            decoratedSlot={decoratedSlot}
            cameraPresets={variant.cameraPresets}
            presetKey={preset}
            onPresetChange={(key) => {
              setReady(false);
              setPreset(key);
              setCamera(null);
            }}
            customCamera={camera}
            onCameraChange={(next) => {
              setReady(false);
              setCamera(next);
            }}
            environmentKey="studio-softbox"
            background={{ kind: 'solid', colorHex: '#f6f5f3' }}
            onFrame={captureFrame}
          />
        </ViewerBoundary>
      </div>
      <button
        type="button"
        className="btn primary"
        disabled={!ready || busy}
        onClick={() => void save()}
      >
        <span className="loading-inline">{(busy || !ready) && <LoadingSpinner compact />}{busy ? 'Saving…' : ready ? 'Capture preview' : 'Loading product…'}</span>
      </button>
      {error && <p className="admin-error">{error}</p>}
    </>
  );
}
export function ThumbnailControls({
  packId,
  initial,
  materials,
}: {
  packId: string;
  initial: CaptureVariant[];
  materials: Record<string, MaterialDefinition>;
}) {
  const [variants, setVariants] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const active = variants.find((v) => v.id === selected);
  const save = async (png: Blob) => {
    if (!active) return;
    setSaving(true);
    try {
      const response = await fetch(
        `/api/admin/packs/${packId}/thumbnails?variantId=${encodeURIComponent(active.id)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'image/png' },
          body: png,
        },
      );
      const payload = (await response.json()) as {
        thumbnailUrl?: string;
        error?: { detail?: string };
      };
      if (!response.ok || !payload.thumbnailUrl)
        throw new Error(payload.error?.detail ?? 'Could not save this preview.');
      setVariants((current) =>
        current.map((v) =>
          v.id === active.id ? { ...v, thumbnailUrl: payload.thumbnailUrl! } : v,
        ),
      );
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <ul className="catalog-grid">
        {variants.map((variant) => (
          <li key={variant.id}>
            <article>
              <h2>{variant.productName}</h2>
              <p className="auth-sub">{variant.name}</p>
              {variant.thumbnailUrl ? (
                <img
                  className="product-thumb"
                  src={variant.thumbnailUrl}
                  alt={variant.productName}
                />
              ) : (
                <span className="product-thumb empty">Preview not available</span>
              )}
              <button
                type="button"
                className="btn"
                disabled={saving}
                data-testid={`capture-${variant.id}`}
                onClick={() => {
                  setSelected(variant.id);
                  setSaved(false);
                }}
              >
                {variant.thumbnailUrl ? 'Regenerate preview' : 'Generate preview'}
              </button>
            </article>
          </li>
        ))}
      </ul>
      {active && (
        <section className="catalog-capture-panel">
          <h2>
            {active.productName} — {active.name}
          </h2>
          <CaptureViewer key={active.id} variant={active} materials={materials} onSave={save} />
          {saved && (
            <p className="pill ok" data-testid="preview-saved">
              Preview saved
            </p>
          )}
          <button type="button" className="btn" disabled={saving} onClick={() => setSelected(null)}>
            Close preview
          </button>
        </section>
      )}
    </>
  );
}
