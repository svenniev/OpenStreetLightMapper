import type { Bbox } from "@openstreetlightmapper/geo";

/**
 * Bounded Mapillary image-metadata client for Milestone 1.
 *
 * One bounding-box search per explicit user query. No creator filter, no
 * pagination following, no bulk download. Provider constraints (endpoint,
 * bbox order, strict < 0.01 sq deg bbox, limit 2000, `Authorization: OAuth`
 * header) follow the official Mapillary API documentation as verified in the
 * milestone specification; community usage corroborates the endpoint shape.
 */

export const MAPILLARY_IMAGES_ENDPOINT = "https://graph.mapillary.com/images";
export const MAPILLARY_SEARCH_LIMIT = 2000;
export const MAPILLARY_SEARCH_FIELDS =
  "id,geometry,computed_geometry,captured_at,is_pano,sequence";
/** Upstream deadline: no indefinite waits. */
export const MAPILLARY_TIMEOUT_MS = 30_000;

/** Known provider throttle signals inside Graph error bodies. */
const THROTTLE_SUBCODES = new Set([4, 17, 32, 613]);

export type MapillaryErrorCode =
  | "MAPILLARY_AUTH_ERROR"
  | "MAPILLARY_RATE_LIMITED"
  | "MAPILLARY_TIMEOUT"
  | "MAPILLARY_NETWORK_ERROR"
  | "MAPILLARY_BAD_RESPONSE"
  | "MAPILLARY_REQUEST_FAILED";

export class MapillaryError extends Error {
  readonly code: MapillaryErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;

  constructor(code: MapillaryErrorCode, message: string, options?: { retryable?: boolean; retryAfterSec?: number }) {
    super(message);
    this.name = "MapillaryError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retryAfterSec = options?.retryAfterSec;
  }
}

/** Thrown when the caller's own AbortSignal (client disconnect) fires. Not a provider failure. */
export class ClientAbortedError extends Error {
  constructor() {
    super("Client disconnected; upstream search aborted.");
    this.name = "ClientAbortedError";
  }
}

export interface MapillarySearchOptions {
  bbox: Bbox;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Aborts upstream work, e.g. when the HTTP client disconnects. */
  signal?: AbortSignal;
}

export interface ProviderSearchResult {
  /** Raw `data` array elements, in provider order. Validated only as an array here. */
  records: unknown[];
  /** Provider indicated more results (e.g. `paging.next`) without us following it. */
  hasMoreIndication: boolean;
}

function sanitizeProviderMessage(value: unknown): string {
  if (typeof value !== "string") return "provider request failed";
  // Truncate defensively; the token travels in a header, never in the URL, so
  // upstream messages cannot echo it from our request line.
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return undefined;
  return seconds;
}

interface ProviderErrorBody {
  error?: { code?: unknown; subcode?: unknown; message?: unknown };
}

function readErrorBody(body: unknown): ProviderErrorBody {
  if (typeof body === "object" && body !== null) return body as ProviderErrorBody;
  return {};
}

/**
 * Execute one bounded bbox metadata search. Throws MapillaryError (provider
 * side), ClientAbortedError (caller disconnected), never leaks credentials.
 */
export async function searchMapillaryByBbox(
  options: MapillarySearchOptions,
): Promise<ProviderSearchResult> {
  const { bbox, token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MAPILLARY_TIMEOUT_MS;

  const params = new URLSearchParams({
    bbox: `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`,
    fields: MAPILLARY_SEARCH_FIELDS,
    limit: String(MAPILLARY_SEARCH_LIMIT),
  });
  const url = `${MAPILLARY_IMAGES_ENDPOINT}?${params.toString()}`;

  // Explicit ref'd timer: AbortSignal.timeout() does not keep the event loop
  // alive, so a hung provider request could otherwise wait forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `OAuth ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ClientAbortedError();
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new MapillaryError("MAPILLARY_TIMEOUT", "Mapillary search timed out.", {
        retryable: true,
      });
    }
    throw new MapillaryError(
      "MAPILLARY_NETWORK_ERROR",
      "Could not reach the Mapillary API (network failure).",
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new MapillaryError(
        "MAPILLARY_REQUEST_FAILED",
        `Mapillary request failed with status ${response.status}.`,
        { retryable: response.status >= 500 },
      );
    }
    throw new MapillaryError(
      "MAPILLARY_BAD_RESPONSE",
      "Mapillary returned malformed JSON.",
      { retryable: false },
    );
  }

  if (!response.ok) {
    const { error } = readErrorBody(body);
    const subcode = typeof error?.code === "number" ? error.code : null;
    const retryAfterSec = parseRetryAfter(response.headers);
    if ((subcode !== null && THROTTLE_SUBCODES.has(subcode)) || response.status === 429) {
      throw new MapillaryError("MAPILLARY_RATE_LIMITED", "Mapillary rate limit reached.", {
        retryable: true,
        retryAfterSec,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new MapillaryError(
        "MAPILLARY_AUTH_ERROR",
        `Mapillary rejected the configured access token (status ${response.status}). ` +
          `Provider said: ${sanitizeProviderMessage(error?.message)} Correct the server search token.`,
        { retryable: false },
      );
    }
    throw new MapillaryError(
      "MAPILLARY_REQUEST_FAILED",
      `Mapillary request failed with status ${response.status}: ` +
        sanitizeProviderMessage(error?.message),
      { retryable: response.status >= 500 },
    );
  }

  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Mapillary response had no data array.", {
      retryable: false,
    });
  }
  const data = (body as { data: unknown[] }).data;
  const paging = (body as { paging?: unknown }).paging;
  const hasMoreIndication =
    typeof paging === "object" &&
    paging !== null &&
    typeof (paging as { next?: unknown }).next === "string" &&
    ((paging as { next: string }).next.length > 0);

  return { records: data, hasMoreIndication };
}
