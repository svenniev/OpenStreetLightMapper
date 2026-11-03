import express from "express";
import { checkRoiLimits, validateRoiPolygon } from "@openstreetlightmapper/geo";
import {
  SEQUENCE_MAX_KNOWN_IDS,
  isProviderId,
  loadSequenceDetail,
} from "../sequences.js";
import { abortOnDisconnect, errorBody, sendMapillaryError } from "./errors.js";

export interface SequenceRouteDeps {
  fetchImpl?: typeof fetch;
  mapillaryTimeoutMs?: number;
  sequenceTotalTimeoutMs?: number;
}

function readSearchToken(): string {
  return (process.env.MAPILLARY_ACCESS_TOKEN ?? "").trim();
}

/**
 * POST /api/mapillary/sequences/:sequenceId/images
 * Body: { roi: GeoJSON Polygon, knownIds?: string[] }.
 *
 * Returns membership in provider order plus records hydrated by this call.
 * `knownIds` lets the client skip re-hydration; it is validated and bounded,
 * and never trusted for membership (the server always lists members itself).
 */
export function createSequenceRouter(deps?: SequenceRouteDeps): express.Router {
  const router = express.Router();

  router.post("/api/mapillary/sequences/:sequenceId/images", async (req, res) => {
    const requestedAt = new Date().toISOString();
    const { sequenceId } = req.params;
    if (!isProviderId(sequenceId)) {
      res
        .status(400)
        .json(
          errorBody(
            "SEQUENCE_INVALID_ID",
            "Sequence ID must be 1–128 letters, digits, underscore, or hyphen.",
            false,
          ),
        );
      return;
    }

    const body = (req.body as { roi?: unknown; knownIds?: unknown } | undefined) ?? {};
    const validation = validateRoiPolygon(body.roi);
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

    let knownIds: string[] = [];
    if (body.knownIds !== undefined) {
      if (!Array.isArray(body.knownIds)) {
        res
          .status(400)
          .json(errorBody("KNOWN_IDS_INVALID", "knownIds must be an array of image IDs.", false));
        return;
      }
      if (body.knownIds.length > SEQUENCE_MAX_KNOWN_IDS) {
        res
          .status(400)
          .json(
            errorBody(
              "KNOWN_IDS_TOO_MANY",
              `knownIds is limited to ${SEQUENCE_MAX_KNOWN_IDS} entries.`,
              false,
            ),
          );
        return;
      }
      knownIds = body.knownIds.filter(isProviderId);
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
      const detail = await loadSequenceDetail({
        sequenceId,
        ring: validation.ring,
        knownIds,
        token,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: deps?.mapillaryTimeoutMs,
        totalTimeoutMs: deps?.sequenceTotalTimeoutMs,
        signal: upstream.signal,
      });
      res.json({ ...detail, requestedAt });
    } catch (error) {
      if (sendMapillaryError(res, error)) return;
      res
        .status(500)
        .json(errorBody("SEQUENCE_FAILED", "Sequence detail failed unexpectedly.", false));
    } finally {
      release();
    }
  });

  return router;
}
