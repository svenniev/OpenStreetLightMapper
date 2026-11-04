import "dotenv/config";
import { createApp } from "./app.js";
import { connectDatabase, disconnectDatabase, getDbState } from "./db/connection.js";
import { startAutoWorker, type WorkerHandle } from "./auto/worker.js";

const port = Number(process.env.PORT ?? 3001);

let workerHandle: WorkerHandle | null = null;
const app = createApp({
  kickAutoWorker: () => {
    // Fire-and-forget: the poll loop picks the job up anyway; a failed kick
    // only costs one poll interval.
    void workerHandle?.runOnce().catch(() => {});
  },
});

const server = app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});

// The database is required for saving but not for serving: boot continues
// without it (health reports database.unavailable) so already loaded work
// stays viewable and saves retry honestly.
void connectDatabase().then(
  () => console.log("[server] local database connected"),
  (error: unknown) =>
    console.log(
      `[server] local database unavailable (${error instanceof Error ? error.message : "connect failed"}); ` +
        `saves will report DB_UNAVAILABLE until it connects.`,
    ),
);

// The worker starts regardless of database state: its polls skip while the
// database is down, and the startup sweep interrupts jobs the dead process
// left active as soon as a connection exists.
workerHandle = startAutoWorker({
  events: (event) => {
    if (event.type === "startup-sweep") {
      console.log(`[server] auto worker started (startup sweep: ${event.jobs} jobs interrupted)`);
    } else if (event.type === "job-claimed") {
      console.log(`[server] auto worker claimed ${event.jobId}`);
    } else if (event.type === "job-done") {
      console.log(`[server] auto job ${event.jobId} ${event.status}`);
    } else if (event.type === "job-failed") {
      console.log(`[server] auto job ${event.jobId} failed: ${event.error}`);
    } else if (event.type === "worker-error") {
      console.log(`[server] auto worker: ${event.message}`);
    }
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal}: closing`);
  server.close();
  if (workerHandle) {
    try {
      await workerHandle.stop();
      console.log("[server] auto worker stopped");
    } catch (error) {
      console.log(
        `[server] auto worker stop failed (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
    workerHandle = null;
  }
  if (getDbState() !== "unavailable") {
    try {
      await disconnectDatabase();
      console.log("[server] local database disconnected");
    } catch (error) {
      console.log(
        `[server] database disconnect failed (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
