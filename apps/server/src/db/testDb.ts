import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "./connection.js";

/**
 * Isolated database for storage tests. The name is checked before every
 * cleanup; anything else refuses to run so tests can never drop the user's
 * working database.
 */
export const TEST_DATABASE_NAME = "openstreetlightmapper_test";

/**
 * Heavy test files run in parallel and clean the whole database between
 * tests, so each gets its own `openstreetlightmapper_test_<suffix>` name.
 * Anything outside this family still refuses to run.
 */
export function isTestDatabaseName(name: string | undefined): boolean {
  return (
    name === TEST_DATABASE_NAME || /^openstreetlightmapper_test_[a-z0-9_]+$/.test(name ?? "")
  );
}

/** Database URI for the current test file (module may override per file). */
export function testDatabaseUri(): string {
  return (
    process.env.MONGODB_TEST_URI?.trim() || `mongodb://127.0.0.1:27018/${TEST_DATABASE_NAME}`
  );
}

/** Point this test file at its own isolated database (call at module top). */
export function useIsolatedTestDatabase(suffix: string): void {
  if (!/^[a-z0-9_]+$/.test(suffix)) {
    throw new Error(`Invalid test database suffix ${JSON.stringify(suffix)}.`);
  }
  const fallback = `mongodb://127.0.0.1:27018/${TEST_DATABASE_NAME}`;
  const base = process.env.MONGODB_TEST_URI?.trim() || fallback;
  process.env.MONGODB_TEST_URI = base.replace(
    /\/[^/?]*(\?.*)?$/,
    `/${TEST_DATABASE_NAME}_${suffix}$1`,
  );
}

/** Fail-closed connect: storage tests need the container, not a skip. */
export async function connectTestDatabase(): Promise<void> {
  const uri = testDatabaseUri();
  try {
    await connectDatabase(uri);
  } catch (error) {
    throw new Error(
      `Storage tests need the local database container (${error instanceof Error ? error.message : "connect failed"}). ` +
        `Start it with: powershell -ExecutionPolicy Bypass -File infra\\database\\start.ps1`,
    );
  }
  const name = mongoose.connection.db?.databaseName;
  if (!isTestDatabaseName(name)) {
    await disconnectDatabase();
    throw new Error(
      `Refusing storage tests against database ${JSON.stringify(name)}; expected the ${JSON.stringify(TEST_DATABASE_NAME)} family.`,
    );
  }
}

/** Drop every test collection (documents + GridFS buckets). Guarded by name. */
export async function cleanTestDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  const name = db?.databaseName;
  if (!isTestDatabaseName(name)) {
    throw new Error(
      `Refusing cleanup of database ${JSON.stringify(name)}; expected the ${JSON.stringify(TEST_DATABASE_NAME)} family.`,
    );
  }
  if (!db) throw new Error("No test database connection.");
  const collections = await db.listCollections().toArray();
  for (const collection of collections) {
    await db.collection(collection.name).deleteMany({});
  }
}

export async function closeTestDatabase(): Promise<void> {
  await disconnectDatabase();
}
