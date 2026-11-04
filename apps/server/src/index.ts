import "dotenv/config";
import { createApp } from "./app.js";
import { connectDatabase, disconnectDatabase, getDbState } from "./db/connection.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp();

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

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal}: closing`);
  server.close();
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
