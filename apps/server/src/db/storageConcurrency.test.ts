import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import {
  cleanTestDatabase,
  closeTestDatabase,
  connectTestDatabase,
  useIsolatedTestDatabase,
} from "../db/testDb.js";
import { getJson, postJson, putJson } from "../routes/httpTestUtils.js";

// Own database: this file's cleanups must not wipe parallel test files.
useIsolatedTestDatabase("concurrency");

function sessionBody(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    key,
    sessionId: `s-${key}`,
    mode: "manual",
    context: { streetId: key, streetDisplayName: "Main St", streetSource: "osm" },
    activeStep: "detect",
    detection: { status: "idle" },
    observations: {},
    assets: {},
    obsOrder: [],
    assetOrder: [],
    obsCounter: 0,
    assetCounter: 0,
    sources: {},
    views: {},
    viewOrder: [],
    manifest: null,
    concepts: [{ id: "concept-pole", text: "street light pole" }],
    conceptCounter: 1,
    runs: [],
    runCounter: 0,
    stagedTest: null,
    finishedPreview: null,
    ...overrides,
  };
}

function registration(itemId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: "run-1",
    itemId,
    kind: "batch",
    viewId: "view-1",
    conceptId: "concept-pole",
    prompt: "street light pole",
    categoryIntent: "pole",
    model: null,
    viewDescriptor: { width: 10, height: 10 },
    artifactId: "d".repeat(24),
    supersedes: null,
    ...overrides,
  };
}

function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: "succeeded",
    objects: [
      {
        providerObjectId: "p1",
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        confidence: 0.9,
        mask: null,
      },
    ],
    model: "sam-3.1",
    truncated: false,
    invalidDiscarded: 0,
    error: null,
    providerRequestId: "req-1",
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

type ErrorBody = { error: { code: string; currentRevision?: number; owner?: string | null } };

describe("storage concurrency", () => {
  before(connectTestDatabase);
  beforeEach(cleanTestDatabase);
  after(closeTestDatabase);

  it("registers the same item once under concurrent identical writes", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Race" }, "cc-ws");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    const [first, second] = await Promise.all([
      postJson(app, base, registration("item-1"), "cc-reg-a"),
      postJson(app, base, registration("item-1"), "cc-reg-b"),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    const dedup = [first, second].find((entry) => entry.status === 200);
    assert.equal((dedup?.body as { deduplicated: boolean }).deduplicated, true);
  });

  it("conflicts concurrent registers with different input instead of 500ing", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Race" }, "cc-ws2");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    const [first, second] = await Promise.all([
      postJson(app, base, registration("item-1"), "cc-regc-a"),
      postJson(app, base, registration("item-1", { prompt: "street light fixture" }), "cc-regc-b"),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const loser = [first, second].find((entry) => entry.status === 409);
    assert.equal((loser?.body as ErrorBody).error.code, "ITEM_CONFLICT");
  });

  it("completes once under concurrent identical writes; terminal results stay immutable", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Race" }, "cc-ws3");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    await postJson(app, base, registration("item-1"), "cc-reg3");
    const body = completion();
    const attempts = await Promise.all(
      ["a", "b", "c", "d", "e"].map((tag) =>
        postJson(app, `${base}/run-1/item-1/complete`, body, `cc-dedup-${tag}`),
      ),
    );
    assert.ok(attempts.every((entry) => entry.status === 200));
    const fresh = attempts.filter(
      (entry) => (entry.body as { deduplicated: boolean }).deduplicated === false,
    );
    assert.equal(fresh.length, 1);

    const full = await getJson(app, `${base}/run-1/item-1`, "cc-full");
    assert.equal(full.status, 200);
    const fullBody = full.body as { status: string; objects: { providerObjectId: string }[] };
    assert.equal(fullBody.status, "succeeded");
    assert.deepEqual(
      fullBody.objects.map((entry) => entry.providerObjectId),
      ["p1"],
    );

    const rewrite = await postJson(
      app,
      `${base}/run-1/item-1/complete`,
      completion({ invalidDiscarded: 1 }),
      "cc-rewrite",
    );
    assert.equal(rewrite.status, 409);
    assert.equal((rewrite.body as ErrorBody).error.code, "ITEM_ALREADY_COMPLETE");
  });

  it("picks one winner for conflicting concurrent completions", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Race" }, "cc-ws4");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    await postJson(app, base, registration("item-1"), "cc-reg4");
    const [first, second] = await Promise.all([
      postJson(
        app,
        `${base}/run-1/item-1/complete`,
        completion({ objects: [{ providerObjectId: "pa", box: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: null, mask: null }] }),
        "cc-race-a",
      ),
      postJson(
        app,
        `${base}/run-1/item-1/complete`,
        completion({ objects: [{ providerObjectId: "pb", box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, confidence: null, mask: null }] }),
        "cc-race-b",
      ),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = [first, second].find((entry) => entry.status === 409);
    assert.equal((loser?.body as ErrorBody).error.code, "ITEM_ALREADY_COMPLETE");
    const winner = [first, second].find((entry) => entry.status === 200);
    assert.equal((winner?.body as { deduplicated: boolean }).deduplicated, false);

    const full = await getJson(app, `${base}/run-1/item-1`, "cc-race-full");
    const winnerId = (full.body as { objects: { providerObjectId: string }[] }).objects[0]
      .providerObjectId;
    assert.ok(winnerId === "pa" || winnerId === "pb");
  });

  it("keeps one terminal outcome for concurrent complete and interrupt", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Race" }, "cc-ws5");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    await postJson(app, base, registration("item-1"), "cc-reg5");
    const [completed, interrupted] = await Promise.all([
      postJson(app, `${base}/run-1/item-1/complete`, completion(), "cc-ci-complete"),
      postJson(app, `${base}/run-1/item-1/interrupt`, {}, "cc-ci-interrupt"),
    ]);
    const full = await getJson(app, `${base}/run-1/item-1`, "cc-ci-full");
    const final = (full.body as { status: string }).status;
    if (final === "succeeded") {
      // Complete won: interrupt is an idempotent no-op on terminal items.
      assert.equal(completed.status, 200);
      assert.equal(interrupted.status, 200);
      assert.equal((interrupted.body as { status: string }).status, "succeeded");
    } else {
      // Interrupt won: the late completion conflicts with the terminal state.
      assert.equal(final, "interrupted");
      assert.equal(interrupted.status, 200);
      assert.equal(completed.status, 409);
      assert.equal((completed.body as ErrorBody).error.code, "ITEM_ALREADY_COMPLETE");
    }
  });

  it("grants an item claim to exactly one concurrent worker", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Claims" }, "cc-ws6");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    await postJson(app, base, registration("item-1"), "cc-reg6");
    const [first, second] = await Promise.all([
      postJson(app, `${base}/run-1/item-1/claim`, { owner: "worker-a" }, "cc-claim-a"),
      postJson(app, `${base}/run-1/item-1/claim`, { owner: "worker-b" }, "cc-claim-b"),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = [first, second].find((entry) => entry.status === 200);
    const winnerBody = winner?.body as { status: string; owner: string; attempts: number };
    assert.equal(winnerBody.status, "running");
    assert.equal(winnerBody.attempts, 1);
    const loser = [first, second].find((entry) => entry.status === 409);
    const loserBody = loser?.body as ErrorBody;
    assert.equal(loserBody.error.code, "ITEM_CLAIMED");
    assert.equal(loserBody.error.owner, winnerBody.owner);
  });

  it("enforces claim ownership on complete and interrupt, with lease takeover", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Claims" }, "cc-ws7");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    await postJson(app, base, registration("item-1"), "cc-reg7");

    const claimed = await postJson(
      app,
      `${base}/run-1/item-1/claim`,
      { owner: "worker-a", leaseMs: 1000 },
      "cc-own-claim",
    );
    assert.equal(claimed.status, 200);

    // Another owner, and the unclaimed browser flow, cannot steal a live claim.
    const stolen = await postJson(
      app,
      `${base}/run-1/item-1/complete`,
      completion({ owner: "worker-b" }),
      "cc-own-steal",
    );
    assert.equal(stolen.status, 409);
    assert.equal((stolen.body as ErrorBody).error.code, "ITEM_CLAIMED");
    const browserSteal = await postJson(
      app,
      `${base}/run-1/item-1/complete`,
      completion(),
      "cc-own-browser",
    );
    assert.equal(browserSteal.status, 409);
    assert.equal((browserSteal.body as ErrorBody).error.code, "ITEM_CLAIMED");
    const strangerInterrupt = await postJson(
      app,
      `${base}/run-1/item-1/interrupt`,
      { owner: "worker-b" },
      "cc-own-interrupt",
    );
    assert.equal(strangerInterrupt.status, 409);
    assert.equal((strangerInterrupt.body as ErrorBody).error.code, "ITEM_CLAIMED");

    // After the lease expires another worker takes over as a new attempt.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const takeover = await postJson(
      app,
      `${base}/run-1/item-1/claim`,
      { owner: "worker-b" },
      "cc-own-takeover",
    );
    assert.equal(takeover.status, 200);
    assert.equal((takeover.body as { attempts: number }).attempts, 2);

    // The new owner completes; the win clears the claim.
    const done = await postJson(
      app,
      `${base}/run-1/item-1/complete`,
      completion({ owner: "worker-b" }),
      "cc-own-done",
    );
    assert.equal(done.status, 200);
    assert.equal((done.body as { deduplicated: boolean }).deduplicated, false);

    // Terminal items reject further claims.
    const late = await postJson(
      app,
      `${base}/run-1/item-1/claim`,
      { owner: "worker-c" },
      "cc-own-late",
    );
    assert.equal(late.status, 409);
    assert.equal((late.body as ErrorBody).error.code, "ITEM_ALREADY_COMPLETE");
  });

  it("pins reviewed results to the acknowledged session revision", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Pin" }, "cc-ws8");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const sessionPath = `/api/workspaces/${workspaceId}/sessions/street-1`;
    await putJson(
      app,
      sessionPath,
      { expectedRevision: null, session: sessionBody("street-1") },
      "cc-pin-session",
    );
    const result = {
      schemaVersion: 1,
      resultId: "rs-1",
      sessionRevision: 1,
      inputRevision: 1,
      counts: { poles: 1, luminaires: 0 },
      limitations: ["Manual review only."],
      provenance: { model: "sam-3.1" },
      snapshot: { assets: [] },
      artifactIds: [],
    };
    const posted = await postJson(app, `${sessionPath}/results`, result, "cc-pin-post");
    assert.equal(posted.status, 201);

    // An edit lands after the result was built: the stored revision moves on.
    const bumped = await putJson(
      app,
      sessionPath,
      { expectedRevision: 1, session: sessionBody("street-1", { obsCounter: 1 }) },
      "cc-pin-bump",
    );
    assert.equal((bumped.body as { revision: number }).revision, 2);

    // Idempotent retries of the created result still succeed.
    const reposted = await postJson(app, `${sessionPath}/results`, result, "cc-pin-repost");
    assert.equal(reposted.status, 200);
    assert.equal((reposted.body as { deduplicated: boolean }).deduplicated, true);

    // New results cannot attach to the older revision.
    const stale = await postJson(
      app,
      `${sessionPath}/results`,
      { ...result, resultId: "rs-2" },
      "cc-pin-stale",
    );
    assert.equal(stale.status, 409);
    const staleBody = stale.body as ErrorBody;
    assert.equal(staleBody.error.code, "REVISION_CONFLICT");
    assert.equal(staleBody.error.currentRevision, 2);

    // A result built from the current revision is accepted.
    const fresh = await postJson(
      app,
      `${sessionPath}/results`,
      { ...result, resultId: "rs-3", sessionRevision: 2 },
      "cc-pin-fresh",
    );
    assert.equal(fresh.status, 201);
  });
});
