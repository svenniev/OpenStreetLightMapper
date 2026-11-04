import mongoose from "mongoose";

/** Sanitized database readiness for health responses. Never carries a URI. */
export type DbState = "connected" | "connecting" | "unavailable";

/** Bounded server-selection/connection timeout (ms). */
export const DB_CONNECT_TIMEOUT_MS = 5000;

let connectPromise: Promise<typeof mongoose> | null = null;

/** Map the driver ready-state to the sanitized public state. */
export function getDbState(): DbState {
  switch (mongoose.connection.readyState) {
    case 1:
      return "connected";
    case 2:
      return "connecting";
    default:
      return "unavailable";
  }
}

function isMissingUri(value: string | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

/**
 * Connect once per process. Concurrent callers share one attempt. Resolves
 * when connected; rejects with a sanitized error (no URI, no credentials).
 * Buffering is disabled so writes fail fast while disconnected instead of
 * appearing to hang or succeed.
 */
export function connectDatabase(uri?: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose);
  if (connectPromise) return connectPromise;
  const target = (uri ?? process.env.MONGODB_URI ?? "").trim();
  if (isMissingUri(target)) {
    return Promise.reject(new Error("MONGODB_URI is not configured."));
  }
  mongoose.set("bufferCommands", false);
  connectPromise = mongoose
    .connect(target, {
      serverSelectionTimeoutMS: DB_CONNECT_TIMEOUT_MS,
      connectTimeoutMS: DB_CONNECT_TIMEOUT_MS,
    })
    .catch((error: unknown) => {
      connectPromise = null;
      throw new Error(
        `Local database connection failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    });
  return connectPromise;
}

/** Test/backdoor reset of the once-per-process guard (no-op when connected). */
export function resetConnectGuardForTests(): void {
  if (mongoose.connection.readyState !== 1) connectPromise = null;
}

/** Clean shutdown: closes the shared connection when open. */
export async function disconnectDatabase(): Promise<void> {
  connectPromise = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/** Active connection, or null when no usable connection exists. */
export function activeConnection(): mongoose.Connection | null {
  return mongoose.connection.readyState === 1 ? mongoose.connection : null;
}
