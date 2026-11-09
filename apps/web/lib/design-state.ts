import type {
  DesignDocument,
  Finish,
  FinishKind,
  MaterialDefinition,
  Placement,
  Transform,
} from '@pr/design-schema';

/**
 * The bridge between the editor's working state and the stored Design Document.
 *
 * The document is what is persisted, rendered and validated; the editor keeps a flattened working
 * copy because that is what the panels bind to. Projecting between the two lives here — in one
 * tested place — rather than being scattered through the component, and a command stack (build
 * order G3) will replace the working copy without changing what gets stored.
 */

/** The finish controls, flattened: the panel edits relief and print settings side by side. */
export interface FinishState {
  kind: FinishKind;
  depthMm: number;
  bevelDeg: number;
  edgeRadiusMm: number;
  /** Material for a mark that carries ink or foil rather than being blind relief. */
  inkMaterialKey: string;
  inkHex: string;
  /** Relief only: fill the mark with `inkMaterialKey` instead of leaving it blind. */
  tintRelief: boolean;
}

export type SceneBackground = DesignDocument['scene']['background'];

export interface SlotAssignment {
  materialKey: string;
  /** Absent when the material is not colorizable — a printed board is whatever it is. */
  colorHex?: string;
  /** Tiling of the material's textures, relative to the material's authored size. */
  textureScale: number;
  textureRotationDeg: number;
}

/** The camera as the document stores it, minus the discriminator. */
export type CustomCamera = {
  positionMm: [number, number, number];
  targetMm: [number, number, number];
  upMm: [number, number, number];
  focalMm: number;
  sensorMm: number;
};

export interface EditorState {
  /** The zone key as the pack declares it, not the editor's list key. */
  zoneKey: string;
  transform: Transform;
  finish: FinishState;
  /** Colour for the first material slot; the panel edits one product colour in v1. */
  /**
   * One assignment per material slot the pack declares (F-MAT-01..04).
   *
   * Keyed by slot, not by material: a slot is a part of the product ("cap body", "liner"), and what
   * is on it is a choice. The editor used to model a single colour, which worked exactly as long as
   * every product had one part.
   */
  materials: Record<string, SlotAssignment>;
  cameraPresetKey: string;
  /**
   * A camera the customer framed by hand, or null to use the preset (F-SCENE-03).
   *
   * Resolved numbers rather than "the preset, orbited a bit": the renderer is given an explicit
   * camera and looks nothing up for itself, and a view worth saving is worth saving exactly. The
   * preset key is kept alongside so the buttons still show where this view came from, and so
   * clearing the override has something to go back to.
   */
  cameraCustom: CustomCamera | null;
  presentationOrientationOverride?: import('@pr/design-schema').OrientationFrame;
  /** Which curated studio lights the design; the same key reaches the renderer (F-SCENE-01). */
  environmentKey: string;
  /** What is behind the product in the preview and in the render (F-SCENE-04). */
  background: SceneBackground;
  artwork: { artworkId: string; versionId: string } | null;
}

export const PLACEMENT_ID = '55555555-5555-4555-8555-555555555555';

/** Collapses the finish controls into the discriminated union the document stores. */
export function finishToDocument(
  state: FinishState,
  materials?: Readonly<Record<string, MaterialDefinition>>,
): Finish {
  // A clear coating stores no tint. A spot varnish is not a colour somebody chose and then a
  // finish — it is the finish, and writing the swatch's leftover hex into the document would make
  // it paint the mark instead of glossing it. Absent `materials` nothing is clear, which keeps the
  // conversion pure for callers that only have the controls.
  const family = materials?.[state.inkMaterialKey]?.family;
  const clear = family === 'coating' || (state.kind !== 'print' && family === 'plastic');

  if (state.kind === 'print') {
    return {
      kind: 'print',
      inkMaterialKey: state.inkMaterialKey,
      ...(clear ? {} : { tintHex: state.inkHex }),
      opacity: 1,
    };
  }
  return {
    kind: state.kind,
    depthMm: state.depthMm,
    bevelDeg: state.bevelDeg,
    edgeRadiusMm: state.edgeRadiusMm,
    ...(state.tintRelief
      ? { inkMaterialKey: state.inkMaterialKey, ...(clear ? {} : { tintHex: state.inkHex }) }
      : {}),
  };
}

/**
 * Expands a stored finish back into the controls.
 *
 * Settings the stored finish has no room for — the depth of a design saved as print, say — come
 * from `fallback`, so switching print → deboss in a reopened design lands on sensible numbers
 * rather than on zero.
 */
export function finishFromDocument(finish: Finish, fallback: FinishState): FinishState {
  if (finish.kind === 'print') {
    return {
      ...fallback,
      kind: 'print',
      inkMaterialKey: finish.inkMaterialKey,
      inkHex: finish.tintHex ?? fallback.inkHex,
    };
  }
  return {
    ...fallback,
    kind: finish.kind,
    depthMm: finish.depthMm,
    bevelDeg: finish.bevelDeg,
    edgeRadiusMm: finish.edgeRadiusMm,
    tintRelief: finish.inkMaterialKey !== undefined,
    inkMaterialKey: finish.inkMaterialKey ?? fallback.inkMaterialKey,
    inkHex: finish.tintHex ?? fallback.inkHex,
  };
}

/** Reads the editor's working state out of a document. */
export function stateFromDocument(
  document: DesignDocument,
  fallback: Omit<EditorState, 'artwork'>,
): EditorState {
  const placement = document.placements[0];
  const camera = document.scene.camera;

  return {
    zoneKey: placement?.zoneKey ?? fallback.zoneKey,
    transform: placement?.transform ?? fallback.transform,
    finish: placement ? finishFromDocument(placement.finish, fallback.finish) : fallback.finish,
    materials: readAssignments(document, fallback.materials),
    cameraPresetKey: camera.kind === 'preset' ? camera.presetKey : fallback.cameraPresetKey,
    cameraCustom:
      camera.kind === 'custom'
        ? {
            positionMm: [...camera.positionMm] as [number, number, number],
            targetMm: [...camera.targetMm] as [number, number, number],
            upMm: [...camera.upMm] as [number, number, number],
            focalMm: camera.focalMm,
            sensorMm: camera.sensorMm,
          }
        : null,
    presentationOrientationOverride: document.scene.presentationOrientationOverride,
    environmentKey: document.scene.environmentKey || fallback.environmentKey,
    background: document.scene.background ?? fallback.background,
    artwork: placement?.artwork ?? null,
  };
}

/**
 * Writes the working state back into a document.
 *
 * Anything the editor does not model — annotations, additional placements, scene settings it does
 * not expose — is carried through untouched, so an older client cannot silently drop a field a
 * newer one wrote.
 */
export function documentFromState(
  base: DesignDocument,
  state: EditorState,
  library?: Readonly<Record<string, MaterialDefinition>>,
): DesignDocument {
  // Slots the editor knows about are written; any the pack declares but this editor did not show
  // keep whatever they had, so an older client cannot quietly strip a part off a product.
  const materials = { ...base.materials };
  for (const [slot, assignment] of Object.entries(state.materials)) {
    materials[slot] = {
      ...base.materials[slot],
      materialKey: assignment.materialKey,
      textureScale: assignment.textureScale,
      textureRotationDeg: assignment.textureRotationDeg,
      ...(assignment.colorHex ? { colorHex: assignment.colorHex } : {}),
    };
  }

  const placements: Placement[] = state.artwork
    ? [
        {
          id: base.placements[0]?.id ?? PLACEMENT_ID,
          order: base.placements[0]?.order ?? 0,
          zoneKey: state.zoneKey,
          artwork: state.artwork,
          transform: state.transform,
          // The library, so a clear coating is stored as one. This is the document that is
          // persisted and rendered: omit it here and the mark is saved with a tint it never had,
          // and the render paints what the editor showed clear.
          finish: finishToDocument(state.finish, library),
        },
      ]
    : [];

  return {
    ...base,
    materials,
    placements,
    scene: {
      ...base.scene,
      presentationOrientationOverride: state.presentationOrientationOverride,
      environmentKey: state.environmentKey,
      background: state.background,
      camera: state.cameraCustom
        ? { kind: 'custom', ...state.cameraCustom }
        : { kind: 'preset', presetKey: state.cameraPresetKey },
    },
  };
}

/** True when two documents differ in anything worth saving. */
export function documentsDiffer(a: DesignDocument, b: DesignDocument): boolean {
  return canonical(a) !== canonical(b);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The assignments a stored document carries, for the slots the editor is showing.
 *
 * A design saved before a pack gained a slot has nothing for it; the fallback supplies the pack's
 * own default, which is what the renderer would have used anyway.
 */
function readAssignments(
  document: DesignDocument,
  fallback: Record<string, SlotAssignment>,
): Record<string, SlotAssignment> {
  const assignments: Record<string, SlotAssignment> = {};

  for (const [slot, base] of Object.entries(fallback)) {
    const stored = document.materials[slot];
    assignments[slot] = stored
      ? {
          materialKey: stored.materialKey || base.materialKey,
          textureScale: stored.textureScale ?? base.textureScale,
          textureRotationDeg: stored.textureRotationDeg ?? base.textureRotationDeg,
          ...(stored.colorHex
            ? { colorHex: stored.colorHex }
            : base.colorHex
              ? { colorHex: base.colorHex }
              : {}),
        }
      : base;
  }

  return assignments;
}
