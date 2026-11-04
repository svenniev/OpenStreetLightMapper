import { useCallback, useMemo, useRef, useState } from "react";
import { pointInRing, type LngLat } from "@openstreetlightmapper/geo";
import { ApiError, createDeadlineSignal } from "../../lib/api";
import {
  postSamDetection,
  type RasterUpload,
  type SamDetectionObject,
} from "../../lib/detectionClient";
import type { LatLngPair } from "../../lib/searchTypes";
import { DEMO_STREET_ID, DEMO_STREET_NAME, runDemoDetection, type DemoScenario } from "./demoFixtures";
import { MAX_CALLS_PER_BATCH } from "./inventoryTypes";
import type {
  AssetPlacement,
  ConceptPrompt,
  DetectionObject,
  InventoryMode,
  InventoryObservation,
  ObservationMask,
  SessionContext,
  SessionPreviewResult,
  SourceView,
  WorkflowSession,
  WorkflowStep,
} from "./inventoryTypes";
import {
  assessFinish,
  buildPreviewResult,
  createSession,
  inventoryReducer,
  type FinishAssessment,
  type InventoryAction,
} from "./inventoryReducer";

export const DEMO_SESSION_KEY = "demo";
export const UNDO_LIMIT = 20;
/** Pacing between staged demo observations (keeps Cancel reachable). */
export const DETECTION_TICK_MS = 25;

export interface LiveContext {
  roiRevision: number;
  runId: string;
  fingerprint: string;
}

export interface UseInventorySessionsOptions {
  /** Current preparation context, or null when no usable plan exists. */
  liveContext: LiveContext | null;
  /** Current RoI ring (lng/lat) for placement containment, or null. */
  roiRing: LngLat[] | null;
  /**
   * Prepare one view's exact inference raster for upload. Injected so the
   * hook stays testable without browser media; absent means SAM calls are
   * unavailable (manual-only path).
   */
  prepareRaster?: (view: SourceView) => Promise<RasterUpload>;
  /**
   * Durable detection persistence (evidence upload, item register/complete).
   * Absent in unit tests (memory-only queue); the app always provides it,
   * and new paid detection is blocked while it reports unavailable.
   */
  persistence?: DetectionPersistence;
  /** Restored sessions for a reopened workspace (remount per workspace). */
  initialSessions?: Record<string, WorkflowSession>;
}

/** Evidence raster upload: exact inference bytes plus view/source identity. */
export interface EvidenceUploadInput {
  raster: RasterUpload;
  view: SourceView;
  source: { imageId: string; attribution: string; sourceUrl: string } | undefined;
}

export interface ItemRegistrationInput {
  runId: string;
  itemId: string;
  kind: "test" | "batch";
  viewId: string;
  conceptId: string;
  prompt: string;
  categoryIntent: "pole" | "luminaire";
  model: string | null;
  viewDescriptor: Record<string, unknown>;
  artifactId: string;
  supersedes: string | null;
}

export interface ItemCompletionInput {
  status: "succeeded" | "empty" | "failed" | "cancelled";
  objects: DetectionObject[];
  model: string | null;
  truncated: boolean;
  invalidDiscarded: number;
  error: string | null;
  providerRequestId: string | null;
  finishedAt: string;
}

export interface RecoveredItem {
  status: string;
  objects: DetectionObject[];
  model: string | null;
  truncated: boolean;
  invalidDiscarded: number;
  error: string | null;
}

/**
 * Durable detection I/O behind the queue. All methods reject with Error on
 * transport/database failure; the queue turns that into honest item states
 * (never a second model call, never fake success).
 */
export interface DetectionPersistence {
  /** False while no workspace is open or the database is unreachable. */
  isAvailable: () => boolean;
  /** Human reason matching isAvailable() === false. */
  unavailableReason: () => string;
  /** Store the exact inference raster; resolves to the artifact ID. */
  uploadEvidence: (input: EvidenceUploadInput) => Promise<string>;
  /** Register an item before inference; resolves with the stored status. */
  registerItem: (key: string, input: ItemRegistrationInput) => Promise<{ status: string }>;
  /** Persist one terminal outcome (idempotent by runId+itemId). */
  completeItem: (
    key: string,
    runId: string,
    itemId: string,
    completion: ItemCompletionInput,
  ) => Promise<void>;
  /** Full stored item for recovery, or null when unknown. */
  fetchFullItem: (key: string, runId: string, itemId: string) => Promise<RecoveredItem | null>;
  /** Slim history for recovery (all pages). */
  listSlimItems: (key: string) => Promise<{ runId: string; itemId: string; status: string }[]>;
  /** Record stranded items as interrupted (best effort, never throws). */
  interruptServerItems: (key: string, refs: { runId: string; itemId: string }[]) => Promise<void>;
  /** A detection outcome landed; persist the session promptly. */
  notifySettled: (key: string) => void;
}

export interface RecoveryReport {
  recovered: number;
  interrupted: number;
  clearedStaged: boolean;
}

/** Client deadline per model call: server deadline plus transport margin. */
export const SAM_CLIENT_TIMEOUT_MS = 150_000;
/** Mirrors the server concept limit so the UI refuses before spending calls. */
export const CONCEPT_TEXT_MAX_LENGTH = 80;

export interface PlacementDraft {
  sessionKey: string;
  assetId: string;
  mode: InventoryMode;
  geo: LatLngPair | null;
  diagram: { x: number; y: number } | null;
  error: string | null;
}

interface HistoryEntry {
  label: string;
  snapshot: WorkflowSession;
}

const UNDOABLE = new Set<InventoryAction["type"]>([
  "OBS_DECIDE",
  "OBS_EDIT",
  "OBS_ADD",
  "OBS_SET_RECT",
  "ASSET_CREATE",
  "ASSET_ADD_OBS",
  "ASSET_REMOVE_OBS",
  "ASSET_SPLIT",
  "ASSET_MERGE",
  "ASSET_REMOVE",
  "SUPPORT_ATTACH",
  "SUPPORT_DETACH",
  "PLACE",
  "ASSET_CONFIRM",
]);

function actionLabel(action: InventoryAction): string {
  switch (action.type) {
    case "OBS_DECIDE":
      return `${action.decision} ${action.id}`;
    case "OBS_EDIT":
      return `Edit ${action.id}`;
    case "OBS_ADD":
      return `Add ${action.observation.id}`;
    case "OBS_SET_RECT":
      return `Annotation ${action.id}`;
    case "ASSET_CREATE":
      return "Create asset";
    case "ASSET_ADD_OBS":
      return `Add to ${action.assetId}`;
    case "ASSET_REMOVE_OBS":
      return `Unassign ${action.observationId}`;
    case "ASSET_SPLIT":
      return `Split ${action.assetId}`;
    case "ASSET_MERGE":
      return `Merge into ${action.retainedId}`;
    case "ASSET_REMOVE":
      return `Remove ${action.assetId}`;
    case "SUPPORT_ATTACH":
      return `Support ${action.luminaireId}`;
    case "SUPPORT_DETACH":
      return `Detach ${action.luminaireId}`;
    case "PLACE":
      return `Place ${action.assetId}`;
    case "ASSET_CONFIRM":
      return `Confirm ${action.assetId}`;
    default:
      return "Edit";
  }
}

/** Edited-work comparison: evidence and assets only, never step or detection. */
function domainKey(session: WorkflowSession): string {
  return JSON.stringify({
    observations: session.observations,
    assets: session.assets,
    obsOrder: session.obsOrder,
    assetOrder: session.assetOrder,
    obsCounter: session.obsCounter,
    assetCounter: session.assetCounter,
  });
}

function sessionIdFor(key: string): string {
  return key === DEMO_SESSION_KEY ? "demo" : `s-${key}`;
}

function isStaleSession(session: WorkflowSession, live: LiveContext | null): boolean {
  if (session.mode === "demo") return false;
  if (!live) return true;
  const context = session.context;
  return (
    context.roiRevision !== live.roiRevision ||
    context.runId !== live.runId ||
    context.fingerprint !== live.fingerprint
  );
}

function staleReason(session: WorkflowSession, live: LiveContext | null): string | null {
  if (session.mode === "demo" || !isStaleSession(session, live)) return null;
  if (!live) return "The preparation context is gone.";
  const context = session.context;
  if (context.roiRevision !== live.roiRevision) return "The region was replaced.";
  if (context.runId !== live.runId) return "A newer preparation run exists.";
  return "The street selection or imagery changed.";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type PlacementInputError = { error: string };

/**
 * Shared placement validation: real positions must be finite and inside the
 * current RoI (boundary included); diagram positions are 0..100 schematic
 * units. Never mixes the two coordinate systems.
 */
export function resolvePlacementInput(
  mode: InventoryMode,
  geo: LatLngPair | null,
  diagram: { x: number; y: number } | null,
  roiRing: LngLat[] | null,
): { placement: AssetPlacement } | PlacementInputError {
  if (mode === "manual") {
    if (!geo) return { error: "Click the map or enter coordinates first." };
    const [lat, lng] = geo;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: "Coordinates must be finite numbers." };
    }
    if (!roiRing) return { error: "No region is available for placement." };
    if (!pointInRing([lng, lat], roiRing)) {
      return { error: "Placement must be inside the current region, boundary included." };
    }
    return { placement: { kind: "geographic", lng, lat } };
  }
  if (!diagram) return { error: "Click the diagram or enter coordinates first." };
  const { x, y } = diagram;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    return { error: "Diagram coordinates must be numbers between 0 and 100." };
  }
  return { placement: { kind: "diagram", x, y } };
}

interface QueueState {
  generation: number;
  abort: AbortController | null;
  running: boolean;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function conceptTextError(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "Concept must be a short noun phrase.";
  if (trimmed.length > CONCEPT_TEXT_MAX_LENGTH) {
    return `Concept must be at most ${CONCEPT_TEXT_MAX_LENGTH} characters.`;
  }
  if (/[\r\n]/.test(trimmed)) return "Concept must be a single line.";
  return null;
}

/** Validate one provider object; drop (null) anything unusable. */
function toDetectionObject(raw: SamDetectionObject): DetectionObject | null {
  if (typeof raw.providerObjectId !== "string" || raw.providerObjectId.length === 0) return null;
  const box = raw.boxNorm;
  if (
    !box ||
    [box.x, box.y, box.w, box.h].some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return null;
  }
  const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);
  const x = clamp01(box.x);
  const y = clamp01(box.y);
  const w = clamp01(box.w);
  const h = clamp01(box.h);
  if (w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  let mask: ObservationMask | null = null;
  if (raw.mask) {
    const candidate = raw.mask;
    const bounds = candidate.bounds;
    if (
      typeof candidate.svgPath === "string" &&
      candidate.svgPath.length > 0 &&
      candidate.svgPath.length <= 1024 * 1024 &&
      Number.isSafeInteger(candidate.width) &&
      candidate.width > 0 &&
      Number.isSafeInteger(candidate.height) &&
      candidate.height > 0 &&
      bounds &&
      [bounds.left, bounds.top, bounds.right, bounds.bottom].every(
        (entry) => typeof entry === "number" && Number.isFinite(entry),
      )
    ) {
      mask = {
        svgPath: candidate.svgPath,
        width: candidate.width,
        height: candidate.height,
        bounds: { ...bounds },
      };
    }
  }
  return {
    providerObjectId: raw.providerObjectId,
    box: { x, y, w, h },
    confidence:
      typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
        ? raw.confidence
        : null,
    mask,
  };
}

function samFailureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Cancelled.";
  return "The SAM request failed unexpectedly.";
}

function persistenceFailureMessage(prefix: string, error: unknown): string {
  const detail =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : "request failed";
  return `${prefix}: ${detail}`;
}

/** Server item statuses that end an attempt (no further transitions). */
const TERMINAL_ITEM_STATUSES = new Set(["succeeded", "empty", "failed", "cancelled", "interrupted"]);

/**
 * Multi-session inventory workflow coordinator: demo + per-street manual
 * sessions, bounded undo, staleness against the live preparation context,
 * atomic demo detection runs, the SAM test/batch queue, and placement drafts.
 * All state is in-memory; only the detection queue touches the network, one
 * explicit model call at a time, through the injected raster pipeline.
 */
export function useInventorySessions(options: UseInventorySessionsOptions) {
  const [sessions, setSessions] = useState<Record<string, WorkflowSession>>(
    () => options.initialSessions ?? {},
  );
  const [histories, setHistories] = useState<Record<string, HistoryEntry[]>>({});
  const [initials, setInitials] = useState<Record<string, string>>(() => {
    const entries: Record<string, string> = {};
    for (const [key, session] of Object.entries(options.initialSessions ?? {})) {
      entries[key] = domainKey(session);
    }
    return entries;
  });
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<PlacementDraft | null>(null);
  const [highlight, setHighlight] = useState<{ sessionKey: string; assetId: string } | null>(null);

  const runRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const queueRef = useRef(new Map<string, QueueState>());
  const importedRef = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<string[]>([]);

  const dispatchTo = useCallback((key: string, action: InventoryAction) => {
    const live = optionsRef.current.liveContext;
    setSessions((prev) => {
      const session = prev[key];
      if (!session) return prev;
      if (action.type !== "SET_STEP" && isStaleSession(session, live)) return prev; // read-only
      const next = inventoryReducer(session, action);
      if (next === session) return prev;
      if (UNDOABLE.has(action.type)) {
        const label = actionLabel(action);
        const snapshot = structuredClone(session);
        setHistories((prior) => {
          const stack = [...(prior[key] ?? []), { label, snapshot }];
          return { ...prior, [key]: stack.slice(-UNDO_LIMIT) };
        });
      }
      return { ...prev, [key]: next };
    });
  }, []);

  const queueFor = (key: string): QueueState => {
    let queue = queueRef.current.get(key);
    if (!queue) {
      queue = { generation: 0, abort: null, running: false };
      queueRef.current.set(key, queue);
    }
    return queue;
  };

  const cancelQueue = useCallback((key: string) => {
    const queue = queueRef.current.get(key);
    if (queue) {
      queue.generation += 1;
      queue.abort?.abort();
      queue.abort = null;
      queue.running = false;
    }
    for (const stamp of [...importedRef.current]) {
      if (stamp.startsWith(`${key}:`)) importedRef.current.delete(stamp);
    }
    setBusyKeys((prev) => prev.filter((entry) => entry !== key));
  }, []);

  const activeSession = activeKey ? (sessions[activeKey] ?? null) : null;

  const openDemo = useCallback(() => {
    setSessions((prev) => {
      if (prev[DEMO_SESSION_KEY]) return prev;
      const created = createSession({
        key: DEMO_SESSION_KEY,
        sessionId: sessionIdFor(DEMO_SESSION_KEY),
        mode: "demo",
        streetId: DEMO_STREET_ID,
        streetDisplayName: DEMO_STREET_NAME,
        context: {
          streetId: DEMO_STREET_ID,
          streetDisplayName: DEMO_STREET_NAME,
          streetSource: "synthetic-demo",
          roiRevision: null,
          runId: null,
          fingerprint: null,
        },
      });
      setInitials((prior) => ({ ...prior, [DEMO_SESSION_KEY]: domainKey(created) }));
      return { ...prev, [DEMO_SESSION_KEY]: created };
    });
    setPlacement(null);
    setActiveKey(DEMO_SESSION_KEY);
    setIsOpen(true);
  }, []);

  const openStreet = useCallback(
    (streetId: string, streetDisplayName: string, streetSource: SessionContext["streetSource"] = "osm") => {
      const live = optionsRef.current.liveContext;
      if (!live) return;
      setSessions((prev) => {
        if (prev[streetId]) return prev;
        const created = createSession({
          key: streetId,
          sessionId: sessionIdFor(streetId),
          mode: "manual",
          streetId,
          streetDisplayName,
          context: { streetId, streetDisplayName, streetSource, ...live },
        });
        setInitials((prior) => ({ ...prior, [streetId]: domainKey(created) }));
        return { ...prev, [streetId]: created };
      });
      setPlacement(null);
      setActiveKey(streetId);
      setIsOpen(true);
    },
    [],
  );

  const closeWorkspace = useCallback(() => {
    setPlacement(null);
    setIsOpen(false);
  }, []);

  const switchSession = useCallback(
    (key: string, step?: WorkflowStep) => {
      if (!sessionsRef.current[key]) return;
      setPlacement(null);
      setHighlight(null);
      setActiveKey(key);
      setIsOpen(true);
      if (step) dispatchTo(key, { type: "SET_STEP", step });
    },
    [dispatchTo],
  );

  const undo = useCallback(() => {
    if (!activeKey) return;
    const session = sessionsRef.current[activeKey];
    if (!session || isStaleSession(session, optionsRef.current.liveContext)) return;
    const stack = histories[activeKey] ?? [];
    const entry = stack[stack.length - 1];
    if (!entry) return;
    setHistories((prev) => ({ ...prev, [activeKey]: stack.slice(0, -1) }));
    // Undo invalidates any finished result; edits already reopened review.
    setSessions((prev) => ({
      ...prev,
      [activeKey]: { ...entry.snapshot, finishedPreview: null },
    }));
  }, [activeKey, histories]);

  const resetSession = useCallback(() => {
    if (!activeKey) return;
    const key = activeKey;
    runRef.current += 1;
    cancelQueue(key);
    setSessions((prev) => {
      const session = prev[key];
      if (!session) return prev;
      const fresh = inventoryReducer(session, { type: "RESET_SESSION" });
      setInitials((prior) => ({ ...prior, [key]: domainKey(fresh) }));
      return { ...prev, [key]: fresh };
    });
    setHistories((prev) => ({ ...prev, [key]: [] }));
    setPlacement(null);
  }, [activeKey, cancelQueue]);

  const restartSession = useCallback(() => {
    const live = optionsRef.current.liveContext;
    if (!activeKey || !live) return;
    const key = activeKey;
    runRef.current += 1;
    cancelQueue(key);
    setSessions((prev) => {
      const session = prev[key];
      if (!session || session.mode === "demo") return prev;
      const fresh = createSession({
        key,
        sessionId: session.sessionId,
        mode: "manual",
        streetId: session.context.streetId,
        streetDisplayName: session.context.streetDisplayName,
        context: {
          streetId: session.context.streetId,
          streetDisplayName: session.context.streetDisplayName,
          streetSource: session.context.streetSource,
          ...live,
        },
      });
      setInitials((prior) => ({ ...prior, [key]: domainKey(fresh) }));
      return { ...prev, [key]: fresh };
    });
    setHistories((prev) => ({ ...prev, [key]: [] }));
    setPlacement(null);
  }, [activeKey, cancelQueue]);

  const discardAll = useCallback(() => {
    runRef.current += 1; // orphan late detection callbacks
    for (const key of queueRef.current.keys()) cancelQueue(key);
    setSessions({});
    setHistories({});
    setInitials({});
    setActiveKey(null);
    setIsOpen(false);
    setPlacement(null);
  }, [cancelQueue]);

  const dirtyKeys = useMemo(() => {
    const dirty = new Set<string>();
    for (const [key, session] of Object.entries(sessions)) {
      const initial = initials[key];
      if (initial !== undefined && domainKey(session) !== initial) dirty.add(key);
    }
    return dirty;
  }, [sessions, initials]);

  const cancelDetection = useCallback(() => {
    if (!activeKey) return;
    const key = activeKey;
    const session = sessionsRef.current[key];
    if (session?.detection.status !== "running") return;
    runRef.current += 1;
    dispatchTo(key, { type: "DETECT_CANCELLED" });
  }, [activeKey, dispatchTo]);

  const runDetection = useCallback(
    (scenario: DemoScenario, imageIds: string[], replace: boolean) => {
      if (!activeKey) return;
      const key = activeKey;
      const session = sessionsRef.current[key];
      if (!session || session.mode !== "demo") return;
      if (session.detection.status === "running") return;
      if (!replace && Object.keys(session.observations).length > 0) return;
      // The adapter is synchronous and deterministic; resolve the outcome
      // before starting so progress totals are exact and errors fail fast.
      let staged: InventoryObservation[];
      try {
        staged = runDemoDetection(imageIds, scenario);
      } catch (error) {
        dispatchTo(key, {
          type: "DETECT_FAILED",
          message: error instanceof Error ? error.message : "Demo detection failed.",
        });
        return;
      }
      const runId = runRef.current + 1;
      runRef.current = runId;
      dispatchTo(key, { type: "DETECT_START", runId, total: staged.length });
      void (async () => {
        // Stage visibly in small ticks; commit atomically at the end.
        for (let index = 0; index < staged.length; index += 1) {
          await wait(DETECTION_TICK_MS);
          if (runRef.current !== runId || !sessionsRef.current[key]) return;
          dispatchTo(key, { type: "DETECT_PROGRESS", runId, staged: index + 1 });
        }
        if (runRef.current !== runId || !sessionsRef.current[key]) return;
        dispatchTo(
          key,
          replace
            ? { type: "DETECT_REPLACE", observations: staged }
            : { type: "DETECT_APPLY", observations: staged },
        );
      })();
    },
    [activeKey, dispatchTo],
  );

  /**
   * Transfer one item's objects into pending observations exactly once.
   * A synchronous ref guard (not just the flushed imported flag) makes
   * rapid or repeated calls add nothing: callers pass already-validated
   * objects because the success dispatch may not have flushed yet.
   */
  const importItemObjects = useCallback(
    (key: string, runId: string, itemId: string, model: string, objects: DetectionObject[]) => {
      const stamp = `${key}:${runId}:${itemId}`;
      if (importedRef.current.has(stamp)) return;
      importedRef.current.add(stamp);
      const session = sessionsRef.current[key];
      const run = session?.runs.find((entry) => entry.runId === runId);
      const item = run?.items.find((entry) => entry.itemId === itemId);
      const view = item ? session?.views[item.viewId] : undefined;
      if (!session || !run || !item || !view || item.imported) return;
      const base = session.obsCounter;
      objects.forEach((object, index) => {
        dispatchTo(key, {
          type: "OBS_ADD",
          observation: {
            id: `obs-${base + index + 1}`,
            imageId: view.imageId,
            viewId: view.viewId,
            category: item.categoryIntent,
            description: `${item.conceptText} sighting`,
            imageRegion: { ...object.box },
            mask: object.mask
              ? { ...object.mask, bounds: { ...object.mask.bounds } }
              : null,
            maskStale: false,
            origin: "sam-text",
            provenance: {
              provider: "meta-sam",
              model,
              prompt: item.conceptText,
              categoryIntent: item.categoryIntent,
              runId,
              itemId: item.itemId,
              requestId: item.requestId,
              providerObjectId: object.providerObjectId,
              confidence: object.confidence,
              geometrySource: "model",
            },
            mode: "manual",
            decision: "pending",
            note: "",
          },
        });
      });
      dispatchTo(key, { type: "RUN_ITEM", runId, itemId, patch: { imported: true } });
    },
    [dispatchTo],
  );

  /**
   * Sequential queue pump: one model call at a time (default concurrency
   * one), per-item outcomes, generation-guarded so cancel/reset/restart
   * orphans late work instead of attaching it elsewhere.
   */
  const pumpQueue = useCallback(
    async (key: string, runId: string) => {
      const queue = queueFor(key);
      const generation = queue.generation;
      const finish = (wasCancelled: boolean) => {
        if (queue.generation !== generation) return;
        queue.running = false;
        queue.abort = null;
        setBusyKeys((prev) => prev.filter((entry) => entry !== key));
        dispatchTo(key, {
          type: "RUN_FINISH",
          runId,
          finishedAt: new Date().toISOString(),
          cancelled: wasCancelled,
        });
      };
      // Setup dispatches may not have flushed yet; wait briefly for queued work.
      let initial = sessionsRef.current[key]?.runs.find((entry) => entry.runId === runId);
      for (
        let attempt = 0;
        attempt < 20 &&
        (!initial || !initial.items.some((item) => item.status === "queued"));
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (queue.generation !== generation) return;
        initial = sessionsRef.current[key]?.runs.find((entry) => entry.runId === runId);
      }
      if (!initial) {
        finish(false);
        return;
      }
      const pendingIds = initial.items
        .filter((item) => item.status === "queued")
        .map((item) => item.itemId);
      let cancelled = false;
      for (const itemId of pendingIds) {
        if (queue.generation !== generation) return;
        const live = sessionsRef.current[key];
        if (!live || isStaleSession(live, optionsRef.current.liveContext)) {
          finish(false);
          return;
        }
        const run = live.runs.find((entry) => entry.runId === runId);
        const item = run?.items.find((entry) => entry.itemId === itemId);
        const view = item ? live.views[item.viewId] : undefined;
        if (!run || !item || !view || run.finishedAt || item.status !== "queued") {
          finish(false);
          return;
        }
        const prepare = optionsRef.current.prepareRaster;
        if (!prepare) {
          dispatchTo(key, {
            type: "RUN_ITEM",
            runId,
            itemId,
            patch: {
              status: "failed",
              error: "Raster preparation is unavailable.",
              finishedAt: new Date().toISOString(),
            },
          });
          continue;
        }
        const controller = new AbortController();
        queue.abort = controller;
        dispatchTo(key, {
          type: "RUN_ITEM",
          runId,
          itemId,
          patch: { status: "preparing", startedAt: new Date().toISOString(), attempts: item.attempts + 1 },
        });
        let raster: RasterUpload;
        try {
          raster = await prepare(view);
        } catch (error) {
          if (queue.generation !== generation) return;
          if (controller.signal.aborted) {
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId,
              patch: { status: "cancelled", finishedAt: new Date().toISOString() },
            });
            cancelled = true;
            break;
          }
          dispatchTo(key, {
            type: "RUN_ITEM",
            runId,
            itemId,
            patch: {
              status: "failed",
              error: samFailureMessage(error),
              finishedAt: new Date().toISOString(),
            },
          });
          continue;
        }
        if (queue.generation !== generation) return;
        if (controller.signal.aborted) {
          dispatchTo(key, {
            type: "RUN_ITEM",
            runId,
            itemId,
            patch: { status: "cancelled", finishedAt: new Date().toISOString() },
          });
          cancelled = true;
          break;
        }
        const persistence = optionsRef.current.persistence;
        let registered = false;
        if (persistence) {
          // Evidence first: no model call until the exact raster is stored
          // and the item is registered with its input.
          const settled = () => persistence.notifySettled(key);
          let artifactId: string;
          try {
            const source = live.sources[view.imageId];
            artifactId = await persistence.uploadEvidence({
              raster,
              view,
              source: source
                ? {
                    imageId: source.imageId,
                    attribution: source.attribution,
                    sourceUrl: source.sourceUrl,
                  }
                : undefined,
            });
          } catch (error) {
            if (queue.generation !== generation) return;
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId,
              patch: {
                status: "failed",
                error: `${persistenceFailureMessage("Evidence upload failed", error)}. No model call was made.`,
                finishedAt: new Date().toISOString(),
              },
            });
            settled();
            continue;
          }
          if (queue.generation !== generation) return;
          if (controller.signal.aborted) {
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId,
              patch: { status: "cancelled", finishedAt: new Date().toISOString() },
            });
            cancelled = true;
            settled();
            break;
          }
          dispatchTo(key, { type: "VIEW_SET_ARTIFACT", viewId: view.viewId, artifactId });
          dispatchTo(key, { type: "RUN_ITEM", runId, itemId, patch: { artifactId } });
          try {
            const registration = await persistence.registerItem(key, {
              runId,
              itemId,
              kind: run.kind,
              viewId: view.viewId,
              conceptId: item.conceptId,
              prompt: item.conceptText,
              categoryIntent: item.categoryIntent,
              model: null,
              viewDescriptor: {
                viewId: view.viewId,
                imageId: view.imageId,
                width: raster.width,
                height: raster.height,
                fullWidth: view.fullWidth,
                fullHeight: view.fullHeight,
                orientation: view.orientation,
                crop: view.crop,
              },
              artifactId,
              supersedes: item.supersedes,
            });
            registered = true;
            dispatchTo(key, { type: "RUN_ITEM", runId, itemId, patch: { registered: true } });
            if (TERMINAL_ITEM_STATUSES.has(registration.status)) {
              // A completed record already exists (crash between completion
              // and local apply): adopt it instead of spending a model call.
              const recovered = await persistence.fetchFullItem(key, runId, itemId).catch(() => null);
              if (
                recovered &&
                (recovered.status === "succeeded" || recovered.status === "empty")
              ) {
                dispatchTo(key, {
                  type: "RUN_ITEM",
                  runId,
                  itemId,
                  patch: {
                    status: recovered.status,
                    objects: recovered.objects,
                    model: recovered.model,
                    truncated: recovered.truncated,
                    invalidDiscarded: recovered.invalidDiscarded,
                    error: null,
                    resultSaved: true,
                    finishedAt: new Date().toISOString(),
                  },
                });
                if (run.kind === "batch") {
                  importItemObjects(key, runId, itemId, recovered.model ?? "unknown model", recovered.objects);
                } else {
                  dispatchTo(key, { type: "TEST_STAGE", runId, itemId });
                }
              } else {
                dispatchTo(key, {
                  type: "RUN_ITEM",
                  runId,
                  itemId,
                  patch: {
                    status: "failed",
                    error: "A saved result exists for this item but could not be loaded. No model call was made.",
                    finishedAt: new Date().toISOString(),
                  },
                });
              }
              settled();
              continue;
            }
          } catch (error) {
            if (queue.generation !== generation) return;
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId,
              patch: {
                status: "failed",
                error: `${persistenceFailureMessage("Detection registration failed", error)}. No model call was made.`,
                finishedAt: new Date().toISOString(),
              },
            });
            settled();
            continue;
          }
          if (queue.generation !== generation) return;
          if (controller.signal.aborted) {
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId,
              patch: { status: "cancelled", resultSaved: false, finishedAt: new Date().toISOString() },
            });
            void persistence
              .completeItem(key, runId, itemId, {
                status: "cancelled",
                objects: [],
                model: null,
                truncated: false,
                invalidDiscarded: 0,
                error: "Cancelled before inference.",
                providerRequestId: null,
                finishedAt: new Date().toISOString(),
              })
              .then(
                () =>
                  dispatchTo(key, {
                    type: "RUN_ITEM",
                    runId,
                    itemId,
                    patch: { resultSaved: true },
                  }),
                () => undefined,
              );
            cancelled = true;
            settled();
            break;
          }
        }
        dispatchTo(key, { type: "RUN_ITEM", runId, itemId, patch: { status: "detecting" } });
        const { signal, release } = createDeadlineSignal(SAM_CLIENT_TIMEOUT_MS, controller.signal);
        try {
          const response = await postSamDetection(
            {
              view: { viewId: view.viewId, imageId: view.imageId, width: raster.width, height: raster.height },
              concept: item.conceptText,
              categoryIntent: item.categoryIntent,
              requestId: item.requestId,
              image: {
                mimeType: raster.mimeType,
                dataBase64: raster.dataBase64,
                width: raster.width,
                height: raster.height,
              },
            },
            signal,
          );
          release();
          if (queue.generation !== generation) return;
          if (
            response.requestId !== item.requestId ||
            response.viewId !== view.viewId ||
            response.inputWidth !== raster.width ||
            response.inputHeight !== raster.height
          ) {
            const finishedAt = new Date().toISOString();
            let resultSaved = !persistence;
            if (persistence && registered) {
              try {
                await persistence.completeItem(key, runId, itemId, {
                  status: "failed",
                  objects: [],
                  model: response.model,
                  truncated: false,
                  invalidDiscarded: 0,
                  error: "The SAM response did not match this request.",
                  providerRequestId: item.requestId,
                  finishedAt,
                });
                resultSaved = true;
              } catch {
                if (queue.generation !== generation) return;
                resultSaved = false;
              }
            }
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId,
              patch: {
                status: "failed",
                error: "The SAM response did not match this request.",
                resultSaved,
                finishedAt,
              },
            });
            persistence?.notifySettled(key);
            continue;
          }
          const objects: DetectionObject[] = [];
          let invalidDiscarded = 0;
          for (const raw of response.objects) {
            const parsed = toDetectionObject(raw);
            if (parsed) objects.push(parsed);
            else invalidDiscarded += 1;
          }
          const status = objects.length > 0 ? "succeeded" : "empty";
          const finishedAt = new Date().toISOString();
          // Persist the parsed response before reporting it saved; a
          // database failure here keeps the in-memory result and flags it
          // unsaved instead of spending a second model call.
          let resultSaved = !persistence;
          if (persistence) {
            try {
              await persistence.completeItem(key, runId, itemId, {
                status,
                objects,
                model: response.model,
                truncated: response.truncated,
                invalidDiscarded,
                error: null,
                providerRequestId: item.requestId,
                finishedAt,
              });
              resultSaved = true;
            } catch {
              if (queue.generation !== generation) return;
              resultSaved = false;
            }
          }
          dispatchTo(key, {
            type: "RUN_ITEM",
            runId,
            itemId,
            patch: {
              status,
              objects,
              model: response.model,
              truncated: response.truncated,
              invalidDiscarded,
              error: null,
              resultSaved,
              finishedAt,
            },
          });
          persistence?.notifySettled(key);
          if (run.kind === "batch") importItemObjects(key, runId, itemId, response.model, objects);
          else dispatchTo(key, { type: "TEST_STAGE", runId, itemId });
        } catch (error) {
          release();
          if (queue.generation !== generation) return;
          if (controller.signal.aborted) {
            const finishedAt = new Date().toISOString();
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId,
              patch: { status: "cancelled", resultSaved: !persistence, finishedAt },
            });
            if (persistence && registered) {
              void persistence
                .completeItem(key, runId, itemId, {
                  status: "cancelled",
                  objects: [],
                  model: null,
                  truncated: false,
                  invalidDiscarded: 0,
                  error: "Cancelled.",
                  providerRequestId: item.requestId,
                  finishedAt,
                })
                .then(
                  () =>
                    dispatchTo(key, {
                      type: "RUN_ITEM",
                      runId,
                      itemId,
                      patch: { resultSaved: true },
                    }),
                  () => undefined,
                );
            }
            persistence?.notifySettled(key);
            cancelled = true;
            break;
          }
          const finishedAt = new Date().toISOString();
          const message = samFailureMessage(error);
          let resultSaved = !persistence;
          if (persistence && registered) {
            try {
              await persistence.completeItem(key, runId, itemId, {
                status: "failed",
                objects: [],
                model: null,
                truncated: false,
                invalidDiscarded: 0,
                error: message,
                providerRequestId: item.requestId,
                finishedAt,
              });
              resultSaved = true;
            } catch {
              if (queue.generation !== generation) return;
              resultSaved = false;
            }
          }
          dispatchTo(key, {
            type: "RUN_ITEM",
            runId,
            itemId,
            patch: {
              status: "failed",
              error: message,
              resultSaved,
              finishedAt,
            },
          });
          persistence?.notifySettled(key);
        } finally {
          if (queue.abort === controller) queue.abort = null;
        }
      }
      if (cancelled) {
        const live = sessionsRef.current[key];
        const run = live?.runs.find((entry) => entry.runId === runId);
        for (const item of run?.items ?? []) {
          if (item.status === "queued" || item.status === "preparing" || item.status === "detecting") {
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId,
              itemId: item.itemId,
              patch: { status: "cancelled", finishedAt: new Date().toISOString() },
            });
          }
        }
      }
      finish(cancelled);
    },
    [dispatchTo, importItemObjects],
  );

  const startQueue = useCallback(
    (key: string, runId: string): string | null => {
      const queue = queueFor(key);
      if (queue.running) return "A detection run is already in progress.";
      if (!optionsRef.current.prepareRaster) return "Raster preparation is unavailable.";
      const persistence = optionsRef.current.persistence;
      if (persistence && !persistence.isAvailable()) return persistence.unavailableReason();
      queue.running = true;
      setBusyKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
      void pumpQueue(key, runId);
      return null;
    },
    [pumpQueue],
  );

  /** One view × one concept: stages the result for explicit import. */
  const runTest = useCallback(
    (viewId: string, conceptId: string): string | null => {
      if (!activeKey) return "No active session.";
      const key = activeKey;
      const session = sessionsRef.current[key];
      if (!session || session.mode !== "manual") return "Tests run in manual sessions.";
      if (isStaleSession(session, optionsRef.current.liveContext)) {
        return "The session context changed — restart the preview.";
      }
      const view = session.views[viewId];
      if (!view) return "Select a source view first.";
      const concept: ConceptPrompt | undefined = session.concepts.find(
        (entry) => entry.id === conceptId,
      );
      if (!concept) return "Select a concept first.";
      if (!concept.enabled) return "Enable this concept first.";
      const textError = conceptTextError(concept.text);
      if (textError) return textError;
      const persistence = optionsRef.current.persistence;
      if (persistence && !persistence.isAvailable()) return persistence.unavailableReason();
      const runId = `run-${session.runCounter + 1}`;
      dispatchTo(key, {
        type: "RUN_START",
        run: {
          runId,
          kind: "test",
          createdAt: new Date().toISOString(),
          finishedAt: null,
          cancelled: false,
          viewIds: [view.viewId],
          conceptIds: [concept.id],
          items: [
            {
              itemId: `${runId}-item-1`,
              requestId: newRequestId(),
              viewId: view.viewId,
              conceptId: concept.id,
              conceptText: concept.text.trim(),
              categoryIntent: concept.categoryIntent,
              status: "queued",
              objects: [],
              model: null,
              error: null,
              attempts: 0,
              truncated: false,
              invalidDiscarded: 0,
              artifactId: null,
              supersedes: null,
              imported: false,
              resultSaved: !persistence,
              registered: false,
              startedAt: null,
              finishedAt: null,
            },
          ],
        },
      });
      persistence?.notifySettled(key);
      return startQueue(key, runId);
    },
    [activeKey, dispatchTo, startQueue],
  );

  /** Transfer the staged test result once into pending observations. */
  const importStagedTest = useCallback((): string | null => {
    if (!activeKey) return "No active session.";
    const key = activeKey;
    const session = sessionsRef.current[key];
    const staged = session?.stagedTest;
    if (!session || !staged) return "No staged test result.";
    if (isStaleSession(session, optionsRef.current.liveContext)) {
      return "The session context changed — restart the preview.";
    }
    const run = session.runs.find((entry) => entry.runId === staged.runId);
    const item = run?.items.find((entry) => entry.itemId === staged.itemId);
    if (!run || !item || (item.status !== "succeeded" && item.status !== "empty")) {
      return "The staged test did not succeed.";
    }
    if (!item.model) return "The staged test has no model result yet.";
    importItemObjects(key, run.runId, item.itemId, item.model, item.objects);
    dispatchTo(key, { type: "TEST_CLEAR" });
    return null;
  }, [activeKey, dispatchTo, importItemObjects]);

  const discardStagedTest = useCallback(() => {
    if (activeKey) dispatchTo(activeKey, { type: "TEST_CLEAR" });
  }, [activeKey, dispatchTo]);

  /**
   * Run every manifest view × enabled concept. Refuses when previous
   * text-prompt output exists unless replace is set (explicit, confirmed in
   * the UI); replacement retains manual and assisted work.
   */
  const runBatch = useCallback(
    (replace: boolean): string | null => {
      if (!activeKey) return "No active session.";
      const key = activeKey;
      const session = sessionsRef.current[key];
      if (!session || session.mode !== "manual") return "Batches run in manual sessions.";
      if (isStaleSession(session, optionsRef.current.liveContext)) {
        return "The session context changed — restart the preview.";
      }
      const views = (session.manifest?.viewIds ?? [])
        .map((viewId) => session.views[viewId])
        .filter((view): view is SourceView => Boolean(view));
      if (views.length === 0) return "Choose source views first.";
      const concepts = session.concepts.filter((concept) => concept.enabled);
      if (concepts.length === 0) return "Enable at least one concept.";
      for (const concept of concepts) {
        const textError = conceptTextError(concept.text);
        if (textError) return `Concept "${concept.text}": ${textError}`;
      }
      const total = views.length * concepts.length;
      if (total > MAX_CALLS_PER_BATCH) {
        return `${total} calls exceed the ${MAX_CALLS_PER_BATCH}-call batch cap — fewer views or concepts.`;
      }
      const hasSamText = Object.values(session.observations).some(
        (observation) => observation.origin === "sam-text",
      );
      if (hasSamText && !replace) {
        return "A previous run already produced observations — replace it explicitly.";
      }
      if (replace && hasSamText) dispatchTo(key, { type: "SAM_REPLACE", observations: [] });
      const persistence = optionsRef.current.persistence;
      if (persistence && !persistence.isAvailable()) return persistence.unavailableReason();
      const runId = `run-${session.runCounter + 1}`;
      dispatchTo(key, {
        type: "RUN_START",
        run: {
          runId,
          kind: "batch",
          createdAt: new Date().toISOString(),
          finishedAt: null,
          cancelled: false,
          viewIds: views.map((view) => view.viewId),
          conceptIds: concepts.map((concept) => concept.id),
          items: views.flatMap((view, viewIndex) =>
            concepts.map((concept, conceptIndex) => ({
              itemId: `${runId}-item-${viewIndex * concepts.length + conceptIndex + 1}`,
              requestId: newRequestId(),
              viewId: view.viewId,
              conceptId: concept.id,
              conceptText: concept.text.trim(),
              categoryIntent: concept.categoryIntent,
              status: "queued" as const,
              objects: [],
              model: null,
              error: null,
              attempts: 0,
              truncated: false,
              invalidDiscarded: 0,
              artifactId: null,
              supersedes: null,
              imported: false,
              resultSaved: !persistence,
              registered: false,
              startedAt: null,
              finishedAt: null,
            })),
          ),
        },
      });
      persistence?.notifySettled(key);
      return startQueue(key, runId);
    },
    [activeKey, dispatchTo, startQueue],
  );

  /** Stop queued work and abort the current request; completed items remain. */
  const cancelBatch = useCallback(() => {
    if (!activeKey) return;
    const key = activeKey;
    const session = sessionsRef.current[key];
    const run = [...(session?.runs ?? [])].reverse().find((entry) => !entry.finishedAt);
    cancelQueue(key);
    if (run && session && !isStaleSession(session, optionsRef.current.liveContext)) {
      const finishedAt = new Date().toISOString();
      for (const item of run.items) {
        if (item.status === "queued" || item.status === "preparing" || item.status === "detecting") {
          dispatchTo(key, {
            type: "RUN_ITEM",
            runId: run.runId,
            itemId: item.itemId,
            patch: { status: "cancelled", finishedAt },
          });
        }
      }
      dispatchTo(key, { type: "RUN_FINISH", runId: run.runId, finishedAt, cancelled: true });
    }
  }, [activeKey, cancelQueue, dispatchTo]);

  /**
   * Retry failed, cancelled, and interrupted items as new explicit attempts.
   * Each retry is a new item (new paid call) linked to the attempt it
   * supersedes; history keeps every outcome.
   */
  const retryFailed = useCallback(
    (runId: string): string | null => {
      if (!activeKey) return "No active session.";
      const key = activeKey;
      const session = sessionsRef.current[key];
      if (!session || session.mode !== "manual") return "Nothing to retry.";
      if (isStaleSession(session, optionsRef.current.liveContext)) {
        return "The session context changed — restart the preview.";
      }
      const persistence = optionsRef.current.persistence;
      if (persistence && !persistence.isAvailable()) return persistence.unavailableReason();
      const run = session.runs.find((entry) => entry.runId === runId);
      if (!run) return "Run not found.";
      const resumable = run.items.filter(
        (item) =>
          item.status === "failed" || item.status === "cancelled" || item.status === "interrupted",
      );
      if (resumable.length === 0) return "Nothing to retry.";
      // Skip items a newer attempt already supersedes (latest attempt only).
      const superseded = new Set(
        run.items.map((item) => item.supersedes).filter((id): id is string => id !== null),
      );
      const latestOnly = resumable.filter((item) => !superseded.has(item.itemId));
      if (latestOnly.length === 0) return "Nothing to retry.";
      const base = run.items.length;
      dispatchTo(key, {
        type: "RUN_ADD_ITEMS",
        runId,
        items: latestOnly.map((item, index) => ({
          itemId: `${runId}-item-${base + index + 1}`,
          requestId: newRequestId(),
          viewId: item.viewId,
          conceptId: item.conceptId,
          conceptText: item.conceptText,
          categoryIntent: item.categoryIntent,
          status: "queued" as const,
          objects: [],
          model: null,
          error: null,
          attempts: item.attempts,
          truncated: false,
          invalidDiscarded: 0,
          artifactId: null,
          supersedes: item.itemId,
          imported: false,
          resultSaved: !persistence,
          registered: false,
          startedAt: null,
          finishedAt: null,
        })),
      });
      dispatchTo(key, { type: "RUN_REOPEN", runId });
      persistence?.notifySettled(key);
      return startQueue(key, runId);
    },
    [activeKey, dispatchTo, startQueue],
  );

  /**
   * Retry one failed, cancelled, or interrupted item as a new attempt linked
   * via supersedes. Never auto-runs; the completion section offers it per row.
   */
  const retryItem = useCallback(
    (runId: string, itemId: string): string | null => {
      if (!activeKey) return "No active session.";
      const key = activeKey;
      const session = sessionsRef.current[key];
      if (!session || session.mode !== "manual") return "Nothing to retry.";
      if (isStaleSession(session, optionsRef.current.liveContext)) {
        return "The session context changed — restart the preview.";
      }
      const persistence = optionsRef.current.persistence;
      if (persistence && !persistence.isAvailable()) return persistence.unavailableReason();
      const run = session.runs.find((entry) => entry.runId === runId);
      if (!run) return "Run not found.";
      const item = run.items.find((entry) => entry.itemId === itemId);
      if (
        !item ||
        (item.status !== "failed" && item.status !== "cancelled" && item.status !== "interrupted")
      ) {
        return "Nothing to retry.";
      }
      const superseded = new Set(
        run.items.map((entry) => entry.supersedes).filter((id): id is string => id !== null),
      );
      if (superseded.has(item.itemId)) return "A newer attempt already supersedes this item.";
      const base = run.items.length;
      dispatchTo(key, {
        type: "RUN_ADD_ITEMS",
        runId,
        items: [
          {
            itemId: `${runId}-item-${base + 1}`,
            requestId: newRequestId(),
            viewId: item.viewId,
            conceptId: item.conceptId,
            conceptText: item.conceptText,
            categoryIntent: item.categoryIntent,
            status: "queued" as const,
            objects: [],
            model: null,
            error: null,
            attempts: item.attempts,
            truncated: false,
            invalidDiscarded: 0,
            artifactId: null,
            supersedes: item.itemId,
            imported: false,
            resultSaved: !persistence,
            registered: false,
            startedAt: null,
            finishedAt: null,
          },
        ],
      });
      dispatchTo(key, { type: "RUN_REOPEN", runId });
      persistence?.notifySettled(key);
      return startQueue(key, runId);
    },
    [activeKey, dispatchTo, startQueue],
  );

  const finishPreview = useCallback(
    (
      ackUnresolved: boolean,
      confirmEmpty: boolean,
      ackIncomplete = false,
    ): FinishAssessment & { finished: boolean } => {
      const fallback: FinishAssessment & { finished: boolean } = {
        ok: false,
        blockers: ["No active session."],
        needsEmptyConfirm: false,
        needsUnresolvedAck: false,
        needsIncompleteAck: false,
        unassigned: [],
        deferredCount: 0,
        unknownPositionCount: 0,
        emptyAssetCount: 0,
        includedCount: 0,
        incompleteItemCount: 0,
        finished: false,
      };
      if (!activeKey) return fallback;
      const session = sessionsRef.current[activeKey];
      if (!session || isStaleSession(session, optionsRef.current.liveContext)) {
        return { ...fallback, blockers: ["The session context changed — restart the preview."] };
      }
      const assessment = assessFinish(session);
      const blockers = [...assessment.blockers];
      if (assessment.ok && assessment.needsUnresolvedAck && !ackUnresolved) {
        blockers.push("Acknowledge the unresolved items summary.");
      }
      if (assessment.ok && assessment.needsEmptyConfirm && !confirmEmpty) {
        blockers.push("Confirm the explicitly reviewed empty set.");
      }
      if (assessment.ok && assessment.needsIncompleteAck && !ackIncomplete) {
        blockers.push("Acknowledge the incomplete image processing.");
      }
      if (blockers.length > 0) return { ...assessment, blockers, finished: false };
      const result: SessionPreviewResult = buildPreviewResult(session, new Date().toISOString());
      dispatchTo(activeKey, { type: "FINISH", result });
      return { ...assessment, blockers: [], finished: true };
    },
    [activeKey, dispatchTo],
  );

  const armPlacement = useCallback(
    (assetId: string) => {
      if (!activeKey) return;
      const session = sessionsRef.current[activeKey];
      if (!session || isStaleSession(session, optionsRef.current.liveContext)) return;
      if (!session.assets[assetId]) return;
      setPlacement({ sessionKey: activeKey, assetId, mode: session.mode, geo: null, diagram: null, error: null });
    },
    [activeKey],
  );

  const setPlacementDraft = useCallback(
    (patch: Partial<Pick<PlacementDraft, "geo" | "diagram">>) => {
      setPlacement((prev) => (prev ? { ...prev, ...patch, error: null } : prev));
    },
    [],
  );

  const cancelPlacement = useCallback(() => setPlacement(null), []);

  const applyPlacement = useCallback((): string | null => {
    const draft = placement;
    if (!draft) return "No placement in progress.";
    const session = sessionsRef.current[draft.sessionKey];
    if (!session || isStaleSession(session, optionsRef.current.liveContext)) {
      setPlacement(null);
      return "The session context changed — restart the preview.";
    }
    const asset = session.assets[draft.assetId];
    if (!asset || asset.observationIds.length === 0) return "Select a non-empty asset to place.";
    const resolved = resolvePlacementInput(
      draft.mode,
      draft.geo,
      draft.diagram,
      optionsRef.current.roiRing,
    );
    if ("error" in resolved) return resolved.error;
    dispatchTo(draft.sessionKey, { type: "PLACE", assetId: draft.assetId, placement: resolved.placement });
    setPlacement(null);
    return null;
  }, [placement, dispatchTo]);

  const placeFromCoordinates = useCallback(
    (assetId: string, input: { geo: LatLngPair } | { diagram: { x: number; y: number } }): string | null => {
      if (!activeKey) return "No active session.";
      const session = sessionsRef.current[activeKey];
      if (!session || isStaleSession(session, optionsRef.current.liveContext)) {
        return "The session context changed — restart the preview.";
      }
      const asset = session.assets[assetId];
      if (!asset || asset.observationIds.length === 0) return "Select a non-empty asset to place.";
      if (session.mode === "manual" && !("geo" in input)) return "Real previews need map coordinates.";
      if (session.mode === "demo" && !("diagram" in input)) return "Demo previews need diagram coordinates.";
      const resolved = resolvePlacementInput(
        session.mode,
        "geo" in input ? input.geo : null,
        "diagram" in input ? input.diagram : null,
        optionsRef.current.roiRing,
      );
      if ("error" in resolved) return resolved.error;
      dispatchTo(activeKey, { type: "PLACE", assetId, placement: resolved.placement });
      return null;
    },
    [activeKey, dispatchTo],
  );

  const undoLabel = activeKey ? (histories[activeKey]?.at(-1)?.label ?? null) : null;
  const undoBlockedStale =
    activeSession !== null && isStaleSession(activeSession, options.liveContext);

  /**
   * Retry durable persistence of one completed in-memory result. Never a
   * model call: re-sends the retained outcome to the idempotent endpoint.
   */
  const retryItemSave = useCallback(
    async (runId: string, itemId: string): Promise<string | null> => {
      if (!activeKey) return "No active session.";
      const key = activeKey;
      const persistence = optionsRef.current.persistence;
      if (!persistence) return null;
      if (!persistence.isAvailable()) return persistence.unavailableReason();
      const session = sessionsRef.current[key];
      const run = session?.runs.find((entry) => entry.runId === runId);
      const item = run?.items.find((entry) => entry.itemId === itemId);
      if (!session || !run || !item) return "Item not found.";
      if (item.resultSaved) return null;
      if (!item.registered) return "This item never reached the server — retry the detection instead.";
      if (
        item.status !== "succeeded" &&
        item.status !== "empty" &&
        item.status !== "failed" &&
        item.status !== "cancelled"
      ) {
        return "Only completed results can be saved.";
      }
      try {
        await persistence.completeItem(key, runId, itemId, {
          status: item.status,
          objects: item.objects,
          model: item.model,
          truncated: item.truncated,
          invalidDiscarded: item.invalidDiscarded,
          error: item.error,
          providerRequestId: item.requestId,
          finishedAt: item.finishedAt ?? new Date().toISOString(),
        });
      } catch (error) {
        return persistenceFailureMessage("Save failed", error);
      }
      dispatchTo(key, { type: "RUN_ITEM", runId, itemId, patch: { resultSaved: true } });
      persistence.notifySettled(key);
      return null;
    },
    [activeKey, dispatchTo],
  );

  /**
   * Restore-time recovery for one session: adopt completed server results
   * without new model calls, then mark stranded items interrupted (never
   * auto-retried). Reports what it did for an honest UI notice.
   */
  const recoverSession = useCallback(
    async (key: string): Promise<RecoveryReport> => {
      const report: RecoveryReport = { recovered: 0, interrupted: 0, clearedStaged: false };
      const persistence = optionsRef.current.persistence;
      const session = sessionsRef.current[key];
      if (!session || session.mode !== "manual") return report;
      const finishedAt = new Date().toISOString();
      if (!persistence || !persistence.isAvailable()) {
        dispatchTo(key, { type: "INTERRUPT_ITEMS", runId: null, finishedAt });
        return report;
      }
      const slim = await persistence.listSlimItems(key).catch((): {
        runId: string;
        itemId: string;
        status: string;
      }[] => []);
      const serverStatus = new Map(slim.map((entry) => [`${entry.runId} ${entry.itemId}`, entry.status]));
      const adopt = async (
        runId: string,
        itemId: string,
        kind: "test" | "batch",
      ): Promise<boolean> => {
        const full = await persistence.fetchFullItem(key, runId, itemId).catch(() => null);
        if (!full || (full.status !== "succeeded" && full.status !== "empty")) return false;
        dispatchTo(key, {
          type: "RUN_ITEM",
          runId,
          itemId,
          patch: {
            status: full.status,
            objects: full.objects,
            model: full.model,
            truncated: full.truncated,
            invalidDiscarded: full.invalidDiscarded,
            error: null,
            resultSaved: true,
            finishedAt: new Date().toISOString(),
          },
        });
        if (kind === "batch") {
          importItemObjects(key, runId, itemId, full.model ?? "unknown model", full.objects);
        } else {
          dispatchTo(key, { type: "TEST_STAGE", runId, itemId });
        }
        report.recovered += 1;
        return true;
      };
      // Stranded in-flight items: adopt usable saved results, else interrupt.
      const interruptRefs: { runId: string; itemId: string }[] = [];
      for (const run of session.runs) {
        for (const item of run.items) {
          const inFlight =
            item.status === "queued" || item.status === "preparing" || item.status === "detecting";
          if (!inFlight) continue;
          const status = serverStatus.get(`${run.runId} ${item.itemId}`);
          if ((status === "succeeded" || status === "empty") && (await adopt(run.runId, item.itemId, run.kind))) {
            continue;
          }
          interruptRefs.push({ runId: run.runId, itemId: item.itemId });
        }
      }
      if (interruptRefs.length > 0) {
        dispatchTo(key, { type: "INTERRUPT_ITEMS", runId: null, finishedAt });
        report.interrupted = interruptRefs.length;
        await persistence.interruptServerItems(key, interruptRefs);
      }
      // Terminal-but-unimported items that lost their objects: adopt or retire.
      const live = sessionsRef.current[key] ?? session;
      for (const run of live.runs) {
        for (const item of run.items) {
          if (item.imported || item.objects.length > 0) continue;
          if (item.status !== "succeeded" && item.status !== "empty") continue;
          if (!item.registered || !item.resultSaved) {
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId: run.runId,
              itemId: item.itemId,
              patch: {
                status: "interrupted",
                error:
                  "The result was never saved and cannot be recovered. Retry explicitly for a new attempt.",
                finishedAt: new Date().toISOString(),
              },
            });
            report.interrupted += 1;
            continue;
          }
          const status = serverStatus.get(`${run.runId} ${item.itemId}`);
          if (status === "succeeded" || status === "empty") {
            await adopt(run.runId, item.itemId, run.kind);
          }
        }
      }
      // Staged test without objects: reattach, or clear when unrecoverable.
      const staged = sessionsRef.current[key]?.stagedTest;
      if (staged) {
        const current = sessionsRef.current[key];
        const stagedItem = current?.runs
          .find((entry) => entry.runId === staged.runId)
          ?.items.find((entry) => entry.itemId === staged.itemId);
        if (
          stagedItem &&
          stagedItem.objects.length === 0 &&
          (stagedItem.status === "succeeded" || stagedItem.status === "empty")
        ) {
          const full = await persistence.fetchFullItem(key, staged.runId, staged.itemId).catch(() => null);
          if (full && full.status === stagedItem.status && full.objects.length > 0) {
            dispatchTo(key, {
              type: "RUN_ITEM",
              runId: staged.runId,
              itemId: staged.itemId,
              patch: {
                objects: full.objects,
                model: full.model,
                truncated: full.truncated,
                invalidDiscarded: full.invalidDiscarded,
                resultSaved: true,
              },
            });
            report.recovered += 1;
          } else if (!full || (full.objects.length === 0 && full.status !== "empty")) {
            dispatchTo(key, { type: "TEST_CLEAR" });
            report.clearedStaged = true;
          }
        }
      }
      persistence.notifySettled(key);
      return report;
    },
    [dispatchTo, importItemObjects],
  );

  return {
    sessions,
    activeKey,
    activeSession,
    isOpen,
    placement,
    histories,
    dirtyKeys,
    hasDirty: dirtyKeys.size > 0,
    highlight,
    setHighlight,
    undoLabel,
    canUndo: undoLabel !== null && !undoBlockedStale,
    undoBlockedStale,
    isStale: (session: WorkflowSession) => isStaleSession(session, options.liveContext),
    staleReason: (session: WorkflowSession) => staleReason(session, options.liveContext),
    openDemo,
    openStreet,
    closeWorkspace,
    switchSession,
    dispatch: (action: InventoryAction) => {
      if (activeKey) dispatchTo(activeKey, action);
    },
    dispatchTo,
    undo,
    resetSession,
    restartSession,
    discardAll,
    runDetection,
    cancelDetection,
    busyKeys,
    runTest,
    importStagedTest,
    discardStagedTest,
    runBatch,
    cancelBatch,
    retryFailed,
    retryItem,
    retryItemSave,
    recoverSession,
    finishPreview,
    armPlacement,
    setPlacementDraft,
    cancelPlacement,
    applyPlacement,
    placeFromCoordinates,
  };
}

export type InventorySessions = ReturnType<typeof useInventorySessions>;
