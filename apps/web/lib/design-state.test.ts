import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, DesignDocument } from '@pr/design-schema';
import {
  documentFromState,
  documentsDiffer,
  finishFromDocument,
  finishToDocument,
  PLACEMENT_ID,
  stateFromDocument,
  type EditorState,
  type FinishState,
} from './design-state.js';

/**
 * The projection between the editor's controls and the stored document.
 *
 * What is worth testing here is the round trip: whatever the user set must come back when the
 * design is reopened, and whatever the editor does not model must survive being saved by it.
 */

const finish: FinishState = {
  kind: 'deboss',
  depthMm: 0.35,
  bevelDeg: 30,
  edgeRadiusMm: 0.05,
  inkMaterialKey: 'foil-gold',
  inkHex: '#c9a227',
  tintRelief: false,
};

const state: EditorState = {
  zoneKey: 'top',
  environmentKey: 'studio-three-point',
  background: { kind: 'studio' },
  transform: {
    offsetMm: { x: 1.5, y: -2 },
    sizeMm: { w: 18, h: 9 },
    rotationDeg: 15,
    flipX: false,
    flipY: false,
    lockAspect: true,
  },
  finish,
  materials: {
    body: { materialKey: 'pp-matte', colorHex: '#1b4d3e', textureScale: 1, textureRotationDeg: 0 },
    liner: { materialKey: 'pp-gloss', colorHex: '#ffffff', textureScale: 1, textureRotationDeg: 0 },
  },
  cameraPresetKey: 'macro-logo',
  cameraCustom: null,
  artwork: {
    artworkId: '11111111-1111-4111-8111-111111111111',
    versionId: '22222222-2222-4222-8222-222222222222',
  },
};

const document = (): DesignDocument =>
  DesignDocument.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    units: 'mm',
    product: { packKey: 'cap-basic', packVersion: '1.0.0', productKey: 'cap-flat', variantKey: 'std' },
    materials: {
      body: { materialKey: 'pp-matte', textureScale: 1, textureRotationDeg: 0 },
      liner: { materialKey: 'pp-gloss', textureScale: 1, textureRotationDeg: 0 },
    },
    placements: [],
    scene: {
      environmentKey: 'studio-softbox',
      environmentRotationDeg: 0,
      exposureEv: 0,
      background: { kind: 'studio' },
      camera: { kind: 'preset', presetKey: 'three-quarter' },
    },
    annotations: {},
  });

describe('finish projection', () => {
  it('round-trips a blind relief', () => {
    expect(finishFromDocument(finishToDocument(finish), finish)).toEqual(finish);
  });

  it('round-trips a tinted relief, colour included', () => {
    const tinted = { ...finish, kind: 'emboss' as const, tintRelief: true, inkHex: '#ffcc00' };
    expect(finishFromDocument(finishToDocument(tinted), finish)).toEqual(tinted);
  });

  it('round-trips print', () => {
    const print = { ...finish, kind: 'print' as const, inkMaterialKey: 'ink-cmyk', inkHex: '#101010' };
    // `tintRelief` is meaningless for print and is not stored; the fallback supplies it.
    expect(finishFromDocument(finishToDocument(print), finish)).toEqual({ ...print, tintRelief: false });
  });

  it('keeps relief settings the stored finish had no room for', () => {
    const stored = finishToDocument({ ...finish, kind: 'print' });
    const restored = finishFromDocument(stored, { ...finish, depthMm: 0.42, bevelDeg: 45 });

    expect(restored.depthMm).toBe(0.42);
    expect(restored.bevelDeg).toBe(45);
  });

  it('produces a finish the schema accepts, for every kind', () => {
    for (const kind of ['emboss', 'deboss', 'print'] as const) {
      expect(() => DesignDocument.shape.placements.element.shape.finish.parse(
        finishToDocument({ ...finish, kind, tintRelief: kind !== 'print' }),
      )).not.toThrow();
    }
  });
});

describe('document projection', () => {
  it('round-trips the working state through a document', () => {
    const saved = documentFromState(document(), state);
    const reopened = stateFromDocument(saved, { ...state, zoneKey: 'skirt' });

    expect(reopened).toEqual(state);
  });

  it('writes the placement into the document', () => {
    const saved = documentFromState(document(), state);

    expect(saved.placements).toHaveLength(1);
    expect(saved.placements[0]).toMatchObject({
      id: PLACEMENT_ID,
      zoneKey: 'top',
      transform: state.transform,
      finish: { kind: 'deboss', depthMm: 0.35 },
    });
    expect(saved.materials['body']!.colorHex).toBe('#1b4d3e');
    expect(saved.scene.camera).toEqual({ kind: 'preset', presetKey: 'macro-logo' });
  });

  it('keeps the placement id a design was opened with', () => {
    const base = documentFromState(document(), state);
    const withOwnId = {
      ...base,
      placements: [{ ...base.placements[0]!, id: '99999999-9999-4999-8999-999999999999', order: 3 }],
    };

    const saved = documentFromState(withOwnId, { ...state, zoneKey: 'skirt' });
    expect(saved.placements[0]!.id).toBe('99999999-9999-4999-8999-999999999999');
    expect(saved.placements[0]!.order).toBe(3);
  });

  it('carries through everything the editor does not model', () => {
    const base = { ...document(), annotations: { note: 'approved by brand' } };
    const saved = documentFromState(base, state);

    expect(saved.annotations.note).toBe('approved by brand');
    expect(saved.product).toEqual(base.product);
    // Exposure is a scene field the panel does not expose, and it survives a save.
    expect(saved.scene.exposureEv).toBe(base.scene.exposureEv);
  });

  it('writes the studio and the background the editor is showing', () => {
    const saved = documentFromState(document(), {
      ...state,
      environmentKey: 'studio-sweep',
      background: { kind: 'solid', colorHex: '#ffffff' },
    });

    expect(saved.scene.environmentKey).toBe('studio-sweep');
    expect(saved.scene.background).toEqual({ kind: 'solid', colorHex: '#ffffff' });
  });

  it('reads them back, so a reopened design is lit as it was left', () => {
    const stored = documentFromState(document(), {
      ...state,
      environmentKey: 'studio-sweep',
      background: { kind: 'transparent' },
    });
    const reopened = stateFromDocument(stored, state);

    expect(reopened.environmentKey).toBe('studio-sweep');
    expect(reopened.background).toEqual({ kind: 'transparent' });
  });

  it('stores no placement when there is no artwork', () => {
    expect(documentFromState(document(), { ...state, artwork: null }).placements).toEqual([]);
  });

  it('falls back for anything an empty design cannot answer', () => {
    const reopened = stateFromDocument(document(), state);

    expect(reopened.zoneKey).toBe(state.zoneKey);
    expect(reopened.finish).toEqual(state.finish);
    expect(reopened.artwork).toBeNull();
    // The document's own camera wins over the fallback, because it has one.
    expect(reopened.cameraPresetKey).toBe('three-quarter');
  });

  it('produces a document the schema accepts', () => {
    expect(() => DesignDocument.parse(documentFromState(document(), state))).not.toThrow();
  });
});

describe('documentsDiffer', () => {
  it('ignores key order and absent optional fields', () => {
    const a = documentFromState(document(), state);
    const b = { ...documentFromState(document(), state), extra: undefined } as DesignDocument;

    expect(documentsDiffer(a, b)).toBe(false);
    expect(documentsDiffer(a, { ...a, materials: { ...a.materials } })).toBe(false);
  });

  it('notices a moved placement', () => {
    const a = documentFromState(document(), state);
    const b = documentFromState(document(), {
      ...state,
      transform: { ...state.transform, offsetMm: { x: 1.6, y: -2 } },
    });

    expect(documentsDiffer(a, b)).toBe(true);
  });

  it('notices a colour change', () => {
    const a = documentFromState(document(), state);
    const b = documentFromState(document(), {
      ...state,
      materials: { ...state.materials, body: { ...state.materials['body']!, colorHex: '#efe8dc' } },
    });

    expect(documentsDiffer(a, b)).toBe(true);
  });

  it('notices a different material on a slot, not only a different colour', () => {
    const a = documentFromState(document(), state);
    const b = documentFromState(document(), {
      ...state,
      materials: { ...state.materials, body: { ...state.materials['body']!, materialKey: 'pp-gloss' } },
    });

    expect(documentsDiffer(a, b)).toBe(true);
  });

  it('leaves a slot the editor was not shown exactly as it was', () => {
    const base = document();
    const saved = documentFromState(base, {
      ...state,
      materials: { body: state.materials['body']! },
    });

    expect(saved.materials['liner']).toEqual(base.materials['liner']);
  });
});

describe('a camera the customer framed themselves (F-SCENE-03)', () => {
  const custom = {
    positionMm: [100, 80, 120] as [number, number, number],
    targetMm: [0, 9, 0] as [number, number, number],
    upMm: [0, 1, 0] as [number, number, number],
    focalMm: 120,
    sensorMm: 36,
  };

  it('is written to the document as explicit numbers, not as a nudged preset', () => {
    // The renderer looks nothing up for itself, so a saved view has to be the whole camera.
    const saved = documentFromState(document(), { ...state, cameraCustom: custom });

    expect(saved.scene.camera).toEqual({ kind: 'custom', ...custom });
  });

  it('comes back on reload, which is the whole point of saving it', () => {
    const saved = documentFromState(document(), { ...state, cameraCustom: custom });
    expect(stateFromDocument(saved, state).cameraCustom).toEqual(custom);
  });

  it('gives way to the preset once the override is cleared', () => {
    const saved = documentFromState(document(), {
      ...state,
      cameraCustom: null,
      cameraPresetKey: 'top',
    });

    expect(saved.scene.camera).toEqual({ kind: 'preset', presetKey: 'top' });
  });

  it('keeps the preset it came from, so the buttons still mean something', () => {
    const saved = documentFromState(document(), { ...state, cameraCustom: custom });
    const reloaded = stateFromDocument(saved, { ...state, cameraPresetKey: 'macro-logo' });

    expect(reloaded.cameraPresetKey).toBe('macro-logo');
    expect(reloaded.cameraCustom).toEqual(custom);
  });

  it('counts as a change worth saving', () => {
    const withPreset = documentFromState(document(), state);
    const withCustom = documentFromState(document(), { ...state, cameraCustom: custom });

    expect(documentsDiffer(withPreset, withCustom)).toBe(true);
  });
});
