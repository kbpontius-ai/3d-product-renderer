'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Crosshair, Eye, FlipHorizontal, RotateCw } from 'lucide-react';
import type {
  DecorationZoneDef,
  MaterialDefinition,
  OrientationFrame,
  Vec3,
} from '@pr/design-schema';
import {
  boundingSphere,
  flipFront,
  frameFromDirections,
  framePreset,
  IMPORTED_FRAME,
  turnUp,
  type ResolvedCamera,
} from '@pr/scene';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { useConfirm } from '@/components/confirm-dialog';
import { Viewport3D, type Viewport3DProps, type ZoneLayers } from '@/components/viewport-3d';
import { OrientationPlane } from './orientation-plane';

export const SETUP_STEPS = ['Import', 'Orientation', 'Decoration zones', 'Review'] as const;
const VIEWS = [
  { key: 'three-quarter', label: 'Three-quarter', azimuthDeg: 35, elevationDeg: 25 },
  { key: 'front', label: 'Front', azimuthDeg: 0, elevationDeg: 0 },
  { key: 'top', label: 'Top', azimuthDeg: 0, elevationDeg: 90 },
].map((v) => ({ ...v, radiusScale: 2.4, focalMm: 85, targetOffsetMm: [0, 0, 0] as Vec3 }));
const EMPTY_LAYERS: ZoneLayers = {
  height: null,
  ink: null,
  texelMm: { x: 1, y: 1 },
  heightRangeMm: 8,
  inkRoughness: 0.5,
  inkMetalness: 0,
  inkTint: 1,
  inkFromHeight: 0,
};

export interface OrientationWizardProps {
  title: string;
  breadcrumbs: { label: string; href?: string }[];
  scope: 'product' | 'design' | 'demo';
  initialFrame?: OrientationFrame;
  defaultFrame?: OrientationFrame;
  confirmed: boolean;
  initialStep?: number;
  meshUrl: string;
  bboxMm: [Vec3, Vec3];
  materials: Record<string, MaterialDefinition>;
  assignments: Viewport3DProps['assignments'];
  decoratedSlot: string;
  zone?: DecorationZoneDef;
  layers?: ZoneLayers;
  environmentKey?: string;
  exitHref: string;
  importSummary: ReactNode;
  zonesContent: ReactNode;
  reviewContent?: ReactNode;
  finalLabel: string;
  zonesDirty?: boolean;
  onConfirm: (frame: OrientationFrame) => Promise<void>;
  onFinish: (frame: OrientationFrame | undefined, useFront: boolean) => Promise<void>;
  onCancel?: () => void;
  onStepChange?: (step: number) => void;
}

class ViewerBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onFailure();
  }
  override render() {
    return this.state.failed ? (
      <div className="orientation-load-error">
        <p>The 3D model could not be loaded.</p>
        <button onClick={() => window.location.reload()}>Retry loading</button>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function OrientationWizard(props: OrientationWizardProps) {
  const start = props.initialFrame ?? IMPORTED_FRAME;
  const [frame, setFrame] = useState(start);
  const [savedFrame, setSavedFrame] = useState(start);
  const [confirmed, setConfirmed] = useState(props.confirmed);
  const [step, setStep] = useState(props.confirmed ? (props.initialStep ?? 1) : 1);
  const [showPlane, setShowPlane] = useState(true);
  const [picking, setPicking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modelFailed, setModelFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useFront, setUseFront] = useState(false);
  const [useDefault, setUseDefault] = useState(false);
  const sphere = useMemo(() => boundingSphere(props.bboxMm), [props.bboxMm]);
  const cameraFor = useCallback(
    (key: string, f: OrientationFrame) => {
      const view = VIEWS.find((v) => v.key === key) ?? VIEWS[0]!;
      const camera = framePreset(view, sphere, undefined, f);
      return camera;
    },
    [sphere],
  );
  const [camera, setCamera] = useState<ResolvedCamera>(() => cameraFor('three-quarter', start));
  const dirty = JSON.stringify(frame) !== JSON.stringify(savedFrame);
  const staged =
    props.scope !== 'product' && (JSON.stringify(frame) !== JSON.stringify(start) || useDefault);
  const guard = useUnsavedGuard(
    dirty || staged,
    'The proposed orientation has not been applied. Leave without it?',
  );
  const { confirm, dialog } = useConfirm();
  const ready = useCallback(() => setLoaded(true), []);
  const failed = useCallback(() => setModelFailed(true), []);
  const go = (value: number) => {
    setStep(value);
    props.onStepChange?.(value);
  };
  const candidate = (next: OrientationFrame) => {
    setFrame(next);
    setError(null);
    setUseDefault(false);
  };
  useEffect(() => {
    if (!picking) return;
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicking(false);
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [picking]);
  const placeholderZone = useMemo<DecorationZoneDef>(
    () => ({
      type: 'planar',
      key: 'orientation-preview',
      name: 'Orientation preview',
      frame: { originMm: sphere.centerMm, normal: [0, 0, 1], tangent: [1, 0, 0] },
      sizeMm: { width: 1, height: 1, safeMarginMm: 0 },
      constraints: {
        finishes: ['print'],
        maxDepthMm: 0.6,
        minStrokeMm: 0.25,
        maxCoverage: 1,
        wrapWarnDeg: 120,
      },
    }),
    [sphere],
  );
  const viewer = {
    meshUrl: props.meshUrl,
    bboxMm: props.bboxMm,
    materials: props.materials,
    assignments: props.assignments,
    decoratedSlot: props.decoratedSlot,
    zone: props.zone ?? placeholderZone,
    layers: props.layers ?? EMPTY_LAYERS,
    environmentKey: 'studio-detail-v1',
    background: { kind: 'studio' as const },
    orientation: frame,
    cameraPresets: VIEWS,
    presetKey: 'three-quarter',
    onPresetChange: (key: string) => setCamera(cameraFor(key, frame)),
    hideControls: true,
  };
  const save = async (next = frame) => {
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(next);
      setFrame(next);
      setSavedFrame(next);
      setConfirmed(true);
      go(2);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Orientation could not be saved. Retry.');
    } finally {
      setBusy(false);
    }
  };
  const exit = async () => {
    if (
      (dirty || staged) &&
      !(await confirm({
        title: 'Discard orientation changes?',
        body: ['Your saved product and artwork will stay unchanged.'],
        confirmLabel: 'Discard',
        cancelLabel: 'Stay',
        tone: 'danger',
      }))
    )
      return;
    if (props.onCancel) props.onCancel();
    else window.location.assign(props.exitHref);
  };
  return (
    <section className="product-setup" data-testid="orientation-wizard" data-step={step}>
      {guard}
      {dialog}
      <nav className="setup-breadcrumbs" aria-label="Page location">
        {props.breadcrumbs.map((crumb, i) => (
          <span key={i}>
            {i > 0 && <span className="setup-separator">/</span>}
            {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : crumb.label}
          </span>
        ))}
      </nav>
      <header className="setup-heading">
        <div>
          <h1>
            {props.scope === 'product' && !props.confirmed
              ? 'Set product orientation'
              : 'Reorient product'}
          </h1>
          <p>Define the front and upright direction for {props.title}.</p>
          <small>
            {props.scope === 'product'
              ? 'Default orientation for this product variant'
              : props.scope === 'demo'
                ? 'Preview only · nothing is saved'
                : 'Orientation for this design only'}
          </small>
        </div>
        <ol className="setup-progress">
          {SETUP_STEPS.map((label, i) => (
            <li key={label} className={i === step ? 'current' : i < step ? 'complete' : ''}>
              <button
                disabled={busy || (i > 1 && (!confirmed || dirty)) || (i !== 2 && props.zonesDirty)}
                onClick={() => go(i)}
                data-testid={`setup-step-${i}`}
                aria-current={step === i ? 'step' : undefined}
              >
                <span className="setup-dot">{i < step ? <Check size={16} /> : i + 1}</span>
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ol>
      </header>
      {error && (
        <p className="admin-error setup-error" role="alert" data-testid="orientation-error">
          {error}
        </p>
      )}
      {step === 0 ? (
        <div className="setup-summary">
          <h2>Imported product</h2>
          {props.importSummary}
          <p>The existing derived model is used. No file needs to be uploaded again.</p>
          <button className="primary" onClick={() => go(1)}>
            Continue to orientation
          </button>
        </div>
      ) : step === 2 ? (
        <div className="setup-summary">
          <h2>Decoration zones and material defaults</h2>
          {props.zonesContent}
        </div>
      ) : (
        <div className="orientation-layout">
          <div className="orientation-main">
            <ViewerBoundary key={props.meshUrl} onFailure={failed}>
              <Viewport3D
                {...viewer}
                customCamera={camera}
                onCameraChange={setCamera}
                onModelReady={ready}
                onSurfacePick={
                  picking
                    ? (normal) => {
                        try {
                          candidate(frameFromDirections(normal, frame.upSource));
                          setPicking(false);
                        } catch (reason) {
                          setPicking(false);
                          setError(
                            reason instanceof Error
                              ? `${reason.message} Turn the plane or use the current view, then select the surface again.`
                              : 'Adjust Up before aligning this surface.',
                          );
                        }
                      }
                    : undefined
                }
                sceneOverlay={
                  showPlane && !picking && step === 1 ? (
                    <OrientationPlane
                      frame={frame}
                      center={sphere.centerMm}
                      radius={sphere.radiusMm}
                      editable
                      onChange={candidate}
                    />
                  ) : undefined
                }
              />
            </ViewerBoundary>
            <div className="orientation-helper">
              {picking
                ? 'Select a surface to use as the front.'
                : step === 1
                  ? 'Drag the rings to orient the front plane.'
                  : 'Review the confirmed orientation.'}
              {picking && <button onClick={() => setPicking(false)}>Cancel selection</button>}
            </div>
            <div className="orientation-views">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  onClick={() => setCamera(cameraFor(v.key, frame))}
                  data-testid={`orientation-view-${v.key}`}
                >
                  {v.label}
                </button>
              ))}
              <button
                onClick={() => setCamera(cameraFor('three-quarter', frame))}
                data-testid="orientation-reset-view"
              >
                Reset view
              </button>
            </div>
          </div>
          <aside className="orientation-inspector">
            {step === 1 ? (
              <>
                <h2>Front plane</h2>
                <p>Front points out of the plane. Up sets the upright direction.</p>
                <button
                  className="primary"
                  disabled={!loaded || modelFailed || busy}
                  onClick={() => setPicking(true)}
                  data-testid="orientation-align"
                >
                  <Crosshair size={17} /> Align to selected surface
                </button>
                <button
                  disabled={!loaded || modelFailed || busy}
                  onClick={() => {
                    try {
                      candidate(
                        frameFromDirections(
                          camera.positionMm.map((n, i) => n - camera.targetMm[i]!) as Vec3,
                          camera.upMm,
                        ),
                      );
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : 'Choose another view.');
                    }
                  }}
                  data-testid="orientation-current-view"
                >
                  <Eye size={17} /> Use current view
                </button>
                <div className="orientation-control-pair">
                  <button
                    disabled={busy}
                    onClick={() => candidate(flipFront(frame))}
                    data-testid="orientation-flip"
                  >
                    <FlipHorizontal size={16} /> Flip front
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => candidate(turnUp(frame))}
                    data-testid="orientation-turn"
                  >
                    <RotateCw size={16} /> Turn up 90°
                  </button>
                </div>
                <button
                  className="orientation-text-action"
                  disabled={busy}
                  onClick={() => candidate(start)}
                >
                  Restore starting orientation
                </button>
                {props.scope === 'design' && (
                  <button
                    onClick={() => {
                      setFrame(props.defaultFrame ?? IMPORTED_FRAME);
                      setUseDefault(true);
                    }}
                    data-testid="orientation-use-default"
                  >
                    Use product default
                  </button>
                )}
              </>
            ) : (
              <>
                <h2>Review</h2>
                <p>
                  {props.scope === 'product'
                    ? 'Confirm this product configuration before publishing.'
                    : 'Artwork placement and physical dimensions stay unchanged.'}
                </p>
                {props.reviewContent}
                {props.scope !== 'product' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={useFront}
                      onChange={(e) => setUseFront(e.target.checked)}
                      data-testid="orientation-use-front"
                    />{' '}
                    Use new Front view
                  </label>
                )}
              </>
            )}
            <div className="orientation-preview-head">
              <h2>Preview</h2>
              {step === 1 && (
                <label>
                  <input
                    type="checkbox"
                    checked={showPlane}
                    onChange={(e) => setShowPlane(e.target.checked)}
                    data-testid="orientation-show-plane"
                  />{' '}
                  Show reference plane
                </label>
              )}
            </div>
            <small>{step === 3 ? 'Proposed Front view' : 'Front view'}</small>
            {props.scope === 'product' && (
              <small>Detail studio preview · design lighting is chosen in the editor.</small>
            )}
            <div className="orientation-front-preview" data-testid="orientation-front-preview">
              <ViewerBoundary onFailure={failed}>
                <Viewport3D
                  {...viewer}
                  lockedView
                  customCamera={cameraFor('front', frame)}
                  onCameraChange={() => undefined}
                />
              </ViewerBoundary>
            </div>
            {step === 3 &&
              props.scope !== 'product' &&
              JSON.stringify(frame) !== JSON.stringify(start) && (
                <>
                  <small>Starting Front view</small>
                  <div className="orientation-front-preview">
                    <ViewerBoundary onFailure={failed}>
                      <Viewport3D
                        {...viewer}
                        orientation={props.initialFrame}
                        lockedView
                        customCamera={cameraFor('front', start)}
                        onCameraChange={() => undefined}
                      />
                    </ViewerBoundary>
                  </div>
                </>
              )}
            <p className="orientation-note">
              {props.scope === 'product'
                ? 'Artwork placement is configured next.'
                : 'Your artwork stays on its existing surface.'}
            </p>
          </aside>
        </div>
      )}
      <footer className="setup-footer">
        <button
          onClick={() => (step > 0 ? go(step - 1) : void exit())}
          disabled={busy || props.zonesDirty}
        >
          <ArrowLeft size={16} /> Back
        </button>
        <button className="orientation-text-action" onClick={() => void exit()} disabled={busy}>
          Close setup
        </button>
        <div>
          {step === 1 && (
            <button
              disabled={!loaded || modelFailed || busy}
              onClick={() =>
                void confirm({
                  title: 'Keep imported axes?',
                  body: [
                    'Front will use the imported +Z direction and Up will use +Y. Geometry stays unchanged.',
                  ],
                  confirmLabel: 'Confirm imported orientation',
                }).then((ok) => {
                  if (ok) void save(IMPORTED_FRAME);
                })
              }
              data-testid="orientation-keep-imported"
            >
              Keep imported orientation
            </button>
          )}
          {step === 1 && (
            <button
              className="primary"
              disabled={!loaded || modelFailed || busy}
              onClick={() => void save()}
              data-testid="orientation-confirm"
            >
              <span className="loading-inline">{busy && <LoadingSpinner compact />}{busy ? 'Saving…' : 'Confirm & set zones'}</span>
            </button>
          )}
          {step === 2 && (
            <button
              className="primary"
              disabled={busy || props.zonesDirty}
              onClick={() => go(3)}
              data-testid="orientation-review"
            >
              Continue to review
            </button>
          )}
          {step === 3 && (
            <button
              className="primary"
              disabled={busy || !confirmed || dirty || modelFailed || !loaded}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await props.onFinish(useDefault ? undefined : frame, useFront);
                } catch (reason) {
                  setError(
                    reason instanceof Error ? reason.message : 'The change could not be applied.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
              data-testid="orientation-finish"
            >
              <span className="loading-inline">{busy && <LoadingSpinner compact />}{busy ? 'Applying…' : props.finalLabel}</span>
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
