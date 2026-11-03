import type { ImageResult } from "./searchTypes";

/**
 * Pure client-side search helpers: sorting, pagination, formatting, and the
 * stale-response guard. Framework-free so they are unit-testable without a DOM.
 */

export const RESULT_PAGE_SIZE = 50;

export const WARNING_MESSAGES: Record<string, string> = {
  POSSIBLY_TRUNCATED:
    "The search reached the provider result limit. More images may exist; select a smaller region.",
  INVALID_RECORDS_EXCLUDED:
    "Some returned records had no usable coordinates and were excluded from the results.",
};

export function warningMessage(code: string): string {
  return WARNING_MESSAGES[code] ?? `The provider reported a data warning (${code}).`;
}

/**
 * Sort the loaded result set: capture time descending, unknown dates last,
 * image ID ascending for deterministic ties. This sorts only the returned set;
 * it must not be read as "the provider returned the newest images".
 */
export function sortSearchResults(images: ImageResult[]): ImageResult[] {
  return [...images].sort((a, b) => {
    if (a.capturedAt !== null && b.capturedAt !== null && a.capturedAt !== b.capturedAt) {
      return b.capturedAt - a.capturedAt;
    }
    if ((a.capturedAt === null) !== (b.capturedAt === null)) {
      return a.capturedAt === null ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface ResultsPage {
  items: ImageResult[];
  page: number;
  pageCount: number;
  total: number;
}

/** Client-side pages over loaded results (not provider pagination). */
export function paginateResults(
  images: ImageResult[],
  page: number,
  pageSize: number = RESULT_PAGE_SIZE,
): ResultsPage {
  const total = images.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), pageCount);
  return {
    items: images.slice((clamped - 1) * pageSize, clamped * pageSize),
    page: clamped,
    pageCount,
    total,
  };
}

/** Full timestamp preserved in data; displayed consistently in UTC. */
export function formatCapturedDate(capturedAt: number | null): string {
  if (capturedAt === null || !Number.isFinite(capturedAt)) return "Unknown";
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatPanoStatus(isPano: boolean | null): string {
  if (isPano === true) return "Panorama";
  if (isPano === false) return "Standard";
  return "Unknown";
}

export function formatRetrievedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "Unknown";
  return formatCapturedDate(ms);
}

export function formatArea(areaSqM: number): string {
  if (!Number.isFinite(areaSqM) || areaSqM < 0) return "Unknown";
  if (areaSqM < 10_000) return `${Math.round(areaSqM).toLocaleString("en-US")} m²`;
  return `${(areaSqM / 1_000_000).toFixed(2)} km²`;
}

export interface SearchGuard {
  /** Start a new search generation; returns its token. */
  next: () => number;
  /** True only when the token belongs to the latest generation. */
  isCurrent: (token: number) => boolean;
  /** Invalidate every outstanding token (region replaced/cleared). */
  invalidate: () => void;
  current: () => number;
}

/**
 * Request/region generation guard: late responses must never overwrite a newer
 * region or search. Pair with AbortController cancellation.
 */
export function createSearchGuard(): SearchGuard {
  let generation = 0;
  return {
    next: () => {
      generation += 1;
      return generation;
    },
    isCurrent: (token: number) => token === generation,
    invalidate: () => {
      generation += 1;
    },
    current: () => generation,
  };
}
