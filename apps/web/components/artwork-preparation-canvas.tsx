'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  preparationSubpaths,
  serializePathData,
  type ArtworkAnalysis,
  type BBox,
  type PreparationObject,
} from '@pr/svg';
import type { ArtworkEndpoint, ArtworkRepair } from '@pr/design-schema';

export const svgImage = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const matrixText = (object: PreparationObject) => {
  const { a, b, c, d, e, f } = object.matrix;
  return `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
};

export function PreparationCanvas({
  analysis,
  sourceSvg,
  objects,
  selected,
  highlighted,
  focused,
  repair,
  pending,
  frame,
  onPick,
  onFocus,
  onEndpoints,
}: {
  analysis: ArtworkAnalysis;
  sourceSvg: string;
  objects: PreparationObject[];
  selected: Set<string>;
  highlighted: Set<string>;
  focused: string | null;
  repair: boolean;
  pending: ArtworkRepair | null;
  frame: { bounds: BBox; revision: number } | null;
  onPick: (ids: string[], choose: boolean) => void;
  onFocus: (id: string) => void;
  onEndpoints: (endpoints: ArtworkEndpoint[]) => void;
}) {
  const [view, setView] = useState(analysis.viewBox);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [hover, setHover] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const clipPaths = useRef(new Map<string, SVGPathElement>());
  const drag = useRef<{ x: number; y: number; view: BBox } | null>(null);
  const selectionView = useRef<BBox | null>(null);
  const lastCandidates = useRef<string[]>([]);

  useEffect(() => {
    if (repair) selectionView.current = view;
    else if (selectionView.current) {
      setView(selectionView.current);
      selectionView.current = null;
    }
    // Preserve the selection view independently of gap inspection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repair]);
  useEffect(() => {
    if (!frame) return;
    const { x, y, w, h } = frame.bounds;
    const size = Math.max(w, h, 0.05) * 1.3;
    setView({ x: x + w / 2 - size / 2, y: y + h / 2 - size / 2, w: size, h: size });
  }, [frame]);

  const candidates = (event: PointerEvent<SVGSVGElement>) => {
    const result: string[] = [];
    for (const object of [...objects].reverse()) {
      if (object.hidden) continue;
      const path = paths.current.get(object.id);
      const ctm = path?.getScreenCTM();
      if (!path || !ctm || ctm.a * ctm.d - ctm.b * ctm.c === 0) continue;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
      const insideClips = object.clips.every((group, clipIndex) =>
        group.some((_shape, shapeIndex) => {
          const clip = clipPaths.current.get(`${object.id}:${clipIndex}:${shapeIndex}`);
          const clipCtm = clip?.getScreenCTM();
          return (
            clip &&
            clipCtm &&
            clipCtm.a * clipCtm.d - clipCtm.b * clipCtm.c !== 0 &&
            clip.isPointInFill(
              new DOMPoint(event.clientX, event.clientY).matrixTransform(clipCtm.inverse()),
            )
          );
        }),
      );
      if (
        insideClips &&
        ((object.fill && path.isPointInFill(point)) || path.isPointInStroke(point))
      )
        result.push(object.id);
    }
    return result;
  };
  const zoom = (factor: number) =>
    setView((box) => ({
      x: box.x + (box.w * (1 - factor)) / 2,
      y: box.y + (box.h * (1 - factor)) / 2,
      w: Math.max(0.0001, Math.min(100_000, box.w * factor)),
      h: Math.max(0.0001, Math.min(100_000, box.h * factor)),
    }));
  const sizePx = svg.current?.getBoundingClientRect().width ?? 500;
  const toleranceMm = (view.w / sizePx) * 6;
  const endpointObjects = repair ? objects.filter((object) => selected.has(object.id)) : [];
  const focusedObject = objects.find((object) => object.id === focused);
  const closure =
    pending?.kind === 'close' ? objects.find((object) => object.id === pending.objectId) : null;
  const closurePath =
    closure && pending?.kind === 'close'
      ? preparationSubpaths(closure).find((path) => path.id === pending.subpathId)
      : null;
  const joinPoint = (endpoint: ArtworkEndpoint) => {
    const object = objects.find((item) => item.id === endpoint.objectId);
    const path =
      object && preparationSubpaths(object).find((item) => item.id === endpoint.subpathId);
    return path ? path[endpoint.end] : null;
  };
  const proposed = closurePath
    ? [closurePath.start, closurePath.end]
    : pending?.kind === 'join'
      ? [joinPoint(pending.a), joinPoint(pending.b)]
      : null;

  return (
    <div className="preparation-source">
      <div className="preparation-canvas-toolbar">
        <button
          type="button"
          className={tool === 'select' ? 'active' : ''}
          onClick={() => setTool('select')}
        >
          {repair ? 'Inspect' : 'Select'}
        </button>
        <button
          type="button"
          className={tool === 'pan' ? 'active' : ''}
          onClick={() => setTool('pan')}
        >
          Pan
        </button>
        <button type="button" onClick={() => zoom(1.5)}>
          −
        </button>
        <button type="button" onClick={() => setView(analysis.viewBox)}>
          Fit source
        </button>
        <button type="button" onClick={() => zoom(1 / 1.5)}>
          +
        </button>
        {!repair && (
          <button type="button" onClick={() => onPick(lastCandidates.current, true)}>
            Choose object here
          </button>
        )}
      </div>
      <svg
        ref={svg}
        className={`preparation-source-svg tool-${tool}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        data-testid="preparation-source"
        onPointerDown={(event) => {
          if (tool !== 'pan') return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, view };
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            const box = event.currentTarget.getBoundingClientRect();
            const units = Math.max(
              drag.current.view.w / box.width,
              drag.current.view.h / box.height,
            );
            setView({
              ...drag.current.view,
              x: drag.current.view.x - (event.clientX - drag.current.x) * units,
              y: drag.current.view.y - (event.clientY - drag.current.y) * units,
            });
          } else if (tool === 'select') {
            lastCandidates.current = candidates(event);
            setHover(lastCandidates.current[0] ?? null);
          }
        }}
        onPointerUp={(event) => {
          if (drag.current) {
            drag.current = null;
            return;
          }
          if (tool !== 'select' || (event.target as Element).hasAttribute('data-endpoint')) return;
          const ids = candidates(event);
          lastCandidates.current = ids;
          if (repair) {
            if (ids[0]) onFocus(ids[0]);
          } else onPick(ids, event.altKey);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <image
          href={svgImage(sourceSvg)}
          x="0"
          y="0"
          width={analysis.viewBox.w}
          height={analysis.viewBox.h}
        />
        <defs>
          {objects.flatMap((object) =>
            object.clips.flatMap((group, clipIndex) =>
              group.map((shape, shapeIndex) => {
                const key = `${object.id}:${clipIndex}:${shapeIndex}`;
                const { a, b, c, d, e, f } = shape.matrix;
                return (
                  <path
                    key={key}
                    ref={(element) => {
                      if (element) clipPaths.current.set(key, element);
                      else clipPaths.current.delete(key);
                    }}
                    d={serializePathData(shape.segments, 12)}
                    transform={`matrix(${a} ${b} ${c} ${d} ${e} ${f})`}
                    fillRule={shape.fillRule}
                  />
                );
              }),
            ),
          )}
        </defs>
        {objects
          .filter((object) => !object.hidden)
          .map((object) => (
            <path
              key={object.id}
              ref={(element) => {
                if (element) paths.current.set(object.id, element);
                else paths.current.delete(object.id);
              }}
              d={serializePathData(object.segments, 12)}
              transform={matrixText(object)}
              fill="transparent"
              fillRule={object.fillRule}
              stroke="transparent"
              strokeWidth={Math.max(
                object.strokeWidth,
                toleranceMm / Math.max(Math.hypot(object.matrix.a, object.matrix.b), 1e-9),
              )}
              strokeLinecap={object.linecap}
              strokeLinejoin={object.linejoin}
              pointerEvents="none"
            />
          ))}
        {objects
          .filter(
            (object) =>
              object.id === hover ||
              object.id === focused ||
              selected.has(object.id) ||
              highlighted.has(object.id),
          )
          .map((object) => (
            <path
              key={`outline-${object.id}`}
              d={serializePathData(object.segments, 12)}
              transform={matrixText(object)}
              fill="none"
              pointerEvents="none"
              vectorEffect="non-scaling-stroke"
              stroke={
                object.id === focused || object.id === hover
                  ? '#b75e23'
                  : highlighted.has(object.id)
                    ? '#885ca2'
                    : '#3b7b79'
              }
              strokeWidth="1.5"
              strokeDasharray={selected.has(object.id) ? undefined : '4 3'}
            />
          ))}
        {repair && focusedObject && (
          <path
            d={serializePathData(focusedObject.segments, 12)}
            transform={matrixText(focusedObject)}
            fill="none"
            stroke="#b75e23"
            vectorEffect="non-scaling-stroke"
            strokeWidth="2"
            pointerEvents="none"
          />
        )}
        {endpointObjects.flatMap((object) =>
          preparationSubpaths(object)
            .filter((path) => !path.closed)
            .flatMap((path) =>
              (['start', 'end'] as const).map((end) => {
                const [x, y] = path[end];
                return (
                  <g key={`${path.id}-${end}`}>
                    <circle
                      cx={x}
                      cy={y}
                      r={toleranceMm * 0.7}
                      fill="white"
                      stroke="#b75e23"
                      vectorEffect="non-scaling-stroke"
                      data-endpoint="true"
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        const ctm = svg.current?.getScreenCTM();
                        if (!ctm) return;
                        const hits = endpointObjects.flatMap((item) =>
                          preparationSubpaths(item)
                            .filter((contour) => !contour.closed)
                            .flatMap((contour) =>
                              (['start', 'end'] as const)
                                .filter((position) => {
                                  const [x, y] = contour[position];
                                  const screen = new DOMPoint(x, y).matrixTransform(ctm);
                                  return (
                                    Math.hypot(
                                      screen.x - event.clientX,
                                      screen.y - event.clientY,
                                    ) <= 8
                                  );
                                })
                                .map((position) => ({
                                  objectId: item.id,
                                  subpathId: contour.id,
                                  end: position,
                                })),
                            ),
                        );
                        onEndpoints(hits);
                      }}
                    />
                    {object.id === focused && (
                      <text
                        x={x + toleranceMm}
                        y={y - toleranceMm}
                        fontSize={toleranceMm * 2}
                        fill="#79401a"
                        pointerEvents="none"
                      >
                        {end === 'start' ? 'A' : 'B'}
                      </text>
                    )}
                  </g>
                );
              }),
            ),
        )}
        {proposed?.[0] && proposed[1] && (
          <line
            x1={proposed[0][0]}
            y1={proposed[0][1]}
            x2={proposed[1][0]}
            y2={proposed[1][1]}
            stroke="#b75e23"
            strokeDasharray="5 4"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}
      </svg>
      <p className="preparation-help">
        {repair
          ? 'Inspect an outline. Endpoints A and B are explicit choices; no snapping is applied.'
          : 'Click to keep or remove an object. Alt-click or Choose object here resolves overlaps. Unselected paint still hides paint beneath it.'}
      </p>
    </div>
  );
}
