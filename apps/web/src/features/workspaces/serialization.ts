import type { StreetSearchResponse, StreetWorkItem } from "../../lib/api";
import type {
  CommittedRoi,
  ImageResult,
  SearchError,
  SearchQueryMeta,
  SearchStatus,
} from "../../lib/searchTypes";
import type { PreparationPlan, PreparationState } from "../preparation/preparationTypes";
import type { SequenceFilter } from "../sequences/sequenceGroup";
import type { SequenceLoadInfo, SequenceScope } from "../sequences/useSequences";
import type { StreetsStatus } from "../streets/useStreets";
import { STORAGE_SCHEMA_VERSION } from "../../lib/workspaceApi";
import type {
  DetectionItem,
  InventoryObservation,
  SourceView,
  WorkflowSession,
} from "../inventory/inventoryTypes";
import { buildPreviewResult } from "../inventory/inventoryReducer";

/** Client mirror of the server snapshot image cap (seeds first, then hydrated). */
export const SNAPSHOT_IMAGES_MAX = 5000;

export function newClientId(prefix: string): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** In-flight search states cannot survive a save; derive the honest rest state. */
export function normalizeDiscoveryStatus(status: SearchStatus, imageCount: number): SearchStatus {
  if (status === "loading") return "idle";
  if ((status === "results" || status === "empty") && imageCount === 0 && status === "results") {
    return "empty";
  }
  return status;
}

/** A preparation run cannot survive a save; its death reads as cancelled. */
export function normalizePreparationState(runState: PreparationState): PreparationState {
  return runState === "preparing" ? "cancelled" : runState;
}

export interface ImagerySnapshotPayload {
  query: SearchQueryMeta;
  warnings: string[];
  status: SearchStatus;
  everSearched: boolean;
  seeds: ImageResult[];
  hydrated: ImageResult[];
  truncatedCount: number;
}

export function buildImagerySnapshotPayload(input: {
  query: SearchQueryMeta;
  warnings: string[];
  status: SearchStatus;
  everSearched: boolean;
  seeds: ImageResult[];
  pool: ImageResult[];
}): ImagerySnapshotPayload {
  const seedIds = new Set(input.seeds.map((seed) => seed.id));
  const hydrated = input.pool.filter((image) => !seedIds.has(image.id));
  const seeds = input.seeds.slice(0, SNAPSHOT_IMAGES_MAX);
  const hydratedCapped = hydrated.slice(0, Math.max(0, SNAPSHOT_IMAGES_MAX - seeds.length));
  const truncatedCount = input.seeds.length + hydrated.length - seeds.length - hydratedCapped.length;
  return {
    query: input.query,
    warnings: [...input.warnings],
    status: normalizeDiscoveryStatus(input.status, input.pool.length),
    everSearched: input.everSearched,
    seeds,
    hydrated: hydratedCapped,
    truncatedCount,
  };
}

export interface StreetSnapshotPayload {
  streets: StreetWorkItem[];
  query: StreetSearchResponse["query"] | null;
  warnings: string[];
  seeded: boolean;
  retrievedAt: string | null;
}

export interface StoredRoi {
  revision: number;
  shape: CommittedRoi["shape"];
  polygon: CommittedRoi["polygon"];
  areaSqM: number;
  bbox: CommittedRoi["bbox"];
  valid: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  center: { lng: number; lat: number } | null;
  zoom: number | null;
}

export function buildStoredRoi(
  roi: CommittedRoi,
  view: { center: { lng: number; lat: number } | null; zoom: number | null },
): StoredRoi {
  return {
    revision: roi.id,
    shape: roi.shape,
    polygon: roi.polygon,
    areaSqM: roi.areaSqM,
    bbox: roi.bbox,
    valid: roi.valid,
    errorCode: roi.errorCode,
    errorMessage: roi.errorMessage,
    center: view.center,
    zoom: view.zoom,
  };
}

export interface WorkspaceBodyInput {
  name: string;
  roi: StoredRoi | null;
  imagerySnapshotId: string | null;
  imagerySelection: {
    status: SearchStatus;
    everSearched: boolean;
    imagerySnapshotId: number;
    warnings: string[];
    searchError: SearchError | null;
    selectedSequenceId: string | null;
    selectedUngroupedId: string | null;
    scope: SequenceScope;
    filter: SequenceFilter;
    loads: Record<string, SequenceLoadInfo>;
    requestedImageId: string | null;
    viewerImageId: string | null;
    truncatedCount: number;
    autoSequenceIds: string[];
  };
  streetSnapshotId: string | null;
  streetSelection: {
    status: StreetsStatus;
    checkedIds: string[];
    focusedId: string | null;
    seeded: boolean;
    snapshotId: number;
    warnings: string[];
    error: SearchError | null;
  };
  preparation: {
    runState: PreparationState;
    plan: PreparationPlan | null;
    failedStreetIds: string[];
    failureReasons: Record<string, string>;
  };
  activeSessionKey: string | null;
  sessionKeys: string[];
}

export function buildWorkspaceBody(input: WorkspaceBodyInput): Record<string, unknown> {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    name: input.name,
    roi: input.roi,
    imagerySnapshotId: input.imagerySnapshotId,
    imagerySelection: input.imagerySelection,
    streetSnapshotId: input.streetSnapshotId,
    streetSelection: input.streetSelection,
    preparation: {
      runState: normalizePreparationState(input.preparation.runState),
      plan: input.preparation.plan,
      failedStreetIds: input.preparation.failedStreetIds,
      failureReasons: input.preparation.failureReasons,
    },
    activeSessionKey: input.activeSessionKey,
    sessionKeys: input.sessionKeys,
  };
}

// ---------------------------------------------------------------------------
// Sessions: strip transient pixels/handles/objects; keep every decision.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize one manual session for storage. Masks, media handles, and parsed
 * item objects stay out: masks/objects resolve from immutable detection
 * items, pixels from evidence artifacts. Throws on demo sessions.
 */
export function serializeSession(session: WorkflowSession): Record<string, unknown> {
  if (session.mode !== "manual") {
    throw new Error("Only manual sessions persist; demo sessions stay memory-only.");
  }
  const clone = structuredClone(session) as unknown as Record<string, unknown>;
  const observations = clone.observations as Record<string, InventoryObservation>;
  for (const observation of Object.values(observations)) observation.mask = null;
  const views = clone.views as Record<string, SourceView>;
  for (const view of Object.values(views)) view.mediaHandle = "";
  for (const run of clone.runs as { items: DetectionItem[] }[]) {
    for (const item of run.items) item.objects = [];
  }
  return { schemaVersion: STORAGE_SCHEMA_VERSION, ...clone };
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RestoreError(`${field} is malformed.`);
  return value;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new RestoreError(`${field} is malformed.`);
  return value;
}

/**
 * Restore a stored session document to a working session. Defensive:
 * unknown shapes fail the open with a message instead of crashing the UI.
 */
export function restoreSession(stored: Record<string, unknown>): WorkflowSession {
  const fail = (field: string): never => {
    throw new RestoreError(`Stored session ${field} is malformed.`);
  };
  if (stored.mode !== "manual") fail("mode");
  if (typeof stored.key !== "string" || typeof stored.sessionId !== "string") fail("identity");
  const context = requiredRecord(stored.context, "context");
  if (typeof context.streetId !== "string" || typeof context.streetDisplayName !== "string") {
    fail("context");
  }
  const observations = requiredRecord(stored.observations, "observations");
  for (const [id, entry] of Object.entries(observations)) {
    if (!isRecord(entry)) fail(`observations.${id}`);
    if ((entry as Record<string, unknown>).id !== id) fail(`observations.${id}`);
  }
  const assets = requiredRecord(stored.assets, "assets");
  for (const [id, entry] of Object.entries(assets)) {
    if (!isRecord(entry)) fail(`assets.${id}`);
    if ((entry as Record<string, unknown>).id !== id) fail(`assets.${id}`);
  }
  const views = requiredRecord(stored.views, "views");
  for (const [id, entry] of Object.entries(views)) {
    if (!isRecord(entry)) fail(`views.${id}`);
    const view = entry as Record<string, unknown>;
    if (view.viewId !== id) fail(`views.${id}`);
    view.mediaHandle = "";
    if (view.artifactId !== null && typeof view.artifactId !== "string") view.artifactId = null;
  }
  for (const entry of Object.values(observations)) {
    (entry as Record<string, unknown>).mask = null;
  }
  const runs = requiredArray(stored.runs, "runs");
  for (const [index, entry] of runs.entries()) {
    if (!isRecord(entry)) fail(`runs[${index}]`);
    const run = entry as Record<string, unknown>;
    if (typeof run.runId !== "string" || !Array.isArray(run.items)) fail(`runs[${index}]`);
    if (!Array.isArray(run.viewIds)) run.viewIds = [];
    if (!Array.isArray(run.conceptIds)) run.conceptIds = [];
    for (const [itemIndex, rawItem] of (run.items as unknown[]).entries()) {
      if (!isRecord(rawItem)) fail(`runs[${index}].items[${itemIndex}]`);
      const item = rawItem as Record<string, unknown>;
      if (typeof item.itemId !== "string") fail(`runs[${index}].items[${itemIndex}]`);
      item.objects = [];
      for (const flag of ["truncated", "imported", "resultSaved", "registered"] as const) {
        if (typeof item[flag] !== "boolean") item[flag] = false;
      }
      if (typeof item.invalidDiscarded !== "number") item.invalidDiscarded = 0;
      if (item.artifactId !== null && typeof item.artifactId !== "string") item.artifactId = null;
      if (item.supersedes !== null && typeof item.supersedes !== "string") item.supersedes = null;
    }
  }
  if (!Array.isArray(stored.obsOrder) || !Array.isArray(stored.assetOrder) || !Array.isArray(stored.viewOrder)) {
    fail("ordering");
  }
  if (!Array.isArray(stored.concepts)) fail("concepts");
  if (stored.manifest !== null && !isRecord(stored.manifest)) fail("manifest");
  if (stored.stagedTest !== null && !isRecord(stored.stagedTest)) fail("stagedTest");
  if (stored.finishedPreview !== null && !isRecord(stored.finishedPreview)) fail("finishedPreview");
  if (!Array.isArray(stored.savedResultRefs)) stored.savedResultRefs = [];
  if (typeof stored.draftAfterResult !== "boolean") stored.draftAfterResult = false;
  for (const counter of ["obsCounter", "assetCounter", "conceptCounter", "runCounter"] as const) {
    if (typeof stored[counter] !== "number") fail(String(counter));
  }
  return stored as unknown as WorkflowSession;
}

// ---------------------------------------------------------------------------
// Workspace seeds: stored documents back to hook initials.
// ---------------------------------------------------------------------------

export interface ResultInput {
  resultId: string;
  sessionRevision: number;
  inputRevision: number | null;
  counts: Record<string, unknown>;
  limitations: string[];
  provenance: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  artifactIds: string[];
}

/**
 * Build one immutable reviewed-result version from a finished session. The
 * snapshot pins the exact evidence/review state the counts summarize;
 * missing evidence stays disclosed in the limitations.
 */
export function buildResultInput(
  session: WorkflowSession,
  input: { resultId: string; sessionRevision: number; finishedAt: string },
): ResultInput {
  const preview = session.finishedPreview ?? buildPreviewResult(session, input.finishedAt);
  const viewIds = new Set<string>();
  for (const observation of Object.values(session.observations)) {
    if (observation.viewId) viewIds.add(observation.viewId);
  }
  const artifactIds: string[] = [];
  const missingEvidence: string[] = [];
  for (const viewId of viewIds) {
    const view = session.views[viewId];
    if (!view) continue;
    if (view.artifactId) artifactIds.push(view.artifactId);
    else missingEvidence.push(viewId);
  }
  const limitations = [...preview.limitations];
  if (missingEvidence.length > 0) {
    limitations.push(
      `${missingEvidence.length} evidence view${missingEvidence.length === 1 ? " lacks" : "s lack"} stored pixels; review the live imagery or refetch before relying on the geometry.`,
    );
  }
  const observations = session.obsOrder.map((id) => {
    const observation = session.observations[id];
    return {
      id: observation.id,
      imageId: observation.imageId,
      viewId: observation.viewId,
      category: observation.category,
      decision: observation.decision,
      description: observation.description,
      imageRegion: observation.imageRegion,
      maskStale: observation.maskStale,
      origin: observation.origin,
      provenance: observation.provenance,
      note: observation.note,
    };
  });
  return {
    resultId: input.resultId,
    sessionRevision: input.sessionRevision,
    inputRevision: session.context.roiRevision,
    counts: { ...(preview.counts as unknown as Record<string, unknown>) },
    limitations,
    provenance: {
      model: preview.model,
      origins: preview.origins,
      streetSource: preview.streetSource,
      streetId: preview.streetId,
      streetDisplayName: preview.streetDisplayName,
      runId: preview.runId,
      fingerprint: preview.fingerprint,
    },
    snapshot: {
      preview,
      processing: preview.processing,
      observations,
      assets: session.assetOrder.map((id) => session.assets[id]),
      views: [...viewIds].map((viewId) => session.views[viewId]),
      manifest: session.manifest,
    },
    artifactIds,
  };
}

export interface RestoredImagerySeed {
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
}

const SEARCH_STATUSES: SearchStatus[] = ["idle", "loading", "cancelled", "failed", "empty", "results"];

function restoreImagerySeed(
  roi: CommittedRoi,
  selection: Record<string, unknown>,
  snapshot: Record<string, unknown> | null,
): RestoredImagerySeed | null {
  if (!snapshot) return null;
  const seeds = requiredArray(snapshot.seeds, "imagery seeds");
  const hydrated = requiredArray(snapshot.hydrated, "imagery hydrated");
  const images = [...(seeds as ImageResult[]), ...(hydrated as ImageResult[])];
  const status = SEARCH_STATUSES.includes(selection.status as SearchStatus)
    ? (selection.status as SearchStatus)
    : "idle";
  return {
    roi,
    images,
    seeds: seeds as ImageResult[],
    query: isRecord(snapshot.query) ? (snapshot.query as unknown as SearchQueryMeta) : null,
    warnings: Array.isArray(selection.warnings)
      ? (selection.warnings as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
    searchError: isRecord(selection.searchError) ? (selection.searchError as unknown as SearchError) : null,
    status: normalizeDiscoveryStatus(status === "loading" ? "idle" : status, images.length),
    everSearched: selection.everSearched === true,
    imagerySnapshotId:
      typeof selection.imagerySnapshotId === "number" ? selection.imagerySnapshotId : 0,
    requestedImageId:
      typeof selection.requestedImageId === "string" ? selection.requestedImageId : null,
  };
}

export interface RestoredWorkspaceSeed {
  roi: CommittedRoi | null;
  mapView: { center: [number, number]; zoom: number } | null;
  imagery: RestoredImagerySeed | null;
  sequences: {
    selectedSequenceId: string | null;
    selectedUngroupedId: string | null;
    scope: SequenceScope;
    filter: SequenceFilter;
    loads: Record<string, SequenceLoadInfo>;
    autoSequenceIds: string[];
  };
  streets: {
    status: StreetsStatus;
    streets: StreetWorkItem[];
    query: StreetSearchResponse["query"] | null;
    warnings: string[];
    error: SearchError | null;
    checkedIds: string[];
    focusedId: string | null;
    seeded: boolean;
    snapshotId: number;
  };
  preparation: {
    runState: PreparationState;
    plan: PreparationPlan | null;
    failedStreetIds: string[];
    failureReasons: Record<string, string>;
  };
  activeSessionKey: string | null;
  sessionKeys: string[];
}

const STREET_STATUSES: StreetsStatus[] = ["idle", "loading", "loaded", "failed"];
const PREPARATION_STATES: PreparationState[] = [
  "not_started",
  "preparing",
  "prepared",
  "failed",
  "cancelled",
  "stale",
];

function restoreLoads(value: unknown): Record<string, SequenceLoadInfo> {
  if (!isRecord(value)) return {};
  const loads: Record<string, SequenceLoadInfo> = {};
  for (const [sequenceId, entry] of Object.entries(value)) {
    // Fail-soft per sequence: a malformed load is dropped (re-hydratable
    // with an explicit click) instead of failing the whole open.
    if (!isRecord(entry) || typeof entry.state !== "string") continue;
    if (entry.memberIds !== null && !Array.isArray(entry.memberIds)) continue;
    loads[sequenceId] = entry as unknown as SequenceLoadInfo;
  }
  return loads;
}

export function restoreWorkspaceSeed(
  stored: Record<string, unknown>,
  imagerySnapshot: Record<string, unknown> | null,
  streetSnapshot: Record<string, unknown> | null,
): RestoredWorkspaceSeed {
  const rawRoi = stored.roi;
  let roi: CommittedRoi | null = null;
  let mapView: RestoredWorkspaceSeed["mapView"] = null;
  if (rawRoi !== null) {
    if (!isRecord(rawRoi) || typeof rawRoi.revision !== "number" || !isRecord(rawRoi.polygon)) {
      throw new RestoreError("Stored region is malformed.");
    }
    roi = {
      id: rawRoi.revision as number,
      shape: rawRoi.shape as CommittedRoi["shape"],
      polygon: rawRoi.polygon as unknown as CommittedRoi["polygon"],
      areaSqM: rawRoi.areaSqM as number,
      bbox: rawRoi.bbox as CommittedRoi["bbox"],
      valid: rawRoi.valid === true,
      errorCode: (rawRoi.errorCode as string | null) ?? null,
      errorMessage: (rawRoi.errorMessage as string | null) ?? null,
    };
    const center = rawRoi.center;
    const zoom = rawRoi.zoom;
    if (
      isRecord(center) &&
      typeof center.lng === "number" &&
      typeof center.lat === "number" &&
      typeof zoom === "number"
    ) {
      mapView = { center: [center.lat as number, center.lng as number], zoom: zoom as number };
    }
  }
  const imagerySelection = requiredRecord(stored.imagerySelection, "imagerySelection");
  const streetSelection = requiredRecord(stored.streetSelection, "streetSelection");
  const preparation = requiredRecord(stored.preparation, "preparation");

  const imagery = roi ? restoreImagerySeed(roi, imagerySelection, imagerySnapshot) : null;

  const scope = imagerySelection.scope;
  const filter = imagerySelection.filter;
  const sequences = {
    selectedSequenceId:
      typeof imagerySelection.selectedSequenceId === "string" ? imagerySelection.selectedSequenceId : null,
    selectedUngroupedId:
      typeof imagerySelection.selectedUngroupedId === "string" ? imagerySelection.selectedUngroupedId : null,
    scope: scope === "whole" ? "whole" : ("inside" as SequenceScope),
    filter: (typeof filter === "string" ? filter : "all") as SequenceFilter,
    loads: restoreLoads(imagerySelection.loads),
    autoSequenceIds: Array.isArray(imagerySelection.autoSequenceIds)
      ? (imagerySelection.autoSequenceIds as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  };

  const streetStatus = STREET_STATUSES.includes(streetSelection.status as StreetsStatus)
    ? (streetSelection.status as StreetsStatus)
    : "idle";
  const streets = {
    status: streetStatus === "loading" ? ("idle" as StreetsStatus) : streetStatus,
    streets: streetSnapshot ? (requiredArray(streetSnapshot.streets, "street streets") as StreetWorkItem[]) : [],
    query:
      streetSnapshot && isRecord(streetSnapshot.query)
        ? (streetSnapshot.query as unknown as StreetSearchResponse["query"])
        : null,
    warnings: Array.isArray(streetSelection.warnings)
      ? (streetSelection.warnings as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
    error: isRecord(streetSelection.error) ? (streetSelection.error as unknown as SearchError) : null,
    checkedIds: Array.isArray(streetSelection.checkedIds)
      ? (streetSelection.checkedIds as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
    focusedId: typeof streetSelection.focusedId === "string" ? streetSelection.focusedId : null,
    seeded: streetSelection.seeded === true,
    snapshotId: typeof streetSelection.snapshotId === "number" ? streetSelection.snapshotId : 0,
  };

  const runState = PREPARATION_STATES.includes(preparation.runState as PreparationState)
    ? normalizePreparationState(preparation.runState as PreparationState)
    : "not_started";
  return {
    roi,
    mapView,
    imagery,
    sequences,
    streets,
    preparation: {
      runState,
      plan: isRecord(preparation.plan) ? (preparation.plan as unknown as PreparationPlan) : null,
      failedStreetIds: Array.isArray(preparation.failedStreetIds)
        ? (preparation.failedStreetIds as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : [],
      failureReasons: isRecord(preparation.failureReasons)
        ? (preparation.failureReasons as Record<string, string>)
        : {},
    },
    activeSessionKey: typeof stored.activeSessionKey === "string" ? stored.activeSessionKey : null,
    sessionKeys: Array.isArray(stored.sessionKeys)
      ? (stored.sessionKeys as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}
