'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AuthoringVariant } from '@pr/catalog';
import type { Vec3 } from '@pr/design-schema';
import { buildMeshIndex, length, normalize, sub, add, type MeshIndex } from '@pr/placement';
import { buildZoneSurface } from '@/lib/zone-surface';
import { assetHref } from '@/lib/asset-url';
import { collectDecoratedGeometry } from '@/lib/mesh-arrays';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import {
  fmt,
  surfaceReport,
  type AuthorableZoneType,
  type SurfaceReport,
} from '@/lib/zone-authoring';
import { ZoneForm, type Candidate, type SurfacePick } from './zone-form';
import type { PreviewZone } from './zone-preview';

/** WebGL only exists in the browser, and the page is rendered on the server first. */
const ZonePreview = dynamic(() => import('./zone-preview').then((m) => m.ZonePreview), {
  ssr: false,
  // The viewer's own code can take a moment on a slow connection; say so rather than show an empty box.
  loading: () => (
    <div className="zone-preview">
      <p className="auth-sub zone-preview-waiting" data-testid="zone-preview-loading-viewer">
        <span className="loading-stack">
          <LoadingSpinner />
          Loading the 3D preview…
        </span>
      </p>
    </div>
  ),
});

const NEW = 'new';

type PickKind = 'point' | 'rim';

/**
 * One variant's zones, beside the part they sit on (F-ADM-13, F-ADM-14).
 *
 * Owns what the forms share: the loaded mesh, which zone is being worked on, what each form says
 * right now (so the preview draws edits before they are saved), which forms have unsaved changes,
 * and which form a click on the part belongs to.
 */
export function VariantZones({
  packId,
  variant,
  draft,
  published,
  onDirtyChange,
}: {
  packId: string;
  variant: AuthoringVariant;
  draft: boolean;
  published: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const part = usePartMesh(
    variant.meshKey,
    variant.materialSlots.map((slot) => slot.key),
  );
  const [activeKey, setActiveKey] = useState<string | null>(variant.zones[0]?.key ?? null);
  const [adding, setAdding] = useState<AuthorableZoneType | null>(null);
  const [candidates, setCandidates] = useState<Record<string, Candidate>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [picking, setPicking] = useState<{
    key: string;
    kind: PickKind;
    points: Vec3[];
    normals: Vec3[];
  } | null>(null);
  const [pick, setPick] = useState<(SurfacePick & { key: string }) | null>(null);
  const seq = useRef(0);

  const zoneKeys = variant.zones.map((zone) => zone.key).join('|');
  useEffect(() => {
    // A zone that was removed leaves nothing to point at.
    const live = new Set([NEW, ...zoneKeys.split('|')]);
    setCandidates((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => live.has(key))),
    );
    setDirty((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => live.has(key))),
    );
  }, [zoneKeys]);

  const hasChanges = Object.values(dirty).some(Boolean);
  useEffect(() => {
    onDirtyChange?.(hasChanges);
  }, [hasChanges, onDirtyChange]);

  const leaveGuard = useUnsavedGuard(
    Object.values(dirty).some(Boolean),
    'Some zones have changes that are not saved. Leave without saving them?',
  );

  // Escape leaves pick mode, the way it leaves every other mode people are used to.
  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPicking(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);

  const candidateFor = useCallback(
    (key: string) => (candidate: Candidate) =>
      setCandidates((current) =>
        current[key]?.zone === candidate.zone && current[key]?.marker === candidate.marker
          ? current
          : { ...current, [key]: candidate },
      ),
    [],
  );
  const dirtyFor = useCallback(
    (key: string) => (isDirty: boolean) =>
      setDirty((current) => (current[key] === isDirty ? current : { ...current, [key]: isDirty })),
    [],
  );

  const names = useMemo(
    () => Object.fromEntries(variant.zones.map((zone) => [zone.key, zone.name])),
    [variant.zones],
  );

  const shown: PreviewZone[] = useMemo(
    () =>
      Object.entries(candidates)
        .filter(([key, candidate]) => candidate.zone !== null && (key !== NEW || adding !== null))
        .map(([key, candidate]) => ({
          key,
          name: candidate.zone!.name || names[key] || 'New zone',
          zone: candidate.zone!,
          active: key === activeKey,
        })),
    [candidates, activeKey, adding, names],
  );

  const surfaces = useMemo(() => {
    const out: Record<string, ReturnType<typeof buildZoneSurface>> = {};
    for (const { key, zone } of shown) {
      const mesh = part.indices[zone.materialSlotKey ?? variant.materialSlots[0]?.key ?? ''];
      if (zone.type === 'conformal' && mesh) out[key] = buildZoneSurface(zone, mesh);
    }
    return out;
  }, [shown, part.indices, variant.materialSlots]);

  /** Where each zone sits against the actual part: a measurement of what was entered, nothing more. */
  const reports = useMemo(() => {
    const out: Record<string, SurfaceReport | null> = {};
    if (!part.index) return out;
    const reach = length(sub(variant.bboxMm[1], variant.bboxMm[0])) * 2;
    for (const { key, zone } of shown) {
      try {
        out[key] =
          zone.type === 'conformal'
            ? (surfaces[key]?.report ?? null)
            : surfaceReport(zone, part.index, reach);
      } catch {
        out[key] = null;
      }
    }
    return out;
  }, [part.index, shown, variant.bboxMm, surfaces]);

  const onPick = (pointMm: Vec3, faceNormal: Vec3) => {
    if (!picking) return;
    // The mesh's own smoothed normal where it has one, so a click on a gently curved face does
    // not take the tilt of whichever facet happened to be under the cursor.
    const normal = part.index?.nearestSurface(pointMm, 0.5)?.normal ?? faceNormal;

    if (picking.kind === 'rim') {
      const points = [...picking.points, pointMm];
      const normals = [...picking.normals, normal];
      if (points.length < 3) {
        setPicking({ ...picking, points, normals });
        return;
      }
      const average = normals.reduce((sum, n) => add(sum, n), [0, 0, 0] as Vec3);
      seq.current += 1;
      setPick({
        key: picking.key,
        seq: seq.current,
        kind: 'rim',
        points: points as [Vec3, Vec3, Vec3],
        normal: length(average) > 1e-9 ? normalize(average) : normal,
      });
      setPicking(null);
      return;
    }

    seq.current += 1;
    setPick({ key: picking.key, seq: seq.current, kind: 'point', points: [pointMm], normal });
    setPicking(null);
  };

  const select = (key: string) => {
    setActiveKey(key);
    document
      .querySelector(`[data-testid="zone-${key}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const formProps = (key: string) => ({
    packId,
    productKey: variant.productKey,
    variantKey: variant.variantKey,
    variantId: variant.variantId,
    materialSlots: variant.materialSlots,
    draft,
    published,
    active: activeKey === key,
    report: part.index ? (reports[key] ?? null) : undefined,
    picking: picking?.key === key ? picking.kind : (false as const),
    pick: pick?.key === key ? pick : null,
    onActivate: () => setActiveKey(key),
    onCandidate: candidateFor(key),
    onDirty: dirtyFor(key),
    onStartPick: (kind: PickKind | null) => {
      setActiveKey(key);
      setPicking(kind ? { key, kind, points: [], normals: [] } : null);
    },
  });

  const [min, max] = variant.bboxMm;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const activeCandidate = activeKey ? candidates[activeKey] : undefined;

  return (
    <section className="zone-variant" data-testid={`variant-${variant.variantKey}`}>
      {leaveGuard}
      <header>
        <a
          className="button"
          href={`/admin/packs/${packId}/setup?step=orientation&product=${encodeURIComponent(variant.productKey)}&variant=${encodeURIComponent(variant.variantKey)}`}
        >
          {variant.presentationOrientation?.confirmed ? 'Reorient product' : 'Set orientation'}
        </a>
        <h2>
          {variant.productName} — {variant.variantName}
        </h2>
        <p className="auth-sub" data-testid={`variant-facts-${variant.variantKey}`}>
          Measured {size.map((n) => fmt(n)).join(' × ')} mm · bounding box (
          {min.map(fmt).join(', ')}) → ({max.map(fmt).join(', ')}). All numbers are millimetres in
          the part&rsquo;s own coordinates.
        </p>
      </header>

      <div className="zone-authoring">
        <div className="zone-authoring-preview">
          {variant.meshKey && !part.scene && !part.error ? (
            <div className="zone-preview">
              <p className="auth-sub zone-preview-waiting" data-testid="zone-preview-loading">
                <span className="loading-stack">
                  <LoadingSpinner />
                  Loading the part…
                </span>
              </p>
            </div>
          ) : variant.meshKey ? (
            <ZonePreview
              scene={part.scene}
              surfaces={surfaces}
              bboxMm={variant.bboxMm}
              zones={shown}
              marker={activeCandidate?.zone ? null : (activeCandidate?.marker ?? null)}
              pickedPoints={picking?.points ?? []}
              picking={picking?.kind ?? false}
              onPick={onPick}
              onSelect={select}
            />
          ) : (
            <p className="auth-sub">
              This pack has no stored mesh for this variant, so there is nothing to preview.
            </p>
          )}
          {part.error && <p className="admin-error">The part could not be loaded: {part.error}</p>}
        </div>

        <div className="zone-authoring-forms">
          {variant.zones.length === 0 && adding === null && (
            <p className="auth-sub" data-testid="zones-empty">
              No zones yet, so nothing can be placed on this part.{' '}
              {draft ? 'Add one below.' : 'Make a new draft version to add one.'}
            </p>
          )}

          {variant.zones.map((zone) => (
            <ZoneForm key={zone.key} {...formProps(zone.key)} zone={zone} />
          ))}

          {adding !== null && (
            <ZoneForm
              key={`new-${adding}`}
              {...formProps(NEW)}
              zone={null}
              newType={adding}
              onClose={(addedKey) => {
                setAdding(null);
                setPicking(null);
                setCandidates((current) => ({ ...current, [NEW]: { zone: null, marker: null } }));
                setDirty((current) => ({ ...current, [NEW]: false }));
                setActiveKey(addedKey);
              }}
            />
          )}

          {draft && adding === null && (
            <div className="zone-add" data-testid={`add-zone-${variant.variantKey}`}>
              <button
                type="button"
                onClick={() => {
                  setAdding('conformal');
                  setActiveKey(NEW);
                }}
                data-testid="add-zone"
              >
                Add zone
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const EMPTY_INDICES: Record<string, MeshIndex> = {};

function usePartMesh(
  meshKey: string | null,
  slots: string[],
): {
  scene: THREE.Object3D | null;
  index: MeshIndex | null;
  indices: Record<string, MeshIndex>;
  error: string | null;
} {
  const [loaded, setLoaded] = useState<{
    scene: THREE.Object3D;
    index: MeshIndex | null;
    indices: Record<string, MeshIndex>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const slotKeys = slots.join('|');
  useEffect(() => {
    if (!meshKey) return;
    let cancelled = false;
    new GLTFLoader()
      .loadAsync(assetHref(meshKey))
      .then((gltf) => {
        if (cancelled) return;
        const scene = gltf.scene;
        const material = new THREE.MeshStandardMaterial({
          color: '#c9c6c4',
          roughness: 0.75,
          metalness: 0,
        });
        const indices: Record<string, MeshIndex> = {};
        const slots = slotKeys.split('|');
        for (const slot of slots) {
          const arrays = collectDecoratedGeometry(
            scene,
            new Set(slots.filter((key) => key !== slot)),
          );
          if (arrays) indices[slot] = buildMeshIndex(arrays);
        }
        const arrays = collectDecoratedGeometry(scene, new Set());
        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) mesh.material = material;
        });
        setLoaded({ scene, index: arrays ? buildMeshIndex(arrays) : null, indices });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [meshKey, slotKeys]);

  return {
    scene: loaded?.scene ?? null,
    index: loaded?.index ?? null,
    indices: loaded?.indices ?? EMPTY_INDICES,
    error,
  };
}
