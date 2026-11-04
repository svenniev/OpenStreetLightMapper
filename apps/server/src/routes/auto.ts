import { randomBytes } from "node:crypto";
import express from "express";
import { InputSnapshotModel } from "../db/models.js";
import type { AutoCandidateStatus, AutoItemStatus, AutoJobDocument } from "../db/autoModels.js";
import {
  STORAGE_SCHEMA_VERSION,
  SNAPSHOT_JSON_BYTES_MAX,
  StorageValidationError,
  checkClientId,
  checkJsonBytes,
} from "../db/validation.js";
import {
  validateAutoImageMetadata,
  validateAutoPlanRequest,
  validateAutoPrepare,
  type ValidatedPlanImageMeta,
} from "../db/autoValidation.js";
import { matchPlanSeeds, resolveAutoPlan } from "../auto/plan.js";
import { fetchImageMetadata } from "../auto/mapillaryImage.js";
import {
  getAutoCandidateEvidence,
  getAutoItem,
  getAutoJob,
  getAutoJobProgress,
  getAutoResult,
  launchAutoJob,
  listAutoCandidates,
  listAutoItems,
  listAutoJobs,
  listAutoObservations,
  requestAutoStop,
  resumeAutoJob,
  retryAutoItem,
} from "../auto/store.js";
import { ClientAbortedError } from "../mapillary.js";
import { isSamConfigured } from "../sam.js";
import { abortOnDisconnect, errorBody, sendMapillaryError } from "./errors.js";
import {
  isWorkspaceId,
  requireDb,
  sendCaughtStorageError,
  sendStorageError,
} from "./storageShared.js";

export interface AutoRouterOptions {
  /** Override the Mapillary fetch implementation (tests inject a mock). */
  fetchImpl?: typeof fetch;
  /** Override the metadata fetch deadline (tests use short values). */
  mapillaryTimeoutMs?: number;
  /** Prompt the in-process worker to poll now (launch/resume/retry). */
  kickWorker?: () => void;
}

const ITEM_STATUSES: AutoItemStatus[] = [
  "queued",
  "running",
  "succeeded",
  "empty",
  "failed",
  "cancelled",
  "interrupted",
];

const CANDIDATE_STATUSES: AutoCandidateStatus[] = [
  "candidate",
  "located",
  "needs-review",
  "rejected",
];

function newPrepareId(): string {
  return `aprep_${randomBytes(8).toString("hex")}`;
}

function newJobId(): string {
  return `aj_${randomBytes(8).toString("hex")}`;
}

function readMapillaryToken(): string {
  return (process.env.MAPILLARY_ACCESS_TOKEN ?? "").trim();
}

function parseBoundedInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StorageValidationError("STORAGE_BAD_REQUEST", "Pagination cursors must be non-negative integers.");
  }
  return Math.min(parsed, max);
}

function checkWorkspaceId(res: express.Response, workspaceId: string): boolean {
  if (!isWorkspaceId(workspaceId)) {
    sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
    return false;
  }
  return true;
}

/**
 * Read-time limitation strings derived deterministically from the published
 * result's stored counts. Nothing here is inferred: every line names a
 * counted gap the run already recorded.
 */
export function buildResultLimitations(counts: Record<string, number>): string[] {
  const limitations: string[] = [];
  const failed = counts.failedItems ?? 0;
  const halted = counts.haltedItems ?? 0;
  const unlocated = counts.unlocatedObservations ?? 0;
  const duplicates = counts.duplicateGroups ?? 0;
  const streetsMissing = counts.streetSnapshotMissing ?? 0;
  const streetsSkipped = counts.streetLinesSkipped ?? 0;
  if (failed > 0) limitations.push(`${failed} items failed before producing output.`);
  if (halted > 0) limitations.push(`${halted} items halted before completion.`);
  if (unlocated > 0) limitations.push(`${unlocated} observations unlocated (see the Unlocated list).`);
  if (duplicates > 0) limitations.push(`${duplicates} possible-duplicate groups kept separate for review.`);
  if (streetsMissing > 0) {
    limitations.push(`${streetsMissing} assets lack street assignment: no street snapshot was provided.`);
  }
  if (streetsSkipped > 0) {
    limitations.push(`${streetsSkipped} streets skipped during assignment (missing or ambiguous geometry).`);
  }
  return limitations;
}

/**
 * Wire shape for one job (list and detail share it; detail adds the plan).
 * Must satisfy the web client's checkJobSummary: jobId, status, mode,
 * totalImages, estimatedCalls, callsMade, stopRequested, model, error,
 * resultId, createdAt, updatedAt.
 */
function toJobSummary(job: AutoJobDocument): Record<string, unknown> {
  const plan = job.plan as {
    mode: unknown;
    totalImages: unknown;
    estimatedCalls: unknown;
  };
  return {
    jobId: job.jobId,
    status: job.status,
    mode: plan.mode,
    totalImages: plan.totalImages,
    estimatedCalls: plan.estimatedCalls,
    callsMade: job.callsMade,
    stopRequested: job.stopRequested,
    model: job.model,
    error: job.error,
    resultId: job.resultId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Automatic mapping routes: prepare a bounded plan from an imagery snapshot,
 * launch it idempotently, and read/stop/resume the durable worker's output.
 *
 * POST   /api/workspaces/:workspaceId/auto/prepare — resolve+freeze a plan (no SAM calls)
 * POST   /api/workspaces/:workspaceId/auto/jobs — launch a prepared plan {prepareSnapshotId, idempotencyKey}
 * GET    /api/workspaces/:workspaceId/auto/jobs — list job summaries
 * GET    /api/workspaces/:workspaceId/auto/jobs/:jobId — job + derived progress
 * GET    /api/workspaces/:workspaceId/auto/jobs/:jobId/items — paginated items (responses excluded)
 * GET    /api/workspaces/:workspaceId/auto/jobs/:jobId/items/:itemId — one item, full detail
 * GET    /api/workspaces/:workspaceId/auto/jobs/:jobId/observations — paginated observations
 * GET    /api/workspaces/:workspaceId/auto/jobs/:jobId/candidates — candidates (?status=)
 * GET    /api/workspaces/:workspaceId/auto/jobs/:jobId/candidates/:candidateId/evidence — inspectable views+overlays
 * GET    /api/workspaces/:workspaceId/auto/jobs/:jobId/result — published result version
 * POST   /api/workspaces/:workspaceId/auto/jobs/:jobId/stop — stop after the current call settles
 * POST   /api/workspaces/:workspaceId/auto/jobs/:jobId/resume — explicit resume (no blanket retries)
 * POST   /api/workspaces/:workspaceId/auto/jobs/:jobId/items/:itemId/retry — explicit new attempt
 */
export function createAutoRouter(options?: AutoRouterOptions): express.Router {
  const router = express.Router();
  const kickWorker = options?.kickWorker ?? (() => {});

  router.post("/api/workspaces/:workspaceId/auto/prepare", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    const controller = new AbortController();
    const stopAbort = abortOnDisconnect(res, controller);
    try {
      const request = validateAutoPlanRequest(req.body ?? {});
      const snapshot = await InputSnapshotModel()
        .findOne({ workspaceId, snapshotId: request.snapshotId, kind: "imagery-discovery" })
        .lean();
      if (!snapshot) {
        sendStorageError(
          res,
          "AUTO_PLAN_REJECTED",
          `Unknown imagery snapshot ${request.snapshotId}; search Mapillary first, then re-prepare.`,
        );
        return;
      }
      if (request.streetSnapshotId) {
        const streets = await InputSnapshotModel()
          .findOne({ workspaceId, snapshotId: request.streetSnapshotId, kind: "street-snapshot" })
          .lean();
        if (!streets) {
          sendStorageError(
            res,
            "AUTO_PLAN_REJECTED",
            `Unknown street snapshot ${request.streetSnapshotId}; re-prepare without it or with a saved one.`,
          );
          return;
        }
      }
      let matched: Array<{ id: string; sequenceId: string }>;
      try {
        matched = matchPlanSeeds(request, snapshot.payload).matched;
      } catch (error) {
        sendStorageError(
          res,
          "AUTO_PLAN_REJECTED",
          `Imagery snapshot ${request.snapshotId} is corrupt; re-run the search. (${error instanceof Error ? error.message : "unreadable"})`,
        );
        return;
      }
      const token = readMapillaryToken();
      const metadata: ValidatedPlanImageMeta[] = [];
      const fetchWarnings: string[] = [];
      if (matched.length > 0 && token) {
        const fetched = await fetchImageMetadata(
          matched.map((seed) => seed.id),
          { token, fetchImpl: options?.fetchImpl, timeoutMs: options?.mapillaryTimeoutMs, signal: controller.signal },
        );
        for (const seed of matched) {
          const raw = fetched.found.get(seed.id);
          if (raw === undefined) continue; // resolveAutoPlan marks it metadata-unavailable.
          metadata.push(validateAutoImageMetadata(raw, seed.id, seed.sequenceId));
        }
      } else if (matched.length > 0 && !token) {
        fetchWarnings.push(
          `No Mapillary token on the server: all ${matched.length} images lack metadata. ` +
            `Set MAPILLARY_ACCESS_TOKEN and re-prepare, or run detect-only.`,
        );
      }
      const { plan, planHash } = resolveAutoPlan(request, snapshot.payload, metadata);
      const warnings = [...fetchWarnings, ...plan.warnings];
      const payload = { plan: { ...plan, warnings }, planHash, counts: plan.counts, warnings };
      checkJsonBytes(payload, SNAPSHOT_JSON_BYTES_MAX, "Auto prepare payload");
      const prepareSnapshotId = newPrepareId();
      await InputSnapshotModel().create({
        snapshotId: prepareSnapshotId,
        workspaceId,
        kind: "auto-prepare",
        schemaVersion: STORAGE_SCHEMA_VERSION,
        payload,
        byteLength: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      });
      const eligibleByImage = new Map(plan.images.map((image) => [image.imageId, image.eligible]));
      res.status(201).json({
        prepareSnapshotId,
        planHash,
        mode: plan.mode,
        totalImages: plan.totalImages,
        estimatedCalls: plan.estimatedCalls,
        minSpacingM: plan.minSpacingM,
        excludedOutsideRoi: plan.excludedOutsideRoi,
        thinnedBySpacing: plan.thinnedBySpacing,
        counts: plan.counts,
        warnings,
        perSequence: plan.perSequence.map((group) => ({
          sequenceId: group.sequenceId,
          imageCount: group.imageIds.length,
          eligibleCount: group.imageIds.filter((imageId) => eligibleByImage.get(imageId)).length,
        })),
      });
    } catch (error) {
      if (error instanceof ClientAbortedError) return;
      if (sendMapillaryError(res, error)) return;
      sendCaughtStorageError(res, error);
    } finally {
      stopAbort();
    }
  });

  router.post("/api/workspaces/:workspaceId/auto/jobs", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const prepareSnapshotId = checkClientId(body.prepareSnapshotId, "prepareSnapshotId");
      const idempotencyKey = checkClientId(body.idempotencyKey, "idempotencyKey");
      const prepared = await InputSnapshotModel()
        .findOne({ workspaceId, snapshotId: prepareSnapshotId, kind: "auto-prepare" })
        .lean();
      if (!prepared) {
        sendStorageError(
          res,
          "AUTO_PLAN_REJECTED",
          "Unknown prepare snapshot; re-prepare the run before launching.",
        );
        return;
      }
      const { plan, planHash } = validateAutoPrepare(prepared.payload);
      if (!readMapillaryToken()) {
        res
          .status(503)
          .json(
            errorBody(
              "MAPILLARY_NOT_CONFIGURED",
              "Mapillary is not configured on the server. Set MAPILLARY_ACCESS_TOKEN (see apps/server/.env.example).",
              false,
            ),
          );
        return;
      }
      if (!isSamConfigured()) {
        res
          .status(503)
          .json(
            errorBody(
              "SAM_NOT_CONFIGURED",
              "SAM detection is not configured on the server. Set MODEL_API_KEY (see apps/server/.env.example).",
              false,
            ),
          );
        return;
      }
      const { job, deduplicated } = await launchAutoJob({
        workspaceId,
        jobId: newJobId(),
        idempotencyKey,
        plan,
        planHash,
      });
      kickWorker();
      res.status(deduplicated ? 200 : 201).json({
        jobId: job.jobId,
        status: job.status,
        deduplicated,
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/auto/jobs", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const limit = parseBoundedInt(req.query.limit, 50, 100);
      const jobs = await listAutoJobs(workspaceId, limit);
      res.json({ jobs: jobs.map(toJobSummary) });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/auto/jobs/:jobId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const job = await getAutoJob(workspaceId, jobId);
      if (!job) {
        sendStorageError(res, "AUTO_JOB_NOT_FOUND", `Unknown auto job ${jobId}.`);
        return;
      }
      const progress = await getAutoJobProgress(workspaceId, jobId);
      res.json({ job: { ...toJobSummary(job), plan: job.plan }, progress });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/auto/jobs/:jobId/items", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const rawStatus = req.query.status;
      const status =
        rawStatus === undefined ? undefined : ITEM_STATUSES.find((entry) => entry === rawStatus);
      if (rawStatus !== undefined && !status) {
        sendStorageError(res, "STORAGE_BAD_REQUEST", `Unknown item status ${String(rawStatus)}.`);
        return;
      }
      const items = await listAutoItems(workspaceId, jobId, {
        status,
        limit: parseBoundedInt(req.query.limit, 100, 500),
        offset: parseBoundedInt(req.query.offset, 0, 100000),
      });
      // List responses stay light: full provider responses live on the item detail read.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- stripped deliberately.
      res.json({ items: items.map(({ response, ...rest }) => rest) });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/auto/jobs/:jobId/items/:itemId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const itemId = checkClientId(req.params.itemId, "itemId");
      const item = await getAutoItem(workspaceId, jobId, itemId);
      if (!item) {
        sendStorageError(res, "AUTO_ITEM_NOT_FOUND", `Unknown auto item ${jobId}/${itemId}.`);
        return;
      }
      res.json({ item });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/auto/jobs/:jobId/observations", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const observations = await listAutoObservations(workspaceId, jobId, {
        limit: parseBoundedInt(req.query.limit, 100, 500),
        offset: parseBoundedInt(req.query.offset, 0, 100000),
      });
      res.json({ observations });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/auto/jobs/:jobId/candidates", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const rawStatus = req.query.status;
      const status =
        rawStatus === undefined ? undefined : CANDIDATE_STATUSES.find((entry) => entry === rawStatus);
      if (rawStatus !== undefined && !status) {
        sendStorageError(res, "STORAGE_BAD_REQUEST", `Unknown candidate status ${String(rawStatus)}.`);
        return;
      }
      const candidates = await listAutoCandidates(workspaceId, jobId, { status });
      res.json({ candidates });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get(
    "/api/workspaces/:workspaceId/auto/jobs/:jobId/candidates/:candidateId/evidence",
    async (req, res) => {
      const connection = requireDb(res);
      if (!connection) return;
      const workspaceId = req.params.workspaceId ?? "";
      if (!checkWorkspaceId(res, workspaceId)) return;
      try {
        const jobId = checkClientId(req.params.jobId, "jobId");
        const candidateId = checkClientId(req.params.candidateId, "candidateId");
        const evidence = await getAutoCandidateEvidence(workspaceId, jobId, candidateId);
        if (!evidence) {
          sendStorageError(res, "AUTO_CANDIDATE_NOT_FOUND", `Unknown auto candidate ${jobId}/${candidateId}.`);
          return;
        }
        const itemsByImage = new Map<string, (typeof evidence.items)[number][]>();
        for (const item of evidence.items) {
          const group = itemsByImage.get(item.imageId) ?? [];
          group.push(item);
          itemsByImage.set(item.imageId, group);
        }
        const asPositiveInt = (value: unknown): number | null =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
        const images = evidence.candidate.imageIds.map((imageId) => {
          const group = itemsByImage.get(imageId) ?? [];
          // Prefer the item that actually stored view bytes (retried items share the image).
          const item = group.find((entry) => entry.artifactId !== null) ?? group[0] ?? null;
          const descriptor = (item?.viewDescriptor ?? {}) as Record<string, unknown>;
          return {
            imageId,
            viewArtifactId: item?.artifactId ? String(item.artifactId) : null,
            width: asPositiveInt(descriptor.width),
            height: asPositiveInt(descriptor.height),
          };
        });
        const observations = evidence.observations.map((observation) => {
          const anchor = (observation.anchor ?? {}) as Record<string, unknown>;
          const uPx = typeof anchor.uPx === "number" && Number.isFinite(anchor.uPx) ? anchor.uPx : null;
          const vPx = typeof anchor.vPx === "number" && Number.isFinite(anchor.vPx) ? anchor.vPx : null;
          const support = (observation.maskSupport ?? {}) as Record<string, unknown>;
          const bounds = (support.bounds ?? {}) as Record<string, unknown>;
          const [left, top, right, bottom] = [bounds.left, bounds.top, bounds.right, bounds.bottom].map(
            (edge) => (typeof edge === "number" && Number.isFinite(edge) ? edge : null),
          );
          return {
            observationId: observation.observationId,
            imageId: observation.imageId,
            box: observation.box,
            confidence:
              typeof observation.confidence === "number" && Number.isFinite(observation.confidence)
                ? observation.confidence
                : null,
            anchor: uPx === null || vPx === null ? null : { uPx, vPx },
            maskArtifactId: observation.maskArtifactId ? String(observation.maskArtifactId) : null,
            maskBounds:
              left === null || top === null || right === null || bottom === null
                ? null
                : { left, top, right, bottom },
          };
        });
        res.json({
          candidateId: evidence.candidate.candidateId,
          truncated: evidence.truncated,
          images,
          observations,
        });
      } catch (error) {
        sendCaughtStorageError(res, error);
      }
    },
  );

  router.get("/api/workspaces/:workspaceId/auto/jobs/:jobId/result", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const result = await getAutoResult(workspaceId, jobId);
      if (!result) {
        sendStorageError(res, "AUTO_RESULT_NOT_FOUND", `Auto job ${jobId} has no published result yet.`);
        return;
      }
      res.json({ result: { ...result, limitations: buildResultLimitations(result.counts ?? {}) } });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post("/api/workspaces/:workspaceId/auto/jobs/:jobId/stop", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const outcome = await requestAutoStop({ workspaceId, jobId });
      res.json(outcome);
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post("/api/workspaces/:workspaceId/auto/jobs/:jobId/resume", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const outcome = await resumeAutoJob({ workspaceId, jobId });
      kickWorker();
      res.json(outcome);
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post("/api/workspaces/:workspaceId/auto/jobs/:jobId/items/:itemId/retry", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    const workspaceId = req.params.workspaceId ?? "";
    if (!checkWorkspaceId(res, workspaceId)) return;
    try {
      const jobId = checkClientId(req.params.jobId, "jobId");
      const itemId = checkClientId(req.params.itemId, "itemId");
      const outcome = await retryAutoItem({ workspaceId, jobId, itemId });
      kickWorker();
      res.json(outcome);
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  return router;
}
