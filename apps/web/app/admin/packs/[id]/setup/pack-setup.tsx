'use client';

import { useEffect, useState } from 'react';
import type { CadJob } from '@pr/cad-jobs';
import { JobLog } from '@/components/job-log';
import { useRouter } from 'next/navigation';
import type { AuthoringVariant, PackAuthoring } from '@pr/catalog';
import type { MaterialDefinition, OrientationFrame } from '@pr/design-schema';
import { finishOf } from '@pr/design-schema';
import { OrientationWizard } from '@/components/orientation-wizard';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { VariantZones } from '../zones/variant-zones';

export function PackSetup({
  pack,
  variant,
  materials,
  meshUrl,
  initialStep,
  ingestion,
}: {
  ingestion: CadJob | null;
  pack: PackAuthoring;
  variant: AuthoringVariant;
  materials: Record<string, MaterialDefinition>;
  meshUrl: string;
  initialStep: number;
}) {
  const router = useRouter();
  const [revision, setRevision] = useState(pack.revision);
  const [dirtyZones, setDirtyZones] = useState(false);

  const initialDefaults = Object.fromEntries(
    variant.materialSlots.map((s) => [s.key, s.defaultMaterialKey]),
  );
  const [defaults, setDefaults] = useState(initialDefaults);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const [materialBusy, setMaterialBusy] = useState(false);
  const [savedDefaults, setSavedDefaults] = useState(initialDefaults);
  const dirtyMaterials = JSON.stringify(defaults) !== JSON.stringify(savedDefaults);
  const guard = useUnsavedGuard(
    dirtyMaterials,
    'Material defaults have changes that are not saved.',
  );
  useEffect(() => {
    setRevision(pack.revision);
  }, [pack.revision]);
  const patch = async (body: {
    orientation?: OrientationFrame & { confirmed: boolean };
    materialDefaults?: Record<string, string>;
  }) => {
    const response = await fetch(`/api/admin/packs/${pack.id}/setup`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productKey: variant.productKey,
        variantKey: variant.variantKey,
        revision,
        ...body,
      }),
    });
    const payload = (await response.json()) as { revision?: string; error?: { detail?: string } };
    if (!response.ok || !payload.revision)
      throw new Error(payload.error?.detail ?? 'Product setup could not be saved. Retry.');
    setRevision(payload.revision);
    router.refresh();
  };
  return (
    <>
      {guard}
      <OrientationWizard
        key={`${variant.productKey}/${variant.variantKey}`}
        title={variant.productName}
        scope="product"
        confirmed={variant.presentationOrientation?.confirmed ?? false}
        initialFrame={variant.presentationOrientation}
        initialStep={initialStep}
        meshUrl={meshUrl}
        bboxMm={variant.bboxMm}
        materials={materials}
        assignments={Object.fromEntries(
          variant.materialSlots.map((s) => [
            s.key,
            {
              materialKey: defaults[s.key] ?? s.defaultMaterialKey,
              textureScale: 1,
              textureRotationDeg: 0,
            },
          ]),
        )}
        decoratedSlot={variant.materialSlots[0]?.key ?? 'body'}
        exitHref="/admin/packs"
        breadcrumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'CAD imports', href: '/admin/cad' },
          { label: variant.productName },
        ]}
        importSummary={
          <>
            <p>
              {pack.name} · {pack.key}@{pack.version} · {variant.variantName}
            </p>
            <p>
              Source dimensions:{' '}
              {variant.bboxMm[1].map((n, i) => (n - variant.bboxMm[0][i]!).toFixed(1)).join(' × ')}{' '}
              mm.
            </p>
            <ImportDiagnostics job={ingestion} />
          </>
        }
        zonesContent={
          <>
            {pack.variants.length > 1 && (
              <nav className="setup-variant-links">
                {pack.variants.map((v) => (
                  <a
                    key={`${v.productKey}/${v.variantKey}`}
                    href={`/admin/packs/${pack.id}/setup?product=${encodeURIComponent(v.productKey)}&variant=${encodeURIComponent(v.variantKey)}`}
                  >
                    {v.productName} · {v.variantName}
                    {v.presentationOrientation?.confirmed ? ' ✓' : ' · orientation needed'}
                  </a>
                ))}
              </nav>
            )}
            <VariantZones
              packId={pack.id}
              variant={variant}
              draft
              published={false}
              onDirtyChange={setDirtyZones}
            />
            <section className="setup-materials">
              <h2>Material defaults</h2>
              <p>
                Choose real materials for each product slot. These defaults do not alter the CAD
                geometry.
              </p>
              {variant.materialSlots
                .filter((s) => s.key !== 'liner')
                .map((slot) => (
                  <label key={slot.key}>
                    {slot.label}
                    <select
                      value={defaults[slot.key]}
                      onChange={(e) =>
                        setDefaults((current) => ({ ...current, [slot.key]: e.target.value }))
                      }
                      data-testid={`setup-material-${slot.key}`}
                    >
                      <option value={slot.defaultMaterialKey}>
                        {materials[slot.defaultMaterialKey]?.name ?? slot.defaultMaterialKey}
                      </option>
                      {Object.values(materials)
                        .filter(
                          (m) =>
                            m.key !== slot.defaultMaterialKey &&
                            (!slot.allowedFamilies.length ||
                              slot.allowedFamilies.includes(m.family)) &&
                            (!slot.allowedFinishes.length ||
                              slot.allowedFinishes.includes(finishOf(m))),
                        )
                        .map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              {materialError && <p className="admin-error">{materialError}</p>}
              <button
                disabled={materialBusy || !dirtyMaterials}
                onClick={async () => {
                  setMaterialBusy(true);
                  setMaterialError(null);
                  try {
                    await patch({
                      materialDefaults: Object.fromEntries(
                        Object.entries(defaults).filter(
                          ([key, value]) => key !== 'liner' && savedDefaults[key] !== value,
                        ),
                      ),
                    });
                    setSavedDefaults(defaults);
                  } catch (e) {
                    setMaterialError(
                      e instanceof Error ? e.message : 'Materials could not be saved.',
                    );
                  } finally {
                    setMaterialBusy(false);
                  }
                }}
              >
                Save material defaults
              </button>
              <a href="/admin/materials">Material library</a>
            </section>
          </>
        }
        reviewContent={
          <>
            <p>
              {pack.key}@{pack.version} · {variant.variantName}
            </p>
            <p>
              {variant.zones.length} decoration zone(s):{' '}
              {variant.zones.map((z) => z.name).join(', ') || 'none configured'}.
            </p>
            <ul>
              {variant.materialSlots
                .filter((s) => s.key !== 'liner')
                .map((s) => (
                  <li key={s.key}>
                    {s.label}: {materials[defaults[s.key] ?? '']?.name ?? defaults[s.key]}
                  </li>
                ))}
            </ul>
            {dirtyMaterials && (
              <p className="admin-error">
                Return to Decoration zones and save material defaults before publishing.
              </p>
            )}
            <ImportDiagnostics job={ingestion} />
            <p>Existing designs stay pinned to their current product version.</p>
          </>
        }
        zonesDirty={dirtyMaterials || dirtyZones}
        onStepChange={(step) => {
          const url = new URL(window.location.href);
          url.searchParams.set('step', ['import', 'orientation', 'zones', 'review'][step]!);
          window.history.replaceState(null, '', url);
        }}
        finalLabel="Publish product version"
        onConfirm={(frame) => patch({ orientation: { ...frame, confirmed: true } })}
        onFinish={async () => {
          if (dirtyMaterials) throw new Error('Save material defaults before publishing.');
          const response = await fetch(`/api/admin/packs/${pack.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'published' }),
          });
          if (!response.ok) {
            const payload = (await response.json()) as { error?: { detail?: string } };
            throw new Error(payload.error?.detail ?? 'This version could not be published.');
          }
          router.push('/admin/packs');
          router.refresh();
        }}
      />
    </>
  );
}

function ImportDiagnostics({ job }: { job: CadJob | null }) {
  if (!job?.result)
    return (
      <p>
        Source import diagnostics are unavailable for this pack in your organization.{' '}
        <a href="/admin/cad">View CAD imports</a>
      </p>
    );
  const result = job.result;
  const openParts = result.parts.filter((part) => !part.watertight);
  return (
    <section className="setup-diagnostics" data-testid="setup-diagnostics">
      <h3>Import diagnostics</h3>
      <p>
        {job.sourceName ?? 'Uploaded CAD file'} · {job.format.toUpperCase()} · {result.importerId}{' '}
        {result.importerVersion}
      </p>
      <p>
        Pipeline {job.pipelineVersion} · {result.parts.length} part(s) ·{' '}
        {result.meshes.reduce((total, mesh) => total + mesh.triangles, 0).toLocaleString()}{' '}
        triangles.
      </p>
      {result.unitAssumed && (
        <p className="setup-warning">
          Source units were assumed during import. Check the physical dimensions.
        </p>
      )}
      {openParts.length > 0 && (
        <p className="setup-warning">
          {openParts.length} part(s) are open surfaces rather than closed solids. Inspect the
          geometry before publishing.
        </p>
      )}
      {result.repairs.length > 0 ? (
        <ul>
          {result.repairs.map((repair, i) => (
            <li key={i}>
              {repair.kind.replaceAll('_', ' ')} × {repair.count}
              {repair.detail ? ` · ${repair.detail}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p>No kernel repairs were recorded.</p>
      )}
      <JobLog endpoint={`/api/admin/cad/${job.id}`} testId="setup-import-log" />
    </section>
  );
}
