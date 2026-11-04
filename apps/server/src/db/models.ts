import mongoose, { Schema } from "mongoose";
import { STORAGE_SCHEMA_VERSION } from "./validation.js";

/**
 * Mongoose schemas for workspace persistence.
 *
 * Deep domain blobs (region snapshots, session state, parsed detections) are
 * validated at the route boundary (see validation.ts) and stored as Mixed so
 * one growing document never silently absorbs unbounded provider output;
 * top-level identity, revision, and timestamp fields stay queryable.
 */

const Mixed = Schema.Types.Mixed;

export interface WorkspaceDocument {
  workspaceId: string;
  schemaVersion: number;
  name: string;
  revision: number;
  roi: Record<string, unknown> | null;
  imagerySnapshotId: string | null;
  imagerySelection: Record<string, unknown>;
  streetSnapshotId: string | null;
  streetSelection: Record<string, unknown>;
  preparation: Record<string, unknown>;
  activeSessionKey: string | null;
  sessionKeys: string[];
  createdAt: Date;
  updatedAt: Date;
}

const workspaceSchema = new Schema<WorkspaceDocument>(
  {
    workspaceId: { type: String, required: true, unique: true, index: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    name: { type: String, required: true },
    revision: { type: Number, required: true },
    roi: { type: Mixed, default: null },
    imagerySnapshotId: { type: String, default: null },
    imagerySelection: { type: Mixed, required: true },
    streetSnapshotId: { type: String, default: null },
    streetSelection: { type: Mixed, required: true },
    preparation: { type: Mixed, required: true },
    activeSessionKey: { type: String, default: null },
    sessionKeys: { type: [String], required: true },
  },
  { timestamps: true },
);

export interface InputSnapshotDocument {
  snapshotId: string;
  workspaceId: string;
  kind: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  byteLength: number;
  createdAt: Date;
  updatedAt: Date;
}

const inputSnapshotSchema = new Schema<InputSnapshotDocument>(
  {
    snapshotId: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    payload: { type: Mixed, required: true },
    byteLength: { type: Number, required: true },
  },
  { timestamps: true },
);

export interface InventorySessionDocument {
  workspaceId: string;
  sessionKey: string;
  sessionId: string;
  schemaVersion: number;
  revision: number;
  mode: string;
  context: Record<string, unknown>;
  activeStep: string;
  detection: Record<string, unknown>;
  observations: Record<string, unknown>;
  assets: Record<string, unknown>;
  obsOrder: string[];
  assetOrder: string[];
  obsCounter: number;
  assetCounter: number;
  sources: Record<string, unknown>;
  views: Record<string, unknown>;
  viewOrder: string[];
  manifest: Record<string, unknown> | null;
  concepts: Record<string, unknown>[];
  conceptCounter: number;
  runs: Record<string, unknown>[];
  runCounter: number;
  stagedTest: Record<string, unknown> | null;
  finishedPreview: Record<string, unknown> | null;
  savedResultRefs: Record<string, unknown>[];
  draftAfterResult: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const inventorySessionSchema = new Schema<InventorySessionDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    sessionKey: { type: String, required: true },
    sessionId: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    revision: { type: Number, required: true },
    mode: { type: String, required: true },
    context: { type: Mixed, required: true },
    activeStep: { type: String, required: true },
    detection: { type: Mixed, required: true },
    observations: { type: Mixed, required: true },
    assets: { type: Mixed, required: true },
    obsOrder: { type: [String], required: true },
    assetOrder: { type: [String], required: true },
    obsCounter: { type: Number, required: true },
    assetCounter: { type: Number, required: true },
    sources: { type: Mixed, required: true },
    views: { type: Mixed, required: true },
    viewOrder: { type: [String], required: true },
    manifest: { type: Mixed, default: null },
    concepts: [Mixed],
    conceptCounter: { type: Number, required: true },
    runs: [Mixed],
    runCounter: { type: Number, required: true },
    stagedTest: { type: Mixed, default: null },
    finishedPreview: { type: Mixed, default: null },
    savedResultRefs: [Mixed],
    draftAfterResult: { type: Boolean, required: true },
  },
  { timestamps: true },
);
inventorySessionSchema.index({ workspaceId: 1, sessionKey: 1 }, { unique: true });

export interface DetectionItemDocument {
  workspaceId: string;
  sessionKey: string;
  runId: string;
  itemId: string;
  kind: string;
  schemaVersion: number;
  viewId: string;
  conceptId: string;
  prompt: string;
  categoryIntent: string;
  model: string | null;
  viewDescriptor: Record<string, unknown>;
  artifactId: string;
  supersedes: string | null;
  status: string;
  /** Worker/tab that claimed the item, if any; null means unclaimed. */
  owner: string | null;
  /** Claim expiry; a claim with a past expiry may be taken over. */
  leaseExpiresAt: Date | null;
  objects: Record<string, unknown>[];
  truncated: boolean;
  invalidDiscarded: number;
  attempts: number;
  error: string | null;
  providerRequestId: string | null;
  registeredAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const detectionItemSchema = new Schema<DetectionItemDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    sessionKey: { type: String, required: true, index: true },
    runId: { type: String, required: true },
    itemId: { type: String, required: true },
    kind: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    viewId: { type: String, required: true },
    conceptId: { type: String, required: true },
    prompt: { type: String, required: true },
    categoryIntent: { type: String, required: true },
    model: { type: String, default: null },
    viewDescriptor: { type: Mixed, required: true },
    artifactId: { type: String, required: true, index: true },
    supersedes: { type: String, default: null },
    status: { type: String, required: true },
    owner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    objects: [Mixed],
    truncated: { type: Boolean, required: true },
    invalidDiscarded: { type: Number, required: true },
    attempts: { type: Number, required: true },
    error: { type: String, default: null },
    providerRequestId: { type: String, default: null },
    registeredAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
detectionItemSchema.index({ workspaceId: 1, sessionKey: 1, runId: 1, itemId: 1 }, { unique: true });
detectionItemSchema.index({ workspaceId: 1, sessionKey: 1, registeredAt: -1 });
detectionItemSchema.index({ workspaceId: 1, sessionKey: 1, status: 1, leaseExpiresAt: 1 });

export interface InventoryResultDocument {
  resultId: string;
  workspaceId: string;
  sessionKey: string;
  schemaVersion: number;
  sessionRevision: number;
  inputRevision: number | null;
  counts: Record<string, unknown>;
  limitations: string[];
  provenance: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  artifactIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const inventoryResultSchema = new Schema<InventoryResultDocument>(
  {
    resultId: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    sessionKey: { type: String, required: true, index: true },
    schemaVersion: { type: Number, required: true, default: STORAGE_SCHEMA_VERSION },
    sessionRevision: { type: Number, required: true },
    inputRevision: { type: Number, default: null },
    counts: { type: Mixed, required: true },
    limitations: { type: [String], required: true },
    provenance: { type: Mixed, required: true },
    snapshot: { type: Mixed, required: true },
    artifactIds: { type: [String], required: true },
  },
  { timestamps: true },
);
inventoryResultSchema.index({ workspaceId: 1, sessionKey: 1, createdAt: -1 });

/**
 * Per-model registration (deliberately not a generic helper: passing a
 * loosely-typed Schema through a generic factory sends tsc into unbounded
 * inference and exhausts the heap).
 */
function registered<T>(name: string): mongoose.Model<T> | undefined {
  return mongoose.models[name] as mongoose.Model<T> | undefined;
}

export const WorkspaceModel = (): mongoose.Model<WorkspaceDocument> =>
  registered<WorkspaceDocument>("Workspace") ?? mongoose.model<WorkspaceDocument>("Workspace", workspaceSchema);
export const InputSnapshotModel = (): mongoose.Model<InputSnapshotDocument> =>
  registered<InputSnapshotDocument>("InputSnapshot") ??
  mongoose.model<InputSnapshotDocument>("InputSnapshot", inputSnapshotSchema);
export const InventorySessionModel = (): mongoose.Model<InventorySessionDocument> =>
  registered<InventorySessionDocument>("InventorySession") ??
  mongoose.model<InventorySessionDocument>("InventorySession", inventorySessionSchema);
export const DetectionItemModel = (): mongoose.Model<DetectionItemDocument> =>
  registered<DetectionItemDocument>("DetectionItem") ??
  mongoose.model<DetectionItemDocument>("DetectionItem", detectionItemSchema);
export const InventoryResultModel = (): mongoose.Model<InventoryResultDocument> =>
  registered<InventoryResultDocument>("InventoryResult") ??
  mongoose.model<InventoryResultDocument>("InventoryResult", inventoryResultSchema);
