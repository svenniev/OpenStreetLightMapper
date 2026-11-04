import mongoose, { Types } from "mongoose";
import {
  AutoCandidateModel,
  AutoJobModel,
  AutoObservationModel,
  AutoResultModel,
  AutoWorkItemModel,
  type AutoCandidateDocument,
  type AutoItemStatus,
  type AutoJobDocument,
  type AutoJobStatus,
  type AutoObservationDocument,
  type AutoResultDocument,
  type AutoWorkItemDocument,
} from "../db/autoModels.js";
import {
  ITEM_CLAIM_LEASE_MS_DEFAULT,
  ITEM_CLAIM_LEASE_MS_MAX,
  ITEM_CLAIM_LEASE_MS_MIN,
  STORAGE_SCHEMA_VERSION,
  StorageValidationError,
  fail,
} from "../db/validation.js";
import {
  stableStringify,
  type ValidatedAutoCandidate,
  type ValidatedAutoConcept,
  type ValidatedAutoObservation,
  type ValidatedAutoViewDescriptor,
} from "../db/autoValidation.js";
import type { ResolvedAutoPlan } from "./plan.js";

/**
 * Atomic store for the automatic (headless) pipeline. Every mutation is a
 * conditional single-document write that exactly one concurrent worker can
 * win; losers re-read the winner instead of overwriting it. Mirrors the
 * manual item register/claim/complete hardening in routes/items.ts.
 */

const TERMINAL_ITEM_STATUSES: AutoItemStatus[] = ["succeeded", "empty", "failed"];
const TERMINAL_ITEM_SET = new Set<string>(TERMINAL_ITEM_STATUSES);
/** Worker-owned phases; only these hold a live lease. */
const ACTIVE_JOB_STATUSES: AutoJobStatus[] = ["preparing", "detecting", "locating", "publishing"];

export function isActiveJobStatus(status: AutoJobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}
const TERMINAL_JOB_STATUSES: AutoJobStatus[] = ["completed", "completed_with_gaps", "failed"];
const RESUMABLE_JOB_STATUSES: AutoJobStatus[] = ["stopped", "interrupted", "failed"];

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Ownership clause for conditional writes: unclaimed docs, docs this worker
 * owns, and docs whose lease expired are writable; anything else loses.
 */
function ownershipClause(owner: string, now: Date): Record<string, unknown> {
  return { $or: [{ owner: null }, { leaseExpiresAt: { $lt: now } }, { owner }] };
}

function checkLeaseMs(leaseMs: number): number {
  const value = leaseMs ?? ITEM_CLAIM_LEASE_MS_DEFAULT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < ITEM_CLAIM_LEASE_MS_MIN ||
    value > ITEM_CLAIM_LEASE_MS_MAX
  ) {
    fail(
      "STORAGE_BAD_REQUEST",
      `Auto claim leaseMs must be an integer ${ITEM_CLAIM_LEASE_MS_MIN}..${ITEM_CLAIM_LEASE_MS_MAX}.`,
    );
  }
  return value;
}

function claimedMessage(
  what: string,
  winner: { owner: string | null; leaseExpiresAt: Date | null; status: string },
): string {
  const lease = winner.leaseExpiresAt ? winner.leaseExpiresAt.toISOString() : "no expiry recorded";
  return (
    `${what} is claimed by ${winner.owner ?? "another worker"} until ${lease} ` +
    `(status ${winner.status}). Re-read it instead of overwriting it.`
  );
}

// ---------------------------------------------------------------------------
// Launch (idempotent by idempotencyKey).
// ---------------------------------------------------------------------------

export interface LaunchAutoJobInput {
  workspaceId: string;
  jobId: string;
  idempotencyKey: string;
  plan: ResolvedAutoPlan;
  planHash: string;
}

function buildAutoItemDocs(
  workspaceId: string,
  jobId: string,
  plan: ResolvedAutoPlan,
  registeredAt: Date,
): Array<Omit<AutoWorkItemDocument, "createdAt" | "updatedAt">> {
  // No createdAt/updatedAt: $setOnInsert must not repeat the paths that
  // Mongoose timestamps manage, or the update conflicts with itself.
  const docs: Array<Omit<AutoWorkItemDocument, "createdAt" | "updatedAt">> = [];
  for (const entry of plan.perSequence) {
    for (const imageId of entry.imageIds) {
      for (const concept of plan.concepts) {
        docs.push({
          workspaceId,
          jobId,
          // Recipe v1 prepares one flat view per image; the view token keeps
          // the identity stable when multi-view recipes arrive.
          itemId: `${imageId}--v0--${concept.conceptId}`,
          schemaVersion: STORAGE_SCHEMA_VERSION,
          sequenceId: entry.sequenceId,
          imageId,
          conceptId: concept.conceptId,
          prompt: concept.text,
          category: concept.category,
          status: "queued",
          owner: null,
          leaseExpiresAt: null,
          viewDescriptor: null,
          artifactId: null,
          observationIds: [],
          attempts: 0,
          error: null,
          providerRequestId: null,
          callSent: false,
          response: null,
          registeredAt,
          finishedAt: null,
        });
      }
    }
  }
  return docs;
}

/** Idempotent item registration: re-launches top up items missing after a crash. */
async function ensureAutoJobItems(
  workspaceId: string,
  jobId: string,
  plan: ResolvedAutoPlan,
): Promise<void> {
  const docs = buildAutoItemDocs(workspaceId, jobId, plan, new Date());
  if (docs.length === 0) return;
  const ops: mongoose.AnyBulkWriteOperation<AutoWorkItemDocument>[] = docs.map((doc) => ({
    updateOne: {
      filter: { workspaceId, jobId, itemId: doc.itemId },
      update: { $setOnInsert: doc },
      upsert: true,
    },
  }));
  await AutoWorkItemModel().bulkWrite(ops, { ordered: false });
}

function samePlanHash(existing: AutoJobDocument, planHash: string): boolean {
  return existing.planHash === planHash;
}

async function launchExisting(
  workspaceId: string,
  existing: AutoJobDocument,
  plan: ResolvedAutoPlan,
  planHash: string,
): Promise<{ job: AutoJobDocument; deduplicated: boolean }> {
  if (!samePlanHash(existing, planHash)) {
    throw new StorageValidationError(
      "AUTO_JOB_CONFLICT",
      `Idempotency key was already used for job ${existing.jobId} with a different plan.`,
    );
  }
  await ensureAutoJobItems(workspaceId, existing.jobId, plan);
  return { job: existing, deduplicated: true };
}

export async function launchAutoJob(
  input: LaunchAutoJobInput,
): Promise<{ job: AutoJobDocument; deduplicated: boolean }> {
  const { workspaceId, jobId, idempotencyKey, plan, planHash } = input;
  const existing = await AutoJobModel().findOne({ workspaceId, idempotencyKey }).lean();
  if (existing) {
    return launchExisting(workspaceId, existing, plan, planHash);
  }
  try {
    const created = await AutoJobModel().create({
      workspaceId,
      jobId,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      status: "queued",
      idempotencyKey,
      plan,
      planHash,
      callsMade: 0,
      owner: null,
      leaseExpiresAt: null,
      model: null,
      stopRequested: false,
      error: null,
      resultId: null,
    });
    await ensureAutoJobItems(workspaceId, jobId, plan);
    return { job: created.toObject(), deduplicated: false };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // Lost a launch race: exactly one creator wins; re-read the winner.
    const raced = await AutoJobModel().findOne({ workspaceId, idempotencyKey }).lean();
    if (!raced) {
      throw new StorageValidationError(
        "AUTO_JOB_CONFLICT",
        "Job id collided with another job; retry the launch.",
      );
    }
    return launchExisting(workspaceId, raced, plan, planHash);
  }
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export async function getAutoJob(
  workspaceId: string,
  jobId: string,
): Promise<AutoJobDocument | null> {
  return AutoJobModel().findOne({ workspaceId, jobId }).lean();
}

export async function listAutoJobs(
  workspaceId: string,
  limit: number = 50,
): Promise<AutoJobDocument[]> {
  const bounded = Math.min(Math.max(limit, 1), 100);
  return AutoJobModel().find({ workspaceId }).sort({ updatedAt: -1 }).limit(bounded).lean();
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

/**
 * Derived progress: counted from items/observations/candidates on every read,
 * so a worker crash between writes can never leave counters behind reality.
 * Only observations referenced by completed items count; orphaned partials
 * from failed attempts are ignored.
 */
export async function getAutoJobProgress(
  workspaceId: string,
  jobId: string,
): Promise<AutoJobProgress | null> {
  const job = await AutoJobModel()
    .findOne({ workspaceId, jobId }, { callsMade: 1 })
    .lean();
  if (!job) return null;
  const items = await AutoWorkItemModel()
    .find({ workspaceId, jobId }, { status: 1, observationIds: 1 })
    .lean();
  let queuedItems = 0;
  let runningItems = 0;
  let doneItems = 0;
  let failedItems = 0;
  let haltedItems = 0;
  let observationCount = 0;
  for (const item of items) {
    switch (item.status) {
      case "queued":
        queuedItems += 1;
        break;
      case "running":
        runningItems += 1;
        break;
      case "succeeded":
      case "empty":
        doneItems += 1;
        observationCount += item.observationIds.length;
        break;
      case "failed":
        failedItems += 1;
        break;
      default:
        haltedItems += 1;
        break;
    }
  }
  const locatedCount = await AutoCandidateModel().countDocuments({
    workspaceId,
    jobId,
    status: "located",
  });
  return {
    totalItems: items.length,
    queuedItems,
    runningItems,
    doneItems,
    failedItems,
    haltedItems,
    observationCount,
    locatedCount,
    callsMade: job.callsMade,
  };
}

export async function getAutoItem(
  workspaceId: string,
  jobId: string,
  itemId: string,
): Promise<AutoWorkItemDocument | null> {
  return AutoWorkItemModel().findOne({ workspaceId, jobId, itemId }).lean();
}

export async function listAutoItems(
  workspaceId: string,
  jobId: string,
  options: { status?: AutoItemStatus; limit?: number; offset?: number } = {},
): Promise<AutoWorkItemDocument[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const filter: Record<string, unknown> = { workspaceId, jobId };
  if (options.status) filter.status = options.status;
  return AutoWorkItemModel()
    .find(filter)
    .sort({ registeredAt: 1, itemId: 1 })
    .skip(offset)
    .limit(limit)
    .lean();
}

export async function listAutoObservations(
  workspaceId: string,
  jobId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<AutoObservationDocument[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  return AutoObservationModel()
    .find({ workspaceId, jobId })
    .sort({ observationId: 1 })
    .skip(offset)
    .limit(limit)
    .lean();
}

export async function listAutoCandidates(
  workspaceId: string,
  jobId: string,
  options: { status?: string } = {},
): Promise<AutoCandidateDocument[]> {
  const filter: Record<string, unknown> = { workspaceId, jobId };
  if (options.status) filter.status = options.status;
  return AutoCandidateModel().find(filter).sort({ candidateId: 1 }).limit(2000).lean();
}

export async function getAutoResult(
  workspaceId: string,
  jobId: string,
): Promise<AutoResultDocument | null> {
  return AutoResultModel().findOne({ workspaceId, jobId }).lean();
}

export interface AutoCandidateEvidence {
  candidate: AutoCandidateDocument;
  observations: AutoObservationDocument[];
  items: AutoWorkItemDocument[];
  truncated: boolean;
}

/** One candidate's inspectable evidence: its observations plus their work items (view bytes). */
export async function getAutoCandidateEvidence(
  workspaceId: string,
  jobId: string,
  candidateId: string,
): Promise<AutoCandidateEvidence | null> {
  const candidate = await AutoCandidateModel().findOne({ workspaceId, jobId, candidateId }).lean();
  if (!candidate) return null;
  const wanted = [...new Set(candidate.observationIds)].slice(0, 200);
  const truncated = candidate.observationIds.length > wanted.length;
  const observations =
    wanted.length === 0
      ? []
      : await AutoObservationModel()
          .find({ workspaceId, jobId, observationId: { $in: wanted } })
          .sort({ observationId: 1 })
          .limit(200)
          .lean();
  const itemIds = [...new Set(observations.map((observation) => observation.itemId))];
  const items =
    itemIds.length === 0
      ? []
      : await AutoWorkItemModel()
          .find({ workspaceId, jobId, itemId: { $in: itemIds } })
          .lean();
  return { candidate, observations, items, truncated };
}

// ---------------------------------------------------------------------------
// Job lifecycle: claim, heartbeat, call budget, finalize.
// ---------------------------------------------------------------------------

export async function claimAutoJob(input: {
  workerId: string;
  leaseMs?: number;
}): Promise<AutoJobDocument | null> {
  const leaseMs = checkLeaseMs(input.leaseMs ?? ITEM_CLAIM_LEASE_MS_DEFAULT);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  // Queued jobs only: a job whose worker died is swept to interrupted at
  // startup or resume and restarts from there explicitly, never by silent
  // adoption (in-flight provider outcomes stay unknown, not reissued).
  return AutoJobModel()
    .findOneAndUpdate(
      { status: "queued", stopRequested: false },
      { $set: { status: "preparing", owner: input.workerId, leaseExpiresAt } },
      { new: true, sort: { createdAt: 1 } },
    )
    .lean();
}

/** Advance one worker-owned phase; false when the lease or phase moved on. */
export async function advanceAutoJobPhase(input: {
  workspaceId: string;
  jobId: string;
  workerId: string;
  from: AutoJobStatus;
  to: AutoJobStatus;
}): Promise<boolean> {
  if (!ACTIVE_JOB_STATUSES.includes(input.from) || !ACTIVE_JOB_STATUSES.includes(input.to)) {
    throw new Error(`advanceAutoJobPhase moves between active phases, got ${input.from} -> ${input.to}.`);
  }
  const updated = await AutoJobModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      status: input.from,
      owner: input.workerId,
    },
    { $set: { status: input.to } },
  );
  return updated.matchedCount === 1;
}

export async function heartbeatAutoJob(input: {
  workspaceId: string;
  jobId: string;
  workerId: string;
  leaseMs?: number;
}): Promise<boolean> {
  const leaseMs = checkLeaseMs(input.leaseMs ?? ITEM_CLAIM_LEASE_MS_DEFAULT);
  const updated = await AutoJobModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      status: { $in: ACTIVE_JOB_STATUSES },
      owner: input.workerId,
    },
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) } },
  );
  return updated.matchedCount === 1;
}

/** First inference wins: the worker records the resolved SAM model label once. */
export async function setAutoJobModel(input: {
  workspaceId: string;
  jobId: string;
  workerId: string;
  model: string;
}): Promise<boolean> {
  const updated = await AutoJobModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      status: { $in: ACTIVE_JOB_STATUSES },
      owner: input.workerId,
      model: null,
    },
    { $set: { model: input.model } },
  );
  return updated.matchedCount === 1;
}

/**
 * Reserve one model call before making it: the increment happens first so a
 * crash can only under-use the budget, never overspend it.
 */
export async function reserveAutoJobCall(input: {
  workspaceId: string;
  jobId: string;
  workerId: string;
  maxCalls: number;
}): Promise<{ allowed: boolean; callsMade: number }> {
  const updated = await AutoJobModel().findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      status: "detecting",
      owner: input.workerId,
    },
    { $inc: { callsMade: 1 } },
    { new: true, projection: { callsMade: 1 } },
  );
  if (!updated) return { allowed: false, callsMade: -1 };
  return { allowed: updated.callsMade <= input.maxCalls, callsMade: updated.callsMade };
}

const FINAL_JOB_STATUSES: AutoJobStatus[] = [
  "completed",
  "completed_with_gaps",
  "failed",
  "stopped",
  "interrupted",
];

export async function finalizeAutoJob(input: {
  workspaceId: string;
  jobId: string;
  workerId: string;
  status: AutoJobStatus;
  error?: string | null;
}): Promise<boolean> {
  if (!FINAL_JOB_STATUSES.includes(input.status)) {
    throw new Error(`finalizeAutoJob needs a final status, got ${input.status}.`);
  }
  const updated = await AutoJobModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      status: { $in: ACTIVE_JOB_STATUSES },
      owner: input.workerId,
    },
    {
      $set: {
        status: input.status,
        error: input.error ?? null,
        owner: null,
        leaseExpiresAt: null,
      },
    },
  );
  return updated.matchedCount === 1;
}

/**
 * Publish-side completion: only the owning worker of a publishing job can
 * attach the result. The worker picks completed vs completed_with_gaps from
 * the final item counts.
 */
export async function setAutoJobResult(input: {
  workspaceId: string;
  jobId: string;
  workerId: string;
  resultId: string;
  status: "completed" | "completed_with_gaps";
}): Promise<boolean> {
  const updated = await AutoJobModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      status: "publishing",
      owner: input.workerId,
    },
    { $set: { status: input.status, resultId: input.resultId, owner: null, leaseExpiresAt: null } },
  );
  return updated.matchedCount === 1;
}

// ---------------------------------------------------------------------------
// Stop / resume / sweep.
// ---------------------------------------------------------------------------

export interface SweepCounts {
  requeued: number;
  interrupted: number;
}

/**
 * Settle running items left by a dead worker. Items that never sent a model
 * call return to queued (safe: nothing billable happened); items with a
 * call in flight become interrupted with an unknown outcome and wait for an
 * explicit per-item retry — never an automatic reissue.
 *
 * With ignoreLease=false only items without a live lease move, so a sweep
 * racing a live worker's completion preserves the completed evidence
 * whichever write lands last.
 */
export async function sweepAutoJobItems(input: {
  workspaceId: string;
  jobId: string;
  ignoreLease: boolean;
}): Promise<SweepCounts> {
  const now = new Date();
  const liveness = input.ignoreLease
    ? {}
    : { $or: [{ owner: null }, { leaseExpiresAt: { $lt: now } }] };
  const base = { workspaceId: input.workspaceId, jobId: input.jobId, status: "running", ...liveness };
  const requeued = await AutoWorkItemModel().updateMany(
    { ...base, callSent: false },
    {
      $set: {
        status: "queued",
        owner: null,
        leaseExpiresAt: null,
        error: null,
        finishedAt: null,
      },
    },
  );
  const interrupted = await AutoWorkItemModel().updateMany(
    { ...base, callSent: true },
    {
      $set: {
        status: "interrupted",
        owner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        error: "Outcome unknown: the worker was lost after the model call was sent.",
      },
    },
  );
  return { requeued: requeued.modifiedCount, interrupted: interrupted.modifiedCount };
}

export async function requestAutoStop(input: {
  workspaceId: string;
  jobId: string;
}): Promise<{ status: AutoJobStatus; stopped: boolean } & SweepCounts> {
  // Read, decide, conditional-write; a lost race re-reads the winner.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const job = await getAutoJob(input.workspaceId, input.jobId);
    if (!job) {
      throw new StorageValidationError("AUTO_JOB_NOT_FOUND", `Unknown auto job ${input.jobId}.`);
    }
    if (TERMINAL_JOB_STATUSES.includes(job.status)) {
      throw new StorageValidationError(
        "AUTO_JOB_CONFLICT",
        `Auto job ${input.jobId} already ${job.status}; it cannot be stopped.`,
      );
    }
    if (job.status === "stopped" || job.status === "interrupted") {
      return { status: job.status, stopped: false, requeued: 0, interrupted: 0 };
    }
    if (job.status === "queued") {
      // Halted before any worker picked it up; stays resumable.
      const halted = await AutoJobModel().findOneAndUpdate(
        { workspaceId: input.workspaceId, jobId: input.jobId, status: "queued" },
        { $set: { status: "stopped", stopRequested: true } },
        { new: true },
      );
      if (halted) return { status: halted.status, stopped: true, requeued: 0, interrupted: 0 };
      continue;
    }
    const now = new Date();
    const live = Boolean(job.owner && job.leaseExpiresAt && job.leaseExpiresAt > now);
    if (live) {
      // A live worker settles its current item and finalizes; flag it.
      if (job.stopRequested) {
        return { status: job.status, stopped: false, requeued: 0, interrupted: 0 };
      }
      const flagged = await AutoJobModel().findOneAndUpdate(
        {
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          status: job.status,
          owner: job.owner,
        },
        { $set: { stopRequested: true } },
        { new: true },
      );
      if (flagged) return { status: flagged.status, stopped: true, requeued: 0, interrupted: 0 };
      continue;
    }
    // No live worker: halt now instead of flagging a ghost.
    const halted = await AutoJobModel().findOneAndUpdate(
      {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        status: job.status,
        $or: [{ owner: null }, { leaseExpiresAt: { $lt: new Date() } }],
      },
      {
        $set: {
          status: "stopped",
          stopRequested: true,
          owner: null,
          leaseExpiresAt: null,
        },
      },
      { new: true },
    );
    if (!halted) continue;
    const swept = await sweepAutoJobItems({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      ignoreLease: false,
    });
    return { status: halted.status, stopped: true, ...swept };
  }
  throw new StorageValidationError(
    "AUTO_JOB_CONFLICT",
    `Auto job ${input.jobId} changed under stop; retry the stop.`,
  );
}

export async function resumeAutoJob(input: {
  workspaceId: string;
  jobId: string;
}): Promise<{ status: AutoJobStatus } & SweepCounts> {
  const job = await getAutoJob(input.workspaceId, input.jobId);
  if (!job) {
    throw new StorageValidationError("AUTO_JOB_NOT_FOUND", `Unknown auto job ${input.jobId}.`);
  }
  if (!RESUMABLE_JOB_STATUSES.includes(job.status)) {
    throw new StorageValidationError(
      "AUTO_JOB_CONFLICT",
      `Only stopped, interrupted, or failed jobs resume; job ${input.jobId} is ${job.status}.`,
    );
  }
  // Explicit resume asserts the previous worker is gone: leftover running
  // items settle by the callSent rule. Failed and interrupted items stay put
  // (no blanket retries); interrupted ones wait for explicit per-item retry.
  const swept = await sweepAutoJobItems({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    ignoreLease: true,
  });
  const resumed = await AutoJobModel().findOneAndUpdate(
    { workspaceId: input.workspaceId, jobId: input.jobId, status: job.status },
    {
      $set: {
        status: "queued",
        stopRequested: false,
        error: null,
        owner: null,
        leaseExpiresAt: null,
      },
    },
    { new: true },
  );
  if (resumed) return { status: resumed.status, ...swept };
  // Lost a resume race; a concurrent resume already requeued the job.
  const raced = await getAutoJob(input.workspaceId, input.jobId);
  if (raced && raced.status === "queued") {
    return { status: raced.status, requeued: 0, interrupted: 0 };
  }
  throw new StorageValidationError(
    "AUTO_JOB_CONFLICT",
    `Auto job ${input.jobId} changed under resume; retry the resume.`,
  );
}

/**
 * Explicit new attempt for one interrupted (unknown-outcome) item. Allowed
 * while the job is not completed; completed jobs keep their published
 * result and retry via a new run instead.
 */
export async function retryAutoItem(input: {
  workspaceId: string;
  jobId: string;
  itemId: string;
}): Promise<{ status: AutoItemStatus; attempts: number }> {
  const job = await getAutoJob(input.workspaceId, input.jobId);
  if (!job) {
    throw new StorageValidationError("AUTO_JOB_NOT_FOUND", `Unknown auto job ${input.jobId}.`);
  }
  if (job.status === "completed" || job.status === "completed_with_gaps") {
    throw new StorageValidationError(
      "AUTO_JOB_CONFLICT",
      `Auto job ${input.jobId} already ${job.status}; launch a new run to retry this image.`,
    );
  }
  // The prepared view is kept (prep is deterministic and already stored);
  // the bumped attempt counter keeps new observation ids distinct.
  const retried = await AutoWorkItemModel().findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      itemId: input.itemId,
      status: "interrupted",
    },
    {
      $set: {
        status: "queued",
        owner: null,
        leaseExpiresAt: null,
        error: null,
        observationIds: [],
        providerRequestId: null,
        callSent: false,
        response: null,
        finishedAt: null,
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  );
  if (retried) return { status: retried.status, attempts: retried.attempts };
  const item = await getAutoItem(input.workspaceId, input.jobId, input.itemId);
  if (!item) {
    throw new StorageValidationError(
      "AUTO_ITEM_NOT_FOUND",
      `Unknown auto item ${input.jobId}/${input.itemId}.`,
    );
  }
  throw new StorageValidationError(
    "AUTO_ITEM_CONFLICT",
    `Only interrupted items retry; auto item ${input.jobId}/${input.itemId} is ${item.status}.`,
  );
}

/**
 * Server-startup recovery: every job left active by the dead process becomes
 * interrupted with its items settled by the callSent rule. Owners are dead
 * by definition here, so leases are ignored.
 */
export async function sweepInterruptedJobs(): Promise<{
  jobs: Array<{ workspaceId: string; jobId: string } & SweepCounts>;
}> {
  const active = await AutoJobModel()
    .find({ status: { $in: ACTIVE_JOB_STATUSES } }, { workspaceId: 1, jobId: 1 })
    .lean();
  const jobs: Array<{ workspaceId: string; jobId: string } & SweepCounts> = [];
  for (const job of active) {
    await AutoJobModel().updateOne(
      { workspaceId: job.workspaceId, jobId: job.jobId },
      {
        $set: {
          status: "interrupted",
          stopRequested: false,
          error: "Server stopped with this job active; resume to continue.",
          owner: null,
          leaseExpiresAt: null,
        },
      },
    );
    const swept = await sweepAutoJobItems({
      workspaceId: job.workspaceId,
      jobId: job.jobId,
      ignoreLease: true,
    });
    jobs.push({ workspaceId: job.workspaceId, jobId: job.jobId, ...swept });
  }
  return { jobs };
}

// ---------------------------------------------------------------------------
// Work items: claim, prepare, complete, interrupt.
// ---------------------------------------------------------------------------

export async function claimAutoItem(input: {
  workspaceId: string;
  jobId: string;
  workerId: string;
  leaseMs?: number;
}): Promise<AutoWorkItemDocument | null> {
  const leaseMs = checkLeaseMs(input.leaseMs ?? ITEM_CLAIM_LEASE_MS_DEFAULT);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const identity = { workspaceId: input.workspaceId, jobId: input.jobId };
  // Queued items only. Running items left by a dead worker settle through
  // the sweep (callSent rule), never by silent adoption.
  return AutoWorkItemModel()
    .findOneAndUpdate(
      { ...identity, status: "queued" },
      { $set: { status: "running", owner: input.workerId, leaseExpiresAt } },
      { new: true, sort: { registeredAt: 1, itemId: 1 } },
    )
    .lean();
}

async function loseAutoItemRace(
  workspaceId: string,
  jobId: string,
  itemId: string,
): Promise<AutoWorkItemDocument> {
  const winner = await getAutoItem(workspaceId, jobId, itemId);
  if (!winner) {
    throw new StorageValidationError(
      "AUTO_ITEM_NOT_FOUND",
      `Unknown auto item ${jobId}/${itemId}.`,
    );
  }
  return winner;
}

/**
 * Record a prepared analysis view. Preparation needs no item claim: the job
 * lease serializes workers, and prep is a deterministic function of the
 * frozen plan, so concurrent writers converge on identical values.
 */
export async function setAutoItemPrepared(input: {
  workspaceId: string;
  jobId: string;
  itemId: string;
  viewDescriptor: ValidatedAutoViewDescriptor;
  artifactId: mongoose.Types.ObjectId | null;
}): Promise<void> {
  const updated = await AutoWorkItemModel().findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      itemId: input.itemId,
      status: "queued",
    },
    {
      $set: {
        viewDescriptor: input.viewDescriptor as unknown as Record<string, unknown>,
        artifactId: input.artifactId,
      },
    },
    { new: true },
  );
  if (updated) return;
  const winner = await loseAutoItemRace(input.workspaceId, input.jobId, input.itemId);
  if (TERMINAL_ITEM_SET.has(winner.status) || winner.status === "interrupted") {
    throw new StorageValidationError(
      "AUTO_ITEM_ALREADY_COMPLETE",
      `Auto item ${input.jobId}/${input.itemId} already finished as ${winner.status}.`,
    );
  }
  throw new StorageValidationError(
    "AUTO_ITEM_CLAIMED",
    claimedMessage(`Auto item ${input.jobId}/${input.itemId}`, winner),
  );
}

/**
 * Fail a queued item during preparation (fetch/decode/geometry errors).
 * Preparation never claims, so this is the only queued -> failed path.
 */
export async function failAutoItem(input: {
  workspaceId: string;
  jobId: string;
  itemId: string;
  error: string;
}): Promise<boolean> {
  const updated = await AutoWorkItemModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      itemId: input.itemId,
      status: "queued",
    },
    { $set: { status: "failed", error: input.error, finishedAt: new Date() } },
  );
  return updated.matchedCount === 1;
}

/**
 * Release a claimed-but-uncalled item back to queued (stop before the call).
 * Only items that never sent a call release; anything sent keeps its
 * unknown outcome for the sweep or an explicit retry.
 */
export async function releaseAutoItem(input: {
  workspaceId: string;
  jobId: string;
  itemId: string;
  workerId: string;
}): Promise<boolean> {
  const updated = await AutoWorkItemModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      itemId: input.itemId,
      status: "running",
      owner: input.workerId,
      callSent: false,
    },
    { $set: { status: "queued", owner: null, leaseExpiresAt: null } },
  );
  return updated.matchedCount === 1;
}

/**
 * Park a running item as unknown-outcome after an ambiguous provider
 * result (timeout, disconnect, unreadable response). Like the sweep's
 * interrupted items, it waits for an explicit retry — never auto-reissued.
 */
export async function markAutoItemUnknown(input: {
  workspaceId: string;
  jobId: string;
  itemId: string;
  workerId: string;
  error: string;
}): Promise<boolean> {
  const updated = await AutoWorkItemModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      itemId: input.itemId,
      status: "running",
      ...ownershipClause(input.workerId, new Date()),
    },
    {
      $set: {
        status: "interrupted",
        error: input.error,
        finishedAt: new Date(),
        owner: null,
        leaseExpiresAt: null,
      },
    },
  );
  return updated.matchedCount === 1;
}

/**
 * Mark a model call sent, immediately before the SAM request, extending the
 * lease to cover the call. The worker aborts the item when this returns
 * false (lease lost); the sweep later treats callSent items as
 * unknown-outcome, never auto-reissued.
 */
export async function markAutoItemCallSent(input: {
  workspaceId: string;
  jobId: string;
  itemId: string;
  workerId: string;
  leaseMs?: number;
}): Promise<boolean> {
  const leaseMs = checkLeaseMs(input.leaseMs ?? ITEM_CLAIM_LEASE_MS_DEFAULT);
  const updated = await AutoWorkItemModel().updateOne(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      itemId: input.itemId,
      status: "running",
      ...ownershipClause(input.workerId, new Date()),
    },
    { $set: { callSent: true, leaseExpiresAt: new Date(Date.now() + leaseMs) } },
  );
  return updated.matchedCount === 1;
}

export type AutoCompleteStatus = "succeeded" | "empty" | "failed";

export interface CompleteAutoItemInput {
  workspaceId: string;
  jobId: string;
  itemId: string;
  workerId: string;
  status: AutoCompleteStatus;
  observationIds: string[];
  error?: string | null;
  providerRequestId?: string | null;
  /** Bounded SAM response digest, persisted before any downstream publish. */
  response?: Record<string, unknown> | null;
}

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

function sameCompletion(
  winner: AutoWorkItemDocument,
  input: CompleteAutoItemInput,
): boolean {
  return (
    winner.status === input.status &&
    stableStringify(sortedIds(winner.observationIds)) ===
      stableStringify(sortedIds(input.observationIds)) &&
    (winner.error ?? null) === (input.error ?? null) &&
    stableStringify(winner.response ?? null) === stableStringify(input.response ?? null)
  );
}

export async function completeAutoItem(
  input: CompleteAutoItemInput,
): Promise<{ status: AutoItemStatus; deduplicated: boolean }> {
  if (input.status === "succeeded" && input.observationIds.length === 0) {
    throw new StorageValidationError(
      "AUTO_ITEM_CONFLICT",
      `Auto item ${input.jobId}/${input.itemId} cannot succeed with zero observations.`,
    );
  }
  if (input.status !== "succeeded" && input.observationIds.length > 0) {
    throw new StorageValidationError(
      "AUTO_ITEM_CONFLICT",
      `Auto item ${input.jobId}/${input.itemId} finished ${input.status} must not reference observations.`,
    );
  }
  if ((input.status === "succeeded" || input.status === "empty") && input.error) {
    throw new StorageValidationError(
      "AUTO_ITEM_CONFLICT",
      `Auto item ${input.jobId}/${input.itemId} finished ${input.status} must not carry an error.`,
    );
  }
  if (input.status === "failed" && !input.error) {
    throw new StorageValidationError(
      "AUTO_ITEM_CONFLICT",
      `Auto item ${input.jobId}/${input.itemId} failed without an error message.`,
    );
  }
  if (input.status === "succeeded") {
    // Completions reference observations, never embed them: every id must be
    // written before the completion that cites it.
    const written = await AutoObservationModel()
      .find(
        {
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          observationId: { $in: input.observationIds },
        },
        { observationId: 1 },
      )
      .lean();
    const writtenIds = new Set(written.map((doc) => doc.observationId));
    const missing = input.observationIds.filter((id) => !writtenIds.has(id));
    if (missing.length > 0) {
      throw new StorageValidationError(
        "AUTO_ITEM_CONFLICT",
        `Auto item ${input.jobId}/${input.itemId} references unwritten observations: ${missing.join(", ")}.`,
      );
    }
  }
  const now = new Date();
  const updated = await AutoWorkItemModel().findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      itemId: input.itemId,
      status: "running",
      ...ownershipClause(input.workerId, now),
    },
    {
      $set: {
        status: input.status,
        observationIds: input.observationIds,
        error: input.error ?? null,
        providerRequestId: input.providerRequestId ?? null,
        response: input.response ?? null,
        finishedAt: now,
        owner: null,
        leaseExpiresAt: null,
      },
    },
    { new: true },
  );
  if (updated) return { status: updated.status, deduplicated: false };
  const winner = await loseAutoItemRace(input.workspaceId, input.jobId, input.itemId);
  if (winner.status === "queued") {
    throw new StorageValidationError(
      "AUTO_ITEM_CONFLICT",
      `Auto item ${input.jobId}/${input.itemId} is queued; claim it before completing it.`,
    );
  }
  if (winner.status === "running") {
    throw new StorageValidationError(
      "AUTO_ITEM_CLAIMED",
      claimedMessage(`Auto item ${input.jobId}/${input.itemId}`, winner),
    );
  }
  if (!sameCompletion(winner, input)) {
    throw new StorageValidationError(
      "AUTO_ITEM_ALREADY_COMPLETE",
      `Auto item ${input.jobId}/${input.itemId} already finished as ${winner.status}; resume the job to retry it.`,
    );
  }
  return { status: winner.status, deduplicated: true };
}

// ---------------------------------------------------------------------------
// Observations (immutable once written; deduped by observationId).
// ---------------------------------------------------------------------------

export interface WriteAutoObservationsInput {
  workspaceId: string;
  jobId: string;
  itemId: string;
  imageId: string;
  concept: ValidatedAutoConcept;
  observations: ValidatedAutoObservation[];
}

function sameObservation(
  existing: AutoObservationDocument,
  incoming: ValidatedAutoObservation & {
    itemId: string;
    imageId: string;
    concept: ValidatedAutoConcept;
  },
): boolean {
  return (
    stableStringify({
      itemId: existing.itemId,
      imageId: existing.imageId,
      conceptId: existing.conceptId,
      prompt: existing.prompt,
      category: existing.category,
      box: existing.box,
      confidence: existing.confidence,
      anchor: existing.anchor,
      maskSupport: existing.maskSupport,
      maskArtifactId: existing.maskArtifactId ? String(existing.maskArtifactId) : null,
      ray: existing.ray,
      rayFailure: existing.rayFailure,
      nearSeam: existing.nearSeam,
      truncated: existing.truncated,
    }) ===
    stableStringify({
      itemId: incoming.itemId,
      imageId: incoming.imageId,
      conceptId: incoming.concept.conceptId,
      prompt: incoming.concept.text,
      category: incoming.concept.category,
      box: incoming.box,
      confidence: incoming.confidence,
      anchor: incoming.anchor,
      maskSupport: incoming.maskSupport,
      maskArtifactId: incoming.maskArtifactId,
      ray: incoming.ray,
      rayFailure: incoming.rayFailure,
      nearSeam: incoming.nearSeam,
      truncated: incoming.truncated,
    })
  );
}

function toObservationDoc(
  input: WriteAutoObservationsInput,
  observation: ValidatedAutoObservation,
): Omit<AutoObservationDocument, "createdAt" | "updatedAt"> {
  // No createdAt/updatedAt: see buildAutoItemDocs.
  return {
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    itemId: input.itemId,
    observationId: observation.observationId,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    imageId: input.imageId,
    conceptId: input.concept.conceptId,
    prompt: input.concept.text,
    category: input.concept.category,
    box: observation.box,
    confidence: observation.confidence,
    anchor: observation.anchor,
    maskSupport: observation.maskSupport,
    ray: observation.ray,
    rayFailure: observation.rayFailure,
    maskArtifactId: observation.maskArtifactId ? new Types.ObjectId(observation.maskArtifactId) : null,
    nearSeam: observation.nearSeam,
    truncated: observation.truncated,
  };
}

export async function writeAutoObservations(
  input: WriteAutoObservationsInput,
): Promise<{ written: number; deduplicated: number }> {
  if (input.observations.length === 0) return { written: 0, deduplicated: 0 };
  const ids = input.observations.map((observation) => observation.observationId);
  if (new Set(ids).size !== ids.length) {
    throw new StorageValidationError(
      "AUTO_OBSERVATION_CONFLICT",
      `Auto item ${input.jobId}/${input.itemId} wrote duplicate observation ids in one batch.`,
    );
  }
  // Atomic per-id upserts: concurrent writers converge (the unique index
  // serializes them) and the counts below are exact. A second pass compares
  // content so same-id/different-content still conflicts instead of hiding.
  const ops: mongoose.AnyBulkWriteOperation<AutoObservationDocument>[] = input.observations.map(
    (observation) => ({
      updateOne: {
        filter: {
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          observationId: observation.observationId,
        },
        update: { $setOnInsert: toObservationDoc(input, observation) },
        upsert: true,
      },
    }),
  );
  const bulk = await AutoObservationModel().bulkWrite(ops, { ordered: false });
  const stored = await AutoObservationModel()
    .find({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      observationId: { $in: ids },
    })
    .lean();
  const byId = new Map(stored.map((doc) => [doc.observationId, doc]));
  for (const observation of input.observations) {
    const match = byId.get(observation.observationId);
    if (
      !match ||
      !sameObservation(match, {
        ...observation,
        itemId: input.itemId,
        imageId: input.imageId,
        concept: input.concept,
      })
    ) {
      throw new StorageValidationError(
        "AUTO_OBSERVATION_CONFLICT",
        `Observation ${observation.observationId} already exists with different content.`,
      );
    }
  }
  return { written: bulk.upsertedCount, deduplicated: bulk.matchedCount };
}

// ---------------------------------------------------------------------------
// Candidates (wholesale replace per association run).
// ---------------------------------------------------------------------------

function candidateDocId(workspaceId: string, jobId: string, candidate: ValidatedAutoCandidate) {
  return { workspaceId, jobId, candidateId: candidate.candidateId };
}

export async function replaceAutoCandidates(input: {
  workspaceId: string;
  jobId: string;
  candidates: ValidatedAutoCandidate[];
}): Promise<{ count: number }> {
  const ids = input.candidates.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) {
    throw new StorageValidationError(
      "AUTO_CANDIDATE_CONFLICT",
      `Association produced duplicate candidate ids for job ${input.jobId}.`,
    );
  }
  // Candidates are derived data: every finalize recomputes the whole set, so
  // a crash between delete and insert self-heals on the next finalize.
  await AutoCandidateModel().deleteMany({ workspaceId: input.workspaceId, jobId: input.jobId });
  if (input.candidates.length === 0) return { count: 0 };
  await AutoCandidateModel().insertMany(
    input.candidates.map((candidate) => ({
      ...candidateDocId(input.workspaceId, input.jobId, candidate),
      schemaVersion: STORAGE_SCHEMA_VERSION,
      kind: candidate.kind,
      status: candidate.status,
      observationIds: candidate.observationIds,
      imageIds: candidate.imageIds,
      viewCount: candidate.viewCount,
      position: candidate.position,
      fit: candidate.fit,
      poleCandidateId: candidate.poleCandidateId,
      luminaireCandidateIds: candidate.luminaireCandidateIds,
      streetId: candidate.streetId,
      checks: candidate.checks,
      revision: 1,
    })),
    { ordered: true },
  );
  return { count: input.candidates.length };
}

// ---------------------------------------------------------------------------
// Results (one per job; immutable; deduped by full content).
// ---------------------------------------------------------------------------

export interface AutoResultInput {
  status: "detection-complete" | "inventory-complete";
  counts: Record<string, number>;
  locatedCandidateIds: string[];
  needsReviewCandidateIds: string[];
  unlocatedObservationIds: string[];
  unlocatedReasons: Record<string, string>;
  thresholds: Record<string, unknown>;
  model: string | null;
  planHash: string;
}

export function autoResultId(jobId: string): string {
  return `ar_${jobId}`;
}

function sameAutoResult(existing: AutoResultDocument, incoming: AutoResultInput): boolean {
  return (
    existing.status === incoming.status &&
    stableStringify(existing.counts) === stableStringify(incoming.counts) &&
    stableStringify(sortedIds(existing.locatedCandidateIds)) ===
      stableStringify(sortedIds(incoming.locatedCandidateIds)) &&
    stableStringify(sortedIds(existing.needsReviewCandidateIds)) ===
      stableStringify(sortedIds(incoming.needsReviewCandidateIds)) &&
    stableStringify(sortedIds(existing.unlocatedObservationIds)) ===
      stableStringify(sortedIds(incoming.unlocatedObservationIds)) &&
    stableStringify(existing.unlocatedReasons ?? {}) === stableStringify(incoming.unlocatedReasons) &&
    stableStringify(existing.thresholds) === stableStringify(incoming.thresholds) &&
    (existing.model ?? null) === (incoming.model ?? null) &&
    existing.planHash === incoming.planHash
  );
}

export async function publishAutoResult(input: {
  workspaceId: string;
  jobId: string;
  result: AutoResultInput;
}): Promise<{ resultId: string; deduplicated: boolean }> {
  const resultId = autoResultId(input.jobId);
  const existing = await AutoResultModel()
    .findOne({ workspaceId: input.workspaceId, jobId: input.jobId })
    .lean();
  if (existing) {
    if (!sameAutoResult(existing, input.result)) {
      throw new StorageValidationError(
        "AUTO_RESULT_EXISTS",
        `Auto job ${input.jobId} already published a different result.`,
      );
    }
    return { resultId: existing.resultId, deduplicated: true };
  }
  try {
    await AutoResultModel().create({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      resultId,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      ...input.result,
    });
    return { resultId, deduplicated: false };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await AutoResultModel()
      .findOne({ workspaceId: input.workspaceId, jobId: input.jobId })
      .lean();
    if (raced && sameAutoResult(raced, input.result)) {
      return { resultId: raced.resultId, deduplicated: true };
    }
    throw new StorageValidationError(
      "AUTO_RESULT_EXISTS",
      `Auto job ${input.jobId} already published a different result.`,
    );
  }
}

