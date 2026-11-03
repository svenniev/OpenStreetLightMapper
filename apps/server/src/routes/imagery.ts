import express from "express";
import {
  attributionFor,
  fetchImageDetail,
  fetchMediaBytes,
  isValidImageId,
  issueMediaHandle,
  sourceUrlFor,
  UnknownHandleError,
} from "../imagery.js";
import { abortOnDisconnect, errorBody, sendMapillaryError } from "./errors.js";

export interface ImageryRouteDeps {
  fetchImpl?: typeof fetch;
  mapillaryTimeoutMs?: number;
}

function readSearchToken(): string {
  return (process.env.MAPILLARY_ACCESS_TOKEN ?? "").trim();
}

/**
 * Imagery routes: on-demand photograph metadata and same-origin media.
 *
 * GET /api/imagery/:imageId — validated source metadata, attribution, and an
 * app-owned media handle. No client-supplied fields, URLs, or tokens.
 * GET /api/imagery/media/:handle — the exact thumbnail bytes behind a live
 * handle. Unknown handles fail closed; this is not a general URL proxy.
 */
export function createImageryRouter(deps?: ImageryRouteDeps): express.Router {
  const router = express.Router();

  router.get("/api/imagery/:imageId", async (req, res) => {
    const imageId = req.params.imageId ?? "";
    if (!isValidImageId(imageId)) {
      res
        .status(400)
        .json(errorBody("IMAGERY_BAD_ID", "That is not a valid Mapillary image ID.", false));
      return;
    }
    const token = readSearchToken();
    if (!token) {
      res
        .status(503)
        .json(
          errorBody(
            "MAPILLARY_NOT_CONFIGURED",
            "Mapillary search is not configured on the server. Set MAPILLARY_ACCESS_TOKEN (see apps/server/.env.example).",
            false,
          ),
        );
      return;
    }

    const upstream = new AbortController();
    const release = abortOnDisconnect(res, upstream);
    try {
      const detail = await fetchImageDetail({
        imageId,
        token,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: deps?.mapillaryTimeoutMs,
        signal: upstream.signal,
      });
      const media = issueMediaHandle(detail);
      res.json({
        image: {
          imageId: detail.imageId,
          sequenceId: detail.sequenceId,
          capturedAt: detail.capturedAt,
          isPano: detail.isPano,
          compassAngle: detail.compassAngle,
          creator: detail.creator,
          attribution: attributionFor(detail),
          sourceUrl: sourceUrlFor(detail.imageId),
          cameraPosition: detail.cameraPosition
            ? { lng: detail.cameraPosition[0], lat: detail.cameraPosition[1] }
            : null,
          coordinateSource: detail.coordinateSource,
          resolution: detail.resolution,
        },
        media: {
          handle: media.handle,
          url: `/api/imagery/media/${media.handle}`,
          expiresAt: media.expiresAt,
        },
      });
    } catch (error) {
      if (!sendMapillaryError(res, error)) {
        res
          .status(500)
          .json(errorBody("IMAGERY_FAILED", "Image detail failed unexpectedly.", false));
      }
    } finally {
      release();
    }
  });

  router.get("/api/imagery/media/:handle", async (req, res) => {
    const handle = req.params.handle ?? "";
    // Handles are server-issued UUIDs; anything else is unknown by construction.
    if (!/^[0-9a-fA-F-]{36}$/.test(handle)) {
      res
        .status(410)
        .json(
          errorBody(
            "IMAGERY_UNKNOWN_HANDLE",
            "This media handle is unknown or expired. Reload the image metadata.",
            false,
          ),
        );
      return;
    }
    const upstream = new AbortController();
    const release = abortOnDisconnect(res, upstream);
    try {
      const media = await fetchMediaBytes(handle, {
        fetchImpl: deps?.fetchImpl,
        timeoutMs: deps?.mapillaryTimeoutMs,
        signal: upstream.signal,
      });
      res.setHeader("content-type", media.contentType);
      res.setHeader("content-length", String(media.bytes.byteLength));
      res.setHeader("cache-control", "private, max-age=300");
      res.setHeader("x-content-type-options", "nosniff");
      res.send(media.bytes);
    } catch (error) {
      if (error instanceof UnknownHandleError) {
        res
          .status(410)
          .json(
            errorBody(
              "IMAGERY_UNKNOWN_HANDLE",
              "This media handle is unknown or expired. Reload the image metadata.",
              false,
            ),
          );
      } else if (!sendMapillaryError(res, error)) {
        res
          .status(500)
          .json(errorBody("IMAGERY_FAILED", "Image media failed unexpectedly.", false));
      }
    } finally {
      release();
    }
  });

  return router;
}
