import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../app.js";
import { cleanTestDatabase, closeTestDatabase, connectTestDatabase } from "../db/testDb.js";
import { getBytes, getJson, postJson, putJson } from "../routes/httpTestUtils.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

function workspaceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "Storage test",
    roi: null,
    imagerySnapshotId: null,
    imagerySelection: {},
    streetSnapshotId: null,
    streetSelection: {},
    preparation: { runState: "not_started", plan: null },
    activeSessionKey: null,
    sessionKeys: [],
    ...overrides,
  };
}

describe("storage routes", () => {
  before(connectTestDatabase);
  beforeEach(cleanTestDatabase);
  after(closeTestDatabase);

  it("creates, reads, updates, and conflicts on workspaces", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "First" }, "ws-create");
    assert.equal(created.status, 201);
    const createdBody = created.body as { workspaceId: string; revision: number };
    assert.match(createdBody.workspaceId, /^ws_[0-9a-f]{16}$/);
    assert.equal(createdBody.revision, 1);

    const fetched = await getJson(app, `/api/workspaces/${createdBody.workspaceId}`, "ws-get");
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body as { name: string }).name, "First");

    const updated = await putJson(
      app,
      `/api/workspaces/${createdBody.workspaceId}`,
      { expectedRevision: 1, workspace: workspaceBody({ name: "Renamed" }) },
      "ws-put",
    );
    assert.equal(updated.status, 200);
    assert.equal((updated.body as { revision: number }).revision, 2);

    const stale = await putJson(
      app,
      `/api/workspaces/${createdBody.workspaceId}`,
      { expectedRevision: 1, workspace: workspaceBody({ name: "Stale" }) },
      "ws-stale",
    );
    assert.equal(stale.status, 409);
    const staleBody = stale.body as { error: { code: string; currentRevision: number } };
    assert.equal(staleBody.error.code, "REVISION_CONFLICT");
    assert.equal(staleBody.error.currentRevision, 2);

    const missing = await getJson(app, "/api/workspaces/ws_0000000000000000", "ws-missing");
    assert.equal(missing.status, 404);

    const listed = await getJson(app, "/api/workspaces", "ws-list");
    assert.equal(listed.status, 200);
    const workspaces = (listed.body as { workspaces: { workspaceId: string }[] }).workspaces;
    assert.ok(workspaces.some((entry) => entry.workspaceId === createdBody.workspaceId));
  });

  it("stores immutable snapshots and validates workspace references", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Snaps" }, "sn-ws");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;

    const imagery = {
      schemaVersion: 1,
      snapshotId: "sn-imagery-1",
      kind: "imagery-discovery",
      payload: {
        query: { matchedCount: 1 },
        warnings: [],
        status: "results",
        everSearched: true,
        seeds: [
          {
            id: "img-1",
            coordinate: [19.04, 47.49],
            coordinateSource: "geometry",
            originalCoordinate: null,
            computedCoordinate: null,
            capturedAt: 1700000000000,
            isPano: false,
            sequenceId: "seq-1",
          },
        ],
        hydrated: [],
        truncatedCount: 0,
      },
    };
    const posted = await postJson(app, `/api/workspaces/${workspaceId}/snapshots`, imagery, "sn-post");
    assert.equal(posted.status, 201);
    const reposted = await postJson(app, `/api/workspaces/${workspaceId}/snapshots`, imagery, "sn-repost");
    assert.equal(reposted.status, 200);
    assert.equal((reposted.body as { deduplicated: boolean }).deduplicated, true);

    const conflict = await postJson(
      app,
      `/api/workspaces/${workspaceId}/snapshots`,
      { ...imagery, kind: "street-snapshot", payload: { streets: [], query: null, warnings: [], seeded: false, retrievedAt: null } },
      "sn-conflict",
    );
    assert.equal(conflict.status, 409);

    const fetched = await getJson(
      app,
      `/api/workspaces/${workspaceId}/snapshots/sn-imagery-1`,
      "sn-get",
    );
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body as { kind: string }).kind, "imagery-discovery");

    const broken = await putJson(
      app,
      `/api/workspaces/${workspaceId}`,
      { expectedRevision: 1, workspace: workspaceBody({ imagerySnapshotId: "sn-unknown" }) },
      "sn-broken",
    );
    assert.equal(broken.status, 400);
    assert.equal((broken.body as { error: { code: string } }).error.code, "BROKEN_EVIDENCE_LINK");

    const linked = await putJson(
      app,
      `/api/workspaces/${workspaceId}`,
      { expectedRevision: 1, workspace: workspaceBody({ imagerySnapshotId: "sn-imagery-1" }) },
      "sn-linked",
    );
    assert.equal(linked.status, 200);
  });

  it("creates and revision-guards sessions", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Sessions" }, "se-ws");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;

    const first = await putJson(
      app,
      `/api/workspaces/${workspaceId}/sessions/street-1`,
      { expectedRevision: null, session: sessionBody("street-1") },
      "se-create",
    );
    assert.equal(first.status, 201);
    assert.equal((first.body as { revision: number }).revision, 1);

    const duplicate = await putJson(
      app,
      `/api/workspaces/${workspaceId}/sessions/street-1`,
      { expectedRevision: null, session: sessionBody("street-1") },
      "se-duplicate",
    );
    assert.equal(duplicate.status, 409);
    assert.equal((duplicate.body as { error: { code: string } }).error.code, "SESSION_EXISTS");

    const fetched = await getJson(
      app,
      `/api/workspaces/${workspaceId}/sessions/street-1`,
      "se-get",
    );
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body as { sessionKey: string }).sessionKey, "street-1");

    const updated = await putJson(
      app,
      `/api/workspaces/${workspaceId}/sessions/street-1`,
      { expectedRevision: 1, session: sessionBody("street-1", { activeStep: "review" }) },
      "se-update",
    );
    assert.equal(updated.status, 200);
    assert.equal((updated.body as { revision: number }).revision, 2);

    const stale = await putJson(
      app,
      `/api/workspaces/${workspaceId}/sessions/street-1`,
      { expectedRevision: 1, session: sessionBody("street-1") },
      "se-stale",
    );
    assert.equal(stale.status, 409);
    assert.equal((stale.body as { error: { code: string } }).error.code, "REVISION_CONFLICT");

    const mismatch = await putJson(
      app,
      `/api/workspaces/${workspaceId}/sessions/street-2`,
      { expectedRevision: null, session: sessionBody("street-1") },
      "se-mismatch",
    );
    assert.equal(mismatch.status, 400);
  });

  it("rejects sessions with unknown evidence artifacts", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Evidence" }, "ev-ws");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const response = await putJson(
      app,
      `/api/workspaces/${workspaceId}/sessions/street-1`,
      {
        expectedRevision: null,
        session: sessionBody("street-1", {
          views: {
            "view-1": {
              viewId: "view-1",
              imageId: "img-1",
              fullWidth: 10,
              fullHeight: 10,
              orientation: 1,
              isPano: false,
              crop: null,
              width: 10,
              height: 10,
              mediaHandle: "",
              fullyReviewed: false,
              artifactId: "c".repeat(24),
            },
          },
          viewOrder: ["view-1"],
        }),
      },
      "ev-broken",
    );
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, "BROKEN_EVIDENCE_LINK");
  });

  it("registers, completes, interrupts, and pages detection items", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Items" }, "it-ws");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const base = `/api/workspaces/${workspaceId}/sessions/street-1/items`;
    const registration = {
      schemaVersion: 1,
      runId: "run-1",
      itemId: "item-1",
      kind: "batch",
      viewId: "view-1",
      conceptId: "concept-pole",
      prompt: "street light pole",
      categoryIntent: "pole",
      model: null,
      viewDescriptor: { width: 10, height: 10 },
      artifactId: "d".repeat(24),
      supersedes: null,
    };
    const registered = await postJson(app, base, registration, "it-register");
    assert.equal(registered.status, 201);
    assert.equal((registered.body as { status: string }).status, "queued");

    const rerequested = await postJson(app, base, registration, "it-reregister");
    assert.equal(rerequested.status, 200);
    assert.equal((rerequested.body as { deduplicated: boolean }).deduplicated, true);

    const conflict = await postJson(
      app,
      base,
      { ...registration, prompt: "street light fixture" },
      "it-conflict",
    );
    assert.equal(conflict.status, 409);

    const dangling = await postJson(
      app,
      base,
      { ...registration, itemId: "item-2", supersedes: "item-9" },
      "it-dangling",
    );
    assert.equal(dangling.status, 404);

    const completion = {
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
      truncated: true,
      invalidDiscarded: 2,
      error: null,
      providerRequestId: "req-1",
      finishedAt: new Date().toISOString(),
    };
    const completed = await postJson(app, `${base}/run-1/item-1/complete`, completion, "it-complete");
    assert.equal(completed.status, 200);

    const recompleted = await postJson(app, `${base}/run-1/item-1/complete`, completion, "it-recomplete");
    assert.equal(recompleted.status, 200);
    assert.equal((recompleted.body as { deduplicated: boolean }).deduplicated, true);

    const rewritten = await postJson(
      app,
      `${base}/run-1/item-1/complete`,
      { ...completion, invalidDiscarded: 3 },
      "it-rewrite",
    );
    assert.equal(rewritten.status, 409);
    assert.equal((rewritten.body as { error: { code: string } }).error.code, "ITEM_ALREADY_COMPLETE");

    const full = await getJson(app, `${base}/run-1/item-1`, "it-full");
    assert.equal(full.status, 200);
    const fullBody = full.body as { status: string; truncated: boolean; objects: unknown[] };
    assert.equal(fullBody.status, "succeeded");
    assert.equal(fullBody.truncated, true);
    assert.equal(fullBody.objects.length, 1);

    const stranded = await postJson(
      app,
      base,
      { ...registration, itemId: "item-3", supersedes: "item-1" },
      "it-stranded",
    );
    assert.equal(stranded.status, 201);
    const interrupted = await postJson(app, `${base}/run-1/item-3/interrupt`, {}, "it-interrupt");
    assert.equal(interrupted.status, 200);
    assert.equal((interrupted.body as { status: string }).status, "interrupted");

    const terminalNoop = await postJson(app, `${base}/run-1/item-1/interrupt`, {}, "it-noop");
    assert.equal(terminalNoop.status, 200);
    assert.equal((terminalNoop.body as { status: string }).status, "succeeded");

    const pageOne = await getJson(app, `${base}?limit=1`, "it-page-one");
    assert.equal(pageOne.status, 200);
    const pageOneBody = pageOne.body as { items: { itemId: string }[]; nextCursor: string | null };
    assert.equal(pageOneBody.items.length, 1);
    assert.ok(pageOneBody.nextCursor);

    const pageTwo = await getJson(app, `${base}?limit=1&cursor=${pageOneBody.nextCursor}`, "it-page-two");
    assert.equal(pageTwo.status, 200);
    const pageTwoBody = pageTwo.body as { items: { itemId: string }[] };
    assert.equal(pageTwoBody.items.length, 1);
    assert.notEqual(pageTwoBody.items[0].itemId, pageOneBody.items[0].itemId);
  });

  it("stores, deduplicates, and serves evidence artifacts", async () => {
    const app = createApp();
    const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
    const contentHash = sha256Hex(bytes);
    const body = {
      schemaVersion: 1,
      meta: {
        contentHash,
        mime: "image/png",
        width: 1,
        height: 1,
        byteLength: bytes.length,
        imageId: "img-1",
        viewId: null,
        orientation: 1,
        crop: null,
        attribution: "Mapillary",
        sourceUrl: "https://www.mapillary.com/map/im/img-1",
      },
      dataBase64: TINY_PNG_BASE64,
    };
    const stored = await postJson(app, "/api/artifacts", body, "ar-post");
    assert.equal(stored.status, 201);
    const artifactId = (stored.body as { artifactId: string }).artifactId;
    assert.match(artifactId, /^[0-9a-f]{24}$/);

    const restated = await postJson(app, "/api/artifacts", body, "ar-repost");
    assert.equal(restated.status, 200);
    assert.equal((restated.body as { deduplicated: boolean }).deduplicated, true);
    assert.equal((restated.body as { artifactId: string }).artifactId, artifactId);

    const meta = await getJson(app, `/api/artifacts/${artifactId}/meta`, "ar-meta");
    assert.equal(meta.status, 200);
    assert.equal((meta.body as { byteLength: number }).byteLength, bytes.length);
    assert.equal(
      ((meta.body as { meta: { contentHash: string } }).meta).contentHash,
      contentHash,
    );

    const fetched = await getBytes(app, `/api/artifacts/${artifactId}`, "ar-get");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers["content-type"], "image/png");
    assert.deepEqual(fetched.bytes, bytes);

    const missing = await getBytes(app, `/api/artifacts/${"0".repeat(24)}`, "ar-missing");
    assert.equal(missing.status, 404);

    const mismatch = await postJson(
      app,
      "/api/artifacts",
      { ...body, meta: { ...body.meta, contentHash: "e".repeat(64) } },
      "ar-mismatch",
    );
    assert.equal(mismatch.status, 400);
  });

  it("creates immutable reviewed results idempotently", async () => {
    const app = createApp();
    const created = await postJson(app, "/api/workspaces", { name: "Results" }, "rs-ws");
    const workspaceId = (created.body as { workspaceId: string }).workspaceId;
    const sessionPath = `/api/workspaces/${workspaceId}/sessions/street-1`;
    await putJson(app, sessionPath, { expectedRevision: null, session: sessionBody("street-1") }, "rs-session");

    const result = {
      schemaVersion: 1,
      resultId: "rs-1",
      sessionRevision: 1,
      inputRevision: 1,
      counts: { poles: 1, luminaires: 0 },
      limitations: ["Positions are manually placed approximations, or explicitly unknown."],
      provenance: { model: "sam-3.1" },
      snapshot: { assets: [] },
      artifactIds: [],
    };
    const posted = await postJson(app, `${sessionPath}/results`, result, "rs-post");
    assert.equal(posted.status, 201);

    const reposted = await postJson(app, `${sessionPath}/results`, result, "rs-repost");
    assert.equal(reposted.status, 200);
    assert.equal((reposted.body as { deduplicated: boolean }).deduplicated, true);

    const rewritten = await postJson(
      app,
      `${sessionPath}/results`,
      { ...result, counts: { poles: 2, luminaires: 0 } },
      "rs-rewrite",
    );
    assert.equal(rewritten.status, 409);

    const listed = await getJson(app, `${sessionPath}/results`, "rs-list");
    assert.equal(listed.status, 200);
    const results = (listed.body as { results: { resultId: string }[] }).results;
    assert.equal(results.length, 1);

    const fetched = await getJson(app, `${sessionPath}/results/rs-1`, "rs-get");
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body as { sessionRevision: number }).sessionRevision, 1);
  });

  it("reports database readiness on health", async () => {
    const app = createApp();
    const health = await getJson(app, "/api/health", "health-db");
    assert.equal(health.status, 200);
    assert.equal((health.body as { database: { state: string } }).database.state, "connected");
  });
});
