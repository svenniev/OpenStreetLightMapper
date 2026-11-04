import { useEffect, useRef } from "react";
import { divIcon, type Map as LeafletMap, type LeafletMouseEvent } from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
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
const STREET = "#15803d";
const STREET_MUTED = "#94a3b8";

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

/** Manually placed inventory asset (never a camera position). */
export interface AssetMapMarker {
  id: string;
  category: "pole" | "luminaire";
  position: LatLngPair;
}

/** Automatically located asset (estimated, unreviewed — never survey-grade). */
export interface AutoAssetMarker {
  id: string;
  category: "pole" | "luminaire";
  position: LatLngPair;
  uncertaintyM: number;
  method: string;
  imageCount: number;
  sequenceCount: number;
  flags: string[];
}

interface DrawingHandlerProps {
  drawing: DrawingTool;
  onMapClick: (pair: LatLngPair) => void;
  onMapMouseMove: (pair: LatLngPair) => void;
  onMapDoubleClick: () => void;
  onCancelDrawing: () => void;
}

/** Placement clicks: active only while armed and not drawing. */
function PlacementHandler(props: {
  armed: boolean;
  drawing: DrawingTool;
  onPlacementClick: (pair: LatLngPair) => void;
}) {
  const map = useMap();
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!props.armed) return;
    const handleClick = (event: LeafletMouseEvent) => {
      const current = propsRef.current;
      if (!current.armed || current.drawing) return;
      current.onPlacementClick([event.latlng.lat, event.latlng.lng]);
    };
    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [map, props.armed]);

  return null;
}

/** Bring the map into view when placement arms (placing needs the map). */
function ScrollOnArmed(props: { armed: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (props.armed) map.getContainer().scrollIntoView({ block: "nearest" });
  }, [map, props.armed]);
  return null;
}

function AutoAssetMarkerView(props: {
  marker: AutoAssetMarker;
  interactive: boolean;
  onSelect: (id: string) => void;
}) {
  const { marker } = props;
  return (
    <Marker
      position={marker.position}
      icon={divIcon({
        className: `asset-pin asset-pin--auto asset-pin--auto-${marker.category}`,
        html: "",
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      })}
      keyboard={props.interactive}
      eventHandlers={props.interactive ? { click: () => props.onSelect(marker.id) } : {}}
    >
      <Tooltip>
        {marker.id} ({marker.category === "pole" ? "Pole/support" : "Luminaire"}) — automatically
        estimated ±{marker.uncertaintyM.toFixed(1)} m ({marker.method}), unreviewed, from{" "}
        {marker.imageCount} images in {marker.sequenceCount} sequences
        {marker.flags.length > 0 ? ` [${marker.flags.join(", ")}]` : ""}.
      </Tooltip>
    </Marker>
  );
}

function AssetMarker(props: {
  marker: AssetMapMarker;
  selected: boolean;
  interactive: boolean;
  onSelect: (id: string) => void;
}) {
  const { marker } = props;
  return (
    <Marker
      position={marker.position}
      icon={divIcon({
        className: `asset-pin asset-pin--${marker.category}${props.selected ? " asset-pin--selected" : ""}`,
        html: "",
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      })}
      keyboard={props.interactive}
      eventHandlers={props.interactive ? { click: () => props.onSelect(marker.id) } : {}}
    >
      <Tooltip>
        {marker.id} ({marker.category === "pole" ? "Pole/support" : "Luminaire"}) — manually
        placed, approximate.
      </Tooltip>
    </Marker>
  );
}

/** Reports settled map views (pan/zoom) for workspace persistence. */
function ViewReporter(props: { onViewChange: ((center: LatLngPair, zoom: number) => void) | undefined }) {
  const map = useMap();
  const callbackRef = useRef(props.onViewChange);
  callbackRef.current = props.onViewChange;
  useEffect(() => {
    if (!callbackRef.current) return;
    const report = () => {
      const center = map.getCenter();
      callbackRef.current?.([center.lat, center.lng], map.getZoom());
    };
    map.on("moveend", report);
    return () => {
      map.off("moveend", report);
    };
  }, [map]);
  return null;
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

function SequencePointMarker({
  image,
  outside,
  viewed,
  pending,
  interactive,
  onSelect,
}: {
  image: ImageResult;
  outside: boolean;
  viewed: boolean;
  pending: boolean;
  interactive: boolean;
  onSelect: (id: string) => void;
}) {
  const [lng, lat] = image.coordinate;
  const ring = outside ? "#64748b" : ACCENT;
  return (
    <CircleMarker
      center={[lat, lng]}
      radius={viewed || pending ? 8 : 5}
      pathOptions={
        viewed
          ? { color: "#0b3b47", weight: 2, fillColor: ACCENT, fillOpacity: 1 }
          : pending
            ? {
                color: ring,
                weight: 2,
                dashArray: "3 3",
                fillColor: "#ffffff",
                fillOpacity: 1,
              }
            : outside
              ? { color: ring, weight: 2, fillColor: "#e2e8f0", fillOpacity: 1 }
              : { color: ring, weight: 2, fillColor: "#ffffff", fillOpacity: 1 }
      }
      interactive={interactive}
      eventHandlers={{ click: () => onSelect(image.id) }}
    >
      <Tooltip direction="top" offset={[0, -6]}>
        {image.id}
      </Tooltip>
    </CircleMarker>
  );
}

/** Clipped in-RoI street geometry in Leaflet [lat, lng] order. */
export interface StreetShape {
  id: string;
  displayName: string;
  /** One entry per clipped fragment line. */
  lines: LatLngPair[][];
  checked: boolean;
  focused: boolean;
}

function StreetLayer({ street }: { street: StreetShape }) {
  return (
    <>
      {street.lines.map((line, index) => (
        <Polyline
          key={`${street.id}:${index}`}
          positions={line}
          pathOptions={
            street.focused
              ? { color: STREET, weight: 6, opacity: 1 }
              : street.checked
                ? { color: STREET, weight: 3, opacity: 0.85 }
                : { color: STREET_MUTED, weight: 2, opacity: 0.45 }
          }
          interactive={false}
        >
          {street.focused && <Tooltip sticky>{street.displayName}</Tooltip>}
        </Polyline>
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

export interface SequencePoints {
  inside: ImageResult[];
  outside: ImageResult[];
}

export interface OsmMapProps {
  mapRef: React.RefObject<LeafletMap | null>;
  roi: CommittedRoi | null;
  drawing: DrawingTool;
  draft: DraftShape | null;
  /** Selected-sequence members only: discovery no longer paints global dots. */
  sequencePoints: SequencePoints;
  /** Clipped street lines; unchecked streets render muted, focus highlights. */
  streets: StreetShape[];
  /** Actually displayed image: highlight derives from viewer truth, not clicks. */
  viewedId: string | null;
  /** Requested but not yet displayed. */
  pendingId: string | null;
  cameraPosition: CameraPosition | null;
  viewedImageId: string | null;
  onMapClick: (pair: LatLngPair) => void;
  onMapMouseMove: (pair: LatLngPair) => void;
  onMapDoubleClick: () => void;
  onCancelDrawing: () => void;
  onSelectResult: (id: string) => void;
  /** Inventory placement: armed clicks become drafts instead of drawing. */
  placementArmed: boolean;
  placementDraft: LatLngPair | null;
  /** Manually placed assets of the active inventory session. */
  inventoryAssets: AssetMapMarker[];
  selectedAssetId: string | null;
  /** Automatically located assets of the selected auto job (own layer). */
  autoAssets: AutoAssetMarker[];
  onAutoAssetClick: (id: string) => void;
  onPlacementClick: (pair: LatLngPair) => void;
  onAssetMarkerClick: (id: string) => void;
  /** Restored map view for a reopened workspace (mount-time only). */
  initialView?: { center: LatLngPair; zoom: number } | null;
  /** Settled map view after pan/zoom (for workspace persistence). */
  onViewChange?: (center: LatLngPair, zoom: number) => void;
}

export function OsmMap(props: OsmMapProps) {
  const { cameraPosition, drawing } = props;
  const markersInteractive = drawing === null;
  return (
    <>
      <MapContainer
        ref={props.mapRef}
        center={props.initialView?.center ?? INITIAL_CENTER}
        zoom={props.initialView?.zoom ?? INITIAL_ZOOM}
        scrollWheelZoom
        preferCanvas
        className={`map-container${props.placementArmed ? " map-container--placing" : ""}`}
        aria-label="OpenStreetMap of Budapest"
      >
        <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
        {props.roi && <RoiLayer roi={props.roi} />}
        {props.streets.map((street) => (
          <StreetLayer key={street.id} street={street} />
        ))}
        {props.draft && <DraftLayer draft={props.draft} />}
        {props.sequencePoints.inside.map((image) => (
          <SequencePointMarker
            key={image.id}
            image={image}
            outside={false}
            viewed={image.id === props.viewedId}
            pending={image.id === props.pendingId}
            interactive={markersInteractive}
            onSelect={props.onSelectResult}
          />
        ))}
        {props.sequencePoints.outside.map((image) => (
          <SequencePointMarker
            key={image.id}
            image={image}
            outside
            viewed={image.id === props.viewedId}
            pending={image.id === props.pendingId}
            interactive={markersInteractive}
            onSelect={props.onSelectResult}
          />
        ))}
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
        {props.inventoryAssets.map((marker) => (
          <AssetMarker
            key={marker.id}
            marker={marker}
            selected={marker.id === props.selectedAssetId}
            interactive={markersInteractive}
            onSelect={props.onAssetMarkerClick}
          />
        ))}
        {props.autoAssets.map((marker) => (
          <AutoAssetMarkerView
            key={`auto-${marker.id}`}
            marker={marker}
            interactive={markersInteractive}
            onSelect={props.onAutoAssetClick}
          />
        ))}
        {props.placementDraft && (
          <CircleMarker
            center={props.placementDraft}
            radius={9}
            pathOptions={{ color: ACCENT, weight: 2, dashArray: "4 3", fill: false }}
            interactive={false}
          >
            <Tooltip permanent={false}>Draft placement — apply or cancel in the workflow</Tooltip>
          </CircleMarker>
        )}
        <DrawingHandler
          drawing={drawing}
          onMapClick={props.onMapClick}
          onMapMouseMove={props.onMapMouseMove}
          onMapDoubleClick={props.onMapDoubleClick}
          onCancelDrawing={props.onCancelDrawing}
        />
        <PlacementHandler
          armed={props.placementArmed}
          drawing={drawing}
          onPlacementClick={props.onPlacementClick}
        />
        <ScrollOnArmed armed={props.placementArmed} />
        <ResizeHandler />
        <ViewReporter onViewChange={props.onViewChange} />
      </MapContainer>
      <ul className="map-legend" aria-label="Map marker legend">
        <li>
          <span className="legend-swatch legend-swatch--result" aria-hidden="true" />
          Sequence image
        </li>
        <li>
          <span className="legend-swatch legend-swatch--outside" aria-hidden="true" />
          Sequence image outside RoI
        </li>
        <li>
          <span className="legend-swatch legend-swatch--selected" aria-hidden="true" />
          Displayed image
        </li>
        <li>
          <span className="legend-swatch legend-swatch--pending" aria-hidden="true" />
          Loading image
        </li>
        <li>
          <span className="legend-swatch legend-swatch--viewed" aria-hidden="true" />
          Viewed image camera
        </li>
        <li>
          <span className="legend-swatch legend-swatch--street" aria-hidden="true" />
          Street in region
        </li>
        <li>
          <span className="legend-swatch legend-swatch--street-muted" aria-hidden="true" />
          Excluded street
        </li>
        <li>
          <span className="legend-swatch legend-swatch--asset" aria-hidden="true" />
          Placed asset (manual, approximate)
        </li>
        <li>
          <span className="legend-swatch legend-swatch--draft" aria-hidden="true" />
          Draft placement
        </li>
      </ul>
    </>
  );
}
