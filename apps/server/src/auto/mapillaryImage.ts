import { fetchJsonWithLimits, TransportError } from "../providerHttp.js";
import { attributionFor, sourceUrlFor } from "../imagery.js";
import {
  ClientAbortedError,
  MAPILLARY_IMAGES_ENDPOINT,
  MapillaryError,
  mapTransportError,
  throwForMapillaryStatus,
} from "../mapillary.js";

/**
 * Bounded per-image Mapillary metadata client for the automatic pipeline.
 *
 * Prepare resolves geometry/eligibility per selected image; the worker
 * refreshes one image at a time for a fresh thumbnail URL (media handles
 * expire, so URLs are never frozen into plans). Field names follow the
 * official Mapillary API documentation (image entity).
 */

export const MAPILLARY_GRAPH_ENDPOINT = "https://graph.mapillary.com";
export const MAPILLARY_IMAGE_FIELDS =
  "id,sequence,camera_type,camera_parameters,width,height,exif_orientation," +
  "geometry,computed_geometry,altitude,computed_altitude,computed_rotation," +
  "compass_angle,computed_compass_angle,merge_cc,atomic_scale,captured_at," +
  "is_pano,creator,thumb_2048_url";
/** Images per collection call (app choice; keeps URLs and bodies small). */
export const MAPILLARY_IMAGE_BATCH_SIZE = 50;
export const MAPILLARY_IMAGE_TIMEOUT_MS = 30_000;
/** Metadata reads retry on retryable failures only, with bounded backoff. */
export const MAPILLARY_IMAGE_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1000];
/** Retry-After is honored up to this cap so a run cannot stall for an hour. */
const RETRY_AFTER_CAP_MS = 30_000;

export interface MapillaryImageOptions {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordId(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function fetchJsonRetried(
  url: string,
  options: MapillaryImageOptions,
): Promise<{ status: number; headers: Headers; json: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MAPILLARY_IMAGE_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await fetchJsonWithLimits(url, {
        fetchImpl,
        headers: { Authorization: `OAuth ${options.token}`, Accept: "application/json" },
        timeoutMs,
        signal: options.signal,
      });
      if (result.status < 200 || result.status >= 300) {
        throwForMapillaryStatus(result.status, result.json, result.headers);
      }
      return result;
    } catch (error) {
      if (error instanceof ClientAbortedError) throw error;
      const mapped =
        error instanceof TransportError
          ? mapTransportError(error)
          : error instanceof MapillaryError
            ? error
            : null;
      if (!mapped || !mapped.retryable || attempt + 1 >= MAPILLARY_IMAGE_ATTEMPTS) {
        throw mapped ?? error;
      }
      if (options.signal?.aborted) throw new ClientAbortedError();
      const honorAfter =
        mapped.retryAfterSec !== undefined
          ? Math.min(mapped.retryAfterSec * 1000, RETRY_AFTER_CAP_MS)
          : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      await sleep(honorAfter);
    }
  }
}

function dataRecords(json: unknown): unknown[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { data?: unknown }).data)) {
    throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Mapillary response had no data array.", {
      retryable: false,
    });
  }
  return (json as { data: unknown[] }).data;
}

/**
 * Fetch metadata for explicit image ids, in sequential bounded batches.
 * Missing images are reported, not fabricated: callers mark them
 * metadata-unavailable and disclose the count.
 */
export async function fetchImageMetadata(
  imageIds: string[],
  options: MapillaryImageOptions,
): Promise<{ found: Map<string, unknown>; missing: string[] }> {
  const found = new Map<string, unknown>();
  for (let offset = 0; offset < imageIds.length; offset += MAPILLARY_IMAGE_BATCH_SIZE) {
    const batch = imageIds.slice(offset, offset + MAPILLARY_IMAGE_BATCH_SIZE);
    const params = new URLSearchParams({
      image_ids: batch.join(","),
      fields: MAPILLARY_IMAGE_FIELDS,
    });
    const result = await fetchJsonRetried(`${MAPILLARY_IMAGES_ENDPOINT}?${params.toString()}`, options);
    for (const record of dataRecords(result.json)) {
      const id = recordId(record);
      if (id && batch.includes(id)) found.set(id, record);
    }
  }
  const missing = imageIds.filter((id) => !found.has(id));
  return { found, missing };
}

/** Refresh one image (fresh thumbnail URL) at preparation time. */
export async function refreshImageMetadata(
  imageId: string,
  options: MapillaryImageOptions,
): Promise<unknown> {
  const params = new URLSearchParams({ fields: MAPILLARY_IMAGE_FIELDS });
  const result = await fetchJsonRetried(
    `${MAPILLARY_GRAPH_ENDPOINT}/${encodeURIComponent(imageId)}?${params.toString()}`,
    options,
  );
  if (recordId(result.json) !== imageId) {
    throw new MapillaryError("MAPILLARY_BAD_RESPONSE", "Mapillary returned the wrong image.", {
      retryable: false,
    });
  }
  return result.json;
}

/** Attribution for a stored view, reusing the viewer wording (never a signed URL). */
export function attributionFromRaw(record: unknown): string {
  if (typeof record !== "object" || record === null) return attributionFor({ creator: null });
  const creator = (record as { creator?: unknown }).creator;
  const username =
    typeof creator === "object" && creator !== null
      ? (creator as { username?: unknown }).username
      : null;
  return attributionFor({ creator: typeof username === "string" && username ? username : null });
}

export { sourceUrlFor };

/**
 * Extract a thumbnail URL without trusting it: https only, no credentials,
 * single hostname. The pixel fetch restricts hosts further.
 */
export function thumbUrl(record: unknown, thumbKind: string): string | null {
  if (typeof record !== "object" || record === null) return null;
  const raw = (record as Record<string, unknown>)[thumbKind];
  if (typeof raw !== "string" || !raw.startsWith("https://")) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
