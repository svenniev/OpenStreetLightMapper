/**
 * Shared Mapillary image-record normalization for seed discovery and
 * sequence hydration. One implementation so both paths validate identically:
 * original coordinate first, computed only as fallback; IDs as strings
 * (safe integers only); unknown metadata stays null; never invent locations.
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Accept a GeoJSON-ish point; return [lng, lat] or null. */
export function readPoint(value: unknown): [number, number] | null {
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

export function readId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  // Preserve IDs as strings when a provider encodes one numerically, but only
  // for safe integers: converting an already-rounded number would fabricate a
  // plausible-looking ID. Anything else fails closed as an invalid record.
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

export function readCapturedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Mapillary's documented contract is Unix milliseconds; never infer
    // seconds from magnitude.
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function readIsPano(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function readSequenceId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

/**
 * Normalize one raw provider entity. Returns null when the record has no
 * valid ID or no valid coordinate; the caller counts the exclusion.
 */
export function normalizeImageRecord(raw: unknown): ImageResult | null {
  if (!isRecord(raw)) return null;
  const id = readId(raw.id);
  const originalCoordinate = readPoint(raw.geometry);
  const computedCoordinate = readPoint(raw.computed_geometry);
  // Prefer the original point; use the computed point only when original is unavailable.
  const coordinate = originalCoordinate ?? computedCoordinate;
  const coordinateSource = originalCoordinate ? "geometry" : "computed_geometry";
  if (id === null || coordinate === null) return null;
  return {
    id,
    coordinate,
    coordinateSource,
    originalCoordinate,
    computedCoordinate,
    capturedAt: readCapturedAt(raw.captured_at),
    isPano: readIsPano(raw.is_pano),
    sequenceId: readSequenceId(raw.sequence),
  };
}
