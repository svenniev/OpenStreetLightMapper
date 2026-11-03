import type { DrawingTool } from "../../lib/searchTypes";

export interface MapToolbarProps {
  drawing: DrawingTool;
  /** Distinct draft vertices (enables polygon finish at ≥3). */
  draftVertexCount: number;
  hasRegion: boolean;
  onStartRectangle: () => void;
  onStartPolygon: () => void;
  onUseCurrentView: () => void;
  onFinishPolygon: () => void;
  onCancelDrawing: () => void;
  onClearRegion: () => void;
}

export function MapToolbar(props: MapToolbarProps) {
  const { drawing } = props;
  return (
    <div className="map-toolbar" role="toolbar" aria-label="Region selection tools">
      {drawing === null && (
        <>
          <button type="button" className="toolbar-button" onClick={props.onStartRectangle}>
            Draw rectangle
          </button>
          <button type="button" className="toolbar-button" onClick={props.onStartPolygon}>
            Draw polygon
          </button>
          <button type="button" className="toolbar-button" onClick={props.onUseCurrentView}>
            Use current map view
          </button>
          <button
            type="button"
            className="toolbar-button"
            onClick={props.onClearRegion}
            disabled={!props.hasRegion}
          >
            Clear region
          </button>
        </>
      )}
      {drawing === "rectangle" && (
        <>
          <span className="drawing-hint" role="status">
            Click two opposite corners on the map.
          </span>
          <button type="button" className="toolbar-button" onClick={props.onCancelDrawing}>
            Cancel drawing
          </button>
        </>
      )}
      {drawing === "polygon" && (
        <>
          <span className="drawing-hint" role="status">
            Click to add vertices, then finish with the button or a double-click.
          </span>
          <button
            type="button"
            className="toolbar-button toolbar-button--primary"
            onClick={props.onFinishPolygon}
            disabled={props.draftVertexCount < 3}
          >
            Finish polygon
          </button>
          <button type="button" className="toolbar-button" onClick={props.onCancelDrawing}>
            Cancel drawing
          </button>
        </>
      )}
    </div>
  );
}
