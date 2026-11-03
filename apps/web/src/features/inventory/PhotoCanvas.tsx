import { useEffect, useRef, useState } from "react";
import type { NormalizedRect, ObservationDecision, ObservationMask, SourceView } from "./inventoryTypes";
import { clampNormalized, cropPixels } from "./imageViews";

export interface PhotoOverlay {
  obsId: string;
  label: string;
  /** Normalized to the VIEW raster (crop or full). */
  rect: NormalizedRect | null;
  mask: ObservationMask | null;
  maskStale: boolean;
  selected: boolean;
  decision: ObservationDecision;
}

interface PhotoCanvasProps {
  mediaUrl: string;
  alt: string;
  view: SourceView;
  overlays: PhotoOverlay[];
  interactive: boolean;
  drawArmed: boolean;
  zoom: number;
  onZoomChange?: (zoom: number) => void;
  onSelectRect: (obsId: string) => void;
  onDrawRect: (rect: NormalizedRect) => void;
  onMoveRect: (obsId: string, rect: NormalizedRect) => void;
  onDisarm: () => void;
  onMediaError?: () => void;
}

const DECISION_COLORS: Record<ObservationDecision, string> = {
  pending: "#b45309",
  accepted: "#15803d",
  rejected: "#b42318",
  deferred: "#64748b",
};

const ZOOM_LEVELS = [1, 1.5, 2, 3];
const MASK_FILL = "#1e88e5";

/**
 * Draws one recorded crop region into a canvas. Decodes through the same
 * orientation-applied bitmap path as inference, so the preview pixels are
 * exactly the analyzed pixels (EXIF-safe, unlike naturalWidth mapping).
 */
function CropLayer({ mediaUrl, view, alt }: { mediaUrl: string; view: SourceView; alt: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const crop = view.crop;

  useEffect(() => {
    setFailed(false);
    if (!crop) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let bitmap: ImageBitmap | null = null;
    void (async () => {
      try {
        const response = await fetch(mediaUrl);
        if (!response.ok) throw new Error(`status ${response.status}`);
        const blob = await response.blob();
        bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        if (cancelled) return;
        const region = cropPixels(crop, bitmap.width, bitmap.height);
        canvas.width = region.w;
        canvas.height = region.h;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no 2d context");
        context.drawImage(bitmap, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        bitmap?.close();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaUrl, crop]);

  if (failed) {
    return <div className="photo-fallback" role="img" aria-label={alt}>The crop preview failed to load.</div>;
  }
  // Canvas intrinsic size is set on draw; CSS stretches it to the frame.
  return <canvas ref={canvasRef} className="photo-media" role="img" aria-label={alt} />;
}

/**
 * Photograph annotation surface: the decoded photo (or exact crop pixels)
 * with normalized-rectangle overlays, model masks, draw/move gestures, and
 * zoom. Overlay geometry is normalized to the VIEW raster, so inference
 * boxes align with the analyzed pixels by construction; the SVG stretches
 * with the media on resize.
 */
export function PhotoCanvas(props: PhotoCanvasProps) {
  const { view } = props;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [drawPreview, setDrawPreview] = useState<NormalizedRect | null>(null);
  const gestureRef = useRef<{ mode: "draw" | "move"; obsId: string | null; start: NormalizedRect | null }>({
    mode: "draw",
    obsId: null,
    start: null,
  });
  const [mediaFailed, setMediaFailed] = useState(false);

  useEffect(() => {
    setMediaFailed(false);
    setDrawPreview(null);
  }, [props.mediaUrl, view.viewId]);

  const toNormalized = (clientX: number, clientY: number): NormalizedRect | null => {
    const frame = frameRef.current?.querySelector("svg.photo-overlay");
    if (!frame) return null;
    const box = frame.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return clampNormalized({
      x: (clientX - box.left) / box.width,
      y: (clientY - box.top) / box.height,
      w: 0,
      h: 0,
    });
  };

  const onPointerDown = (event: React.MouseEvent, obsId: string | null, rect: NormalizedRect | null) => {
    if (!props.interactive) return;
    if (props.drawArmed) {
      const point = toNormalized(event.clientX, event.clientY);
      if (!point) return;
      gestureRef.current = { mode: "draw", obsId: null, start: point };
      setDrawPreview({ ...point, w: 0, h: 0 });
    } else if (obsId && rect) {
      gestureRef.current = { mode: "move", obsId, start: { ...rect } };
      props.onSelectRect(obsId);
    }
    event.preventDefault();
  };

  const onPointerMove = (event: React.MouseEvent) => {
    const gesture = gestureRef.current;
    if (!props.interactive || !gesture.start) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    if (gesture.mode === "draw") {
      const start = gesture.start;
      setDrawPreview({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      });
    } else if (gesture.obsId) {
      const start = gesture.start;
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      props.onMoveRect(gesture.obsId, clampNormalized({ ...start, x: start.x + dx, y: start.y + dy }));
    }
  };

  const onPointerUp = () => {
    const gesture = gestureRef.current;
    if (gesture.mode === "draw" && drawPreview && drawPreview.w > 0.005 && drawPreview.h > 0.005) {
      props.onDrawRect(clampNormalized(drawPreview));
      props.onDisarm();
    }
    gestureRef.current = { mode: "draw", obsId: null, start: null };
    setDrawPreview(null);
  };

  const zoomIndex = Math.max(
    0,
    ZOOM_LEVELS.findIndex((level) => level >= props.zoom - 1e-9),
  );

  return (
    <div className="photo-canvas">
      {props.onZoomChange && (
        <div className="photo-zoom" role="group" aria-label="Photo zoom">
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={zoomIndex <= 0}
            onClick={() => props.onZoomChange?.(ZOOM_LEVELS[Math.max(0, zoomIndex - 1)])}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="photo-zoom__level" aria-live="polite">
            {Math.round(ZOOM_LEVELS[zoomIndex === -1 ? 0 : zoomIndex] * 100)}%
          </span>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
            onClick={() => props.onZoomChange?.(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, zoomIndex + 1)])}
            aria-label="Zoom in"
          >
            +
          </button>
          {props.zoom !== 1 && (
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              onClick={() => props.onZoomChange?.(1)}
            >
              Reset
            </button>
          )}
        </div>
      )}
      <div className="photo-scroll">
        <div ref={frameRef} className="photo-frame" style={{ width: `${props.zoom * 100}%` }}>
          {view.crop ? (
            <CropLayer mediaUrl={props.mediaUrl} view={view} alt={props.alt} />
          ) : mediaFailed ? (
            <div className="photo-fallback" role="img" aria-label={props.alt}>
              The photograph failed to load.{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setMediaFailed(false);
                  props.onMediaError?.();
                }}
              >
                Retry
              </button>
            </div>
          ) : (
            <img
              className="photo-media"
              src={props.mediaUrl}
              alt={props.alt}
              draggable={false}
              onError={() => setMediaFailed(true)}
            />
          )}
          <svg
            className="photo-overlay"
            viewBox={`0 0 ${view.width} ${view.height}`}
            preserveAspectRatio="none"
            onMouseDown={(event) => onPointerDown(event, null, null)}
            onMouseMove={onPointerMove}
            onMouseUp={onPointerUp}
            onMouseLeave={() => {
              gestureRef.current = { mode: "draw", obsId: null, start: null };
              setDrawPreview(null);
            }}
          >
            {props.overlays.map((entry) => {
              if (!entry.rect) return null;
              const color = DECISION_COLORS[entry.decision];
              const x = entry.rect.x * view.width;
              const y = entry.rect.y * view.height;
              const w = entry.rect.w * view.width;
              const h = entry.rect.h * view.height;
              const showMask = entry.mask && !entry.maskStale;
              return (
                <g key={entry.obsId}>
                  {showMask && (
                    <svg
                      x={entry.mask!.bounds.left}
                      y={entry.mask!.bounds.top}
                      width={Math.max(entry.mask!.bounds.right - entry.mask!.bounds.left, 1)}
                      height={Math.max(entry.mask!.bounds.bottom - entry.mask!.bounds.top, 1)}
                      viewBox={`0 0 ${entry.mask!.width} ${entry.mask!.height}`}
                    >
                      <path
                        d={entry.mask!.svgPath}
                        fill={MASK_FILL}
                        fillOpacity={0.35}
                        stroke={MASK_FILL}
                        strokeWidth={1}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          props.onSelectRect(entry.obsId);
                        }}
                        style={{ cursor: props.interactive ? "pointer" : "default" }}
                      >
                        <title>{entry.label} model mask</title>
                      </path>
                    </svg>
                  )}
                  {entry.selected && (
                    <rect
                      x={x - 3}
                      y={y - 3}
                      width={w + 6}
                      height={h + 6}
                      fill="none"
                      stroke="#ffffff"
                      strokeWidth={5}
                    />
                  )}
                  <rect
                    x={x}
                    y={y}
                    width={Math.max(w, 2)}
                    height={Math.max(h, 2)}
                    fill={color}
                    fillOpacity={0.12}
                    stroke={color}
                    strokeWidth={entry.selected ? 3 : 2}
                    style={{ cursor: props.interactive ? "move" : "default" }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      onPointerDown(event, entry.obsId, entry.rect);
                    }}
                  >
                    <title>{entry.label}</title>
                  </rect>
                  {entry.selected && (
                    <text x={x} y={Math.max(y - 6, 12)} fontSize={Math.max(view.width / 60, 12)} fill={color} fontWeight="bold">
                      {entry.label}
                    </text>
                  )}
                </g>
              );
            })}
            {drawPreview && drawPreview.w > 0 && drawPreview.h > 0 && (
              <rect
                x={drawPreview.x * view.width}
                y={drawPreview.y * view.height}
                width={drawPreview.w * view.width}
                height={drawPreview.h * view.height}
                fill="none"
                stroke="#0e7490"
                strokeWidth={2}
                strokeDasharray="5 3"
              />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}
