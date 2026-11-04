import express from "express";
import { artifactsExist } from "../db/artifacts.js";
import { InventoryResultModel, InventorySessionModel } from "../db/models.js";
import {
  STORAGE_SCHEMA_VERSION,
  StorageValidationError,
  checkClientId,
  validateExpectedRevision,
  validateResultInput,
  validateSessionInput,
} from "../db/validation.js";
import {
  isWorkspaceId,
  requireDb,
  sendCaughtStorageError,
  sendStorageError,
} from "./storageShared.js";

function sessionResponse(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceId: doc.workspaceId,
    sessionKey: doc.sessionKey,
    sessionId: doc.sessionId,
    schemaVersion: doc.schemaVersion,
    revision: doc.revision,
    session: {
      schemaVersion: doc.schemaVersion,
      key: doc.sessionKey,
      sessionId: doc.sessionId,
      mode: doc.mode,
      context: doc.context,
      activeStep: doc.activeStep,
      detection: doc.detection,
      observations: doc.observations,
      assets: doc.assets,
      obsOrder: doc.obsOrder,
      assetOrder: doc.assetOrder,
      obsCounter: doc.obsCounter,
      assetCounter: doc.assetCounter,
      sources: doc.sources,
      views: doc.views,
      viewOrder: doc.viewOrder,
      manifest: doc.manifest,
      concepts: doc.concepts,
      conceptCounter: doc.conceptCounter,
      runs: doc.runs,
      runCounter: doc.runCounter,
      stagedTest: doc.stagedTest,
      finishedPreview: doc.finishedPreview,
      savedResultRefs: doc.savedResultRefs,
      draftAfterResult: doc.draftAfterResult,
    },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Session and reviewed-result routes (one atomic document per session, so a
 * merge/split is a single revision-guarded update).
 *
 * GET /api/workspaces/:workspaceId/sessions/:sessionKey — full session
 * PUT /api/workspaces/:workspaceId/sessions/:sessionKey — {expectedRevision|null, session}
 * POST /api/workspaces/:workspaceId/sessions/:sessionKey/results — immutable result (idempotent by resultId)
 * GET .../results — version list, newest first
 * GET .../results/:resultId — one full result
 */
export function createSessionsRouter(): express.Router {
  const router = express.Router();

  router.get("/api/workspaces/:workspaceId/sessions/:sessionKey", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const doc = await InventorySessionModel().findOne({ workspaceId, sessionKey }).lean();
      if (!doc) {
        sendStorageError(res, "SESSION_NOT_FOUND", "Unknown session.");
        return;
      }
      res.json(sessionResponse(doc as unknown as Record<string, unknown>));
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.put("/api/workspaces/:workspaceId/sessions/:sessionKey", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expectedRevision = validateExpectedRevision(body);
      const { session, artifactIds } = validateSessionInput(body.session);
      if ((session.key as string) !== sessionKey) {
        throw new StorageValidationError(
          "STORAGE_BAD_REQUEST",
          "Session key in the URL does not match the session body.",
        );
      }
      const found = await artifactsExist(connection, artifactIds);
      const missing = artifactIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new StorageValidationError(
          "BROKEN_EVIDENCE_LINK",
          `Session references ${missing.length} unknown evidence artifact${missing.length === 1 ? "" : "s"} ` +
            `(${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}). Upload evidence first.`,
        );
      }
      if (expectedRevision === null) {
        const existing = await InventorySessionModel().findOne(
          { workspaceId, sessionKey },
          { _id: 1 },
        );
        if (existing) {
          throw new StorageValidationError(
            "SESSION_EXISTS",
            "Session already exists; update it with its expectedRevision.",
          );
        }
        await InventorySessionModel().create({
          workspaceId,
          sessionKey,
          sessionId: session.sessionId,
          schemaVersion: STORAGE_SCHEMA_VERSION,
          revision: 1,
          mode: session.mode,
          context: session.context,
          activeStep: session.activeStep,
          detection: session.detection,
          observations: session.observations,
          assets: session.assets,
          obsOrder: session.obsOrder,
          assetOrder: session.assetOrder,
          obsCounter: session.obsCounter,
          assetCounter: session.assetCounter,
          sources: session.sources,
          views: session.views,
          viewOrder: session.viewOrder,
          manifest: session.manifest,
          concepts: session.concepts,
          conceptCounter: session.conceptCounter,
          runs: session.runs,
          runCounter: session.runCounter,
          stagedTest: session.stagedTest,
          finishedPreview: session.finishedPreview,
          savedResultRefs: (session.savedResultRefs as unknown[] | undefined) ?? [],
          draftAfterResult: (session.draftAfterResult as boolean | undefined) ?? false,
        });
        res.status(201).json({ workspaceId, sessionKey, revision: 1 });
        return;
      }
      const updated = await InventorySessionModel().findOneAndUpdate(
        { workspaceId, sessionKey, revision: expectedRevision },
        {
          $set: {
            sessionId: session.sessionId,
            mode: session.mode,
            context: session.context,
            activeStep: session.activeStep,
            detection: session.detection,
            observations: session.observations,
            assets: session.assets,
            obsOrder: session.obsOrder,
            assetOrder: session.assetOrder,
            obsCounter: session.obsCounter,
            assetCounter: session.assetCounter,
            sources: session.sources,
            views: session.views,
            viewOrder: session.viewOrder,
            manifest: session.manifest,
            concepts: session.concepts,
            conceptCounter: session.conceptCounter,
            runs: session.runs,
            runCounter: session.runCounter,
            stagedTest: session.stagedTest,
            finishedPreview: session.finishedPreview,
            savedResultRefs: (session.savedResultRefs as unknown[] | undefined) ?? [],
            draftAfterResult: (session.draftAfterResult as boolean | undefined) ?? false,
          },
          $inc: { revision: 1 },
        },
        { new: true, projection: { revision: 1, updatedAt: 1 } },
      );
      if (!updated) {
        const current = await InventorySessionModel().findOne(
          { workspaceId, sessionKey },
          { revision: 1, updatedAt: 1 },
        );
        if (!current) {
          sendStorageError(res, "SESSION_NOT_FOUND", "Unknown session.");
          return;
        }
        res.status(409).json({
          error: {
            code: "REVISION_CONFLICT",
            message:
              `Session changed elsewhere (stored revision ${current.revision}, expected ${expectedRevision}). ` +
              `Reload the newer version or save as a new workspace.`,
            retryable: false,
            currentRevision: current.revision,
            updatedAt: current.updatedAt,
          },
        });
        return;
      }
      res.json({ workspaceId, sessionKey, revision: updated.revision });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post("/api/workspaces/:workspaceId/sessions/:sessionKey/results", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const session = await InventorySessionModel().findOne(
        { workspaceId, sessionKey },
        { _id: 1, revision: 1 },
      );
      if (!session) {
        sendStorageError(res, "SESSION_NOT_FOUND", "Unknown session.");
        return;
      }
      const input = validateResultInput(req.body);
      const found = await artifactsExist(connection, input.artifactIds);
      const missing = input.artifactIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new StorageValidationError(
          "BROKEN_EVIDENCE_LINK",
          `Result references ${missing.length} unknown evidence artifact${missing.length === 1 ? "" : "s"}. Upload evidence first.`,
        );
      }
      const existing = await InventoryResultModel().findOne({ resultId: input.resultId });
      if (existing) {
        const same =
          existing.workspaceId === workspaceId &&
          existing.sessionKey === sessionKey &&
          existing.sessionRevision === input.sessionRevision &&
          (existing.inputRevision ?? null) === input.inputRevision &&
          JSON.stringify(existing.counts) === JSON.stringify(input.counts) &&
          JSON.stringify(existing.limitations) === JSON.stringify(input.limitations) &&
          JSON.stringify(existing.provenance) === JSON.stringify(input.provenance) &&
          JSON.stringify(existing.snapshot) === JSON.stringify(input.snapshot) &&
          JSON.stringify(existing.artifactIds) === JSON.stringify(input.artifactIds);
        if (!same) {
          throw new StorageValidationError(
            "RESULT_CONFLICT",
            `Result ${input.resultId} already exists with different content.`,
          );
        }
        res.json({ resultId: existing.resultId, deduplicated: true });
        return;
      }
      // Pin the result to the acknowledged revision: content built from newer
      // edits must not attach to an older revision. Idempotent retries of an
      // already-created result pass through the check above.
      if (session.revision !== input.sessionRevision) {
        res.status(409).json({
          error: {
            code: "REVISION_CONFLICT",
            message:
              `Session changed since this result was built (stored revision ${session.revision}, ` +
              `result claims ${input.sessionRevision}). Re-save the session and retry with a fresh result.`,
            retryable: false,
            currentRevision: session.revision,
          },
        });
        return;
      }
      const created = await InventoryResultModel().create({
        resultId: input.resultId,
        workspaceId,
        sessionKey,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        sessionRevision: input.sessionRevision,
        inputRevision: input.inputRevision,
        counts: input.counts,
        limitations: input.limitations,
        provenance: input.provenance,
        snapshot: input.snapshot,
        artifactIds: input.artifactIds,
      });
      res.status(201).json({ resultId: created.resultId, deduplicated: false });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/sessions/:sessionKey/results", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const docs = await InventoryResultModel()
        .find(
          { workspaceId, sessionKey },
          { resultId: 1, sessionRevision: 1, inputRevision: 1, counts: 1, createdAt: 1 },
        )
        .sort({ createdAt: -1 })
        .lean();
      res.json({
        results: docs.map((doc) => ({
          resultId: doc.resultId,
          sessionRevision: doc.sessionRevision,
          inputRevision: doc.inputRevision,
          counts: doc.counts,
          createdAt: doc.createdAt,
        })),
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/sessions/:sessionKey/results/:resultId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const resultId = checkClientId(req.params.resultId, "resultId");
      const doc = await InventoryResultModel().findOne({ resultId, workspaceId, sessionKey }).lean();
      if (!doc) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown result.");
        return;
      }
      res.json({
        resultId: doc.resultId,
        workspaceId: doc.workspaceId,
        sessionKey: doc.sessionKey,
        schemaVersion: doc.schemaVersion,
        sessionRevision: doc.sessionRevision,
        inputRevision: doc.inputRevision,
        counts: doc.counts,
        limitations: doc.limitations,
        provenance: doc.provenance,
        snapshot: doc.snapshot,
        artifactIds: doc.artifactIds,
        createdAt: doc.createdAt,
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  return router;
}
