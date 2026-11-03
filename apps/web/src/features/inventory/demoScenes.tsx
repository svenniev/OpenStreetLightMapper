import type { ReactNode } from "react";

/**
 * Schematic demo street scenes (flat SVG illustrations, 400×300). These are
 * drawings, not photographs: every render carries a "schematic illustration"
 * tag, and observation rectangles use normalized coordinates over this
 * viewBox so overlays stay aligned at any size.
 */

export const DEMO_SCENE_WIDTH = 400;
export const DEMO_SCENE_HEIGHT = 300;

export function isDemoImageId(imageId: string): boolean {
  return imageId === "demo-image-01" || imageId === "demo-image-02" || imageId === "demo-image-03";
}

function Pole({
  x,
  top,
  base,
  arms,
}: {
  x: number;
  top: number;
  base: number;
  arms: Array<{ y: number; dir: 1 | -1; len: number }>;
}) {
  return (
    <g>
      <rect x={x} y={top} width={8} height={base - top} fill="#3d4750" />
      {arms.map((arm, index) => {
        const x0 = arm.dir === 1 ? x + 8 : x - arm.len;
        const headCx = arm.dir === 1 ? x + 8 + arm.len + 4 : x - arm.len - 4;
        return (
          <g key={index}>
            <rect x={x0} y={arm.y} width={arm.len} height={5} fill="#3d4750" />
            <ellipse cx={headCx} cy={arm.y + 8} rx={10} ry={5} fill="#f2c14e" />
            <rect x={headCx - 10} y={arm.y + 3} width={20} height={3} fill="#8a6d1f" />
          </g>
        );
      })}
    </g>
  );
}

function Houses({ variant }: { variant: 1 | 2 }) {
  return variant === 1 ? (
    <g>
      <rect x={0} y={110} width={120} height={80} fill="#c3ccd4" />
      <rect x={0} y={100} width={120} height={12} fill="#8d99a5" />
      <rect x={150} y={90} width={110} height={100} fill="#b9c2cb" />
      <rect x={150} y={80} width={110} height={12} fill="#8d99a5" />
      <rect x={290} y={115} width={110} height={75} fill="#c3ccd4" />
      <rect x={20} y={130} width={18} height={24} fill="#7c8a96" />
      <rect x={180} y={110} width={18} height={24} fill="#7c8a96" />
      <rect x={320} y={135} width={18} height={24} fill="#7c8a96" />
    </g>
  ) : (
    <g>
      <rect x={0} y={95} width={150} height={95} fill="#b9c2cb" />
      <rect x={0} y={85} width={150} height={12} fill="#8d99a5" />
      <rect x={180} y={120} width={90} height={70} fill="#c3ccd4" />
      <rect x={300} y={100} width={100} height={90} fill="#b9c2cb" />
      <rect x={40} y={115} width={18} height={24} fill="#7c8a96" />
      <rect x={330} y={120} width={18} height={24} fill="#7c8a96" />
    </g>
  );
}

function StreetBase() {
  return (
    <g>
      <rect x={0} y={0} width={400} height={190} fill="#d7e3ee" />
      <rect x={0} y={190} width={400} height={20} fill="#ccd1d6" />
      <rect x={0} y={210} width={400} height={90} fill="#9aa2a9" />
      <line x1={0} y1={255} x2={400} y2={255} stroke="#f4f4f4" strokeWidth={3} strokeDasharray="18 14" />
    </g>
  );
}

function Tree({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x - 5} y={y} width={10} height={50} fill="#6b4f35" />
      <circle cx={x} cy={y - 15} r={28} fill="#6a9a6b" />
      <circle cx={x - 18} cy={y} r={20} fill="#77a878" />
      <circle cx={x + 18} cy={y} r={20} fill="#5f8f60" />
    </g>
  );
}

function SceneArt({ sceneId }: { sceneId: string }) {
  if (sceneId === "demo-image-01") {
    return (
      <g>
        <StreetBase />
        <Houses variant={1} />
        <Pole x={66} top={70} base={195} arms={[{ y: 78, dir: 1, len: 34 }, { y: 95, dir: 1, len: 34 }]} />
        <Pole x={246} top={85} base={195} arms={[{ y: 92, dir: 1, len: 30 }]} />
      </g>
    );
  }
  if (sceneId === "demo-image-02") {
    return (
      <g>
        <StreetBase />
        <Houses variant={2} />
        <Pole x={286} top={75} base={195} arms={[{ y: 82, dir: -1, len: 34 }, { y: 99, dir: -1, len: 34 }]} />
        <Pole x={116} top={90} base={195} arms={[{ y: 97, dir: 1, len: 28 }]} />
        <rect x={344} y={144} width={22} height={30} rx={6} fill="#4a4a4a" />
      </g>
    );
  }
  return (
    <g>
      <rect x={0} y={0} width={400} height={150} fill="#cfdae4" />
      <rect x={0} y={0} width={90} height={210} fill="#aeb7c0" />
      <rect x={310} y={0} width={90} height={210} fill="#aeb7c0" />
      <rect x={90} y={150} width={220} height={60} fill="#c3ccd4" />
      <rect x={0} y={210} width={400} height={90} fill="#9aa2a9" />
      <Pole x={176} top={70} base={195} arms={[{ y: 78, dir: 1, len: 34 }, { y: 95, dir: 1, len: 34 }]} />
      <Tree x={303} y={150} />
    </g>
  );
}

export interface DemoSceneProps {
  sceneId: string;
  label: string;
  children?: ReactNode;
  svgProps?: React.SVGProps<SVGSVGElement>;
}

/** Illustration frame: fixed viewBox, schema tag, overlay children on top. */
export function DemoScene(props: DemoSceneProps) {
  return (
    <svg
      viewBox={`0 0 ${DEMO_SCENE_WIDTH} ${DEMO_SCENE_HEIGHT}`}
      role="img"
      aria-label={`${props.label} (schematic illustration)`}
      className="demo-scene"
      {...props.svgProps}
    >
      <SceneArt sceneId={props.sceneId} />
      {props.children}
      <text x={392} y={292} textAnchor="end" fontSize={11} fill="#5b6770" fontStyle="italic">
        schematic illustration
      </text>
    </svg>
  );
}
