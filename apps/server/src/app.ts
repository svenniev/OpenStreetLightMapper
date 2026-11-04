import express from "express";
import cors from "cors";
import { getDbState } from "./db/connection.js";
import { createSearchRouter, isMapillarySearchConfigured } from "./routes/mapillarySearch.js";
import { createDetectionRouter, isSamDetectionConfigured } from "./routes/detection.js";
import { createImageryRouter } from "./routes/imagery.js";
import { createSequenceRouter } from "./routes/sequenceDetail.js";
import { samModelName } from "./sam.js";
import { createStreetsRouter } from "./routes/streetsSearch.js";
import { createArtifactsRouter } from "./routes/artifacts.js";
import { createAutoRouter } from "./routes/auto.js";
import { createItemsRouter } from "./routes/items.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createWorkspacesRouter } from "./routes/workspaces.js";

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
  /** Prompt the in-process auto worker to poll now (launch/resume/retry). */
  kickAutoWorker?: () => void;
}

/**
 * Express application.
 *
 * Workspace persistence lives in MongoDB (see db/ and the storage routes);
 * the process connects in index.ts. Meta model calls and private credentials
 * stay on this server, never in the browser bundle.
 */
export function createApp(options?: AppOptions): express.Express {
  const app = express();

  app.use(cors());
  // 12 MB accommodates base64 inference rasters on the detection route (the
  // route re-validates size and magic bytes); all other payloads are still
  // validated and capped after parsing.
  app.use(express.json({ limit: "12mb" }));

  app.get("/api/health", (_req, res) => {
    // `configured` means a key is present, not verified/authenticated; the
    // health check never makes chargeable model calls. `database.state`
    // reports the live connection (connected/connecting/unavailable): a
    // present MONGODB_URI alone is not a successful connection.
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      database: { state: getDbState() },
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

  app.use(createWorkspacesRouter());
  app.use(createSessionsRouter());
  app.use(createItemsRouter());
  app.use(createArtifactsRouter());
  app.use(
    createAutoRouter({
      fetchImpl: options?.mapillaryFetch,
      mapillaryTimeoutMs: options?.mapillaryTimeoutMs,
      kickWorker: options?.kickAutoWorker,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
