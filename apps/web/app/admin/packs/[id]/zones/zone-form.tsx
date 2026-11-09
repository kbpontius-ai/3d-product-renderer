'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useConfirm } from '@/components/confirm-dialog';
import { useHydrated } from '@/lib/use-hydrated';
import type { DecorationZoneDef, FinishKind, Vec3 } from '@pr/design-schema';
import {
  applyRimPick,
  changeZoneMapping,
  applySurfacePick,
  AXIS_CHOICES,
  emptyZoneForm,
  flipCylinderAxis,
  flipFacing,
  fmt,
  formFromZone,
  formsMatch,
  frameOf,
  isAuthorable,
  placementMarker,
  rotateArtwork90,
  zeroAngleDirection,
  zoneFromForm,
  ZONE_TYPE_LABELS,
  SURFACE_TOLERANCE_MM,
  type AuthorableZoneType,
  type SurfaceReport,
  type Triple,
  type ZoneForm as FormState,
} from '@/lib/zone-authoring';

/**
 * One zone's form: where it sits on the part, how big it is, and what the tooling allows in it.
 *
 * Used for a zone that exists and for one being added. Placement is only editable on a draft; on a
 * published pack it is shown, so the author can see what customers' designs are built on, and the
 * way to change it is a new draft version.
 *
 * Saving validates the whole pack rather than the field that changed, so an edit that is only wrong
 * in context — artwork wider than the circumference it wraps, a margin that leaves nothing printable
 * — is refused with the reason rather than accepted and discovered later by a customer.
 */

const FINISHES: FinishKind[] = ['emboss', 'deboss', 'print'];

/** A click (or three, around a rim) on the part, delivered to the form that asked for it. */
export interface SurfacePick {
  seq: number;
  kind: 'point' | 'rim';
  points: Vec3[];
  /** The surface's normal under the click — averaged over the three for a rim. */
  normal: Vec3;
}

/** What the form says right now, for the preview: a whole zone, or just where it will sit. */
export interface Candidate {
  zone: DecorationZoneDef | null;
  marker: { point: Vec3; normal: Vec3 } | null;
}

export function ZoneForm({
  packId,
  productKey,
  variantKey,
  variantId,
  materialSlots,
  zone,
  newType,
  draft,
  published,
  active,
  report,
  picking,
  pick,
  onActivate,
  onCandidate,
  onDirty,
  onStartPick,
  onClose,
}: {
  packId: string;
  productKey: string;
  variantKey: string;
  variantId: string;
  materialSlots: { key: string; label: string }[];
  /** The zone as stored, or null for one being added. */
  zone: DecorationZoneDef | null;
  newType?: AuthorableZoneType;
  /** Whether the pack is a draft: placement, adding and removing are only allowed then. */
  draft: boolean;
  /** Whether the pack is published, which is what the test pattern needs. */
  published: boolean;
  active: boolean;
  /** How the zone sits against the part; undefined until the mesh has loaded, null if unmeasurable. */
  report: SurfaceReport | null | undefined;
  picking: false | 'point' | 'rim';
  pick: SurfacePick | null;
  onActivate: () => void;
  onCandidate: (candidate: Candidate) => void;
  /** Whether the form differs from what is saved, for the page's leave-without-saving guard. */
  onDirty: (dirty: boolean) => void;
  /** Starts clicking on the part for this zone, or stops (null). */
  onStartPick: (kind: 'point' | 'rim' | null) => void;
  /** After a new zone is added (with its key) or its form is cancelled (with null). */
  onClose?: (addedKey: string | null) => void;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const key = zone?.key ?? 'new';
  const [form, setForm] = useState<FormState>(() =>
    zone ? formFromZone(zone) : emptyZoneForm(newType ?? 'planar'),
  );
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'checking' | 'removing'>('idle');
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [pickProblem, setPickProblem] = useState<string | null>(null);

  const authorable = isAuthorable(form.type);
  const placementEditable = draft && authorable;
  const result = useMemo(
    () => (authorable ? zoneFromForm(form, zone?.key ?? 'new-zone') : null),
    [form, authorable, zone],
  );
  const marker = useMemo(() => (authorable ? placementMarker(form) : null), [form, authorable]);

  // What is saved, to tell an edit from a reformat. Recomputed when a save brings the zone back.
  const baseline = useMemo(
    () => (zone ? formFromZone(zone) : emptyZoneForm(newType ?? 'planar')),
    [zone, newType],
  );
  const dirty = !formsMatch(form, baseline);
  useEffect(() => {
    onDirty(dirty);
    // `onDirty` is a fresh closure on every render of the parent; the flag is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // The preview draws what the form says right now, not what was last saved — and, before the zone
  // is complete, at least where it will sit.
  useEffect(() => {
    onCandidate({ zone: result ? result.zone : zone, marker });
    // `onCandidate` is a fresh closure on every render of the parent; the values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, zone, marker]);

  // Once a save has been refused for missing fields, the list follows the form as it is filled in
  // rather than going on naming boxes that are no longer empty.
  useEffect(() => {
    setProblems((current) => (current.length > 0 ? (result?.problems ?? []) : current));
  }, [result]);

  useEffect(() => {
    if (!pick) return;
    const picked =
      pick.kind === 'rim' && pick.points.length === 3
        ? applyRimPick(form, pick.points as [Vec3, Vec3, Vec3], pick.normal)
        : applySurfacePick(form, pick.points[0]!, pick.normal);
    if (picked.form) {
      setForm(picked.form);
      setPickProblem(null);
    } else {
      setPickProblem(picked.problem);
    }
    // Applied once per click, keyed by its sequence number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.seq]);

  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setState((current) => (current === 'saved' ? 'idle' : current));
  };
  const setAxis = (
    field: 'originMm' | 'normal' | 'tangent' | 'axisOriginMm' | 'axisDir',
    index: number,
    value: string,
  ) =>
    setForm((current) => {
      const next = [...current[field]] as Triple;
      next[index] = value;
      return { ...current, [field]: next };
    });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (result && result.problems.length > 0) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    setState('saving');

    const response = zone
      ? await fetch(`/api/admin/packs/${packId}/zones`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            productKey,
            variantKey,
            zoneKey: zone.key,
            name: form.name,
            ...(placementEditable && form.type !== zone.type && result?.zone
              ? { mapping: form.type, frame: frameOf(result.zone) }
              : {}),
            ...(form.materialSlotKey !== baseline.materialSlotKey
              ? { materialSlotKey: form.materialSlotKey || null }
              : {}),
            widthMm: form.widthMm,
            heightMm: form.heightMm,
            safeMarginMm: form.safeMarginMm,
            maxDepthMm: form.maxDepthMm,
            minStrokeMm: form.minStrokeMm,
            maxCoverage: form.maxCoverage,
            wrapWarnDeg: form.wrapWarnDeg,
            finishes: form.finishes,
            // Only when it actually moved: an unchanged frame sent back would be refused on a zone
            // that designs already use, and would record a move that never happened.
            ...(placementEditable && result?.zone && moved(zone, result.zone)
              ? { frame: frameOf(result.zone) }
              : {}),
          }),
        })
      : await fetch(`/api/admin/packs/${packId}/zones`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ productKey, variantKey, zone: withoutKey(result!.zone!) }),
        });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { detail?: string } };
      setError(body.error?.detail ?? 'that change was refused');
      setState('idle');
      return;
    }

    if (!zone) {
      const body = (await response.json()) as { key: string };
      onClose?.(body.key);
    } else {
      setState('saved');
    }
    router.refresh();
  };

  const remove = async () => {
    if (!zone) return;
    const ok = await confirm({
      title: `Remove the zone “${zone.name}”?`,
      body: [`Key: ${zone.key}`],
      consequences: ['It is removed from this draft. This cannot be undone.'],
      confirmLabel: 'Remove zone',
      tone: 'danger',
    });
    if (!ok) return;
    setState('removing');
    setError(null);
    const query = new URLSearchParams({ productKey, variantKey, zoneKey: zone.key });
    const response = await fetch(`/api/admin/packs/${packId}/zones?${query}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { detail?: string } };
      setError(body.error?.detail ?? 'the zone could not be removed');
      setState('idle');
      return;
    }
    router.refresh();
  };

  /** Makes a real design with the test pattern in this zone, and opens it in the editor. */
  const check = async () => {
    if (!zone) return;
    setState('checking');
    setError(null);
    try {
      const response = await fetch('/api/admin/zone-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ variantId, zoneKey: zone.key }),
      });
      const body = (await response.json()) as { designId?: string; error?: { detail?: string } };
      if (!response.ok || !body.designId) {
        setError(body.error?.detail ?? 'the check could not be set up');
        setState('idle');
        return;
      }
      router.push(`/design/${body.designId}`);
    } catch {
      setError('the check could not be set up');
      setState('idle');
    }
  };

  const zeroAngle = form.type === 'cylindrical' ? zeroAngleDirection(form.axisDir) : null;

  return (
    <form
      className={active ? 'admin-form zone-form active' : 'admin-form zone-form'}
      onSubmit={(e) => void save(e)}
      onFocusCapture={onActivate}
      data-testid={`zone-${key}`}
    >
      {dialog}
      <label>
        Name
        <input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          data-testid={`zone-name-${key}`}
        />
        <small>
          {authorable ? ZONE_TYPE_LABELS[form.type as AuthorableZoneType] : form.type} zone
          {zone ? (
            <>
              {' '}
              · key <code>{zone.key}</code>
            </>
          ) : (
            ' · the key is made from the name when it is added'
          )}
        </small>
      </label>

      <label>
        Artwork target part
        <select
          value={form.materialSlotKey}
          disabled={!draft}
          onChange={(event) => set('materialSlotKey', event.target.value)}
          data-testid={`zone-target-${key}`}
        >
          <option value="">Automatic</option>
          {materialSlots.map((slot) => (
            <option key={slot.key} value={slot.key}>
              {slot.label}
            </option>
          ))}
        </select>
        <small>
          Choose the part that receives this zone’s artwork. Changing a published target requires a
          new draft version.
        </small>
      </label>
      {(form.type === 'planar' || form.type === 'conformal') && (
        <label>
          Mapping
          <select
            value={form.type}
            disabled={!placementEditable || state === 'saving'}
            data-testid={`zone-mapping-${key}`}
            onChange={(event) => {
              const type = event.target.value;
              if (type !== 'planar' && type !== 'conformal') return;
              setForm((current) => changeZoneMapping(current, type));
              setState('idle');
            }}
          >
            <option value="planar">Flat surface</option>
            <option value="conformal">Follow surface</option>
          </select>
          <small>
            {form.type === 'conformal'
              ? 'Follows the actual part geometry.'
              : 'Uses a flat placement plane.'}
          </small>
        </label>
      )}

      {authorable && (
        <fieldset className="zone-placement" disabled={!placementEditable}>
          <legend>Placement</legend>
          {!draft && (
            <small>
              Fixed while the pack is published — customers&rsquo; designs are built on it. Make a
              new draft version to move it.
            </small>
          )}

          {form.type === 'cylindrical' ? (
            <>
              <VecField
                label="Axis point (mm)"
                values={form.axisOriginMm}
                onChange={(i, v) => setAxis('axisOriginMm', i, v)}
                testId={`zone-axis-origin-${key}`}
              />
              <VecField
                label="Axis direction"
                values={form.axisDir}
                onChange={(i, v) => setAxis('axisDir', i, v)}
                onChoose={(value) => set('axisDir', value)}
                testId={`zone-axis-dir-${key}`}
              />
              <div className="admin-columns zone-three">
                <NumberField
                  label="Radius (mm)"
                  value={form.radiusMm}
                  onChange={(v) => set('radiusMm', v)}
                  testId={`zone-radius-${key}`}
                />
                <NumberField
                  label="Centre angle (°)"
                  value={form.centerAngleDeg}
                  onChange={(v) => set('centerAngleDeg', v)}
                  testId={`zone-angle-${key}`}
                  hint={
                    zeroAngle ? `0° points toward (${zeroAngle.map(fmt).join(', ')})` : undefined
                  }
                />
                <NumberField
                  label="Centre height along axis (mm)"
                  value={form.centerHeightMm}
                  onChange={(v) => set('centerHeightMm', v)}
                  testId={`zone-height-along-${key}`}
                />
              </div>
              <div className="zone-buttons">
                <button
                  type="button"
                  onClick={() => setForm(flipCylinderAxis)}
                  data-testid={`zone-flip-axis-${key}`}
                >
                  Turn artwork upside down
                </button>
              </div>
            </>
          ) : (
            <>
              <VecField
                label="Centre (mm)"
                values={form.originMm}
                onChange={(i, v) => setAxis('originMm', i, v)}
                testId={`zone-origin-${key}`}
              />
              <VecField
                label="Facing direction"
                values={form.normal}
                onChange={(i, v) => setAxis('normal', i, v)}
                onChoose={(value) => set('normal', value)}
                testId={`zone-normal-${key}`}
              />
              <VecField
                label="Artwork reads along"
                values={form.tangent}
                onChange={(i, v) => setAxis('tangent', i, v)}
                onChoose={(value) => set('tangent', value)}
                testId={`zone-tangent-${key}`}
              />
              {form.type === 'conformal' && (
                <NumberField
                  label="Projection depth (mm)"
                  value={form.maxProjectionDepthMm}
                  onChange={(v) => set('maxProjectionDepthMm', v)}
                  testId={`zone-projection-${key}`}
                  hint="How far the artwork is projected onto the curve"
                />
              )}
              <div className="zone-buttons">
                <button
                  type="button"
                  onClick={() => setForm(flipFacing)}
                  data-testid={`zone-flip-${key}`}
                >
                  Face the other way
                </button>
                <button
                  type="button"
                  onClick={() => setForm(rotateArtwork90)}
                  data-testid={`zone-rotate-${key}`}
                >
                  Rotate artwork 90°
                </button>
              </div>
            </>
          )}

          <div className="zone-buttons">
            <button
              type="button"
              className={picking === 'point' ? 'pressed' : undefined}
              aria-pressed={picking === 'point'}
              onClick={() => onStartPick(picking === 'point' ? null : 'point')}
              data-testid={`zone-pick-${key}`}
            >
              {picking === 'point' ? 'Click the part… (cancel)' : 'Place by clicking the part'}
            </button>
            <button
              type="button"
              className={picking === 'rim' ? 'pressed' : undefined}
              aria-pressed={picking === 'rim'}
              title={
                form.type === 'cylindrical'
                  ? 'Click three points around a round edge to set the axis and radius'
                  : 'Click three points around a round edge to centre the zone on it'
              }
              onClick={() => onStartPick(picking === 'rim' ? null : 'rim')}
              data-testid={`zone-rim-${key}`}
            >
              {picking === 'rim'
                ? 'Click 3 points on the rim… (cancel)'
                : form.type === 'cylindrical'
                  ? 'Axis from 3 rim points'
                  : 'Centre from 3 rim points'}
            </button>
          </div>
          {pickProblem && <span className="admin-error">{pickProblem}</span>}

          {result && !result.zone && (
            <small data-testid={`zone-not-drawn-${key}`}>
              {marker ? 'Only its centre is shown on the part so far' : 'Not shown on the part yet'}{' '}
              — {result.problems[0]?.toLowerCase()}.
            </small>
          )}
          {report !== undefined && result?.zone && (
            <SurfaceNotes report={report} testId={`zone-distance-${key}`} />
          )}
        </fieldset>
      )}

      <div className="admin-columns zone-three">
        <NumberField
          label={form.type === 'cylindrical' ? 'Arc width (mm)' : 'Width (mm)'}
          value={form.widthMm}
          onChange={(v) => set('widthMm', v)}
          testId={`zone-width-${key}`}
        />
        <NumberField
          label="Height (mm)"
          value={form.heightMm}
          onChange={(v) => set('heightMm', v)}
          testId={`zone-heightmm-${key}`}
        />
        <NumberField
          label="Safe margin (mm)"
          value={form.safeMarginMm}
          onChange={(v) => set('safeMarginMm', v)}
          testId={`zone-margin-${key}`}
          hint="Artwork may cross it, but it is flagged."
        />
      </div>

      <div className="admin-columns zone-four">
        <NumberField
          label="Max depth (mm)"
          value={form.maxDepthMm}
          onChange={(v) => set('maxDepthMm', v)}
          hint="What the tooling can hold."
        />
        <NumberField
          label="Min stroke (mm)"
          value={form.minStrokeMm}
          onChange={(v) => set('minStrokeMm', v)}
          hint="Thinnest feature the process reproduces."
        />
        <NumberField
          label="Max coverage"
          value={form.maxCoverage}
          onChange={(v) => set('maxCoverage', v)}
        />
        <NumberField
          label="Wrap warning (deg)"
          value={form.wrapWarnDeg}
          onChange={(v) => set('wrapWarnDeg', v)}
        />
      </div>

      <fieldset className="zone-finishes">
        <legend>Finishes</legend>
        {FINISHES.map((finish) => (
          <label key={finish}>
            <input
              type="checkbox"
              checked={form.finishes.includes(finish)}
              onChange={() =>
                set(
                  'finishes',
                  form.finishes.includes(finish)
                    ? form.finishes.filter((f) => f !== finish)
                    : [...form.finishes, finish],
                )
              }
            />
            {finish}
          </label>
        ))}
      </fieldset>

      {problems.length > 0 && (
        <ul className="admin-error zone-problems" data-testid={`zone-problems-${key}`}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="admin-form-actions">
        <button type="submit" disabled={state === 'saving'} data-testid={`zone-save-${key}`}>
          {state === 'saving' ? 'Saving…' : zone ? 'Save zone' : 'Add zone'}
        </button>
        {zone ? (
          <>
            <button
              type="button"
              disabled={state === 'checking' || !published}
              title={
                published
                  ? undefined
                  : 'The test pattern opens in the customer editor, which only shows published packs'
              }
              onClick={() => void check()}
              data-testid={`zone-check-${key}`}
              data-hydrated={hydrated || undefined}
            >
              {state === 'checking' ? 'Preparing…' : 'Check with test pattern'}
            </button>
            {draft && (
              <button
                type="button"
                className="danger"
                disabled={state === 'removing'}
                onClick={() => void remove()}
                data-testid={`zone-remove-${key}`}
              >
                {state === 'removing' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </>
        ) : (
          <button type="button" onClick={() => onClose?.(null)} data-testid="zone-cancel-new">
            Cancel
          </button>
        )}
        {state === 'saved' && (
          <span className="admin-ok" data-testid={`zone-saved-${key}`}>
            Saved
          </span>
        )}
        {zone && dirty && state === 'idle' && (
          <span className="zone-unsaved" data-testid={`zone-unsaved-${key}`}>
            Unsaved changes
          </span>
        )}
        {error && (
          <span className="admin-error" data-testid={`zone-error-${key}`}>
            {error}
          </span>
        )}
      </div>
      {zone && !published && (
        <small>
          The preview shows this zone&rsquo;s test pattern already. The full check opens in the
          customer editor, so it becomes available once the pack is published.
        </small>
      )}
    </form>
  );
}

/**
 * What the measurement of the zone against the part found.
 *
 * Each note says what is wrong with the numbers as entered and which control fixes it; none of them
 * proposes other numbers.
 */
function SurfaceNotes({ report, testId }: { report: SurfaceReport | null; testId: string }) {
  if (!report || report.centreMm === null) {
    return (
      <small className="admin-error" data-testid={testId}>
        {report?.facesInto
          ? 'This zone faces into the part — use "Face the other way".'
          : report?.surfaceVertices !== undefined
            ? 'No supported surface was found at the centre — adjust placement or projection depth.'
            : 'This zone’s centre is nowhere near the part’s surface.'}
      </small>
    );
  }
  const notes: string[] = [];
  if (report.centreMm > SURFACE_TOLERANCE_MM) {
    notes.push(`This zone's centre is ${report.centreMm.toFixed(1)} mm from the part's surface.`);
  }
  if (report.cornersOff > 0) {
    notes.push(
      report.surfaceVertices !== undefined
        ? `${report.cornersOff} of 4 corners are unsupported by the part's surface.`
        : `${report.cornersOff} of 4 corners ${report.cornersOff === 1 ? 'is' : 'are'} more than ${SURFACE_TOLERANCE_MM} mm off the part — it hangs over an edge.`,
    );
  }
  if (report.unsupportedVertices) {
    notes.push(
      `${report.unsupportedVertices} of ${report.surfaceVertices} surface samples are unsupported — adjust placement, size or projection depth.`,
    );
  }
  if (report.facesInto) {
    notes.push(
      'This zone faces into the part, so artwork would be pressed inwards — use "Face the other way".',
    );
  }
  if (notes.length === 0) {
    return (
      <small data-testid={testId}>
        On the surface: centre {report.centreMm.toFixed(2)} mm, all four corners on the part.
      </small>
    );
  }
  return (
    <small className="admin-error" data-testid={testId}>
      {notes.join(' ')}
    </small>
  );
}

function NumberField({
  label,
  value,
  onChange,
  testId,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
  hint?: string | undefined;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function VecField({
  label,
  values,
  onChange,
  onChoose,
  testId,
}: {
  label: string;
  values: Triple;
  onChange: (index: number, value: string) => void;
  /** Offers the six axis directions as one-click choices. */
  onChoose?: (value: Triple) => void;
  testId: string;
}) {
  return (
    <div className="zone-vec">
      <span className="zone-vec-label">{label}</span>
      <div className="zone-vec-inputs">
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <label key={axis}>
            <span>{axis}</span>
            <input
              type="number"
              step="any"
              value={values[index]}
              onChange={(e) => onChange(index, e.target.value)}
              data-testid={`${testId}-${axis.toLowerCase()}`}
            />
          </label>
        ))}
      </div>
      {onChoose && (
        <div className="zone-axis-choices">
          {AXIS_CHOICES.map((choice) => (
            <button
              key={choice.label}
              type="button"
              onClick={() => onChoose(choice.value.map(String) as Triple)}
              data-testid={`${testId}-${choice.label.replace('−', 'neg').replace('+', 'pos')}`}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the placement changed by more than the form's own rounding.
 *
 * The form shows four decimal places, so a frame stored with more would otherwise read as moved on
 * every save — refused on a zone designs use, and quietly rounded on one they do not.
 */
function moved(before: DecorationZoneDef, after: DecorationZoneDef): boolean {
  const a = numbersIn(frameOf(before));
  const b = numbersIn(frameOf(after));
  return a.length !== b.length || a.some((value, i) => Math.abs(value - b[i]!) > 1e-4);
}

const numbersIn = (value: unknown): number[] =>
  typeof value === 'number'
    ? [value]
    : value && typeof value === 'object'
      ? Object.keys(value)
          .sort()
          .flatMap((field) => numbersIn((value as Record<string, unknown>)[field]))
      : [];

function withoutKey(zone: DecorationZoneDef): Omit<DecorationZoneDef, 'key'> {
  const { key: _key, ...rest } = zone;
  return rest;
}
