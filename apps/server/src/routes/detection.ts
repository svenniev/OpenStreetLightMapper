import express from "express";
import {
  SAM_MAX_CONCEPT_LENGTH,
  SamClientAbortedError,
  SamError,
  segmentImage,
  type SamRequest,
} from "../sam.js";
import { isSamConfigured, samModelName } from "../sam.js";
import { abortOnDisconnect, errorBody, sendSamError } from "./errors.js";

export interface DetectionRouteDeps {
  fetchImpl?: typeof fetch;
  samTimeoutMs?: number;
}

/** 8192px per side: generous for thumbnails, closed for absurd inputs. */
const MAX_SIDE_PX = 8192;
/** ~8 MiB of decoded raster bytes, measured on the base64 text. */
const MAX_BASE64_CHARS = 11_184_812;

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isSide(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_SIDE_PX
  );
}

function isBase64Text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BASE64_CHARS &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

/** Cheap magic-byte check on the first decoded bytes: fail fast on wrong MIME. */
function magicMatches(mimeType: string, dataBase64: string): boolean {
  let head: Buffer;
  try {
    head = Buffer.from(dataBase64.slice(0, 24), "base64");
  } catch {
    return false;
  }
  if (mimeType === "image/jpeg") return head.length >= 2 && head[0] === 0xff && head[1] === 0xd8;
  if (mimeType === "image/png") {
    return (
      head.length >= 8 &&
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47
    );
  }
  if (mimeType === "image/webp") {
    return (
      head.length >= 12 &&
      head.toString("ascii", 0, 4) === "RIFF" &&
      head.toString("ascii", 8, 12) === "WEBP"
    );
  }
  return false;
}

function validateRequest(body: unknown): SamRequest | { message: string } {
  if (typeof body !== "object" || body === null) return { message: "Request must be a JSON object." };
  const record = body as Record<string, unknown>;
  const view = record.view as Record<string, unknown> | undefined;
  const image = record.image as Record<string, unknown> | undefined;
  if (!view || typeof view !== "object") return { message: "A view descriptor is required." };
  if (!image || typeof image !== "object") return { message: "Image bytes are required." };
  if (!isId(view.viewId)) return { message: "view.viewId must be a non-empty string." };
  if (!isId(view.imageId)) return { message: "view.imageId must be a non-empty string." };
  if (!isSide(view.width) || !isSide(view.height)) {
    return { message: "View dimensions must be positive integers within bounds." };
  }
  if (image.width !== view.width || image.height !== view.height) {
    return { message: "Image bytes must match the view dimensions." };
  }
  const concept = typeof record.concept === "string" ? record.concept.trim() : "";
  if (concept.length === 0 || concept.length > SAM_MAX_CONCEPT_LENGTH || /[\r\n]/.test(concept)) {
    return { message: "Concept must be a short single-line phrase." };
  }
  if (record.categoryIntent !== "pole" && record.categoryIntent !== "luminaire") {
    return { message: "categoryIntent must be pole or luminaire." };
  }
  if (!isId(record.requestId)) return { message: "requestId must be a non-empty string." };
  if (
    image.mimeType !== "image/jpeg" &&
    image.mimeType !== "image/png" &&
    image.mimeType !== "image/webp"
  ) {
    return { message: "Image must be JPEG, PNG, or WebP." };
  }
  if (!isBase64Text(image.dataBase64)) {
    return { message: "Image data must be base64 within the 8 MiB raster limit." };
  }
  if (!magicMatches(image.mimeType, image.dataBase64)) {
    return { message: "Image bytes do not match the declared image type." };
  }
  return {
    viewId: view.viewId,
    imageId: view.imageId,
    width: view.width,
    height: view.height,
    concept,
    categoryIntent: record.categoryIntent,
    requestId: record.requestId,
    mimeType: image.mimeType,
    dataBase64: image.dataBase64,
  };
}

/**
 * POST /api/detection/sam — one concept on one inference raster.
 *
 * One request is exactly one chargeable model call. The browser orchestrates
 * bounded batches; the server holds no jobs, queues, or provider sessions.
 */
export function createDetectionRouter(deps?: DetectionRouteDeps): express.Router {
  const router = express.Router();

  router.post("/api/detection/sam", async (req, res) => {
    const validated = validateRequest(req.body);
    if ("message" in validated) {
      res.status(400).json(errorBody("SAM_BAD_REQUEST", validated.message, false));
      return;
    }
    const apiKey = (process.env.MODEL_API_KEY ?? "").trim();
    if (!apiKey) {
      res
        .status(503)
        .json(
          errorBody(
            "SAM_NOT_CONFIGURED",
            "SAM detection is not configured on the server. Set MODEL_API_KEY (see apps/server/.env.example).",
            false,
          ),
        );
      return;
    }

    const upstream = new AbortController();
    const release = abortOnDisconnect(res, upstream);
    try {
      const result = await segmentImage(validated, {
        apiKey,
        model: samModelName(),
        fetchImpl: deps?.fetchImpl,
        timeoutMs: deps?.samTimeoutMs,
        signal: upstream.signal,
      });
      res.json({
        requestId: result.requestId,
        viewId: result.viewId,
        provider: "meta-sam",
        model: result.model,
        prompt: result.prompt,
        categoryIntent: result.categoryIntent,
        inputWidth: result.inputWidth,
        inputHeight: result.inputHeight,
        objects: result.objects.map((object) => ({
          providerObjectId: object.providerObjectId,
          box: object.box,
          boxNorm: object.boxNorm,
          confidence: object.confidence,
          mask: object.mask,
        })),
        truncated: result.truncated,
        retrievedAt: result.retrievedAt,
      });
    } catch (error) {
      if (error instanceof SamClientAbortedError) {
        // Caller is gone; nothing to send.
      } else if (error instanceof SamError) {
        sendSamError(res, error);
      } else {
        res
          .status(500)
          .json(errorBody("SAM_REQUEST_FAILED", "SAM detection failed unexpectedly.", false));
      }
    } finally {
      release();
    }
  });

  return router;
}

export function isSamDetectionConfigured(): boolean {
  return isSamConfigured();
}
