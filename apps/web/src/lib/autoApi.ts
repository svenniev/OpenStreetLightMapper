import { requestJson } from "./api";

/**
 * Typed client for the automatic-mapping routes. Validators stay total:
 * anything unexpected becomes an ApiError(BAD_RESPONSE), never a crash.
 */

export interface AutoPrepareCounts {
  totalImages: number;
  eligibleImages: number;
  detectionOnlyImages: number;
  missingMetadataImages: number;
  panoImages: number;
  perspectiveImages: number;
  unknownCameraImages: number;
}

export interface AutoPrepareSequence {
  sequenceId: string;
  imageCount: number;
  eligibleCount: number;
}

export interface AutoPrepareResponse {
  prepareSnapshotId: string;
  planHash: string;
  mode: "detect" | "locate";
  totalImages: number;
  estimatedCalls: number;
  minSpacingM: number;
  excludedOutsideRoi: number;
  thinnedBySpacing: number;
  counts: AutoPrepareCounts;
  warnings: string[];
  perSequence: AutoPrepareSequence[];
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

export interface AutoJobSummary {
  jobId: string;
  status: AutoJobStatus;
  mode: "detect" | "locate";
  totalImages: number;
  estimatedCalls: number;
  callsMade: number;
  stopRequested: boolean;
  model: string | null;
  error: string | null;
  resultId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoJobProgress {
  totalItems: number;
  queuedItems: number;
  runningItems: number;
  doneItems: number;
  failedItems: number;
  haltedItems: number;
  observationCount: number;
  locatedCount: number;
  callsMade: number;
}

export interface AutoJobDetail {
  job: AutoJobSummary & {
    plan: {
      sequenceIds: string[];
      imageIds: string[];
      concepts: { conceptId: string; text: string; category: "pole" | "luminaire" }[];
      perSequence: { sequenceId: string; imageIds: string[] }[];
    };
  };
  progress: AutoJobProgress | null;
}

export type AutoItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "empty"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AutoWorkItem {
  itemId: string;
  sequenceId: string;
  imageId: string;
  conceptId: string;
  category: "pole" | "luminaire";
  status: AutoItemStatus;
  attempts: number;
  error: string | null;
  artifactId: string | null;
  observationIds: string[];
  callSent: boolean;
  finishedAt: string | null;
}

export interface AutoObservationSummary {
  observationId: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number | null;
  anchor: { method: string; uPx: number; vPx: number } | null;
  ray: { origin: [number, number, number]; direction: [number, number, number] } | null;
  rayFailure: string | null;
  truncated: boolean;
}

export type AutoCandidateStatus = "candidate" | "located" | "needs-review" | "rejected";

export interface AutoCandidateSummary {
  candidateId: string;
  category: "pole" | "luminaire";
  status: AutoCandidateStatus;
  position: { lng: number; lat: number; uncertaintyM: number; method: string } | null;
  observationIds: string[];
  imageIds: string[];
  sequenceIds: string[];
  unlocatedReason: string | null;
  supportId: string | null;
  streetId: string | null;
  flags: string[];
}

export interface AutoResultSummary {
  resultId: string;
  status: "detection-complete" | "inventory-complete";
  counts: Record<string, number>;
  limitations: string[];
  createdAt: string;
}

export interface AutoEvidenceImage {
  imageId: string;
  viewArtifactId: string | null;
  width: number | null;
  height: number | null;
}

export interface AutoEvidenceObservation {
  observationId: string;
  imageId: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number | null;
  anchor: { uPx: number; vPx: number } | null;
  maskArtifactId: string | null;
  /** Mask placement in analysis-view pixels (masks are cropped rasters, not view-sized). */
  maskBounds: { left: number; top: number; right: number; bottom: number } | null;
}

export interface AutoCandidateEvidence {
  candidateId: string;
  truncated: boolean;
  images: AutoEvidenceImage[];
  observations: AutoEvidenceObservation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry): entry is string => typeof entry === "string")) return null;
  return value;
}

const JOB_STATUSES: AutoJobStatus[] = [
  "queued",
  "preparing",
  "detecting",
  "locating",
  "publishing",
  "completed",
  "completed_with_gaps",
  "stopped",
  "interrupted",
  "failed",
];

const ITEM_STATUSES: AutoItemStatus[] = [
  "queued",
  "running",
  "succeeded",
  "empty",
  "failed",
  "cancelled",
  "interrupted",
];

const CANDIDATE_STATUSES: AutoCandidateStatus[] = ["candidate", "located", "needs-review", "rejected"];

function checkCounts(value: unknown): AutoPrepareCounts | null {
  if (!isRecord(value)) return null;
  const fields = [
    "totalImages",
    "eligibleImages",
    "detectionOnlyImages",
    "missingMetadataImages",
    "panoImages",
    "perspectiveImages",
    "unknownCameraImages",
  ] as const;
  const counts: Record<string, number> = {};
  for (const field of fields) {
    const parsed = asNumber(value[field]);
    if (parsed === null) return null;
    counts[field] = parsed;
  }
  return counts as unknown as AutoPrepareCounts;
}

function checkPrepare(body: unknown): AutoPrepareResponse | null {
  if (!isRecord(body)) return null;
  if (body.mode !== "detect" && body.mode !== "locate") return null;
  const prepareSnapshotId = asString(body.prepareSnapshotId);
  const planHash = asString(body.planHash);
  const totalImages = asNumber(body.totalImages);
  const estimatedCalls = asNumber(body.estimatedCalls);
  const minSpacingM = asNumber(body.minSpacingM);
  const excludedOutsideRoi = asNumber(body.excludedOutsideRoi);
  const thinnedBySpacing = asNumber(body.thinnedBySpacing);
  const counts = checkCounts(body.counts);
  const warnings = asStringArray(body.warnings);
  if (
    !prepareSnapshotId ||
    !planHash ||
    totalImages === null ||
    estimatedCalls === null ||
    minSpacingM === null ||
    excludedOutsideRoi === null ||
    thinnedBySpacing === null ||
    !counts ||
    !warnings
  ) {
    return null;
  }
  if (!Array.isArray(body.perSequence)) return null;
  const perSequence: AutoPrepareSequence[] = [];
  for (const entry of body.perSequence) {
    if (!isRecord(entry)) return null;
    const sequenceId = asString(entry.sequenceId);
    const imageCount = asNumber(entry.imageCount);
    const eligibleCount = asNumber(entry.eligibleCount);
    if (!sequenceId || imageCount === null || eligibleCount === null) return null;
    perSequence.push({ sequenceId, imageCount, eligibleCount });
  }
  return {
    prepareSnapshotId,
    planHash,
    mode: body.mode,
    totalImages,
    estimatedCalls,
    minSpacingM,
    excludedOutsideRoi,
    thinnedBySpacing,
    counts,
    warnings,
    perSequence,
  };
}

function checkJobSummary(value: unknown): AutoJobSummary | null {
  if (!isRecord(value)) return null;
  if (!JOB_STATUSES.includes(value.status as AutoJobStatus)) return null;
  if (value.mode !== "detect" && value.mode !== "locate") return null;
  const jobId = asString(value.jobId);
  const totalImages = asNumber(value.totalImages);
  const estimatedCalls = asNumber(value.estimatedCalls);
  const callsMade = asNumber(value.callsMade);
  const createdAt = asString(value.createdAt);
  const updatedAt = asString(value.updatedAt);
  if (!jobId || totalImages === null || estimatedCalls === null || callsMade === null || !createdAt || !updatedAt) {
    return null;
  }
  return {
    jobId,
    status: value.status as AutoJobStatus,
    mode: value.mode,
    totalImages,
    estimatedCalls,
    callsMade,
    stopRequested: value.stopRequested === true,
    model: asString(value.model),
    error: asString(value.error),
    resultId: asString(value.resultId),
    createdAt,
    updatedAt,
  };
}

function checkProgress(value: unknown): AutoJobProgress | null {
  if (!isRecord(value)) return null;
  const fields = [
    "totalItems",
    "queuedItems",
    "runningItems",
    "doneItems",
    "failedItems",
    "haltedItems",
    "observationCount",
    "locatedCount",
    "callsMade",
  ] as const;
  const progress: Record<string, number> = {};
  for (const field of fields) {
    const parsed = asNumber(value[field]);
    if (parsed === null) return null;
    progress[field] = parsed;
  }
  return progress as unknown as AutoJobProgress;
}

function checkJobDetail(body: unknown): AutoJobDetail | null {
  if (!isRecord(body) || !isRecord(body.job)) return null;
  const summary = checkJobSummary(body.job);
  if (!summary) return null;
  const plan = body.job.plan;
  if (!isRecord(plan)) return null;
  const sequenceIds = asStringArray(plan.sequenceIds);
  const imageIds = asStringArray(plan.imageIds);
  if (!sequenceIds || !imageIds) return null;
  if (!Array.isArray(plan.concepts) || !Array.isArray(plan.perSequence)) return null;
  const concepts: AutoJobDetail["job"]["plan"]["concepts"] = [];
  for (const entry of plan.concepts) {
    if (!isRecord(entry)) return null;
    const conceptId = asString(entry.conceptId);
    const text = asString(entry.text);
    if (!conceptId || !text || (entry.category !== "pole" && entry.category !== "luminaire")) return null;
    concepts.push({ conceptId, text, category: entry.category });
  }
  const perSequence: AutoJobDetail["job"]["plan"]["perSequence"] = [];
  for (const entry of plan.perSequence) {
    if (!isRecord(entry)) return null;
    const sequenceId = asString(entry.sequenceId);
    const groupIds = asStringArray(entry.imageIds);
    if (!sequenceId || !groupIds) return null;
    perSequence.push({ sequenceId, imageIds: groupIds });
  }
  const progress = body.progress === null ? null : checkProgress(body.progress);
  if (body.progress !== null && !progress) return null;
  return { job: { ...summary, plan: { sequenceIds, imageIds, concepts, perSequence } }, progress };
}

function checkItem(value: unknown): AutoWorkItem | null {
  if (!isRecord(value)) return null;
  if (!ITEM_STATUSES.includes(value.status as AutoItemStatus)) return null;
  if (value.category !== "pole" && value.category !== "luminaire") return null;
  const itemId = asString(value.itemId);
  const sequenceId = asString(value.sequenceId);
  const imageId = asString(value.imageId);
  const conceptId = asString(value.conceptId);
  const attempts = asNumber(value.attempts);
  const observationIds = asStringArray(value.observationIds);
  if (!itemId || !sequenceId || !imageId || !conceptId || attempts === null || !observationIds) return null;
  return {
    itemId,
    sequenceId,
    imageId,
    conceptId,
    category: value.category,
    status: value.status as AutoItemStatus,
    attempts,
    error: asString(value.error),
    artifactId: asString(value.artifactId),
    observationIds,
    callSent: value.callSent === true,
    finishedAt: asString(value.finishedAt),
  };
}

function checkObservation(value: unknown): AutoObservationSummary | null {
  if (!isRecord(value)) return null;
  const observationId = asString(value.observationId);
  if (!observationId || !isRecord(value.box)) return null;
  const x = asNumber(value.box.x);
  const y = asNumber(value.box.y);
  const w = asNumber(value.box.w);
  const h = asNumber(value.box.h);
  if (x === null || y === null || w === null || h === null) return null;
  let anchor: AutoObservationSummary["anchor"] = null;
  if (isRecord(value.anchor)) {
    const method = asString(value.anchor.method);
    const uPx = asNumber(value.anchor.uPx);
    const vPx = asNumber(value.anchor.vPx);
    if (!method || uPx === null || vPx === null) return null;
    anchor = { method, uPx, vPx };
  }
  let ray: AutoObservationSummary["ray"] = null;
  if (isRecord(value.ray) && Array.isArray(value.ray.origin) && Array.isArray(value.ray.direction)) {
    const origin = value.ray.origin as unknown[];
    const direction = value.ray.direction as unknown[];
    if (
      origin.length !== 3 ||
      direction.length !== 3 ||
      [...origin, ...direction].some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      return null;
    }
    ray = {
      origin: origin as [number, number, number],
      direction: direction as [number, number, number],
    };
  }
  return {
    observationId,
    box: { x, y, w, h },
    confidence: typeof value.confidence === "number" ? value.confidence : null,
    anchor,
    ray,
    rayFailure: asString(value.rayFailure),
    truncated: value.truncated === true,
  };
}

function checkCandidate(value: unknown): AutoCandidateSummary | null {
  if (!isRecord(value)) return null;
  if (!CANDIDATE_STATUSES.includes(value.status as AutoCandidateStatus)) return null;
  // Stored field names: kind (not category), checks (not flags),
  // poleCandidateId (not supportId), fit.unresolvedReason (not
  // unlocatedReason). Sequence ids are joined client-side from the job plan.
  if (value.kind !== "pole" && value.kind !== "luminaire") return null;
  const candidateId = asString(value.candidateId);
  const observationIds = asStringArray(value.observationIds);
  const imageIds = asStringArray(value.imageIds);
  if (!candidateId || !observationIds || !imageIds) return null;
  let position: AutoCandidateSummary["position"] = null;
  if (isRecord(value.position)) {
    const lng = asNumber(value.position.lng);
    const lat = asNumber(value.position.lat);
    const uncertaintyM = asNumber(value.position.uncertaintyM);
    const method = asString(value.position.method);
    if (lng === null || lat === null || uncertaintyM === null || !method) return null;
    position = { lng, lat, uncertaintyM, method };
  }
  const fit = isRecord(value.fit) ? value.fit : null;
  return {
    candidateId,
    category: value.kind,
    status: value.status as AutoCandidateStatus,
    position,
    observationIds,
    imageIds,
    sequenceIds: asStringArray(value.sequenceIds) ?? [],
    unlocatedReason: fit ? asString(fit.unresolvedReason) : null,
    supportId: asString(value.poleCandidateId),
    streetId: asString(value.streetId),
    flags: asStringArray(value.checks) ?? [],
  };
}

function checkResult(body: unknown): AutoResultSummary | null {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  const result = body.result;
  if (result.status !== "detection-complete" && result.status !== "inventory-complete") return null;
  const resultId = asString(result.resultId);
  const createdAt = asString(result.createdAt);
  // Limitations are derived server-side at read time; older responses omit them.
  const limitations = asStringArray(result.limitations) ?? [];
  if (!resultId || !createdAt || !isRecord(result.counts)) return null;
  const counts: Record<string, number> = {};
  for (const [key, entry] of Object.entries(result.counts)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    counts[key] = entry;
  }
  return { resultId, status: result.status, counts, limitations, createdAt };
}

export interface PrepareAutoRunInput {
  mode: "detect" | "locate";
  snapshotId: string;
  streetSnapshotId: string | null;
  sequenceIds: string[];
  concepts: { conceptId: string; text: string; category: "pole" | "luminaire" }[];
  maxImages?: number;
  maxCalls?: number;
  minSpacingM?: number;
}

export async function prepareAutoRun(
  workspaceId: string,
  input: PrepareAutoRunInput,
  signal?: AbortSignal,
): Promise<AutoPrepareResponse> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/prepare`,
    { method: "POST", payload: input, signal, what: "auto prepare" },
    checkPrepare,
  );
}

export async function launchAutoJob(
  workspaceId: string,
  input: { prepareSnapshotId: string; idempotencyKey: string },
  signal?: AbortSignal,
): Promise<{ jobId: string; status: AutoJobStatus; deduplicated: boolean }> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs`,
    { method: "POST", payload: input, signal, what: "auto launch" },
    (body) => {
      if (!isRecord(body)) return null;
      const jobId = asString(body.jobId);
      if (!jobId || !JOB_STATUSES.includes(body.status as AutoJobStatus)) return null;
      return { jobId, status: body.status as AutoJobStatus, deduplicated: body.deduplicated === true };
    },
  );
}

export async function listAutoJobs(workspaceId: string, signal?: AbortSignal): Promise<AutoJobSummary[]> {
  return requestJson(`/api/workspaces/${workspaceId}/auto/jobs`, { signal, what: "auto jobs" }, (body) => {
    if (!isRecord(body) || !Array.isArray(body.jobs)) return null;
    const jobs: AutoJobSummary[] = [];
    for (const entry of body.jobs) {
      const parsed = checkJobSummary(entry);
      if (!parsed) return null;
      jobs.push(parsed);
    }
    return jobs;
  });
}

export async function getAutoJob(
  workspaceId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<AutoJobDetail> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}`,
    { signal, what: "auto job" },
    checkJobDetail,
  );
}

export async function listAutoItems(
  workspaceId: string,
  jobId: string,
  query: { status?: AutoItemStatus; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AutoWorkItem[]> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/items${suffix}`,
    { signal, what: "auto items" },
    (body) => {
      if (!isRecord(body) || !Array.isArray(body.items)) return null;
      const items: AutoWorkItem[] = [];
      for (const entry of body.items) {
        const parsed = checkItem(entry);
        if (!parsed) return null;
        items.push(parsed);
      }
      return items;
    },
  );
}

export async function listAutoObservations(
  workspaceId: string,
  jobId: string,
  query: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AutoObservationSummary[]> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/observations${suffix}`,
    { signal, what: "auto observations" },
    (body) => {
      if (!isRecord(body) || !Array.isArray(body.observations)) return null;
      const observations: AutoObservationSummary[] = [];
      for (const entry of body.observations) {
        const parsed = checkObservation(entry);
        if (!parsed) return null;
        observations.push(parsed);
      }
      return observations;
    },
  );
}

export async function listAutoCandidates(
  workspaceId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<AutoCandidateSummary[]> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/candidates`,
    { signal, what: "auto candidates" },
    (body) => {
      if (!isRecord(body) || !Array.isArray(body.candidates)) return null;
      const candidates: AutoCandidateSummary[] = [];
      for (const entry of body.candidates) {
        const parsed = checkCandidate(entry);
        if (!parsed) return null;
        candidates.push(parsed);
      }
      return candidates;
    },
  );
}

function checkEvidence(body: unknown): AutoCandidateEvidence | null {
  if (!isRecord(body)) return null;
  const candidateId = asString(body.candidateId);
  if (!candidateId || !Array.isArray(body.images) || !Array.isArray(body.observations)) return null;
  const images: AutoEvidenceImage[] = [];
  for (const entry of body.images) {
    if (!isRecord(entry)) return null;
    const imageId = asString(entry.imageId);
    if (!imageId) return null;
    images.push({
      imageId,
      viewArtifactId: asString(entry.viewArtifactId),
      width: asNumber(entry.width),
      height: asNumber(entry.height),
    });
  }
  const observations: AutoEvidenceObservation[] = [];
  for (const entry of body.observations) {
    if (!isRecord(entry) || !isRecord(entry.box)) return null;
    const observationId = asString(entry.observationId);
    const imageId = asString(entry.imageId);
    const x = asNumber(entry.box.x);
    const y = asNumber(entry.box.y);
    const w = asNumber(entry.box.w);
    const h = asNumber(entry.box.h);
    if (!observationId || !imageId || x === null || y === null || w === null || h === null) return null;
    let anchor: AutoEvidenceObservation["anchor"] = null;
    if (isRecord(entry.anchor)) {
      const uPx = asNumber(entry.anchor.uPx);
      const vPx = asNumber(entry.anchor.vPx);
      if (uPx === null || vPx === null) return null;
      anchor = { uPx, vPx };
    }
    let maskBounds: AutoEvidenceObservation["maskBounds"] = null;
    if (isRecord(entry.maskBounds)) {
      const left = asNumber(entry.maskBounds.left);
      const top = asNumber(entry.maskBounds.top);
      const right = asNumber(entry.maskBounds.right);
      const bottom = asNumber(entry.maskBounds.bottom);
      if (left === null || top === null || right === null || bottom === null) return null;
      maskBounds = { left, top, right, bottom };
    }
    observations.push({
      observationId,
      imageId,
      box: { x, y, w, h },
      confidence: typeof entry.confidence === "number" ? entry.confidence : null,
      anchor,
      maskArtifactId: asString(entry.maskArtifactId),
      maskBounds,
    });
  }
  return { candidateId, truncated: body.truncated === true, images, observations };
}

export async function getAutoCandidateEvidence(
  workspaceId: string,
  jobId: string,
  candidateId: string,
  signal?: AbortSignal,
): Promise<AutoCandidateEvidence> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/candidates/${candidateId}/evidence`,
    { signal, what: "auto evidence" },
    checkEvidence,
  );
}

export async function getAutoResult(
  workspaceId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<AutoResultSummary> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/result`,
    { signal, what: "auto result" },
    checkResult,
  );
}

export async function stopAutoJob(
  workspaceId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<{ status: AutoJobStatus; stopped: boolean }> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/stop`,
    { method: "POST", payload: {}, signal, what: "auto stop" },
    (body) => {
      if (!isRecord(body) || !JOB_STATUSES.includes(body.status as AutoJobStatus)) return null;
      return { status: body.status as AutoJobStatus, stopped: body.stopped === true };
    },
  );
}

export async function resumeAutoJob(
  workspaceId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<{ status: AutoJobStatus }> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/resume`,
    { method: "POST", payload: {}, signal, what: "auto resume" },
    (body) => {
      if (!isRecord(body) || !JOB_STATUSES.includes(body.status as AutoJobStatus)) return null;
      return { status: body.status as AutoJobStatus };
    },
  );
}

export async function retryAutoItem(
  workspaceId: string,
  jobId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<{ status: AutoItemStatus; attempts: number }> {
  return requestJson(
    `/api/workspaces/${workspaceId}/auto/jobs/${jobId}/items/${encodeURIComponent(itemId)}/retry`,
    { method: "POST", payload: {}, signal, what: "auto retry" },
    (body) => {
      if (!isRecord(body) || !ITEM_STATUSES.includes(body.status as AutoItemStatus)) return null;
      const attempts = asNumber(body.attempts);
      if (attempts === null) return null;
      return { status: body.status as AutoItemStatus, attempts };
    },
  );
}

/** Jobs the worker may still advance: poll these, show Stop/Resume by state. */
export function isActiveAutoJobStatus(status: AutoJobStatus): boolean {
  return (
    status === "queued" ||
    status === "preparing" ||
    status === "detecting" ||
    status === "locating" ||
    status === "publishing"
  );
}
