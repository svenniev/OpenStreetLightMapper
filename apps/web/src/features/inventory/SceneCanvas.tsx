import { useRef, useState } from "react";
import type { NormalizedRect, ObservationDecision } from "./inventoryTypes";
import { DEMO_SCENE_HEIGHT, DEMO_SCENE_WIDTH, DemoScene } from "./demoScenes";

export interface OverlayRect {
  obsId: string;
  label: string;
  rect: NormalizedRect;
  selected: boolean;
  decision: ObservationDecision;
}

export interface SceneCanvasProps {
  sceneId: string;
  label: string;
  rects: OverlayRect[];
  /** Stale sessions render read-only. */
  interactive: boolean;
  /** The next background drag draws a rectangle. */
  drawArmed: boolean;
  onSelectRect: (obsId: string) => void;
  onDrawRect: (rect: NormalizedRect) => void;
  onMoveRect: (obsId: string, rect: NormalizedRect) => void;
  onDisarm: () => void;
}

const MIN_SIZE = 5; // svg units

export function clampNormalized(rect: NormalizedRect): NormalizedRect {
  const x = Math.min(Math.max(rect.x, 0), 1);
  const y = Math.min(Math.max(rect.y, 0), 1);
  const w = Math.min(Math.max(rect.w, 0), 1 - x);
  const h = Math.min(Math.max(rect.h, 0), 1 - y);
  return { x, y, w, h };
}

function sameRect(a: NormalizedRect, b: NormalizedRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

const DECISION_COLORS: Record<ObservationDecision, string> = {
  pending: "#b45309",
  accepted: "#15803d",
  rejected: "#b42318",
  deferred: "#64748b",
};

type Gesture =
  | { kind: "draw"; startX: number; startY: number; curX: number; curY: number }
  | { kind: "move"; obsId: string; grabDX: number; grabDY: number; orig: NormalizedRect; moved: boolean }
  | { kind: "resize"; obsId: string; orig: NormalizedRect; moved: boolean }
  | null;

/**
 * Static-scene canvas: normalized-coordinate overlays that scale with the
 * illustration, with click-select, drag-draw, drag-move, and corner-resize.
 * Coordinate math is pure from the SVG bounding box (the stylesheet keeps the
 * 4:3 aspect so the mapping stays exact).
 */
export function SceneCanvas(props: SceneCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [gesture, setGesture] = useState<Gesture>(null);

  const toSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - box.left) / box.width) * DEMO_SCENE_WIDTH,
      y: ((clientY - box.top) / box.height) * DEMO_SCENE_HEIGHT,
    };
  };

  const toNormalized = (x: number, y: number, w: number, h: number): NormalizedRect =>
    clampNormalized({
      x: x / DEMO_SCENE_WIDTH,
      y: y / DEMO_SCENE_HEIGHT,
      w: w / DEMO_SCENE_WIDTH,
      h: h / DEMO_SCENE_HEIGHT,
    });

  const finishGesture = (point: { x: number; y: number }) => {
    const current = gesture;
    setGesture(null);
    if (!current) return;
    if (current.kind === "draw") {
      const x = Math.min(current.startX, point.x);
      const y = Math.min(current.startY, point.y);
      const w = Math.abs(point.x - current.startX);
      const h = Math.abs(point.y - current.startY);
      props.onDisarm();
      if (w >= MIN_SIZE && h >= MIN_SIZE) props.onDrawRect(toNormalized(x, y, w, h));
      return;
    }
    if (!current.moved) return; // plain click: selection only, no commit
    if (current.kind === "move") {
      const w = current.orig.w * DEMO_SCENE_WIDTH;
      const h = current.orig.h * DEMO_SCENE_HEIGHT;
      const x = Math.min(Math.max(point.x - current.grabDX, 0), DEMO_SCENE_WIDTH - w);
      const y = Math.min(Math.max(point.y - current.grabDY, 0), DEMO_SCENE_HEIGHT - h);
      const next = toNormalized(x, y, w, h);
      if (!sameRect(next, current.orig)) props.onMoveRect(current.obsId, next);
      return;
    }
    const x = current.orig.x * DEMO_SCENE_WIDTH;
    const y = current.orig.y * DEMO_SCENE_HEIGHT;
    const w = Math.min(Math.max(point.x - x, MIN_SIZE), DEMO_SCENE_WIDTH - x);
    const h = Math.min(Math.max(point.y - y, MIN_SIZE), DEMO_SCENE_HEIGHT - y);
    const next = toNormalized(x, y, w, h);
    if (!sameRect(next, current.orig)) props.onMoveRect(current.obsId, next);
  };

  const drawPreview =
    gesture?.kind === "draw"
      ? {
          x: Math.min(gesture.startX, gesture.curX),
          y: Math.min(gesture.startY, gesture.curY),
          w: Math.abs(gesture.curX - gesture.startX),
          h: Math.abs(gesture.curY - gesture.startY),
        }
      : null;

  return (
    <DemoScene
      sceneId={props.sceneId}
      label={props.label}
      svgProps={{
        ref: svgRef,
        className: `demo-scene${props.drawArmed ? " demo-scene--drawing" : ""}`,
        onMouseDown: (event) => {
          if (!props.interactive || !props.drawArmed || event.button !== 0) return;
          const point = toSvg(event.clientX, event.clientY);
          setGesture({ kind: "draw", startX: point.x, startY: point.y, curX: point.x, curY: point.y });
        },
        onMouseMove: (event) => {
          if (!gesture) return;
          if (gesture.kind === "draw") {
            const point = toSvg(event.clientX, event.clientY);
            setGesture({ ...gesture, curX: point.x, curY: point.y });
          } else if (!gesture.moved) {
            // Move/resize commit on release; track drag intent for click detection.
            setGesture({ ...gesture, moved: true });
          }
        },
        onMouseUp: (event) => {
          if (!gesture) return;
          finishGesture(toSvg(event.clientX, event.clientY));
        },
        onMouseLeave: () => {
          if (gesture?.kind === "draw") props.onDisarm();
          setGesture(null);
        },
      }}
    >
      {props.rects.map((entry) => {
        const x = entry.rect.x * DEMO_SCENE_WIDTH;
        const y = entry.rect.y * DEMO_SCENE_HEIGHT;
        const w = entry.rect.w * DEMO_SCENE_WIDTH;
        const h = entry.rect.h * DEMO_SCENE_HEIGHT;
        const color = DECISION_COLORS[entry.decision];
        return (
          <g key={entry.obsId}>
            {entry.selected && (
              <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} fill="none" stroke="#ffffff" strokeWidth={5} />
            )}
            <rect
              data-obs-rect={entry.obsId}
              x={x}
              y={y}
              width={w}
              height={h}
              fill={color}
              fillOpacity={0.12}
              stroke={color}
              strokeWidth={entry.selected ? 3 : 2}
              style={{ cursor: props.interactive ? "move" : "default" }}
              onMouseDown={(event) => {
                if (!props.interactive || props.drawArmed || event.button !== 0) return;
                event.stopPropagation();
                props.onSelectRect(entry.obsId);
                const point = toSvg(event.clientX, event.clientY);
                setGesture({
                  kind: "move",
                  obsId: entry.obsId,
                  grabDX: point.x - x,
                  grabDY: point.y - y,
                  orig: entry.rect,
                  moved: false,
                });
              }}
            >
              <title>{entry.label}</title>
            </rect>
            {entry.selected && (
              <text x={x} y={y - 6} fontSize={12} fill={color} fontWeight="bold">
                {entry.label}
              </text>
            )}
            {entry.selected && props.interactive && (
              <circle
                data-obs-handle={entry.obsId}
                cx={x + w}
                cy={y + h}
                r={6}
                fill="#ffffff"
                stroke={color}
                strokeWidth={2}
                style={{ cursor: "nwse-resize" }}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  setGesture({ kind: "resize", obsId: entry.obsId, orig: entry.rect, moved: false });
                }}
              />
            )}
          </g>
        );
      })}
      {drawPreview && drawPreview.w >= MIN_SIZE && drawPreview.h >= MIN_SIZE && (
        <rect
          x={drawPreview.x}
          y={drawPreview.y}
          width={drawPreview.w}
          height={drawPreview.h}
          fill="none"
          stroke="#0e7490"
          strokeWidth={2}
          strokeDasharray="5 3"
        />
      )}
    </DemoScene>
  );
}
