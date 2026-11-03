import express from "express";
import cors from "cors";
import { createSearchRouter, isMapillarySearchConfigured } from "./routes/mapillarySearch.js";

export const SERVICE_NAME = "openstreetlightmapper-server";

export interface AppOptions {
  /** Override the fetch implementation (tests inject a mock; default: global fetch). */
  mapillaryFetch?: typeof fetch;
  /** Override the upstream Mapillary deadline (tests use short values). */
  mapillaryTimeoutMs?: number;
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
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    // Intentionally no database field: no connection has been established.
    // `configured` means a search token is present, not verified/authenticated.
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      providers: { mapillarySearch: { configured: isMapillarySearchConfigured() } },
    });
  });

  app.use(
    createSearchRouter({
      fetchImpl: options?.mapillaryFetch,
      mapillaryTimeoutMs: options?.mapillaryTimeoutMs,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
