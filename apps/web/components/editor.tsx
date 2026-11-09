'use client';

import { ArchiveBanner } from './archive-banner';
import { useDesignArchive } from '@/lib/use-design-archive';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtworkStats, MaterialDefinition, Placement, Transform, RenderLighting } from '@pr/design-schema';
import { finishOf } from '@pr/design-schema';
import type { FinishParams } from '@pr/artwork';
import {
  aabb,
  fitSize,
  initialTransform,
  validatePlacement,
  type Guide,
  type Issue,
} from '@pr/placement';
import { inkShading } from '@pr/materials';
import {
  DEFAULT_ENVIRONMENT_KEY,
  ENVIRONMENTS,
  crossSectionPlanes,
  effectiveOrientation,
  boundingSphere,
  framePreset,
  IMPORTED_FRAME,
} from '@pr/scene';
import dynamic from 'next/dynamic';
import { readPreparationFile } from '@/lib/artwork-preparation-file';
import type { PreparationEntry } from '@/components/artwork-preparation';
const ArtworkPreparation = dynamic(
  () => import('@/components/artwork-preparation').then((module) => module.ArtworkPreparation),
  { ssr: false },
);

import { OrientationWizard } from '@/components/orientation-wizard';
import { inspectionFrame } from '@/lib/orientation-view';
import { ArtworkLibrary } from '@/components/artwork-library';
import { FaceViewCanvas } from '@/components/face-view-canvas';
import { RenderPanel } from '@/components/render-panel';
import { SnapshotButton } from '@/components/snapshot-button';
import { Viewport3D, type ZoneLayers } from '@/components/viewport-3d';
import { LoadingSpinner } from '@/components/loading-spinner';
import { PlacementColorSample } from '@/components/placement-color-sample';
import {
  documentFromState,
  finishToDocument,
  stateFromDocument,
  PLACEMENT_ID,
  type CustomCamera,
  type EditorState,
  type FinishState,
  type SceneBackground,
  type SlotAssignment,
} from '@/lib/design-state';
import type { EditorArtwork, EditorZone } from '@/lib/fixtures';
import {
  heightArtwork,
  heightLayerRangeMm,
  HEIGHT_LAYER_RANGE_MM,
  inkArtwork,
  shadeArtwork,
} from '@/lib/shade';
import { useArtwork } from '@/lib/use-artwork';
import { useDesignThumbnail } from '@/lib/use-thumbnail';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';
import { useEditorHistory } from '@/lib/use-editor-history';
import { useHydrated } from '@/lib/use-hydrated';
import { SAVE_LABELS, useDesignSave, type DesignBinding } from '@/lib/use-design-save';
import { drawZoneTexture, zoneTexelSizeMm } from '@/lib/zone-texture';

export interface EditorProps {
  zones: EditorZone[];
  materials: Record<string, MaterialDefinition>;
  artwork: EditorArtwork;
  colorways: readonly { key: string; label: string; hex: string }[];
  /** Absent for the demo route: the editor then runs entirely in the browser and saves nothing. */
  design?: DesignBinding;
  subtitle?: string;
  /**
   * Other variants of the same product, if the pack ships any (F-CAT-04).
   *
   * Switching carries the placement over where the target declares the same zone, which is what
   * makes a size range a range rather than a set of unrelated products.
   */
  siblings?: { variantId: string; key: string; name: string }[];
}

type Mode = 'place' | 'look' | 'split';

/** A stable empty array, so a zone with no guides does not re-render the canvas every frame. */
const EMPTY_GUIDES: Guide[] = [];

/**
 * Alignment actions (F-PLACE-10).
 *
 * Against the safe area rather than the zone's outer edge: "align left" means where artwork may
 * actually go, and putting a logo flush with a boundary the tooling cannot hold is not what anyone
 * means by aligning it.
 */
const ALIGNMENTS = [
  { key: 'left', label: '⇤', title: 'Align to the left of the safe area' },
  { key: 'centre-h', label: '↔', title: 'Center horizontally' },
  { key: 'right', label: '⇥', title: 'Align to the right of the safe area' },
  { key: 'top', label: '⇡', title: 'Align to the top of the safe area' },
  { key: 'centre-v', label: '↕', title: 'Center vertically' },
  { key: 'bottom', label: '⇣', title: 'Align to the bottom of the safe area' },
] as const;

type Alignment = (typeof ALIGNMENTS)[number]['key'];

function align(
  transform: Transform,
  action: Alignment,
  zone: { w: number; h: number; safeMarginMm: number },
): Transform {
  // The rotated artwork's own footprint, so aligning a tilted logo still puts its edge on the line.
  const box = aabb(transform);
  const halfW = (box.max.x - box.min.x) / 2;
  const halfH = (box.max.y - box.min.y) / 2;
  const limitX = Math.max(0, zone.w / 2 - zone.safeMarginMm - halfW);
  const limitY = Math.max(0, zone.h / 2 - zone.safeMarginMm - halfH);
  const offset = { ...transform.offsetMm };

  switch (action) {
    case 'left':
      offset.x = -limitX;
      break;
    case 'right':
      offset.x = limitX;
      break;
    case 'centre-h':
      offset.x = 0;
      break;
    case 'top':
      // Zone space is +y up, so the top of the face is the positive limit.
      offset.y = limitY;
      break;
    case 'bottom':
      offset.y = -limitY;
      break;
    case 'centre-v':
      offset.y = 0;
      break;
  }

  return { ...transform, offsetMm: offset };
}

/**
 * Stands in for a real artwork id while the sample is on screen.
 *
 * `validatePlacement` needs a placement, and a placement names an artwork. Nothing is saved with
 * this id: a design without stored artwork stores no placement at all.
 */
const PREVIEW_ARTWORK_REF = {
  artworkId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
};

const EMPTY_LAYERS: ZoneLayers = {
  height: null,
  ink: null,
  texelMm: { x: 1, y: 1 },
  heightRangeMm: HEIGHT_LAYER_RANGE_MM,
  inkRoughness: 0.5,
  inkMetalness: 0,
  inkTint: 1,
  inkFromHeight: 0,
};

function toCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

function defaultInkKey(materials: Record<string, MaterialDefinition>): string {
  return materials['pp-matte'] ? 'pp-matte' : Object.keys(materials)[0] ?? 'pp-matte';
}

export function Editor({
  zones,
  materials,
  artwork,
  colorways,
  design,
  subtitle,
  siblings = [],
}: EditorProps) {
  const [mode, setMode] = useState<Mode>('look');

  const fallback = useMemo<Omit<EditorState, 'artwork'>>(
    () => ({
      zoneKey: zones[0]!.definition.key,
      transform: initialTransform(artwork.naturalSizeMm, {
        w: zones[0]!.widthMm,
        h: zones[0]!.heightMm,
        safeMarginMm: zones[0]!.safeMarginMm,
      }),
      finish: {
        kind: zones[0]!.definition.constraints.finishes.includes('deboss')
          ? 'deboss'
          : zones[0]!.definition.constraints.finishes[0]!,
        depthMm: Math.min(0.35, zones[0]!.definition.constraints.maxDepthMm),
        bevelDeg: 30,
        edgeRadiusMm: 0.05,
        inkMaterialKey: defaultInkKey(materials),
        inkHex: '#c9a227',
        tintRelief: false,
      },
      materials: Object.fromEntries(
        zones[0]!.materialSlots.map((slot) => [
          slot.key,
          {
            materialKey: slot.defaultMaterialKey,
            textureScale: 1,
            textureRotationDeg: 0,
            ...(slot.colorizable ? { colorHex: colorways[0]!.hex } : {}),
          },
        ]),
      ),
      environmentKey: DEFAULT_ENVIRONMENT_KEY,
      background: { kind: 'studio' },
      cameraPresetKey: zones[0]!.cameraPresets[0]?.key ?? 'three-quarter',
      cameraCustom: null,
    }),
    [zones, artwork.naturalSizeMm, materials, colorways],
  );

  // A saved design opens exactly as it was left; the demo opens on the product's defaults.
  const initial = useMemo<EditorState>(
    () => (design ? stateFromDocument(design.document, fallback) : { ...fallback, artwork: null }),
    // Hydration happens once, from the document the server rendered with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const archive = useDesignArchive(design);
  const readOnly = archive.readOnly;
  const [viewCamera, setViewCamera] = useState<{
    presetKey: string;
    custom: CustomCamera | null;
  } | null>(null);
  const [viewZone, setViewZone] = useState<string | null>(null);
  const history = useEditorHistory(initial, readOnly);
  const [orientationSetup, setOrientationSetup] = useState(false);
  const [inspecting, setInspecting] = useState(true);
  const [lightRotation, setLightRotation] = useState(0);
  const [surfaceTarget, setSurfaceTarget] = useState<{ zone: string; slot: string } | null>(null);
  // Marks the root once handlers are live; see `useHydrated`. Nothing renders differently.
  const hydrated = useHydrated();
  const { state, amend } = history;
  const zone =
    zones.find(
      (z) => z.definition.key === (readOnly ? (viewZone ?? state.zoneKey) : state.zoneKey),
    ) ?? zones[0]!;
  const orientation = useMemo(
    () => effectiveOrientation(zone.presentationOrientation, state.presentationOrientationOverride),
    [zone.presentationOrientation, state.presentationOrientationOverride],
  );
  const inspectionOrientation = useMemo(
    () => inspectionFrame(zone.definition, orientation ?? IMPORTED_FRAME, lightRotation),
    [zone.definition, orientation, lightRotation],
  );
  const extent = useMemo(
    () => ({ w: zone.widthMm, h: zone.heightMm, safeMarginMm: zone.safeMarginMm }),
    [zone],
  );

  const { transform, finish } = state;
  const cameraPreset = readOnly
    ? (viewCamera?.presetKey ?? state.cameraPresetKey)
    : state.cameraPresetKey;

  /**
   * The slot the decoration sits on, and its colour.
   *
   * The face view and the emboss shading need one part colour, and it is the colour of whatever the
   * artwork is being placed on — not an average of every part the product has.
   */
  const decoratedSlot =
    zone.definition.materialSlotKey ??
    (surfaceTarget?.zone === zone.key ? surfaceTarget.slot : undefined) ??
    zone.materialSlots[0]?.key ??
    'body';
  const resolveSurfaceTarget = useCallback(
    (slot: string) => {
      setSurfaceTarget((current) =>
        current?.zone === zone.key && current.slot === slot ? current : { zone: zone.key, slot },
      );
    },
    [zone.key],
  );
  const decorated = state.materials[decoratedSlot];
  const partColor = decorated?.colorHex ?? colorways[0]!.hex;
  const renderLighting = useMemo<RenderLighting>(
    () => ({
      environmentKey: inspecting ? 'studio-detail-v1' : state.environmentKey,
      rotationDeg: 0,
      ...((inspecting ? inspectionOrientation : orientation)
        ? { orientation: inspecting ? inspectionOrientation : orientation }
        : {}),
    }),
    [inspecting, inspectionOrientation, orientation, state.environmentKey],
  );
  const sampleKey = JSON.stringify({
    zone: zone.definition,
    bbox: zone.bboxMm,
    material: decorated && materials[decorated.materialKey],
    assignment: decorated,
    lighting: renderLighting,
    orientation,
    background: state.background,
  });
  const [placementColor, setPlacementColor] = useState<{ key: string; hex: string } | null>(null);
  const sampleColor = useCallback(
    (hex: string) => {
      setPlacementColor((old) =>
        old?.key === sampleKey && old.hex === hex ? old : { key: sampleKey, hex },
      );
    },
    [sampleKey],
  );
  const placementColorHex = placementColor?.key === sampleKey ? placementColor.hex : partColor;

  const setTransform = useCallback(
    (
      next: Transform | ((current: Transform) => Transform),
      label = 'move',
      options?: { continues?: boolean; ends?: boolean },
    ) => {
      history.apply(
        label,
        (s) => ({ ...s, transform: typeof next === 'function' ? next(s.transform) : next }),
        options,
      );
    },
    [history],
  );
  const setFinish = useCallback(
    (next: (current: FinishState) => FinishState, label = 'finish') => {
      history.apply(label, (s) => ({ ...s, finish: next(s.finish) }));
    },
    [history],
  );
  const setSlot = useCallback(
    (slotKey: string, patch: Partial<SlotAssignment>, label = 'material') =>
      history.apply(
        label,
        (s) => ({
          ...s,
          materials: {
            ...s.materials,
            [slotKey]: { ...s.materials[slotKey]!, ...patch },
          },
        }),
        { discrete: true },
      ),
    [history],
  );

  const setEnvironment = useCallback(
    (key: string) =>
      history.apply('environment', (s) => ({ ...s, environmentKey: key }), { discrete: true }),
    [history],
  );

  const setBackground = useCallback(
    (background: SceneBackground) =>
      history.apply('background', (s) => ({ ...s, background }), { discrete: true }),
    [history],
  );

  const setCameraPreset = useCallback(
    // Picking a preset is how you get back to a known view, so it clears the hand-framed one.
    (key: string) => {
      if (readOnly) {
        setViewCamera({ presetKey: key, custom: null });
        return;
      }
      history.apply('camera', (s) => ({ ...s, cameraPresetKey: key, cameraCustom: null }), {
        discrete: true,
      });
    },
    [history, readOnly],
  );

  /**
   * The view the customer framed themselves, saved with the design (F-SCENE-03).
   *
   * Narrowed to the five numbers the document stores rather than passing the viewport's camera
   * through: the resolved camera also carries depth-of-field fields the editor does not offer, and
   * quietly persisting something no control can change is how a design ends up in a state nobody
   * can get it out of.
   */
  const setCustomCamera = useCallback(
    (camera: CustomCamera) => {
      if (readOnly) {
        setViewCamera({ presetKey: cameraPreset, custom: camera });
        return;
      }
      history.apply(
        'camera',
        (s) => ({
          ...s,
          cameraCustom: {
            positionMm: [...camera.positionMm] as [number, number, number],
            targetMm: [...camera.targetMm] as [number, number, number],
            upMm: [...camera.upMm] as [number, number, number],
            focalMm: camera.focalMm,
            sensorMm: camera.sensorMm,
          },
        }),
        { discrete: true },
      );
    },
    [history, readOnly, cameraPreset],
  );

  const setZoneKey = useCallback(
    (key: string) => {
      if (readOnly) {
        setViewZone(key);
        return;
      }
      history.apply('face', (s) => ({ ...s, zoneKey: key }), { discrete: true });
    },
    [history, readOnly],
  );

  // The global snap toggle (F-PLACE-06), remembered per person across sessions. The per-drag
  // override lives in the canvas — `Alt`, or dragging past the break threshold.
  const [snapEnabled, setSnapEnabled] = usePersistedToggle('pr.snap', true);
  const [gridEnabled, setGridEnabled] = useState(false);
  /**
   * Guides the user pulled out of the rulers (F-PLACE-11).
   *
   * Per zone, because a guide is a statement about a particular face: 12 mm from the left of the
   * top face means nothing on the skirt. Not saved with the design — they are scaffolding for the
   * placement being made now, and a design reopened next week should not be full of old lines.
   */
  const [guidesByZone, setGuidesByZone] = useState<Record<string, Guide[]>>({});
  const [scale, setScale] = useState(0);

  const {
    artwork: active,
    rejection,
    busy: uploading,
    adoptPrepared,
    choose,
    reset: resetArtwork,
    // A design saves what it places, so its uploads go to the library; the demo has nowhere to put
    // one and runs the same pipeline in the tab.
  } = useArtwork(artwork);
  const [preparation, setPreparation] = useState<PreparationEntry | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const mask = active?.mask ?? null;
  const field = active?.field ?? null;
  const naturalSizeMm = active?.naturalSizeMm ?? artwork.naturalSizeMm;
  const [artworkPreview, setArtworkPreview] = useState<{
    image: HTMLCanvasElement;
    sampleKey: string;
    colorHex: string;
  } | null>(null);
  // Waits for the artwork shading only, not the color sample. The sample is a second WebGL scene
  // that takes seconds to compile on a slow or software renderer, and gating on it held the canvas
  // hidden for that long; until it arrives the canvas shows the part's own color.
  const placementLoading = Boolean(mask && field && artworkPreview?.sampleKey !== sampleKey);

  // Zone-space layers, composited on every placement change and uploaded to the 3D material:
  // height drives normal perturbation, ink drives colour and surface response.
  const heightLayerRef = useRef<HTMLCanvasElement | null>(null);
  const inkLayerRef = useRef<HTMLCanvasElement | null>(null);
  const [zoneLayers, setZoneLayers] = useState<ZoneLayers | null>(null);

  // Switching face re-fits the artwork and keeps the finish legal for the new face: a carton panel
  // that only prints must not inherit a deboss from a moulded closure. A design that was just
  // hydrated is already legal and already positioned, so the first pass leaves it alone.
  const fittingZone = zones.find((item) => item.definition.key === state.zoneKey) ?? zones[0]!;
  const hydratedRef = useRef(Boolean(design));
  useEffect(() => {
    if (hydratedRef.current) {
      hydratedRef.current = false;
      return;
    }
    // Amended, not pushed: this is the editor finishing the change the user made, so undoing the
    // face switch should go back past all of it in one press.
    const constraints = fittingZone.definition.constraints;
    amend((current) => ({
      ...current,
      transform: initialTransform(naturalSizeMm, {
        w: fittingZone.widthMm,
        h: fittingZone.heightMm,
        safeMarginMm: fittingZone.safeMarginMm,
      }),
      finish: {
        ...current.finish,
        kind: constraints.finishes.includes(current.finish.kind)
          ? current.finish.kind
          : constraints.finishes[0]!,
        depthMm: Math.min(current.finish.depthMm, constraints.maxDepthMm),
      },
      cameraPresetKey: fittingZone.cameraPresets.some((p) => p.key === current.cameraPresetKey)
        ? current.cameraPresetKey
        : (fittingZone.cameraPresets[0]?.key ?? current.cameraPresetKey),
    }));
  }, [amend, naturalSizeMm, fittingZone]);

  /**
   * Where this product can be cut, worked out from what it declares (F-EDIT-11).
   *
   * All the zones, not only the decorated one, because the axis a closure turns about is stated by
   * its skirt whether or not the design puts anything there.
   */
  const crossSections = useMemo(
    () =>
      crossSectionPlanes({
        bboxMm: zone.bboxMm,
        zones: zones.map((z) => z.definition),
        decoratedZoneKey: zone.definition.key,
      }),
    [zone.bboxMm, zone.definition.key, zones],
  );

  const finishParams: FinishParams | null =
    finish.kind === 'print'
      ? null
      : {
          depthMm: finish.depthMm,
          bevelDeg: finish.bevelDeg,
          edgeRadiusMm: finish.edgeRadiusMm,
          kind: finish.kind,
        };

  /**
   * What the mark is made of, resolved once and shared by every view.
   *
   * The same call the render spec makes, so the viewport and the path tracer cannot disagree about
   * a gloss varnish. Null is a blind relief: depth in the part's own material, which is the
   * "same as the part" default.
   */
  const resolvedInk = useMemo(
    () => inkShading(finishToDocument(finish, materials), materials),
    [finish, materials],
  );

  // Shading is cheap enough to redo on every finish change and needs no GPU; it uses the same
  // height profile the path tracer will displace with.
  const [heightImage, setHeightImage] = useState<HTMLCanvasElement | null>(null);
  const [inkImage, setInkImage] = useState<HTMLCanvasElement | null>(null);
  const inked = finish.kind === 'print' || finish.tintRelief;

  /**
   * The encode range for the height layer, narrowed to this design's own relief.
   *
   * The layer is 8-bit, so the range is the step size, and the step size is visible once the layer
   * moves geometry rather than tilting normals (`F-PREV-06`). Derived once here and passed to both
   * the encoder and the shader, because the two disagreeing is a silent depth error.
   */
  const heightRangeMm = heightLayerRangeMm(finishParams?.depthMm ?? null);

  const inkMaterials = useMemo(
    () =>
      Object.values(materials)
        .filter((m) => m.key === 'pp-matte' || m.key === 'pp-gloss')
        .sort((a, b) => (a.name ?? a.key).localeCompare(b.name ?? b.key)),
    [materials],
  );

  useEffect(() => {
    if (!mask || !field) return;

    // Keep relief edges legible without applying the fixed key light a second time to the sampled color.
    setArtworkPreview({
      image: toCanvas(
        shadeArtwork(field, mask, {
          finish: finishParams,
          partColorHex: placementColorHex,
          matchSurfaceColor: true,
          inkColorHex: inked ? finish.inkHex : undefined,
        }),
      ),
      sampleKey,
      colorHex: placementColorHex,
    });

    // 3D: geometry and colour as separate layers, lit by the 3D scene.
    setHeightImage(toCanvas(heightArtwork(field, mask, finishParams, heightRangeMm)));
    setInkImage(inked ? toCanvas(inkArtwork(mask, finish.inkHex, 1)) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finishParams is derived from these
  }, [mask, field, finish, placementColorHex, sampleKey, inked, heightRangeMm]);

  // Composite the zone layers: both views place artwork with the same transform, so they cannot
  // disagree about the design.
  useEffect(() => {
    heightLayerRef.current ??= document.createElement('canvas');
    inkLayerRef.current ??= document.createElement('canvas');

    const height = drawZoneTexture(heightLayerRef.current, {
      zone: extent,
      transform,
      artwork: heightImage,
      // Outside the artwork the layer must read "zero relief", not transparent black, or the
      // shader would see a cliff at the artwork's bounding box.
      clearStyle: 'rgb(128, 128, 128)',
    });
    const ink = drawZoneTexture(inkLayerRef.current, {
      zone: extent,
      transform,
      artwork: inkImage,
    });

    setZoneLayers({
      height,
      ink,
      texelMm: zoneTexelSizeMm(extent, height),
      heightRangeMm,
      // The mark shades from the material the design chose, through the same resolver the Cycles
      // scene builder calls. These were two constants — 0.55/0 and 0.18/1 — which were `ink-black`
      // and `foil-gold` copied out of the fixture pack, so picking any other ink changed the
      // colour and nothing else.
      inkRoughness: resolvedInk?.roughness ?? EMPTY_LAYERS.inkRoughness,
      inkMetalness: resolvedInk?.metallic ?? EMPTY_LAYERS.inkMetalness,
      inkTint: resolvedInk?.tintStrength ?? 1,
      // A filled relief covers where there is relief to fill; a print covers where its artwork is.
      // A blind relief has no ink at all, and must leave every ink channel inert: switching its
      // coverage to depth would blend the surface toward the empty layer's placeholder numbers
      // wherever the mark stands proud, which is a matte grey smear across an untinted emboss.
      inkFromHeight: resolvedInk && finish.kind !== 'print' ? 1 : 0,
    });
  }, [extent, finish.kind, heightImage, heightRangeMm, resolvedInk, inkImage, transform]);

  const stats: ArtworkStats = useMemo(
    () => ({
      pathCount: active?.report?.stats.pathCount ?? 4,
      nodeCount: active?.report?.stats.nodeCount ?? 320,
      naturalSizeMm,
      contentBbox: { x: 0, y: 0, w: naturalSizeMm.w, h: naturalSizeMm.h },
      minStrokeMm: active?.minStrokeMm ?? null,
      coverage: active?.coverage ?? 0.25,
      hasText: false,
      hasGradients: active?.report?.stats.hasGradients ?? false,
      hasClipPaths: false,
    }),
    [active, naturalSizeMm],
  );

  const artworkRef = active?.ref ?? null;

  // What is on screen, whether or not it can be saved: the validation strip should tell the truth
  // about the sample too, so a user learns the limits before they upload anything.
  const placement: Placement = useMemo(
    () => ({
      id: design?.document.placements[0]?.id ?? PLACEMENT_ID,
      zoneKey: zone.definition.key,
      artwork: artworkRef ?? PREVIEW_ARTWORK_REF,
      transform,
      finish: finishToDocument(finish, materials),
      order: 0,
    }),
    [artworkRef, design, finish, materials, transform, zone.definition.key],
  );

  // The identical function the API runs before it will persist a design.
  const issues: Issue[] = useMemo(
    () => validatePlacement(placement, zone.definition, stats),
    [placement, stats, zone.definition],
  );
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  /*
   * Nothing to save until the design's artwork has actually arrived.
   *
   * The artwork loads asynchronously — its mask is an image — and until it has, `artworkRef` is
   * null, so the document built here has no placement at all. Offered to autosave, that document
   * differs from the stored one and is written 900 ms later: opening a design on a slow connection
   * saved it without its logo, and only put the logo back if the mask arrived before the tab closed.
   */
  const projected = useMemo(
    () =>
      design && active
        ? documentFromState(
            design.document,
            {
              zoneKey: zone.definition.key,
              transform,
              finish,
              materials: state.materials,
              cameraPresetKey: state.cameraPresetKey,
              cameraCustom: state.cameraCustom,
              presentationOrientationOverride: state.presentationOrientationOverride,
              environmentKey: state.environmentKey,
              background: state.background,
              artwork: artworkRef,
            },
            materials,
          )
        : null,
    [
      active,
      artworkRef,
      design,
      materials,
      zone.definition.key,
      transform,
      finish,
      // The whole map, not the decorated part's colour: the document is built from every slot, so
      // depending on one of them meant a material changed without a colour change never reached
      // the projected document, and so was never saved.
      state.materials,
      state.cameraPresetKey,
      state.cameraCustom,
      state.presentationOrientationOverride,
      state.environmentKey,
      state.background,
    ],
  );

  const save = useDesignSave(design, projected, {
    blocked: readOnly || errors.length > 0 || orientationSetup,
    onArchived: archive.onArchived,
  });
  const thumbnail = useDesignThumbnail(design?.id ?? null);
  const onThumbnailFrame = thumbnail.onFrame;
  const [leaving, setLeaving] = useState(false);
  const viewerCanvas = useRef<HTMLCanvasElement | null>(null);
  const onViewerFrame = useCallback((canvas: HTMLCanvasElement | null) => {
    viewerCanvas.current = canvas;
    if (!readOnly) onThumbnailFrame(canvas);
  }, [readOnly, onThumbnailFrame]);

  const applyFit = useCallback(
    (mode: 'contain' | 'cover' | 'natural') => {
      setTransform((t) => ({ ...t, sizeMm: fitSize(naturalSizeMm, extent, mode) }), `fit-${mode}`);
    },
    [naturalSizeMm, extent, setTransform],
  );

  const setNumber = useCallback(
    (label: string, update: (t: Transform, value: number) => Transform, value: string) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return;
      setTransform((t) => update(t, parsed), label);
    },
    [setTransform],
  );

  const clearanceMm = Math.min(
    extent.w / 2 - Math.abs(transform.offsetMm.x) - transform.sizeMm.w / 2,
    extent.h / 2 - Math.abs(transform.offsetMm.y) - transform.sizeMm.h / 2,
  );

  if (orientationSetup)
    return (
      <OrientationWizard
        title={subtitle ?? zone.name}
        scope={design ? 'design' : 'demo'}
        confirmed
        initialFrame={orientation}
        defaultFrame={effectiveOrientation(zone.presentationOrientation)}
        meshUrl={zone.meshUrl}
        bboxMm={zone.bboxMm}
        materials={materials}
        assignments={state.materials}
        decoratedSlot={decoratedSlot}
        zone={zone.definition}
        layers={zoneLayers ?? EMPTY_LAYERS}
        environmentKey={state.environmentKey}
        exitHref={design ? `/design/${design.id}` : '/design/demo'}
        breadcrumbs={[
          { label: 'Designs', href: '/designs' },
          { label: design?.name ?? 'Demo design' },
          { label: 'Orientation' },
        ]}
        importSummary={
          <p>
            {subtitle ?? zone.name} · {zone.variantKey}. The pinned product and its existing mesh
            are retained.
          </p>
        }
        zonesContent={
          <>
            <p>Review existing decoration zones. Their physical geometry is read-only here.</p>
            <ul>
              {zones.map((z) => (
                <li key={z.key}>
                  {z.name} · {z.widthMm} × {z.heightMm} mm
                </li>
              ))}
            </ul>
            <p>Artwork transforms, materials and finishes stay unchanged.</p>
          </>
        }
        reviewContent={
          <>
            <p>Keep the current camera unless you choose a new Front view below.</p>
            <p>This change affects only {design ? 'this design' : 'the demo preview'}.</p>
          </>
        }
        finalLabel={design ? 'Apply to design' : 'Apply to preview'}
        onConfirm={async () => undefined}
        onCancel={() => setOrientationSetup(false)}
        onFinish={async (frame, useFront) => {
          const sphere = boundingSphere(zone.bboxMm);
          const effective = frame ?? effectiveOrientation(zone.presentationOrientation);
          const preset =
            zone.cameraPresets.find((p) => p.key === cameraPreset) ?? zone.cameraPresets[0]!;
          const oldCamera =
            state.cameraCustom ?? framePreset(preset, sphere, undefined, orientation);
          const nextCamera = useFront
            ? framePreset(
                {
                  ...(zone.cameraPresets.find((p) => p.key === 'front') ?? preset),
                  key: 'front',
                  azimuthDeg: 0,
                  elevationDeg: 0,
                },
                sphere,
                undefined,
                effective,
              )
            : oldCamera;
          if (!design) {
            history.apply(
              'orientation',
              (current) => ({
                ...current,
                presentationOrientationOverride: frame,
                cameraCustom: nextCamera,
              }),
              { discrete: true },
            );
            setOrientationSetup(false);
            return;
          }
          const base = projected ?? design.document;
          const document = {
            ...base,
            scene: {
              ...base.scene,
              presentationOrientationOverride: frame,
              camera: { kind: 'custom' as const, ...nextCamera },
            },
          };
          const response = await fetch(`/api/designs/${design.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ document, expectedVersion: save.version }),
          });
          if (!response.ok) {
            const payload = (await response.json()) as { error?: { detail?: string } };
            throw new Error(
              payload.error?.detail ??
                (response.status === 409
                  ? 'This design changed in another window. Reload before applying.'
                  : 'The orientation could not be saved.'),
            );
          }
          window.location.reload();
        }}
      />
    );

  if (preparation)
    return (
      <ArtworkPreparation
        entry={preparation}
        persist={Boolean(design)}
        onCancel={() => setPreparation(null)}
        onSaved={() => {
          setPreparation(null);
          setLibraryRevision((value) => value + 1);
        }}
        onPrepared={async (svg, name) => {
          await adoptPrepared(svg, name);
          setPreparation(null);
        }}
      />
    );

  return (
    <div
      className={`editor${readOnly ? ' editor-archived' : ''}`}
      data-hydrated={hydrated || undefined}
    >
      <header className="topbar">
        <div className="brand">
          <a
            className="brand-home"
            href="/designs"
            aria-label={leaving ? 'Saving preview…' : 'Back to designs'}
            data-testid="editor-home"
            aria-busy={leaving}
            onClick={async (event) => {
              if (
                event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey ||
                event.altKey || !design || readOnly
              ) return;
              event.preventDefault();
              if (leaving) return;
              setLeaving(true);
              if (mode === 'place') setMode('look');
              if (!(await save.saveNow())) {
                setLeaving(false);
                return;
              }
              await thumbnail.captureNow();
              window.location.assign('/designs');
            }}
          >
            <span aria-hidden>{leaving ? '…' : '←'}</span>
          </a>
          <div>
            <strong>{design?.name ?? 'Demo workspace'}</strong>
            <span className="sub">{subtitle ?? 'Place · demo design'}</span>
            {design && siblings.length > 1 && (
              <select
                className="variant-switch"
                disabled={readOnly || leaving}
                value={zones[0]?.variantKey ?? ''}
                data-testid="variant-switch"
                onChange={(event) => {
                  const target = siblings.find((sibling) => sibling.key === event.target.value);
                  if (!target) return;
                  void fetch(`/api/designs/${design.id}/variant`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ variantId: target.variantId }),
                  }).then(() => window.location.reload());
                }}
              >
                {siblings.map((sibling) => (
                  <option key={sibling.variantId} value={sibling.key}>
                    {sibling.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="mode-switch" role="group" aria-label="Editor mode">
          {(['place', 'split', 'look'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'active' : ''}
              onClick={() => setMode(m)}
              data-testid={`mode-${m}`}
            >
              {m === 'place' ? 'Place' : m === 'look' ? 'Viewer' : 'Split'}
            </button>
          ))}
        </div>

        <div className="topbar-actions">
          <div className="history" role="group" aria-label="History">
            <button
              type="button"
              onClick={history.undo}
              disabled={!history.canUndo}
              title="Undo (Ctrl/Cmd Z)"
              aria-label="Undo"
              data-testid="undo"
            >
              ↶
            </button>
            <button
              type="button"
              onClick={history.redo}
              disabled={!history.canRedo}
              title="Redo (Ctrl/Cmd Shift Z)"
              aria-label="Redo"
              data-testid="redo"
            >
              ↷
            </button>
          </div>
          {design && (
            <span
              className={`chip ${readOnly ? 'archive-view-status' : `save-${save.status}`}`}
              data-testid="save-status"
              data-status={readOnly ? 'archived' : save.status}
            >
              {readOnly ? 'View-only' : SAVE_LABELS[save.status]}
            </span>
          )}
          {!design && <span className="chip">Demo · not saved</span>}
          <SnapshotButton
            canvas={viewerCanvas}
            name={design?.name ?? 'viewer'}
            disabled={mode === 'place' || leaving}
            placeMode={mode === 'place'}
          />
          {design && (
            <button
              type="button"
              className="primary"
              data-testid="open-render-settings"
              disabled={readOnly || leaving}
              onClick={() =>
                document
                  .querySelector('[data-testid="render-panel"]')
                  ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              }
            >
              Render
            </button>
          )}
          <span className="chip" data-testid="scale-chip">
            {scale ? `${scale.toFixed(1)} px/mm` : '—'}
          </span>
        </div>
      </header>

      {readOnly && (
        <ArchiveBanner
          title="Artwork archived — this design is view-only."
          action={
            <a
              className="archive-banner-link"
              href={
                archive.artworks[0]
                  ? `/artwork?artworkId=${archive.artworks[0].artworkId}`
                  : '/artwork?state=archived'
              }
            >
              View artwork
            </a>
          }
        >
          {archive.artworks.length
            ? archive.artworks.map((item) => `“${item.name}”`).join(', ')
            : 'Artwork in this design'}{' '}
          {archive.artworks.length === 1 ? 'is' : 'are'} archived. Restore{' '}
          {archive.artworks.length === 1 ? 'it' : 'all archived artwork'} in Artwork to enable
          editing.
          {save.status === 'blocked' && history.hasEdits && ' Unsaved local changes have not been saved.'}
          {archive.error && ` ${archive.error}`}
        </ArchiveBanner>
      )}
      {!readOnly && archive.error && (
        <p className="archive-status-error issue warning">{archive.error}</p>
      )}

      {save.status === 'conflict' && (
        <div className="conflict-banner" data-testid="save-conflict" role="alert">
          This design was changed somewhere else while you were editing. Reload to pick up that
          version — your unsaved changes here will be lost.
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}

      <aside className="rail">
        <h2>Decoration zones</h2>
        <ul className="zone-list">
          {zones.map((z) => (
            <li key={z.key}>
              <button
                type="button"
                className={z.definition.key === zone.definition.key ? 'zone active' : 'zone'}
                onClick={() => setZoneKey(z.definition.key)}
                data-testid={`zone-${z.definition.key}`}
              >
                <span>{z.name}</span>
                <small>
                  {z.widthMm} × {z.heightMm} mm · {z.type}
                </small>
              </button>
            </li>
          ))}
        </ul>

        <h2>Guides</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={snapEnabled}
            onChange={(e) => setSnapEnabled(e.target.checked)}
            data-testid="snap-toggle"
          />
          Snapping <kbd>Alt</kbd> to suspend
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={gridEnabled}
            onChange={(e) => setGridEnabled(e.target.checked)}
          />
          Grid
        </label>

        <fieldset className="editor-controls" disabled={readOnly || leaving}>
          <h2>Materials</h2>
          {/*
          A face need not have any material slots — a carton's side panel is decorated but not
          re-coloured. The heading used to stand over nothing at all, which reads as a panel that
          failed to load rather than one with nothing to offer. Say so instead.
        */}
          {zone.materialSlots.every((slot) => !state.materials[slot.key]) && (
            <p className="panel-empty" data-testid="materials-empty">
              No materials to choose from on this file.
            </p>
          )}
          {zone.materialSlots.map((slot) => {
            const assignment = state.materials[slot.key];
            if (!assignment) return null;

            const options = ['pp-matte', 'pp-gloss']
              .flatMap((key) => materials[key] ? [materials[key]!] : [])
              .filter(
              (candidate) =>
                (slot.allowedFamilies.length === 0 ||
                  slot.allowedFamilies.includes(candidate.family)) &&
                (slot.allowedFinishes.length === 0 ||
                  slot.allowedFinishes.includes(finishOf(candidate))),
            );
            const chosen = materials[assignment.materialKey];
            const textured = Boolean(chosen && hasTextures(chosen));

            return (
              <div className="slot" key={slot.key} data-testid={`slot-${slot.key}`}>
                <label className="slot-label">
                  {slot.label}
                  <select
                    className="panel-select"
                    value={assignment.materialKey}
                    data-testid={`material-${slot.key}`}
                    onChange={(e) => setSlot(slot.key, { materialKey: e.target.value })}
                  >
                    {options.map((option) => (
                      <option key={option.key} value={option.key}>{option.name}</option>
                    ))}
                  </select>
                </label>

                {/*
                No colour for the liner (F-MAT-09).

                A liner is the sealing wad inside a closure. It is a real part, but it is not one
                anybody specifies the colour of and — on every mesh this product has — it is not one
                anybody can see: the fixture cap is a single body, and a real closure only shows its
                liner on a cutaway. The slot is standing decision to remove entirely; until that
                happens the control that invited a choice nobody needs is gone.
              */}
                {slot.key !== 'liner' && slot.colorizable && (
                  <>
                    <div className="swatches">
                      {colorways.map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          title={`${c.label} — approximate on screen`}
                          aria-label={`${c.label}, approximate`}
                          className={c.hex === assignment.colorHex ? 'swatch active' : 'swatch'}
                          style={{ background: c.hex }}
                          data-testid={`colorway-${slot.key}-${c.key}`}
                          onClick={() => setSlot(slot.key, { colorHex: c.hex }, 'colour')}
                        />
                      ))}
                      {/* The palette is a shortcut, not a limit: brand colours are rarely in it. */}
                      <input
                        type="color"
                        className="swatch-picker"
                        value={assignment.colorHex ?? '#cccccc'}
                        aria-label={`${slot.label} color`}
                        data-testid={`color-${slot.key}`}
                        onChange={(e) => setSlot(slot.key, { colorHex: e.target.value }, 'colour')}
                      />
                    </div>
                    {/*
                    Named colours are approximations and say so (F-MAT-02). A screen cannot promise
                    a moulded part's colour — the pigment, the resin and the light it is looked at
                    under all move it — and a customer who reads "Forest green" as a commitment is a
                    customer who is going to be surprised by a physical sample.
                  */}
                    <small className="swatch-caveat">
                      Named colors are approximate. Match to a physical standard before ordering.
                    </small>
                    <input
                      className="hex-input"
                      value={assignment.colorHex ?? ''}
                      aria-label={`${slot.label} hex`}
                      data-testid={`hex-${slot.key}`}
                      onChange={(e) => {
                        const value = e.target.value.trim();
                        if (/^#[0-9a-fA-F]{6}$/.test(value))
                          setSlot(slot.key, { colorHex: value }, 'colour');
                      }}
                    />
                  </>
                )}

                {textured && (
                  <div className="grid2">
                    <label>
                      Texture scale
                      <input
                        type="number"
                        min="0.1"
                        max="10"
                        step="0.1"
                        value={assignment.textureScale}
                        data-testid={`texture-scale-${slot.key}`}
                        onChange={(e) =>
                          setSlot(
                            slot.key,
                            { textureScale: clampScale(Number(e.target.value)) },
                            'texture',
                          )
                        }
                      />
                    </label>
                    <label>
                      Rotation (deg)
                      <input
                        type="number"
                        step="5"
                        value={assignment.textureRotationDeg}
                        data-testid={`texture-rotation-${slot.key}`}
                        onChange={(e) =>
                          setSlot(
                            slot.key,
                            { textureRotationDeg: Number(e.target.value) || 0 },
                            'texture',
                          )
                        }
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })}

          {/*
          The mark's own material, beside the ones the part is made of.

          It lives here rather than with the finish controls because that is what it is: a slot,
          like the cap body and the liner, answering "what is this made of" rather than "how deep
          is it". The finish panel keeps the questions only a relief has — depth, bevel, and
          whether the mark is filled at all.
        */}
          {inkMaterials.length > 0 && (
            <div className="slot" data-testid="slot-artwork">
              {inkMaterials.length > 0 && (
                <label className="slot-label">
                  Artwork
                  <select
                    className="panel-select"
                    value={inked ? finish.inkMaterialKey : 'same-as-cap'}
                    data-testid="ink-material"
                    onChange={(e) =>
                      setFinish((f) => ({
                        ...f,
                        tintRelief: e.target.value !== 'same-as-cap',
                        inkMaterialKey: e.target.value === 'same-as-cap' ? f.inkMaterialKey : e.target.value,
                      }), 'ink-material')
                    }
                  >
                    {finish.kind !== 'print' && <option value="same-as-cap">Same as cap</option>}
                  {inkMaterials.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.name ?? m.key}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {finish.kind !== 'print' ? (
                <p className="slot-note" data-testid="ink-clear">
                  Artwork keeps the cap’s color. Choose a finish independently, or use the cap’s finish.
                </p>
              ) : (
                <label className="slot-color">
                  Ink color
                  <input
                    type="color"
                    value={finish.inkHex}
                    aria-label="Artwork ink color"
                    data-testid="ink-color"
                    onChange={(e) => setFinish((f) => ({ ...f, inkHex: e.target.value }), 'ink')}
                  />
                </label>
              )}
            </div>
          )}

          <h2>Lighting preset</h2>
          <select
            className="panel-select"
            value={state.environmentKey}
            data-testid="environment"
            onChange={(e) => setEnvironment(e.target.value)}
          >
            {ENVIRONMENTS.map((option) => (
              <option key={option.key} value={option.key} title={option.description}>
                {option.name}
              </option>
            ))}
          </select>

          <h2>Background</h2>
          <div className="background-choice">
            {(['studio', 'solid', 'transparent'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={state.background.kind === kind ? 'chip active' : 'chip'}
                data-testid={`background-${kind}`}
                onClick={() =>
                  setBackground(
                    kind === 'solid'
                      ? {
                          kind,
                          colorHex:
                            state.background.kind === 'solid'
                              ? state.background.colorHex
                              : '#f2f4f8',
                        }
                      : { kind },
                  )
                }
              >
                {kind === 'studio' ? 'Studio' : kind === 'solid' ? 'Color' : 'None'}
              </button>
            ))}
            {state.background.kind === 'solid' && (
              <input
                type="color"
                value={state.background.colorHex}
                data-testid="background-color"
                onChange={(e) => setBackground({ kind: 'solid', colorHex: e.target.value })}
              />
            )}
          </div>
        </fieldset>
        <div className="orientation-editor-controls">
          <h2>Orientation</h2>
          <button
            type="button"
            className="wide"
            disabled={
              readOnly || (Boolean(design) && save.status !== 'saved' && save.status !== 'idle')
            }
            onClick={() => setOrientationSetup(true)}
            data-testid="reorient-product"
          >
            Reorient product
          </button>
          <h2>Viewer lighting</h2>
          <div className="segmented inspection-modes">
            <button
              type="button"
              className={inspecting ? '' : 'active'}
              aria-pressed={!inspecting}
              onClick={() => setInspecting(false)}
              data-testid="design-lighting"
            >
              Design lighting
            </button>
            <button
              type="button"
              className={inspecting ? 'active' : ''}
              aria-pressed={inspecting}
              onClick={() => setInspecting(true)}
              data-testid="inspect-artwork"
            >
              Inspection
            </button>
          </div>
          {inspecting && (
            <label className="inspection-rotation">
              <span className="inspection-rotation-label">
                Light rotation
                <span>{lightRotation}°</span>
              </span>
              <input
                type="range"
                min="-180"
                max="180"
                step="5"
                value={lightRotation}
                onChange={(e) => setLightRotation(Number(e.target.value))}
                data-testid="inspection-rotation"
              />
            </label>
          )}
          <button
            type="button"
            className="wide"
            onClick={() => setLightRotation(0)}
            data-testid="inspection-reset"
          >
            Reset rotation
          </button>
          <p className="inspection-note">
            Render uses the lighting currently shown in the viewer.
            {inspecting && (zone.type === 'uv_rect' || zone.type === 'flat_panel')
              ? ' Using product orientation.'
              : ''}
          </p>
        </div>
        {state.background.kind === 'transparent' && (
          <p className="readout">Renders come out with alpha, ready to composite.</p>
        )}
      </aside>

      <main className="stage">
        {mode !== 'look' && decorated && materials[decorated.materialKey] && (
          <PlacementColorSample
            material={materials[decorated.materialKey]!}
            assignment={decorated}
            zone={zone.definition}
            bboxMm={zone.bboxMm}
            surfaceOrientation={orientation}
            lightingOrientation={renderLighting.orientation}
            environmentKey={renderLighting.environmentKey}
            rotationDeg={renderLighting.rotationDeg}
            background={state.background}
            onColor={sampleColor}
          />
        )}
        <div className={`panes mode-${mode}`}>
          {mode !== 'look' && (
            <FaceViewCanvas
              readOnly={readOnly}
              zone={extent}
              zoneLabel={zone.name}
              transform={transform}
              artworkImage={artworkPreview?.image ?? null}
              loading={placementLoading}
              snapEnabled={snapEnabled}
              gridEnabled={gridEnabled}
              guides={guidesByZone[zone.key] ?? EMPTY_GUIDES}
              onGuidesChange={(next) => setGuidesByZone((all) => ({ ...all, [zone.key]: next }))}
              partColorHex={placementColorHex}
              surfaceColorSampled={placementColor?.key === sampleKey}
              /*
                The canvas says where a gesture starts and stops; history uses that rather than
                guessing from a clock. Dropping the flag here left a drag to be coalesced on timing
                alone, so a slow one became two entries and undo took back half of it.
              */
              onTransformChange={(next, { commit }) =>
                setTransform(next, 'move', commit ? { ends: true } : { continues: true })
              }
              onScaleChange={setScale}
            />
          )}
          {mode !== 'place' && (
            <Viewport3D
              meshUrl={zone.meshUrl}
              bboxMm={zone.bboxMm}
              zone={zone.definition}
              layers={zoneLayers ?? EMPTY_LAYERS}
              materials={materials}
              assignments={state.materials}
              decoratedSlot={decoratedSlot}
              cameraPresets={zone.cameraPresets}
              presetKey={cameraPreset}
              orientation={orientation}
              onDecorationTarget={resolveSurfaceTarget}
              lightingOrientation={renderLighting.orientation}
              environmentKey={renderLighting.environmentKey}
              environmentRotationDeg={renderLighting.rotationDeg}
              background={state.background}
              onFrame={onViewerFrame}
              crossSections={crossSections}
              onPresetChange={setCameraPreset}
              customCamera={
                readOnly
                  ? (viewCamera?.custom ?? (viewCamera ? null : state.cameraCustom))
                  : state.cameraCustom
              }
              onCameraChange={setCustomCamera}
            />
          )}
        </div>
        <div className="validation" data-testid="validation">
          {errors.map((i) => (
            <p key={i.code} className="issue error">
              {i.message}
            </p>
          ))}
          {warnings.map((i) => (
            <p key={i.code} className="issue warning">
              {i.message}
            </p>
          ))}
          {issues.length === 0 && (
            <p className="issue ok">Placement is within every limit for this face.</p>
          )}
        </div>
      </main>

      <aside className="panel">
        <fieldset className="editor-controls" disabled={readOnly || leaving}>
          <section>
            <h2>Artwork</h2>
            <p className="artwork-name" data-testid="artwork-name">
              {active?.name ?? artwork.name}
              {readOnly ? (
                <span className="tag">Archived</span>
              ) : (
                active?.source === 'library' && <span className="tag">in your library</span>
              )}
            </p>
            {design && active?.source === 'sample' && (
              <p className="artwork-hint" data-testid="artwork-sample-hint">
                This is our sample mark, so it is not part of the design. Upload your artwork to
                place it and save it.
              </p>
            )}

            <label className="upload">
              <input
                type="file"
                accept=".svg,image/svg+xml"
                data-testid="artwork-upload"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setPreparationError(null);
                    void readPreparationFile(file)
                      .then(setPreparation)
                      .catch((error: unknown) =>
                        setPreparationError(
                          error instanceof Error ? error.message : 'The file could not be read.',
                        ),
                      );
                  }
                  e.target.value = '';
                }}
              />
              <span className="loading-inline">{uploading && <LoadingSpinner compact />}{uploading ? 'Processing…' : 'Upload an SVG logo'}</span>
            </label>

            {preparationError && <p className="issue error">{preparationError}</p>}
            {design && (
              <ArtworkLibrary
                key={libraryRevision}
                initiallyOpen={libraryRevision > 0}
                disabled={readOnly || leaving}
                currentVersionId={active?.ref?.versionId ?? null}
                onChoose={(record) => void choose(record)}
              />
            )}

            {rejection && (
              <div className="artwork-report rejected" data-testid="artwork-rejection">
                <strong>{rejection.fileName} was not accepted</strong>
                {rejection.report.errors.map((error) => (
                  <p key={error.code}>
                    {error.message}
                    {error.hint ? ` ${error.hint}` : ''}
                  </p>
                ))}
                <button type="button" onClick={resetArtwork}>
                  Use the sample logo
                </button>
              </div>
            )}

            {active?.report && active.report.warnings.length > 0 && (
              <div className="artwork-report" data-testid="artwork-warnings">
                {active.report.warnings.map((warning) => (
                  <p key={warning.code}>{warning.message}</p>
                ))}
              </div>
            )}
            <div className="grid2">
              <label>
                W (mm)
                <input
                  type="number"
                  step="0.1"
                  value={transform.sizeMm.w.toFixed(2)}
                  data-testid="input-width"
                  onChange={(e) =>
                    setNumber(
                      'width',
                      (t, v) => {
                        const ratio = t.sizeMm.h / t.sizeMm.w;
                        return { ...t, sizeMm: { w: v, h: t.lockAspect ? v * ratio : t.sizeMm.h } };
                      },
                      e.target.value,
                    )
                  }
                />
              </label>
              <label>
                H (mm)
                <input
                  type="number"
                  step="0.1"
                  value={transform.sizeMm.h.toFixed(2)}
                  onChange={(e) =>
                    setNumber(
                      'height',
                      (t, v) => {
                        const ratio = t.sizeMm.w / t.sizeMm.h;
                        return { ...t, sizeMm: { w: t.lockAspect ? v * ratio : t.sizeMm.w, h: v } };
                      },
                      e.target.value,
                    )
                  }
                />
              </label>
              <label>
                X (mm)
                <input
                  type="number"
                  step="0.1"
                  value={transform.offsetMm.x.toFixed(2)}
                  data-testid="input-x"
                  onChange={(e) =>
                    setNumber(
                      'x',
                      (t, v) => ({ ...t, offsetMm: { ...t.offsetMm, x: v } }),
                      e.target.value,
                    )
                  }
                />
              </label>
              <label>
                Y (mm)
                <input
                  type="number"
                  step="0.1"
                  value={transform.offsetMm.y.toFixed(2)}
                  data-testid="input-y"
                  onChange={(e) =>
                    setNumber(
                      'y',
                      (t, v) => ({ ...t, offsetMm: { ...t.offsetMm, y: v } }),
                      e.target.value,
                    )
                  }
                />
              </label>
              <label>
                Rotation (°)
                <input
                  type="number"
                  step="1"
                  value={transform.rotationDeg.toFixed(1)}
                  onChange={(e) =>
                    setNumber('rotate', (t, v) => ({ ...t, rotationDeg: v }), e.target.value)
                  }
                />
              </label>
              <label className="lock">
                <input
                  type="checkbox"
                  checked={transform.lockAspect}
                  onChange={(e) =>
                    setTransform((t) => ({ ...t, lockAspect: e.target.checked }), 'lock')
                  }
                />
                Lock aspect
              </label>
            </div>
            <div className="buttons">
              <button type="button" onClick={() => applyFit('contain')} data-testid="fit-button">
                Fit
              </button>
              <button type="button" onClick={() => applyFit('cover')}>
                Fill
              </button>
              <button type="button" onClick={() => applyFit('natural')}>
                100%
              </button>
              <button
                type="button"
                onClick={() => setTransform((t) => ({ ...t, offsetMm: { x: 0, y: 0 } }), 'centre')}
                data-testid="center-button"
              >
                Center
              </button>
            </div>

            <div className="row wrap" data-testid="align-actions">
              {ALIGNMENTS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  title={action.title}
                  data-testid={`align-${action.key}`}
                  onClick={() =>
                    setTransform((t) => align(t, action.key, extent), `align-${action.key}`)
                  }
                >
                  {action.label}
                </button>
              ))}
              <button
                type="button"
                title="Back to a centered, unrotated, natural-size placement"
                data-testid="reset-transform"
                onClick={() => setTransform(() => initialTransform(naturalSizeMm, extent), 'reset')}
              >
                Reset
              </button>
            </div>
            <p className="readout" data-testid="clearance">
              Clearance to edge {clearanceMm.toFixed(2)} mm
            </p>
          </section>

          <section>
            <h2>Finish</h2>
            <div className="segmented">
              {(['emboss', 'deboss', 'print'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={finish.kind === kind ? 'active' : ''}
                  disabled={!zone.definition.constraints.finishes.includes(kind)}
                  onClick={() => setFinish((f) => ({ ...f, kind }), 'finish-kind')}
                  data-testid={`finish-${kind}`}
                >
                  {kind}
                </button>
              ))}
            </div>

            {finish.kind !== 'print' && (
              <>
                <label className="slider">
                  Depth {finish.depthMm.toFixed(2)} mm
                  <input
                    type="range"
                    min="0.05"
                    max={String(Math.max(zone.definition.constraints.maxDepthMm, 0.1))}
                    step="0.01"
                    value={finish.depthMm}
                    data-testid="depth-slider"
                    onChange={(e) =>
                      setFinish((f) => ({ ...f, depthMm: Number(e.target.value) }), 'depth')
                    }
                  />
                </label>
                <label className="slider">
                  Bevel {finish.bevelDeg}°
                  <input
                    type="range"
                    min="5"
                    max="90"
                    step="1"
                    value={finish.bevelDeg}
                    onChange={(e) =>
                      setFinish((f) => ({ ...f, bevelDeg: Number(e.target.value) }), 'bevel')
                    }
                  />
                </label>
                <label className="slider">
                  Edge radius {finish.edgeRadiusMm.toFixed(2)} mm
                  <input
                    type="range"
                    min="0"
                    max="0.3"
                    step="0.01"
                    value={finish.edgeRadiusMm}
                    onChange={(e) =>
                      setFinish(
                        (f) => ({ ...f, edgeRadiusMm: Number(e.target.value) }),
                        'edge-radius',
                      )
                    }
                  />
                </label>


              </>
            )}
          </section>
        </fieldset>
        {design && (
          <RenderPanel
            designId={design.id}
            blocked={readOnly || errors.length > 0}
            lighting={renderLighting}
            beforeSubmit={save.saveNow}
            inspectionActive={inspecting}
            onReturnToProduct={() => setInspecting(false)}
          />
        )}

        <section>
          <h2>Face</h2>
          <p className="readout">
            {zone.name}
            <br />
            {zone.widthMm} × {zone.heightMm} mm, {zone.safeMarginMm} mm safe margin
            <br />
            max depth {zone.definition.constraints.maxDepthMm} mm · min stroke{' '}
            {zone.definition.constraints.minStrokeMm} mm
          </p>
          {design && (
            <p className="readout" data-testid="design-version">
              Version {save.version}
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

/** A material with any map worth tiling; only then are scale and rotation meaningful. */
function hasTextures(material: MaterialDefinition): boolean {
  return Object.entries(material.maps).some(
    ([key, value]) => key !== 'tilingMm' && value && typeof value === 'object',
  );
}

const clampScale = (value: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0.1), 10) : 1;
