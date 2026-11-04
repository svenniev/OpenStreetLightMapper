import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { ApiError } from "./lib/api";
import { mediaUrlFor, rasterizeView } from "./lib/detectionClient";
import type { SourceView } from "./features/inventory/inventoryTypes";
import { useSamStatus } from "./features/inventory/useSamStatus";
import { useViewMedia } from "./features/inventory/useViewMedia";
import { useWorkspaceStore } from "./features/workspaces/useWorkspaceStore";
import { WorkspaceContent } from "./features/workspaces/WorkspaceContent";
import { ConflictDialog, SaveBanner, WorkspaceMenu } from "./features/workspaces/WorkspaceShell";
import "./App.css";

export default function App() {
  const health = useBackendHealth();
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
  const store = useWorkspaceStore({ dbState: health.dbState, prepareRaster });
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!store.hasUnsaved) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [store.hasUnsaved]);

  const opened = store.seedState.workspaceId !== null;
  return (
    <div className="app">
      <Header
        health={health}
        menu={<WorkspaceMenu store={store} />}
        save={<SaveBanner store={store} />}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ConflictDialog store={store} />
      {opened ? (
        <WorkspaceContent
          key={store.seedState.seedKey}
          seed={store.seedState}
          store={store}
          health={health}
          viewMedia={viewMedia}
          sam={sam}
          prepareRaster={prepareRaster}
          settingsOpen={settingsOpen}
          onCloseSettings={() => setSettingsOpen(false)}
        />
      ) : store.status.kind === "loading" ? (
        <p className="search-status" role="status">
          Loading workspace…
        </p>
      ) : (
        <div className="workspace-empty" role="status">
          <p className="search-status">
            {health.dbState === "unavailable"
              ? "The local database is unavailable — start it to open or create a workspace."
              : "No workspace is open. Create one or open a saved workspace from the menu above."}
          </p>
          {store.listError && (
            <p className="search-status error-text" role="alert">
              {store.listError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
