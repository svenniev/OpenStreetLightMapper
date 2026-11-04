import { randomBytes } from "node:crypto";
import express from "express";
import { InputSnapshotModel, WorkspaceModel } from "../db/models.js";
import {
  STORAGE_SCHEMA_VERSION,
  StorageValidationError,
  validateExpectedRevision,
  validateSnapshotInput,
  validateWorkspaceInput,
} from "../db/validation.js";
import {
  isWorkspaceId,
  requireDb,
  sendCaughtStorageError,
  sendStorageError,
} from "./storageShared.js";

function newWorkspaceId(): string {
  return `ws_${randomBytes(8).toString("hex")}`;
}

const EMPTY_SELECTION = {};
const EMPTY_PREPARATION = { runState: "not_started", plan: null };

/**
 * Workspace routes: the durable unit the user reopens.
 *
 * GET /api/workspaces — list (identity + revision + timestamps, no blobs)
 * POST /api/workspaces — create {name?}
 * GET /api/workspaces/:workspaceId — full workspace document
 * PUT /api/workspaces/:workspaceId — {expectedRevision, workspace} (409 on mismatch)
 * POST /api/workspaces/:workspaceId/snapshots — immutable input snapshot (idempotent by snapshotId)
 * GET /api/workspaces/:workspaceId/snapshots/:snapshotId — one snapshot payload
 */
export function createWorkspacesRouter(): express.Router {
  const router = express.Router();

  router.get("/api/workspaces", async (_req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const docs = await WorkspaceModel()
        .find({}, { workspaceId: 1, name: 1, revision: 1, sessionKeys: 1, createdAt: 1, updatedAt: 1 })
        .sort({ updatedAt: -1 })
        .lean();
      res.json({
        workspaces: docs.map((doc) => ({
          workspaceId: doc.workspaceId,
          name: doc.name,
          revision: doc.revision,
          sessionCount: doc.sessionKeys.length,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        })),
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post("/api/workspaces", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawName = body.name;
      const name =
        rawName === undefined || rawName === null
          ? `Workspace ${new Date().toISOString().slice(0, 10)}`
          : String(rawName);
      if (name.length === 0 || name.length > 120) {
        throw new StorageValidationError(
          "STORAGE_BAD_REQUEST",
          "Workspace name must be a 1..120 character string.",
        );
      }
      const workspaceId = newWorkspaceId();
      const created = await WorkspaceModel().create({
        workspaceId,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        name,
        revision: 1,
        roi: null,
        imagerySnapshotId: null,
        imagerySelection: EMPTY_SELECTION,
        streetSnapshotId: null,
        streetSelection: EMPTY_SELECTION,
        preparation: EMPTY_PREPARATION,
        activeSessionKey: null,
        sessionKeys: [],
      });
      res.status(201).json({
        workspaceId: created.workspaceId,
        schemaVersion: created.schemaVersion,
        name: created.name,
        revision: created.revision,
        roi: null,
        imagerySnapshotId: null,
        imagerySelection: EMPTY_SELECTION,
        streetSnapshotId: null,
        streetSelection: EMPTY_SELECTION,
        preparation: EMPTY_PREPARATION,
        activeSessionKey: null,
        sessionKeys: [],
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const doc = await WorkspaceModel().findOne({ workspaceId }).lean();
      if (!doc) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      res.json({
        workspaceId: doc.workspaceId,
        schemaVersion: doc.schemaVersion,
        name: doc.name,
        revision: doc.revision,
        roi: doc.roi,
        imagerySnapshotId: doc.imagerySnapshotId,
        imagerySelection: doc.imagerySelection,
        streetSnapshotId: doc.streetSnapshotId,
        streetSelection: doc.streetSelection,
        preparation: doc.preparation,
        activeSessionKey: doc.activeSessionKey,
        sessionKeys: doc.sessionKeys,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.put("/api/workspaces/:workspaceId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expectedRevision = validateExpectedRevision(body);
      if (expectedRevision === null) {
        throw new StorageValidationError(
          "STORAGE_BAD_REQUEST",
          "Workspace updates require expectedRevision.",
        );
      }
      const workspace = validateWorkspaceInput(body.workspace);
      // Snapshot references must resolve: a workspace may not point at
      // snapshots that were never stored.
      for (const [field, snapshotId] of [
        ["imagerySnapshotId", workspace.imagerySnapshotId],
        ["streetSnapshotId", workspace.streetSnapshotId],
      ] as const) {
        if (snapshotId) {
          const snapshot = await InputSnapshotModel().findOne(
            { snapshotId, workspaceId },
            { _id: 1 },
          );
          if (!snapshot) {
            throw new StorageValidationError(
              "BROKEN_EVIDENCE_LINK",
              `Workspace ${field} references unknown snapshot ${snapshotId}.`,
            );
          }
        }
      }
      const updated = await WorkspaceModel().findOneAndUpdate(
        { workspaceId, revision: expectedRevision },
        {
          $set: {
            name: workspace.name,
            roi: workspace.roi,
            imagerySnapshotId: workspace.imagerySnapshotId,
            imagerySelection: workspace.imagerySelection,
            streetSnapshotId: workspace.streetSnapshotId,
            streetSelection: workspace.streetSelection,
            preparation: workspace.preparation,
            activeSessionKey: workspace.activeSessionKey,
            sessionKeys: workspace.sessionKeys,
          },
          $inc: { revision: 1 },
        },
        { new: true },
      );
      if (!updated) {
        const current = await WorkspaceModel().findOne(
          { workspaceId },
          { revision: 1, updatedAt: 1 },
        );
        if (!current) {
          sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
          return;
        }
        res.status(409).json({
          error: {
            code: "REVISION_CONFLICT",
            message: `Workspace changed elsewhere (stored revision ${current.revision}, expected ${expectedRevision}). Reload the newer version or save as a new workspace.`,
            retryable: false,
            currentRevision: current.revision,
            updatedAt: current.updatedAt,
          },
        });
        return;
      }
      res.json({ workspaceId: updated.workspaceId, revision: updated.revision });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.post("/api/workspaces/:workspaceId/snapshots", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const workspace = await WorkspaceModel().findOne({ workspaceId }, { _id: 1 });
      if (!workspace) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const input = validateSnapshotInput(req.body);
      const byteLength = Buffer.byteLength(JSON.stringify(input.payload), "utf8");
      const existing = await InputSnapshotModel().findOne({ snapshotId: input.snapshotId });
      if (existing) {
        if (existing.workspaceId !== workspaceId || existing.kind !== input.kind) {
          throw new StorageValidationError(
            "SNAPSHOT_CONFLICT",
            `Snapshot ${input.snapshotId} already exists with different ownership or kind.`,
          );
        }
        res.json({ snapshotId: existing.snapshotId, deduplicated: true });
        return;
      }
      await InputSnapshotModel().create({
        snapshotId: input.snapshotId,
        workspaceId,
        kind: input.kind,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        payload: input.payload,
        byteLength,
      });
      res.status(201).json({ snapshotId: input.snapshotId, deduplicated: false });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/workspaces/:workspaceId/snapshots/:snapshotId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const workspaceId = req.params.workspaceId ?? "";
      const snapshotId = req.params.snapshotId ?? "";
      if (!isWorkspaceId(workspaceId)) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown workspace.");
        return;
      }
      const doc = await InputSnapshotModel()
        .findOne({ snapshotId, workspaceId }, { snapshotId: 1, kind: 1, schemaVersion: 1, payload: 1 })
        .lean();
      if (!doc) {
        sendStorageError(res, "WORKSPACE_NOT_FOUND", "Unknown snapshot.");
        return;
      }
      res.json({
        snapshotId: doc.snapshotId,
        kind: doc.kind,
        schemaVersion: doc.schemaVersion,
        payload: doc.payload,
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  return router;
}
