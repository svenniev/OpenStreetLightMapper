import type express from "express";
import type mongoose from "mongoose";
import { activeConnection } from "../db/connection.js";
import { StorageValidationError, type StorageErrorCode } from "../db/validation.js";
import { errorBody } from "./errors.js";

const STATUS_BY_CODE: Record<StorageErrorCode, number> = {
  STORAGE_BAD_REQUEST: 400,
  STORAGE_SCHEMA_VERSION: 400,
  STORAGE_PAYLOAD_TOO_LARGE: 413,
  STORAGE_RECORD_LIMIT: 400,
  BROKEN_EVIDENCE_LINK: 400,
  BROKEN_SUPPORT_LINK: 400,
  CONTEXT_MIXING: 400,
  REVISION_CONFLICT: 409,
  SESSION_EXISTS: 409,
  SESSION_MODE_NOT_PERSISTED: 400,
  ITEM_CONFLICT: 409,
  ITEM_ALREADY_COMPLETE: 409,
  ITEM_CLAIMED: 409,
  ITEM_NOT_FOUND: 404,
  AUTO_JOB_NOT_FOUND: 404,
  AUTO_JOB_CONFLICT: 409,
  AUTO_PLAN_REJECTED: 400,
  AUTO_ITEM_NOT_FOUND: 404,
  AUTO_ITEM_CONFLICT: 409,
  AUTO_ITEM_ALREADY_COMPLETE: 409,
  AUTO_ITEM_CLAIMED: 409,
  AUTO_OBSERVATION_CONFLICT: 409,
  AUTO_CANDIDATE_NOT_FOUND: 404,
  AUTO_CANDIDATE_CONFLICT: 409,
  AUTO_RESULT_EXISTS: 409,
  AUTO_RESULT_NOT_FOUND: 404,
  RESULT_CONFLICT: 409,
  SNAPSHOT_CONFLICT: 409,
  WORKSPACE_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  DB_UNAVAILABLE: 503,
};

/** Send a typed storage error. Returns true (response sent). */
export function sendStorageError(
  res: express.Response,
  code: StorageErrorCode,
  message: string,
): boolean {
  res
    .status(STATUS_BY_CODE[code])
    .json(errorBody(code, message, code === "DB_UNAVAILABLE"));
  return true;
}

/** Active DB connection, or a 503 when the database is unavailable. */
export function requireDb(res: express.Response): mongoose.Connection | null {
  const connection = activeConnection();
  if (!connection) {
    sendStorageError(
      res,
      "DB_UNAVAILABLE",
      "Local database unavailable. Start it (infra/database/start.ps1) and retry the save.",
    );
    return null;
  }
  return connection;
}

/**
 * Map a thrown error to a storage response. Returns true when handled.
 * Unexpected errors become a sanitized 500 (no stack, no internals).
 */
export function sendCaughtStorageError(res: express.Response, error: unknown): boolean {
  if (error instanceof StorageValidationError) {
    sendStorageError(res, error.code, error.message);
    return true;
  }
  if (res.headersSent) return true;
  res
    .status(500)
    .json(
      errorBody("STORAGE_FAILED", "The database request failed unexpectedly.", true),
    );
  return true;
}

/** Workspace IDs are server-generated: ws_ + 16 hex characters. */
export function isWorkspaceId(value: string): boolean {
  return /^ws_[0-9a-f]{16}$/.test(value);
}
