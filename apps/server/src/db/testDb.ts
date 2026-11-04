import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "./connection.js";

/**
 * Isolated database for storage tests. The name is checked before every
 * cleanup; anything else refuses to run so tests can never drop the user's
 * working database.
 */
export const TEST_DATABASE_NAME = "openstreetlightmapper_test";

export function testDatabaseUri(): string {
  return (
    process.env.MONGODB_TEST_URI?.trim() || `mongodb://127.0.0.1:27018/${TEST_DATABASE_NAME}`
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
  if (name !== TEST_DATABASE_NAME) {
    await disconnectDatabase();
    throw new Error(
      `Refusing storage tests against database ${JSON.stringify(name)}; expected ${JSON.stringify(TEST_DATABASE_NAME)}.`,
    );
  }
}

/** Drop every test collection (documents + GridFS buckets). Guarded by name. */
export async function cleanTestDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  const name = db?.databaseName;
  if (name !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing cleanup of database ${JSON.stringify(name)}; expected ${JSON.stringify(TEST_DATABASE_NAME)}.`,
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
