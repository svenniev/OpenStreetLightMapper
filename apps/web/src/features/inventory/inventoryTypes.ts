/**
 * Detect → review → group → place → inventory preview domain model.
 *
 * Everything here lives in React/in-memory state only: no database, no
 * storage APIs, no exports. Records carry their mode (demo/manual) and street
 * provenance as data, and demo records can never cross into real sessions.
 *
 * Raster bytes never live here: views describe inference rasters (IDs,
 * dimensions, transforms, media handles) while bytes stay in the media cache
 * and transient upload buffers, so undo snapshots only clone small descriptors.
 */

export type InventoryMode = "demo" | "manual";

export type WorkflowStep = "detect" | "review" | "group" | "place" | "inventory";

export const WORKFLOW_STEPS: WorkflowStep[] = ["detect", "review", "group", "place", "inventory"];

export const WORKFLOW_STEP_LABELS: Record<WorkflowStep, string> = {
  detect: "1 Detect",
  review: "2 Review",
  group: "3 Group assets",
  place: "4 Place assets",
  inventory: "5 Inventory",
};

export type ObservationCategory = "pole" | "luminaire" | "uncertain";

export type AssetCategory = "pole" | "luminaire";

export const OBSERVATION_CATEGORY_LABELS: Record<ObservationCategory, string> = {
  pole: "Pole/support",
  luminaire: "Luminaire",
  uncertain: "Other/uncertain",
};

export type ObservationDecision = "pending" | "accepted" | "rejected" | "deferred";

export const OBSERVATION_DECISION_LABELS: Record<ObservationDecision, string> = {
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  deferred: "Deferred",
};

/** How an observation entered the session. Demo fixtures never leave demo mode. */
export type ObservationOrigin = "demo" | "manual" | "sam-text" | "sam-assisted";

export const OBSERVATION_ORIGIN_LABELS: Record<ObservationOrigin, string> = {
  demo: "Demo",
  manual: "Manual",
  "sam-text": "SAM text",
  "sam-assisted": "SAM assisted",
};

/**
 * Where the session's street label comes from. Only `osm` is a real
 * OpenStreetMap street; work areas stay explicitly unverified everywhere.
 */
export type StreetSource = "osm" | "manual-work-area" | "synthetic-demo";

export const STREET_SOURCE_LABELS: Record<StreetSource, string> = {
  osm: "OpenStreetMap street",
  "manual-work-area": "Manual work area — street unverified",
  "synthetic-demo": "Synthetic demo",
};

/**
 * Normalized image coordinates: fractions (0..1) of the underlying static
 * raster (illustration or decoded photograph), never CSS pixels.
 */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Model provenance for SAM-produced observations. Null for demo/manual. */
export interface ObservationProvenance {
  provider: "meta-sam";
  model: string;
  /** Exact concept text sent to the model. */
  prompt: string;
  categoryIntent: AssetCategory | "uncertain";
  runId: string;
  requestId: string;
  /** Provider object ID: local to its request, not a global pole identity. */
  providerObjectId: string;
  confidence: number | null;
  geometrySource: "model" | "manual-adjusted";
}

/**
 * Model mask: an SVG path in its own raster space (width × height) plus the
 * half-open inference-pixel bounds that raster covers. Renderers nest the
 * path under its bounds; no path surgery needed.
 */
export interface ObservationMask {
  svgPath: string;
  width: number;
  height: number;
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface InventoryObservation {
  id: string;
  imageId: string;
  /** Inference view this sighting belongs to; null for demo fixtures. */
  viewId: string | null;
  category: ObservationCategory;
  description: string;
  imageRegion: NormalizedRect | null;
  /** Model mask; null when the model sent none. */
  mask: ObservationMask | null;
  /** True once a manual edit moved the annotation off the model geometry. */
  maskStale: boolean;
  origin: ObservationOrigin;
  provenance: ObservationProvenance | null;
  mode: InventoryMode;
  decision: ObservationDecision;
  note: string;
}

export type SupportLink =
  | { kind: "pole"; poleAssetId: string }
  | { kind: "wall" }
  | { kind: "suspended" }
  | { kind: "unknown" };

export const SUPPORT_LINK_LABELS: Record<SupportLink["kind"], string> = {
  pole: "Pole/support",
  wall: "Wall-mounted",
  suspended: "Suspended",
  unknown: "Support unknown",
};

/**
 * Discriminated placement. Diagram coordinates (0..100 schematic units) must
 * never reach geographic functions; geographic placements are WGS84.
 */
export type AssetPlacement =
  | { kind: "geographic"; lng: number; lat: number }
  | { kind: "diagram"; x: number; y: number }
  | { kind: "inherited" }
  | { kind: "unknown"; explicit: boolean };

export interface InventoryAsset {
  id: string;
  category: AssetCategory;
  observationIds: string[];
  confirmed: boolean;
  /** Luminaires only; pole assets always carry null. */
  support: SupportLink | null;
  placement: AssetPlacement;
  mode: InventoryMode;
  streetSource: StreetSource;
  note: string;
}

/** One Mapillary photograph chosen as evidence (metadata, not pixels). */
export interface SourceImage {
  imageId: string;
  sequenceId: string | null;
  capturedAt: number | null;
  isPano: boolean | null;
  attribution: string;
  sourceUrl: string;
  /** Camera position, explicitly typed: never an asset location. */
  cameraPosition: { lng: number; lat: number } | null;
  resolution: string;
}

/**
 * One immutable inference view: a whole photograph or a recorded crop of it.
 * Dimensions are decoded display pixels (EXIF orientation applied) — the
 * exact raster sent to the model.
 */
export interface SourceView {
  viewId: string;
  imageId: string;
  fullWidth: number;
  fullHeight: number;
  /** EXIF orientation 1..8 recorded at decode; 1 means no rotation. */
  orientation: number;
  isPano: boolean;
  /** Fraction of the full image, or null for the whole photograph. */
  crop: NormalizedRect | null;
  /** Actual inference raster dimensions in pixels. */
  width: number;
  height: number;
  mediaHandle: string;
  fullyReviewed: boolean;
}

/** Frozen per-session source selection. Changes require an explicit restart. */
export interface SourceManifest {
  imageIds: string[];
  viewIds: string[];
  chosenAt: string;
  acked: boolean;
  samplingNote: string | null;
}

/** One editable text concept with its category mapping. */
export interface ConceptPrompt {
  id: string;
  text: string;
  categoryIntent: AssetCategory;
  enabled: boolean;
}

export const DEFAULT_CONCEPTS: ConceptPrompt[] = [
  { id: "concept-pole", text: "street light pole", categoryIntent: "pole", enabled: true },
  { id: "concept-fixture", text: "street light fixture", categoryIntent: "luminaire", enabled: true },
];

/** Hard cap on inference views per run, crops included. */
export const MAX_VIEWS_PER_RUN = 10;
/** Suggested image count for a first selection. */
export const SUGGESTED_IMAGE_COUNT = 5;
/** Cap on chargeable model calls per batch (views × concepts). */
export const MAX_CALLS_PER_BATCH = 20;

export type DetectionItemStatus =
  | "queued"
  | "preparing"
  | "detecting"
  | "succeeded"
  | "empty"
  | "failed"
  | "cancelled";

export const DETECTION_ITEM_STATUS_LABELS: Record<DetectionItemStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  detecting: "Detecting",
  succeeded: "Succeeded",
  empty: "No matches",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** One parsed model object, normalized to the inference raster. */
export interface DetectionObject {
  providerObjectId: string;
  box: NormalizedRect;
  confidence: number | null;
  /** Model mask, or null when the model sent none. */
  mask: ObservationMask | null;
}

/** One view × concept inference: exactly one chargeable model call. */
export interface DetectionItem {
  itemId: string;
  requestId: string;
  viewId: string;
  conceptId: string;
  conceptText: string;
  categoryIntent: AssetCategory;
  status: DetectionItemStatus;
  objects: DetectionObject[];
  /** Actual model behind the result; null until a response arrives. */
  model: string | null;
  error: string | null;
  attempts: number;
  /** True once the result entered observations; blocks double imports. */
  imported: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DetectionRun {
  runId: string;
  kind: "test" | "batch";
  createdAt: string;
  finishedAt: string | null;
  cancelled: boolean;
  items: DetectionItem[];
}

/** Cap on retained run history per session (oldest finished runs drop off). */
export const MAX_RUNS_RETAINED = 5;

export type DetectionStatus =
  | { status: "idle" }
  | { status: "running"; runId: number; staged: number; total: number }
  | { status: "finished"; observationCount: number; empty: boolean; at: string }
  | { status: "failed"; message: string }
  | { status: "cancelled" };

export interface SessionContext {
  streetId: string;
  streetDisplayName: string;
  streetSource: StreetSource;
  /** Nulls mark the isolated demo context (no RoI, run, or fingerprint). */
  roiRevision: number | null;
  runId: string | null;
  fingerprint: string | null;
}

export interface WorkflowSession {
  key: string;
  sessionId: string;
  mode: InventoryMode;
  context: SessionContext;
  activeStep: WorkflowStep;
  detection: DetectionStatus;
  observations: Record<string, InventoryObservation>;
  assets: Record<string, InventoryAsset>;
  obsOrder: string[];
  assetOrder: string[];
  obsCounter: number;
  assetCounter: number;
  sources: Record<string, SourceImage>;
  views: Record<string, SourceView>;
  viewOrder: string[];
  manifest: SourceManifest | null;
  concepts: ConceptPrompt[];
  conceptCounter: number;
  runs: DetectionRun[];
  runCounter: number;
  /** Staged one-view test result awaiting import or discard. */
  stagedTest: { runId: string; itemId: string } | null;
  finishedPreview: SessionPreviewResult | null;
}

export interface SessionPreviewAsset {
  assetId: string;
  category: AssetCategory;
  support: SupportLink | null;
  position:
    | { kind: "geographic"; lng: number; lat: number }
    | { kind: "diagram"; x: number; y: number }
    | { kind: "inherited"; fromAssetId: string }
    | { kind: "unknown" };
  positionMethod: "manual" | "inherited" | "unknown";
  observationIds: string[];
  imageIds: string[];
  reviewState: "confirmed";
  streetSource: StreetSource;
  note: string;
}

export interface SessionPreviewProcessing {
  views: number;
  succeededViews: number;
  failedViews: number;
  unprocessedViews: number;
  concepts: string[];
}

export interface SessionPreviewResult {
  kind: "session-preview";
  mode: InventoryMode;
  sessionId: string;
  streetId: string;
  streetDisplayName: string;
  streetSource: StreetSource;
  origins: ObservationOrigin[];
  /** Model behind SAM evidence, or null for manual/demo-only previews. */
  model: string | null;
  processing: SessionPreviewProcessing;
  roiRevision: number | null;
  runId: string | null;
  fingerprint: string | null;
  finishedAt: string;
  assets: SessionPreviewAsset[];
  counts: {
    poles: number;
    luminaires: number;
    placed: number;
    unplaced: number;
    deferred: number;
    observations: number;
  };
  limitations: string[];
  temporary: true;
}

export interface SessionCounts {
  pending: number;
  accepted: number;
  rejected: number;
  deferred: number;
  assets: number;
  placed: number;
  unplaced: number;
  confirmed: number;
  unassignedAccepted: number;
  views: number;
}
