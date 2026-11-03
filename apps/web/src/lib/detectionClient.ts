import { ApiError, requestJson } from "./api";
import { cropPixels, exifOrientation } from "../features/inventory/imageViews";
import type { SourceView } from "../features/inventory/inventoryTypes";

/**
 * Detection client: on-demand Mapillary photograph metadata, one-image SAM
 * inference, and the browser raster pipeline.
 *
 * Raster rule: the bytes sent to SAM are re-encoded from the exact displayed
 * raster (EXIF orientation applied, recorded crop cut out), so model boxes
 * always address the pixels the user sees. Decoded dimensions come from the
 * bitmap, never from upload metadata.
 */

export interface ImageryDetail {
  imageId: string;
  sequenceId: string | null;
  capturedAt: number | null;
  isPano: boolean | null;
  compassAngle: number | null;
  creator: string | null;
  attribution: string;
  sourceUrl: string;
  cameraPosition: { lng: number; lat: number } | null;
  coordinateSource: "geometry" | "computed_geometry" | null;
  resolution: string;
}

export interface ImageryResponse {
  image: ImageryDetail;
  media: { handle: string; url: string; expiresAt: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateImagery(body: unknown): ImageryResponse | null {
  if (!isRecord(body) || !isRecord(body.image) || !isRecord(body.media)) return null;
  const image = body.image;
  if (typeof image.imageId !== "string" || image.imageId.length === 0) return null;
  if (typeof image.attribution !== "string" || typeof image.sourceUrl !== "string") return null;
  if (typeof image.resolution !== "string") return null;
  if (typeof body.media.handle !== "string" || typeof body.media.url !== "string") return null;
  return body as unknown as ImageryResponse;
}

/** On-demand photograph metadata + app-owned media handle for one image ID. */
export function fetchImagery(imageId: string, signal?: AbortSignal): Promise<ImageryResponse> {
  return requestJson(
    `/api/imagery/${encodeURIComponent(imageId)}`,
    { signal, what: "imagery" },
    validateImagery,
  );
}

export function mediaUrlFor(handle: string): string {
  return `/api/imagery/media/${handle}`;
}

export interface SamDetectionInput {
  view: { viewId: string; imageId: string; width: number; height: number };
  concept: string;
  categoryIntent: "pole" | "luminaire";
  requestId: string;
  image: { mimeType: "image/jpeg" | "image/png" | "image/webp"; dataBase64: string; width: number; height: number };
}

export interface SamDetectionObject {
  providerObjectId: string;
  box: { left: number; top: number; right: number; bottom: number };
  boxNorm: { x: number; y: number; w: number; h: number };
  confidence: number | null;
  mask: {
    svgPath: string;
    width: number;
    height: number;
    bounds: { left: number; top: number; right: number; bottom: number };
  } | null;
}

export interface SamDetectionResponse {
  requestId: string;
  viewId: string;
  provider: string;
  model: string;
  prompt: string;
  categoryIntent: "pole" | "luminaire";
  inputWidth: number;
  inputHeight: number;
  objects: SamDetectionObject[];
  truncated: boolean;
  retrievedAt: string;
}

function validateDetection(body: unknown): SamDetectionResponse | null {
  if (!isRecord(body)) return null;
  if (typeof body.requestId !== "string" || typeof body.viewId !== "string") return null;
  if (typeof body.provider !== "string" || typeof body.model !== "string") return null;
  if (typeof body.prompt !== "string") return null;
  if (body.categoryIntent !== "pole" && body.categoryIntent !== "luminaire") return null;
  if (typeof body.inputWidth !== "number" || typeof body.inputHeight !== "number") return null;
  if (!Array.isArray(body.objects) || typeof body.truncated !== "boolean") return null;
  return body as unknown as SamDetectionResponse;
}

/** One concept on one raster: exactly one chargeable model call. */
export function postSamDetection(
  input: SamDetectionInput,
  signal?: AbortSignal,
): Promise<SamDetectionResponse> {
  return requestJson(
    "/api/detection/sam",
    {
      method: "POST",
      payload: {
        view: input.view,
        concept: input.concept,
        categoryIntent: input.categoryIntent,
        requestId: input.requestId,
        image: input.image,
      },
      signal,
      what: "detection",
    },
    validateDetection,
  );
}

export interface DecodedMedia {
  orientation: number;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

/** 15 MiB mirrors the server media cap; anything larger fails closed here too. */
export const CLIENT_MEDIA_LIMIT_BYTES = 15 * 1024 * 1024;
/** 8 MiB upload cap matches the server raster validation. */
export const CLIENT_RASTER_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Download and decode one media URL with EXIF orientation applied. The caller
 * owns the returned bitmap and must close() it; use rasterizeView or
 * measureMedia instead of holding bitmaps.
 */
export async function decodeMedia(mediaUrl: string, signal?: AbortSignal): Promise<DecodedMedia> {
  let response: Response;
  try {
    response = await fetch(mediaUrl, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError("MEDIA_UNREACHABLE", "The photograph could not be downloaded.", true);
  }
  if (!response.ok) {
    if (response.status === 410) {
      throw new ApiError(
        "MEDIA_HANDLE_EXPIRED",
        "This media handle expired. Reload the image metadata.",
        false,
        410,
      );
    }
    throw new ApiError(
      "MEDIA_FAILED",
      `The photograph download failed (status ${response.status}).`,
      response.status >= 500,
      response.status,
    );
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > CLIENT_MEDIA_LIMIT_BYTES) {
    throw new ApiError("MEDIA_TOO_LARGE", "The photograph exceeds the 15 MiB decode limit.", false);
  }
  const orientation = exifOrientation(new Uint8Array(buffer));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buffer]), { imageOrientation: "from-image" });
  } catch {
    throw new ApiError(
      "MEDIA_DECODE_FAILED",
      "The photograph could not be decoded (unsupported format).",
      false,
    );
  }
  if (bitmap.width <= 0 || bitmap.height <= 0) {
    bitmap.close();
    throw new ApiError("MEDIA_DECODE_FAILED", "The photograph decoded to an empty raster.", false);
  }
  return { orientation, width: bitmap.width, height: bitmap.height, bitmap };
}

/** Decode dims + orientation for a media URL, releasing the bitmap. */
export async function measureMedia(
  mediaUrl: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; orientation: number }> {
  const decoded = await decodeMedia(mediaUrl, signal);
  const dims = { width: decoded.width, height: decoded.height, orientation: decoded.orientation };
  decoded.bitmap.close();
  return dims;
}

export interface RasterUpload {
  mimeType: "image/jpeg";
  dataBase64: string;
  width: number;
  height: number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("Unreadable raster encoding."));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("Unreadable raster encoding."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Re-encode the exact displayed raster (full photo or recorded crop) as an
 * uploadable JPEG. Dimensions come from the decoded bitmap.
 */
export async function rasterizeView(
  view: Pick<SourceView, "crop">,
  mediaUrl: string,
  signal?: AbortSignal,
): Promise<RasterUpload> {
  const decoded = await decodeMedia(mediaUrl, signal);
  try {
    const region = view.crop
      ? cropPixels(view.crop, decoded.width, decoded.height)
      : { x: 0, y: 0, w: decoded.width, h: decoded.height };
    const canvas = document.createElement("canvas");
    canvas.width = region.w;
    canvas.height = region.h;
    const context = canvas.getContext("2d");
    if (!context) throw new ApiError("RASTER_FAILED", "The browser 2D canvas is unavailable.", false);
    context.drawImage(decoded.bitmap, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/jpeg", 0.92),
    );
    if (!blob) throw new ApiError("RASTER_FAILED", "The raster could not be encoded.", false);
    if (blob.size > CLIENT_RASTER_LIMIT_BYTES) {
      throw new ApiError(
        "RASTER_TOO_LARGE",
        "This view encodes to more than 8 MiB — choose a smaller crop.",
        false,
      );
    }
    const dataBase64 = await blobToBase64(blob);
    return { mimeType: "image/jpeg", dataBase64, width: region.w, height: region.h };
  } finally {
    decoded.bitmap.close();
  }
}
