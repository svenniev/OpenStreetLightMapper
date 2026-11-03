import type { RoiPolygon } from "@openstreetlightmapper/geo";
import type { ImageResult, SearchResponse } from "./searchTypes";

export interface HealthResponse {
  service: string;
  status: string;
  providers?: {
    mapillarySearch?: {
      configured?: boolean;
    };
    samDetection?: {
      configured?: boolean;
      model?: string;
    };
  };
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(code: string, message: string, retryable: boolean, httpStatus: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

interface ErrorPayload {
  error?: { code?: unknown; message?: unknown; retryable?: unknown };
}

function readErrorPayload(body: unknown): ErrorPayload {
  if (typeof body === "object" && body !== null) return body as ErrorPayload;
  return {};
}

function toApiError(status: number, body: unknown): ApiError {
  const { error } = readErrorPayload(body);
  const code = typeof error?.code === "string" ? error.code : "SEARCH_FAILED";
  const message = typeof error?.message === "string" ? error.message : "Request failed.";
  const retryable = error?.retryable === true;
  return new ApiError(code, message, retryable, status);
}

/**
 * AbortSignal with a deadline: aborts after `timeoutMs` unless released, and
 * forwards an optional parent signal. The caller must call `release()`.
 */
export function createDeadlineSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  parent?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", forward);
    },
  };
}

/**
 * Generic same-origin JSON helper for newer routes. Throws ApiError on
 * failure; the caller's AbortSignal abort propagates as-is for cancellation.
 */
export async function requestJson<T>(
  path: string,
  options: { method?: string; payload?: unknown; signal?: AbortSignal; what: string },
  validate: (body: unknown) => T | null,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.payload !== undefined ? { "content-type": "application/json" } : undefined,
      body: options.payload !== undefined ? JSON.stringify(options.payload) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      "BACKEND_UNREACHABLE",
      "The backend could not be reached. Start it with `npm run dev` and retry.",
      true,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", "The backend returned an unreadable response.", true, response.status);
  }
  if (!response.ok) throw toApiError(response.status, body);
  const validated = validate(body);
  if (!validated) {
    throw new ApiError(
      "BAD_RESPONSE",
      `The backend returned an unexpected ${options.what} response.`,
      true,
      response.status,
    );
  }
  return validated;
}

/**
 * Explicit image-metadata search for one committed region. Throws ApiError on
 * failure; the caller's AbortSignal abort propagates as-is for cancellation.
 */
export async function searchMapillaryImages(
  roi: RoiPolygon,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  let response: Response;
  try {
    response = await fetch("/api/mapillary/images/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roi }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      "BACKEND_UNREACHABLE",
      "The backend could not be reached. Start it with `npm run dev` and retry.",
      true,
    );
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", "The backend returned an unreadable response.", true, response.status);
  }

  if (!response.ok) throw toApiError(response.status, body);

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { images?: unknown }).images) ||
    typeof (body as { query?: unknown }).query !== "object"
  ) {
    throw new ApiError("BAD_RESPONSE", "The backend returned an unexpected search response.", true, response.status);
  }
  return body as SearchResponse;
}

export interface HydratedMember extends ImageResult {
  inRoi: boolean;
}

export interface SequenceDetailResponse {
  sequenceId: string;
  memberIds: string[];
  images: HydratedMember[];
  membership: {
    status: "complete" | "partial" | "unknown";
    returnedCount: number;
    capped: boolean;
  };
  detail: {
    status: "loaded" | "partial" | "failed";
    loadedCount: number;
    missingCount: number;
    invalidCount: number;
    inRegionCount: number;
    outRegionCount: number;
    unresolvedCount: number;
    skippedKnownCount: number;
  };
  warnings: string[];
  retrievedAt: string;
  requestedAt: string;
}

/** On-demand sequence membership + metadata for IDs the client lacks. */
export async function fetchSequenceDetail(
  sequenceId: string,
  roi: RoiPolygon,
  knownIds: string[],
  signal?: AbortSignal,
): Promise<SequenceDetailResponse> {
  let response: Response;
  try {
    response = await fetch(
      `/api/mapillary/sequences/${encodeURIComponent(sequenceId)}/images`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roi, knownIds }),
        signal,
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      "BACKEND_UNREACHABLE",
      "The backend could not be reached. Start it with `npm run dev` and retry.",
      true,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", "The backend returned an unreadable response.", true, response.status);
  }
  if (!response.ok) throw toApiError(response.status, body);
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { memberIds?: unknown }).memberIds) ||
    !Array.isArray((body as { images?: unknown }).images) ||
    typeof (body as { detail?: unknown }).detail !== "object"
  ) {
    throw new ApiError(
      "BAD_RESPONSE",
      "The backend returned an unexpected sequence response.",
      true,
      response.status,
    );
  }
  return body as SequenceDetailResponse;
}

export interface StreetSegment {
  wayId: number;
  highway: string;
  nodeIds: number[];
  tags: Partial<Record<"service" | "access" | "bridge" | "tunnel" | "layer" | "lit", string>>;
  version: number | null;
  timestamp: string | null;
}

export interface StreetWorkItem {
  id: string;
  displayName: string;
  partLabel: string | null;
  name: string | null;
  ref: string | null;
  wayIds: number[];
  segments: StreetSegment[];
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
  lengthM: number;
  /**
   * Demo-seed display links only (present on the seeded demo street).
   * Never a real image-to-street association.
   */
  demoSequenceIds?: string[];
}

export interface StreetSearchResponse {
  streets: StreetWorkItem[];
  query: {
    bbox: [number, number, number, number];
    requestedAt: string;
    retrievedAt: string;
    candidateCount: number;
    invalidWayCount: number;
    ineligibleWayCount: number;
    outsideCount: number;
    streetCount: number;
    status: string;
  };
  warnings: string[];
}

/** Street work items for one committed region (independent of Mapillary config). */
export async function fetchStreets(
  roi: RoiPolygon,
  signal?: AbortSignal,
): Promise<StreetSearchResponse> {
  let response: Response;
  try {
    response = await fetch("/api/streets/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roi }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      "BACKEND_UNREACHABLE",
      "The backend could not be reached. Start it with `npm run dev` and retry.",
      true,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", "The backend returned an unreadable response.", true, response.status);
  }
  if (!response.ok) throw toApiError(response.status, body);
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { streets?: unknown }).streets) ||
    typeof (body as { query?: unknown }).query !== "object"
  ) {
    throw new ApiError(
      "BAD_RESPONSE",
      "The backend returned an unexpected street response.",
      true,
      response.status,
    );
  }
  return body as StreetSearchResponse;
}
