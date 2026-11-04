import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { activeConnection } from "../db/connection.js";
import { openArtifactDownload, sha256Hex, storeArtifact } from "../db/artifacts.js";
import { InputSnapshotModel } from "../db/models.js";
import type { AutoJobDocument, AutoWorkItemDocument } from "../db/autoModels.js";
import { StorageValidationError, validateArtifactMeta } from "../db/validation.js";
import { ITEM_CLAIM_LEASE_MS_MAX } from "../db/validation.js";
import { validateAutoImageMetadata, type ValidatedAutoViewDescriptor } from "../db/autoValidation.js";
import type { ResolvedAutoPlan } from "./plan.js";
import { associateObservations, type StreetLine } from "./associate.js";
import {
  attributionFromRaw,
  refreshImageMetadata,
  sourceUrlFor,
  thumbUrl,
} from "./mapillaryImage.js";
import { ClientAbortedError } from "../mapillary.js";
import { buildAutoObservations } from "./observations.js";
import { prepareAnalysisView, PrepError } from "./prep.js";
import {
  isActiveJobStatus,
  advanceAutoJobPhase,
  claimAutoItem,
  claimAutoJob,
  completeAutoItem,
  failAutoItem,
  finalizeAutoJob,
  getAutoJob,
  getAutoJobProgress,
  getAutoItem,
  heartbeatAutoJob,
  listAutoCandidates,
  listAutoItems,
  markAutoItemCallSent,
  markAutoItemUnknown,
  publishAutoResult,
  releaseAutoItem,
  replaceAutoCandidates,
  reserveAutoJobCall,
  setAutoItemPrepared,
  setAutoJobModel,
  setAutoJobResult,
  sweepInterruptedJobs,
  writeAutoObservations,
} from "./store.js";
import {
  isSamConfigured,
  SamClientAbortedError,
  SamError,
  samModelName,
  samTimeoutMs,
  segmentImage,
  type SamObject,
  type SamResult,
} from "../sam.js";
import { AutoObservationModel } from "../db/autoModels.js";

/**
 * Durable in-server worker for automatic jobs. Sequential: one job at a
 * time, one SAM call in flight globally. Browser-independent; a restart
 * sweeps active jobs to interrupted and explicit resume continues them.
 */

export interface SamPort {
  segmentImage: typeof segmentImage;
  isSamConfigured: () => boolean;
  samModelName: () => string;
  samTimeoutMs: () => number;
}

const defaultSamPort: SamPort = { segmentImage, isSamConfigured, samModelName, samTimeoutMs };

export type WorkerEvent =
  | { type: "startup-sweep"; jobs: number }
  | { type: "job-claimed"; jobId: string }
  | { type: "job-done"; jobId: string; status: string }
  | { type: "job-failed"; jobId: string; error: string }
  | { type: "worker-error"; message: string }
  | { type: "poll-skipped"; reason: string };

export interface WorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sam?: SamPort;
  events?: (event: WorkerEvent) => void;
  /** Overrides MAPILLARY_ACCESS_TOKEN (tests); production reads env. */
  token?: string;
  /** Overrides MODEL_API_KEY (tests); production reads env. */
  apiKey?: string;
}

export interface WorkerHandle {
  workerId: string;
  stop: () => Promise<void>;
  runOnce: () => Promise<{ jobId: string; status: string } | null>;
}

interface WorkerContext {
  workerId: string;
  fetchImpl?: typeof fetch;
  sam: SamPort;
  events: (event: WorkerEvent) => void;
  connection: mongoose.Connection;
  token: string;
  apiKey: string;
  stopped: () => boolean;
}

/** Cap for one stored mask path; oversized masks keep their box, not the path. */
export const MASK_SVG_BYTES_MAX = 512 * 1024;
/** Pause between items after a rate limit (plus the provider's Retry-After). */
const RATE_LIMIT_PAUSE_MS = 5000;
const RATE_LIMIT_PAUSE_MAX_MS = 30000;
/** Retries of a whole run when even the failure save throws (DB outage). */
const RUN_RETRIES = 3;
const RUN_RETRY_DELAY_MS = 10000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown worker error.";
  return message.split("\n", 1)[0].slice(0, 500) || "Unknown worker error.";
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function readArtifactBytes(
  connection: mongoose.Connection,
  artifactId: string,
): Promise<Buffer | null> {
  try {
    const { stream } = openArtifactDownload(connection, artifactId);
    return await streamToBuffer(stream);
  } catch {
    return null;
  }
}

function jobIdentity(job: AutoJobDocument): { workspaceId: string; jobId: string } {
  return { workspaceId: job.workspaceId, jobId: job.jobId };
}

function planOf(job: AutoJobDocument): ResolvedAutoPlan | null {
  const plan = job.plan as unknown as ResolvedAutoPlan | null;
  if (!plan || !Array.isArray(plan.images) || !Array.isArray(plan.imageIds)) return null;
  return plan;
}

/**
 * Fresh job read with the worker's decision: keep going, settle a stop, or
 * notice an external halt. Heartbeats at the same time to hold the lease.
 */
async function checkJob(
  ctx: WorkerContext,
  job: AutoJobDocument,
): Promise<"continue" | "stop" | "halted" | "lost"> {
  const identity = jobIdentity(job);
  const alive = await heartbeatAutoJob({ ...identity, workerId: ctx.workerId });
  const current = await getAutoJob(identity.workspaceId, identity.jobId);
  if (!current) return "lost";
  if (current.owner !== ctx.workerId || !isActiveJobStatus(current.status)) return "halted";
  if (!alive) {
    // Lease anomaly with ownership intact: fail loudly so resume recovers.
    await finalizeAutoJob({
      ...identity,
      workerId: ctx.workerId,
      status: "failed",
      error: "Worker lost its lease; resume to continue.",
    }).catch(() => false);
    return "lost";
  }
  if (current.stopRequested) return "stop";
  return "continue";
}

async function loadStreetLines(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
): Promise<{ streets: StreetLine[] | null; snapshotMissing: boolean; linesSkipped: number }> {
  if (!plan.streetSnapshotId) return { streets: null, snapshotMissing: false, linesSkipped: 0 };
  const doc = await InputSnapshotModel()
    .findOne(
      { workspaceId: job.workspaceId, snapshotId: plan.streetSnapshotId },
      { kind: 1, payload: 1 },
    )
    .lean();
  const payload = doc?.payload as { streets?: unknown } | undefined;
  if (!doc || doc.kind !== "street-snapshot" || !payload || !Array.isArray(payload.streets)) {
    return { streets: null, snapshotMissing: true, linesSkipped: 0 };
  }
  const streets: StreetLine[] = [];
  let linesSkipped = 0;
  for (const entry of payload.streets as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      linesSkipped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const geometry = record.geometry as { type?: unknown; coordinates?: unknown } | undefined;
    if (
      typeof record.id !== "string" ||
      typeof record.displayName !== "string" ||
      geometry?.type !== "MultiLineString" ||
      !Array.isArray(geometry.coordinates)
    ) {
      linesSkipped += 1;
      continue;
    }
    const lines: Array<Array<[number, number]>> = [];
    let valid = true;
    for (const line of geometry.coordinates as unknown[]) {
      if (!Array.isArray(line)) {
        valid = false;
        break;
      }
      const positions: Array<[number, number]> = [];
      for (const position of line as unknown[]) {
        if (
          !Array.isArray(position) ||
          typeof position[0] !== "number" ||
          typeof position[1] !== "number" ||
          !Number.isFinite(position[0]) ||
          !Number.isFinite(position[1])
        ) {
          valid = false;
          break;
        }
        positions.push([position[0], position[1]]);
      }
      if (!valid || positions.length === 0) {
        valid = false;
        break;
      }
      lines.push(positions);
    }
    if (!valid || lines.length === 0) {
      linesSkipped += 1;
      continue;
    }
    streets.push({ id: record.id, displayName: record.displayName, lines });
  }
  return { streets, snapshotMissing: false, linesSkipped };
}

async function referencedObservations(
  workspaceId: string,
  jobId: string,
): Promise<{ observationIds: string[]; items: AutoWorkItemDocument[] }> {
  const items = await listAutoItems(workspaceId, jobId, { limit: 500 });
  const ids = new Set<string>();
  for (const item of items) {
    if (item.status === "succeeded") {
      for (const id of item.observationIds) ids.add(id);
    }
  }
  return { observationIds: [...ids].sort(), items };
}

async function runAssociationAndStore(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
): Promise<{
  streetSnapshotMissing: boolean;
  streetLinesSkipped: number;
  unlocated: Array<{ observationId: string; reason: string }>;
}> {
  const identity = jobIdentity(job);
  const { observationIds, items } = await referencedObservations(identity.workspaceId, identity.jobId);
  const observations =
    observationIds.length === 0
      ? []
      : await AutoObservationModel()
          .find({ workspaceId: identity.workspaceId, jobId: identity.jobId, observationId: { $in: observationIds } })
          .sort({ observationId: 1 })
          .limit(10000)
          .lean();
  const views = items.flatMap((item) =>
    item.viewDescriptor
      ? [{ imageId: item.imageId, descriptor: item.viewDescriptor as unknown as ValidatedAutoViewDescriptor }]
      : [],
  );
  const streets = await loadStreetLines(ctx, job, plan);
  const { candidates, unlocated } = associateObservations({ plan, observations, views, streets: streets.streets });
  await replaceAutoCandidates({ ...identity, candidates });
  return { streetSnapshotMissing: streets.snapshotMissing, streetLinesSkipped: streets.linesSkipped, unlocated };
}

async function settleStop(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
): Promise<void> {
  // The current item already settled; store partial association where the
  // evidence supports it, then finalize. Association failures must not
  // block the stop: observations stay accessible without candidates.
  try {
    const progress = await getAutoJobProgress(job.workspaceId, job.jobId);
    if (progress && progress.observationCount > 0) {
      await runAssociationAndStore(ctx, job, plan);
    }
  } catch (error) {
    ctx.events({ type: "worker-error", message: `Stop-time association failed: ${sanitizeError(error)}` });
  }
  await finalizeAutoJob({ ...jobIdentity(job), workerId: ctx.workerId, status: "stopped" });
}

async function prepOneItem(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
  item: AutoWorkItemDocument,
  metaByImage: Map<string, ResolvedAutoPlan["images"][number]>,
): Promise<void> {
  const identity = { workspaceId: job.workspaceId, jobId: job.jobId, itemId: item.itemId };
  const planMeta = metaByImage.get(item.imageId);
  if (!planMeta) {
    await failAutoItem({ ...identity, error: "Plan has no record for this image." });
    return;
  }
  let raw: unknown;
  try {
    raw = await refreshImageMetadata(item.imageId, { token: ctx.token, fetchImpl: ctx.fetchImpl });
  } catch (error) {
    if (error instanceof ClientAbortedError) throw error;
    await failAutoItem({
      ...identity,
      error: `Metadata refresh failed: ${sanitizeError(error)}`,
    });
    return;
  }
  const thumb = thumbUrl(raw, plan.recipe.thumbKind);
  if (!thumb) {
    await failAutoItem({ ...identity, error: "Provider metadata has no thumbnail URL." });
    return;
  }
  const geometrySource = planMeta.eligible ? "plan" : "prep-refetch";
  const geometry = planMeta.eligible
    ? planMeta
    : validateAutoImageMetadata(raw, item.imageId, item.sequenceId);
  try {
    const prepared = await prepareAnalysisView({
      imageId: item.imageId,
      meta: geometry,
      geometrySource,
      thumbKind: plan.recipe.thumbKind,
      thumbUrl: thumb,
      anchor: plan.anchor,
      analysisLongSidePx: plan.recipe.analysisLongSidePx,
      encodeQuality: plan.recipe.encodeQuality,
      fetchImpl: ctx.fetchImpl,
    });
    const stored = await storeArtifact(
      ctx.connection,
      prepared.bytes,
      validateArtifactMeta({
        contentHash: sha256Hex(prepared.bytes),
        mime: "image/jpeg",
        width: prepared.width,
        height: prepared.height,
        byteLength: prepared.bytes.length,
        imageId: item.imageId,
        viewId: item.itemId,
        orientation: 1,
        crop: null,
        attribution: attributionFromRaw(raw),
        sourceUrl: sourceUrlFor(item.imageId),
      }),
    );
    await setAutoItemPrepared({
      ...identity,
      viewDescriptor: prepared.descriptor,
      artifactId: new Types.ObjectId(stored.artifactId),
    });
  } catch (error) {
    if (error instanceof PrepError) {
      await failAutoItem({ ...identity, error: error.message });
      return;
    }
    throw error;
  }
}

async function runPreparing(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
): Promise<"continue" | "stop" | "halted" | "lost"> {
  const metaByImage = new Map(plan.images.map((meta) => [meta.imageId, meta]));
  for (let offset = 0; ; offset += 200) {
    const items = await listAutoItems(job.workspaceId, job.jobId, { limit: 200, offset });
    if (items.length === 0) break;
    for (const item of items) {
      if (item.status !== "queued" || item.viewDescriptor) continue;
      const state = await checkJob(ctx, job);
      if (state !== "continue") return state;
      await prepOneItem(ctx, job, plan, item, metaByImage);
    }
    if (items.length < 200) break;
  }
  const advanced = await advanceAutoJobPhase({
    ...jobIdentity(job),
    workerId: ctx.workerId,
    from: "preparing",
    to: "detecting",
  });
  return advanced ? "continue" : "lost";
}

function maskRecord(object: SamObject): { svg: string | null; tooLarge: boolean } {
  if (!object.mask || !object.mask.svgPath) return { svg: null, tooLarge: false };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${object.mask.width} ${object.mask.height}">` +
    `<path d="${object.mask.svgPath}"/></svg>`;
  if (svg.length > MASK_SVG_BYTES_MAX) return { svg: null, tooLarge: true };
  return { svg, tooLarge: false };
}

async function storeMaskArtifact(
  ctx: WorkerContext,
  job: AutoJobDocument,
  item: AutoWorkItemDocument,
  object: SamObject,
  svg: string,
): Promise<string | null> {
  if (!object.mask) return null;
  try {
    const bytes = Buffer.from(svg, "utf8");
    const stored = await storeArtifact(
      ctx.connection,
      bytes,
      validateArtifactMeta({
        contentHash: sha256Hex(bytes),
        mime: "image/svg+xml",
        width: object.mask.width,
        height: object.mask.height,
        byteLength: bytes.length,
        imageId: item.imageId,
        viewId: item.itemId,
        orientation: 1,
        crop: null,
        attribution: `SAM 3.1 mask for ${item.imageId}`,
        sourceUrl: sourceUrlFor(item.imageId),
      }),
    );
    return stored.artifactId;
  } catch {
    return null;
  }
}

async function detectOneItem(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
  item: AutoWorkItemDocument,
): Promise<"continue" | "stop" | "halted" | "lost" | "fatal"> {
  const identity = { workspaceId: job.workspaceId, jobId: job.jobId, itemId: item.itemId };
  const workerId = ctx.workerId;
  const view = item.viewDescriptor as unknown as ValidatedAutoViewDescriptor | null;
  if (!view || !item.artifactId) {
    await completeAutoItem({
      ...identity,
      workerId,
      status: "failed",
      observationIds: [],
      error: "Prepared view missing.",
    }).catch(() => undefined);
    return "continue";
  }
  const reserved = await reserveAutoJobCall({
    workspaceId: job.workspaceId,
    jobId: job.jobId,
    workerId,
    maxCalls: plan.maxCalls,
  });
  if (reserved.callsMade < 0) return "lost";
  if (!reserved.allowed) {
    await completeAutoItem({
      ...identity,
      workerId,
      status: "failed",
      observationIds: [],
      error: "Model call budget exhausted.",
    });
    return "continue";
  }
  const callLeaseMs = Math.min(ctx.sam.samTimeoutMs() + 60000, ITEM_CLAIM_LEASE_MS_MAX);
  if (!(await markAutoItemCallSent({ ...identity, workerId, leaseMs: callLeaseMs }))) {
    return "lost";
  }
  const bytes = await readArtifactBytes(ctx.connection, String(item.artifactId));
  if (!bytes) {
    await completeAutoItem({
      ...identity,
      workerId,
      status: "failed",
      observationIds: [],
      error: "Prepared view bytes missing.",
    });
    return "continue";
  }
  let result: SamResult;
  try {
    result = await ctx.sam.segmentImage(
      {
        viewId: item.itemId,
        imageId: item.imageId,
        width: view.width,
        height: view.height,
        concept: item.prompt,
        categoryIntent: item.category as "pole" | "luminaire",
        requestId: `${job.jobId}-${item.itemId}-a${item.attempts}`,
        mimeType: "image/jpeg",
        dataBase64: bytes.toString("base64"),
      },
      {
        apiKey: ctx.apiKey,
        model: ctx.sam.samModelName(),
        fetchImpl: ctx.fetchImpl,
        timeoutMs: ctx.sam.samTimeoutMs(),
      },
    );
  } catch (error) {
    return classifySamFailure(ctx, job, item, error);
  }
  await setAutoJobModel({
    workspaceId: job.workspaceId,
    jobId: job.jobId,
    workerId,
    model: result.model,
  });
  // The item may have settled under us during a long call; then the sweep
  // owns the outcome and this response is dropped, not forced in.
  const current = await getAutoItem(job.workspaceId, job.jobId, item.itemId);
  if (!current || current.status !== "running" || current.owner !== workerId) {
    return "continue";
  }
  const maskArtifactIds = new Map<string, string | null>();
  const warnings: string[] = [];
  if (result.truncated) warnings.push("truncated");
  for (const object of result.objects) {
    const { svg, tooLarge } = maskRecord(object);
    if (tooLarge) warnings.push(`mask-too-large:${object.providerObjectId}`);
    maskArtifactIds.set(
      object.providerObjectId,
      svg ? await storeMaskArtifact(ctx, job, item, object, svg) : null,
    );
  }
  const built = buildAutoObservations({
    itemId: item.itemId,
    attempts: item.attempts,
    category: item.category as "pole" | "luminaire",
    descriptor: view,
    objects: result.objects,
    maskArtifactIds,
  });
  const response = {
    objectCount: result.objects.length,
    invalidDiscarded: built.invalidDiscarded,
    truncated: result.truncated,
    warnings,
  };
  if (built.observations.length > 0) {
    await writeAutoObservations({
      workspaceId: job.workspaceId,
      jobId: job.jobId,
      itemId: item.itemId,
      imageId: item.imageId,
      concept: { conceptId: item.conceptId, text: item.prompt, category: item.category as "pole" | "luminaire" },
      observations: built.observations,
    });
    await completeAutoItem({
      ...identity,
      workerId,
      status: "succeeded",
      observationIds: built.observations.map((observation) => observation.observationId),
      providerRequestId: result.requestId,
      response,
    });
  } else {
    await completeAutoItem({
      ...identity,
      workerId,
      status: "empty",
      observationIds: [],
      providerRequestId: result.requestId,
      response,
    });
  }
  return "continue";
}

/**
 * SAM failure policy: explicit rejections fail the item (rate limits pause
 * the run briefly); ambiguous outcomes park the item as unknown for an
 * explicit retry; systematic errors fail the whole job fast.
 */
async function classifySamFailure(
  ctx: WorkerContext,
  job: AutoJobDocument,
  item: AutoWorkItemDocument,
  error: unknown,
): Promise<"continue" | "fatal"> {
  const identity = { workspaceId: job.workspaceId, jobId: job.jobId, itemId: item.itemId };
  if (error instanceof SamClientAbortedError || error instanceof ClientAbortedError) {
    await markAutoItemUnknown({ ...identity, workerId: ctx.workerId, error: "Model call aborted; outcome unknown." });
    return "continue";
  }
  if (!(error instanceof SamError)) throw error;
  switch (error.code) {
    case "SAM_RATE_LIMITED": {
      await completeAutoItem({
        ...identity,
        workerId: ctx.workerId,
        status: "failed",
        observationIds: [],
        error: "Model rate limited.",
      });
      const pause = Math.min(
        RATE_LIMIT_PAUSE_MS + (error.retryAfterSec ?? 0) * 1000,
        RATE_LIMIT_PAUSE_MAX_MS,
      );
      await sleep(pause);
      return "continue";
    }
    case "SAM_TIMEOUT":
    case "SAM_NETWORK_ERROR":
    case "SAM_BAD_RESPONSE":
      await markAutoItemUnknown({
        ...identity,
        workerId: ctx.workerId,
        error: `${error.message} Outcome unknown; retry explicitly.`,
      });
      return "continue";
    case "SAM_REQUEST_FAILED":
      if (error.retryable) {
        await markAutoItemUnknown({
          ...identity,
          workerId: ctx.workerId,
          error: `${error.message} Outcome unknown; retry explicitly.`,
        });
        return "continue";
      }
      await completeAutoItem({
        ...identity,
        workerId: ctx.workerId,
        status: "failed",
        observationIds: [],
        error: error.message,
      });
      return "continue";
    default: {
      // SAM_NOT_CONFIGURED, SAM_BAD_REQUEST, SAM_AUTH_ERROR: systematic.
      await completeAutoItem({
        ...identity,
        workerId: ctx.workerId,
        status: "failed",
        observationIds: [],
        error: error.message,
      }).catch(() => undefined);
      await finalizeAutoJob({
        workspaceId: job.workspaceId,
        jobId: job.jobId,
        workerId: ctx.workerId,
        status: "failed",
        error: error.message,
      });
      return "fatal";
    }
  }
}

async function runDetecting(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
): Promise<"continue" | "stop" | "halted" | "lost" | "fatal"> {
  for (;;) {
    const state = await checkJob(ctx, job);
    if (state !== "continue") return state;
    const item = await claimAutoItem({ workspaceId: job.workspaceId, jobId: job.jobId, workerId: ctx.workerId });
    if (!item) break;
    // A stop between claim and call releases the uncalled item.
    const fresh = await getAutoJob(job.workspaceId, job.jobId);
    if (!fresh || fresh.owner !== ctx.workerId || !isActiveJobStatus(fresh.status)) {
      await releaseAutoItem({ workspaceId: job.workspaceId, jobId: job.jobId, itemId: item.itemId, workerId: ctx.workerId });
      return "halted";
    }
    if (fresh.stopRequested) {
      await releaseAutoItem({ workspaceId: job.workspaceId, jobId: job.jobId, itemId: item.itemId, workerId: ctx.workerId });
      return "stop";
    }
    const outcome = await detectOneItem(ctx, job, plan, item);
    if (outcome !== "continue") return outcome;
  }
  const advanced = await advanceAutoJobPhase({
    ...jobIdentity(job),
    workerId: ctx.workerId,
    from: "detecting",
    to: "locating",
  });
  return advanced ? "continue" : "lost";
}

async function runLocating(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
): Promise<
  { state: "continue" | "stop" | "halted" | "lost" } & {
    streetSnapshotMissing: boolean;
    streetLinesSkipped: number;
    unlocated: Array<{ observationId: string; reason: string }>;
  }
> {
  const state = await checkJob(ctx, job);
  if (state !== "continue") {
    return { state, streetSnapshotMissing: false, streetLinesSkipped: 0, unlocated: [] };
  }
  const association = await runAssociationAndStore(ctx, job, plan);
  const advanced = await advanceAutoJobPhase({
    ...jobIdentity(job),
    workerId: ctx.workerId,
    from: "locating",
    to: "publishing",
  });
  return { state: advanced ? "continue" : "lost", ...association };
}

async function runPublishing(
  ctx: WorkerContext,
  job: AutoJobDocument,
  plan: ResolvedAutoPlan,
  association: {
    streetSnapshotMissing: boolean;
    streetLinesSkipped: number;
    unlocated: Array<{ observationId: string; reason: string }>;
  },
): Promise<"continue" | "stop" | "halted" | "lost"> {
  const identity = jobIdentity(job);
  const state = await checkJob(ctx, job);
  if (state === "stop") {
    // Stopped at the gate: the located evidence is already stored.
    await finalizeAutoJob({ ...identity, workerId: ctx.workerId, status: "stopped" });
    return state;
  }
  if (state !== "continue") return state;
  const progress = await getAutoJobProgress(identity.workspaceId, identity.jobId);
  const candidates = await listAutoCandidates(identity.workspaceId, identity.jobId);
  const { observationIds } = await referencedObservations(identity.workspaceId, identity.jobId);
  const unlocatedObservationIds = association.unlocated.map((entry) => entry.observationId);
  const unlocatedReasons: Record<string, string> = {};
  for (const entry of association.unlocated) unlocatedReasons[entry.observationId] = entry.reason;
  const locatedCandidateIds = candidates.filter((c) => c.status === "located").map((c) => c.candidateId);
  const needsReviewCandidateIds = candidates.filter((c) => c.status === "needs-review").map((c) => c.candidateId);
  const duplicateGroups = candidates.filter((c) => c.checks.includes("possible-duplicate")).length;
  const failedItems = progress?.failedItems ?? 0;
  const haltedItems = progress?.haltedItems ?? 0;
  const status = plan.mode === "locate" ? "inventory-complete" : "detection-complete";
  const current = await getAutoJob(identity.workspaceId, identity.jobId);
  const { resultId } = await publishAutoResult({
    ...identity,
    result: {
      status,
      counts: {
        totalItems: progress?.totalItems ?? 0,
        doneItems: progress?.doneItems ?? 0,
        failedItems,
        haltedItems,
        observations: observationIds.length,
        candidates: candidates.length,
        located: locatedCandidateIds.length,
        needsReview: needsReviewCandidateIds.length,
        unlocatedObservations: unlocatedObservationIds.length,
        duplicateGroups,
        callsMade: progress?.callsMade ?? 0,
        streetSnapshotMissing: association.streetSnapshotMissing ? 1 : 0,
        streetLinesSkipped: association.streetLinesSkipped,
      },
      locatedCandidateIds,
      needsReviewCandidateIds,
      unlocatedObservationIds,
      unlocatedReasons,
      thresholds: plan.thresholds as unknown as Record<string, unknown>,
      model: current?.model ?? null,
      planHash: job.planHash,
    },
  });
  const attached = await setAutoJobResult({
    ...identity,
    workerId: ctx.workerId,
    resultId,
    status: failedItems + haltedItems > 0 ? "completed_with_gaps" : "completed",
  });
  if (!attached) {
    // Published but not attached: resume recovers via idempotent re-publish.
    const latest = await getAutoJob(identity.workspaceId, identity.jobId);
    if (latest && latest.owner === ctx.workerId && isActiveJobStatus(latest.status)) {
      await finalizeAutoJob({ ...identity, workerId: ctx.workerId, status: "failed", error: "Result published but not attached; resume to recover." }).catch(
        () => false,
      );
    }
    return "lost";
  }
  return "continue";
}

async function runJob(ctx: WorkerContext, job: AutoJobDocument): Promise<void> {
  const plan = planOf(job);
  if (!plan) {
    await finalizeAutoJob({
      ...jobIdentity(job),
      workerId: ctx.workerId,
      status: "failed",
      error: "Job plan is corrupt.",
    });
    return;
  }
  if (!ctx.sam.isSamConfigured()) {
    await finalizeAutoJob({
      ...jobIdentity(job),
      workerId: ctx.workerId,
      status: "failed",
      error: "Model API key not configured (MODEL_API_KEY). Configure it and resume.",
    });
    return;
  }
  let outcome: "continue" | "stop" | "halted" | "lost" | "fatal" = await runPreparing(ctx, job, plan);
  if (outcome === "stop") {
    await settleStop(ctx, job, plan);
    return;
  }
  if (outcome !== "continue") return;
  outcome = await runDetecting(ctx, job, plan);
  if (outcome === "stop") {
    await settleStop(ctx, job, plan);
    return;
  }
  // Fatal already finalized the job; halted/lost belong to someone else.
  if (outcome !== "continue") return;
  const locating = await runLocating(ctx, job, plan);
  if (locating.state === "stop") {
    await finalizeAutoJob({ ...jobIdentity(job), workerId: ctx.workerId, status: "stopped" });
    return;
  }
  if (locating.state !== "continue") return;
  await runPublishing(ctx, job, plan, locating);
}

async function runJobGuarded(ctx: WorkerContext, job: AutoJobDocument): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runJob(ctx, job);
      return;
    } catch (error) {
      if (error instanceof StorageValidationError) {
        // Lease/ownership races land here: the winner owns the outcome.
        ctx.events({ type: "worker-error", message: `Job ${job.jobId}: ${sanitizeError(error)}` });
        return;
      }
      const message = sanitizeError(error);
      try {
        await finalizeAutoJob({
          ...jobIdentity(job),
          workerId: ctx.workerId,
          status: "failed",
          error: message,
        });
        ctx.events({ type: "job-failed", jobId: job.jobId, error: message });
        return;
      } catch {
        // Even the failure save threw (DB outage): retry the run, which is
        // idempotent, then abandon it for the startup sweep to heal.
        if (attempt + 1 >= RUN_RETRIES || ctx.stopped()) return;
        await sleep(RUN_RETRY_DELAY_MS);
      }
    }
  }
}

function readMapillaryToken(): string {
  return (process.env.MAPILLARY_ACCESS_TOKEN ?? "").trim();
}

function readModelApiKey(): string {
  return (process.env.MODEL_API_KEY ?? "").trim();
}

export async function runOneAutoJob(options: WorkerOptions = {}): Promise<{ jobId: string; status: string } | null> {
  const connection = activeConnection();
  if (!connection) return null;
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const sam = options.sam ?? defaultSamPort;
  const events = options.events ?? (() => {});
  const ctx: Omit<WorkerContext, "token" | "apiKey" | "stopped"> = {
    workerId,
    fetchImpl: options.fetchImpl,
    sam,
    events,
    connection,
  };
  const job = await claimAutoJob({ workerId });
  if (!job) return null;
  events({ type: "job-claimed", jobId: job.jobId });
  const token = (options.token ?? readMapillaryToken()).trim();
  const apiKey = (options.apiKey ?? readModelApiKey()).trim();
  if (!token) {
    await finalizeAutoJob({
      ...jobIdentity(job),
      workerId,
      status: "failed",
      error: "Mapillary access token not configured (MAPILLARY_ACCESS_TOKEN). Configure it and resume.",
    });
    return { jobId: job.jobId, status: "failed" };
  }
  await runJobGuarded({ ...ctx, token, apiKey, stopped: () => false }, job);
  const final = await getAutoJob(job.workspaceId, job.jobId);
  const status = final?.status ?? "unknown";
  events({ type: "job-done", jobId: job.jobId, status });
  return { jobId: job.jobId, status };
}

export function startAutoWorker(options: WorkerOptions = {}): WorkerHandle {
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const events = options.events ?? (() => {});
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<unknown> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const connection = activeConnection();
    if (!connection) {
      events({ type: "poll-skipped", reason: "db-unavailable" });
    } else {
      try {
        const ran = await runOneAutoJob({ ...options, workerId });
        if (stopped) return;
        timer = setTimeout(() => void tickLoop(), ran ? 0 : pollIntervalMs);
        timer.unref?.();
        return;
      } catch (error) {
        events({ type: "worker-error", message: sanitizeError(error) });
      }
    }
    if (stopped) return;
    timer = setTimeout(() => void tickLoop(), pollIntervalMs);
    timer.unref?.();
  };

  const tickLoop = (): void => {
    current = tick().catch((error: unknown) => {
      events({ type: "worker-error", message: sanitizeError(error) });
    });
  };

  current = (async () => {
    try {
      const connection = activeConnection();
      if (connection) {
        const swept = await sweepInterruptedJobs();
        events({ type: "startup-sweep", jobs: swept.jobs.length });
      }
    } catch (error) {
      events({ type: "worker-error", message: `Startup sweep failed: ${sanitizeError(error)}` });
    }
    if (!stopped) tickLoop();
  })();

  return {
    workerId,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
    runOnce: () => runOneAutoJob({ ...options, workerId }),
  };
}
