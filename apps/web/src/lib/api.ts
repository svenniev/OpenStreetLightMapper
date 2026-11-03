import type { RoiPolygon } from "@openstreetlightmapper/geo";
import type { SearchResponse } from "./searchTypes";

export interface HealthResponse {
  service: string;
  status: string;
  providers?: {
    mapillarySearch?: {
      configured?: boolean;
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

  if (!response.ok) {
    const { error } = readErrorPayload(body);
    const code = typeof error?.code === "string" ? error.code : "SEARCH_FAILED";
    const message =
      typeof error?.message === "string" ? error.message : "Image search failed.";
    const retryable = error?.retryable === true;
    throw new ApiError(code, message, retryable, response.status);
  }

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
