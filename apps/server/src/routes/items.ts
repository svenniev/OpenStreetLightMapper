import express from "express";
import { Types } from "mongoose";
import { DetectionItemModel } from "../db/models.js";
import {
  STORAGE_SCHEMA_VERSION,
  StorageValidationError,
  checkClientId,
  validateItemClaim,
  validateItemCompletion,
  validateItemRegistration,
  validateOptionalOwner,
} from "../db/validation.js";
import {
  isWorkspaceId,
  requireDb,
  sendCaughtStorageError,
  sendStorageError,
} from "./storageShared.js";

const TERMINAL_STATUSES = new Set(["succeeded", "empty", "failed", "cancelled", "interrupted"]);
const TERMINAL_STATUS_LIST = [...TERMINAL_STATUSES];

interface ItemIdentity {
  workspaceId: string;
  sessionKey: string;
  runId: string;
  itemId: string;
}

/**
 * Ownership clause for conditional writes: unclaimed docs, docs this caller
 * owns, and docs whose lease expired are writable; anything else loses.
 */
function ownershipClause(owner: string | null, now: Date): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [{ owner: null }, { leaseExpiresAt: { $lt: now } }];
  if (owner) clauses.push({ owner });
  return { $or: clauses };
}

/** A lost race against a live claim: report the winner for re-reading. */
function sendClaimed(
  res: express.Response,
  identity: ItemIdentity,
  winner: { status: string; owner: string | null; leaseExpiresAt: Date | null },
): void {
  const lease = winner.leaseExpiresAt ? winner.leaseExpiresAt.toISOString() : "no expiry recorded";
  res.status(409).json({
    error: {
      code: "ITEM_CLAIMED",
      message:
        `Item ${identity.runId}/${identity.itemId} is claimed by ${winner.owner ?? "another worker"} ` +
        `until ${lease} (status ${winner.status}). Re-read the item instead of overwriting it.`,
      retryable: false,
      owner: winner.owner,
      leaseExpiresAt: winner.leaseExpiresAt ? winner.leaseExpiresAt.toISOString() : null,
      status: winner.status,
    },
  });
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

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
 * POST .../items/:runId/:itemId/claim — atomic claim with owner + lease
 * POST .../items/:runId/:itemId/complete — one terminal transition (idempotent)
 * POST .../items/:runId/:itemId/interrupt — mark a stranded item interrupted
 * GET .../sessions/:sessionKey/items — slim history, newest first, paginated
 * GET .../items/:runId/:itemId — one full item with parsed objects
 *
 * All mutations are atomic conditional updates: exactly one concurrent writer
 * wins, and every loser re-reads the winner instead of overwriting it.
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
      try {
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
        return;
      } catch (error) {
        // Lost a concurrent register race: re-read the winner like the
        // pre-check above instead of surfacing a 500.
        if (!isDuplicateKey(error)) throw error;
        const raced = await DetectionItemModel().findOne({
          workspaceId,
          sessionKey,
          runId: input.runId,
          itemId: input.itemId,
        });
        if (!raced) throw error;
        if (
          !sameRegistration(
            {
              kind: raced.kind,
              viewId: raced.viewId,
              conceptId: raced.conceptId,
              prompt: raced.prompt,
              artifactId: raced.artifactId,
            },
            input,
          )
        ) {
          throw new StorageValidationError(
            "ITEM_CONFLICT",
            `Item ${input.runId}/${input.itemId} is already registered with different input.`,
          );
        }
        res.json({ runId: raced.runId, itemId: raced.itemId, status: raced.status, deduplicated: true });
        return;
      }
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post(
    "/api/workspaces/:workspaceId/sessions/:sessionKey/items/:runId/:itemId/claim",
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
        const identity: ItemIdentity = { workspaceId, sessionKey, runId, itemId };
        const input = validateItemClaim(req.body);
        const now = new Date();
        // Atomic claim: exactly one concurrent claimant wins. Reclaims after an
        // expired lease count as a new attempt; the first claim does not.
        const updated = await DetectionItemModel().findOneAndUpdate(
          {
            ...identity,
            status: { $in: ["queued", "running"] },
            $or: [{ owner: null }, { owner: input.owner }, { leaseExpiresAt: { $lt: now } }],
          },
          [
            {
              $set: {
                status: "running",
                owner: input.owner,
                leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
                attempts: {
                  $cond: [{ $eq: ["$status", "queued"] }, "$attempts", { $add: ["$attempts", 1] }],
                },
              },
            },
          ],
          {
            new: true,
            projection: { runId: 1, itemId: 1, status: 1, owner: 1, leaseExpiresAt: 1, attempts: 1 },
          },
        );
        if (updated) {
          res.json({
            runId: updated.runId,
            itemId: updated.itemId,
            status: updated.status,
            owner: updated.owner,
            leaseExpiresAt: updated.leaseExpiresAt ? updated.leaseExpiresAt.toISOString() : null,
            attempts: updated.attempts,
          });
          return;
        }
        const winner = await DetectionItemModel().findOne(identity);
        if (!winner) {
          sendStorageError(res, "ITEM_NOT_FOUND", "Unknown item; register it before claiming it.");
          return;
        }
        if (TERMINAL_STATUSES.has(winner.status)) {
          throw new StorageValidationError(
            "ITEM_ALREADY_COMPLETE",
            `Item ${runId}/${itemId} already completed as ${winner.status}; claims apply to queued or running items.`,
          );
        }
        sendClaimed(res, identity, {
          status: winner.status,
          owner: winner.owner ?? null,
          leaseExpiresAt: winner.leaseExpiresAt ?? null,
        });
      } catch (error) {
        sendCaughtStorageError(res, error);
      }
    },
  );

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
        const identity: ItemIdentity = { workspaceId, sessionKey, runId, itemId };
        const input = validateItemCompletion(req.body);
        // Atomic terminal transition: one concurrent completer wins; a claim
        // owner completes its own item and the win clears the claim.
        const updated = await DetectionItemModel().findOneAndUpdate(
          {
            ...identity,
            status: { $nin: TERMINAL_STATUS_LIST },
            ...ownershipClause(input.owner, new Date()),
          },
          {
            $set: {
              status: input.status,
              objects: input.objects,
              ...(input.model ? { model: input.model } : {}),
              truncated: input.truncated,
              invalidDiscarded: input.invalidDiscarded,
              error: input.error,
              providerRequestId: input.providerRequestId,
              finishedAt: new Date(input.finishedAt),
              owner: null,
              leaseExpiresAt: null,
            },
          },
          { new: true },
        );
        if (updated) {
          res.json({ runId, itemId, status: updated.status, deduplicated: false });
          return;
        }
        const winner = await DetectionItemModel().findOne(identity);
        if (!winner) {
          sendStorageError(res, "ITEM_NOT_FOUND", "Unknown item; register it before completing it.");
          return;
        }
        if (!TERMINAL_STATUSES.has(winner.status)) {
          sendClaimed(res, identity, {
            status: winner.status,
            owner: winner.owner ?? null,
            leaseExpiresAt: winner.leaseExpiresAt ?? null,
          });
          return;
        }
        const same =
          winner.status === input.status &&
          JSON.stringify(winner.objects) === JSON.stringify(input.objects) &&
          winner.truncated === input.truncated &&
          winner.invalidDiscarded === input.invalidDiscarded &&
          (winner.error ?? null) === input.error;
        if (!same) {
          throw new StorageValidationError(
            "ITEM_ALREADY_COMPLETE",
            `Item ${runId}/${itemId} already completed as ${winner.status}; retry as a new attempt.`,
          );
        }
        res.json({ runId, itemId, status: winner.status, deduplicated: true });
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
        const identity: ItemIdentity = { workspaceId, sessionKey, runId, itemId };
        const owner = validateOptionalOwner(req.body);
        // Atomic interrupt: a live claim held by someone else stays untouched.
        const updated = await DetectionItemModel().findOneAndUpdate(
          {
            ...identity,
            status: { $nin: TERMINAL_STATUS_LIST },
            ...ownershipClause(owner, new Date()),
          },
          [
            {
              $set: {
                status: "interrupted",
                finishedAt: "$$NOW",
                owner: null,
                leaseExpiresAt: null,
                error: {
                  $ifNull: ["$error", "Interrupted by restart or navigation; not automatically retried."],
                },
              },
            },
          ],
          { new: true },
        );
        if (updated) {
          res.json({ runId, itemId, status: updated.status });
          return;
        }
        const winner = await DetectionItemModel().findOne(identity);
        if (!winner) {
          sendStorageError(res, "ITEM_NOT_FOUND", "Unknown item.");
          return;
        }
        // Idempotent: terminal items keep their outcome.
        if (TERMINAL_STATUSES.has(winner.status)) {
          res.json({ runId, itemId, status: winner.status });
          return;
        }
        sendClaimed(res, identity, {
          status: winner.status,
          owner: winner.owner ?? null,
          leaseExpiresAt: winner.leaseExpiresAt ?? null,
        });
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
