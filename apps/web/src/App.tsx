import { useCallback, useEffect, useMemo, useState } from "react";
import { latLngBounds } from "leaflet";
import { Header } from "./components/Header";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { useRoiSearch } from "./hooks/useRoiSearch";
import { MapToolbar } from "./features/map/MapToolbar";
import { OsmMap, type AssetMapMarker, type StreetShape } from "./features/map/OsmMap";
import { MapillaryPanel } from "./features/street-imagery/MapillaryPanel";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { SequencePanel } from "./features/sequences/SequencePanel";
import { useSequences } from "./features/sequences/useSequences";
import { StreetPanel } from "./features/streets/StreetPanel";
import { useStreets } from "./features/streets/useStreets";
import { buildDemoSeed } from "./features/streets/seedDemo";
import { isInRegion } from "./lib/search";
import { usePreparation } from "./features/preparation/usePreparation";
import { ResultsModal } from "./features/results/ResultsModal";
import type { PreviewExpectation } from "./features/results/resultTypes";
import { isDemoImageId } from "./features/inventory/demoScenes";
import { ApiError } from "./lib/api";
import { mediaUrlFor, rasterizeView } from "./lib/detectionClient";
import { resolvePlacement } from "./features/inventory/inventoryReducer";
import type {
  InventoryObservation,
  SessionPreviewResult,
  SourceView,
} from "./features/inventory/inventoryTypes";
import { InventoryWorkspace } from "./features/inventory/InventoryWorkspace";
import { useInventorySessions } from "./features/inventory/useInventorySessions";
import { useSamStatus } from "./features/inventory/useSamStatus";
import { useViewMedia } from "./features/inventory/useViewMedia";
import { DEMO_STREET_ID } from "./features/streets/seedDemo";
import type { ImageResult, LatLngPair } from "./lib/searchTypes";
import "./App.css";

interface ResultsPreviewState {
  preview: SessionPreviewResult;
  expected: PreviewExpectation;
  displayName: string;
  sessionKey: string;
  views: Record<string, SourceView>;
  viewOrder: string[];
  observations: Record<string, InventoryObservation>;
}

export default function App() {
  const health = useBackendHealth();
  const backendConnected = health.connection === "connected";
  const search = useRoiSearch({ backendConnected, searchConfigured: health.searchConfigured });
  const sequences = useSequences({
    roi: search.roi,
    seeds: search.seeds,
    pool: search.images,
    mergeHydratedImages: search.mergeHydratedImages,
    requestViewerImage: search.selectResult,
    viewerActual: search.viewerActual,
  });
  const streets = useStreets({ roi: search.roi, backendConnected });
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
  const viewMedia = useViewMedia();
  const sam = useSamStatus({
    configured: health.samConfigured,
    model: health.samModel,
    viewMedia,
  });
  const prepareRaster = useCallback(
    async (view: SourceView) => {
      const detail = await viewMedia.ensureImage(view.imageId);
      try {
        return await rasterizeView(view, mediaUrlFor(detail.media.handle));
      } catch (error) {
        if (error instanceof ApiError && error.code === "MEDIA_HANDLE_EXPIRED") {
          const fresh = await viewMedia.refreshImage(view.imageId);
          return rasterizeView(view, mediaUrlFor(fresh.media.handle));
        }
        throw error;
      }
    },
    [viewMedia],
  );
  const inventory = useInventorySessions({
    liveContext,
    roiRing: search.roi?.polygon.coordinates[0] ?? null,
    prepareRaster,
  });
  const [resultsPreview, setResultsPreview] = useState<ResultsPreviewState | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

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
      ? "Prepare the region first (Start Processing)."
      : streetOptions.length === 0
        ? "Include at least one street."
        : !liveContext
          ? "Preparation context unavailable."
          : null;

  // Streets with a current finished preview enable their Results buttons.
  const resultsAvailable = new Set(
    Object.values(inventory.sessions)
      .filter(
        (session) =>
          session.mode === "manual" && session.finishedPreview && !inventory.isStale(session),
      )
      .map((session) => session.context.streetId),
  );

  const openSessionResults = useCallback(
    (sessionKey: string) => {
      const session = inventory.sessions[sessionKey];
      if (!session?.finishedPreview || inventory.isStale(session)) return;
      setResultsPreview({
        preview: session.finishedPreview,
        expected: {
          streetId: session.context.streetId,
          sessionId: session.sessionId,
          roiRevision: session.context.roiRevision,
          runId: session.context.runId,
          fingerprint: session.context.fingerprint,
        },
        displayName: session.context.streetDisplayName,
        sessionKey,
        views: session.views,
        viewOrder: session.viewOrder,
        observations: session.observations,
      });
    },
    [inventory.sessions, inventory.isStale],
  );

  const openStreetResults = useCallback(
    (streetId: string) => {
      const session = Object.values(inventory.sessions).find(
        (entry) => entry.context.streetId === streetId,
      );
      if (session) openSessionResults(session.key);
    },
    [inventory.sessions, openSessionResults],
  );

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
    if (!inventory.hasDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [inventory.hasDirty]);

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

  return (
    <div className="app">
      <Header health={health} />
      <div className="layout">
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
          <div className="workspace" aria-label="Geographic workspace">
            <div className="map-column">
              <section className="panel map-panel" aria-labelledby="map-panel-title">
                <h2 id="map-panel-title" className="panel-title">
                  Map
                </h2>
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
                />
              </section>
              <section className="panel sequences-panel" aria-labelledby="sequences-panel-title">
                <h2 id="sequences-panel-title" className="panel-title">
                  Mapillary sequences
                </h2>
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
          {inventory.isOpen && inventory.activeSession && (
            <section className="panel inventory-panel" aria-label="Inventory workflow">
              <InventoryWorkspace
                sessions={inventory}
                poolImages={poolImages}
                onSelectImage={(id) => {
                  if (!isDemoImageId(id)) search.selectResult(id);
                }}
                onOpenResults={() => {
                  if (inventory.activeKey) openSessionResults(inventory.activeKey);
                }}
                sequenceOptions={sequenceOptions}
                currentSequenceId={sequences.selectedSequenceId}
                currentImageId={search.viewerActual.imageId}
                viewMedia={viewMedia}
                sam={sam}
              />
            </section>
          )}
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
              previewResults={resultsAvailable}
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
          </section>
        </main>
        <aside className="settings-sidebar" aria-labelledby="settings-title">
          <h2 id="settings-title" className="panel-title">
            Settings
          </h2>
          <SettingsPanel
            search={search}
            backendConnected={backendConnected}
            searchConfigured={health.searchConfigured}
            streetTotal={streets.streets.length}
            preparation={preparation}
            inventory={inventory}
            streetOptions={streetOptions}
            canOpenInventory={inventoryDisabledReason === null}
            inventoryDisabledReason={inventoryDisabledReason}
            sam={sam}
          />
        </aside>
      </div>
      {resultsPreview && (
        <ResultsModal
          streetDisplayName={resultsPreview.displayName}
          expected={{
            streetId: resultsPreview.expected.streetId,
            roiRevision: resultsPreview.expected.roiRevision ?? -1,
            runId: resultsPreview.expected.runId ?? "",
          }}
          payload={resultsPreview.preview}
          previewExpected={resultsPreview.expected}
          evidence={{
            observations: resultsPreview.observations,
            views: resultsPreview.views,
            viewMedia,
          }}
          onReturnToReview={() => {
            const sessionKey = resultsPreview.sessionKey;
            setResultsPreview(null);
            inventory.switchSession(sessionKey, "inventory");
          }}
          onClose={() => setResultsPreview(null)}
        />
      )}
    </div>
  );
}
