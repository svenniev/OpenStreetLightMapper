import { useEffect, useRef, useState } from "react";
import type { BackendHealth } from "../../hooks/useBackendHealth";
import type { RoiSearch } from "../../hooks/useRoiSearch";
import { MAPILLARY_CLIENT_TOKEN, OSM_TILE_URL_IS_DEFAULT } from "../../lib/config";
import type { SamStatus } from "../inventory/useSamStatus";
import type { WorkspaceStore } from "../workspaces/useWorkspaceStore";
import { SamSection } from "./SettingsPanel";

export interface SettingsDrawerProps {
  health: BackendHealth;
  search: RoiSearch;
  sam: SamStatus;
  store: WorkspaceStore;
  /** Developer manual load: drives the viewer like a list selection. */
  onManualImageId: (id: string) => void;
  onClose: () => void;
}

type SettingsTab = "providers" | "database" | "developer";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "database", label: "Local database" },
  { id: "developer", label: "Developer tools" },
];

const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function ProvidersTab(props: { health: BackendHealth; search: RoiSearch; sam: SamStatus }) {
  const { health } = props;
  const searchStatusLabel =
    health.connection !== "connected"
      ? "Unknown (backend unavailable)"
      : health.searchConfigured === true
        ? "Configured"
        : health.searchConfigured === false
          ? "Not configured"
          : "Checking…";
  return (
    <div className="settings-tab">
      <dl className="config-status">
        <div className="config-row">
          <dt>Mapillary viewer</dt>
          <dd>{MAPILLARY_CLIENT_TOKEN ? "Configured" : "Not configured"}</dd>
        </div>
        <div className="config-row">
          <dt>Mapillary search</dt>
          <dd>{searchStatusLabel}</dd>
        </div>
        <div className="config-row">
          <dt>Basemap</dt>
          <dd>{OSM_TILE_URL_IS_DEFAULT ? "OpenStreetMap default tiles" : "Custom tile URL"}</dd>
        </div>
      </dl>
      <h3 className="settings-heading">SAM detection</h3>
      <SamSection search={props.search} sam={props.sam} />
    </div>
  );
}

const SAVE_STATE_LABELS: Record<string, string> = {
  "no-workspace": "no workspace",
  loading: "loading",
  clean: "saved",
  dirty: "unsaved changes",
  saving: "saving",
  failed: "failed",
  conflict: "conflict",
};

function DatabaseTab(props: { health: BackendHealth; store: WorkspaceStore }) {
  const { health, store } = props;
  const dbLabel =
    health.dbState === "connected"
      ? "Connected — workspaces save locally"
      : health.dbState === "connecting"
        ? "Connecting…"
        : health.dbState === "unavailable"
          ? "Unavailable — work is not saved"
          : "Checking…";
  return (
    <div className="settings-tab">
      <dl className="config-status">
        <div className="config-row">
          <dt>Local database</dt>
          <dd>{dbLabel}</dd>
        </div>
        <div className="config-row">
          <dt>Open workspace</dt>
          <dd>{store.seedState.workspaceId ? store.name : "none"}</dd>
        </div>
        <div className="config-row">
          <dt>Save state</dt>
          <dd>{SAVE_STATE_LABELS[store.status.kind] ?? store.status.kind}</dd>
        </div>
      </dl>
      <h3 className="settings-heading">Troubleshooting</h3>
      <ul className="sam-steps">
        <li>Start the database before the server: run the start script in infra/database.</li>
        <li>
          The database listens on loopback only (127.0.0.1:27018) — a local-development
          configuration, not remotely deployable.
        </li>
        <li>If saving fails, use Retry save; unsaved edits stay in memory until saved.</li>
      </ul>
      <p className="search-hint">
        Connection details live in server configuration and are never shown here.
      </p>
    </div>
  );
}

function DeveloperTab(props: { onManualImageId: (id: string) => void }) {
  const [imageId, setImageId] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="settings-tab">
      <h3 className="settings-heading">Manual image load</h3>
      <p className="search-hint">
        Load any Mapillary image into the viewer for testing, exactly like selecting it from a
        list.
      </p>
      <form
        className="mapillary-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = imageId.trim();
          if (!IMAGE_ID_PATTERN.test(trimmed)) {
            setError("Use 1–64 letters, digits, underscore, or hyphen.");
            return;
          }
          setError(null);
          props.onManualImageId(trimmed);
        }}
      >
        <label htmlFor="settings-image-id">Mapillary image ID</label>
        <div className="mapillary-form-row">
          <input
            id="settings-image-id"
            name="settings-image-id"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. p1x2…"
            value={imageId}
            onChange={(event) => setImageId(event.target.value)}
          />
          <button type="submit">Load image</button>
        </div>
      </form>
      {error && (
        <p className="search-status error-text" role="alert">
          {error}
        </p>
      )}
      <h3 className="settings-heading">Environment</h3>
      <p className="search-hint">
        Provider keys and timeouts live in <code>apps/server/.env</code> and{" "}
        <code>apps/web/.env</code> (see the <code>.env.example</code> files). Values are never
        displayed in the app.
      </p>
    </div>
  );
}

/**
 * Settings drawer: provider/database/developer configuration only. Workflow
 * actions live in their owning panels. Escape and Close dismiss; opening the
 * drawer never resets map zoom or viewer imagery.
 */
export function SettingsDrawer(props: SettingsDrawerProps) {
  const { onClose } = props;
  const [tab, setTab] = useState<SettingsTab>("providers");
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
        className="drawer-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <h2 id="settings-drawer-title" className="panel-title">
            Settings
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="drawer-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`drawer-tab${tab === entry.id ? " drawer-tab--active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {tab === "providers" && (
          <ProvidersTab health={props.health} search={props.search} sam={props.sam} />
        )}
        {tab === "database" && <DatabaseTab health={props.health} store={props.store} />}
        {tab === "developer" && <DeveloperTab onManualImageId={props.onManualImageId} />}
      </div>
    </div>
  );
}
