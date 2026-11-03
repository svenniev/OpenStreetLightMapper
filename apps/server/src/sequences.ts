import { pointInRing, type LngLat } from "@openstreetlightmapper/geo";
import { normalizeImageRecord, readId, type ImageResult } from "./records.js";
import {
  ClientAbortedError,
  MAPILLARY_IMAGES_ENDPOINT,
  MAPILLARY_SEARCH_FIELDS,
  MapillaryError,
} from "./mapillary.js";
import { TransportError, fetchJsonWithLimits } from "./providerHttp.js";

/**
 * Bounded sequence membership + metadata hydration.
 *
 * Strategy follows the documented provider surface (verified against the
 * official MapillaryJS viewer's own request code):
 *   1. `GET /image_ids?sequence_id=...` yields member IDs in sequence order.
 *   2. Missing metadata comes from documented batch entity requests,
 *      `GET /images?image_ids=<csv>&fields=...`.
 * No invented sequence-search endpoint, no followed pagination.
 */

export const MAPILLARY_IMAGE_IDS_ENDPOINT = "https://graph.mapillary.com/image_ids";
/** Opaque provider IDs: bounded length, safe characters only. */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Metadata batch size per upstream request. */
export const SEQUENCE_BATCH_SIZE = 50;
/** At most two concurrent metadata batch requests. */
export const SEQUENCE_MAX_CONCURRENCY = 2;
/** Application limit: member IDs hydrated per sequence (not a provider quota). */
export const SEQUENCE_MAX_MEMBERS = 5000;
/** Per-request upstream deadline including body consumption. */
export const SEQUENCE_REQUEST_TIMEOUT_MS = 30_000;
/** Total sequence-detail deadline. */
export const SEQUENCE_TOTAL_TIMEOUT_MS = 120_000;
/** Application bound on client-supplied known IDs per request. */
export const SEQUENCE_MAX_KNOWN_IDS = 20_000;

export interface SequenceDetailOptions {
  sequenceId: string;
  ring: LngLat[];
  /** IDs the caller already holds (skipped, never re-hydrated). */
  knownIds?: string[];
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface HydratedMember extends ImageResult {
  inRoi: boolean;
}

export type MembershipStatus = "complete" | "partial" | "unknown";
export type DetailStatus = "loaded" | "partial" | "failed";

export interface SequenceDetail {
  sequenceId: string;
  /** Membership order (provider order), up to the application cap. */
  memberIds: string[];
  /** Records hydrated by this call (complement of known IDs). */
  images: HydratedMember[];
  membership: {
    status: MembershipStatus;
    returnedCount: number;
    capped: boolean;
  };
  detail: {
    status: DetailStatus;
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
}

function mapTransportError(error: TransportError): MapillaryError {
  switch (error.kind) {
    case "aborted":
      throw new ClientAbortedError();
    case "timeout":
      return new MapillaryError("MAPILLARY_TIMEOUT", "Mapillary sequence request timed out.", {
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

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return undefined;
  return seconds;
}

const THROTTLE_SUBCODES = new Set([4, 17, 32, 613]);

interface ProviderContext {
  token: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
  /** True only when the CALLER aborted (vs the total deadline firing). */
  isCallerAbort: () => boolean;
}

async function providerGet(
  url: string,
  context: ProviderContext,
): Promise<{ body: unknown; headers: Headers }> {
  let status: number;
  let headers: Headers;
  let body: unknown;
  try {
    const result = await fetchJsonWithLimits(url, {
      fetchImpl: context.fetchImpl,
      headers: { Authorization: `OAuth ${context.token}`, Accept: "application/json" },
      timeoutMs: context.timeoutMs,
      signal: context.signal,
    });
    status = result.status;
    headers = result.headers;
    body = result.json;
  } catch (error) {
    if (error instanceof TransportError) {
      if (error.kind === "aborted" && !context.isCallerAbort()) {
        // The total deadline fired while the caller still waits: per-request
        // timeout semantics, never a silent caller-gone path.
        throw new MapillaryError("MAPILLARY_TIMEOUT", "Mapillary sequence request timed out.", {
          retryable: true,
        });
      }
      throw mapTransportError(error);
    }
    throw error;
  }
  if (status < 200 || status >= 300) {
    const errorRecord =
      typeof body === "object" && body !== null
        ? ((body as { error?: unknown }).error as { code?: unknown } | undefined)
        : undefined;
    const subcode =
      errorRecord && typeof errorRecord.code === "number" ? errorRecord.code : null;
    if ((subcode !== null && THROTTLE_SUBCODES.has(subcode)) || status === 429) {
      throw new MapillaryError("MAPILLARY_RATE_LIMITED", "Mapillary rate limit reached.", {
        retryable: true,
        retryAfterSec: parseRetryAfter(headers),
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
  return { body, headers };
}

function readDataArray(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? data : null;
}

function hasNextPage(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const paging = (body as { paging?: unknown }).paging;
  return (
    typeof paging === "object" &&
    paging !== null &&
    typeof (paging as { next?: unknown }).next === "string" &&
    ((paging as { next: string }).next.length > 0)
  );
}

/** Bounded worker pool preserving input order in the output array. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  fn: (item: T) => Promise<R>,
): Promise<{ results: (R | undefined)[]; stopped: boolean }> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  let stopped = false;
  async function worker(): Promise<void> {
    for (;;) {
      if (shouldStop()) {
        stopped = true;
        return;
      }
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return { results, stopped };
}

export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

/**
 * Load one sequence's membership and hydrate records the caller lacks.
 * Never throws away partial progress: batch-level failures leave the
 * remainder explicitly unresolved instead of failing silently.
 */
export async function loadSequenceDetail(
  options: SequenceDetailOptions,
): Promise<SequenceDetail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SEQUENCE_REQUEST_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? SEQUENCE_TOTAL_TIMEOUT_MS;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw new ClientAbortedError();

  // Total deadline plus caller cancellation fan into one detail controller.
  const detailController = new AbortController();
  let totalFired = false;
  const totalTimer = setTimeout(() => {
    totalFired = true;
    detailController.abort();
  }, totalTimeoutMs);
  const forwardCallerAbort = () => detailController.abort();
  callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });

  const context: ProviderContext = {
    token: options.token,
    fetchImpl,
    timeoutMs,
    signal: detailController.signal,
    isCallerAbort: () => callerSignal?.aborted === true,
  };

  try {
    // 1. Membership, in provider (sequence) order.
    const membershipUrl = `${MAPILLARY_IMAGE_IDS_ENDPOINT}?${new URLSearchParams({
      sequence_id: options.sequenceId,
    }).toString()}`;
    let membershipBody: unknown;
    try {
      ({ body: membershipBody } = await providerGet(membershipUrl, context));
    } catch (error) {
      if (callerSignal?.aborted) throw new ClientAbortedError();
      throw error;
    }
    const rawMembers = readDataArray(membershipBody);
    if (rawMembers === null) {
      throw new MapillaryError(
        "MAPILLARY_BAD_RESPONSE",
        "Mapillary sequence response had no data array.",
        { retryable: false },
      );
    }
    const allMemberIds: string[] = [];
    for (const entry of rawMembers) {
      const id =
        typeof entry === "object" && entry !== null
          ? ((entry as { id?: unknown }).id as unknown)
          : null;
      if (isProviderId(id)) allMemberIds.push(id);
    }
    const morePages = hasNextPage(membershipBody);
    const capped = allMemberIds.length > SEQUENCE_MAX_MEMBERS;
    const memberIds = capped ? allMemberIds.slice(0, SEQUENCE_MAX_MEMBERS) : allMemberIds;
    const membershipStatus: MembershipStatus = morePages
      ? "unknown"
      : capped
        ? "partial"
        : "complete";

    // 2. Hydrate the complement of caller-known IDs, in bounded batches.
    const known = new Set((options.knownIds ?? []).filter(isProviderId));
    const toHydrate = memberIds.filter((id) => !known.has(id));
    const skippedKnownCount = memberIds.length - toHydrate.length;
    const batches: string[][] = [];
    for (let i = 0; i < toHydrate.length; i += SEQUENCE_BATCH_SIZE) {
      batches.push(toHydrate.slice(i, i + SEQUENCE_BATCH_SIZE));
    }

    const images: HydratedMember[] = [];
    let missingCount = 0;
    let invalidCount = 0;
    let inRegionCount = 0;
    let outRegionCount = 0;
    let timeoutHit = false;
    const warnings: string[] = [];
    if (capped) warnings.push("SEQUENCE_MEMBERS_CAPPED");
    if (morePages) warnings.push("SEQUENCE_MEMBERSHIP_UNKNOWN");

    const hydrateBatch = async (batch: string[]): Promise<void> => {
      const url = `${MAPILLARY_IMAGES_ENDPOINT}?${new URLSearchParams({
        image_ids: batch.join(","),
        fields: MAPILLARY_SEARCH_FIELDS,
      }).toString()}`;
      let body: unknown;
      try {
        ({ body } = await providerGet(url, context));
      } catch (error) {
        if (callerSignal?.aborted) throw new ClientAbortedError();
        // Auth misconfiguration must surface as an error, not a silent gap.
        if (error instanceof MapillaryError && error.code === "MAPILLARY_AUTH_ERROR") throw error;
        if (error instanceof MapillaryError && error.code === "MAPILLARY_TIMEOUT") {
          timeoutHit = true;
        }
        // Anything else leaves this batch explicitly unresolved (partial).
        throw new BatchUnresolvedError(batch);
      }
      const entities = readDataArray(body);
      if (entities === null) throw new BatchUnresolvedError(batch);
      const seen = new Set<string>();
      for (const entity of entities) {
        // Returned-but-invalid entities are invalid, not missing: no double count.
        const returnedId = readId((entity as { id?: unknown } | null)?.id);
        if (returnedId !== null) seen.add(returnedId);
        const normalized = normalizeImageRecord(entity);
        if (normalized === null) {
          invalidCount += 1;
          continue;
        }
        // Verify membership where the provider supplies a sequence.
        if (normalized.sequenceId !== null && normalized.sequenceId !== options.sequenceId) {
          invalidCount += 1;
          continue;
        }
        const inRoi = pointInRing(normalized.coordinate, options.ring);
        if (inRoi) inRegionCount += 1;
        else outRegionCount += 1;
        images.push({ ...normalized, inRoi });
      }
      for (const id of batch) {
        if (!seen.has(id)) missingCount += 1; // deleted/unavailable: no fabricated location
      }
    };

    let unresolvedCount = 0;
    if (batches.length > 0) {
      await mapPool(
        batches,
        SEQUENCE_MAX_CONCURRENCY,
        () => callerSignal?.aborted === true || totalFired,
        async (batch) => {
          try {
            await hydrateBatch(batch);
            return true;
          } catch (error) {
            if (error instanceof ClientAbortedError) throw error;
            if (error instanceof MapillaryError && error.code === "MAPILLARY_AUTH_ERROR") {
              throw error;
            }
            if (error instanceof BatchUnresolvedError) {
              unresolvedCount += error.batch.length;
              return false;
            }
            throw error;
          }
        },
      );
      if (callerSignal?.aborted) throw new ClientAbortedError();
    }
    // Reconcile: anything neither loaded, missing, invalid, nor known is unresolved.
    const accounted =
      images.length + missingCount + invalidCount + skippedKnownCount;
    unresolvedCount = Math.max(unresolvedCount, memberIds.length - accounted);

    const loadedCount = images.length;
    let detailStatus: DetailStatus;
    // Timeouts (per-request or total) resolve to partial with retained
    // unresolved counts, never to a bare failure without counts.
    const anyTimeout = timeoutHit || totalFired;
    if (loadedCount === 0 && skippedKnownCount === 0 && memberIds.length > 0 && !anyTimeout) {
      detailStatus = "failed";
    } else if (
      unresolvedCount > 0 ||
      missingCount > 0 ||
      invalidCount > 0 ||
      membershipStatus !== "complete"
    ) {
      detailStatus = "partial";
    } else {
      detailStatus = "loaded";
    }
    if (detailStatus === "partial") warnings.push("SEQUENCE_HYDRATION_PARTIAL");
    if (missingCount > 0) warnings.push("SEQUENCE_MEMBERS_MISSING");
    if (invalidCount > 0) warnings.push("SEQUENCE_MEMBERS_INVALID");

    return {
      sequenceId: options.sequenceId,
      memberIds,
      images,
      membership: {
        status: membershipStatus,
        returnedCount: rawMembers.length,
        capped,
      },
      detail: {
        status: detailStatus,
        loadedCount,
        missingCount,
        invalidCount,
        inRegionCount,
        outRegionCount,
        unresolvedCount,
        skippedKnownCount,
      },
      warnings,
      retrievedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(totalTimer);
    callerSignal?.removeEventListener("abort", forwardCallerAbort);
  }
}

class BatchUnresolvedError extends Error {
  readonly batch: string[];
  constructor(batch: string[]) {
    super("Batch left unresolved.");
    this.name = "BatchUnresolvedError";
    this.batch = batch;
  }
}
