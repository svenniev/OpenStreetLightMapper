import { pointInRing, type LngLat } from "@openstreetlightmapper/geo";
import { MAPILLARY_SEARCH_LIMIT } from "./mapillary.js";

/**
 * Normalization of raw Mapillary image records into the search response.
 *
 * Defined processing order (diagnostic counts are reproducible):
 *   1. validate record fields (id + at least one coordinate)
 *   2. exact point-in-polygon test against the committed RoI (boundary included)
 *   3. deduplicate by image ID (first occurrence wins)
 *
 * Truncation is evaluated against the RAW upstream record count, before any
 * filtering or deduplication.
 */

export interface ImageResult {
  id: string;
  /** [longitude, latitude] search coordinate. */
  coordinate: [number, number];
  coordinateSource: "geometry" | "computed_geometry";
  originalCoordinate: [number, number] | null;
  computedCoordinate: [number, number] | null;
  /** Unix milliseconds, or null when unknown. */
  capturedAt: number | null;
  isPano: boolean | null;
  sequenceId: string | null;
}

export type RetrievalStatus = "not_capped" | "possibly_truncated";
export type SearchWarningCode = "POSSIBLY_TRUNCATED" | "INVALID_RECORDS_EXCLUDED";

export interface ProcessedSearch {
  images: ImageResult[];
  rawReturnedCount: number;
  matchedCount: number;
  invalidRecordCount: number;
  outsideRoiCount: number;
  duplicateCount: number;
  retrievalStatus: RetrievalStatus;
  warnings: SearchWarningCode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Accept a GeoJSON-ish point; return [lng, lat] or null. */
function readPoint(value: unknown): [number, number] | null {
  if (!isRecord(value) || !Array.isArray(value.coordinates)) return null;
  const [lng, lat] = value.coordinates as unknown[];
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    return null;
  }
  return [lng, lat];
}

function readId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  // Preserve IDs as strings even if a provider ever encodes one numerically.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readCapturedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Normal providers send ISO strings; tolerate epoch seconds or milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function readIsPano(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readSequenceId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export interface ProcessRecordsOptions {
  providerLimit?: number;
  hasMoreIndication?: boolean;
}

export function processProviderRecords(
  ring: LngLat[],
  rawRecords: unknown[],
  options?: ProcessRecordsOptions,
): ProcessedSearch {
  const providerLimit = options?.providerLimit ?? MAPILLARY_SEARCH_LIMIT;
  const rawReturnedCount = rawRecords.length;
  const seen = new Set<string>();
  const images: ImageResult[] = [];
  let invalidRecordCount = 0;
  let outsideRoiCount = 0;
  let duplicateCount = 0;

  for (const raw of rawRecords) {
    if (!isRecord(raw)) {
      invalidRecordCount += 1;
      continue;
    }
    const id = readId(raw.id);
    const originalCoordinate = readPoint(raw.geometry);
    const computedCoordinate = readPoint(raw.computed_geometry);
    // Prefer the original point; use the computed point only when original is unavailable.
    const coordinate = originalCoordinate ?? computedCoordinate;
    const coordinateSource = originalCoordinate ? "geometry" : "computed_geometry";
    if (id === null || coordinate === null) {
      invalidRecordCount += 1;
      continue;
    }
    if (!pointInRing(coordinate, ring)) {
      outsideRoiCount += 1;
      continue;
    }
    if (seen.has(id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(id);
    images.push({
      id,
      coordinate,
      coordinateSource,
      originalCoordinate,
      computedCoordinate,
      capturedAt: readCapturedAt(raw.captured_at),
      isPano: readIsPano(raw.is_pano),
      sequenceId: readSequenceId(raw.sequence),
    });
  }

  const retrievalStatus: RetrievalStatus =
    rawReturnedCount >= providerLimit || options?.hasMoreIndication
      ? "possibly_truncated"
      : "not_capped";
  const warnings: SearchWarningCode[] = [];
  if (retrievalStatus === "possibly_truncated") warnings.push("POSSIBLY_TRUNCATED");
  if (invalidRecordCount > 0) warnings.push("INVALID_RECORDS_EXCLUDED");

  return {
    images,
    rawReturnedCount,
    matchedCount: images.length,
    invalidRecordCount,
    outsideRoiCount,
    duplicateCount,
    retrievalStatus,
    warnings,
  };
}
