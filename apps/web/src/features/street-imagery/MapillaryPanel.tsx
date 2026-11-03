import { useCallback, useEffect, useRef, useState } from "react";
import { Viewer } from "mapillary-js";
import "mapillary-js/dist/mapillary.css";
import { MAPILLARY_CLIENT_TOKEN } from "../../lib/config";
import type { CameraPosition } from "../../lib/types";
import type { RequestedImage } from "../../lib/searchTypes";
import { createMoveQueue, type MoveQueue } from "../../lib/viewerQueue";

const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type ViewerState = "idle" | "loading" | "ready" | "error";

function classifyViewerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (/webgl/i.test(message)) {
    return "WebGL is unavailable in this browser, so Mapillary imagery cannot be rendered here.";
  }
  if (/401|403|unauthor|forbidden|access token|token/i.test(message)) {
    return `Mapillary authorization failed (${message}). Check VITE_MAPILLARY_CLIENT_TOKEN.`;
  }
  if (/404|not found|invalid.*image|image.*invalid/i.test(lowered)) {
    return `Mapillary image not found (${message}). Check the image ID.`;
  }
  if (/network|fetch|failed to fetch|load failed|offline/i.test(lowered)) {
    return `Network error while loading Mapillary imagery (${message}).`;
  }
  return `Could not load that Mapillary image (${message}).`;
}

interface LngLatLike {
  lat: number;
  lng?: number;
  lon?: number;
}

function normalizeLngLat(value: unknown): CameraPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<LngLatLike>;
  const lat = candidate.lat;
  const lng = candidate.lng ?? candidate.lon;
  if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }
  return null;
}

/** Best-effort coordinate extraction across MapillaryJS Image shapes. */
async function extractCameraPosition(image: unknown): Promise<CameraPosition | null> {
  if (typeof image !== "object" || image === null) return null;
  const record = image as Record<string, unknown>;

  if (typeof record.getLngLat === "function") {
    try {
      const value = await (record.getLngLat as () => unknown)();
      const normalized = normalizeLngLat(value);
      if (normalized) return normalized;
    } catch {
      // Fall through to property-based shapes.
    }
  }

  for (const key of ["computedLngLat", "lngLat", "originalLngLat"]) {
    const normalized = normalizeLngLat(record[key]);
    if (normalized) return normalized;
  }
  return null;
}

function extractImageId(image: unknown): string | null {
  if (typeof image !== "object" || image === null) return null;
  const id = (image as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface MapillaryPanelProps {
  onCameraPosition: (position: CameraPosition | null) => void;
  onActualImageId: (imageId: string | null) => void;
  /** Latest load request from map/list selection; the token orders repeat requests. */
  requestedImage: RequestedImage | null;
  /** True when the displayed image is not part of the current search results. */
  isActualOutsideResults: boolean;
}

export function MapillaryPanel({
  onCameraPosition,
  onActualImageId,
  requestedImage,
  isActualOutsideResults,
}: MapillaryPanelProps) {
  const [manualId, setManualId] = useState("");
  const [viewerState, setViewerState] = useState<ViewerState>("idle");
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [actualId, setActualId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const listenerRef = useRef<((event: { image?: unknown }) => void) | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const queueRef = useRef<MoveQueue | null>(null);
  const disposedRef = useRef(false);
  const arrivalRef = useRef(0);
  const appliedArrivalRef = useRef(0);
  const lastPropTokenRef = useRef<number | null>(null);

  const onCameraPositionRef = useRef(onCameraPosition);
  onCameraPositionRef.current = onCameraPosition;
  const onActualImageIdRef = useRef(onActualImageId);
  onActualImageIdRef.current = onActualImageId;
  const actualIdRef = useRef(actualId);
  actualIdRef.current = actualId;
  const viewerStateRef = useRef(viewerState);
  viewerStateRef.current = viewerState;

  const handleImageEvent = useCallback(async (event: { image?: unknown }) => {
    // Arrival ordering: async extraction may finish out of order, so a stale
    // handler must never overwrite a newer event's image, status, or marker.
    arrivalRef.current += 1;
    const arrival = arrivalRef.current;
    const imageId = extractImageId(event.image);
    const position = await extractCameraPosition(event.image).catch(() => null);
    if (disposedRef.current) return;
    if (arrival < appliedArrivalRef.current) return;
    appliedArrivalRef.current = arrival;
    if (imageId) {
      const genuineChange = imageId !== actualIdRef.current;
      setActualId(imageId);
      onActualImageIdRef.current(imageId);
      if (genuineChange) {
        // Viewer navigation to a new image retires any previous failed request.
        setError(null);
        setViewerState("ready");
      } else if (viewerStateRef.current === "idle" || viewerStateRef.current === "loading") {
        setViewerState("ready");
      }
    }
    // Only report coordinates actually supplied by the viewer; never invent any.
    onCameraPositionRef.current(position);
  }, []);
  const handleImageEventRef = useRef(handleImageEvent);
  handleImageEventRef.current = handleImageEvent;

  // Dispose viewer + listeners on unmount (also covers React StrictMode remounts).
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      queueRef.current = null;
      const viewer = viewerRef.current;
      const listener = listenerRef.current;
      viewerRef.current = null;
      listenerRef.current = null;
      if (viewer) {
        if (listener) {
          try {
            viewer.off("image", listener);
          } catch {
            // Listener removal is best-effort during teardown.
          }
        }
        try {
          viewer.remove();
        } catch {
          // Fall back to clearing the container if remove() is unavailable.
          if (containerRef.current) containerRef.current.innerHTML = "";
        }
      }
    };
  }, []);

  const ensureViewer = useCallback((): Viewer => {
    const existing = viewerRef.current;
    if (existing) return existing;
    const container = containerRef.current;
    if (!container) {
      throw new Error("Mapillary viewer container is not available.");
    }
    let viewer: Viewer;
    try {
      viewer = new Viewer({
        container,
        accessToken: MAPILLARY_CLIENT_TOKEN,
        component: { cover: false },
      });
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Mapillary viewer failed to initialize.",
      );
    }
    const listener = (event: { image?: unknown }) => {
      void handleImageEventRef.current(event);
    };
    viewer.on("image", listener);
    viewerRef.current = viewer;
    listenerRef.current = listener;

    // Keep the viewer in sync with panel resizes.
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = new ResizeObserver(() => {
      try {
        viewer.resize();
      } catch {
        // Resize is best-effort.
      }
    });
    resizeObserverRef.current.observe(container);
    return viewer;
  }, []);

  const getQueue = useCallback((): MoveQueue => {
    const existing = queueRef.current;
    if (existing) return existing;
    const queue = createMoveQueue(async (id: string) => {
      const viewer = ensureViewer();
      return viewer.moveTo(id);
    });
    queueRef.current = queue;
    return queue;
  }, [ensureViewer]);

  const requestMove = useCallback(
    async (id: string) => {
      const trimmed = id.trim();
      if (!trimmed) {
        setError("Enter a Mapillary image ID first.");
        setViewerState("error");
        return;
      }
      if (!IMAGE_ID_PATTERN.test(trimmed)) {
        setError("That image ID looks invalid. Use 1–64 letters, digits, underscore, or hyphen.");
        setViewerState("error");
        return;
      }
      setRequestedId(trimmed);
      setViewerState("loading");
      setError(null);
      const queue = getQueue();
      const ticket = queue.request(trimmed);
      const outcome = await ticket.done;
      if (disposedRef.current) return;
      if (!outcome.applied) return; // Superseded; the newer request owns the status.
      if (outcome.error !== undefined) {
        // Keep any previous camera position and actual ID; a failed load must
        // not fabricate either.
        setError(classifyViewerError(outcome.error));
        setViewerState("error");
        return;
      }
      const imageId = extractImageId(outcome.result);
      const position = await extractCameraPosition(outcome.result).catch(() => null);
      if (disposedRef.current) return;
      if (queue.latestToken() !== ticket.token) return; // Newer request arrived meanwhile.
      if (imageId) {
        setActualId(imageId);
        onActualImageIdRef.current(imageId);
      }
      onCameraPositionRef.current(position);
      setViewerState("ready");
    },
    [getQueue],
  );

  // Map/list selections arrive as prop requests; manual loads use requestMove directly.
  useEffect(() => {
    if (!requestedImage || !MAPILLARY_CLIENT_TOKEN) return;
    if (lastPropTokenRef.current === requestedImage.token) return;
    lastPropTokenRef.current = requestedImage.token;
    void requestMove(requestedImage.id);
  }, [requestedImage, requestMove]);

  const retry = useCallback(() => {
    if (requestedId) void requestMove(requestedId);
  }, [requestMove, requestedId]);

  if (!MAPILLARY_CLIENT_TOKEN) {
    return (
      <div className="mapillary-empty">
        <p className="panel-notice">
          <strong>Mapillary is not configured.</strong>
        </p>
        <p>
          Set <code>VITE_MAPILLARY_CLIENT_TOKEN</code> in <code>apps/web/.env</code> (see{" "}
          <code>.env.example</code>) using a client access token from the{" "}
          <a href="https://www.mapillary.com/dashboard/developers">
            Mapillary developer dashboard
          </a>
          , then restart the dev server. The map and the rest of the app keep working without
          it.
        </p>
      </div>
    );
  }

  return (
    <div className="mapillary-panel">
      <div
        ref={containerRef}
        className="mapillary-container"
        aria-label="Mapillary street imagery viewer"
        role="region"
      />

      <div className="mapillary-status" role="status" aria-live="polite">
        {viewerState === "idle" && !actualId && (
          <span>
            Select a result on the map or in the list, or enter an image ID below for a manual
            test load.
          </span>
        )}
        {viewerState === "loading" && requestedId && <span>Loading {requestedId}…</span>}
        {viewerState === "ready" && actualId && (
          <span>
            Showing {actualId}
            {isActualOutsideResults ? " — Outside current search results" : ""}. The map marker
            shows the camera position, never a lamp.
          </span>
        )}
        {viewerState === "error" && error && (
          <span className="error-text">
            {requestedId ? (
              <>
                Could not load requested image {requestedId}: {error}{" "}
              </>
            ) : (
              <>{error} </>
            )}
            {actualId ? <>Still showing {actualId}.</> : <>Nothing is displayed.</>}{" "}
            {requestedId && (
              <button type="button" className="link-button" onClick={retry}>
                Retry
              </button>
            )}
          </span>
        )}
      </div>

      <form
        className="mapillary-form"
        onSubmit={(event) => {
          event.preventDefault();
          void requestMove(manualId);
        }}
      >
        <label htmlFor="mapillary-image-id">Manual image ID (testing)</label>
        <div className="mapillary-form-row">
          <input
            id="mapillary-image-id"
            name="mapillary-image-id"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. p1x2…"
            value={manualId}
            onChange={(event) => setManualId(event.target.value)}
          />
          <button type="submit" disabled={viewerState === "loading"}>
            {viewerState === "loading" ? "Loading…" : "Load image"}
          </button>
        </div>
      </form>
    </div>
  );
}
