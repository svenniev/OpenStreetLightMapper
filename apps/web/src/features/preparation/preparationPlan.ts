import type { StreetWorkItem } from "../../lib/api";
import type { StreetPlanItem } from "./preparationTypes";

/** 32-bit FNV-1a, hex-encoded. Deterministic across sessions for one input. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface FingerprintParts {
  roiRevision: number;
  streetSnapshotId: number;
  checkedIds: string[];
  imagerySnapshotId: number;
  /** Hash of the sorted in-RoI pool IDs (the pool behind the snapshot). */
  poolHash: string;
  discoveryWarnings: string[];
  streetWarnings: string[];
}

/**
 * Stable input fingerprint: identical inputs always yield the identical
 * fingerprint regardless of checkbox toggle order or pool ordering.
 */
export function computeInputFingerprint(parts: FingerprintParts): string {
  const canonical = JSON.stringify({
    roiRevision: parts.roiRevision,
    streetSnapshotId: parts.streetSnapshotId,
    checkedIds: [...parts.checkedIds].sort(),
    imagerySnapshotId: parts.imagerySnapshotId,
    poolHash: parts.poolHash,
    discoveryWarnings: [...parts.discoveryWarnings].sort(),
    streetWarnings: [...parts.streetWarnings].sort(),
  });
  return fnv1aHex(canonical);
}

/** Hash of the sorted pool IDs; empty pool hashes to a fixed value. */
export function hashPoolIds(imageIds: string[]): string {
  return fnv1aHex(JSON.stringify([...imageIds].sort()));
}

/**
 * Real per-street validation: the plan may only reference streets with a
 * usable identity, source ways, clipped geometry, and a finite length.
 * Returns a human-readable reason, or null when the street is usable.
 */
export function validateStreetForPlan(street: StreetWorkItem): string | null {
  if (typeof street.id !== "string" || street.id.length === 0) {
    return "missing street ID";
  }
  if (!Array.isArray(street.wayIds) || street.wayIds.length === 0) {
    return "no source OSM ways";
  }
  const geometry = street.geometry;
  if (
    !geometry ||
    geometry.type !== "MultiLineString" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length === 0 ||
    geometry.coordinates.some(
      (line) =>
        !Array.isArray(line) ||
        line.some(
          (point) =>
            !Array.isArray(point) ||
            point.length < 2 ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]),
        ),
    )
  ) {
    return "missing or invalid clipped geometry";
  }
  if (typeof street.lengthM !== "number" || !Number.isFinite(street.lengthM) || street.lengthM < 0) {
    return "invalid in-region length";
  }
  return null;
}

export function buildStreetPlanItem(street: StreetWorkItem): StreetPlanItem {
  return {
    streetId: street.id,
    displayName: street.displayName,
    wayIds: [...street.wayIds],
    lengthM: street.lengthM,
    imageAssociation: "pending",
  };
}

/** Shallow-deep freeze for plain snapshot data (objects and arrays). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) deepFreeze(record[key]);
    Object.freeze(value);
  }
  return value;
}
