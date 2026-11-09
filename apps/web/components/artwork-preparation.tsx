'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  analyzeArtworkSource,
  compatiblePreparationJoin,
  preparationSourceSvg,
  preparationSubpaths,
  type ArtworkAnalysis,
  type BBox,
  type PreparationObject,
  type PreparationPreview,
} from '@pr/svg';
import { previewArtworkPreparation } from '@pr/raster';
import type {
  ArtworkEndpoint,
  ArtworkPreparationRecipe,
  ArtworkPreparationRequest,
  ArtworkRepair,
} from '@pr/design-schema';
import type { StoredArtwork } from '@/lib/editor-data';
import { artworkRequest, ArtworkRequestError } from '@/lib/artwork-api';
import {
  currentPreparationPreview,
  initialPreparationState,
  preparationReducer,
} from '@/lib/artwork-preparation-state';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { useConfirm } from './confirm-dialog';
import { PreparationCanvas, svgImage } from './artwork-preparation-canvas';

export interface PreparationEntry {
  source?: string;
  name?: string;
  artworkId?: string;
  versionId?: string;
}
interface AnalysisResponse {
  analysis: ArtworkAnalysis;
  recipe: ArtworkPreparationRecipe;
  name: string;
  preview: PreparationPreview | null;
  originalSource?: string;
}
interface Props {
  entry: PreparationEntry;
  persist: boolean;
  onCancel: () => void;
  onSaved: (artwork: StoredArtwork) => void;
  onPrepared?: (svg: string, name: string) => Promise<void>;
}

export function ArtworkPreparation(props: Props) {
  const [loaded, setLoaded] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const load = async () => {
      if (props.persist) {
        const result = await artworkRequest<AnalysisResponse>('/api/artworks/preparation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(props.entry),
          signal: controller.signal,
        });
        let originalSource = props.entry.source;
        if (!originalSource && props.entry.artworkId) {
          const response = await fetch(
            `/api/artworks/${props.entry.artworkId}/original?versionId=${props.entry.versionId}`,
            { signal: controller.signal },
          );
          if (!response.ok)
            throw new Error('The artwork changed while opening it. Reopen its current version.');
          originalSource = await response.text();
        }
        // Keep the authorized original in memory so a concurrent update cannot prevent saving a copy.
        return { ...result, originalSource };
      }
      const analysis = await analyzeArtworkSource(props.entry.source ?? '');
      return {
        analysis,
        name: props.entry.name ?? 'Artwork',
        recipe: {
          sourceDigest: analysis.sourceDigest,
          analyzerVersion: analysis.analyzerVersion,
          selected: [],
          repairs: [],
          acknowledged: [],
          transforms: [],
        },
        preview: null,
      };
    };
    void load()
      .then((result) => {
        if (!controller.signal.aborted) setLoaded(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Analysis failed.');
      });
    return () => controller.abort();
  }, [props.entry, props.persist, attempt]);
  if (loaded) return <PreparationWorkspace {...props} loaded={loaded} />;
  return (
    <section className="preparation-loading" data-testid="artwork-preparation">
      <h1>Prepare artwork</h1>
      {error ? (
        <>
          <p className="issue error" data-testid="preparation-error">
            {error}
          </p>
          <p>
            Export static outlined vectors with solid opaque paint. Unsaved choices are kept only in
            this tab.
          </p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry analysis
          </button>
        </>
      ) : (
        <p className="loading-inline"><LoadingSpinner compact />Analyzing SVG…</p>
      )}
      <button type="button" onClick={props.onCancel}>
        Back to artwork
      </button>
    </section>
  );
}

function GroupCheck({
  label,
  count,
  total,
  disabled,
  onChange,
}: {
  label: string;
  count: number;
  total: number;
  disabled: boolean;
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = count > 0 && count < total;
  }, [count, total]);
  return (
    <label className="preparation-group">
      <input
        ref={input}
        type="checkbox"
        checked={total > 0 && count === total}
        disabled={disabled}
        onChange={onChange}
      />
      {label}{' '}
      <small>
        {count}/{total}
      </small>
    </label>
  );
}

const outlineLabel = (object: PreparationObject | undefined, id: string) => {
  const index = object ? preparationSubpaths(object).findIndex((path) => path.id === id) : -1;
  return index < 0 ? 'Outline' : `Outline ${index + 1}`;
};

function PreparationWorkspace({
  loaded,
  entry,
  persist,
  onCancel,
  onSaved,
  onPrepared,
}: Props & { loaded: AnalysisResponse }) {
  const { analysis } = loaded;
  const [state, dispatch] = useReducer(
    preparationReducer,
    { name: loaded.name, recipe: loaded.recipe },
    initialPreparationState,
  );
  const [step, setStep] = useState<'select' | 'review' | 'confirm'>('select');
  const [focused, setFocused] = useState<string | null>(null);
  const [subpathId, setSubpathId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [frame, setFrame] = useState<{ bounds: BBox; revision: number } | null>(null);
  const [repairTool, setRepairTool] = useState<'inspect' | 'close' | 'join' | 'width'>('inspect');
  const [endpointCandidates, setEndpointCandidates] = useState<ArtworkEndpoint[]>([]);
  const [joinA, setJoinA] = useState<ArtworkEndpoint | null>(null);
  const [joinB, setJoinB] = useState<ArtworkEndpoint | null>(null);
  const [widthMm, setWidthMm] = useState(1);
  const [acceptedRepair, setAcceptedRepair] = useState(false);
  const [originalView, setOriginalView] = useState(false);
  const [backing, setBacking] = useState('checker');
  const [ink, setInk] = useState('black');
  const [mobileTab, setMobileTab] = useState('source');
  const [objectsExpanded, setObjectsExpanded] = useState(true);
  const [color, setColor] = useState<string | null>(null);
  const [shadeTolerance, setShadeTolerance] = useState(0);
  const [saving, setSaving] = useState(false);
  const [archiveBlocked, setArchiveBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { confirm, dialog } = useConfirm();
  const leaveDialog = useUnsavedGuard(
    true,
    'Unsaved artwork preparation is kept only in this tab and will be lost.',
  );
  const recipe = state.present.recipe;
  const result = currentPreparationPreview(state);
  const repairing = state.mode === 'repair';
  const selected = useMemo(
    () => new Set(recipe.selected.map((item) => item.objectId)),
    [recipe.selected],
  );
  const objects = result?.objects ?? analysis.objects;
  const object = objects.find((item) => item.id === focused);
  const openPaths = objects
    .filter((item) => selected.has(item.id))
    .flatMap((item) =>
      preparationSubpaths(item)
        .filter((path) => !path.closed)
        .map((path) => ({ object: item, path })),
    );
  const path = object && preparationSubpaths(object).find((item) => item.id === subpathId);
  const pending = state.pendingRepair;
  const shown = pending?.result ?? result;
  const issues = result?.issues ?? analysis.issues;
  const reviews = issues.filter((issue) => issue.severity === 'review');
  const current = Boolean(result);

  useEffect(() => {
    const controller = new AbortController();
    const revision = state.revision;
    const operation = state.pendingRepair?.operation;
    const previewRecipe = operation
      ? { ...recipe, repairs: [...recipe.repairs, operation] }
      : recipe;
    const timer = setTimeout(() => {
      setError(null);
      const calculate = async () => {
        if (persist) {
          const response = await artworkRequest<AnalysisResponse>('/api/artworks/preparation', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              ...entry,
              name: state.present.name,
              recipe: previewRecipe,
            } satisfies ArtworkPreparationRequest),
          });
          if (!response.preview) throw new Error('The server did not return a prepared preview.');
          return response.preview;
        }
        return previewArtworkPreparation(analysis, previewRecipe);
      };
      void calculate()
        .then((preview) => {
          if (controller.signal.aborted) return;
          dispatch(
            operation
              ? { type: 'repair-preview', operation, revision, result: preview }
              : { type: 'preview', revision, result: preview },
          );
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setError(error instanceof Error ? error.message : 'Preview failed.');
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    analysis,
    entry,
    persist,
    recipe,
    state.revision,
    state.present.name,
    state.pendingRepair?.operation,
    attempt,
  ]);

  const edit = (patch: Partial<ArtworkPreparationRecipe>, name = state.present.name) => {
    setError(null);
    setStep('select');
    setColor(null);
    dispatch({ type: 'edit', draft: { name, recipe: { ...recipe, ...patch } } });
  };
  const frameBounds = (bounds: BBox | null) => {
    if (bounds) setFrame((previous) => ({ bounds, revision: (previous?.revision ?? 0) + 1 }));
  };
  const focus = (id: string) => {
    setFocused(id);
    setCandidates([]);
    const item = objects.find((object) => object.id === id);
    const open = item && preparationSubpaths(item).find((path) => !path.closed);
    setSubpathId(open?.id ?? null);
    frameBounds(item?.bounds ?? null);
  };
  const toggle = (ids: string[]) => {
    if (repairing || saving) return;
    const allKept = ids.every((id) => selected.has(id));
    const retained = recipe.selected.filter((item) => !ids.includes(item.objectId));
    edit({
      selected: allKept
        ? retained
        : [...retained, ...ids.map((objectId) => ({ objectId, paint: 'both' as const }))],
    });
  };
  const cancel = async () => {
    if (saving) return;
    if (
      await confirm({
        title: 'Discard artwork preparation?',
        body: ['No artwork has been saved. Unsaved choices cannot be recovered after leaving.'],
        confirmLabel: 'Discard preparation',
        cancelLabel: 'Keep preparing',
        tone: 'danger',
      })
    )
      onCancel();
  };
  const enterRepair = (target?: { objectId: string; subpathId?: string }) => {
    setRepairTool('inspect');
    setJoinA(null);
    setJoinB(null);
    setAcceptedRepair(false);
    dispatch({ type: 'enter-repair' });
    if (target) {
      setFocused(target.objectId);
      setSubpathId(target.subpathId ?? null);
      frameBounds(objects.find((item) => item.id === target.objectId)?.bounds ?? null);
    } else if (!object || !selected.has(object.id)) {
      const first =
        openPaths[0] ??
        objects
          .filter((item) => selected.has(item.id))
          .map((item) => ({ object: item, path: null }))[0];
      if (first) {
        setFocused(first.object.id);
        setSubpathId(first.path?.id ?? null);
      }
    }
  };
  const leaveRepair = async () => {
    if (
      pending &&
      !(await confirm({
        title: 'Discard repair preview and return?',
        body: ['Applied repairs remain in the draft. This preview has not been applied.'],
        confirmLabel: 'Discard preview and return',
        cancelLabel: 'Stay in repair mode',
      }))
    )
      return;
    dispatch({ type: 'discard-preview' });
    dispatch({ type: 'leave-repair' });
    setRepairTool('inspect');
  };
  const chooseOperation = (operation: ArtworkRepair) => {
    setAcceptedRepair(false);
    setOriginalView(false);
    setError(null);
    dispatch({ type: 'choose-repair', operation });
  };
  const endpoint = (end: ArtworkEndpoint) => {
    if (!repairing || !selected.has(end.objectId)) return;
    if (repairTool === 'join') {
      if (!joinA) setJoinA(end);
      else setJoinB(end);
      dispatch({ type: 'discard-preview' });
      setAcceptedRepair(false);
    } else {
      setFocused(end.objectId);
      setSubpathId(end.subpathId);
    }
  };
  const setTool = (tool: typeof repairTool) => {
    setRepairTool(tool);
    setJoinA(null);
    setJoinB(null);
    setAcceptedRepair(false);
    dispatch({ type: 'discard-preview' });
  };
  const resize = (axis: 'widthMm' | 'heightMm', value: number) => {
    if (!result?.boundsMm || !Number.isFinite(value) || value < 0.01 || value > 1000) return;
    edit({
      transforms: [
        ...recipe.transforms,
        {
          widthMm: result.boundsMm.w,
          heightMm: result.boundsMm.h,
          [axis]: value,
          rotationDeg: 0,
          flipX: false,
          flipY: false,
        },
      ],
    });
  };
  const save = async (asCopy = false) => {
    if (!result?.canSave || !current || !state.present.name.trim() || saving || repairing) return;
    setSaving(true);
    setError(null);
    setArchiveBlocked(false);
    try {
      if (persist) {
        let sourceEntry = entry;
        if (asCopy && entry.artworkId) {
          if (!loaded.originalSource)
            throw new Error(
              'The original is unavailable. Re-upload it to save a separate artwork.',
            );
          sourceEntry = { source: loaded.originalSource };
        }
        const saved = await artworkRequest<StoredArtwork>('/api/artworks/preparation', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...sourceEntry, recipe, name: state.present.name.trim() }),
        });
        onSaved(saved);
      } else if (result.svg && onPrepared) await onPrepared(result.svg, state.present.name.trim());
    } catch (error) {
      setArchiveBlocked(error instanceof ArtworkRequestError && error.code === 'archived_artwork');
      setError(
        error instanceof Error
          ? error.message
          : 'Save failed. Your choices are still here; retry when ready.',
      );
    } finally {
      setSaving(false);
    }
  };
  const similar = analysis.objects.filter(
    (item) =>
      !item.hidden &&
      color &&
      [item.fill, item.stroke].some((paint) => {
        if (!paint) return false;
        const channels = (hex: string) =>
          [1, 3, 5].map((position) => parseInt(hex.slice(position, position + 2), 16));
        const reference = channels(color);
        return channels(paint).every(
          (channel, index) => Math.abs(channel - reference[index]!) <= shadeTolerance,
        );
      }),
  );
  const next = () =>
    setStep(
      reviews.some((issue) => !recipe.acknowledged.includes(issue.id)) ? 'review' : 'confirm',
    );
  const openStatus = (item: PreparationObject) =>
    item.fill
      ? 'Review fill boundary'
      : item.stroke && item.strokeWidth > 0
        ? 'Usable open stroke'
        : 'Blocked: no painted area';
  const gap = path ? Math.hypot(path.end[0] - path.start[0], path.end[1] - path.start[1]) : null;
  const keepOpen = () => {
    const scoped = reviews.filter(
      (issue) => issue.objectId === focused && issue.subpathId === subpathId,
    );
    dispatch({ type: 'leave-repair' });
    dispatch({
      type: 'edit',
      draft: {
        ...state.present,
        recipe: {
          ...recipe,
          acknowledged: [...new Set([...recipe.acknowledged, ...scoped.map((issue) => issue.id)])],
        },
      },
    });
    dispatch({ type: 'enter-repair' });
  };
  const previewSvg = originalView ? result?.svg : shown?.svg;
  const paintPreview =
    previewSvg && ink === 'white'
      ? previewSvg.replace(/fill="#000000"/g, 'fill="#ffffff"')
      : previewSvg;

  return (
    <section
      className="artwork-preparation"
      data-testid="artwork-preparation"
      data-mode={state.mode}
    >
      {dialog}
      {leaveDialog}
      <header className="preparation-head">
        <button
          type="button"
          disabled={saving}
          onClick={() => void (repairing ? leaveRepair() : cancel())}
        >
          {repairing ? 'Back to selection' : 'Back to artwork'}
        </button>
        <div>
          <h1>{repairing ? 'Repair paths' : 'Prepare artwork'}</h1>
          <p>
            {loaded.name} ·{' '}
            {repairing
              ? 'Inspect before changing geometry'
              : `1 Select · 2 Review · 3 Confirm — ${step}`}
          </p>
        </div>
        <button type="button" disabled={saving} onClick={() => void cancel()}>
          Cancel
        </button>
      </header>
      {error && (
        <div className="issue error" data-testid="preparation-error">
          <p>{error}</p>
          {archiveBlocked && (
            <p>
              Restore the file in another tab, then retry saving. Your upload choices remain here.{' '}
              <a
                className="archive-banner-link"
                href="/artwork?state=archived"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open archived artwork
              </a>
            </p>
          )}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry preview
          </button>
          {entry.artworkId && (
            <button
              type="button"
              disabled={!result?.canSave || saving}
              onClick={() => void save(true)}
            >
              Save as separate artwork
            </button>
          )}
        </div>
      )}
      <nav className="preparation-mobile-tabs">
        <button type="button" onClick={() => setObjectsExpanded((value) => !value)}>
          {objectsExpanded ? 'Hide objects' : 'Show objects'}
        </button>
        <button type="button" onClick={() => setMobileTab('source')}>
          Source
        </button>
        <button type="button" onClick={() => setMobileTab('prepared')}>
          Prepared
        </button>
      </nav>
      <div className={`preparation-body show-${mobileTab}`}>
        <aside className={`preparation-objects${objectsExpanded ? '' : ' collapsed'}`}>
          <h2>
            {repairing
              ? 'Open paths'
              : step === 'select'
                ? 'Objects'
                : step === 'review'
                  ? 'Review issues'
                  : 'Confirm artwork'}
          </h2>
          {repairing ? (
            <>
              <p>Inclusion is frozen. Repairs are saved when you save artwork.</p>
              <ul>
                {openPaths.map(({ object: item, path: contour }) => (
                  <li key={contour.id}>
                    <button
                      type="button"
                      className={subpathId === contour.id ? 'active' : ''}
                      onClick={() => {
                        setFocused(item.id);
                        setSubpathId(contour.id);
                        frameBounds(item.bounds);
                        dispatch({ type: 'discard-preview' });
                      }}
                    >
                      {item.label} · Outline{' '}
                      {preparationSubpaths(item).findIndex((path) => path.id === contour.id) + 1}
                      <small>{openStatus(item)}</small>
                    </button>
                  </li>
                ))}
              </ul>
              {!openPaths.length && <p>No retained open paths. Applied repairs remain undoable.</p>}
              <h3>Applied / reviewed</h3>
              <ul>
                {recipe.repairs.map((repair, index) => (
                  <li key={index}>
                    {repair.kind}
                    {'objectId' in repair && !selected.has(repair.objectId)
                      ? ' (excluded; inactive)'
                      : ''}
                  </li>
                ))}
              </ul>
              {objects
                .filter((item) => selected.has(item.id) && !item.fill && !item.stroke)
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => {
                      focus(item.id);
                      setTool('width');
                    }}
                  >
                    {item.label} · Set stroke width
                  </button>
                ))}
            </>
          ) : step === 'select' ? (
            <>
              <input
                aria-label="Find an object"
                placeholder="Find an object…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="preparation-list-actions">
                <button
                  type="button"
                  data-testid="preparation-keep-all"
                  disabled={saving}
                  onClick={() =>
                    edit({
                      selected: analysis.objects
                        .filter((item) => !item.hidden)
                        .map((item) => ({ objectId: item.id, paint: 'both' })),
                    })
                  }
                >
                  Keep all visible objects
                </button>
                <button type="button" onClick={() => edit({ selected: [] })}>
                  Clear
                </button>
              </div>
              {analysis.groups.map((group) => (
                <GroupCheck
                  key={group.id}
                  label={group.label}
                  total={group.objectIds.length}
                  count={group.objectIds.filter((id) => selected.has(id)).length}
                  disabled={saving}
                  onChange={() => toggle(group.objectIds)}
                />
              ))}
              {[false, true].map((hidden) => (
                <div key={String(hidden)}>
                  {hidden && analysis.objects.some((item) => item.hidden) && (
                    <h3>Hidden objects</h3>
                  )}
                  <ul>
                    {analysis.objects
                      .filter((item) => item.hidden === hidden)
                      .filter((item) =>
                        item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                      )
                      .map((item) => (
                        <li
                          key={item.id}
                          className={`preparation-object${item.hidden ? ' hidden-object' : ''}`}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Keep ${item.label}`}
                            checked={selected.has(item.id)}
                            disabled={saving}
                            data-testid={`keep-${item.id}`}
                            onChange={() => toggle([item.id])}
                          />
                          <button
                            type="button"
                            className={focused === item.id ? 'active' : ''}
                            onClick={() => focus(item.id)}
                          >
                            <img alt="" src={svgImage(preparationSourceSvg(analysis, [item]))} />
                            <span>
                              {item.label}
                              <small>
                                {item.hidden
                                  ? 'Hidden · no visible paint'
                                  : `${item.fill ?? 'no fill'} / ${item.stroke ?? 'no stroke'}`}
                                {recipe.repairs.some((repair) =>
                                  'objectId' in repair
                                    ? repair.objectId === item.id
                                    : repair.a.objectId === item.id ||
                                      repair.b.objectId === item.id,
                                )
                                  ? ' · repair applied'
                                  : ''}
                              </small>
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
              {object && (
                <div className="preparation-inspector">
                  <h3>{object.label}</h3>
                  <p>
                    Compound outlines and holes stay together. Only visible portions are retained.
                  </p>
                  {object.fill && object.stroke && (
                    <label>
                      Paint to keep
                      <select
                        value={
                          recipe.selected.find((item) => item.objectId === object.id)?.paint ??
                          'both'
                        }
                        onChange={(event) =>
                          edit({
                            selected: [
                              ...recipe.selected.filter((item) => item.objectId !== object.id),
                              {
                                objectId: object.id,
                                paint: event.target.value as 'both' | 'fill' | 'stroke',
                              },
                            ],
                          })
                        }
                      >
                        <option value="both">Both</option>
                        <option value="fill">Fill</option>
                        <option value="stroke">Stroke</option>
                      </select>
                    </label>
                  )}
                  {object.groups.map((id) => (
                    <button
                      type="button"
                      key={id}
                      onClick={() =>
                        toggle(analysis.groups.find((group) => group.id === id)?.objectIds ?? [])
                      }
                    >
                      Select containing group
                    </button>
                  ))}
                  {[
                    ...new Set(
                      [object.fill, object.stroke].filter((paint): paint is string =>
                        Boolean(paint),
                      ),
                    ),
                  ].map((paint) => (
                    <button
                      type="button"
                      key={paint}
                      onClick={() => {
                        setColor(paint);
                        setShadeTolerance(0);
                      }}
                    >
                      Select similar color {paint}
                    </button>
                  ))}
                </div>
              )}
              {color && (
                <div className="preparation-inspector">
                  <strong>Select similar color {color}</strong>
                  <label>
                    Include similar shades
                    <input
                      type="range"
                      min="0"
                      max="50"
                      value={shadeTolerance}
                      onChange={(event) => setShadeTolerance(Number(event.target.value))}
                    />
                  </label>
                  <p>
                    {similar.length} matching objects:{' '}
                    {similar.map((item) => item.label).join(', ')}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      edit({
                        selected: [
                          ...recipe.selected.filter(
                            (item) => !similar.some((match) => match.id === item.objectId),
                          ),
                          ...similar.map((item) => ({ objectId: item.id, paint: 'both' as const })),
                        ],
                      })
                    }
                  >
                    Apply color selection
                  </button>
                  <button type="button" onClick={() => setColor(null)}>
                    Cancel shortcut
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {step === 'confirm' && (
                <>
                  <label>
                    Name
                    <input
                      value={state.present.name}
                      maxLength={200}
                      data-testid="preparation-name"
                      onChange={(event) =>
                        dispatch({
                          type: 'edit',
                          draft: { ...state.present, name: event.target.value },
                        })
                      }
                    />
                  </label>
                  <p>
                    Selected bounds: {result?.keptBoundsMm?.w.toFixed(2)} ×{' '}
                    {result?.keptBoundsMm?.h.toFixed(2)} mm
                  </p>
                  <div className="preparation-dimensions">
                    {(['widthMm', 'heightMm'] as const).map((axis) => (
                      <label key={axis}>
                        {axis === 'widthMm' ? 'Width' : 'Height'} (mm)
                        <input
                          type="number"
                          min="0.01"
                          max="1000"
                          step="any"
                          value={
                            result?.boundsMm
                              ? Number(
                                  (axis === 'widthMm'
                                    ? result.boundsMm.w
                                    : result.boundsMm.h
                                  ).toFixed(4),
                                )
                              : ''
                          }
                          onChange={(event) => resize(axis, Number(event.target.value))}
                        />
                      </label>
                    ))}
                  </div>
                  <p>
                    {recipe.repairs.length} repairs applied;{' '}
                    {openPaths.filter(({ object }) => !object.fill && object.stroke).length} usable
                    open strokes kept.
                  </p>
                  <p>Preview ink and backing are viewing aids. They are not saved objects.</p>
                  {entry.artworkId && (
                    <p>Existing designs keep their pinned version. This saves a new version.</p>
                  )}
                </>
              )}
              {issues.map((issue) => (
                <div
                  className={`issue ${issue.severity === 'error' ? 'error' : 'warning'}`}
                  key={issue.id}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (issue.objectId) focus(issue.objectId);
                    }}
                  >
                    {issue.message}
                  </button>
                  {issue.severity === 'review' && (
                    <label>
                      <input
                        type="checkbox"
                        checked={recipe.acknowledged.includes(issue.id)}
                        onChange={() =>
                          dispatch({
                            type: 'edit',
                            draft: {
                              ...state.present,
                              recipe: {
                                ...recipe,
                                acknowledged: recipe.acknowledged.includes(issue.id)
                                  ? recipe.acknowledged.filter((id) => id !== issue.id)
                                  : [...recipe.acknowledged, issue.id],
                              },
                            },
                          })
                        }
                      />
                      {issue.code === 'confirm_size'
                        ? 'I confirm the physical dimensions shown'
                        : 'Keep appearance'}
                    </label>
                  )}
                  {issue.subpathId && (
                    <button
                      type="button"
                      onClick={() => {
                        setFocused(issue.objectId ?? null);
                        setSubpathId(issue.subpathId ?? null);
                        if (issue.objectId)
                          enterRepair({ objectId: issue.objectId, subpathId: issue.subpathId });
                      }}
                    >
                      Repair paths…
                    </button>
                  )}
                </div>
              ))}
              {!issues.length && <p>No issues to review.</p>}
            </>
          )}
        </aside>
        <div className="preparation-source-panel">
          <h2>{repairing ? 'Geometry view' : 'Source'}</h2>
          <PreparationCanvas
            analysis={analysis}
            sourceSvg={
              originalView
                ? (result?.sourceSvg ?? analysis.sourceSvg)
                : (pending?.result?.sourceSvg ?? result?.sourceSvg ?? analysis.sourceSvg)
            }
            objects={objects}
            selected={selected}
            highlighted={new Set(!repairing && color ? similar.map((item) => item.id) : [])}
            focused={focused}
            repair={repairing}
            pending={pending?.operation ?? null}
            frame={frame}
            onFocus={focus}
            onEndpoints={(endpoints) => {
              if (endpoints.length === 1) endpoint(endpoints[0]!);
              else setEndpointCandidates(endpoints);
            }}
            onPick={(ids, choose) => {
              if (choose) setCandidates(ids);
              else if (ids[0]) {
                setFocused(ids[0]);
                toggle([ids[0]]);
              }
            }}
          />
          {endpointCandidates.length > 0 && (
            <div className="preparation-candidates">
              <h3>Choose endpoint at this position</h3>
              {endpointCandidates.map((candidate) => (
                <button
                  type="button"
                  key={JSON.stringify(candidate)}
                  onMouseEnter={() => setFocused(candidate.objectId)}
                  onClick={() => {
                    endpoint(candidate);
                    setEndpointCandidates([]);
                  }}
                >
                  {objects.find((item) => item.id === candidate.objectId)?.label} ·{' '}
                  {outlineLabel(
                    objects.find((item) => item.id === candidate.objectId),
                    candidate.subpathId,
                  )}{' '}
                  · {candidate.end === 'start' ? 'A' : 'B'}
                </button>
              ))}
            </div>
          )}
          {candidates.length > 0 && (
            <div className="preparation-candidates">
              <h3>Choose object here · front to back</h3>
              {candidates.map((id) => (
                <button
                  type="button"
                  key={id}
                  onMouseEnter={() => setFocused(id)}
                  onClick={() => {
                    toggle([id]);
                    setCandidates([]);
                  }}
                >
                  {objects.find((item) => item.id === id)?.label} {selected.has(id) ? '(kept)' : ''}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="preparation-result-panel">
          <h2>{repairing ? 'Result preview' : 'Prepared mark'}</h2>
          <div className="preparation-canvas-toolbar">
            <select
              aria-label="Preview backing"
              value={backing}
              onChange={(event) => setBacking(event.target.value)}
            >
              <option value="checker">Checkerboard</option>
              <option value="light">Light backing</option>
              <option value="dark">Dark backing</option>
            </select>
            <select
              aria-label="Preview ink"
              value={ink}
              onChange={(event) => setInk(event.target.value)}
            >
              <option value="black">Black ink</option>
              <option value="white">White ink</option>
            </select>
          </div>
          <PreparedMarkCanvas
            svg={paintPreview ?? null}
            backing={backing}
            empty={
              selected.size
                ? 'No visible area. Inspect empty, hidden or occluded objects, or enter Repair paths.'
                : 'Click the parts you want to use.'
            }
          />
          {result?.svg && (
            <p className="preparation-help">
              Check fine details at the intended physical size. The vector preview can show detail
              below the placement mask’s resolution.
            </p>
          )}
          {!current && <p data-testid="preparation-updating">Updating preview…</p>}
          <p>
            {selected.size} objects kept ·{' '}
            {reviews.filter((issue) => !recipe.acknowledged.includes(issue.id)).length} items to
            review
          </p>
          {repairing && (
            <div className="preparation-repair-controls">
              <div className="preparation-list-actions">
                {(['inspect', 'close', 'join', 'width'] as const).map((tool) => (
                  <button
                    type="button"
                    key={tool}
                    className={repairTool === tool ? 'active' : ''}
                    onClick={() => setTool(tool)}
                  >
                    {
                      {
                        inspect: 'Inspect',
                        close: 'Close loop',
                        join: 'Join ends',
                        width: 'Set stroke width',
                      }[tool]
                    }
                  </button>
                ))}
              </div>
              <h3>
                {object?.label ?? 'Choose a retained path'}
                {path ? ` · ${outlineLabel(object, path.id)}` : ''}
              </h3>
              {path && (
                <>
                  <p>
                    Gap: {gap?.toFixed(4)}{' '}
                    {analysis.unitsConfirmed || recipe.acknowledged.includes('confirm-size')
                      ? 'mm'
                      : 'drawing units (confirm physical size before repair)'}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      frameBounds({
                        x: Math.min(path.start[0], path.end[0]),
                        y: Math.min(path.start[1], path.end[1]),
                        w: Math.abs(path.end[0] - path.start[0]),
                        h: Math.abs(path.end[1] - path.start[1]),
                      })
                    }
                  >
                    Fit gap
                  </button>
                  <button type="button" onClick={() => frameBounds(object?.bounds ?? null)}>
                    Fit object
                  </button>
                  <p>
                    {object?.fill
                      ? 'SVG fills this open contour across an implicit edge. Explicit closure also changes its stroke caps and joins.'
                      : 'A usable open stroke does not need closure.'}
                  </p>
                  <button type="button" disabled={Boolean(pending)} onClick={keepOpen}>
                    Keep open
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(pending)}
                    onClick={() => {
                      const index = openPaths.findIndex((item) => item.path.id === subpathId);
                      const next = openPaths[(index + 1) % openPaths.length];
                      if (next) {
                        setFocused(next.object.id);
                        setSubpathId(next.path.id);
                        frameBounds(next.object.bounds);
                      }
                    }}
                  >
                    Next open path
                  </button>
                </>
              )}
              {repairTool === 'close' && (
                <>
                  <p>
                    This adds one straight edge between A and B. Curved reconstruction requires your
                    source editor.
                  </p>
                  <button
                    type="button"
                    data-testid="preparation-preview-close"
                    disabled={
                      !object ||
                      !path ||
                      path.closed ||
                      !selected.has(object.id) ||
                      (!analysis.unitsConfirmed && !recipe.acknowledged.includes('confirm-size'))
                    }
                    onClick={() => {
                      if (object && path)
                        chooseOperation({ kind: 'close', objectId: object.id, subpathId: path.id });
                    }}
                  >
                    Preview closure
                  </button>
                </>
              )}
              {repairTool === 'join' && (
                <>
                  <p>
                    Choose the exact first and second endpoints. Incompatible widths, fills, dashes,
                    clips, and intervening layers cannot be joined here.
                  </p>
                  {(['a', 'b'] as const).map((slot) => (
                    <label key={slot}>
                      Endpoint {slot.toUpperCase()}
                      <select
                        value={JSON.stringify(slot === 'a' ? joinA : joinB)}
                        onChange={(event) => {
                          const endpoint = JSON.parse(event.target.value) as ArtworkEndpoint | null;
                          if (slot === 'a') {
                            setJoinA(endpoint);
                            setJoinB(null);
                          } else setJoinB(endpoint);
                          dispatch({ type: 'discard-preview' });
                          setAcceptedRepair(false);
                        }}
                      >
                        <option value="null">Choose endpoint…</option>
                        {openPaths.flatMap(({ object: item, path }) =>
                          (['start', 'end'] as const).map((end) => {
                            const compatible =
                              !joinA ||
                              compatiblePreparationJoin(
                                objects.find((object) => object.id === joinA.objectId)!,
                                item,
                              );
                            return (
                              <option
                                key={`${path.id}-${end}`}
                                value={JSON.stringify({
                                  objectId: item.id,
                                  subpathId: path.id,
                                  end,
                                })}
                                disabled={
                                  slot === 'b' && (!compatible || joinA?.subpathId === path.id)
                                }
                              >
                                {item.label} · {outlineLabel(item, path.id)} ·{' '}
                                {end === 'start' ? 'A' : 'B'}
                                {compatible ? '' : ' — incompatible paint / clip'}
                              </option>
                            );
                          }),
                        )}
                      </select>
                    </label>
                  ))}
                  <button
                    type="button"
                    disabled={
                      !joinA ||
                      !joinB ||
                      (!analysis.unitsConfirmed && !recipe.acknowledged.includes('confirm-size'))
                    }
                    onClick={() => {
                      if (joinA && joinB) chooseOperation({ kind: 'join', a: joinA, b: joinB });
                    }}
                  >
                    Preview join
                  </button>
                </>
              )}
              {repairTool === 'width' && (
                <>
                  <label>
                    Stroke width (mm)
                    <input
                      type="number"
                      min="0.001"
                      max="100"
                      step="any"
                      value={widthMm}
                      onChange={(event) => {
                        setWidthMm(Number(event.target.value));
                        dispatch({ type: 'discard-preview' });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={
                      !object ||
                      !selected.has(object.id) ||
                      !(widthMm > 0 && widthMm <= 100) ||
                      (!analysis.unitsConfirmed && !recipe.acknowledged.includes('confirm-size'))
                    }
                    onClick={() => {
                      if (object)
                        chooseOperation({ kind: 'stroke-width', objectId: object.id, widthMm });
                    }}
                  >
                    Preview stroke width
                  </button>
                </>
              )}
              {pending && (
                <>
                  <button
                    type="button"
                    className={originalView ? 'active' : ''}
                    onClick={() => setOriginalView(true)}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    className={!originalView ? 'active' : ''}
                    onClick={() => setOriginalView(false)}
                  >
                    With repair
                  </button>
                  {pending.result ? (
                    <>
                      <div className="preparation-before-after">
                        <figure>
                          <figcaption>Before</figcaption>
                          {result?.svg && <img alt="Before repair" src={svgImage(result.svg)} />}
                        </figure>
                        <figure>
                          <figcaption>After</figcaption>
                          {pending.result.svg && (
                            <img alt="After repair" src={svgImage(pending.result.svg)} />
                          )}
                        </figure>
                      </div>
                      {pending.result.repairChanges && (
                        <figure className="preparation-paint-changes">
                          <figcaption>Paint changes · original size</figcaption>
                          <img
                            alt="Highlighted repair changes"
                            src={svgImage(pending.result.repairChanges.svg)}
                          />
                          <p>Green adds paint. Red removes paint. Grey is the previous mark.</p>
                        </figure>
                      )}
                      {pending.result.issues
                        .filter((issue) => issue.severity !== 'info')
                        .map((issue) => (
                          <p
                            className={`issue ${issue.severity === 'error' ? 'error' : 'warning'}`}
                            key={issue.id}
                          >
                            {issue.message}
                          </p>
                        ))}
                      <label>
                        <input
                          type="checkbox"
                          checked={acceptedRepair}
                          onChange={(event) => setAcceptedRepair(event.target.checked)}
                        />
                        I reviewed the painted changes, including crossings, counters and joins.
                      </label>
                    </>
                  ) : (
                    <p className="loading-inline"><LoadingSpinner compact />Updating repair preview…</p>
                  )}
                  <button type="button" onClick={() => dispatch({ type: 'discard-preview' })}>
                    Cancel preview
                  </button>
                  <button
                    type="button"
                    className="primary"
                    data-testid="preparation-apply-repair"
                    disabled={
                      !acceptedRepair ||
                      !pending.result ||
                      pending.result.issues.some((issue) => issue.severity === 'error')
                    }
                    onClick={() => {
                      dispatch({ type: 'apply-repair' });
                      setAcceptedRepair(false);
                    }}
                  >
                    Apply repair
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className="preparation-footer">
        <button
          type="button"
          disabled={!state.past.length || saving}
          onClick={() => dispatch({ type: 'undo' })}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!state.future.length || saving}
          onClick={() => dispatch({ type: 'redo' })}
        >
          Redo
        </button>
        {!repairing && (
          <>
            <button
              type="button"
              data-testid="preparation-repair"
              disabled={!selected.size || saving}
              onClick={() => enterRepair()}
            >
              Repair paths… · Open paths: {openPaths.length}
            </button>
            <button type="button" onClick={() => setStep('select')}>
              Select
            </button>
            {step === 'confirm' ? (
              <button
                type="button"
                className="primary"
                data-testid="preparation-save"
                disabled={!result?.canSave || !state.present.name.trim() || saving}
                onClick={() => void save()}
              >
                <span className="loading-inline">
                {saving && <LoadingSpinner compact />}
                {saving
                  ? 'Saving…'
                  : persist
                    ? entry.artworkId
                      ? 'Save new version'
                      : 'Save artwork'
                    : 'Use prepared artwork'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                data-testid="preparation-next"
                disabled={
                  !result?.svg || issues.some((issue) => issue.severity === 'error') || saving
                }
                onClick={step === 'review' ? () => setStep('confirm') : next}
              >
                {step === 'review'
                  ? 'Confirm artwork'
                  : reviews.length
                    ? 'Review artwork'
                    : 'Confirm artwork'}
              </button>
            )}
          </>
        )}
      </footer>
    </section>
  );
}

function PreparedMarkCanvas({
  svg,
  backing,
  empty,
}: {
  svg: string | null;
  backing: string;
  empty: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; offset: { x: number; y: number } } | null>(null);
  return (
    <>
      <div className="preparation-canvas-toolbar">
        <button type="button" onClick={() => setZoom((value) => Math.max(0.25, value / 1.5))}>
          −
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          Fit mark
        </button>
        <button type="button" onClick={() => setZoom((value) => Math.min(64, value * 1.5))}>
          +
        </button>
        <small>Drag to pan</small>
      </div>
      <div
        className={`preparation-result backing-${backing}`}
        data-testid="preparation-result"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, offset };
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setOffset({
              x: drag.current.offset.x + event.clientX - drag.current.x,
              y: drag.current.offset.y + event.clientY - drag.current.y,
            });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {svg ? (
          <img
            draggable={false}
            alt="Prepared monochrome mark"
            src={svgImage(svg)}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          />
        ) : (
          <p>{empty}</p>
        )}
      </div>
    </>
  );
}
