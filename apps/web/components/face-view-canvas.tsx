'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LoadingSpinner } from '@/components/loading-spinner';
import type { Transform, Vec2 } from '@pr/design-schema';
import {
  aabb,
  corners,
  type ActiveSnap,
  type Axis,
  type Guide,
  type ZoneExtent,
} from '@pr/placement';
import {
  beginGesture,
  commitGesture,
  cursorFor,
  fitViewport,
  handlePositions,
  hitTest,
  nudge,
  panByPx,
  pxPerMm,
  resize,
  rotateHandlePosition,
  rulerStepMm,
  screenToZone,
  updateGesture,
  zoneToScreen,
  zoomAt,
  type Gesture,
  type Viewport,
} from '@pr/face-view';

/**
 * The 2D face view (F-PLACE-01..14).
 *
 * Drawing and pointer handling only — every decision about where artwork ends up is made by
 * @pr/face-view and @pr/placement, the same pure code the API validates with.
 */

export interface FaceViewCanvasProps {
  readOnly?: boolean;
  zone: ZoneExtent;
  zoneLabel: string;
  transform: Transform;
  artworkImage: HTMLCanvasElement | null;
  snapEnabled: boolean;
  gridEnabled: boolean;
  partColorHex: string;
  surfaceColorSampled?: boolean;
  loading?: boolean;
  /**
   * Guides the user has pulled out of the rulers (F-PLACE-11).
   *
   * Held by the editor rather than here so undo can reach them, and so switching face does not
   * quietly discard the lines someone just placed.
   */
  guides: Guide[];
  onGuidesChange: (guides: Guide[]) => void;
  onTransformChange: (transform: Transform, options: { commit: boolean }) => void;
  onScaleChange?: (pxPerMm: number) => void;
}

/** How close to a ruler you must press to pull a new guide out of it. */
const RULER_PX = 22;
/** Grab radius for picking up a guide that is already there. */
const GUIDE_GRAB_PX = 5;

const GUIDE_COLORS: Record<ActiveSnap['kind'], string> = {
  zoneCenter: '#e0409a',
  guide: '#8b5cf6',
  safeEdge: '#f59e0b',
  zoneEdge: '#64748b',
  neighborCenter: '#22d3ee',
  neighborEdge: '#22d3ee',
};

export function FaceViewCanvas({
  readOnly = false,
  zone,
  zoneLabel,
  transform,
  artworkImage,
  snapEnabled,
  gridEnabled,
  partColorHex,
  surfaceColorSampled = false,
  loading = false,
  guides: customGuides,
  onGuidesChange,
  onTransformChange,
  onScaleChange,
}: FaceViewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  /** Which custom guide is being dragged, and whether it started life on the ruler. */
  const guideRef = useRef<{ index: number; axis: Axis } | null>(null);

  const [viewport, setViewport] = useState<Viewport>(() => fitViewport({ w: 800, h: 600 }, zone));
  const [guides, setGuides] = useState<ActiveSnap[]>([]);
  const [cursor, setCursor] = useState('default');
  const [boundaryFlash, setBoundaryFlash] = useState(false);

  // Keep the viewport's zone in sync when the user switches faces.
  useEffect(() => {
    setViewport((vp) => fitViewport(vp.canvasPx, zone));
  }, [zone]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setViewport((vp) => resize(vp, { w: Math.max(1, width), h: Math.max(1, height) }));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const scale = pxPerMm(viewport);
  useEffect(() => onScaleChange?.(scale), [scale, onScaleChange]);

  const pointerPosition = useCallback((event: React.PointerEvent<HTMLCanvasElement>): Vec2 => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.focus();
      const point = pointerPosition(event);

      // Middle button pans, matching every other canvas tool people already know.
      if (event.button === 1) {
        panRef.current = point;
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      if (readOnly) return;

      // Guides first: they sit on top of the artwork, and a ruler press means a new one.
      const existing = guideAt(customGuides, viewport, point);
      if (existing !== null) {
        guideRef.current = { index: existing, axis: customGuides[existing]!.axis };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      const fromRuler = rulerAt(point);
      if (fromRuler) {
        const mm = toMm(viewport, point);
        const next = [
          ...customGuides,
          { axis: fromRuler, valueMm: fromRuler === 'x' ? mm.x : mm.y },
        ];
        guideRef.current = { index: next.length - 1, axis: fromRuler };
        onGuidesChange(next);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      const target = hitTest(viewport, transform, point);
      const gesture = beginGesture(viewport, transform, point, target);
      if (!gesture) return;
      gestureRef.current = gesture;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [customGuides, onGuidesChange, pointerPosition, transform, viewport, readOnly],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = pointerPosition(event);

      if (panRef.current) {
        const delta = { x: point.x - panRef.current.x, y: point.y - panRef.current.y };
        panRef.current = point;
        setViewport((vp) => panByPx(vp, delta));
        return;
      }

      if (readOnly) {
        gestureRef.current = null;
        guideRef.current = null;
        setCursor('default');
        return;
      }
      const dragging = guideRef.current;
      if (dragging) {
        const mm = toMm(viewport, point);
        const next = [...customGuides];
        next[dragging.index] = {
          axis: dragging.axis,
          valueMm: dragging.axis === 'x' ? mm.x : mm.y,
        };
        onGuidesChange(next);
        return;
      }

      const gesture = gestureRef.current;
      if (!gesture) {
        const overGuide = guideAt(customGuides, viewport, point) !== null;
        setCursor(
          overGuide
            ? 'grab'
            : rulerAt(point)
              ? 'copy'
              : cursorFor(hitTest(viewport, transform, point), transform),
        );
        return;
      }

      const update = updateGesture(
        gesture,
        viewport,
        point,
        { zone, snapEnabled, guides: customGuides },
        { alt: event.altKey, shift: event.shiftKey },
      );
      gestureRef.current = update.gesture;
      setGuides(update.guides);
      setBoundaryFlash(update.hitBoundary);
      onTransformChange(update.transform, { commit: false });
    },
    [
      customGuides,
      onGuidesChange,
      onTransformChange,
      pointerPosition,
      snapEnabled,
      transform,
      viewport,
      zone,
      readOnly,
    ],
  );

  const endGesture = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      panRef.current = null;

      // A guide dropped back on its ruler, or off the canvas, is a guide being thrown away.
      const dropped = guideRef.current;
      guideRef.current = null;
      if (dropped) {
        const point = pointerPosition(event);
        if (rulerAt(point) || outside(point, viewport)) {
          onGuidesChange(customGuides.filter((_, index) => index !== dropped.index));
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        return;
      }

      const gesture = gestureRef.current;
      gestureRef.current = null;
      setGuides([]);
      setBoundaryFlash(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!gesture || readOnly) return;
      // Quantise once, on release, so undo entries and autosaves stay meaningful.
      onTransformChange(commitGesture({ transform, guides: [], gesture, hitBoundary: false }), {
        commit: true,
      });
    },
    [
      customGuides,
      onGuidesChange,
      onTransformChange,
      pointerPosition,
      transform,
      viewport,
      readOnly,
    ],
  );

  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = Math.exp(-event.deltaY * 0.0015);
    setViewport((vp) => zoomAt(vp, point, factor));
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (readOnly) return;
      const map: Record<string, 'up' | 'down' | 'left' | 'right'> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      };
      const direction = map[event.key];
      if (!direction) return;
      event.preventDefault();
      onTransformChange(nudge(transform, direction, zone, event.shiftKey), { commit: true });
    },
    [onTransformChange, transform, zone, readOnly],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { w, h } = viewport.canvasPx;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, w, h);

    const k = pxPerMm(viewport);
    const half = { x: zone.w / 2, y: zone.h / 2 };
    const topLeft = zoneToScreen(viewport, { x: -half.x, y: half.y });
    const zoneW = zone.w * k;
    const zoneH = zone.h * k;

    ctx.fillStyle = partColorHex;
    ctx.fillRect(topLeft.x, topLeft.y, zoneW, zoneH);

    if (gridEnabled) drawGrid(ctx, viewport, zone, k);

    // Safe margin.
    const m = zone.safeMarginMm * k;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    ctx.strokeRect(topLeft.x + m, topLeft.y + m, zoneW - 2 * m, zoneH - 2 * m);
    ctx.setLineDash([]);

    // Zone boundary — flashes when the placement is being held back by it.
    ctx.strokeStyle = boundaryFlash ? '#f87171' : 'rgba(226, 232, 240, 0.75)';
    ctx.lineWidth = boundaryFlash ? 2.5 : 1.5;
    ctx.strokeRect(topLeft.x, topLeft.y, zoneW, zoneH);

    // Centre cross-hair: the alignment users reach for most often.
    const centre = zoneToScreen(viewport, { x: 0, y: 0 });
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(topLeft.x, centre.y);
    ctx.lineTo(topLeft.x + zoneW, centre.y);
    ctx.moveTo(centre.x, topLeft.y);
    ctx.lineTo(centre.x, topLeft.y + zoneH);
    ctx.stroke();

    if (artworkImage) {
      const c = zoneToScreen(viewport, transform.offsetMm);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate((-transform.rotationDeg * Math.PI) / 180); // zone +y is up; canvas +y is down
      ctx.scale(
        ((transform.sizeMm.w * k) / artworkImage.width) * (transform.flipX ? -1 : 1),
        ((transform.sizeMm.h * k) / artworkImage.height) * (transform.flipY ? -1 : 1),
      );
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(artworkImage, -artworkImage.width / 2, -artworkImage.height / 2);
      ctx.restore();
    }

    drawCustomGuides(ctx, viewport, customGuides);
    drawSnapGuides(ctx, viewport, guides, zone);
    if (!readOnly) drawTransformBox(ctx, viewport, transform);
    drawRulers(ctx, viewport, zone);

    // Scale readout: the promise that on-screen millimetres are real millimetres. Drawn on its own
    // plate, because it shares the bottom-left corner with the vertical ruler's last label.
    const readout = `${k.toFixed(1)} px/mm · ${zoneLabel}`;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const plate = ctx.measureText(readout).width + 12;

    ctx.fillStyle = 'rgba(11, 13, 17, 0.85)';
    ctx.fillRect(6, h - 26, plate, 18);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
    ctx.fillText(readout, 12, h - 13);
  }, [
    artworkImage,
    boundaryFlash,
    readOnly,
    customGuides,
    gridEnabled,
    guides,
    partColorHex,
    transform,
    viewport,
    zone,
    zoneLabel,
  ]);

  useLayoutEffect(() => {
    draw();
  }, [draw]);

  const box = useMemo(() => aabb(transform), [transform]);

  return (
    <div ref={wrapRef} className="face-view">
      {/*
        `application` is the point of the role here: this canvas handles arrow keys itself to nudge
        artwork by exact millimetres, and the role is what stops a screen reader capturing them
        first. The rule reads canvas-with-a-role as a mistake; here it is the accessible behaviour.
      */}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label={`Face view for ${zoneLabel}. Artwork ${transform.sizeMm.w.toFixed(1)} by ${transform.sizeMm.h.toFixed(1)} millimetres, offset ${transform.offsetMm.x.toFixed(1)}, ${transform.offsetMm.y.toFixed(1)}.`}
        style={{ cursor, touchAction: 'none', outline: 'none', visibility: loading ? 'hidden' : 'visible' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        data-testid="face-view-canvas"
        data-surface-color={partColorHex}
        data-color-sampled={surfaceColorSampled}
      />
      {loading && (
        <div className="viewport-loading" data-testid="placement-loading">
          <LoadingSpinner />
          <small>Preparing placement colors…</small>
        </div>
      )}
      <span className="sr-only" data-testid="placement-readout">
        {`x ${transform.offsetMm.x.toFixed(2)} y ${transform.offsetMm.y.toFixed(2)} w ${transform.sizeMm.w.toFixed(2)} h ${transform.sizeMm.h.toFixed(2)} rot ${transform.rotationDeg.toFixed(1)} left ${box.min.x.toFixed(2)}`}
      </span>
    </div>
  );
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  zone: ZoneExtent,
  k: number,
): void {
  const step = rulerStepMm(viewport, 26);
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -zone.w / 2; x <= zone.w / 2 + 1e-6; x += step) {
    const p = zoneToScreen(viewport, { x, y: zone.h / 2 });
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x, p.y + zone.h * k);
  }
  for (let y = -zone.h / 2; y <= zone.h / 2 + 1e-6; y += step) {
    const p = zoneToScreen(viewport, { x: -zone.w / 2, y });
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + zone.w * k, p.y);
  }
  ctx.stroke();
}

function drawSnapGuides(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  guides: ActiveSnap[],
  zone: ZoneExtent,
): void {
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  for (const guide of guides) {
    ctx.strokeStyle = GUIDE_COLORS[guide.kind];
    ctx.beginPath();
    if (guide.axis === 'x') {
      const top = zoneToScreen(viewport, { x: guide.valueMm, y: zone.h / 2 });
      const bottom = zoneToScreen(viewport, { x: guide.valueMm, y: -zone.h / 2 });
      ctx.moveTo(top.x, top.y - 14);
      ctx.lineTo(bottom.x, bottom.y + 14);
    } else {
      const left = zoneToScreen(viewport, { x: -zone.w / 2, y: guide.valueMm });
      const right = zoneToScreen(viewport, { x: zone.w / 2, y: guide.valueMm });
      ctx.moveTo(left.x - 14, left.y);
      ctx.lineTo(right.x + 14, right.y);
    }
    ctx.stroke();
  }
}

function drawTransformBox(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  transform: Transform,
): void {
  const pts = corners(transform).map((c) => zoneToScreen(viewport, c));
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();

  const handles = handlePositions(viewport, transform);
  ctx.fillStyle = '#0f1115';
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  for (const p of Object.values(handles)) {
    ctx.beginPath();
    ctx.rect(p.x - 4, p.y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }

  const rotate = rotateHandlePosition(viewport, transform);
  const north = handles.n;
  ctx.beginPath();
  ctx.moveTo(north.x, north.y);
  ctx.lineTo(rotate.x, rotate.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rotate.x, rotate.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawRulers(ctx: CanvasRenderingContext2D, viewport: Viewport, zone: ZoneExtent): void {
  const step = rulerStepMm(viewport);
  const { w, h } = viewport.canvasPx;

  ctx.fillStyle = 'rgba(15, 17, 21, 0.92)';
  ctx.fillRect(0, 0, w, 18);
  ctx.fillRect(0, 0, 30, h);

  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.lineWidth = 1;

  const limit = Math.max(zone.w, zone.h);
  for (let mm = -limit; mm <= limit + 1e-6; mm += step) {
    const p = zoneToScreen(viewport, { x: mm, y: 0 });
    if (p.x > 30 && p.x < w) {
      ctx.beginPath();
      ctx.moveTo(p.x, 12);
      ctx.lineTo(p.x, 18);
      ctx.stroke();
      ctx.fillText(String(round(mm)), p.x + 3, 10);
    }
    const q = zoneToScreen(viewport, { x: 0, y: mm });
    if (q.y > 18 && q.y < h) {
      ctx.beginPath();
      ctx.moveTo(24, q.y);
      ctx.lineTo(30, q.y);
      ctx.stroke();
      ctx.fillText(String(round(mm)), 3, q.y - 3);
    }
  }
}

const round = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(2)));

// -------------------------------------------------------------------------------------------
// Custom guides (F-PLACE-11)

const toMm = (viewport: Viewport, point: Vec2): Vec2 => screenToZone(viewport, point);

/**
 * Which ruler, if any, a press landed on. The left ruler makes vertical guides and vice versa.
 *
 * Screen space, and no viewport: the rulers are a fixed gutter at the edge of the canvas, so where
 * they are does not depend on how the zone is currently framed.
 */
function rulerAt(point: Vec2): Axis | null {
  if (point.x <= RULER_PX && point.y > RULER_PX) return 'x';
  if (point.y <= RULER_PX) return 'y';
  return null;
}

const outside = (point: Vec2, viewport: Viewport): boolean =>
  point.x < 0 || point.y < 0 || point.x > viewport.canvasPx.w || point.y > viewport.canvasPx.h;

/** The guide under the pointer, if one is within grabbing distance. */
function guideAt(guides: Guide[], viewport: Viewport, point: Vec2): number | null {
  for (const [index, guide] of guides.entries()) {
    const at =
      guide.axis === 'x'
        ? zoneToScreen(viewport, { x: guide.valueMm, y: 0 }).x
        : zoneToScreen(viewport, { x: 0, y: guide.valueMm }).y;
    const distance = Math.abs((guide.axis === 'x' ? point.x : point.y) - at);
    if (distance <= GUIDE_GRAB_PX) return index;
  }
  return null;
}

/** Draws the guides the user placed, distinct from the ones snapping produces while dragging. */
function drawCustomGuides(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  guides: Guide[],
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.85)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);

  for (const guide of guides) {
    ctx.beginPath();
    if (guide.axis === 'x') {
      const x = Math.round(zoneToScreen(viewport, { x: guide.valueMm, y: 0 }).x) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, viewport.canvasPx.h);
    } else {
      const y = Math.round(zoneToScreen(viewport, { x: 0, y: guide.valueMm }).y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(viewport.canvasPx.w, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
