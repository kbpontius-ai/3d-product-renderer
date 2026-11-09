'use client';

import { useEffect, useRef, useState } from 'react';
import { Hand, MousePointer2, Minus, Plus, Undo2, Redo2 } from 'lucide-react';

export function ArtworkViewer({
  src,
  widthMm,
  heightMm,
  editWidthMm,
  editHeightMm,
  canUndo,
  canRedo,
  disabled,
  onResize,
  onUndo,
  onRedo,
}: {
  src: string;
  widthMm: number;
  heightMm: number;
  editWidthMm: number;
  editHeightMm: number;
  disabled: boolean;
  onResize: (widthMm: number, heightMm: number, coalesce: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [frame, setFrame] = useState({ w: 600, h: 400 });
  const [fitSize, setFitSize] = useState({ w: widthMm, h: heightMm });
  const canvas = useRef<HTMLDivElement>(null);
  const resize = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    widthMm: number;
    heightMm: number;
    moved: boolean;
  } | null>(null);
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setFrame({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  const pixelsPerMm = Math.min((frame.w * 0.85) / fitSize.w, (frame.h * 0.85) / fitSize.h);
  const fittedWidth = widthMm * pixelsPerMm;
  return (
    <div className="artwork-viewer">
      <div className="artwork-viewer-toolbar">
        <button
          type="button"
          title="Select artwork"
          aria-label="Select artwork"
          className={tool === 'select' ? 'active' : ''}
          onClick={() => setTool('select')}
        >
          <MousePointer2 size={18} />
        </button>
        <button
          type="button"
          title="Pan"
          aria-label="Pan"
          className={tool === 'pan' ? 'active' : ''}
          onClick={() => setTool('pan')}
        >
          <Hand size={18} />
        </button>
        <span className="artwork-toolbar-rule" />
        <button
          type="button"
          aria-label="Zoom out"
          disabled={zoom <= 0.25}
          onClick={() => setZoom(Math.max(0.25, zoom / 1.25))}
        >
          <Minus size={18} />
        </button>
        <span className="artwork-zoom" data-testid="artwork-zoom">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={zoom >= 4}
          onClick={() => setZoom(Math.min(4, zoom * 1.25))}
        >
          <Plus size={18} />
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
            setFitSize({ w: widthMm, h: heightMm });
          }}
        >
          Fit
        </button>
        <span className="artwork-toolbar-rule" />
        <button type="button" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={18} />
        </button>
        <button type="button" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={18} />
        </button>
      </div>
      <div
        ref={canvas}
        className={`artwork-canvas${tool === 'pan' ? ' artwork-canvas-pan' : ''}`}
        data-testid="artwork-canvas"
        onPointerDown={(event) => {
          if (tool !== 'pan' || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: pan.x, y: pan.y, startX: event.clientX, startY: event.clientY };
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setPan({
              x: drag.current.x + event.clientX - drag.current.startX,
              y: drag.current.y + event.clientY - drag.current.startY,
            });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div
          className="artwork-canvas-selection"
          data-selected={tool === 'select' && !disabled}
          style={{
            width: fittedWidth,
            height: (fittedWidth * heightMm) / widthMm,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <img
            src={src}
            alt="Selected SVG artwork"
            draggable={false}
            data-testid="artwork-svg-preview"
          />
          {tool === 'select' &&
            !disabled &&
            [
              [-1, -1],
              [1, -1],
              [-1, 1],
              [1, 1],
            ].map(([x, y], index) => (
              <button
                key={index}
                type="button"
                className="artwork-resize-handle"
                aria-label={`Resize artwork corner ${index + 1}`}
                disabled={disabled}
                style={{ left: x === -1 ? 0 : '100%', top: y === -1 ? 0 : '100%' }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const rect = event.currentTarget.parentElement!.getBoundingClientRect();
                  resize.current = {
                    x: event.clientX,
                    y: event.clientY,
                    w: rect.width,
                    h: rect.height,
                    widthMm: editWidthMm,
                    heightMm: editHeightMm,
                    moved: false,
                  };
                }}
                onPointerMove={(event) => {
                  const start = resize.current;
                  if (!start) return;
                  const movement =
                    ((event.clientX - start.x) * x! * start.w +
                      (event.clientY - start.y) * y! * start.h) /
                    (start.w ** 2 + start.h ** 2);
                  const scale = Math.min(
                    1000 / Math.max(start.widthMm, start.heightMm),
                    Math.max(0.01 / Math.min(start.widthMm, start.heightMm), 1 + movement),
                  );
                  if (scale === 1 && !start.moved) return;
                  onResize(start.widthMm * scale, start.heightMm * scale, start.moved);
                  start.moved = true;
                }}
                onPointerUp={() => {
                  resize.current = null;
                }}
                onPointerCancel={() => {
                  resize.current = null;
                }}
              />
            ))}
        </div>
      </div>
      <p className="artwork-canvas-size" data-testid="artwork-preview-size">
        {widthMm.toFixed(1)} × {heightMm.toFixed(1)} mm
      </p>
    </div>
  );
}
