import express from "express";
import { checkRoiLimits, validateRoiPolygon } from "@openstreetlightmapper/geo";
import {
  StreetAbortedError,
  StreetError,
  buildOverpassQuery,
  fetchOverpassWays,
  processOverpassElements,
} from "../streets.js";
import { abortOnDisconnect, errorBody } from "./errors.js";

export interface StreetsRouteDeps {
  fetchImpl?: typeof fetch;
  overpassTimeoutMs?: number;
  overpassUrl?: string;
}

function readOverpassUrl(override?: string): string {
  if (override !== undefined) return override;
  const configured = (process.env.OVERPASS_URL ?? "").trim();
  return configured.length > 0 ? configured : "https://overpass-api.de/api/interpreter";
}

/**
 * POST /api/streets/search
 * Body: { roi: GeoJSON Polygon }.
 *
 * Retrieves eligible OSM highway ways through a server-side Overpass query,
 * clips them to the actual polygon, and groups them into street work items.
 * Independent of Mapillary configuration.
 */
export function createStreetsRouter(deps?: StreetsRouteDeps): express.Router {
  const router = express.Router();

  router.post("/api/streets/search", async (req, res) => {
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

    const upstream = new AbortController();
    const release = abortOnDisconnect(res, upstream);
    try {
      const query = buildOverpassQuery(validation.bbox, validation.ring);
      const { elements } = await fetchOverpassWays({
        endpoint: readOverpassUrl(deps?.overpassUrl),
        query,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: deps?.overpassTimeoutMs,
        signal: upstream.signal,
      });
      const retrievedAt = new Date().toISOString();
      const { dataset } = processOverpassElements(elements, validation.ring);
      const warnings: string[] = [];
      if (dataset.invalidWayCount > 0) warnings.push("STREET_WAYS_INVALID");
      res.json({
        streets: dataset.streets,
        query: {
          bbox: validation.bbox,
          requestedAt,
          retrievedAt,
          candidateCount: dataset.candidateCount,
          invalidWayCount: dataset.invalidWayCount,
          ineligibleWayCount: dataset.ineligibleWayCount,
          outsideCount: dataset.outsideCount,
          streetCount: dataset.streets.length,
          status: "complete",
        },
        warnings,
      });
    } catch (error) {
      if (error instanceof StreetAbortedError) return; // Caller is gone; nothing to send.
      if (error instanceof StreetError) {
        const status =
          error.code === "OVERPASS_RATE_LIMITED"
            ? 429
            : error.code === "OVERPASS_TIMEOUT"
              ? 504
              : error.code === "STREET_LIMIT_EXCEEDED"
                ? 400
                : error.code === "OVERPASS_MISCONFIGURED"
                  ? 500
                  : 502;
        if (error.code === "OVERPASS_RATE_LIMITED" && error.retryAfterSec !== undefined) {
          res.setHeader("Retry-After", String(error.retryAfterSec));
        }
        // Codes and statuses only; upstream bodies are never logged.
        console.warn(`[streets] Overpass failure: ${error.code} -> HTTP ${status}`);
        res.status(status).json(errorBody(error.code, error.message, error.retryable));
        return;
      }
      res
        .status(500)
        .json(errorBody("STREETS_FAILED", "Street search failed unexpectedly.", false));
    } finally {
      release();
    }
  });

  return router;
}
