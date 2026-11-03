import {
  decodeMaskToSVGPath,
  parseImageStream,
  recordsOfKind,
  type ImageSegmentationResult,
  type SegmentationBoxRecord,
  type SegmentationMaskRecord,
} from "@meta-sam/parser";
import { fetchBytesWithLimits, TransportError } from "./providerHttp.js";

/**
 * Hosted SAM 3.1 client over the Meta Model API Responses endpoint.
 *
 * Transport follows the official TypeScript cookbook
 * (meta-model-cookbook 07_sam/01_api_basics): one user message pairing a
 * short `input_text` concept with one `input_image` data URL, streamed
 * (`stream: true`), parsed with the official `@meta-sam/parser` — never a
 * hand-rolled grammar parser. The whole SSE payload is buffered through the
 * standard bounded transport (deadline-through-body, caller cancellation,
 * byte cap) and then replayed to the parser, with the cookbook's documented
 * event normalization (synthesize `response.output_text.done` from
 * `response.content_part.done`, which the live API emits instead).
 *
 * Wire coordinates are inclusive source pixels; the parser converts them to
 * half-open [left, right) × [top, bottom) `SegmentationBoxRecord`s. This
 * module verifies the wire frame size against the declared inference raster
 * before normalizing anything.
 *
 * Raw provider text, credentials, and image bytes never reach logs or error
 * messages: failures map to stable sanitized codes.
 */

export const SAM_API_URL = "https://api.meta.ai/v1/responses";
export const SAM_DEFAULT_MODEL = "sam-3.1";
export const SAM_DEFAULT_TIMEOUT_MS = 120_000;
export const SAM_MIN_TIMEOUT_MS = 10_000;
export const SAM_MAX_TIMEOUT_MS = 300_000;
/** 10 MiB: one_bit masks keep payloads small; anything larger fails closed. */
export const SAM_RESPONSE_LIMIT_BYTES = 10 * 1024 * 1024;
/** Defensive per-call object cap; excess objects are dropped and flagged. */
export const SAM_MAX_OBJECTS = 200;
export const SAM_MAX_CONCEPT_LENGTH = 80;

export type SamErrorCode =
  | "SAM_NOT_CONFIGURED"
  | "SAM_BAD_REQUEST"
  | "SAM_AUTH_ERROR"
  | "SAM_RATE_LIMITED"
  | "SAM_TIMEOUT"
  | "SAM_NETWORK_ERROR"
  | "SAM_BAD_RESPONSE"
  | "SAM_REQUEST_FAILED";

export class SamError extends Error {
  readonly code: SamErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;

  constructor(code: SamErrorCode, message: string, options?: { retryable?: boolean; retryAfterSec?: number }) {
    super(message);
    this.name = "SamError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retryAfterSec = options?.retryAfterSec;
  }
}

/** Thrown when the caller's own AbortSignal (client disconnect) fires. */
export class SamClientAbortedError extends Error {
  constructor() {
    super("Client disconnected; SAM request aborted.");
    this.name = "SamClientAbortedError";
  }
}

export interface SamRequest {
  viewId: string;
  imageId: string;
  width: number;
  height: number;
  concept: string;
  categoryIntent: "pole" | "luminaire";
  requestId: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
}

export interface SamRequestOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SamMask {
  /** Polygonal path in mask-raster space (width × height below). */
  svgPath: string;
  width: number;
  height: number;
  /** Half-open source-pixel box the raster covers. */
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface SamObject {
  providerObjectId: string;
  /** Half-open source pixels. */
  box: { left: number; top: number; right: number; bottom: number };
  /** Normalized to the verified inference raster. */
  boxNorm: { x: number; y: number; w: number; h: number };
  confidence: number | null;
  mask: SamMask | null;
}

export interface SamResult {
  requestId: string;
  viewId: string;
  model: string;
  prompt: string;
  categoryIntent: "pole" | "luminaire";
  inputWidth: number;
  inputHeight: number;
  objects: SamObject[];
  truncated: boolean;
  retrievedAt: string;
}

export function isSamConfigured(): boolean {
  return (process.env.MODEL_API_KEY ?? "").trim().length > 0;
}

export function samModelName(): string {
  const configured = (process.env.SAM_MODEL ?? "").trim();
  return configured.length > 0 ? configured : SAM_DEFAULT_MODEL;
}

export function samTimeoutMs(): number {
  const raw = Number.parseInt(process.env.SAM_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(raw)) return SAM_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, SAM_MIN_TIMEOUT_MS), SAM_MAX_TIMEOUT_MS);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return undefined;
  return seconds;
}

function mapTransportError(error: TransportError): SamError {
  switch (error.kind) {
    case "aborted":
      throw new SamClientAbortedError();
    case "timeout":
      return new SamError("SAM_TIMEOUT", "The SAM request timed out.", { retryable: true });
    case "network":
      return new SamError("SAM_NETWORK_ERROR", "Could not reach the Meta Model API (network failure).", {
        retryable: true,
      });
    case "too_large":
      return new SamError("SAM_BAD_RESPONSE", "The SAM response exceeded the 10 MiB safety limit.", {
        retryable: false,
      });
    case "bad_json":
      return new SamError("SAM_BAD_RESPONSE", "The SAM response was unreadable.", { retryable: false });
  }
}

/** Split one buffered SSE payload into parsed `data:` event objects. */
export function parseSseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as unknown);
    } catch {
      throw new SamError("SAM_BAD_RESPONSE", "The SAM stream contained malformed events.", {
        retryable: false,
      });
    }
  }
  return events;
}

interface LaneCarrier {
  type?: unknown;
  item_id?: unknown;
  output_index?: unknown;
  content_index?: unknown;
  part?: { type?: unknown; text?: unknown } | null;
}

/**
 * Cookbook event normalization: the live API emits
 * `response.content_part.done` (not `response.output_text.done`) to finalize
 * the text lane, so synthesize the finalizer the parser waits for. A stream
 * with no text-lane events at all plus a bare `response.completed` is the
 * valid empty outcome — synthesize an empty lane so it parses to zero
 * records instead of failing.
 */
export async function* normalizedEvents(
  events: readonly unknown[],
): AsyncGenerator<{ readonly type: string; readonly [key: string]: unknown }> {
  const finalized = new Set<string>();
  const laneKey = (event: LaneCarrier): string =>
    `${String(event.item_id)}:${String(event.output_index)}:${String(event.content_index)}`;
  let sawLaneEvent = false;
  for (const raw of events) {
    const event = (typeof raw === "object" && raw !== null ? raw : {}) as LaneCarrier;
    if (
      event.type === "response.output_text.delta" ||
      event.type === "response.output_text.done" ||
      event.type === "response.content_part.done"
    ) {
      sawLaneEvent = true;
    }
    if (event.type === "response.output_text.done") finalized.add(laneKey(event));
    if (event.type === "response.completed" && !sawLaneEvent) {
      yield {
        type: "response.output_text.done",
        item_id: "synthetic-empty-lane",
        output_index: 0,
        content_index: 0,
        text: "",
      };
    }
    yield raw as { readonly type: string };
    if (
      event.type === "response.content_part.done" &&
      !finalized.has(laneKey(event)) &&
      event.part !== null &&
      typeof event.part === "object" &&
      event.part?.type === "output_text" &&
      typeof event.part.text === "string"
    ) {
      finalized.add(laneKey(event));
      yield {
        type: "response.output_text.done",
        item_id: event.item_id,
        output_index: event.output_index,
        content_index: event.content_index,
        text: event.part.text,
      };
    }
  }
}

/**
 * Verify the wire frame size before normalization: every box token must agree
 * on one w/h pair, and it must equal the declared inference raster. Empty
 * output (no box tokens) passes — zero matches is valid.
 */
export function verifyWireDimensions(rawOutput: string, width: number, height: number): void {
  const seen = new Set<string>();
  const pattern = /w=(\d+);h=(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawOutput)) !== null) {
    seen.add(`${match[1]}x${match[2]}`);
  }
  if (seen.size === 0) return;
  if (seen.size > 1 || !seen.has(`${width}x${height}`)) {
    throw new SamError(
      "SAM_BAD_RESPONSE",
      "The SAM response described a different image size than the analyzed raster.",
      { retryable: false },
    );
  }
}

function toNormalized(
  box: SegmentationBoxRecord,
  width: number,
  height: number,
): SamObject["boxNorm"] {
  const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);
  return {
    x: clamp01(box.left / width),
    y: clamp01(box.top / height),
    w: clamp01((box.right - box.left) / width),
    h: clamp01((box.bottom - box.top) / height),
  };
}

function masksByObject(records: readonly SegmentationMaskRecord[]): Map<string, SegmentationMaskRecord> {
  const paired = new Map<string, SegmentationMaskRecord>();
  for (const record of records) {
    if (!paired.has(record.objectId)) paired.set(record.objectId, record);
  }
  return paired;
}

function toSamObjects(result: ImageSegmentationResult, width: number, height: number): SamObject[] {
  const boxes = recordsOfKind(result.records, "box");
  const masks = masksByObject(recordsOfKind(result.records, "mask"));
  const objects: SamObject[] = [];
  for (const box of boxes) {
    const maskRecord = masks.get(box.objectId) ?? null;
    let mask: SamMask | null = null;
    if (maskRecord) {
      let svgPath = "";
      try {
        svgPath = decodeMaskToSVGPath(maskRecord.mask);
      } catch {
        throw new SamError("SAM_BAD_RESPONSE", "The SAM response carried an undecodable mask.", {
          retryable: false,
        });
      }
      if (svgPath) {
        mask = {
          svgPath,
          width: maskRecord.mask.width,
          height: maskRecord.mask.height,
          bounds: { ...maskRecord.bounds },
        };
      }
    }
    objects.push({
      providerObjectId: box.objectId,
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      boxNorm: toNormalized(box, width, height),
      confidence:
        typeof box.confidence === "number" && Number.isFinite(box.confidence) ? box.confidence : null,
      mask,
    });
  }
  return objects;
}

/**
 * Run one concept on one inference raster. Throws SamError (typed, sanitized)
 * or SamClientAbortedError (caller disconnected).
 */
export async function segmentImage(
  request: SamRequest,
  options: SamRequestOptions,
): Promise<SamResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? samTimeoutMs();
  const model = options.model ?? samModelName();

  const body = JSON.stringify({
    model,
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: request.concept },
          { type: "input_image", image_url: `data:${request.mimeType};base64,${request.dataBase64}` },
        ],
      },
    ],
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
  });

  let status: number;
  let headers: Headers;
  let bytes: Uint8Array;
  try {
    const result = await fetchBytesWithLimits(SAM_API_URL, {
      fetchImpl,
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
      timeoutMs,
      maxBytes: SAM_RESPONSE_LIMIT_BYTES,
      signal: options.signal,
    });
    status = result.status;
    headers = result.headers;
    bytes = result.bytes;
  } catch (error) {
    if (error instanceof TransportError) throw mapTransportError(error);
    throw error;
  }

  if (status === 401 || status === 403) {
    throw new SamError(
      "SAM_AUTH_ERROR",
      `The Meta Model API rejected the configured key (provider status ${status}). Check MODEL_API_KEY and the project's SAM entitlement.`,
      { retryable: false },
    );
  }
  if (status === 429) {
    throw new SamError("SAM_RATE_LIMITED", "The Meta Model API rate limit was reached.", {
      retryable: true,
      retryAfterSec: parseRetryAfter(headers),
    });
  }
  if (status < 200 || status >= 300) {
    throw new SamError(
      "SAM_REQUEST_FAILED",
      `The SAM request failed (provider status ${status}).`,
      { retryable: status >= 500 },
    );
  }

  const text = new TextDecoder().decode(bytes);
  const events = parseSseEvents(text);
  let parsed: ImageSegmentationResult;
  try {
    parsed = await parseImageStream(normalizedEvents(events)).finalResult;
  } catch (error) {
    if (error instanceof Error && error.name === "ResponsesStreamRefusalError") {
      throw new SamError("SAM_REQUEST_FAILED", "The model refused this image.", { retryable: false });
    }
    if (error instanceof Error && error.name === "ResponsesStreamFailedError") {
      throw new SamError("SAM_REQUEST_FAILED", "The model request failed.", { retryable: false });
    }
    throw new SamError("SAM_BAD_RESPONSE", "The SAM response could not be parsed.", {
      retryable: false,
    });
  }
  if (parsed.outcome.status !== "completed") {
    throw new SamError("SAM_REQUEST_FAILED", "The SAM response did not complete.", {
      retryable: true,
    });
  }
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new SamError("SAM_BAD_RESPONSE", "The SAM response contained errors.", { retryable: false });
  }

  verifyWireDimensions(parsed.rawOutput, request.width, request.height);
  const objects = toSamObjects(parsed, request.width, request.height);
  if (objects.length === 0 && parsed.rawOutput.trim().length > 0) {
    // Documented zero-match output is an EMPTY lane; text without boxes is
    // malformed and must never read as zero matches.
    throw new SamError("SAM_BAD_RESPONSE", "The SAM response contained no usable detections.", {
      retryable: false,
    });
  }
  return {
    requestId: request.requestId,
    viewId: request.viewId,
    model,
    prompt: request.concept,
    categoryIntent: request.categoryIntent,
    inputWidth: request.width,
    inputHeight: request.height,
    objects: objects.slice(0, SAM_MAX_OBJECTS),
    truncated: objects.length > SAM_MAX_OBJECTS,
    retrievedAt: new Date().toISOString(),
  };
}
