import { randomUUID } from "node:crypto";
import { MapillaryError, mapTransportError, throwForMapillaryStatus } from "./mapillary.js";
import { fetchBytesWithLimits, fetchJsonWithLimits, TransportError } from "./providerHttp.js";
import { isRecord, readCapturedAt, readId, readIsPano, readPoint, readSequenceId } from "./records.js";

/**
 * Mapillary image-detail client and bounded same-origin media proxy.
 *
 * The browser needs downloadable photograph bytes for the annotation canvas,
 * but Mapillary thumbnail URLs are cross-origin (canvas tainting) and
 * transient signed URLs (not evidence identifiers). This module fetches image
 * metadata by ID on demand, picks one verified thumbnail URL, and serves its
 * bytes through an app-owned media handle:
 *
 * - handles are random, short-lived, and resolve server-side only — the
 *   endpoint never accepts an arbitrary URL, so it is not a general proxy;
 * - media fetches send no Mapillary credentials (the signed URL is the auth);
 * - redirects are followed manually with HTTPS/credential validation;
 * - bytes are capped, content-typed, deadline-bounded, and cached briefly.
 *
 * Signed URLs never leave the server: clients see metadata, attribution, and
 * the opaque media handle.
 */

export const MAPILLARY_IMAGE_DETAIL_FIELDS =
  "id,sequence,captured_at,is_pano,geometry,computed_geometry,compass_angle,computed_compass_angle,creator,thumb_256_url,thumb_1024_url,thumb_2048_url,thumb_original_url";
export const MAPILLARY_IMAGE_PAGE_URL = "https://www.mapillary.com/map/im";
export const IMAGERY_TIMEOUT_MS = 30_000;
/** 15 MiB: large panoramas must still fail closed, not buffer forever. */
export const IMAGERY_MEDIA_LIMIT_BYTES = 15 * 1024 * 1024;
export const IMAGERY_MAX_REDIRECTS = 5;
export const IMAGERY_HANDLE_TTL_MS = 15 * 60 * 1000;
export const IMAGERY_MAX_HANDLES = 200;
export const IMAGERY_BYTE_CACHE_MAX_ENTRIES = 50;
export const IMAGERY_BYTE_CACHE_MAX_BYTES = 100 * 1024 * 1024;

export interface ImageDetailOptions {
  imageId: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NormalizedImageDetail {
  imageId: string;
  sequenceId: string | null;
  capturedAt: number | null;
  isPano: boolean | null;
  compassAngle: number | null;
  creator: string | null;
  /** [longitude, latitude] camera position with its source. */
  cameraPosition: [number, number] | null;
  coordinateSource: "geometry" | "computed_geometry" | null;
  resolution: string;
  /** Server-side only: the verified thumbnail URL behind the media handle. */
  thumbUrl: string;
}

export interface MediaBytesOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MediaBytes {
  bytes: Buffer;
  contentType: string;
}

/** Thrown when a media handle is unknown or expired. Maps to HTTP 410. */
export class UnknownHandleError extends Error {
  constructor() {
    super("Unknown or expired media handle.");
    this.name = "UnknownHandleError";
  }
}

interface MediaHandleEntry {
  imageId: string;
  url: string;
  resolution: string;
  issuedAt: number;
}

interface CachedBytes {
  bytes: Buffer;
  contentType: string;
}

const handleStore = new Map<string, MediaHandleEntry>();
const byteCache = new Map<string, CachedBytes>();
let byteCacheBytes = 0;

const THUMB_PREFERENCE: { field: string; resolution: string }[] = [
  { field: "thumb_2048_url", resolution: "2048px thumbnail" },
  { field: "thumb_1024_url", resolution: "1024px thumbnail" },
  { field: "thumb_original_url", resolution: "original thumbnail" },
  { field: "thumb_256_url", resolution: "256px thumbnail" },
];

function readThumbUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  return value;
}

function readCreator(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value.slice(0, 120);
  if (isRecord(value) && typeof value.username === "string" && value.username.length > 0) {
    return value.username.slice(0, 120);
  }
  return null;
}

function readCompassAngle(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Mapillary image IDs are numeric; anything else fails closed before any fetch. */
export function isValidImageId(imageId: string): boolean {
  if (!/^\d{1,19}$/.test(imageId)) return false;
  return Number.isSafeInteger(Number(imageId));
}

export function normalizeImageDetail(imageId: string, raw: unknown): NormalizedImageDetail | null {
  if (!isRecord(raw)) return null;
  const id = readId(raw.id);
  if (id === null || id !== imageId) return null;
  let thumbUrl: string | null = null;
  let resolution = "";
  for (const candidate of THUMB_PREFERENCE) {
    const url = readThumbUrl(raw[candidate.field]);
    if (url) {
      thumbUrl = url;
      resolution = candidate.resolution;
      break;
    }
  }
  if (!thumbUrl) return null;
  const original = readPoint(raw.geometry);
  const computed = readPoint(raw.computed_geometry);
  return {
    imageId: id,
    sequenceId: readSequenceId(raw.sequence),
    capturedAt: readCapturedAt(raw.captured_at),
    isPano: readIsPano(raw.is_pano),
    compassAngle:
      readCompassAngle(raw.computed_compass_angle) ?? readCompassAngle(raw.compass_angle),
    creator: readCreator(raw.creator),
    cameraPosition: original ?? computed,
    coordinateSource: original ? "geometry" : computed ? "computed_geometry" : null,
    resolution,
    thumbUrl,
  };
}

export function attributionFor(detail: Pick<NormalizedImageDetail, "creator">): string {
  return detail.creator ? `© Mapillary contributors — ${detail.creator}` : "© Mapillary contributors";
}

export function sourceUrlFor(imageId: string): string {
  return `${MAPILLARY_IMAGE_PAGE_URL}/${imageId}`;
}

/**
 * Fetch one image's metadata by ID. Throws MapillaryError (provider side) or
 * ClientAbortedError (caller disconnected).
 */
export async function fetchImageDetail(
  options: ImageDetailOptions,
): Promise<NormalizedImageDetail> {
  const { imageId, token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? IMAGERY_TIMEOUT_MS;
  const params = new URLSearchParams({ fields: MAPILLARY_IMAGE_DETAIL_FIELDS });
  const url = `https://graph.mapillary.com/${imageId}?${params.toString()}`;

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

  if (status < 200 || status >= 300) throwForMapillaryStatus(status, body, headers);

  const detail = normalizeImageDetail(imageId, body);
  if (!detail) {
    throw new MapillaryError(
      "MAPILLARY_BAD_RESPONSE",
      "Mapillary returned no usable image detail or thumbnail.",
      { retryable: false },
    );
  }
  return detail;
}

/** Issue a short-lived media handle for a verified thumbnail URL. */
export function issueMediaHandle(detail: NormalizedImageDetail): { handle: string; expiresAt: string } {
  if (handleStore.size >= IMAGERY_MAX_HANDLES) {
    const oldest = handleStore.keys().next().value;
    if (oldest !== undefined) {
      handleStore.delete(oldest);
      evictCachedBytes(oldest);
    }
  }
  const handle = randomUUID();
  const issuedAt = Date.now();
  handleStore.set(handle, {
    imageId: detail.imageId,
    url: detail.thumbUrl,
    resolution: detail.resolution,
    issuedAt,
  });
  return { handle, expiresAt: new Date(issuedAt + IMAGERY_HANDLE_TTL_MS).toISOString() };
}

/** Resolve a handle to its server-side entry, or null when unknown/expired. */
export function resolveMediaHandle(handle: string): MediaHandleEntry | null {
  const entry = handleStore.get(handle);
  if (!entry) return null;
  if (Date.now() - entry.issuedAt > IMAGERY_HANDLE_TTL_MS) {
    handleStore.delete(handle);
    evictCachedBytes(handle);
    return null;
  }
  return entry;
}

function evictCachedBytes(handle: string): void {
  const cached = byteCache.get(handle);
  if (cached) {
    byteCacheBytes -= cached.bytes.byteLength;
    byteCache.delete(handle);
  }
}

function storeCachedBytes(handle: string, bytes: Buffer, contentType: string): void {
  evictCachedBytes(handle);
  byteCache.set(handle, { bytes, contentType });
  byteCacheBytes += bytes.byteLength;
  while (
    (byteCache.size > IMAGERY_BYTE_CACHE_MAX_ENTRIES || byteCacheBytes > IMAGERY_BYTE_CACHE_MAX_BYTES) &&
    byteCache.size > 0
  ) {
    const oldest = byteCache.keys().next().value;
    if (oldest === undefined || oldest === handle) break;
    evictCachedBytes(oldest);
  }
}

function validatedRedirect(current: string, location: string | null): string {
  if (!location) {
    throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Image media redirect was missing its target.", {
      retryable: false,
    });
  }
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Image media redirect target was invalid.", {
      retryable: false,
    });
  }
  if (next.protocol !== "https:" || !next.hostname || next.username || next.password) {
    throw new MapillaryError(
      "MAPILLARY_BAD_RESPONSE",
      "Image media redirect left trusted HTTPS destinations.",
      { retryable: false },
    );
  }
  return next.toString();
}

/**
 * Download one handle's media bytes with validated redirects. Sends no
 * Mapillary credentials. Throws MapillaryError or ClientAbortedError.
 */
export async function fetchMediaBytes(
  handle: string,
  options?: MediaBytesOptions,
): Promise<MediaBytes> {
  const entry = resolveMediaHandle(handle);
  if (!entry) throw new UnknownHandleError();
  const cached = byteCache.get(handle);
  if (cached) return { bytes: cached.bytes, contentType: cached.contentType };

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? IMAGERY_TIMEOUT_MS;
  let current = entry.url;
  for (let hop = 0; hop <= IMAGERY_MAX_REDIRECTS; hop += 1) {
    let status: number;
    let headers: Headers;
    let bytes: Uint8Array;
    try {
      const result = await fetchBytesWithLimits(current, {
        fetchImpl,
        headers: { Accept: "image/*" },
        timeoutMs,
        maxBytes: IMAGERY_MEDIA_LIMIT_BYTES,
        redirect: "manual",
        signal: options?.signal,
      });
      status = result.status;
      headers = result.headers;
      bytes = result.bytes;
    } catch (error) {
      if (error instanceof TransportError) throw mapTransportError(error);
      throw error;
    }
    if (status >= 300 && status < 400) {
      if (hop === IMAGERY_MAX_REDIRECTS) {
        throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Image media redirected too many times.", {
          retryable: false,
        });
      }
      current = validatedRedirect(current, headers.get("location"));
      continue;
    }
    if (status < 200 || status >= 300) throwForMapillaryStatus(status, null, headers);
    const contentType = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Image media was not an image payload.", {
        retryable: false,
      });
    }
    const buffer = Buffer.from(bytes);
    if (buffer.byteLength === 0) {
      throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Image media was empty.", {
        retryable: false,
      });
    }
    storeCachedBytes(handle, buffer, contentType);
    return { bytes: buffer, contentType };
  }
  // Unreachable: the final hop always returns or throws above.
  throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Image media request ended unexpectedly.", {
    retryable: false,
  });
}
