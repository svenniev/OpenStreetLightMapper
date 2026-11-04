import mongoose, { Schema } from "mongoose";
import { STORAGE_SCHEMA_VERSION } from "./validation.js";

/**
 * Automatic (headless) pipeline documents. These are additive and separate
 * from the manual session/item/result types: a background worker owns them
 * through atomic claim/complete transitions, and the UI only reads them
 * (plus launch/stop/resume on jobs).
 */

const Mixed = Schema.Types.Mixed;

function registered<T>(name: string): mongoose.Model<T> | undefined {
  return mongoose.models[name] as mongoose.Model<T> | undefined;
}

export type AutoJobStatus =
  | "queued"
  | "preparing"
  | "detecting"
  | "locating"
  | "publishing"
  | "completed"
  | "completed_with_gaps"
  | "stopped"
  | "interrupted"
  | "failed";

export interface AutoJobDocument {
  workspaceId: string;
  jobId: string;
  schemaVersion: number;
  status: AutoJobStatus;
  /** Launch idempotency key, unique per workspace. */
  idempotencyKey: string;
  /** Immutable resolved plan (sequences, images, concepts, anchor, budget). */
  plan: Record<string, unknown>;
  planHash: string;
  /** Model calls made (reservation counter; progress itself is derived). */
  callsMade: number;
  owner: string | null;
  leaseExpiresAt: Date | null;
  /** SAM model label resolved by the worker on first inference. */
  model: string | null;
  stopRequested: boolean;
  error: string | null;
  resultId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const autoJobSchema = new Schema<AutoJobDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    jobId: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    status: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    plan: { type: Mixed, required: true },
    planHash: { type: String, required: true },
    callsMade: { type: Number, required: true, default: 0 },
    owner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    model: { type: String, default: null },
    stopRequested: { type: Boolean, required: true, default: false },
    error: { type: String, default: null },
    resultId: { type: String, default: null },
  },
  { timestamps: true },
);

autoJobSchema.index({ workspaceId: 1, jobId: 1 }, { unique: true });
autoJobSchema.index({ workspaceId: 1, idempotencyKey: 1 }, { unique: true });
autoJobSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
autoJobSchema.index({ status: 1, leaseExpiresAt: 1, updatedAt: 1 });

export type AutoItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "empty"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AutoWorkItemDocument {
  workspaceId: string;
  jobId: string;
  itemId: string;
  schemaVersion: number;
  sequenceId: string;
  imageId: string;
  conceptId: string;
  prompt: string;
  category: string;
  status: AutoItemStatus;
  owner: string | null;
  leaseExpiresAt: Date | null;
  /** Prepared analysis view: dims, pixel chain, camera, pose, source bytes. */
  viewDescriptor: Record<string, unknown> | null;
  artifactId: mongoose.Types.ObjectId | null;
  observationIds: string[];
  attempts: number;
  error: string | null;
  providerRequestId: string | null;
  /**
   * True once a SAM call was sent for the current attempt. A running item
   * with callSent=false never called (safe to requeue); with callSent=true
   * the provider outcome is unknown (explicit retry only, never auto-issued).
   */
  callSent: boolean;
  /** Bounded SAM response digest (object count, warnings), set at completion. */
  response: Record<string, unknown> | null;
  registeredAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const autoWorkItemSchema = new Schema<AutoWorkItemDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    jobId: { type: String, required: true },
    itemId: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    sequenceId: { type: String, required: true },
    imageId: { type: String, required: true },
    conceptId: { type: String, required: true },
    prompt: { type: String, required: true },
    category: { type: String, required: true },
    status: { type: String, required: true },
    owner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    viewDescriptor: { type: Mixed, default: null },
    artifactId: { type: Schema.Types.ObjectId, default: null },
    observationIds: { type: [String], required: true, default: [] },
    attempts: { type: Number, required: true, default: 0 },
    error: { type: String, default: null },
    providerRequestId: { type: String, default: null },
    callSent: { type: Boolean, required: true, default: false },
    response: { type: Mixed, default: null },
    registeredAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

autoWorkItemSchema.index({ workspaceId: 1, jobId: 1, itemId: 1 }, { unique: true });
autoWorkItemSchema.index({ workspaceId: 1, jobId: 1, status: 1, leaseExpiresAt: 1 });
autoWorkItemSchema.index({ workspaceId: 1, jobId: 1, imageId: 1 });

export interface AutoObservationDocument {
  workspaceId: string;
  jobId: string;
  itemId: string;
  observationId: string;
  schemaVersion: number;
  imageId: string;
  conceptId: string;
  prompt: string;
  category: string;
  /** Normalized [x, y, w, h] detection box in the analysis view. */
  box: { x: number; y: number; w: number; h: number };
  confidence: number | null;
  /** Pixel anchor + margin/clamp bookkeeping, in analysis-view pixels. */
  anchor: Record<string, unknown>;
  maskSupport: Record<string, unknown> | null;
  /** World ray in job-local ENU, or null with a rayFailure reason. */
  ray: { origin: [number, number, number]; direction: [number, number, number] } | null;
  rayFailure: string | null;
  maskArtifactId: mongoose.Types.ObjectId | null;
  nearSeam: boolean;
  truncated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const autoObservationSchema = new Schema<AutoObservationDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    jobId: { type: String, required: true },
    itemId: { type: String, required: true },
    observationId: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    imageId: { type: String, required: true },
    conceptId: { type: String, required: true },
    prompt: { type: String, required: true },
    category: { type: String, required: true },
    box: { type: Mixed, required: true },
    confidence: { type: Number, default: null },
    anchor: { type: Mixed, required: true },
    maskSupport: { type: Mixed, default: null },
    ray: { type: Mixed, default: null },
    rayFailure: { type: String, default: null },
    maskArtifactId: { type: Schema.Types.ObjectId, default: null },
    nearSeam: { type: Boolean, required: true, default: false },
    truncated: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

autoObservationSchema.index({ workspaceId: 1, jobId: 1, observationId: 1 }, { unique: true });
autoObservationSchema.index({ workspaceId: 1, jobId: 1, imageId: 1 });
autoObservationSchema.index({ workspaceId: 1, jobId: 1, category: 1 });

export type AutoCandidateStatus = "candidate" | "located" | "needs-review" | "rejected";

export interface AutoCandidateDocument {
  workspaceId: string;
  jobId: string;
  candidateId: string;
  schemaVersion: number;
  kind: "pole" | "luminaire";
  status: AutoCandidateStatus;
  observationIds: string[];
  imageIds: string[];
  viewCount: number;
  /** Map position when located; null otherwise. Never a camera position. */
  position: {
    lng: number;
    lat: number;
    uncertaintyM: number;
    method: string;
  } | null;
  /** Triangulation diagnostics behind a located position. */
  fit: Record<string, unknown> | null;
  /** Luminaire -> supporting pole link (pole candidates list supporters). */
  poleCandidateId: string | null;
  luminaireCandidateIds: string[];
  /** Nearest unambiguous street, or null when unknown/ambiguous. */
  streetId: string | null;
  /** Machine-readable check outcomes and anomaly flags. */
  checks: string[];
  /** Conditional-update revision for association writes. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const autoCandidateSchema = new Schema<AutoCandidateDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    jobId: { type: String, required: true },
    candidateId: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    kind: { type: String, required: true },
    status: { type: String, required: true },
    observationIds: { type: [String], required: true, default: [] },
    imageIds: { type: [String], required: true, default: [] },
    viewCount: { type: Number, required: true, default: 0 },
    position: { type: Mixed, default: null },
    fit: { type: Mixed, default: null },
    poleCandidateId: { type: String, default: null },
    luminaireCandidateIds: { type: [String], required: true, default: [] },
    streetId: { type: String, default: null },
    checks: { type: [String], required: true, default: [] },
    revision: { type: Number, required: true, default: 1 },
  },
  { timestamps: true },
);

autoCandidateSchema.index({ workspaceId: 1, jobId: 1, candidateId: 1 }, { unique: true });
autoCandidateSchema.index({ workspaceId: 1, jobId: 1, status: 1 });
autoCandidateSchema.index({ workspaceId: 1, jobId: 1, kind: 1, status: 1 });

export type AutoResultStatus = "detection-complete" | "inventory-complete";

export interface AutoResultDocument {
  workspaceId: string;
  jobId: string;
  resultId: string;
  schemaVersion: number;
  /** Detection-only and positioned outcomes are labelled, never mixed. */
  status: AutoResultStatus;
  counts: Record<string, number>;
  locatedCandidateIds: string[];
  needsReviewCandidateIds: string[];
  unlocatedObservationIds: string[];
  /** Stable per-observation reason for every unlocated id above. */
  unlocatedReasons: Record<string, string>;
  thresholds: Record<string, unknown>;
  model: string | null;
  planHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const autoResultSchema = new Schema<AutoResultDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    jobId: { type: String, required: true },
    resultId: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    status: { type: String, required: true },
    counts: { type: Mixed, required: true },
    locatedCandidateIds: { type: [String], required: true, default: [] },
    needsReviewCandidateIds: { type: [String], required: true, default: [] },
    unlocatedObservationIds: { type: [String], required: true, default: [] },
    unlocatedReasons: { type: Mixed, required: true, default: {} },
    thresholds: { type: Mixed, required: true },
    model: { type: String, default: null },
    planHash: { type: String, required: true },
  },
  { timestamps: true },
);

// One published result per job.
autoResultSchema.index({ workspaceId: 1, jobId: 1 }, { unique: true });

export const AutoJobModel = (): mongoose.Model<AutoJobDocument> =>
  registered<AutoJobDocument>("AutoJob") ?? mongoose.model<AutoJobDocument>("AutoJob", autoJobSchema);
export const AutoWorkItemModel = (): mongoose.Model<AutoWorkItemDocument> =>
  registered<AutoWorkItemDocument>("AutoWorkItem") ??
  mongoose.model<AutoWorkItemDocument>("AutoWorkItem", autoWorkItemSchema);
export const AutoObservationModel = (): mongoose.Model<AutoObservationDocument> =>
  registered<AutoObservationDocument>("AutoObservation") ??
  mongoose.model<AutoObservationDocument>("AutoObservation", autoObservationSchema);
export const AutoCandidateModel = (): mongoose.Model<AutoCandidateDocument> =>
  registered<AutoCandidateDocument>("AutoCandidate") ??
  mongoose.model<AutoCandidateDocument>("AutoCandidate", autoCandidateSchema);
export const AutoResultModel = (): mongoose.Model<AutoResultDocument> =>
  registered<AutoResultDocument>("AutoResult") ??
  mongoose.model<AutoResultDocument>("AutoResult", autoResultSchema);
