import express from "express";
import { findArtifact, isArtifactId, openArtifactDownload, storeArtifact } from "../db/artifacts.js";
import {
  ARTIFACT_BYTES_MAX,
  STORAGE_SCHEMA_VERSION,
  StorageValidationError,
  validateArtifactMeta,
} from "../db/validation.js";
import { requireDb, sendCaughtStorageError, sendStorageError } from "./storageShared.js";

/**
 * Evidence-artifact routes: immutable raster bytes in GridFS, keyed by
 * content hash. Narrowly scoped evidence persistence, not a bulk downloader.
 *
 * POST /api/artifacts — {schemaVersion, meta, dataBase64} (idempotent by hash)
 * GET /api/artifacts/:artifactId — raw bytes with bounds/validation
 * GET /api/artifacts/:artifactId/meta — metadata without bytes
 */
export function createArtifactsRouter(): express.Router {
  const router = express.Router();

  router.post("/api/artifacts", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.schemaVersion !== STORAGE_SCHEMA_VERSION) {
        throw new StorageValidationError(
          "STORAGE_SCHEMA_VERSION",
          `Unsupported schemaVersion ${JSON.stringify(body.schemaVersion)}; this server stores version ${STORAGE_SCHEMA_VERSION}.`,
        );
      }
      const meta = validateArtifactMeta(body.meta);
      if (typeof body.dataBase64 !== "string" || body.dataBase64.length === 0) {
        throw new StorageValidationError("STORAGE_BAD_REQUEST", "Artifact dataBase64 must be a non-empty string.");
      }
      // Base64 inflates ~4/3; reject absurd payloads before decoding.
      if (body.dataBase64.length > Math.ceil((ARTIFACT_BYTES_MAX * 4) / 3) + 16) {
        throw new StorageValidationError(
          "STORAGE_PAYLOAD_TOO_LARGE",
          `Artifact payload exceeds the ${(ARTIFACT_BYTES_MAX / 1024 / 1024).toFixed(0)} MiB raster cap.`,
        );
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(body.dataBase64, "base64");
      } catch {
        throw new StorageValidationError("STORAGE_BAD_REQUEST", "Artifact dataBase64 is not valid base64.");
      }
      if (bytes.length === 0 || bytes.length > ARTIFACT_BYTES_MAX) {
        throw new StorageValidationError(
          "STORAGE_PAYLOAD_TOO_LARGE",
          `Artifact decodes to ${bytes.length} bytes; the cap is ${ARTIFACT_BYTES_MAX} bytes.`,
        );
      }
      // PNG/JPEG magic bytes, so stored evidence is actually an image.
      const isPng =
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a;
      const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const matchesMime =
        (meta.mime === "image/png" && isPng) || (meta.mime === "image/jpeg" && isJpeg);
      if (!matchesMime) {
        throw new StorageValidationError(
          "STORAGE_BAD_REQUEST",
          `Artifact bytes are not a ${meta.mime} image.`,
        );
      }
      try {
        const stored = await storeArtifact(connection, bytes, meta);
        res.status(stored.deduplicated ? 200 : 201).json(stored);
      } catch (error) {
        if (error instanceof Error && /content hash|byte length|complete|conflicting/.test(error.message)) {
          throw new StorageValidationError("STORAGE_BAD_REQUEST", error.message);
        }
        throw error;
      }
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/artifacts/:artifactId/meta", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const artifactId = req.params.artifactId ?? "";
      if (!isArtifactId(artifactId)) {
        sendStorageError(res, "ARTIFACT_NOT_FOUND", "Unknown artifact.");
        return;
      }
      const info = await findArtifact(connection, artifactId);
      if (!info) {
        sendStorageError(res, "ARTIFACT_NOT_FOUND", "Unknown artifact.");
        return;
      }
      res.json({
        artifactId: info.artifactId,
        byteLength: info.length,
        mime: info.contentType,
        meta: info.metadata,
      });
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  router.get("/api/artifacts/:artifactId", async (req, res) => {
    const connection = requireDb(res);
    if (!connection) return;
    try {
      const artifactId = req.params.artifactId ?? "";
      if (!isArtifactId(artifactId)) {
        sendStorageError(res, "ARTIFACT_NOT_FOUND", "Unknown artifact.");
        return;
      }
      const { stream, info } = openArtifactDownload(connection, artifactId);
      const file = await info;
      if (!file) {
        sendStorageError(res, "ARTIFACT_NOT_FOUND", "Unknown artifact.");
        return;
      }
      // Stored bytes are our own validated PNG/JPEG rasters; serve them as
      // immutable images, never as executable markup.
      res.setHeader("Content-Type", file.contentType ?? "application/octet-stream");
      res.setHeader("Content-Length", String(file.length));
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      stream.on("error", () => {
        if (!res.headersSent) {
          sendStorageError(res, "ARTIFACT_NOT_FOUND", "Unknown artifact.");
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch (error) {
      sendCaughtStorageError(res, error);
    }
  });

  return router;
}
