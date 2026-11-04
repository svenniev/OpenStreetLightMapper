import { useCallback, useEffect, useRef, useState } from "react";
import { latLngBounds, type Map as LeafletMap } from "leaflet";
import {
  checkRoiLimits,
  latLngToLngLat,
  rectangleRingFromBbox,
  validateRoiPolygon,
  type LngLat,
  type RoiPolygon,
} from "@openstreetlightmapper/geo";
import { ApiError, searchMapillaryImages } from "../lib/api";
import { createSearchGuard, sortSearchResults } from "../lib/search";
import type {
  CommittedRoi,
  DraftShape,
  DrawingTool,
  ImageResult,
  LatLngPair,
  RequestedImage,
  RoiShape,
  SearchError,
  SearchQueryMeta,
  SearchStatus,
  ViewerActual,
} from "../lib/searchTypes";

export interface UseRoiSearchOptions {
  backendConnected: boolean;
  /** Null while unknown (backend unreachable). */
  searchConfigured: boolean | null;
  /**
   * Restored discovery state for a reopened workspace (remount per
   * workspace). Seeds pools/lists without running a new search.
   */
  initial?: {
    roi: CommittedRoi;
    images: ImageResult[];
    seeds: ImageResult[];
    query: SearchQueryMeta | null;
    warnings: string[];
    searchError: SearchError | null;
    status: SearchStatus;
    everSearched: boolean;
    imagerySnapshotId: number;
    requestedImageId: string | null;
  } | null;
}

const EMPTY_SEARCH = {
  images: [] as ImageResult[],
  query: null as SearchQueryMeta | null,
  warnings: [] as string[],
  searchError: null as SearchError | null,
};

function samePair(a: LatLngPair, b: LatLngPair): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Session bound on hydrated (non-seed) image records in the region pool. */
const MAX_HYDRATED_POOL = 20_000;

/**
 * Coordinates drawing drafts, the single committed RoI, search generations,
 * result selection, and actual viewer state. Drafts, committed regions, query
 * generations, selections, and viewer truth stay distinct by construction.
 */
export function useRoiSearch(options: UseRoiSearchOptions) {
  const mapRef = useRef<LeafletMap | null>(null);
  const initial = options.initial ?? null;
  const [roi, setRoi] = useState<CommittedRoi | null>(initial?.roi ?? null);
  const [drawing, setDrawing] = useState<DrawingTool>(null);
  const [draft, setDraft] = useState<DraftShape | null>(null);
  const [status, setStatus] = useState<SearchStatus>(initial?.status ?? "idle");
  const [images, setImages] = useState<ImageResult[]>(initial?.images ?? EMPTY_SEARCH.images);
  /** Discovery seeds (in-RoI by construction); grouping input, never hydrated. */
  const [seeds, setSeeds] = useState<ImageResult[]>(initial?.seeds ?? []);
  const [query, setQuery] = useState<SearchQueryMeta | null>(initial?.query ?? EMPTY_SEARCH.query);
  const [warnings, setWarnings] = useState<string[]>(initial?.warnings ?? EMPTY_SEARCH.warnings);
  const [searchError, setSearchError] = useState<SearchError | null>(
    initial?.searchError ?? EMPTY_SEARCH.searchError,
  );
  const [requestedImage, setRequestedImage] = useState<RequestedImage | null>(
    initial?.requestedImageId ? { id: initial.requestedImageId, token: 1 } : null,
  );
  const [viewerActual, setViewerActual] = useState<ViewerActual>({
    imageId: null,
    sequenceId: null,
    position: null,
  });
  const [everSearched, setEverSearched] = useState(initial?.everSearched ?? false);
  /** Bumps on every discovery completion and pool-expanding hydration. */
  const [imagerySnapshotId, setImagerySnapshotId] = useState(initial?.imagerySnapshotId ?? 0);

  const roiIdRef = useRef(initial?.roi.id ?? 0);
  const requestTokenRef = useRef(initial?.requestedImageId ? 1 : 0);
  const guardRef = useRef(createSearchGuard());
  const searchAbortRef = useRef<AbortController | null>(null);
  /** Seed IDs of the current discovery; hydrated records evict around them. */
  const seedIdsRef = useRef<Set<string>>(new Set((initial?.seeds ?? []).map((seed) => seed.id)));

  // Mirrors for stable async callbacks.
  const roiRef = useRef<CommittedRoi | null>(null);
  roiRef.current = roi;
  const statusRef = useRef(status);
  statusRef.current = status;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const viewerActualRef = useRef(viewerActual);
  viewerActualRef.current = viewerActual;
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const invalidateSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    guardRef.current.invalidate();
    seedIdsRef.current = new Set();
    setStatus("idle");
    setImages([]);
    setSeeds([]);
    setQuery(null);
    setWarnings([]);
    setSearchError(null);
    setImagerySnapshotId(0);
  }, []);

  // Abort and invalidate outstanding discovery work on unmount.
  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      guardRef.current.invalidate();
    },
    [],
  );

  const commitRing = useCallback(
    (shape: RoiShape, ring: LngLat[]) => {
      const candidate: RoiPolygon = { type: "Polygon", coordinates: [ring] };
      const validation = validateRoiPolygon(candidate);
      roiIdRef.current += 1;
      const id = roiIdRef.current;
      if (!validation.ok) {
        setRoi({
          id,
          shape,
          polygon: candidate,
          areaSqM: 0,
          bbox: [0, 0, 0, 0],
          valid: false,
          errorCode: validation.code,
          errorMessage: validation.message,
        });
      } else {
        const limits = checkRoiLimits(validation.areaSqM, validation.bbox);
        setRoi({
          id,
          shape,
          polygon: validation.polygon,
          areaSqM: validation.areaSqM,
          bbox: validation.bbox,
          valid: limits.ok,
          errorCode: limits.ok ? null : (limits.code ?? "REGION_TOO_LARGE"),
          errorMessage: limits.ok ? null : (limits.message ?? "Region too large."),
        });
      }
      // Replacement invalidates the previous search; cancellation of a draft
      // never reaches this path, so the old results survive until commit.
      invalidateSearch();
      setDrawing(null);
      setDraft(null);
    },
    [invalidateSearch],
  );

  const startDrawing = useCallback((tool: Exclude<DrawingTool, null>) => {
    // An in-flight search for the committed region may continue; committing a
    // replacement invalidates it, while cancelling the draft preserves it.
    setDrawing(tool);
    setDraft({ tool, vertices: [], cursor: null });
  }, []);

  const cancelDrawing = useCallback(() => {
    // Restores the previous committed region and results untouched.
    setDrawing(null);
    setDraft(null);
  }, []);

  const handleMapClick = useCallback(
    (pair: LatLngPair) => {
      const current = draft;
      if (!drawing || !current) return;
      if (drawing === "rectangle") {
        if (current.vertices.length === 0) {
          setDraft({ ...current, vertices: [pair] });
        } else if (!samePair(current.vertices[0], pair)) {
          const [lat1, lng1] = current.vertices[0];
          const south = Math.min(lat1, pair[0]);
          const north = Math.max(lat1, pair[0]);
          const west = Math.min(lng1, pair[1]);
          const east = Math.max(lng1, pair[1]);
          commitRing("rectangle", rectangleRingFromBbox([west, south, east, north]));
        }
      } else {
        const last = current.vertices[current.vertices.length - 1];
        if (last && samePair(last, pair)) return;
        setDraft({ ...current, vertices: [...current.vertices, pair] });
      }
    },
    [commitRing, draft, drawing],
  );

  const handleMapMouseMove = useCallback(
    (pair: LatLngPair) => {
      if (!drawing || !draft) return;
      setDraft((prev) => (prev ? { ...prev, cursor: pair } : prev));
    },
    [drawing, draft],
  );

  const finishPolygon = useCallback(() => {
    if (drawing !== "polygon" || !draft) return;
    const distinct = new Set(draft.vertices.map(([lat, lng]) => `${lat},${lng}`));
    if (distinct.size < 3) return;
    const ring = draft.vertices.map(([lat, lng]) => latLngToLngLat(lat, lng));
    ring.push([...ring[0]] as LngLat);
    commitRing("polygon", ring);
  }, [commitRing, draft, drawing]);

  const useCurrentView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    commitRing("rectangle", rectangleRingFromBbox([west, south, east, north]));
  }, [commitRing]);

  const clearRegion = useCallback(() => {
    invalidateSearch();
    setRoi(null);
    setDrawing(null);
    setDraft(null);
    // A displayed image survives as viewer truth; it becomes "outside results".
  }, [invalidateSearch]);

  const fitRegion = useCallback(() => {
    const map = mapRef.current;
    const current = roiRef.current;
    if (!map || !current) return;
    const bounds = latLngBounds(current.polygon.coordinates[0].map(([lng, lat]) => [lat, lng] as LatLngPair));
    map.fitBounds(bounds.pad(0.1));
  }, []);

  const runSearch = useCallback(async () => {
    const current = roiRef.current;
    const opts = optionsRef.current;
    if (!current?.valid || statusRef.current === "loading") return;
    if (!opts.backendConnected || opts.searchConfigured !== true) return;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const token = guardRef.current.next();
    const roiId = current.id;
    // A new explicit search clears the previous result set and warnings; the region stays.
    setStatus("loading");
    setImages([]);
    setSeeds([]);
    setQuery(null);
    setWarnings([]);
    setSearchError(null);
    try {
      const response = await searchMapillaryImages(current.polygon, controller.signal);
      if (!guardRef.current.isCurrent(token) || roiIdRef.current !== roiId) return; // stale
      seedIdsRef.current = new Set(response.images.map((image) => image.id));
      const sorted = sortSearchResults(response.images);
      setImages(sorted);
      setSeeds(sorted);
      setQuery(response.query);
      setWarnings(response.warnings);
      setStatus(response.images.length > 0 ? "results" : "empty");
      setEverSearched(true);
      setImagerySnapshotId((value) => value + 1);
    } catch (error) {
      if (!guardRef.current.isCurrent(token) || roiIdRef.current !== roiId) return; // stale
      if (controller.signal.aborted) {
        setStatus("cancelled");
        return;
      }
      if (error instanceof ApiError) {
        setSearchError({ code: error.code, message: error.message, retryable: error.retryable });
      } else {
        setSearchError({
          code: "SEARCH_FAILED",
          message: "Image search failed unexpectedly.",
          retryable: true,
        });
      }
      setStatus("failed");
    }
  }, []);

  const cancelSearch = useCallback(() => {
    if (statusRef.current !== "loading") return;
    // Invalidate acceptance immediately: a transport that resolves after abort
    // must not populate results, and the UI settles on cancelled at once.
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    guardRef.current.invalidate();
    setStatus("cancelled");
  }, []);

  /**
   * Merge hydrated sequence members into the region pool by ID. Seeds are
   * never evicted; non-seed records past the session bound are dropped. The
   * imagery snapshot bumps only when the pool actually grows.
   */
  const mergeHydratedImages = useCallback((records: ImageResult[]): number => {
    const seeds = seedIdsRef.current;
    const known = new Set(imagesRef.current.map((image) => image.id));
    const fresh = records.filter((record) => !known.has(record.id));
    if (fresh.length === 0) return 0;
    const merged = sortSearchResults([...imagesRef.current, ...fresh]);
    let nonSeed = 0;
    const trimmed = merged.filter((image) => {
      if (seeds.has(image.id)) return true;
      nonSeed += 1;
      return nonSeed <= MAX_HYDRATED_POOL;
    });
    setImages(trimmed);
    setImagerySnapshotId((value) => value + 1);
    return fresh.length;
  }, []);

  const selectResult = useCallback((id: string) => {
    // Request a viewer load unless the viewer already shows this image; a
    // repeated click on the failed request retries it. Highlighting derives
    // from actual viewer state, never from this click alone.
    if (viewerActualRef.current.imageId !== id) {
      requestTokenRef.current += 1;
      setRequestedImage({ id, token: requestTokenRef.current });
    }
  }, []);

  const handleActualImage = useCallback(
    (update: { imageId: string | null; sequenceId: string | null }) => {
      setViewerActual((prev) =>
        prev.imageId === update.imageId && prev.sequenceId === update.sequenceId
          ? prev
          : { ...prev, imageId: update.imageId, sequenceId: update.sequenceId },
      );
    },
    [],
  );

  const handleCameraPosition = useCallback((position: ViewerActual["position"]) => {
    setViewerActual((prev) => ({ ...prev, position }));
  }, []);

  // Pending load indication: requested but not yet displayed.
  const pendingId =
    requestedImage && requestedImage.id !== viewerActual.imageId ? requestedImage.id : null;

  const searchAvailable = options.backendConnected && options.searchConfigured === true;
  const findEnabled = (roi?.valid ?? false) && searchAvailable && status !== "loading";

  return {
    mapRef,
    roi,
    drawing,
    draft,
    status,
    images,
    seeds,
    query,
    warnings,
    searchError,
    requestedImage,
    pendingId,
    viewerActual,
    everSearched,
    imagerySnapshotId,
    searchAvailable,
    findEnabled,
    startDrawing,
    cancelDrawing,
    handleMapClick,
    handleMapMouseMove,
    handleMapDoubleClick: finishPolygon,
    finishPolygon,
    useCurrentView,
    clearRegion,
    fitRegion,
    runSearch,
    cancelSearch,
    mergeHydratedImages,
    selectResult,
    handleActualImage,
    handleCameraPosition,
  };
}

export type RoiSearch = ReturnType<typeof useRoiSearch>;
