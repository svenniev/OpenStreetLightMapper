import { useState } from "react";
import { formatRetrievedAt } from "../../lib/search";
import type { WorkspaceStore, SaveStatus } from "./useWorkspaceStore";

function saveText(status: SaveStatus): string {
  switch (status.kind) {
    case "no-workspace":
      return "No workspace open — work is not saved.";
    case "loading":
      return "Loading workspace";
    case "clean":
      return status.savedAt ? `Saved locally · ${formatRetrievedAt(status.savedAt)}` : "Saved locally";
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "failed":
      return `Save failed · ${status.message}`;
    case "conflict":
      return "Conflict";
  }
}

/** Autosave state line under the header; failures offer an explicit retry. */
export function SaveBanner({ store }: { store: WorkspaceStore }) {
  const { status } = store;
  return (
    <div
      className={`save-banner save-banner--${status.kind}`}
      role="status"
      aria-live="polite"
    >
      <span>{saveText(status)}</span>
      {status.kind === "failed" && (
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          onClick={() => void store.flushNow()}
        >
          Retry save
        </button>
      )}
      {(status.kind === "dirty" || status.kind === "clean") && store.seedState.workspaceId && (
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          onClick={() => void store.flushNow()}
        >
          Save now
        </button>
      )}
    </div>
  );
}

/**
 * Revision-conflict resolution. The autosaver never overwrites a newer
 * stored revision: reload it or fork local edits into a new workspace.
 */
export function ConflictDialog({ store }: { store: WorkspaceStore }) {
  const { status } = store;
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status.kind !== "conflict") return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        className="modal-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="conflict-title" className="panel-title">
          Newer version on the server
        </h2>
        <p className="search-status" role="alert">
          {status.record} changed elsewhere (stored revision {status.currentRevision}). Your
          unsaved edits are still in memory — nothing was overwritten.
        </p>
        {error && (
          <p className="search-status error-text" role="alert">
            {error}
          </p>
        )}
        <div className="inventory-actions">
          <button
            type="button"
            className="toolbar-button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              void store.reloadNewer().then((message) => {
                setBusy(false);
                setError(message);
              });
            }}
          >
            Reload newer (discard my edits)
          </button>
        </div>
        <label className="inventory-label">
          Save my edits as a new workspace
          <input
            type="text"
            className="inventory-input"
            value={name}
            maxLength={120}
            placeholder={`${store.name} (fork)`}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="inventory-actions">
          <button
            type="button"
            className="toolbar-button toolbar-button--primary"
            disabled={busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              void store.saveAsNewWorkspace(name.trim() || `${store.name} (fork)`).then((message) => {
                setBusy(false);
                setError(message);
              });
            }}
          >
            Save as new workspace
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Workspace menu: current name + rename, open/create/list. The list refreshes
 * on demand only — opening a workspace flushes pending saves first.
 */
export function WorkspaceMenu({ store }: { store: WorkspaceStore }) {
  const [open, setOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [rename, setRename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentId = store.seedState.workspaceId;

  const run = (task: () => Promise<string | null>) => {
    setError(null);
    setBusy(true);
    void task().then((message) => {
      setBusy(false);
      setError(message);
      if (!message) setOpen(false);
    });
  };

  return (
    <div className="workspace-menu">
      <button
        type="button"
        className="toolbar-button"
        aria-expanded={open}
        onClick={() => {
          setError(null);
          if (!open) void store.refreshWorkspaceList();
          setOpen((value) => !value);
        }}
      >
        {currentId ? `Workspace: ${store.name}` : "Workspaces"}
      </button>
      {open && (
        <div className="workspace-menu-panel" role="dialog" aria-label="Workspaces">
          {error && (
            <p className="search-status error-text" role="alert">
              {error}
            </p>
          )}
          {currentId && (
            <div className="workspace-menu-row">
              {rename === null ? (
                <>
                  <span className="search-status">
                    Open: <strong>{store.name}</strong>
                  </span>{" "}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setRename(store.name)}
                  >
                    Rename
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="text"
                    className="inventory-input"
                    value={rename}
                    maxLength={120}
                    disabled={busy}
                    aria-label="Workspace name"
                    onChange={(event) => setRename(event.target.value)}
                  />{" "}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => {
                      const message = store.renameWorkspace(rename);
                      setError(message);
                      if (!message) setRename(null);
                    }}
                  >
                    Save name
                  </button>{" "}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setRename(null)}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
          <div className="workspace-menu-row">
            <input
              type="text"
              className="inventory-input"
              value={createName}
              maxLength={120}
              placeholder="New workspace name"
              disabled={busy}
              aria-label="New workspace name"
              onChange={(event) => setCreateName(event.target.value)}
            />{" "}
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={busy}
              onClick={() => run(() => store.createNewWorkspace(createName))}
            >
              Create and open
            </button>
          </div>
          <div className="workspace-menu-row">
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => void store.refreshWorkspaceList()}
            >
              Refresh list
            </button>
          </div>
          {store.listError && (
            <p className="search-status error-text" role="alert">
              {store.listError}
            </p>
          )}
          {store.workspaceList && store.workspaceList.length === 0 && (
            <p className="search-status">No saved workspaces yet.</p>
          )}
          {store.workspaceList && store.workspaceList.length > 0 && (
            <ul className="batch-items">
              {store.workspaceList.map((entry) => (
                <li key={entry.workspaceId}>
                  <strong>{entry.name}</strong> · {entry.sessionCount} session
                  {entry.sessionCount === 1 ? "" : "s"} · rev {entry.revision} ·{" "}
                  {formatRetrievedAt(entry.updatedAt)}{" "}
                  {entry.workspaceId === currentId ? (
                    <span className="search-hint">(open)</span>
                  ) : (
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy}
                      onClick={() => run(() => store.openWorkspace(entry.workspaceId))}
                    >
                      Open
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
