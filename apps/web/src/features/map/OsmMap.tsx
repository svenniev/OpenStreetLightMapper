import { useEffect, useRef } from "react";
import type { Map as LeafletMap, LeafletMouseEvent } from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Polygon,
  Polyline,
  Popup,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { OSM_ATTRIBUTION, OSM_TILE_URL } from "../../lib/config";
import type { CameraPosition } from "../../lib/types";
import type {
  CommittedRoi,
  DraftShape,
  DrawingTool,
  ImageResult,
  LatLngPair,
} from "../../lib/searchTypes";

/** Budapest city scale. */
const INITIAL_CENTER: [number, number] = [47.4979, 19.0402];
const INITIAL_ZOOM = 12;

const ACCENT = "#0e7490";
const ERROR = "#b42318";
const VIEWED = "#b45309";

/** Keep Leaflet in sync with panel resizes (CSS grid changes, narrow layouts). */
function ResizeHandler() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(container);
    // Initial sync after mount (fonts/panels may still settle).
    const timer = window.setTimeout(() => map.invalidateSize(), 100);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [map]);
  return null;
}

interface DrawingHandlerProps {
  drawing: DrawingTool;
  onMapClick: (pair: LatLngPair) => void;
  onMapMouseMove: (pair: LatLngPair) => void;
  onMapDoubleClick: () => void;
  onCancelDrawing: () => void;
}

/** Temporary drawing listeners: attached only in drawing mode, removed after. */
function DrawingHandler(props: DrawingHandlerProps) {
  const map = useMap();
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!props.drawing) return;
    const handleClick = (event: LeafletMouseEvent) => {
      propsRef.current.onMapClick([event.latlng.lat, event.latlng.lng]);
    };
    const handleMouseMove = (event: LeafletMouseEvent) => {
      propsRef.current.onMapMouseMove([event.latlng.lat, event.latlng.lng]);
    };
    const handleDoubleClick = () => {
      propsRef.current.onMapDoubleClick();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") propsRef.current.onCancelDrawing();
    };
    map.on("click", handleClick);
    map.on("mousemove", handleMouseMove);
    if (props.drawing === "polygon") {
      // Double-click finishes the polygon instead of zooming while drawing.
      map.on("dblclick", handleDoubleClick);
      map.doubleClickZoom.disable();
    }
    window.addEventListener("keydown", handleKey);
    return () => {
      map.off("click", handleClick);
      map.off("mousemove", handleMouseMove);
      map.off("dblclick", handleDoubleClick);
      map.doubleClickZoom.enable();
      window.removeEventListener("keydown", handleKey);
    };
  }, [map, props.drawing]);
  return null;
}

function DraftLayer({ draft }: { draft: DraftShape }) {
  if (draft.tool === "rectangle") {
    const [first] = draft.vertices;
    if (!first || !draft.cursor) return null;
    const bounds: [LatLngPair, LatLngPair] = [first, draft.cursor];
    return <Rectangle bounds={bounds} pathOptions={{ color: ACCENT, dashArray: "6 4", weight: 2, fillOpacity: 0.08 }} />;
  }
  const line = draft.cursor ? [...draft.vertices, draft.cursor] : draft.vertices;
  if (line.length === 0) return null;
  return (
    <>
      <Polyline positions={line} pathOptions={{ color: ACCENT, dashArray: "6 4", weight: 2 }} />
      {draft.vertices.map(([lat, lng], index) => (
        <CircleMarker
          key={`${lat},${lng}:${index}`}
          center={[lat, lng]}
          radius={3}
          pathOptions={{ color: ACCENT, fillColor: ACCENT, fillOpacity: 1 }}
          interactive={false}
        />
      ))}
    </>
  );
}

function RoiLayer({ roi }: { roi: CommittedRoi }) {
  const positions = roi.polygon.coordinates[0].map(
    ([lng, lat]) => [lat, lng] as LatLngPair,
  );
  const color = roi.valid ? ACCENT : ERROR;
  return (
    <Polygon
      positions={positions}
      pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: 0.1 }}
    />
  );
}

export interface OsmMapProps {
  mapRef: React.RefObject<LeafletMap | null>;
  roi: CommittedRoi | null;
  drawing: DrawingTool;
  draft: DraftShape | null;
  results: ImageResult[];
  selectedId: string | null;
  cameraPosition: CameraPosition | null;
  viewedImageId: string | null;
  onMapClick: (pair: LatLngPair) => void;
  onMapMouseMove: (pair: LatLngPair) => void;
  onMapDoubleClick: () => void;
  onCancelDrawing: () => void;
  onSelectResult: (id: string) => void;
}

export function OsmMap(props: OsmMapProps) {
  const { cameraPosition, drawing } = props;
  const markersInteractive = drawing === null;
  return (
    <>
      <MapContainer
        ref={props.mapRef}
        center={INITIAL_CENTER}
        zoom={INITIAL_ZOOM}
        scrollWheelZoom
        preferCanvas
        className="map-container"
        aria-label="OpenStreetMap of Budapest"
      >
        <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
        {props.roi && <RoiLayer roi={props.roi} />}
        {props.draft && <DraftLayer draft={props.draft} />}
        {props.results.map((image) => {
          const [lng, lat] = image.coordinate;
          const selected = image.id === props.selectedId;
          return (
            <CircleMarker
              key={image.id}
              center={[lat, lng]}
              radius={selected ? 8 : 5}
              pathOptions={
                selected
                  ? { color: "#0b3b47", weight: 2, fillColor: ACCENT, fillOpacity: 1 }
                  : { color: ACCENT, weight: 2, fillColor: "#ffffff", fillOpacity: 1 }
              }
              interactive={markersInteractive}
              eventHandlers={{ click: () => props.onSelectResult(image.id) }}
            >
              <Tooltip direction="top" offset={[0, -6]}>
                {image.id}
              </Tooltip>
            </CircleMarker>
          );
        })}
        {cameraPosition && (
          <CircleMarker
            center={[cameraPosition.lat, cameraPosition.lng]}
            radius={8}
            pathOptions={{ color: "#5c3a09", weight: 2, fillColor: VIEWED, fillOpacity: 1 }}
          >
            <Popup>
              Viewed image camera{props.viewedImageId ? ` (${props.viewedImageId})` : ""} — not a
              lamp location.
            </Popup>
          </CircleMarker>
        )}
        <DrawingHandler
          drawing={drawing}
          onMapClick={props.onMapClick}
          onMapMouseMove={props.onMapMouseMove}
          onMapDoubleClick={props.onMapDoubleClick}
          onCancelDrawing={props.onCancelDrawing}
        />
        <ResizeHandler />
      </MapContainer>
      <ul className="map-legend" aria-label="Map marker legend">
        <li>
          <span className="legend-swatch legend-swatch--result" aria-hidden="true" />
          Result image
        </li>
        <li>
          <span className="legend-swatch legend-swatch--selected" aria-hidden="true" />
          Selected result
        </li>
        <li>
          <span className="legend-swatch legend-swatch--viewed" aria-hidden="true" />
          Viewed image camera
        </li>
      </ul>
    </>
  );
}
