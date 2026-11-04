import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { latLngBounds } from "leaflet";
import type { BackendHealth } from "../../hooks/useBackendHealth";
import { useRoiSearch } from "../../hooks/useRoiSearch";
import { MapToolbar } from "../map/MapToolbar";
import { OsmMap, type AssetMapMarker, type StreetShape } from "../map/OsmMap";
import { MapillaryPanel } from "../street-imagery/MapillaryPanel";
import {
  RegionSummary,
  SearchControls,
  SearchResults,
} from "../settings/SettingsPanel";
import { SettingsDrawer } from "../settings/SettingsDrawer";
import { SequencePanel } from "../sequences/SequencePanel";
import { useSequences } from "../sequences/useSequences";
import { StreetPanel } from "../streets/StreetPanel";
import { useStreets } from "../streets/useStreets";
import { DEMO_STREET_ID, buildDemoSeed } from "../streets/seedDemo";
import { isInRegion } from "../../lib/search";
import { PreparationPanel } from "../preparation/PreparationPanel";
import { usePreparation } from "../preparation/usePreparation";
import { ResultsModal } from "../results/ResultsModal";
import type { PreviewExpectation } from "../results/resultTypes";
import { isDemoImageId } from "../inventory/demoScenes";
import { resolvePlacement } from "../inventory/inventoryReducer";
import type {
  InventoryObservation,
  SessionPreviewResult,
  SourceView,
} from "../inventory/inventoryTypes";
import { InventoryEntry } from "../inventory/InventoryEntry";
import { InventoryWorkspace } from "../inventory/InventoryWorkspace";
import { useInventorySessions } from "../inventory/useInventorySessions";
import type { SamStatus } from "../inventory/useSamStatus";
import type { ViewMedia } from "../inventory/useViewMedia";
import type { MaskFetcher } from "../inventory/useEvidence";
import type { RasterUpload } from "../../lib/detectionClient";
import type { ImageResult, LatLngPair } from "../../lib/searchTypes";
import { fetchReviewedResult } from "../../lib/workspaceApi";
import {
  buildImagerySnapshotPayload,
  buildStoredRoi,
  newClientId,
  serializeSession,
} from "./serialization";
import type {
  TrackedState,
  WorkspaceSeedState,
  WorkspaceStore,
} from "./useWorkspaceStore";

export interface WorkspaceContentProps {
  seed: WorkspaceSeedState;
  store: WorkspaceStore;
  health: BackendHealth;
  viewMedia: ViewMedia;
  sam: SamStatus;
  prepareRaster: (view: SourceView) => Promise<RasterUpload>;
  /** Settings drawer visibility, owned by the header button in App. */
  settingsOpen: boolean;
  onCloseSettings: () => void;
}

interface SavedResultsViewState {
  sessionKey: string;
  displayName: string;
  preview: SessionPreviewResult;
  expected: PreviewExpectation;
  views: Record<string, SourceView>;
  observations: Record<string, InventoryObservation>;
  /** Null for the unsaved in-memory preview. */
  savedMeta: {
    resultId: string;
    createdAt: string;
    sessionRevision: number;
    history: { resultId: string; sessionRevision: number; createdAt: string }[];
    draftAfterResult: boolean;
  } | null;
}

/**
 * The geographic workspace for one open workspace document (remount per
 * workspace via key). Owns every domain hook, seeded from the restored
 * workspace; reports a serializable snapshot to the store each render.
 */
export function WorkspaceContent(props: WorkspaceContentProps) {
  const { seed, store, health, viewMedia, sam } = props;
  const backendConnected = health.connection === "connected";
  const search = useRoiSearch({
    backendConnected,
    searchConfigured: health.searchConfigured,
    initial: seed.seed.imagery,
  });
  const sequences = useSequences({
    roi: search.roi,
    seeds: search.seeds,
    pool: search.images,
    mergeHydratedImages: search.mergeHydratedImages,
    requestViewerImage: search.selectResult,
    viewerActual: search.viewerActual,
    initial: seed.seed.sequences,
  });
  const streets = useStreets({ roi: search.roi, backendConnected, initial: seed.seed.streets });
  const preparation = usePreparation({
    roi: search.roi,
    streetsStatus: streets.status,
    streets: streets.streets,
    streetSnapshotId: streets.snapshotId,
    streetWarnings: streets.warnings,
    streetRetrievedAt: streets.query?.retrievedAt ?? null,
    checkedIds: streets.checkedIds,
    selectionVersion: streets.selectionVersion,
    discoveryStatus: search.status,
    discoveryWarnings: search.warnings,
    images: search.images,
    imagerySnapshotId: search.imagerySnapshotId,
    sequenceRefs: sequences.sequenceRefs,
    detailLoading: sequences.detailLoading,
    drawingActive: search.drawing !== null,
    streetSeeded: streets.seeded,
    initial: seed.seed.preparation,
  });

  const liveContext = useMemo(
    () =>
      search.roi && preparation.plan && preparation.liveFingerprint
        ? {
            roiRevision: search.roi.id,
            runId: preparation.plan.runId,
            fingerprint: preparation.liveFingerprint,
          }
        : null,
    [search.roi, preparation.plan, preparation.liveFingerprint],
  );
  const inventory = useInventorySessions({
    liveContext,
    roiRing: search.roi?.polygon.coordinates[0] ?? null,
    prepareRaster: props.prepareRaster,
    persistence: store.persistence,
    initialSessions: seed.sessions,
  });
  const [mapView, setMapView] = useState<{ center: [number, number]; zoom: number } | null>(
    seed.seed.mapView,
  );
  const [resultsView, setResultsView] = useState<SavedResultsViewState | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [resultSave, setResultSave] = useState<{ saving: boolean; error: string | null }>({
    saving: false,
    error: null,
  });
  const pendingResultIdRef = useRef<string | null>(null);

  // In-region Mapillary pool for manual image references.
  const poolImages = useMemo(() => search.images.filter(isInRegion), [search.images]);

  const sequenceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const image of poolImages) {
      if (image.sequenceId) counts.set(image.sequenceId, (counts.get(image.sequenceId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([sequenceId, count]) => ({ sequenceId, count }));
  }, [poolImages]);

  const streetOptions = useMemo(
    () =>
      streets.streets
        .filter((street) => streets.checkedIds.has(street.id))
        .map((street) => ({
          id: street.id,
          displayName: street.displayName,
          streetSource: (street.id === DEMO_STREET_ID ? "manual-work-area" : "osm") as
            | "manual-work-area"
            | "osm",
        })),
    [streets.streets, streets.checkedIds],
  );

  const inventoryDisabledReason = !search.roi?.valid
    ? "Commit a valid region first."
    : preparation.runState !== "prepared"
      ? "Prepare the region first (Prepare selected streets)."
      : streetOptions.length === 0
        ? "Include at least one street."
        : !liveContext
          ? "Preparation context unavailable."
          : null;

  // Streets whose saved Results open only after the server acknowledged them.
  const resultsAvailable = useMemo(
    () =>
      new Set(
        Object.values(inventory.sessions)
          .filter(
            (session) =>
              session.mode === "manual" &&
              session.savedResultRefs.length > 0 &&
              !inventory.isStale(session),
          )
          .map((session) => session.context.streetId),
      ),
    [inventory.sessions, inventory.isStale],
  );

  const maskFetcher: MaskFetcher | null = useMemo(() => {
    const sessionKey = inventory.activeKey;
    if (!seed.workspaceId || !sessionKey) return null;
    return {
      fetchFullItem: (runId: string, itemId: string) =>
        store.persistence.fetchFullItem(sessionKey, runId, itemId),
    };
  }, [seed.workspaceId, store.persistence, inventory.activeKey]);

  const openSavedResult = useCallback(
    async (sessionKey: string, resultId: string | null, historyOverride?: { resultId: string; sessionRevision: number; createdAt: string }[]) => {
      const session = inventory.sessions[sessionKey];
      const workspaceId = seed.workspaceId;
      if (!session || session.mode !== "manual" || !workspaceId) return;
      setResultsLoading(true);
      try {
        const history = historyOverride ?? (await store.listSessionResults(sessionKey));
        if (history.length === 0) {
          store.setNotice("No saved results for this street yet.");
          return;
        }
        const target = resultId ? history.find((entry) => entry.resultId === resultId) : history[0];
        if (!target) {
          store.setNotice("That saved version is no longer listed.");
          return;
        }
        const stored = await fetchReviewedResult(workspaceId, sessionKey, target.resultId);
        const preview = (stored.snapshot as { preview?: SessionPreviewResult }).preview;
        if (!preview || preview.kind !== "session-preview") {
          store.setNotice("That saved version is malformed and cannot open.");
          return;
        }
        const snapshot = stored.snapshot as {
          observations?: Record<string, InventoryObservation>;
          views?: Record<string, SourceView>;
        };
        setResultsView({
          sessionKey,
          displayName: session.context.streetDisplayName,
          preview,
          expected: {
            streetId: session.context.streetId,
            sessionId: session.sessionId,
            roiRevision: session.context.roiRevision,
            runId: session.context.runId,
            fingerprint: session.context.fingerprint,
          },
          views: snapshot.views ?? {},
          observations: snapshot.observations ?? {},
          savedMeta: {
            resultId: stored.resultId,
            createdAt: stored.createdAt,
            sessionRevision: stored.sessionRevision,
            history,
            draftAfterResult: session.draftAfterResult,
          },
        });
      } catch (error) {
        store.setNotice(error instanceof Error ? error.message : "Opening the saved result failed.");
      } finally {
        setResultsLoading(false);
      }
    },
    [inventory.sessions, seed.workspaceId, store],
  );

  const openPreviewResults = useCallback(() => {
    const session = inventory.activeSession;
    const key = inventory.activeKey;
    if (!session || !key || !session.finishedPreview) return;
    setResultsView({
      sessionKey: key,
      displayName: session.context.streetDisplayName,
      preview: session.finishedPreview,
      expected: {
        streetId: session.context.streetId,
        sessionId: session.sessionId,
        roiRevision: session.context.roiRevision,
        runId: session.context.runId,
        fingerprint: session.context.fingerprint,
      },
      views: session.views,
      observations: session.observations,
      savedMeta: null,
    });
  }, [inventory.activeKey, inventory.activeSession]);

  const openStreetResults = useCallback(
    (streetId: string) => {
      const session = Object.values(inventory.sessions).find(
        (entry) => entry.context.streetId === streetId,
      );
      if (session) void openSavedResult(session.key, null);
    },
    [inventory.sessions, openSavedResult],
  );

  const handleSaveResult = useCallback(async () => {
    const session = inventory.activeSession;
    const key = inventory.activeKey;
    if (!session || !key || session.mode !== "manual" || !session.finishedPreview) return;
    if (!pendingResultIdRef.current) pendingResultIdRef.current = newClientId("rs");
    setResultSave({ saving: true, error: null });
    const outcome = await store.saveReviewedResultVersion(key, pendingResultIdRef.current);
    if ("error" in outcome) {
      setResultSave({ saving: false, error: outcome.error });
    } else {
      pendingResultIdRef.current = null;
      setResultSave({ saving: false, error: null });
    }
  }, [inventory.activeKey, inventory.activeSession, store]);

  // Placed assets of the active manual session, for map markers.
  const activeInventory = inventory.isOpen ? inventory.activeSession : null;
  const inventoryAssets = useMemo<AssetMapMarker[]>(() => {
    if (!activeInventory || activeInventory.mode !== "manual") return [];
    const markers: AssetMapMarker[] = [];
    for (const asset of Object.values(activeInventory.assets)) {
      const resolved = resolvePlacement(asset, activeInventory.assets);
      if (resolved.kind === "geographic") {
        markers.push({
          id: asset.id,
          category: asset.category,
          position: [resolved.lat, resolved.lng],
        });
      }
    }
    return markers;
  }, [activeInventory]);

  const placementActive =
    inventory.placement?.mode === "manual" &&
    inventory.placement.sessionKey === inventory.activeKey &&
    search.drawing === null;

  const handleClearRegion = useCallback(() => {
    if (inventory.hasDirty) {
      setConfirmingClear(true);
      return;
    }
    search.clearRegion();
  }, [inventory.hasDirty, search]);

  useEffect(() => {
    if (!store.hasUnsaved && !inventory.hasDirty && inventory.busyKeys.length === 0) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [store.hasUnsaved, inventory.hasDirty, inventory.busyKeys.length]);

  // Demo-seed preview from in-region sequenced positions (Overpass workaround).
  const seedPreview = useMemo(
    () =>
      buildDemoSeed(
        search.images
          .filter(isInRegion)
          .filter(
            (image): image is ImageResult & { sequenceId: string } =>
              image.sequenceId !== null,
          )
          .map((image) => ({
            id: image.id,
            lng: image.coordinate[0],
            lat: image.coordinate[1],
            sequenceId: image.sequenceId,
            capturedAt: image.capturedAt,
          })),
        search.roi?.bbox ?? [0, 0, 0, 0],
      ),
    [search.images, search.roi],
  );

  const draftVertexCount = useMemo(
    () =>
      new Set((search.draft?.vertices ?? []).map(([lat, lng]) => `${lat},${lng}`)).size,
    [search.draft],
  );

  // Outside the current working selection: the selected sequence (or single
  // ungrouped image) when one is selected, else the discovery pool.
  const actualId = search.viewerActual.imageId;
  const isActualOutsideWorkingSelection = useMemo(() => {
    if (actualId === null) return false;
    if (sequences.selectedSequenceId || sequences.selectedUngroupedId) {
      return !sequences.selectedMembers.some((member) => member.id === actualId);
    }
    if (!search.everSearched) return false;
    return !search.images.some((image) => image.id === actualId);
  }, [
    actualId,
    sequences.selectedSequenceId,
    sequences.selectedUngroupedId,
    sequences.selectedMembers,
    search.everSearched,
    search.images,
  ]);

  const fitSequence = useCallback(() => {
    const map = search.mapRef.current;
    const members = [...sequences.points.inside, ...sequences.points.outside];
    if (!map || members.length === 0) return;
    map.fitBounds(
      latLngBounds(
        members.map((member) => [member.coordinate[1], member.coordinate[0]] as LatLngPair),
      ).pad(0.1),
    );
  }, [search.mapRef, sequences.points]);

  const canFitSequence =
    sequences.points.inside.length + sequences.points.outside.length > 0;

  // Clipped street geometry for the map (GeoJSON lng/lat → Leaflet lat/lng),
  // with malformed points dropped so bad server data cannot crash Leaflet.
  const streetShapes = useMemo<StreetShape[]>(
    () =>
      streets.streets.map((street) => ({
        id: street.id,
        displayName: street.displayName,
        lines: street.geometry.coordinates
          .map((line) =>
            line
              .filter(
                (point): point is [number, number] =>
                  Array.isArray(point) &&
                  point.length >= 2 &&
                  Number.isFinite(point[0]) &&
                  Number.isFinite(point[1]),
              )
              .map(([lng, lat]) => [lat, lng] as LatLngPair),
          )
          .filter((line) => line.length > 0),
        checked: streets.checkedIds.has(street.id),
        focused: streets.focusedId === street.id,
      })),
    [streets.streets, streets.checkedIds, streets.focusedId],
  );

  // ---- Persistence tracking (serializable snapshot per record, memoized) ----

  const imageryTracked = useMemo(() => {
    if ((!search.everSearched && search.images.length === 0) || !search.query) return null;
    const payload = buildImagerySnapshotPayload({
      query: search.query,
      warnings: search.warnings,
      status: search.status,
      everSearched: search.everSearched,
      seeds: search.seeds,
      pool: search.images,
    });
    return { json: JSON.stringify(payload), payload };
  }, [search.everSearched, search.images, search.query, search.seeds, search.status, search.warnings]);

  const streetTracked = useMemo(() => {
    if (streets.streets.length === 0) return null;
    const payload = {
      streets: streets.streets,
      query: streets.query,
      warnings: streets.warnings,
      seeded: streets.seeded,
      retrievedAt: streets.query?.retrievedAt ?? null,
    };
    return { json: JSON.stringify(payload), payload };
  }, [streets.streets, streets.query, streets.warnings, streets.seeded]);

  const imagerySelection = useMemo(
    () => ({
      status: search.status,
      everSearched: search.everSearched,
      imagerySnapshotId: search.imagerySnapshotId,
      warnings: search.warnings,
      searchError: search.searchError,
      selectedSequenceId: sequences.selectedSequenceId,
      selectedUngroupedId: sequences.selectedUngroupedId,
      scope: sequences.scope,
      filter: sequences.filter,
      loads: sequences.loads,
      requestedImageId: search.requestedImage?.id ?? null,
      viewerImageId: search.viewerActual.imageId,
      truncatedCount: imageryTracked?.payload.truncatedCount ?? 0,
    }),
    [
      search.status,
      search.everSearched,
      search.imagerySnapshotId,
      search.warnings,
      search.searchError,
      sequences.selectedSequenceId,
      sequences.selectedUngroupedId,
      sequences.scope,
      sequences.filter,
      sequences.loads,
      search.requestedImage?.id,
      search.viewerActual.imageId,
      imageryTracked,
    ],
  );

  const streetSelection = useMemo(
    () => ({
      status: streets.status,
      checkedIds: [...streets.checkedIds],
      focusedId: streets.focusedId,
      seeded: streets.seeded,
      snapshotId: streets.snapshotId,
      warnings: streets.warnings,
      error: streets.error,
    }),
    [
      streets.status,
      streets.checkedIds,
      streets.focusedId,
      streets.seeded,
      streets.snapshotId,
      streets.warnings,
      streets.error,
    ],
  );

  const preparationTracked = useMemo(
    () => ({
      runState: preparation.runState,
      plan: preparation.plan,
      failedStreetIds: preparation.failedStreetIds,
      failureReasons: preparation.failureReasons,
    }),
    [preparation.runState, preparation.plan, preparation.failedStreetIds, preparation.failureReasons],
  );

  const sessionsTracked = useMemo(() => {
    const entries: Record<string, { json: string; body: Record<string, unknown> }> = {};
    for (const [key, session] of Object.entries(inventory.sessions)) {
      if (session.mode !== "manual") continue;
      const body = serializeSession(session);
      entries[key] = { json: JSON.stringify(body), body };
    }
    return entries;
  }, [inventory.sessions]);

  const roiTracked = useMemo(
    () =>
      search.roi
        ? buildStoredRoi(search.roi, {
            center: mapView ? { lng: mapView.center[1], lat: mapView.center[0] } : null,
            zoom: mapView?.zoom ?? null,
          })
        : null,
    [search.roi, mapView],
  );

  const tracked: TrackedState = useMemo(
    () => ({
      name: store.name,
      roi: roiTracked,
      imagery: imageryTracked,
      imagerySelection: imagerySelection as unknown as Record<string, unknown>,
      imagerySelectionJson: JSON.stringify(imagerySelection),
      street: streetTracked,
      streetSelection: streetSelection as unknown as Record<string, unknown>,
      streetSelectionJson: JSON.stringify(streetSelection),
      preparation: preparationTracked as unknown as Record<string, unknown>,
      preparationJson: JSON.stringify(preparationTracked),
      sessions: sessionsTracked,
      activeSessionKey: inventory.activeKey,
    }),
    [
      store.name,
      roiTracked,
      imageryTracked,
      imagerySelection,
      streetTracked,
      streetSelection,
      preparationTracked,
      sessionsTracked,
      inventory.activeKey,
    ],
  );

  useEffect(() => {
    store.track(tracked);
  });

  useEffect(() => {
    store.registerContent({ dispatchTo: inventory.dispatchTo });
  }, [store, inventory.dispatchTo]);

  // Restore once per mount: activate the saved session, then recover
  // detection state without new model calls. Idempotent by design.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const activeKey = seed.seed.activeSessionKey;
    if (activeKey && seed.sessions[activeKey]) {
      inventory.switchSession(activeKey);
    }
    if (!seed.recovered) return;
    let cancelled = false;
    void (async () => {
      let recovered = 0;
      let interrupted = 0;
      let clearedStaged = false;
      for (const key of Object.keys(seed.sessions)) {
        const report = await inventory.recoverSession(key);
        recovered += report.recovered;
        interrupted += report.interrupted;
        clearedStaged = clearedStaged || report.clearedStaged;
      }
      if (cancelled) return;
      const parts: string[] = [];
      if (recovered > 0) parts.push(`${recovered} saved result${recovered === 1 ? "" : "s"} recovered without new model calls`);
      if (interrupted > 0) parts.push(`${interrupted} stranded item${interrupted === 1 ? " was" : "s were"} marked interrupted — not automatically retried`);
      if (clearedStaged) parts.push("an unrecoverable staged test was cleared");
      if (parts.length > 0) setRecoveryNotice(`Recovery: ${parts.join("; ")}.`);
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: seed and inventory are fixed for this mount.
  }, []);

  const scrollToInventory = useCallback(() => {
    document.getElementById("inventory-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const scrollToMap = useCallback(() => {
    document.getElementById("map-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <main className="main-column">
      {confirmingClear && (
        <div className="clear-confirm" role="alert">
          Discard {inventory.dirtyKeys.size} edited inventory preview
          {inventory.dirtyKeys.size === 1 ? "" : "s"} and clear the region?{" "}
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => {
              setConfirmingClear(false);
              inventory.discardAll();
              search.clearRegion();
            }}
          >
            Discard all and clear
          </button>{" "}
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => setConfirmingClear(false)}
          >
            Keep workspace
          </button>
        </div>
      )}
      {store.notice && (
        <div className="clear-confirm" role="status">
          {store.notice}{" "}
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => store.setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {recoveryNotice && (
        <div className="clear-confirm" role="status">
          {recoveryNotice}{" "}
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => setRecoveryNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="workspace" aria-label="Geographic workspace">
        <div className="map-column">
          <section id="map-panel" className="panel map-panel" aria-labelledby="map-panel-title">
            <h2 id="map-panel-title" className="panel-title">
              Map
            </h2>
            <RegionSummary search={search} />
            <MapToolbar
              drawing={search.drawing}
              draftVertexCount={draftVertexCount}
              hasRegion={search.roi !== null}
              onStartRectangle={() => search.startDrawing("rectangle")}
              onStartPolygon={() => search.startDrawing("polygon")}
              onUseCurrentView={search.useCurrentView}
              onFinishPolygon={search.finishPolygon}
              onCancelDrawing={search.cancelDrawing}
              onClearRegion={handleClearRegion}
            />
            <OsmMap
              mapRef={search.mapRef}
              roi={search.roi}
              drawing={search.drawing}
              draft={search.draft}
              sequencePoints={sequences.points}
              streets={streetShapes}
              viewedId={search.viewerActual.imageId}
              pendingId={search.pendingId}
              cameraPosition={search.viewerActual.position}
              viewedImageId={search.viewerActual.imageId}
              onMapClick={search.handleMapClick}
              onMapMouseMove={search.handleMapMouseMove}
              onMapDoubleClick={search.handleMapDoubleClick}
              onCancelDrawing={search.cancelDrawing}
              onSelectResult={search.selectResult}
              placementArmed={placementActive}
              placementDraft={placementActive ? (inventory.placement?.geo ?? null) : null}
              inventoryAssets={inventoryAssets}
              selectedAssetId={
                inventory.highlight?.sessionKey === inventory.activeKey
                  ? (inventory.highlight.assetId ?? null)
                  : null
              }
              onPlacementClick={(pair) => inventory.setPlacementDraft({ geo: pair })}
              onAssetMarkerClick={(id) => {
                if (inventory.activeKey) {
                  inventory.setHighlight({ sessionKey: inventory.activeKey, assetId: id });
                }
              }}
              initialView={seed.seed.mapView}
              onViewChange={(center, zoom) => setMapView({ center, zoom })}
            />
          </section>
        </div>
        <section className="panel imagery-panel" aria-labelledby="imagery-panel-title">
          <h2 id="imagery-panel-title" className="panel-title">
            Street imagery
          </h2>
          <MapillaryPanel
            onCameraPosition={search.handleCameraPosition}
            onActualImage={search.handleActualImage}
            requestedImage={search.requestedImage}
            isActualOutsideResults={isActualOutsideWorkingSelection}
          />
        </section>
      </div>
      <section className="panel sequences-panel sequences-panel--compact" aria-labelledby="sequences-panel-title">
        <h2 id="sequences-panel-title" className="panel-title">
          Mapillary sequences
        </h2>
        <SearchControls
          search={search}
          backendConnected={backendConnected}
          searchConfigured={health.searchConfigured}
        />
        <SearchResults search={search} />
        <SequencePanel
          groups={sequences.groups}
          filter={sequences.filter}
          onFilter={sequences.setFilter}
          scope={sequences.scope}
          onScope={sequences.setScope}
          selectedSequenceId={sequences.selectedSequenceId}
          selectedUngroupedId={sequences.selectedUngroupedId}
          selectedLoad={sequences.selectedLoad}
          scopedMembers={sequences.scopedMembers}
          unresolvedIds={sequences.unresolvedIds}
          imageListOpen={sequences.imageListOpen}
          onToggleImageList={() => sequences.setImageListOpen(!sequences.imageListOpen)}
          imagePage={sequences.imagePage}
          onImagePage={sequences.setImagePage}
          viewedId={search.viewerActual.imageId}
          pendingId={search.pendingId}
          foreignSequence={sequences.foreignSequence}
          hasDiscovery={search.everSearched}
          onSelectSequence={sequences.selectSequence}
          onSelectUngrouped={sequences.selectUngrouped}
          onSelectImage={search.selectResult}
          onRetryDetail={sequences.retryDetail}
          onFitSequence={fitSequence}
          canFitSequence={canFitSequence}
        />
      </section>
      <section className="panel streets-panel" aria-labelledby="streets-panel-title">
        <h2 id="streets-panel-title" className="panel-title">
          Streets in region
        </h2>
        <StreetPanel
          status={streets.status}
          streets={streets.streets}
          checkedIds={streets.checkedIds}
          checkedCount={streets.checkedCount}
          focusedId={streets.focusedId}
          warnings={streets.warnings}
          error={streets.error}
          retrievedAt={streets.query?.retrievedAt ?? null}
          hasRegion={search.roi !== null}
          workflowStatuses={preparation.workflowStatuses}
          resultsAvailable={resultsAvailable}
          seeded={streets.seeded}
          seedPreview={seedPreview}
          onToggleChecked={streets.setChecked}
          onSelectAll={streets.selectAll}
          onDeselectAll={streets.deselectAll}
          onToggleFocus={streets.toggleFocus}
          onRetry={streets.retry}
          onSeed={() => {
            if (seedPreview) streets.seedDemo(seedPreview);
          }}
          onOpenResults={openStreetResults}
        />
        <div className="streets-actions">
          <PreparationPanel preparation={preparation} streetTotal={streets.streets.length} />
          <InventoryEntry
            inventory={inventory}
            streetOptions={streetOptions}
            canOpen={inventoryDisabledReason === null}
            disabledReason={inventoryDisabledReason}
          />
        </div>
      </section>
      {inventory.isOpen && inventory.activeSession && (
        <section id="inventory-panel" className="panel inventory-panel" aria-label="Inventory workflow">
          <InventoryWorkspace
            sessions={inventory}
            poolImages={poolImages}
            onSelectImage={(id) => {
              if (!isDemoImageId(id)) search.selectResult(id);
            }}
            onOpenResults={openPreviewResults}
            sequenceOptions={sequenceOptions}
            currentSequenceId={sequences.selectedSequenceId}
            currentImageId={search.viewerActual.imageId}
            viewMedia={viewMedia}
            sam={sam}
            maskFetcher={maskFetcher}
            resultSave={
              seed.workspaceId
                ? { onSave: () => void handleSaveResult(), saving: resultSave.saving, error: resultSave.error }
                : null
            }
            onReturnToInventory={scrollToInventory}
            onGoToMap={scrollToMap}
          />
        </section>
      )}
      {resultsView && (
        <ResultsModal
          streetDisplayName={resultsView.displayName}
          expected={{
            streetId: resultsView.expected.streetId,
            roiRevision: resultsView.expected.roiRevision ?? -1,
            runId: resultsView.expected.runId ?? "",
          }}
          payload={resultsView.preview}
          previewExpected={resultsView.expected}
          evidence={{
            observations:
              inventory.sessions[resultsView.sessionKey]?.observations ??
              resultsView.observations,
            views:
              inventory.sessions[resultsView.sessionKey]?.views ?? resultsView.views,
            viewMedia,
          }}
          savedMeta={
            resultsView.savedMeta
              ? {
                  resultId: resultsView.savedMeta.resultId,
                  createdAt: resultsView.savedMeta.createdAt,
                  history: resultsView.savedMeta.history,
                  draftAfterResult: resultsView.savedMeta.draftAfterResult,
                  onSelectVersion: (resultId) =>
                    void openSavedResult(
                      resultsView.sessionKey,
                      resultId,
                      resultsView.savedMeta?.history,
                    ),
                }
              : null
          }
          occurrenceEditing={
            resultsView.savedMeta
              ? null
              : {
                  updateNote: (obsId, note) =>
                    inventory.dispatchTo(resultsView.sessionKey, {
                      type: "OBS_EDIT",
                      id: obsId,
                      note,
                    }),
                  unconfirmAsset: (assetId) => {
                    const live = inventory.sessions[resultsView.sessionKey];
                    const asset = live?.assets[assetId];
                    for (const obsId of asset?.observationIds ?? []) {
                      inventory.dispatchTo(resultsView.sessionKey, {
                        type: "OBS_DECIDE",
                        id: obsId,
                        decision: "pending",
                      });
                    }
                    setResultsView(null);
                  },
                }
          }
          onReturnToReview={() => {
            const sessionKey = resultsView.sessionKey;
            setResultsView(null);
            inventory.switchSession(sessionKey, "inventory");
          }}
          onClose={() => setResultsView(null)}
        />
      )}
      {resultsLoading && (
        <p className="search-status" role="status">
          Loading saved result…
        </p>
      )}
      {props.settingsOpen && (
        <SettingsDrawer
          health={health}
          search={search}
          sam={sam}
          store={store}
          onManualImageId={(id) => search.selectResult(id)}
          onClose={props.onCloseSettings}
        />
      )}
    </main>
  );
}
