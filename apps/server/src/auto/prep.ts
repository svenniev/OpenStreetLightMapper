import sharp from "sharp";
import { llaToEnu, validateCameraDescriptor } from "@openstreetlightmapper/geo";
import { fetchBytesWithLimits, TransportError } from "../providerHttp.js";
import {
  validateAutoViewDescriptor,
  type AutoViewOp,
  type ValidatedAutoViewDescriptor,
  type ValidatedPlanImageMeta,
} from "../db/autoValidation.js";

/**
 * Server-side analysis-view preparation: restricted thumbnail fetch,
 * EXIF-aware decode, bounded resize, JPEG encode, and a validated view
 * descriptor with an invertible pixel chain. No database access here; the
 * worker stores the returned bytes in GridFS before calling SAM.
 */

export const PREP_FETCH_BYTES_MAX = 32 * 1024 * 1024;
export const PREP_PIXELS_MAX = 100_000_000;
export const PREP_REDIRECTS_MAX = 3;
export const PREP_TIMEOUT_MS = 60_000;
/** Thumbnail/provider aspect agreement (thumbnail is a uniform scale). */
export const PREP_DIMENSION_ASPECT_TOLERANCE = 0.02;

export type PrepErrorCode =
  | "PREP_BAD_URL"
  | "PREP_FETCH_FAILED"
  | "PREP_TOO_LARGE"
  | "PREP_DECODE_FAILED"
  | "PREP_TOO_MANY_PIXELS"
  | "PREP_UNSUPPORTED_EXIF"
  | "PREP_DIMENSION_MISMATCH";

export class PrepError extends Error {
  readonly code: PrepErrorCode;

  constructor(code: PrepErrorCode, message: string) {
    super(message);
    this.name = "PrepError";
    this.code = code;
  }
}

/** Thumbnail hosts: the Mapillary CDN only. Nothing else is fetched. */
export function isPrepUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "fbcdn.net" || host.endsWith(".fbcdn.net");
}

export interface PrepFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function mapPrepTransport(error: TransportError): PrepError {
  switch (error.kind) {
    case "timeout":
      return new PrepError("PREP_FETCH_FAILED", "Thumbnail fetch timed out.");
    case "network":
      return new PrepError("PREP_FETCH_FAILED", "Could not reach the thumbnail host.");
    case "too_large":
      return new PrepError("PREP_TOO_LARGE", "Thumbnail exceeds the 32 MiB fetch cap.");
    default:
      return new PrepError("PREP_FETCH_FAILED", "Thumbnail fetch failed.");
  }
}

/**
 * Fetch thumbnail bytes with per-hop allowlist validation. Redirects are
 * followed manually (never by the HTTP client) so escapes off the CDN fail
 * closed instead of fetching an attacker's pixels.
 */
export async function fetchPrepBytes(url: string, options: PrepFetchOptions = {}): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PREP_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= PREP_REDIRECTS_MAX; hop += 1) {
    if (!isPrepUrlAllowed(current)) {
      throw new PrepError("PREP_BAD_URL", "Thumbnail URL is outside the Mapillary CDN allowlist.");
    }
    let result: { status: number; headers: Headers; bytes: Uint8Array };
    try {
      result = await fetchBytesWithLimits(current, {
        fetchImpl,
        redirect: "manual",
        timeoutMs,
        maxBytes: PREP_FETCH_BYTES_MAX,
        signal: options.signal,
        headers: { Accept: "image/*" },
      });
    } catch (error) {
      if (error instanceof TransportError) {
        if (error.kind === "aborted") throw error;
        throw mapPrepTransport(error);
      }
      throw error;
    }
    if (result.status >= 300 && result.status < 400) {
      const location = result.headers.get("location");
      if (!location) {
        throw new PrepError("PREP_FETCH_FAILED", "Thumbnail redirect had no destination.");
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new PrepError("PREP_BAD_URL", "Thumbnail redirect destination is not a URL.");
      }
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new PrepError("PREP_FETCH_FAILED", `Thumbnail fetch failed (status ${result.status}).`);
    }
    return Buffer.from(result.bytes);
  }
  throw new PrepError("PREP_FETCH_FAILED", "Thumbnail redirect chain is too long.");
}

export interface PrepViewInput extends PrepFetchOptions {
  imageId: string;
  /** Frozen (plan) or refreshed (prep) geometry; pixels always come fresh. */
  meta: ValidatedPlanImageMeta;
  geometrySource: "plan" | "prep-refetch";
  thumbKind: string;
  thumbUrl: string;
  anchor: { lngLat: [number, number]; altM: number };
  analysisLongSidePx: number;
  encodeQuality: number;
}

export interface PrepViewOutput {
  bytes: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
  chain: AutoViewOp[];
  descriptor: ValidatedAutoViewDescriptor;
  prepWarnings: string[];
}

const ORIENT_EXIF = new Set([1, 3, 6, 8]);

export async function prepareAnalysisView(input: PrepViewInput): Promise<PrepViewOutput> {
  const bytes = await fetchPrepBytes(input.thumbUrl, input);
  let storedW: number;
  let storedH: number;
  let orientation: number;
  try {
    const info = await sharp(bytes).metadata();
    if (info.format !== "jpeg" && info.format !== "png" && info.format !== "webp") {
      throw new PrepError("PREP_DECODE_FAILED", `Thumbnail format ${info.format ?? "unknown"} is not supported.`);
    }
    if (!info.width || !info.height) {
      throw new PrepError("PREP_DECODE_FAILED", "Thumbnail decoded without dimensions.");
    }
    storedW = info.width;
    storedH = info.height;
    orientation = info.orientation ?? 1;
  } catch (error) {
    if (error instanceof PrepError) throw error;
    throw new PrepError("PREP_DECODE_FAILED", "Thumbnail bytes did not decode as an image.");
  }
  if (storedW * storedH > PREP_PIXELS_MAX) {
    throw new PrepError("PREP_TOO_MANY_PIXELS", "Thumbnail exceeds the 100 megapixel decode cap.");
  }
  if (!ORIENT_EXIF.has(orientation)) {
    throw new PrepError(
      "PREP_UNSUPPORTED_EXIF",
      `EXIF orientation ${orientation} is mirrored or unknown; only 1, 3, 6, and 8 are supported.`,
    );
  }
  const ops: AutoViewOp[] = [];
  let pipeline = sharp(bytes);
  let width = storedW;
  let height = storedH;
  if (orientation !== 1) {
    pipeline = pipeline.rotate();
    ops.push({ op: "orient", exif: orientation as 1 | 3 | 6 | 8, fromW: storedW, fromH: storedH });
    if (orientation === 6 || orientation === 8) {
      width = storedH;
      height = storedW;
    }
  }
  // The thumbnail must be a uniform scale of the provider original; a
  // mismatch means the pixels and the frozen geometry disagree. The check
  // is transpose-tolerant because the provider may report stored or display
  // dimensions for EXIF-rotated originals.
  const warnings: string[] = [];
  if (input.meta.originalWidth && input.meta.originalHeight) {
    const providerAspect = input.meta.originalWidth / input.meta.originalHeight;
    const observedAspect = width / height;
    const direct = Math.abs(providerAspect - observedAspect) / providerAspect;
    const transposed = Math.abs(1 / providerAspect - observedAspect) / (1 / providerAspect);
    if (Math.min(direct, transposed) > PREP_DIMENSION_ASPECT_TOLERANCE) {
      throw new PrepError(
        "PREP_DIMENSION_MISMATCH",
        `Thumbnail is ${width}x${height} but the provider original is ` +
          `${input.meta.originalWidth}x${input.meta.originalHeight}; refusing to mix them.`,
      );
    }
  } else {
    warnings.push("Original dimensions unknown; skipped the thumbnail dimension check.");
  }
  const longSide = Math.max(width, height);
  if (longSide > input.analysisLongSidePx) {
    const scale = input.analysisLongSidePx / longSide;
    const toW = Math.max(1, Math.round(width * scale));
    const toH = Math.max(1, Math.round(height * scale));
    pipeline = pipeline.resize(toW, toH, { fit: "fill", kernel: "lanczos3" });
    ops.push({ op: "resize", fromW: width, fromH: height, toW, toH });
    width = toW;
    height = toH;
  }
  let outBytes: Buffer;
  try {
    outBytes = await pipeline.jpeg({ quality: input.encodeQuality }).toBuffer();
    const verify = await sharp(outBytes).metadata();
    if (verify.width !== width || verify.height !== height) {
      throw new PrepError("PREP_DECODE_FAILED", "Analysis view encoded at unexpected dimensions.");
    }
  } catch (error) {
    if (error instanceof PrepError) throw error;
    throw new PrepError("PREP_DECODE_FAILED", "Analysis view encode failed.");
  }
  const meta = input.meta;
  // Equirectangular panoramas carry no parameters; perspective must.
  // validateCameraDescriptor enforces the per-model rule.
  const cameraVerdict =
    meta.cameraType && meta.originalWidth && meta.originalHeight
      ? validateCameraDescriptor({
          cameraType: meta.cameraType,
          cameraParameters: meta.cameraParameters,
          width: meta.originalWidth,
          height: meta.originalHeight,
        })
      : { ok: false as const };
  const camera =
    cameraVerdict.ok && meta.cameraType
      ? { cameraType: meta.cameraType, cameraParameters: [...(meta.cameraParameters ?? [])] }
      : null;
  const lngLat = meta.computedLngLat ?? meta.originalLngLat;
  const positionSource = meta.computedLngLat ? "computed" : meta.originalLngLat ? "original" : null;
  const altitudeM = meta.computedAltitudeM ?? meta.originalAltitudeM;
  const pose =
    lngLat && altitudeM !== null && meta.rotationAxisAngle && positionSource
      ? {
          centerEnu: llaToEnu(lngLat[0], lngLat[1], altitudeM, input.anchor),
          rotationWcAxisAngle: [...meta.rotationAxisAngle] as [number, number, number],
          positionSource,
          rotationSource: "computed" as const,
        }
      : null;
  const compass = meta.computedCompassDeg ?? meta.compassDeg;
  let descriptor: ValidatedAutoViewDescriptor;
  try {
    descriptor = validateAutoViewDescriptor({
      width,
      height,
      chain: { ops },
      camera,
      pose,
      anchor: input.anchor,
      source: {
        imageId: input.imageId,
        thumbKind: input.thumbKind,
        geometrySource: input.geometrySource,
        originalWidth: meta.originalWidth,
        originalHeight: meta.originalHeight,
        providerExifOrientation: meta.exifOrientation,
        observedExifOrientation: orientation,
        originalLngLat: meta.originalLngLat,
        computedLngLat: meta.computedLngLat,
        compassDeg: compass,
        altitudeM,
        mergeCc: meta.mergeCc,
        atomicScale: meta.atomicScale,
        metadataFields: meta.metadataFields,
        prepWarnings: warnings,
      },
    });
  } catch (error) {
    throw new PrepError(
      "PREP_DECODE_FAILED",
      `Prepared view failed validation: ${error instanceof Error ? error.message : "unknown"}.`,
    );
  }
  return { bytes: outBytes, mime: "image/jpeg", width, height, chain: ops, descriptor, prepWarnings: warnings };
}
