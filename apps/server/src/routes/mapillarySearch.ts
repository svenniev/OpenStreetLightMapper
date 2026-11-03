import express from "express";
import {
  checkRoiLimits,
  validateRoiPolygon,
} from "@openstreetlightmapper/geo";
import { MAPILLARY_SEARCH_LIMIT, searchMapillaryByBbox } from "../mapillary.js";
import { processProviderRecords } from "../search.js";
import { abortOnDisconnect, errorBody, sendMapillaryError } from "./errors.js";

export interface SearchRouteDeps {
  fetchImpl?: typeof fetch;
  mapillaryTimeoutMs?: number;
}

/** Reads configuration at request time so tests and restarts behave identically. */
function readSearchToken(): string {
  return (process.env.MAPILLARY_ACCESS_TOKEN ?? "").trim();
}

export function isMapillarySearchConfigured(): boolean {
  return readSearchToken().length > 0;
}

/**
 * POST /api/mapillary/images/search
 * Body: { roi: GeoJSON Polygon }. The bounding box is computed server-side
 * from validated geometry; no client-supplied area, URL, fields, limit, or
 * token is trusted.
 */
export function createSearchRouter(deps?: SearchRouteDeps): express.Router {
  const router = express.Router();

  router.post("/api/mapillary/images/search", async (req, res) => {
    const requestedAt = new Date().toISOString();

    const roi = (req.body as { roi?: unknown } | undefined)?.roi;
    const validation = validateRoiPolygon(roi);
    if (!validation.ok) {
      res.status(400).json(errorBody(validation.code, validation.message, false));
      return;
    }
    const limits = checkRoiLimits(validation.areaSqM, validation.bbox);
    if (!limits.ok) {
      res
        .status(400)
        .json(errorBody(limits.code ?? "REGION_TOO_LARGE", limits.message ?? "Region too large.", false));
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

    // Abort upstream work when the HTTP client disconnects; never leave a
    // background collection running after the caller is gone.
    const upstream = new AbortController();
    const release = abortOnDisconnect(res, upstream);

    try {
      const provider = await searchMapillaryByBbox({
        bbox: validation.bbox,
        token,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: deps?.mapillaryTimeoutMs,
        signal: upstream.signal,
      });
      const retrievedAt = new Date().toISOString();
      const processed = processProviderRecords(validation.ring, provider.records, {
        providerLimit: MAPILLARY_SEARCH_LIMIT,
        hasMoreIndication: provider.hasMoreIndication,
      });
      res.json({
        images: processed.images,
        query: {
          bbox: validation.bbox,
          requestedAt,
          retrievedAt,
          providerLimit: MAPILLARY_SEARCH_LIMIT,
          rawReturnedCount: processed.rawReturnedCount,
          matchedCount: processed.matchedCount,
          invalidRecordCount: processed.invalidRecordCount,
          outsideRoiCount: processed.outsideRoiCount,
          duplicateCount: processed.duplicateCount,
          retrievalStatus: processed.retrievalStatus,
        },
        warnings: processed.warnings,
      });
    } catch (error) {
      if (sendMapillaryError(res, error)) {
        // Handled (or the caller is gone and there is nothing to send).
      } else {
        res
          .status(500)
          .json(errorBody("SEARCH_FAILED", "Image search failed unexpectedly.", false));
      }
    } finally {
      release();
    }
  });

  return router;
}
