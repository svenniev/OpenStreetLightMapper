import { useMemo } from "react";
import { Header } from "./components/Header";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { useRoiSearch } from "./hooks/useRoiSearch";
import { MapToolbar } from "./features/map/MapToolbar";
import { OsmMap } from "./features/map/OsmMap";
import { MapillaryPanel } from "./features/street-imagery/MapillaryPanel";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import "./App.css";

export default function App() {
  const health = useBackendHealth();
  const backendConnected = health.connection === "connected";
  const search = useRoiSearch({ backendConnected, searchConfigured: health.searchConfigured });

  const draftVertexCount = useMemo(
    () =>
      new Set((search.draft?.vertices ?? []).map(([lat, lng]) => `${lat},${lng}`)).size,
    [search.draft],
  );

  return (
    <div className="app">
      <Header health={health} />
      <div className="layout">
        <main className="workspace" aria-label="Geographic workspace">
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
              onClearRegion={search.clearRegion}
            />
            <OsmMap
              mapRef={search.mapRef}
              roi={search.roi}
              drawing={search.drawing}
              draft={search.draft}
              results={search.images}
              selectedId={search.selectedId}
              cameraPosition={search.viewerActual.position}
              viewedImageId={search.viewerActual.imageId}
              onMapClick={search.handleMapClick}
              onMapMouseMove={search.handleMapMouseMove}
              onMapDoubleClick={search.handleMapDoubleClick}
              onCancelDrawing={search.cancelDrawing}
              onSelectResult={search.selectResult}
            />
          </section>
          <section className="panel imagery-panel" aria-labelledby="imagery-panel-title">
            <h2 id="imagery-panel-title" className="panel-title">
              Street imagery
            </h2>
            <MapillaryPanel
              onCameraPosition={search.handleCameraPosition}
              onActualImageId={search.handleActualImageId}
              requestedImage={search.requestedImage}
              isActualOutsideResults={search.isActualOutsideResults}
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
          />
        </aside>
      </div>
    </div>
  );
}
