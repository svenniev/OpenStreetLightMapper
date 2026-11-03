import { useRef } from "react";

export interface DiagramPin {
  assetId: string;
  category: "pole" | "luminaire";
  x: number;
  y: number;
  selected: boolean;
}

export interface DemoDiagramProps {
  pins: DiagramPin[];
  draft: { x: number; y: number } | null;
  interactive: boolean;
  selectedAssetId: string | null;
  onSelectPin: (assetId: string) => void;
  onDiagramClick: (point: { x: number; y: number }) => void;
}

/**
 * Schematic top-down street diagram for demo placement. Coordinates are
 * 0..100 diagram units — explicitly not geographic measurements. Poles render
 * as triangles, luminaires as diamonds, the draft as a dashed circle: shape
 * as well as color distinguishes them.
 */
export function DemoDiagram(props: DemoDiagramProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const toDiagram = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(((clientX - box.left) / box.width) * 100, 0), 100),
      y: Math.min(Math.max(((clientY - box.top) / box.height) * 100, 0), 100),
    };
  };

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Schematic street diagram for demo placement (not geographic)"
      className="demo-diagram"
      style={{ cursor: props.interactive ? "crosshair" : "default" }}
      onClick={(event) => {
        if (!props.interactive) return;
        props.onDiagramClick(toDiagram(event.clientX, event.clientY));
      }}
    >
      <rect x={0} y={0} width={100} height={100} fill="#e4e9ee" />
      <rect x={0} y={38} width={100} height={10} fill="#ccd1d6" />
      <rect x={0} y={48} width={100} height={16} fill="#9aa2a9" />
      <rect x={0} y={64} width={100} height={10} fill="#ccd1d6" />
      <line x1={0} y1={56} x2={100} y2={56} stroke="#f4f4f4" strokeWidth={1.5} strokeDasharray="5 4" />
      <rect x={6} y={8} width={22} height={20} fill="#c3ccd4" stroke="#8d99a5" />
      <rect x={36} y={8} width={22} height={20} fill="#c3ccd4" stroke="#8d99a5" />
      <rect x={66} y={8} width={22} height={20} fill="#c3ccd4" stroke="#8d99a5" />
      <rect x={6} y={80} width={22} height={12} fill="#c3ccd4" stroke="#8d99a5" />
      <rect x={66} y={80} width={22} height={12} fill="#c3ccd4" stroke="#8d99a5" />
      <text x={97} y={97} textAnchor="end" fontSize={5} fill="#5b6770" fontStyle="italic">
        schematic — not geographic
      </text>
      {props.pins.map((pin) =>
        pin.category === "pole" ? (
          <g
            key={pin.assetId}
            role="button"
            tabIndex={0}
            aria-label={`Highlight ${pin.assetId} (pole)`}
            style={{ cursor: "pointer" }}
            onClick={(event) => {
              event.stopPropagation();
              props.onSelectPin(pin.assetId);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelectPin(pin.assetId);
              }
            }}
          >
            <title>{pin.assetId} (pole)</title>
            <polygon
              points={`${pin.x},${pin.y - 4} ${pin.x - 3.5},${pin.y + 3} ${pin.x + 3.5},${pin.y + 3}`}
              fill="#0e7490"
              stroke={pin.selected ? "#0b3b47" : "#ffffff"}
              strokeWidth={pin.selected ? 1.5 : 1}
            />
            <text x={pin.x + 4.5} y={pin.y + 2} fontSize={4.5} fill="#0b3b47">
              {pin.assetId}
            </text>
          </g>
        ) : (
          <g
            key={pin.assetId}
            role="button"
            tabIndex={0}
            aria-label={`Highlight ${pin.assetId} (luminaire)`}
            style={{ cursor: "pointer" }}
            onClick={(event) => {
              event.stopPropagation();
              props.onSelectPin(pin.assetId);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelectPin(pin.assetId);
              }
            }}
          >
            <title>{pin.assetId} (luminaire)</title>
            <polygon
              points={`${pin.x},${pin.y - 4} ${pin.x + 3.5},${pin.y} ${pin.x},${pin.y + 4} ${pin.x - 3.5},${pin.y}`}
              fill="#b45309"
              stroke={pin.selected ? "#5c3a09" : "#ffffff"}
              strokeWidth={pin.selected ? 1.5 : 1}
            />
            <text x={pin.x + 4.5} y={pin.y + 2} fontSize={4.5} fill="#5c3a09">
              {pin.assetId}
            </text>
          </g>
        ),
      )}
      {props.draft && (
        <g>
          <circle
            cx={props.draft.x}
            cy={props.draft.y}
            r={3}
            fill="none"
            stroke="#0e7490"
            strokeWidth={1.2}
            strokeDasharray="2 1.5"
          />
          <text x={props.draft.x + 4} y={props.draft.y - 3} fontSize={4.5} fill="#0e7490">
            Draft placement
          </text>
        </g>
      )}
    </svg>
  );
}
