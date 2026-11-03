/**
 * Result-view contracts. Completed inventory results have no production
 * producer yet (test fixtures only). Session preview payloads come from the
 * in-memory inventory workflow. Every payload is validated at this boundary;
 * stale or wrong-street payloads are refused, never shown as current. The two
 * contracts stay distinct: a preview is never a completed result.
 */

import type { SessionPreviewResult } from "../inventory/inventoryTypes";

export type AssetReviewState = "unreviewed" | "accepted" | "rejected";

export interface InventoryMeasurement {
  kind: string;
  value: number | null;
  unit: string | null;
}

export interface InventoryRecord {
  assetId: string;
  sourceImageIds: string[];
  reviewState: AssetReviewState;
  measurements: InventoryMeasurement[];
}

export interface StreetInventoryResult {
  streetId: string;
  streetDisplayName: string;
  wayIds: number[];
  roiRevision: number;
  runId: string;
  completedAt: string;
  records: InventoryRecord[];
  warnings: string[];
}

export interface ResultExpectation {
  streetId: string;
  roiRevision: number;
  runId: string;
}

export type ValidatedResult =
  | { ok: true; result: StreetInventoryResult }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function validateMeasurement(value: unknown): value is InventoryMeasurement {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== "string" || value.kind.length === 0) return false;
  if (value.value !== null && (typeof value.value !== "number" || !Number.isFinite(value.value)))
    return false;
  if (value.unit !== null && typeof value.unit !== "string") return false;
  return true;
}

function validateRecord(value: unknown): value is InventoryRecord {
  if (!isRecord(value)) return false;
  if (typeof value.assetId !== "string" || value.assetId.length === 0) return false;
  if (!isStringArray(value.sourceImageIds)) return false;
  if (value.reviewState !== "unreviewed" && value.reviewState !== "accepted" && value.reviewState !== "rejected")
    return false;
  if (!Array.isArray(value.measurements) || !value.measurements.every(validateMeasurement))
    return false;
  return true;
}

/**
 * Accepts only a well-formed completed result that matches the currently
 * open street and run. A legitimate completed result may contain zero
 * records; that is distinct from "no completed result".
 */
export function validateInventoryResult(
  payload: unknown,
  expected: ResultExpectation,
): ValidatedResult {
  if (!isRecord(payload)) return { ok: false, reason: "malformed result payload" };
  if (payload.streetId !== expected.streetId)
    return { ok: false, reason: "result is for a different street" };
  if (payload.roiRevision !== expected.roiRevision || payload.runId !== expected.runId)
    return { ok: false, reason: "result is for a different region revision or run" };
  if (typeof payload.streetDisplayName !== "string" || payload.streetDisplayName.length === 0)
    return { ok: false, reason: "malformed result payload" };
  if (
    !Array.isArray(payload.wayIds) ||
    !payload.wayIds.every((id) => typeof id === "number" && Number.isSafeInteger(id))
  )
    return { ok: false, reason: "malformed result payload" };
  if (typeof payload.completedAt !== "string" || payload.completedAt.length === 0)
    return { ok: false, reason: "malformed result payload" };
  if (!Array.isArray(payload.records) || !payload.records.every(validateRecord))
    return { ok: false, reason: "malformed inventory records" };
  if (!Array.isArray(payload.warnings) || !payload.warnings.every((w) => typeof w === "string"))
    return { ok: false, reason: "malformed result payload" };
  return {
    ok: true,
    result: {
      streetId: expected.streetId,
      streetDisplayName: payload.streetDisplayName as string,
      wayIds: [...(payload.wayIds as number[])],
      roiRevision: expected.roiRevision,
      runId: expected.runId,
      completedAt: payload.completedAt as string,
      records: [...(payload.records as InventoryRecord[])],
      warnings: [...(payload.warnings as string[])],
    },
  };
}

export interface PreviewExpectation {
  streetId: string;
  sessionId: string;
  roiRevision: number | null;
  runId: string | null;
  fingerprint: string | null;
}

function isPreviewAsset(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.assetId !== "string" || value.assetId.length === 0) return false;
  if (value.category !== "pole" && value.category !== "luminaire") return false;
  if (!isRecord(value.position) || typeof value.position.kind !== "string") return false;
  if (value.position.kind === "geographic") {
    if (typeof value.position.lng !== "number" || typeof value.position.lat !== "number") return false;
  }
  if (value.position.kind === "diagram") {
    if (typeof value.position.x !== "number" || typeof value.position.y !== "number") return false;
  }
  if (
    value.positionMethod !== "manual" &&
    value.positionMethod !== "inherited" &&
    value.positionMethod !== "unknown"
  )
    return false;
  if (!isStringArray(value.observationIds)) return false;
  if (!isStringArray(value.imageIds)) return false;
  if (value.reviewState !== "confirmed") return false;
  if (
    value.streetSource !== "osm" &&
    value.streetSource !== "manual-work-area" &&
    value.streetSource !== "synthetic-demo"
  )
    return false;
  return true;
}

export type ValidatedPreview =
  | { ok: true; preview: SessionPreviewResult }
  | { ok: false; reason: string };

/**
 * Accepts only a well-formed temporary session preview matching the current
 * street, session, and input context. Demo and manual payloads validate
 * through the same boundary with unmistakable mode labels at render time.
 */
export function validateSessionPreview(
  payload: unknown,
  expected: PreviewExpectation,
): ValidatedPreview {
  if (!isRecord(payload) || payload.kind !== "session-preview") {
    return { ok: false, reason: "not a session preview payload" };
  }
  if (payload.mode !== "demo" && payload.mode !== "manual") {
    return { ok: false, reason: "malformed preview payload" };
  }
  if (payload.streetId !== expected.streetId || payload.sessionId !== expected.sessionId) {
    return { ok: false, reason: "preview is for a different street or session" };
  }
  if (
    payload.roiRevision !== expected.roiRevision ||
    payload.runId !== expected.runId ||
    payload.fingerprint !== expected.fingerprint
  ) {
    return { ok: false, reason: "preview is for a different region revision or run" };
  }
  if (typeof payload.streetDisplayName !== "string" || payload.streetDisplayName.length === 0) {
    return { ok: false, reason: "malformed preview payload" };
  }
  if (typeof payload.finishedAt !== "string" || payload.finishedAt.length === 0) {
    return { ok: false, reason: "malformed preview payload" };
  }
  if (payload.temporary !== true) return { ok: false, reason: "malformed preview payload" };
  if (!Array.isArray(payload.assets) || !payload.assets.every(isPreviewAsset)) {
    return { ok: false, reason: "malformed preview assets" };
  }
  const counts = payload.counts;
  if (
    !isRecord(counts) ||
    ["poles", "luminaires", "placed", "unplaced", "deferred", "observations"].some(
      (key) => typeof counts[key] !== "number" || !Number.isInteger(counts[key]),
    )
  ) {
    return { ok: false, reason: "malformed preview payload" };
  }
  if (!Array.isArray(payload.limitations) || !payload.limitations.every((entry) => typeof entry === "string")) {
    return { ok: false, reason: "malformed preview payload" };
  }
  if (
    payload.streetSource !== "osm" &&
    payload.streetSource !== "manual-work-area" &&
    payload.streetSource !== "synthetic-demo"
  ) {
    return { ok: false, reason: "malformed preview payload" };
  }
  const origins = payload.origins;
  if (
    !Array.isArray(origins) ||
    !origins.every(
      (entry) => entry === "demo" || entry === "manual" || entry === "sam-text" || entry === "sam-assisted",
    )
  ) {
    return { ok: false, reason: "malformed preview payload" };
  }
  if (payload.model !== null && typeof payload.model !== "string") {
    return { ok: false, reason: "malformed preview payload" };
  }
  const processing = payload.processing;
  if (
    !isRecord(processing) ||
    ["views", "succeededViews", "failedViews", "unprocessedViews"].some(
      (key) => typeof processing[key] !== "number" || !Number.isInteger(processing[key]),
    ) ||
    !isStringArray(processing.concepts)
  ) {
    return { ok: false, reason: "malformed preview payload" };
  }
  return {
    ok: true,
    preview: {
      kind: "session-preview",
      mode: payload.mode as "demo" | "manual",
      sessionId: expected.sessionId,
      streetId: expected.streetId,
      streetDisplayName: payload.streetDisplayName as string,
      streetSource: payload.streetSource as SessionPreviewResult["streetSource"],
      origins: [...(origins as SessionPreviewResult["origins"])],
      model: payload.model as string | null,
      processing: {
        views: processing.views as number,
        succeededViews: processing.succeededViews as number,
        failedViews: processing.failedViews as number,
        unprocessedViews: processing.unprocessedViews as number,
        concepts: [...(processing.concepts as string[])],
      },
      roiRevision: expected.roiRevision,
      runId: expected.runId,
      fingerprint: expected.fingerprint,
      finishedAt: payload.finishedAt as string,
      assets: [...(payload.assets as SessionPreviewResult["assets"])],
      counts: { ...(payload.counts as SessionPreviewResult["counts"]) },
      limitations: [...(payload.limitations as string[])],
      temporary: true,
    },
  };
}
