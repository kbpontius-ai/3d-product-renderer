'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MaterialRecord } from '@pr/catalog';
import type { MaterialDefinition } from '@pr/design-schema';
import { MaterialPreview } from './material-preview';

/**
 * One material: what it looks like, what it is made of, and what it would change.
 *
 * The preview updates as the sliders move, before anything is saved — judging a roughness value by
 * reading it is not a thing anyone can do. Saving is separate and says how many designs use the
 * material, because they will all look different afterwards.
 */

const SLOTS = ['baseColor', 'roughness', 'metallic', 'normal', 'ao', 'height'] as const;

const clamp = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;

const NUMBERS = [
  { key: 'roughness', label: 'Roughness', max: 1, step: 0.01 },
  { key: 'metallic', label: 'Metallic', max: 1, step: 0.01 },
  { key: 'clearcoat', label: 'Clearcoat', max: 1, step: 0.01 },
  { key: 'clearcoatRoughness', label: 'Clearcoat roughness', max: 1, step: 0.01 },
  { key: 'sheen', label: 'Sheen', max: 1, step: 0.01 },
  { key: 'transmission', label: 'Transmission', max: 1, step: 0.01 },
] as const;

export function MaterialCard({
  material,
  previewOpen,
  onTogglePreview,
}: {
  material: MaterialRecord;
  previewOpen: boolean;
  onTogglePreview: () => void;
}) {
  const router = useRouter();
  const [definition, setDefinition] = useState<MaterialDefinition>(material.definition);
  const [name, setName] = useState(material.name);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const dirty =
    name !== material.name || JSON.stringify(definition) !== JSON.stringify(material.definition);

  const setBase = (key: string, value: number | string) => {
    setState('idle');
    setDefinition((current) => ({ ...current, base: { ...current.base, [key]: value } }));
  };

  const save = async () => {
    setState('saving');
    setError(null);
    const response = await fetch(`/api/admin/materials/${material.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, definition }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: { detail?: string } };
      setError(body.error?.detail ?? 'that change was refused');
      setState('idle');
      return;
    }
    setState('saved');
    router.refresh();
  };

  const uploadTexture = async (slot: (typeof SLOTS)[number], file: File) => {
    setError(null);
    const response = await fetch(`/api/admin/materials/${material.id}/texture?slot=${slot}`, {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: file,
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: { detail?: string } };
      setError(body.error?.detail ?? 'that texture was refused');
      return;
    }
    const updated = (await response.json()) as MaterialRecord;
    setDefinition(updated.definition);
    router.refresh();
  };

  const maps = definition.maps as Record<string, { path?: string } | number | undefined>;

  return (
    <div className="material-card" data-testid={`material-${material.key}`}>
      {previewOpen ? (
        <MaterialPreview definition={definition} />
      ) : (
        <button
          type="button"
          className="material-preview-stub"
          style={{ background: definition.base.baseColorHex }}
          onClick={onTogglePreview}
          data-testid={`material-preview-${material.key}`}
        >
          Preview
        </button>
      )}

      <div className="material-body">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid={`material-name-${material.key}`} />
          <small>
            <code>{material.key}</code> · {material.origin} · used by {material.usedByDesigns} design
            {material.usedByDesigns === 1 ? '' : 's'}
          </small>
        </label>

        <label>
          Base color
          <input
            type="color"
            value={definition.base.baseColorHex}
            onChange={(e) => setBase('baseColorHex', e.target.value)}
            data-testid={`material-color-${material.key}`}
          />
        </label>

        {NUMBERS.map((field) => (
          <label key={field.key}>
            {field.label}
            {/* Slider to feel it, number to mean it: an operator matching a spec sheet has a
                figure in mind, and dragging to 0.62 is not something a mouse can do. */}
            <span className="material-slider">
              <input
                type="range"
                min={0}
                max={field.max}
                step={field.step}
                value={Number(definition.base[field.key] ?? 0)}
                onChange={(e) => setBase(field.key, Number(e.target.value))}
                data-testid={`material-${field.key}-slider-${material.key}`}
              />
              <input
                type="number"
                min={0}
                max={field.max}
                step={field.step}
                value={Number(definition.base[field.key] ?? 0)}
                onChange={(e) => setBase(field.key, clamp(Number(e.target.value), field.max))}
                data-testid={`material-${field.key}-${material.key}`}
              />
            </span>
          </label>
        ))}

        <details>
          <summary>Textures</summary>
          {SLOTS.map((slot) => {
            const current = maps[slot];
            const path = current && typeof current === 'object' ? current.path : undefined;
            return (
              <label key={slot} className="material-texture">
                {slot}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadTexture(slot, file);
                  }}
                />
                {path && <small>{path.split('/').pop()}</small>}
              </label>
            );
          })}
        </details>

        <div className="admin-form-actions">
          <button type="button" disabled={!dirty || state === 'saving'} onClick={() => void save()} data-testid={`material-save-${material.key}`}>
            {state === 'saving' ? 'Saving…' : 'Save'}
          </button>
          {state === 'saved' && (
            <span className="admin-ok" data-testid={`material-saved-${material.key}`}>
              Saved
            </span>
          )}
          {material.usedByDesigns > 0 && dirty && (
            <span className="auth-sub">{material.usedByDesigns} design(s) will change.</span>
          )}
          {error && <span className="admin-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
