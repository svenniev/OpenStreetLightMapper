import type { Bbox } from "@openstreetlightmapper/geo";
import {
  TransportError,
  fetchJsonWithLimits,
} from "./providerHttp.js";

/**
 * Bounded Mapillary image-metadata client for RoI discovery.
 *
 * One bounding-box search per explicit user query. No creator filter, no
 * pagination following, no bulk download. Provider constraints (endpoint,
 * bbox order, strict < 0.01 sq deg bbox, limit 2000, `Authorization: OAuth`
 * header) follow the official Mapillary API documentation and are corroborated
 * by the official MapillaryJS viewer's own request code.
 *
 * User-facing messages are stable templates: raw provider text (which could
 * contain credentials or URLs) is never returned or logged.
 */

export const MAPILLARY_IMAGES_ENDPOINT = "https://graph.mapillary.com/images";
export const MAPILLARY_SEARCH_LIMIT = 2000;
export const MAPILLARY_SEARCH_FIELDS =
  "id,geometry,computed_geometry,captured_at,is_pano,sequence";
/** Upstream deadline covering the whole request including body consumption. */
export const MAPILLARY_TIMEOUT_MS = 30_000;

/** Known provider throttle signals inside Graph error bodies. */
const THROTTLE_SUBCODES = new Set([4, 17, 32, 613]);

export type MapillaryErrorCode =
  | "MAPILLARY_AUTH_ERROR"
  | "MAPILLARY_RATE_LIMITED"
  | "MAPILLARY_TIMEOUT"
  | "MAPILLARY_NETWORK_ERROR"
  | "MAPILLARY_BAD_RESPONSE"
  | "MAPILLARY_BODY_TOO_LARGE"
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

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return undefined;
  return seconds;
}

/** Shared transport-failure mapping for every Mapillary client in this server. */
export function mapTransportError(error: TransportError): MapillaryError {
  switch (error.kind) {
    case "aborted":
      throw new ClientAbortedError();
    case "timeout":
      return new MapillaryError("MAPILLARY_TIMEOUT", "Mapillary search timed out.", {
        retryable: true,
      });
    case "network":
      return new MapillaryError(
        "MAPILLARY_NETWORK_ERROR",
        "Could not reach the Mapillary API (network failure).",
        { retryable: true },
      );
    case "too_large":
      return new MapillaryError(
        "MAPILLARY_BODY_TOO_LARGE",
        "Mapillary response exceeded the 10 MiB safety limit.",
        { retryable: false },
      );
    case "bad_json":
      return new MapillaryError("MAPILLARY_BAD_RESPONSE", "Mapillary returned malformed JSON.", {
        retryable: false,
      });
  }
}

/**
 * Shared non-2xx mapping for every Mapillary client in this server. Always
 * throws; status-first handling keeps error bodies out of the decision.
 */
export function throwForMapillaryStatus(status: number, body: unknown, headers: Headers): never {
  const errorRecord =
    typeof body === "object" && body !== null
      ? ((body as { error?: unknown }).error as { code?: unknown } | undefined)
      : undefined;
  const subcode =
    errorRecord && typeof errorRecord.code === "number" ? errorRecord.code : null;
  const retryAfterSec = parseRetryAfter(headers);
  if ((subcode !== null && THROTTLE_SUBCODES.has(subcode)) || status === 429) {
    throw new MapillaryError("MAPILLARY_RATE_LIMITED", "Mapillary rate limit reached.", {
      retryable: true,
      retryAfterSec,
    });
  }
  if (status === 401 || status === 403) {
    throw new MapillaryError(
      "MAPILLARY_AUTH_ERROR",
      `Mapillary rejected the configured access token (provider status ${status}). Correct the server search token.`,
      { retryable: false },
    );
  }
  throw new MapillaryError(
    "MAPILLARY_REQUEST_FAILED",
    `Mapillary request failed (provider status ${status}).`,
    { retryable: status >= 500 },
  );
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

  let status: number;
  let headers: Headers;
  let body: unknown;
  try {
    const result = await fetchJsonWithLimits(url, {
      fetchImpl,
      headers: { Authorization: `OAuth ${token}`, Accept: "application/json" },
      timeoutMs,
      signal: options.signal,
    });
    status = result.status;
    headers = result.headers;
    body = result.json;
  } catch (error) {
    if (error instanceof TransportError) throw mapTransportError(error);
    throw error;
  }

  if (status < 200 || status >= 300) {
    throwForMapillaryStatus(status, body, headers);
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
