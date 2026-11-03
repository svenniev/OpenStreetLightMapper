import express from "express";
import cors from "cors";
import { createSearchRouter, isMapillarySearchConfigured } from "./routes/mapillarySearch.js";
import { createDetectionRouter, isSamDetectionConfigured } from "./routes/detection.js";
import { createImageryRouter } from "./routes/imagery.js";
import { createSequenceRouter } from "./routes/sequenceDetail.js";
import { samModelName } from "./sam.js";
import { createStreetsRouter } from "./routes/streetsSearch.js";

export const SERVICE_NAME = "openstreetlightmapper-server";

export interface AppOptions {
  /** Override the fetch implementation (tests inject a mock; default: global fetch). */
  mapillaryFetch?: typeof fetch;
  /** Override the upstream Mapillary deadline (tests use short values). */
  mapillaryTimeoutMs?: number;
  /** Override the sequence-detail total deadline (tests use short values). */
  sequenceTotalTimeoutMs?: number;
  /** Override the Overpass fetch implementation. */
  overpassFetch?: typeof fetch;
  /** Override the Overpass deadline (tests use short values). */
  overpassTimeoutMs?: number;
  /** Override the Overpass endpoint (tests use a placeholder). */
  overpassUrl?: string;
  /** Override the Meta Model API fetch implementation. */
  samFetch?: typeof fetch;
  /** Override the SAM deadline (tests use short values). */
  samTimeoutMs?: number;
}

/**
 * Express application.
 *
 * MongoDB integration boundary (pending): persistence is deferred to a later
 * milestone. `MONGODB_URI` is reserved in `.env.example` but no connection is
 * established here and no schemas/collections are created. Future Meta model
 * calls and private credentials must live on this server, never in the
 * browser bundle.
 */
export function createApp(options?: AppOptions): express.Express {
  const app = express();

  app.use(cors());
  // 12 MB accommodates base64 inference rasters on the detection route (the
  // route re-validates size and magic bytes); all other payloads are still
  // validated and capped after parsing.
  app.use(express.json({ limit: "12mb" }));

  app.get("/api/health", (_req, res) => {
    // Intentionally no database field: no connection has been established.
    // `configured` means a key is present, not verified/authenticated; the
    // health check never makes chargeable model calls.
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      providers: {
        mapillarySearch: { configured: isMapillarySearchConfigured() },
        samDetection: { configured: isSamDetectionConfigured(), model: samModelName() },
      },
    });
  });

  app.use(
    createSearchRouter({
      fetchImpl: options?.mapillaryFetch,
      mapillaryTimeoutMs: options?.mapillaryTimeoutMs,
    }),
  );

  app.use(
    createSequenceRouter({
      fetchImpl: options?.mapillaryFetch,
      mapillaryTimeoutMs: options?.mapillaryTimeoutMs,
      sequenceTotalTimeoutMs: options?.sequenceTotalTimeoutMs,
    }),
  );

  app.use(
    createDetectionRouter({
      fetchImpl: options?.samFetch,
      samTimeoutMs: options?.samTimeoutMs,
    }),
  );

  app.use(
    createImageryRouter({
      fetchImpl: options?.mapillaryFetch,
      mapillaryTimeoutMs: options?.mapillaryTimeoutMs,
    }),
  );

  app.use(
    createStreetsRouter({
      fetchImpl: options?.overpassFetch,
      overpassTimeoutMs: options?.overpassTimeoutMs,
      overpassUrl: options?.overpassUrl,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
