import { requestJson } from "./api";

export const STORAGE_SCHEMA_VERSION = 1;

export type DbState = "connected" | "connecting" | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  revision: number;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

function validateWorkspaceList(body: unknown): { workspaces: WorkspaceSummary[] } | null {
  if (!isRecord(body) || !Array.isArray(body.workspaces)) return null;
  for (const entry of body.workspaces) {
    if (!isRecord(entry) || typeof entry.workspaceId !== "string") return null;
  }
  return body as { workspaces: WorkspaceSummary[] };
}

export interface StoredWorkspace {
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
  createdAt: string;
  updatedAt: string;
}

function validateStoredWorkspace(body: unknown): StoredWorkspace | null {
  if (!isRecord(body)) return null;
  if (typeof body.workspaceId !== "string") return null;
  if (body.schemaVersion !== STORAGE_SCHEMA_VERSION) return null;
  if (typeof body.name !== "string" || typeof body.revision !== "number") return null;
  if (!Array.isArray(body.sessionKeys)) return null;
  return body as unknown as StoredWorkspace;
}

function validateRevisionAck(body: unknown): { revision: number } | null {
  if (!isRecord(body) || typeof body.revision !== "number") return null;
  return { revision: body.revision };
}

export async function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  const response = await requestJson(
    "/api/workspaces",
    { what: "workspace list", signal },
    validateWorkspaceList,
  );
  return response.workspaces;
}

export async function createWorkspace(name: string, signal?: AbortSignal): Promise<StoredWorkspace> {
  return requestJson(
    "/api/workspaces",
    { method: "POST", payload: { name }, what: "workspace", signal },
    validateStoredWorkspace,
  );
}

export async function fetchWorkspace(workspaceId: string, signal?: AbortSignal): Promise<StoredWorkspace> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    { what: "workspace", signal },
    validateStoredWorkspace,
  );
}

export interface WorkspaceSaveInput {
  expectedRevision: number;
  workspace: Record<string, unknown>;
}

export async function saveWorkspace(
  workspaceId: string,
  input: WorkspaceSaveInput,
  signal?: AbortSignal,
): Promise<number> {
  const ack = await requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: "PUT", payload: input, what: "workspace save", signal },
    validateRevisionAck,
  );
  return ack.revision;
}

export interface StoredSnapshot {
  snapshotId: string;
  kind: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

function validateStoredSnapshot(body: unknown): StoredSnapshot | null {
  if (!isRecord(body) || typeof body.snapshotId !== "string") return null;
  if (!isRecord(body.payload)) return null;
  return body as unknown as StoredSnapshot;
}

export async function storeSnapshot(
  workspaceId: string,
  input: { snapshotId: string; kind: string; payload: unknown },
  signal?: AbortSignal,
): Promise<{ snapshotId: string; deduplicated: boolean }> {
  const response = await requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/snapshots`,
    {
      method: "POST",
      payload: { schemaVersion: STORAGE_SCHEMA_VERSION, ...input },
      what: "snapshot",
      signal,
    },
    (body) => {
      if (!isRecord(body) || typeof body.snapshotId !== "string") return null;
      return { snapshotId: body.snapshotId, deduplicated: body.deduplicated === true };
    },
  );
  return response;
}

export async function fetchSnapshot(
  workspaceId: string,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<StoredSnapshot> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/snapshots/${encodeURIComponent(snapshotId)}`,
    { what: "snapshot", signal },
    validateStoredSnapshot,
  );
}

export interface StoredSession {
  workspaceId: string;
  sessionKey: string;
  sessionId: string;
  schemaVersion: number;
  revision: number;
  session: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function validateStoredSession(body: unknown): StoredSession | null {
  if (!isRecord(body)) return null;
  if (typeof body.sessionKey !== "string" || typeof body.revision !== "number") return null;
  if (!isRecord(body.session)) return null;
  return body as unknown as StoredSession;
}

export async function fetchSession(
  workspaceId: string,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<StoredSession> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}`,
    { what: "session", signal },
    validateStoredSession,
  );
}

export async function saveSession(
  workspaceId: string,
  sessionKey: string,
  input: { expectedRevision: number | null; session: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<number> {
  const ack = await requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}`,
    { method: "PUT", payload: input, what: "session save", signal },
    validateRevisionAck,
  );
  return ack.revision;
}

export interface SlimDetectionItem {
  runId: string;
  itemId: string;
  kind: string;
  viewId: string;
  conceptId: string;
  prompt: string;
  categoryIntent: string;
  model: string | null;
  artifactId: string;
  supersedes: string | null;
  status: string;
  objectCount: number;
  truncated: boolean;
  invalidDiscarded: number;
  attempts: number;
  error: string | null;
  providerRequestId: string | null;
  registeredAt: string;
  finishedAt: string | null;
}

export interface FullDetectionItem extends SlimDetectionItem {
  viewDescriptor: Record<string, unknown>;
  objects: Record<string, unknown>[];
}

function validateItemAck(body: unknown): { runId: string; itemId: string; status: string } | null {
  if (!isRecord(body)) return null;
  if (typeof body.runId !== "string" || typeof body.itemId !== "string" || typeof body.status !== "string") {
    return null;
  }
  return { runId: body.runId, itemId: body.itemId, status: body.status };
}

export async function registerDetectionItem(
  workspaceId: string,
  sessionKey: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ runId: string; itemId: string; status: string }> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/items`,
    {
      method: "POST",
      payload: { schemaVersion: STORAGE_SCHEMA_VERSION, ...input },
      what: "item registration",
      signal,
    },
    validateItemAck,
  );
}

export async function completeDetectionItem(
  workspaceId: string,
  sessionKey: string,
  runId: string,
  itemId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ runId: string; itemId: string; status: string }> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/items/${encodeURIComponent(runId)}/${encodeURIComponent(itemId)}/complete`,
    {
      method: "POST",
      payload: { schemaVersion: STORAGE_SCHEMA_VERSION, ...input },
      what: "item completion",
      signal,
    },
    validateItemAck,
  );
}

export async function interruptDetectionItem(
  workspaceId: string,
  sessionKey: string,
  runId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<{ runId: string; itemId: string; status: string }> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/items/${encodeURIComponent(runId)}/${encodeURIComponent(itemId)}/interrupt`,
    { method: "POST", payload: {}, what: "item interrupt", signal },
    validateItemAck,
  );
}

export async function listDetectionItems(
  workspaceId: string,
  sessionKey: string,
  options: { runId?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<{ items: SlimDetectionItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.runId) params.set("runId", options.runId);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/items${query}`,
    { what: "item list", signal },
    (body) => {
      if (!isRecord(body) || !Array.isArray(body.items)) return null;
      if (body.nextCursor !== null && typeof body.nextCursor !== "string") return null;
      return body as { items: SlimDetectionItem[]; nextCursor: string | null };
    },
  );
}

export async function fetchDetectionItem(
  workspaceId: string,
  sessionKey: string,
  runId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<FullDetectionItem> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/items/${encodeURIComponent(runId)}/${encodeURIComponent(itemId)}`,
    { what: "detection item", signal },
    (body) => {
      if (!isRecord(body) || !Array.isArray(body.objects)) return null;
      return body as unknown as FullDetectionItem;
    },
  );
}

export interface ArtifactMetaInput {
  contentHash: string;
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  byteLength: number;
  imageId: string;
  viewId: string | null;
  orientation: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  attribution: string;
  sourceUrl: string;
}

export async function uploadArtifact(
  meta: ArtifactMetaInput,
  dataBase64: string,
  signal?: AbortSignal,
): Promise<{ artifactId: string; deduplicated: boolean; byteLength: number }> {
  return requestJson(
    "/api/artifacts",
    {
      method: "POST",
      payload: { schemaVersion: STORAGE_SCHEMA_VERSION, meta, dataBase64 },
      what: "artifact upload",
      signal,
    },
    (body) => {
      if (!isRecord(body) || typeof body.artifactId !== "string") return null;
      return {
        artifactId: body.artifactId,
        deduplicated: body.deduplicated === true,
        byteLength: typeof body.byteLength === "number" ? body.byteLength : 0,
      };
    },
  );
}

export function artifactUrlFor(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}`;
}

export interface ResultSummary {
  resultId: string;
  sessionRevision: number;
  inputRevision: number | null;
  counts: Record<string, unknown>;
  createdAt: string;
}

export async function saveReviewedResult(
  workspaceId: string,
  sessionKey: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ resultId: string; deduplicated: boolean }> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/results`,
    {
      method: "POST",
      payload: { schemaVersion: STORAGE_SCHEMA_VERSION, ...input },
      what: "result save",
      signal,
    },
    (body) => {
      if (!isRecord(body) || typeof body.resultId !== "string") return null;
      return { resultId: body.resultId, deduplicated: body.deduplicated === true };
    },
  );
}

export async function listReviewedResults(
  workspaceId: string,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<ResultSummary[]> {
  const response = await requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/results`,
    { what: "result list", signal },
    (body) => {
      if (!isRecord(body) || !Array.isArray(body.results)) return null;
      return body as { results: ResultSummary[] };
    },
  );
  return response.results;
}

export interface StoredResult {
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
  createdAt: string;
}

export async function fetchReviewedResult(
  workspaceId: string,
  sessionKey: string,
  resultId: string,
  signal?: AbortSignal,
): Promise<StoredResult> {
  return requestJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/results/${encodeURIComponent(resultId)}`,
    { what: "reviewed result", signal },
    (body) => {
      if (!isRecord(body) || typeof body.resultId !== "string") return null;
      if (!isRecord(body.snapshot)) return null;
      return body as unknown as StoredResult;
    },
  );
}
