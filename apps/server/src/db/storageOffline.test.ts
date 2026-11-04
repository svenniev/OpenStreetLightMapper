import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { getJson, postJson } from "../routes/httpTestUtils.js";

/**
 * Storage behavior without a database connection. This file never connects,
 * so it runs in its own process against the shared disconnected state: every
 * storage route must fail honestly with DB_UNAVAILABLE, never fake success.
 */
describe("storage without a database", () => {
  it("reports unavailable health and refuses storage work", async () => {
    const app = createApp();
    const health = await getJson(app, "/api/health", "offline-health");
    assert.equal(health.status, 200);
    assert.equal((health.body as { database: { state: string } }).database.state, "unavailable");

    const created = await postJson(app, "/api/workspaces", { name: "Nope" }, "offline-create");
    assert.equal(created.status, 503);
    assert.equal((created.body as { error: { code: string; retryable: boolean } }).error.code, "DB_UNAVAILABLE");
    assert.equal((created.body as { error: { retryable: boolean } }).error.retryable, true);

    const listed = await getJson(app, "/api/workspaces", "offline-list");
    assert.equal(listed.status, 503);
  });
});
