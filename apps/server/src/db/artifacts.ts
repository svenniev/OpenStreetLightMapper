import { createHash } from "node:crypto";
import { GridFSBucket, ObjectId, type Db } from "mongodb";
import type mongoose from "mongoose";
import type { ValidatedArtifactMeta } from "./validation.js";

/** GridFS bucket for evidence rasters (collections evidence.files/chunks). */
export const EVIDENCE_BUCKET = "evidence";

export interface StoredArtifact {
  artifactId: string;
  deduplicated: boolean;
  byteLength: number;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isArtifactId(value: string): boolean {
  return /^[0-9a-f]{24}$/.test(value);
}

function bucketFor(connection: mongoose.Connection): { bucket: GridFSBucket; db: Db } {
  const db = connection.db;
  if (!db) throw new Error("Local database connection has no database handle.");
  return { bucket: new GridFSBucket(db, { bucketName: EVIDENCE_BUCKET }), db };
}

let contentIndexEnsured = false;

/** Unique dedup index on the raster content hash (idempotent). */
async function ensureContentIndex(db: Db): Promise<void> {
  if (contentIndexEnsured) return;
  await db
    .collection(`${EVIDENCE_BUCKET}.files`)
    .createIndex({ "metadata.contentHash": 1 }, { unique: true });
  contentIndexEnsured = true;
}

function artifactMeta(meta: ValidatedArtifactMeta, byteLength: number): Record<string, unknown> {
  return {
    contentHash: meta.contentHash,
    mime: meta.mime,
    width: meta.width,
    height: meta.height,
    byteLength,
    imageId: meta.imageId,
    viewId: meta.viewId,
    orientation: meta.orientation,
    crop: meta.crop,
    attribution: meta.attribution,
    sourceUrl: meta.sourceUrl,
  };
}

/**
 * Store one immutable evidence raster, deduplicated by content hash. The
 * artifact ID is the GridFS file ID; identical bytes resolve to the same
 * record through the unique content-hash index. Verifies the stored length
 * before reporting success so interrupted uploads never look complete.
 */
export async function storeArtifact(
  connection: mongoose.Connection,
  bytes: Buffer,
  meta: ValidatedArtifactMeta,
): Promise<StoredArtifact> {
  if (bytes.length !== meta.byteLength) {
    throw new Error(
      `Artifact byte length ${bytes.length} does not match declared ${meta.byteLength}.`,
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== meta.contentHash) {
    throw new Error("Artifact bytes do not match the declared content hash.");
  }
  const { bucket, db } = bucketFor(connection);
  await ensureContentIndex(db);
  const files = db.collection(`${EVIDENCE_BUCKET}.files`);
  const existing = await files.findOne(
    { "metadata.contentHash": meta.contentHash },
    { projection: { length: 1 } },
  );
  if (existing) {
    if (existing.length !== bytes.length) {
      throw new Error("A conflicting artifact record already exists for this content hash.");
    }
    return { artifactId: String(existing._id), deduplicated: true, byteLength: bytes.length };
  }
  const uploadId = await new Promise<ObjectId>((resolve, reject) => {
    const stream = bucket.openUploadStream(`${meta.imageId}.bin`, {
      contentType: meta.mime,
      metadata: artifactMeta(meta, bytes.length),
    });
    stream.on("error", (error: unknown) => {
      reject(error instanceof Error ? error : new Error("Artifact upload failed."));
    });
    stream.on("finish", () => resolve(stream.id as ObjectId));
    stream.end(bytes);
  }).catch(async (error: unknown) => {
    // A duplicate-key error means a concurrent upload won the race; fall
    // through to the verification read below.
    if ((error as { code?: unknown })?.code === 11000) {
      const winner = await files.findOne(
        { "metadata.contentHash": meta.contentHash },
        { projection: { _id: 1, length: 1 } },
      );
      if (winner) return winner._id as ObjectId;
    }
    throw error;
  });
  const stored = await files.findOne({ _id: uploadId }, { projection: { length: 1 } });
  if (!stored || stored.length !== bytes.length) {
    throw new Error("Artifact upload did not complete; retry the upload.");
  }
  return {
    artifactId: String(uploadId),
    deduplicated: false,
    byteLength: bytes.length,
  };
}

export interface ArtifactFileInfo {
  artifactId: string;
  length: number;
  contentType: string | null;
  metadata: Record<string, unknown>;
}

export async function findArtifact(
  connection: mongoose.Connection,
  artifactId: string,
): Promise<ArtifactFileInfo | null> {
  const { db } = bucketFor(connection);
  const file = await db
    .collection(`${EVIDENCE_BUCKET}.files`)
    .findOne({ _id: new ObjectId(artifactId) });
  if (!file) return null;
  return {
    artifactId,
    length: file.length as number,
    contentType: (file.contentType as string | undefined) ?? null,
    metadata: (file.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

/** IDs from the list that exist (used to validate evidence links). */
export async function artifactsExist(
  connection: mongoose.Connection,
  artifactIds: string[],
): Promise<Set<string>> {
  const { db } = bucketFor(connection);
  if (artifactIds.length === 0) return new Set();
  const objectIds = artifactIds.filter(isArtifactId).map((id) => new ObjectId(id));
  const cursor = db
    .collection(`${EVIDENCE_BUCKET}.files`)
    .find({ _id: { $in: objectIds } }, { projection: { _id: 1 } });
  const found = new Set<string>();
  for await (const file of cursor) found.add(String(file._id));
  return found;
}

export function openArtifactDownload(
  connection: mongoose.Connection,
  artifactId: string,
): { stream: NodeJS.ReadableStream; info: Promise<ArtifactFileInfo | null> } {
  const { bucket } = bucketFor(connection);
  return {
    stream: bucket.openDownloadStream(new ObjectId(artifactId)),
    info: findArtifact(connection, artifactId),
  };
}
