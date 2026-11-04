import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import type { RasterUpload } from "../../lib/detectionClient";
import {
  completeDetectionItem,
  createWorkspace,
  fetchDetectionItem,
  fetchSession,
  fetchSnapshot,
  fetchWorkspace,
  interruptDetectionItem,
  listDetectionItems,
  listReviewedResults,
  listWorkspaces,
  registerDetectionItem,
  saveReviewedResult,
  saveSession,
  saveWorkspace,
  storeSnapshot,
  uploadArtifact,
  type StoredWorkspace,
  type WorkspaceSummary,
} from "../../lib/workspaceApi";
import type {
  DetectionPersistence,
  EvidenceUploadInput,
  ItemCompletionInput,
  ItemRegistrationInput,
  RecoveredItem,
} from "../inventory/useInventorySessions";
import type { InventoryAction } from "../inventory/inventoryReducer";
import type { DetectionObject, SourceView, WorkflowSession } from "../inventory/inventoryTypes";
import { base64ToBytes, sha256HexAsync } from "./evidenceBytes";
import {
  RestoreError,
  buildResultInput,
  buildWorkspaceBody,
  newClientId,
  restoreSession,
  restoreWorkspaceSeed,
  type ImagerySnapshotPayload,
  type RestoredWorkspaceSeed,
  type StreetSnapshotPayload,
  type WorkspaceBodyInput,
} from "./serialization";

export const AUTOSAVE_DEBOUNCE_MS = 750;
export const AUTOSAVE_MAX_WAIT_MS = 10_000;
export const SETTLED_FLUSH_MS = 250;

export type SaveStatus =
  | { kind: "no-workspace" }
  | { kind: "loading" }
  | { kind: "clean"; savedAt: string | null }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "failed"; message: string }
  | { kind: "conflict"; record: string; message: string; currentRevision: number };

export interface TrackedSessionEntry {
  json: string;
  body: Record<string, unknown>;
}

export interface TrackedState {
  name: string;
  roi: WorkspaceBodyInput["roi"];
  imagery: { json: string; payload: ImagerySnapshotPayload } | null;
  imagerySelection: Record<string, unknown>;
  imagerySelectionJson: string;
  street: { json: string; payload: StreetSnapshotPayload } | null;
  streetSelection: Record<string, unknown>;
  streetSelectionJson: string;
  preparation: Record<string, unknown>;
  preparationJson: string;
  sessions: Record<string, TrackedSessionEntry>;
  activeSessionKey: string | null;
}

export interface WorkspaceSeedState {
  seedKey: number;
  workspaceId: string | null;
  name: string;
  seed: RestoredWorkspaceSeed;
  sessions: Record<string, WorkflowSession>;
  /** Opened from storage: run detection recovery once after mount. */
  recovered: boolean;
}

export function emptySeed(): RestoredWorkspaceSeed {
  return {
    roi: null,
    mapView: null,
    imagery: null,
    sequences: {
      selectedSequenceId: null,
      selectedUngroupedId: null,
      scope: "inside",
      filter: "all",
      loads: {},
    },
    streets: {
      status: "idle",
      streets: [],
      query: null,
      warnings: [],
      error: null,
      checkedIds: [],
      focusedId: null,
      seeded: false,
      snapshotId: 0,
    },
    preparation: { runState: "not_started", plan: null, failedStreetIds: [], failureReasons: {} },
    activeSessionKey: null,
    sessionKeys: [],
  };
}

function readWorkspaceParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("workspace");
  return value && value.length > 0 ? value : null;
}

function writeWorkspaceParam(workspaceId: string | null): void {
  const url = new URL(window.location.href);
  if (workspaceId) url.searchParams.set("workspace", workspaceId);
  else url.searchParams.delete("workspace");
  window.history.replaceState(null, "", url.toString());
}

/** Lightly validate a stored item for recovery (server validated at write). */
function toRecoveredItem(full: {
  status: string;
  objects: Record<string, unknown>[];
  model: string | null;
  truncated: boolean;
  invalidDiscarded: number;
  error: string | null;
}): RecoveredItem | null {
  const objects: DetectionObject[] = [];
  for (const entry of full.objects) {
    const box = entry.box as { x: number; y: number; w: number; h: number } | undefined;
    if (
      typeof entry.providerObjectId !== "string" ||
      !box ||
      [box.x, box.y, box.w, box.h].some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      return null;
    }
    const mask = entry.mask as DetectionObject["mask"];
    objects.push({
      providerObjectId: entry.providerObjectId as string,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      confidence: typeof entry.confidence === "number" ? (entry.confidence as number) : null,
      mask: mask && typeof mask === "object" ? mask : null,
    });
  }
  return {
    status: full.status,
    objects,
    model: full.model,
    truncated: full.truncated === true,
    invalidDiscarded: typeof full.invalidDiscarded === "number" ? full.invalidDiscarded : 0,
    error: full.error,
  };
}

export interface WorkspaceStoreOptions {
  dbState: "connected" | "connecting" | "unavailable" | null;
  prepareRaster: (view: SourceView) => Promise<RasterUpload>;
}

export interface ContentApi {
  dispatchTo: (key: string, action: InventoryAction) => void;
}

/**
 * Workspace persistence coordinator: owns the open workspace identity,
 * revisions, save state, and the detection-persistence adapter. Domain state
 * stays in the content hooks; the content reports a serializable snapshot
 * each render, and the store diffs, debounces, and flushes it.
 */
export function useWorkspaceStore(options: WorkspaceStoreOptions) {
  const [seedState, setSeedState] = useState<WorkspaceSeedState>({
    seedKey: 0,
    workspaceId: null,
    name: "",
    seed: emptySeed(),
    sessions: {},
    recovered: false,
  });
  const [status, setStatus] = useState<SaveStatus>({ kind: "no-workspace" });
  const [name, setNameState] = useState("");
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const trackedRef = useRef<TrackedState | null>(null);
  const contentRef = useRef<ContentApi | null>(null);
  const workspaceIdRef = useRef<string | null>(null);
  const statusRef = useRef<SaveStatus>(status);
  statusRef.current = status;
  /** Acknowledged baselines: exact JSON the server confirmed. */
  const ackedRef = useRef({
    imageryJson: null as string | null,
    imagerySnapshotId: null as string | null,
    streetJson: null as string | null,
    streetSnapshotId: null as string | null,
    workspaceJson: null as string | null,
    sessionJsons: {} as Record<string, string>,
  });
  const revisionsRef = useRef({ workspace: 0, sessions: {} as Record<string, number> });
  const flushChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const timerRef = useRef<number | null>(null);
  const firstDirtyAtRef = useRef<number | null>(null);
  const seedKeyRef = useRef(0);

  const dbReady = useCallback(() => optionsRef.current.dbState === "connected", []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Abort pending timers on unmount.
  useEffect(() => () => clearTimer(), [clearTimer]);

  const isDirty = useCallback((tracked: TrackedState): boolean => {
    const acked = ackedRef.current;
    if ((tracked.imagery?.json ?? null) !== acked.imageryJson) return true;
    if ((tracked.street?.json ?? null) !== acked.streetJson) return true;
    const sessionKeys = Object.keys(tracked.sessions);
    const ackedKeys = Object.keys(acked.sessionJsons);
    if (sessionKeys.length !== ackedKeys.length) return true;
    for (const key of sessionKeys) {
      if (tracked.sessions[key]?.json !== acked.sessionJsons[key]) return true;
    }
    // The workspace body is derived at flush time (snapshot IDs included);
    // compare its stable inputs here.
    const fingerprint = JSON.stringify({
      name: tracked.name,
      roi: tracked.roi,
      imagerySelection: tracked.imagerySelectionJson,
      streetSelection: tracked.streetSelectionJson,
      preparation: tracked.preparationJson,
      activeSessionKey: tracked.activeSessionKey,
      sessionKeys,
      imagerySnapshotId: acked.imagerySnapshotId,
      streetSnapshotId: acked.streetSnapshotId,
    });
    return fingerprint !== acked.workspaceJson;
  }, []);

  const scheduleFlush = useCallback(
    (delayMs: number) => {
      clearTimer();
      if (firstDirtyAtRef.current === null) firstDirtyAtRef.current = Date.now();
      const elapsed = Date.now() - firstDirtyAtRef.current;
      if (elapsed >= AUTOSAVE_MAX_WAIT_MS) {
        void flushNowRef.current();
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void flushNowRef.current();
      }, delayMs);
    },
    [clearTimer],
  );

  /**
   * Report the latest serializable snapshot (called every content render).
   * Pure diffing: schedules a debounced flush only when JSON differs from
   * the acknowledged baseline, and only while a workspace is open.
   */
  const track = useCallback(
    (tracked: TrackedState) => {
      trackedRef.current = tracked;
      if (!workspaceIdRef.current) return;
      const current = statusRef.current;
      if (current.kind === "loading" || current.kind === "conflict" || current.kind === "saving") {
        return;
      }
      if (!isDirty(tracked)) {
        if (current.kind === "dirty" || current.kind === "failed") {
          // Edits were undone back to the acknowledged state.
          setStatus({ kind: "clean", savedAt: null });
        }
        firstDirtyAtRef.current = null;
        clearTimer();
        return;
      }
      if (current.kind !== "dirty" && current.kind !== "failed") setStatus({ kind: "dirty" });
      scheduleFlush(AUTOSAVE_DEBOUNCE_MS);
    },
    [clearTimer, isDirty, scheduleFlush],
  );

  /** Prompt flush after a detection outcome (still serialized/coalesced). */
  const notifySettled = useCallback(
    (_key: string) => {
      if (!workspaceIdRef.current) return;
      const current = statusRef.current;
      if (current.kind === "loading" || current.kind === "conflict" || current.kind === "saving") {
        return;
      }
      scheduleFlush(SETTLED_FLUSH_MS);
    },
    [scheduleFlush],
  );

  const registerContent = useCallback((api: ContentApi) => {
    contentRef.current = api;
  }, []);

  /** Upload missing evidence rasters for observed views; patch the body. */
  const ensureEvidence = useCallback(
    async (
      workspaceId: string,
      sessionKey: string,
      body: Record<string, unknown>,
    ): Promise<{ patched: boolean; warnings: string[] }> => {
      const warnings: string[] = [];
      let patched = false;
      const views = body.views as Record<string, SourceView>;
      const sources = body.sources as Record<string, { attribution: string; sourceUrl: string }>;
      const observed = new Set<string>();
      for (const observation of Object.values(
        body.observations as Record<string, { viewId: string | null }>,
      )) {
        if (observation.viewId) observed.add(observation.viewId);
      }
      for (const viewId of observed) {
        const view = views[viewId];
        if (!view || view.artifactId) continue;
        try {
          const raster = await optionsRef.current.prepareRaster(view);
          const bytes = base64ToBytes(raster.dataBase64);
          const source = sources[view.imageId];
          const uploaded = await uploadArtifact(
            {
              contentHash: await sha256HexAsync(bytes),
              mime: "image/jpeg",
              width: raster.width,
              height: raster.height,
              byteLength: bytes.length,
              imageId: view.imageId,
              viewId: view.viewId,
              orientation: view.orientation,
              crop: view.crop ? { ...view.crop } : null,
              attribution: source?.attribution ?? "Mapillary contributors",
              sourceUrl: source?.sourceUrl ?? `https://www.mapillary.com/map/im/${view.imageId}`,
            },
            raster.dataBase64,
          );
          view.artifactId = uploaded.artifactId;
          patched = true;
          contentRef.current?.dispatchTo(sessionKey, {
            type: "VIEW_SET_ARTIFACT",
            viewId,
            artifactId: uploaded.artifactId,
          });
        } catch (error) {
          // Decisions still save; pixels stay pending for a later flush.
          warnings.push(
            `Evidence for view ${viewId} is unavailable (${error instanceof Error ? error.message : "upload failed"}). Decisions are saved; pixels stay pending.`,
          );
        }
      }
      return { patched, warnings };
    },
    [],
  );

  const doFlush = useCallback(async (): Promise<boolean> => {
    const workspaceId = workspaceIdRef.current;
    const tracked = trackedRef.current;
    if (!workspaceId || !tracked) return true;
    const current = statusRef.current;
    if (current.kind === "loading" || current.kind === "conflict") return false;
    if (!dbReady()) {
      // Dirty state preserved; the banner offers an explicit Retry.
      setStatus((prev) => (prev.kind === "saving" ? { kind: "dirty" } : prev));
      return false;
    }
    if (!isDirty(tracked)) {
      firstDirtyAtRef.current = null;
      setStatus({ kind: "clean", savedAt: null });
      return true;
    }
    const acked = ackedRef.current;
    try {
      // Snapshots first (immutable, idempotent): new content gets a new ID.
      let imagerySnapshotId = acked.imagerySnapshotId;
      if (tracked.imagery && tracked.imagery.json !== acked.imageryJson) {
        const snapshotId = newClientId("sn");
        await storeSnapshot(workspaceId, {
          snapshotId,
          kind: "imagery-discovery",
          payload: tracked.imagery.payload,
        });
        imagerySnapshotId = snapshotId;
        acked.imageryJson = tracked.imagery.json;
        acked.imagerySnapshotId = snapshotId;
      } else if (!tracked.imagery) {
        imagerySnapshotId = null;
        acked.imageryJson = null;
        acked.imagerySnapshotId = null;
      }
      let streetSnapshotId = acked.streetSnapshotId;
      if (tracked.street && tracked.street.json !== acked.streetJson) {
        const snapshotId = newClientId("sn");
        await storeSnapshot(workspaceId, {
          snapshotId,
          kind: "street-snapshot",
          payload: tracked.street.payload,
        });
        streetSnapshotId = snapshotId;
        acked.streetJson = tracked.street.json;
        acked.streetSnapshotId = snapshotId;
      } else if (!tracked.street) {
        streetSnapshotId = null;
        acked.streetJson = null;
        acked.streetSnapshotId = null;
      }
      // Sessions (valuable work first), with evidence staged ahead of them.
      const evidenceWarnings: string[] = [];
      for (const [key, entry] of Object.entries(tracked.sessions)) {
        const body = entry.body;
        const { warnings } = await ensureEvidence(workspaceId, key, body);
        evidenceWarnings.push(...warnings);
        const json = JSON.stringify(body);
        if (json === acked.sessionJsons[key]) continue;
        const expectedRevision = revisionsRef.current.sessions[key] ?? null;
        const revision = await saveSession(workspaceId, key, {
          expectedRevision,
          session: body,
        });
        revisionsRef.current.sessions[key] = revision;
        acked.sessionJsons[key] = json;
      }
      // Workspace document last: references every snapshot and session key.
      const workspaceBody = buildWorkspaceBody({
        name: tracked.name,
        roi: tracked.roi,
        imagerySnapshotId,
        imagerySelection: tracked.imagerySelection as WorkspaceBodyInput["imagerySelection"],
        streetSnapshotId,
        streetSelection: tracked.streetSelection as WorkspaceBodyInput["streetSelection"],
        preparation: tracked.preparation as WorkspaceBodyInput["preparation"],
        activeSessionKey: tracked.activeSessionKey,
        sessionKeys: Object.keys(tracked.sessions),
      });
      const workspaceJson = JSON.stringify({
        name: tracked.name,
        roi: tracked.roi,
        imagerySelection: tracked.imagerySelectionJson,
        streetSelection: tracked.streetSelectionJson,
        preparation: tracked.preparationJson,
        activeSessionKey: tracked.activeSessionKey,
        sessionKeys: Object.keys(tracked.sessions),
        imagerySnapshotId,
        streetSnapshotId,
      });
      if (workspaceJson !== acked.workspaceJson) {
        const revision = await saveWorkspace(workspaceId, {
          expectedRevision: revisionsRef.current.workspace,
          workspace: workspaceBody,
        });
        revisionsRef.current.workspace = revision;
        acked.workspaceJson = workspaceJson;
      }
      firstDirtyAtRef.current = null;
      setNotice(evidenceWarnings.length > 0 ? evidenceWarnings.join(" ") : null);
      setStatus({ kind: "clean", savedAt: new Date().toISOString() });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
        const currentRevision =
          typeof error.data.currentRevision === "number" ? error.data.currentRevision : 0;
        setStatus({
          kind: "conflict",
          record: "workspace or session",
          message: error.message,
          currentRevision,
        });
        return false;
      }
      const message = error instanceof Error ? error.message : "Save failed unexpectedly.";
      setStatus({ kind: "failed", message });
      return false;
    }
  }, [dbReady, ensureEvidence, isDirty]);

  const flushNowRef = useRef<() => Promise<boolean>>(async () => true);
  flushNowRef.current = () => {
    clearTimer();
    firstDirtyAtRef.current = null;
    setStatus((prev) =>
      prev.kind === "dirty" || prev.kind === "failed" ? { kind: "saving" } : prev,
    );
    flushChainRef.current = flushChainRef.current.then(() => doFlush());
    return flushChainRef.current;
  };

  /** Immediate flush (Save now / Retry). Resolves true when fully saved. */
  const flushNow = useCallback((): Promise<boolean> => flushNowRef.current(), []);

  /** Baselines for a freshly opened workspace; the first track() adopts them. */
  const pendingBaselineRef = useRef<{
    imagerySnapshotId: string | null;
    streetSnapshotId: string | null;
    workspaceRevision: number;
    sessionRevisions: Record<string, number>;
  } | null>(null);

  const adoptBaseline = useCallback((tracked: TrackedState): void => {
    const baseline = pendingBaselineRef.current;
    pendingBaselineRef.current = null;
    if (!baseline) return;
    // Sessions: the exact JSON the content serialized from restored state.
    const sessionJsons: Record<string, string> = {};
    for (const [key, entry] of Object.entries(tracked.sessions)) sessionJsons[key] = entry.json;
    ackedRef.current = {
      imageryJson: tracked.imagery?.json ?? null,
      imagerySnapshotId: baseline.imagerySnapshotId,
      streetJson: tracked.street?.json ?? null,
      streetSnapshotId: baseline.streetSnapshotId,
      workspaceJson: JSON.stringify({
        name: tracked.name,
        roi: tracked.roi,
        imagerySelection: tracked.imagerySelectionJson,
        streetSelection: tracked.streetSelectionJson,
        preparation: tracked.preparationJson,
        activeSessionKey: tracked.activeSessionKey,
        sessionKeys: Object.keys(tracked.sessions),
        imagerySnapshotId: baseline.imagerySnapshotId,
        streetSnapshotId: baseline.streetSnapshotId,
      }),
      sessionJsons,
    };
    revisionsRef.current = {
      workspace: baseline.workspaceRevision,
      sessions: baseline.sessionRevisions,
    };
    setStatus({ kind: "clean", savedAt: null });
  }, []);

  const trackWithBaseline = useCallback(
    (tracked: TrackedState) => {
      if (pendingBaselineRef.current) {
        trackedRef.current = tracked;
        adoptBaseline(tracked);
        return;
      }
      track(tracked);
    },
    [adoptBaseline, track],
  );

  const loadSeed = useCallback(
    async (
      workspace: StoredWorkspace,
    ): Promise<{ seedState: WorkspaceSeedState; sessionRevisions: Record<string, number> }> => {
      const workspaceId = workspace.workspaceId;
      const [imagerySnapshot, streetSnapshot] = await Promise.all([
        workspace.imagerySnapshotId
          ? fetchSnapshot(workspaceId, workspace.imagerySnapshotId).catch(() => null)
          : Promise.resolve(null),
        workspace.streetSnapshotId
          ? fetchSnapshot(workspaceId, workspace.streetSnapshotId).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (workspace.imagerySnapshotId && !imagerySnapshot) {
        throw new RestoreError("The saved imagery snapshot is missing; the workspace cannot open coherently.");
      }
      if (workspace.streetSnapshotId && !streetSnapshot) {
        throw new RestoreError("The saved street snapshot is missing; the workspace cannot open coherently.");
      }
      const seed = restoreWorkspaceSeed(
        workspace as unknown as Record<string, unknown>,
        (imagerySnapshot?.payload as Record<string, unknown>) ?? null,
        (streetSnapshot?.payload as Record<string, unknown>) ?? null,
      );
      const sessions: Record<string, WorkflowSession> = {};
      const sessionRevisions: Record<string, number> = {};
      for (const sessionKey of workspace.sessionKeys) {
        const stored = await fetchSession(workspaceId, sessionKey);
        sessions[sessionKey] = restoreSession(stored.session);
        sessionRevisions[sessionKey] = stored.revision;
      }
      seedKeyRef.current += 1;
      return {
        seedState: {
          seedKey: seedKeyRef.current,
          workspaceId,
          name: workspace.name,
          seed,
          sessions,
          recovered: true,
        },
        sessionRevisions,
      };
    },
    [],
  );

  const beginLoad = useCallback(() => {
    clearTimer();
    trackedRef.current = null;
    pendingBaselineRef.current = null;
    contentRef.current = null;
    setNotice(null);
    setStatus({ kind: "loading" });
  }, [clearTimer]);

  /** Open a workspace by ID. Flushes pending saves first; stays put on failure. */
  const openWorkspace = useCallback(
    async (workspaceId: string): Promise<string | null> => {
      if (statusRef.current.kind === "loading") return "A workspace is already loading.";
      if (workspaceIdRef.current) {
        const saved = await flushNowRef.current();
        if (!saved) return "Save the current workspace (or resolve the conflict) before switching.";
      }
      if (!dbReady()) return "Not saved — local database unavailable.";
      beginLoad();
      try {
        const workspace = await fetchWorkspace(workspaceId);
        const { seedState, sessionRevisions } = await loadSeed(workspace);
        workspaceIdRef.current = workspace.workspaceId;
        pendingBaselineRef.current = {
          imagerySnapshotId: workspace.imagerySnapshotId,
          streetSnapshotId: workspace.streetSnapshotId,
          workspaceRevision: workspace.revision,
          sessionRevisions,
        };
        setNameState(seedState.name);
        setSeedState(seedState);
        writeWorkspaceParam(workspaceId);
        return null;
      } catch (error) {
        workspaceIdRef.current = null;
        setStatus({ kind: "no-workspace" });
        return error instanceof Error ? error.message : "Opening the workspace failed.";
      }
    },
    [beginLoad, dbReady, loadSeed],
  );

  const refreshListRef = useRef<() => Promise<void>>(async () => undefined);
  refreshListRef.current = async () => {
    if (!dbReady()) {
      setWorkspaceList(null);
      setListError("Not saved — local database unavailable.");
      return;
    }
    try {
      setWorkspaceList(await listWorkspaces());
      setListError(null);
    } catch (error) {
      setWorkspaceList(null);
      setListError(error instanceof Error ? error.message : "Listing workspaces failed.");
    }
  };

  const refreshWorkspaceList = useCallback((): Promise<void> => refreshListRef.current(), []);

  /** Create a workspace on the server and open it empty. */
  const createNewWorkspace = useCallback(
    async (name: string): Promise<string | null> => {
      if (statusRef.current.kind === "loading") return "A workspace is already loading.";
      if (workspaceIdRef.current) {
        const saved = await flushNowRef.current();
        if (!saved) return "Save the current workspace (or resolve the conflict) before switching.";
      }
      if (!dbReady()) return "Not saved — local database unavailable.";
      beginLoad();
      try {
        const workspace = await createWorkspace(name.trim() || `Workspace ${new Date().toISOString().slice(0, 10)}`);
        workspaceIdRef.current = workspace.workspaceId;
        pendingBaselineRef.current = {
          imagerySnapshotId: null,
          streetSnapshotId: null,
          workspaceRevision: workspace.revision,
          sessionRevisions: {},
        };
        seedKeyRef.current += 1;
        const seedState: WorkspaceSeedState = {
          seedKey: seedKeyRef.current,
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          seed: emptySeed(),
          sessions: {},
          recovered: false,
        };
        setNameState(seedState.name);
        setSeedState(seedState);
        writeWorkspaceParam(workspace.workspaceId);
        void refreshListRef.current();
        return null;
      } catch (error) {
        workspaceIdRef.current = null;
        setStatus({ kind: "no-workspace" });
        return error instanceof Error ? error.message : "Creating the workspace failed.";
      }
    },
    [beginLoad, dbReady],
  );

  /** Rename locally; the rename saves with the next flush. */
  const renameWorkspace = useCallback((nextName: string): string | null => {
    if (!workspaceIdRef.current) return "No workspace is open.";
    const trimmed = nextName.trim();
    if (trimmed.length === 0) return "The name must not be blank.";
    if (trimmed.length > 120) return "The name must be at most 120 characters.";
    setNameState(trimmed);
    return null;
  }, []);

  /** Conflict: discard local edits and reload the newer stored version. */
  const reloadNewer = useCallback(async (): Promise<string | null> => {
    const workspaceId = workspaceIdRef.current;
    if (!workspaceId) return "No workspace is open.";
    if (!dbReady()) return "Not saved — local database unavailable.";
    beginLoad();
    try {
      const workspace = await fetchWorkspace(workspaceId);
      const { seedState, sessionRevisions } = await loadSeed(workspace);
      pendingBaselineRef.current = {
        imagerySnapshotId: workspace.imagerySnapshotId,
        streetSnapshotId: workspace.streetSnapshotId,
        workspaceRevision: workspace.revision,
        sessionRevisions,
      };
      setNameState(seedState.name);
      setSeedState(seedState);
      return null;
    } catch (error) {
      setStatus({ kind: "failed", message: error instanceof Error ? error.message : "Reload failed." });
      return error instanceof Error ? error.message : "Reload failed.";
    }
  }, [beginLoad, dbReady, loadSeed]);

  /**
   * Conflict: keep local edits by saving them as a new workspace. Saved
   * result versions stay with the old workspace (they are immutable history).
   */
  const saveAsNewWorkspace = useCallback(
    async (name: string): Promise<string | null> => {
      const tracked = trackedRef.current;
      if (!tracked) return "Nothing to save.";
      if (!dbReady()) return "Not saved — local database unavailable.";
      beginLoad();
      try {
        const workspace = await createWorkspace(name.trim() || `Workspace ${new Date().toISOString().slice(0, 10)}`);
        const workspaceId = workspace.workspaceId;
        let imagerySnapshotId: string | null = null;
        if (tracked.imagery) {
          imagerySnapshotId = newClientId("sn");
          await storeSnapshot(workspaceId, {
            snapshotId: imagerySnapshotId,
            kind: "imagery-discovery",
            payload: tracked.imagery.payload,
          });
        }
        let streetSnapshotId: string | null = null;
        if (tracked.street) {
          streetSnapshotId = newClientId("sn");
          await storeSnapshot(workspaceId, {
            snapshotId: streetSnapshotId,
            kind: "street-snapshot",
            payload: tracked.street.payload,
          });
        }
        const sessionRevisions: Record<string, number> = {};
        for (const [key, entry] of Object.entries(tracked.sessions)) {
          const body = { ...entry.body, savedResultRefs: [], draftAfterResult: false };
          const revision = await saveSession(workspaceId, key, { expectedRevision: null, session: body });
          sessionRevisions[key] = revision;
        }
        const revision = await saveWorkspace(workspaceId, {
          expectedRevision: workspace.revision,
          workspace: buildWorkspaceBody({
            name: workspace.name,
            roi: tracked.roi,
            imagerySnapshotId,
            imagerySelection: tracked.imagerySelection as WorkspaceBodyInput["imagerySelection"],
            streetSnapshotId,
            streetSelection: tracked.streetSelection as WorkspaceBodyInput["streetSelection"],
            preparation: tracked.preparation as WorkspaceBodyInput["preparation"],
            activeSessionKey: tracked.activeSessionKey,
            sessionKeys: Object.keys(tracked.sessions),
          }),
        });
        const stored = await fetchWorkspace(workspaceId);
        void revision;
        const { seedState } = await loadSeed(stored);
        // Local sessions keep their in-memory result refs cleared to match.
        for (const session of Object.values(seedState.sessions)) {
          session.savedResultRefs = [];
          session.draftAfterResult = false;
        }
        workspaceIdRef.current = workspaceId;
        pendingBaselineRef.current = {
          imagerySnapshotId,
          streetSnapshotId,
          workspaceRevision: stored.revision,
          sessionRevisions,
        };
        setNameState(seedState.name);
        setSeedState(seedState);
        writeWorkspaceParam(workspaceId);
        void refreshListRef.current();
        return null;
      } catch (error) {
        workspaceIdRef.current = null;
        setStatus({ kind: "no-workspace" });
        return error instanceof Error ? error.message : "Saving as a new workspace failed.";
      }
    },
    [beginLoad, dbReady, loadSeed],
  );

  const unavailableReason = useCallback((): string => {
    if (!workspaceIdRef.current) return "Open a workspace before running detection.";
    const current = statusRef.current;
    if (current.kind === "loading") return "Loading workspace — wait before running detection.";
    if (current.kind === "conflict") return "Resolve the conflict (reload newer or save as new) before running detection.";
    if (current.kind === "failed") return "Save failed — retry the save before running detection.";
    if (!dbReady()) return "Not saved — local database unavailable.";
    return "Detection is unavailable.";
  }, [dbReady]);

  const persistence: DetectionPersistence = useMemo(
    () => ({
      isAvailable: () => {
        if (!workspaceIdRef.current || !dbReady()) return false;
        const current = statusRef.current;
        return current.kind === "clean" || current.kind === "dirty" || current.kind === "saving";
      },
      unavailableReason,
      uploadEvidence: async (input: EvidenceUploadInput): Promise<string> => {
        const workspaceId = workspaceIdRef.current;
        if (!workspaceId) throw new Error("No workspace is open.");
        const bytes = base64ToBytes(input.raster.dataBase64);
        const uploaded = await uploadArtifact(
          {
            contentHash: await sha256HexAsync(bytes),
            mime: "image/jpeg",
            width: input.raster.width,
            height: input.raster.height,
            byteLength: bytes.length,
            imageId: input.view.imageId,
            viewId: input.view.viewId,
            orientation: input.view.orientation,
            crop: input.view.crop ? { ...input.view.crop } : null,
            attribution: input.source?.attribution ?? "Mapillary contributors",
            sourceUrl:
              input.source?.sourceUrl ?? `https://www.mapillary.com/map/im/${input.view.imageId}`,
          },
          input.raster.dataBase64,
        );
        if (!uploaded.artifactId) throw new Error("The server returned no artifact ID.");
        return uploaded.artifactId;
      },
      registerItem: async (key: string, input: ItemRegistrationInput) => {
        const workspaceId = workspaceIdRef.current;
        if (!workspaceId) throw new Error("No workspace is open.");
        return registerDetectionItem(workspaceId, key, { ...input });
      },
      completeItem: async (
        key: string,
        runId: string,
        itemId: string,
        completion: ItemCompletionInput,
      ): Promise<void> => {
        const workspaceId = workspaceIdRef.current;
        if (!workspaceId) throw new Error("No workspace is open.");
        await completeDetectionItem(workspaceId, key, runId, itemId, { ...completion });
      },
      fetchFullItem: async (key: string, runId: string, itemId: string) => {
        const workspaceId = workspaceIdRef.current;
        if (!workspaceId) return null;
        try {
          const full = await fetchDetectionItem(workspaceId, key, runId, itemId);
          return toRecoveredItem({
            status: full.status,
            objects: full.objects,
            model: full.model,
            truncated: full.truncated,
            invalidDiscarded: full.invalidDiscarded,
            error: full.error,
          });
        } catch {
          return null;
        }
      },
      listSlimItems: async (key: string) => {
        const workspaceId = workspaceIdRef.current;
        if (!workspaceId) return [];
        const all: { runId: string; itemId: string; status: string }[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          const response = await listDetectionItems(
            workspaceId,
            key,
            cursor ? { limit: 500, cursor } : { limit: 500 },
          );
          all.push(...response.items);
          cursor = response.nextCursor;
          if (!cursor) break;
        }
        return all;
      },
      interruptServerItems: async (key: string, refs: { runId: string; itemId: string }[]) => {
        const workspaceId = workspaceIdRef.current;
        if (!workspaceId) return;
        for (const ref of refs) {
          try {
            await interruptDetectionItem(workspaceId, key, ref.runId, ref.itemId);
          } catch {
            // Best effort: the local interrupt already landed.
          }
        }
      },
      notifySettled: (_key: string) => notifySettled(_key),
    }),
    [dbReady, notifySettled, unavailableReason],
  );

  /**
   * Save one immutable reviewed-result version: flush the session, post the
   * pinned snapshot (idempotent per resultId), record the version locally,
   * and flush again so the version reference persists. The snapshot builds
   * from the flushed session body, so just-uploaded evidence is included.
   */
  const saveReviewedResultVersion = useCallback(
    async (
      sessionKey: string,
      resultId: string,
    ): Promise<{ resultId: string } | { error: string }> => {
      const workspaceId = workspaceIdRef.current;
      if (!workspaceId) return { error: "No workspace is open." };
      if (!dbReady()) return { error: "Not saved — local database unavailable." };
      const flushed = await flushNowRef.current();
      if (!flushed) return { error: "Save the session before saving the result." };
      const sessionRevision = revisionsRef.current.sessions[sessionKey];
      if (!sessionRevision) return { error: "Save the session before saving the result." };
      const body = trackedRef.current?.sessions[sessionKey]?.body;
      if (!body) return { error: "The session is not available." };
      try {
        const input = buildResultInput(body as unknown as WorkflowSession, {
          resultId,
          sessionRevision,
          finishedAt: new Date().toISOString(),
        });
        const ack = await saveReviewedResult(workspaceId, sessionKey, { ...input });
        contentRef.current?.dispatchTo(sessionKey, {
          type: "RESULT_SAVED",
          resultId: ack.resultId,
          sessionRevision,
          createdAt: new Date().toISOString(),
        });
        await flushNowRef.current();
        return { resultId: ack.resultId };
      } catch (error) {
        if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
          setStatus({
            kind: "conflict",
            record: `session ${sessionKey}`,
            message: error.message,
            currentRevision:
              typeof error.data.currentRevision === "number" ? error.data.currentRevision : 0,
          });
        }
        return { error: error instanceof Error ? error.message : "Saving the result failed." };
      }
    },
    [dbReady],
  );

  const listSessionResults = useCallback(async (sessionKey: string) => {
    const workspaceId = workspaceIdRef.current;
    if (!workspaceId) return [];
    return listReviewedResults(workspaceId, sessionKey).catch(() => []);
  }, []);

  const openWorkspaceRef = useRef(openWorkspace);
  openWorkspaceRef.current = openWorkspace;

  // Open ?workspace= on first mount (once per page lifetime), after the
  // first health poll reports database readiness (bounded wait).
  const initialOpenRef = useRef(false);
  useEffect(() => {
    if (initialOpenRef.current) return;
    initialOpenRef.current = true;
    const workspaceId = readWorkspaceParam();
    if (!workspaceId) return;
    let waitedMs = 0;
    const timer = window.setInterval(() => {
      const dbState = optionsRef.current.dbState;
      if (dbState === null && waitedMs < 10_000) {
        waitedMs += 250;
        return;
      }
      window.clearInterval(timer);
      void openWorkspaceRef.current(workspaceId).then((error) => {
        if (error) setNotice(error);
      });
    }, 250);
    void timer;
  }, []);

  const hasUnsaved =
    status.kind === "dirty" || status.kind === "saving" || status.kind === "failed";

  return {
    seedState,
    status,
    name,
    notice,
    setNotice,
    workspaceList,
    listError,
    hasUnsaved,
    track: trackWithBaseline,
    registerContent,
    flushNow,
    openWorkspace,
    createNewWorkspace,
    renameWorkspace,
    reloadNewer,
    saveAsNewWorkspace,
    refreshWorkspaceList,
    persistence,
    saveReviewedResultVersion,
    listSessionResults,
  };
}

export type WorkspaceStore = ReturnType<typeof useWorkspaceStore>;
