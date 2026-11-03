import { pointInRing, type LngLat } from "@openstreetlightmapper/geo";
import { MAPILLARY_SEARCH_LIMIT } from "./mapillary.js";
import { normalizeImageRecord, type ImageResult } from "./records.js";

export type { ImageResult };

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
    const normalized = normalizeImageRecord(raw);
    if (normalized === null) {
      invalidRecordCount += 1;
      continue;
    }
    if (!pointInRing(normalized.coordinate, ring)) {
      outsideRoiCount += 1;
      continue;
    }
    if (seen.has(normalized.id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(normalized.id);
    images.push(normalized);
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
