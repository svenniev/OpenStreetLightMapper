import express from "express";
import { Types } from "mongoose";
import { DetectionItemModel } from "../db/models.js";
import {
  STORAGE_SCHEMA_VERSION,
  StorageValidationError,
  checkClientId,
  validateItemCompletion,
  validateItemRegistration,
} from "../db/validation.js";
import {
  isWorkspaceId,
  requireDb,
  sendCaughtStorageError,
  sendStorageError,
} from "./storageShared.js";

const TERMINAL_STATUSES = new Set(["succeeded", "empty", "failed", "cancelled", "interrupted"]);

function sameRegistration(
  existing: { kind: string; viewId: string; conceptId: string; prompt: string; artifactId: string },
  input: { kind: string; viewId: string; conceptId: string; prompt: string; artifactId: string },
): boolean {
  return (
    existing.kind === input.kind &&
    existing.viewId === input.viewId &&
    existing.conceptId === input.conceptId &&
    existing.prompt === input.prompt &&
    existing.artifactId === input.artifactId
  );
}

function slimItem(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: doc.runId,
    itemId: doc.itemId,
    kind: doc.kind,
    viewId: doc.viewId,
    conceptId: doc.conceptId,
    prompt: doc.prompt,
    categoryIntent: doc.categoryIntent,
    model: doc.model,
    artifactId: doc.artifactId,
    supersedes: doc.supersedes,
    status: doc.status,
    objectCount: Array.isArray(doc.objects) ? (doc.objects as unknown[]).length : 0,
    truncated: doc.truncated,
    invalidDiscarded: doc.invalidDiscarded,
    attempts: doc.attempts,
    error: doc.error,
    providerRequestId: doc.providerRequestId,
    registeredAt: doc.registeredAt,
    finishedAt: doc.finishedAt,
  };
}

function fullItem(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    ...slimItem(doc),
    viewDescriptor: doc.viewDescriptor,
    objects: doc.objects,
  };
}

/**
 * Detection-item routes: immutable inference records with attempt links.
 *
 * POST .../sessions/:sessionKey/items — register (idempotent by runId+itemId)
 * POST .../items/:runId/:itemId/complete — one terminal transition (idempotent)
 * POST .../items/:runId/:itemId/interrupt — mark a stranded item interrupted
 * GET .../sessions/:sessionKey/items — slim history, newest first, paginated
 * GET .../items/:runId/:itemId — one full item with parsed objects
 */
export function createItemsRouter(): express.Router {
  const router = express.Router();

  router.post("/api/workspaces/:workspaceId/sessions/:sessionKey/items", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const input = validateItemRegistration(req.body);
      const existing = await DetectionItemModel().findOne({
        workspaceId,
        sessionKey,
        runId: input.runId,
        itemId: input.itemId,
      });
      if (existing) {
        if (
          !sameRegistration(
            {
              kind: existing.kind,
              viewId: existing.viewId,
              conceptId: existing.conceptId,
              prompt: existing.prompt,
              artifactId: existing.artifactId,
            },
            input,
          )
        ) {
          throw new StorageValidationError(
            "ITEM_CONFLICT",
            `Item ${input.runId}/${input.itemId} is already registered with different input.`,
          );
        }
        res.json({ runId: existing.runId, itemId: existing.itemId, status: existing.status, deduplicated: true });
        return;
      }
      // Attempt links must resolve: a retry names the item it supersedes.
      if (input.supersedes) {
        const prior = await DetectionItemModel().findOne(
          { workspaceId, sessionKey, runId: input.runId, itemId: input.supersedes },
          { _id: 1 },
        );
        if (!prior) {
          throw new StorageValidationError(
            "ITEM_NOT_FOUND",
            `Superseded item ${input.runId}/${input.supersedes} is unknown.`,
          );
        }
      }
      const created = await DetectionItemModel().create({
        workspaceId,
        sessionKey,
        runId: input.runId,
        itemId: input.itemId,
        kind: input.kind,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        viewId: input.viewId,
        conceptId: input.conceptId,
        prompt: input.prompt,
        categoryIntent: input.categoryIntent,
        model: input.model,
        viewDescriptor: input.viewDescriptor,
        artifactId: input.artifactId,
        supersedes: input.supersedes,
        status: "queued",
        objects: [],
        truncated: false,
        invalidDiscarded: 0,
        attempts: 1,
        error: null,
        providerRequestId: null,
        registeredAt: new Date(),
        finishedAt: null,
      });
      res
        .status(201)
        .json({ runId: created.runId, itemId: created.itemId, status: created.status, deduplicated: false });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post(
    "/api/workspaces/:workspaceId/sessions/:sessionKey/items/:runId/:itemId/complete",
    async (req, res) => {
      const connection = requireDb(res);
      if (!connection) return;
      try {
        const workspaceId = req.params.workspaceId ?? "";
        if (!isWorkspaceId(workspaceId)) {
          sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
          return;
        }
        const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
        const runId = checkClientId(req.params.runId, "runId");
        const itemId = checkClientId(req.params.itemId, "itemId");
        const input = validateItemCompletion(req.body);
        const existing = await DetectionItemModel().findOne({ workspaceId, sessionKey, runId, itemId });
        if (!existing) {
          sendStorageError(res, "ITEM_NOT_FOUND", "Unknown item; register it before completing it.");
          return;
        }
        if (TERMINAL_STATUSES.has(existing.status)) {
          const same =
            existing.status === input.status &&
            JSON.stringify(existing.objects) === JSON.stringify(input.objects) &&
            existing.truncated === input.truncated &&
            existing.invalidDiscarded === input.invalidDiscarded &&
            (existing.error ?? null) === input.error;
          if (!same) {
            throw new StorageValidationError(
              "ITEM_ALREADY_COMPLETE",
              `Item ${runId}/${itemId} already completed as ${existing.status}; retry as a new attempt.`,
            );
          }
          res.json({ runId, itemId, status: existing.status, deduplicated: true });
          return;
        }
        existing.status = input.status;
        existing.objects = input.objects as unknown as Record<string, unknown>[];
        // `set`: `model` is also a Document method, so direct assignment collides.
        if (input.model) existing.set("model", input.model);
        existing.truncated = input.truncated;
        existing.invalidDiscarded = input.invalidDiscarded;
        existing.error = input.error;
        existing.providerRequestId = input.providerRequestId;
        existing.finishedAt = new Date(input.finishedAt);
        await existing.save();
        res.json({ runId, itemId, status: existing.status, deduplicated: false });
      } catch (error) {
        sendCaughtStorageError(res, error);
      }
    },
  );

  router.post(
    "/api/workspaces/:workspaceId/sessions/:sessionKey/items/:runId/:itemId/interrupt",
    async (req, res) => {
      const connection = requireDb(res);
      if (!connection) return;
      try {
        const workspaceId = req.params.workspaceId ?? "";
        if (!isWorkspaceId(workspaceId)) {
          sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
          return;
        }
        const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
        const runId = checkClientId(req.params.runId, "runId");
        const itemId = checkClientId(req.params.itemId, "itemId");
        const existing = await DetectionItemModel().findOne({ workspaceId, sessionKey, runId, itemId });
        if (!existing) {
          sendStorageError(res, "ITEM_NOT_FOUND", "Unknown item.");
          return;
        }
        // Idempotent: terminal items keep their outcome; stranded items are
        // recorded as interrupted (never auto-retried).
        if (!TERMINAL_STATUSES.has(existing.status)) {
          existing.status = "interrupted";
          existing.finishedAt = new Date();
          if (!existing.error) existing.error = "Interrupted by restart or navigation; not automatically retried.";
          await existing.save();
        }
        res.json({ runId, itemId, status: existing.status });
      } catch (error) {
        sendCaughtStorageError(res, error);
      }
    },
  );

  router.get("/api/workspaces/:workspaceId/sessions/:sessionKey/items", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const rawLimit = req.query.limit;
      const limit = rawLimit === undefined ? 100 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new StorageValidationError("STORAGE_BAD_REQUEST", "limit must be an integer 1..500.");
      }
      const rawRunId = req.query.runId;
      const filter: Record<string, unknown> = { workspaceId, sessionKey };
      if (rawRunId !== undefined) filter.runId = checkClientId(String(rawRunId), "runId");
      const rawCursor = req.query.cursor;
      if (rawCursor !== undefined) {
        const cursor = String(rawCursor);
        if (!Types.ObjectId.isValid(cursor)) {
          throw new StorageValidationError("STORAGE_BAD_REQUEST", "cursor must be an item page cursor.");
        }
        filter._id = { $lt: new Types.ObjectId(cursor) };
      }
      const docs = await DetectionItemModel()
        .find(filter, { viewDescriptor: 0, objects: 0 })
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const page = docs.slice(0, limit);
      const nextCursor =
        docs.length > limit ? String(page[page.length - 1]._id) : null;
      res.json({
        items: page.map((doc) => slimItem(doc as unknown as Record<string, unknown>)),
        nextCursor,
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/sessions/:sessionKey/items/:runId/:itemId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const sessionKey = checkClientId(req.params.sessionKey, "sessionKey");
      const runId = checkClientId(req.params.runId, "runId");
      const itemId = checkClientId(req.params.itemId, "itemId");
      const doc = await DetectionItemModel().findOne({ workspaceId, sessionKey, runId, itemId }).lean();
      if (!doc) {
        sendStorageError(res, "ITEM_NOT_FOUND", "Unknown item.");
        return;
      }
      res.json(fullItem(doc as unknown as Record<string, unknown>));
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  return router;
}
