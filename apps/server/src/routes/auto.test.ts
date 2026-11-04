import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildResultLimitations, createAutoRouter } from "./auto.js";
import { getJson, jsonResponse, postJson } from "./httpTestUtils.js";
import {
  cleanTestDatabase,
  closeTestDatabase,
  connectTestDatabase,
  useIsolatedTestDatabase,
} from "../db/testDb.js";
import { InputSnapshotModel } from "../db/models.js";
import { AutoCandidateModel, AutoObservationModel, AutoWorkItemModel } from "../db/autoModels.js";
import { STORAGE_SCHEMA_VERSION } from "../db/validation.js";

// Own database: this file's cleanups must not wipe parallel test files.
useIsolatedTestDatabase("auto_routes");

const WS = "ws_aaaaaaaaaaaaaaaa";

function eligibleRecord(id: string): Record<string, unknown> {
  return {
    id,
    camera_type: "perspective",
    camera_parameters: [0.8, 0, 0],
    width: 2048,
    height: 1536,
    exif_orientation: 1,
    geometry: { type: "Point", coordinates: [19.0, 47.0] },
    computed_geometry: { type: "Point", coordinates: [19.0, 47.0] },
    altitude: 2,
    computed_altitude: 2,
    computed_rotation: [Math.PI / 2, 0, 0],
    compass_angle: 0,
    merge_cc: 1,
    captured_at: 1000,
    is_pano: false,
    creator: { username: "tester" },
    thumb_2048_url: `https://scontent.xx.fbcdn.net/${id}.jpg`,
  };
}

function mockFetch(records: Map<string, Record<string, unknown>>): typeof fetch {
  return (async (url: string) => {
    const ids = (new URL(String(url)).searchParams.get("image_ids") ?? "").split(",").filter(Boolean);
    return jsonResponse({ data: ids.map((id) => records.get(id)).filter(Boolean) });
  }) as unknown as typeof fetch;
}

function seedImagerySnapshot(
  snapshotId: string,
  seeds: Array<{ id: string; sequenceId: string; inRoi?: boolean }>,
): Promise<void> {
  const payload = {
    seeds: seeds.map((seed, index) => ({
      id: seed.id,
      coordinate: [19.0 + index * 0.01, 47.0],
      sequenceId: seed.sequenceId,
      ...(seed.inRoi === undefined ? {} : { inRoi: seed.inRoi }),
    })),
    hydrated: [],
  };
  return InputSnapshotModel()
    .create({
      snapshotId,
      workspaceId: WS,
      kind: "imagery-discovery",
      schemaVersion: STORAGE_SCHEMA_VERSION,
      payload,
      byteLength: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    })
    .then(() => {});
}

function planBody(snapshotId: string, sequenceIds: string[]): Record<string, unknown> {
  return {
    mode: "locate",
    snapshotId,
    streetSnapshotId: null,
    sequenceIds,
    concepts: [{ conceptId: "pole", text: "street light pole", category: "pole" }],
    maxImages: 100,
    maxCalls: 200,
    minSpacingM: 0,
  };
}

describe("auto routes", () => {
  const savedToken = process.env.MAPILLARY_ACCESS_TOKEN;
  const savedKey = process.env.MODEL_API_KEY;
  before(async () => {
    process.env.MAPILLARY_ACCESS_TOKEN = "test-token";
    process.env.MODEL_API_KEY = "test-key";
    await connectTestDatabase();
  });
  beforeEach(cleanTestDatabase);
  after(async () => {
    if (savedToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = savedToken;
    if (savedKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = savedKey;
    await closeTestDatabase();
  });

  function appFor(records: Map<string, Record<string, unknown>>): express.Express {
    const app = express();
    app.use(express.json({ limit: "12mb" }));
    let kicks = 0;
    app.use(createAutoRouter({ fetchImpl: mockFetch(records), kickWorker: () => { kicks += 1; } }));
    (app as unknown as { kickCount: () => number }).kickCount = () => kicks;
    return app;
  }

  it("prepares a bounded plan without calling SAM and stores the prepare snapshot", async () => {
    await seedImagerySnapshot("snap-1", [
      { id: "img-1", sequenceId: "seq-a" },
      { id: "img-2", sequenceId: "seq-a" },
    ]);
    const app = appFor(
      new Map([
        ["img-1", eligibleRecord("img-1")],
        ["img-2", eligibleRecord("img-2")],
      ]),
    );
    const response = await postJson(app, `/api/workspaces/${WS}/auto/prepare`, planBody("snap-1", ["seq-a"]), "prep-ok");
    assert.equal(response.status, 201);
    const body = response.body as Record<string, unknown>;
    assert.ok(typeof body.prepareSnapshotId === "string");
    assert.equal(body.mode, "locate");
    assert.equal(body.totalImages, 2);
    assert.equal(body.estimatedCalls, 2);
    assert.deepEqual((body.counts as Record<string, number>).eligibleImages, 2);
    assert.deepEqual(body.perSequence, [{ sequenceId: "seq-a", imageCount: 2, eligibleCount: 2 }]);
    const stored = await InputSnapshotModel().findOne({ snapshotId: body.prepareSnapshotId }).lean();
    assert.equal(stored?.kind, "auto-prepare");
  });

  it("prepare plans only in-RoI images and reports exclusions", async () => {
    await seedImagerySnapshot("snap-roi", [
      { id: "img-1", sequenceId: "seq-a", inRoi: true },
      { id: "img-2", sequenceId: "seq-a", inRoi: false },
    ]);
    const app = appFor(new Map([["img-1", eligibleRecord("img-1")]]));
    const response = await postJson(
      app,
      `/api/workspaces/${WS}/auto/prepare`,
      planBody("snap-roi", ["seq-a"]),
      "prep-roi",
    );
    assert.equal(response.status, 201);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.totalImages, 1);
    assert.equal(body.excludedOutsideRoi, 1);
    assert.equal(body.thinnedBySpacing, 0);
    assert.match((body.warnings as string[]).join(" "), /outside-RoI images excluded/);
  });

  it("prepare rejects unknown snapshots and over-budget selections", async () => {
    const app = appFor(new Map());
    const missing = await postJson(
      app,
      `/api/workspaces/${WS}/auto/prepare`,
      planBody("nope", ["seq-a"]),
      "prep-missing",
    );
    assert.equal(missing.status, 400);
    assert.equal((missing.body as { error: { code: string } }).error.code, "AUTO_PLAN_REJECTED");

    await seedImagerySnapshot("snap-2", [
      { id: "img-1", sequenceId: "seq-a" },
      { id: "img-2", sequenceId: "seq-a" },
    ]);
    const over = await postJson(
      app,
      `/api/workspaces/${WS}/auto/prepare`,
      { ...planBody("snap-2", ["seq-a"]), maxImages: 1 },
      "prep-over",
    );
    assert.equal(over.status, 400);
    assert.match(
      (over.body as { error: { message: string } }).error.message,
      /over the maxImages bound/,
    );
  });

  it("launches idempotently, rejects plan changes on a reused key, and reads back the job", async () => {
    await seedImagerySnapshot("snap-3", [{ id: "img-1", sequenceId: "seq-a" }]);
    const app = appFor(new Map([["img-1", eligibleRecord("img-1")]]));
    const prepared = await postJson(
      app,
      `/api/workspaces/${WS}/auto/prepare`,
      planBody("snap-3", ["seq-a"]),
      "launch-prep",
    );
    assert.equal(prepared.status, 201);
    const prepareSnapshotId = (prepared.body as Record<string, string>).prepareSnapshotId;

    const launch = { prepareSnapshotId, idempotencyKey: "key-1" };
    const first = await postJson(app, `/api/workspaces/${WS}/auto/jobs`, launch, "launch-1");
    assert.equal(first.status, 201);
    const jobId = (first.body as Record<string, string>).jobId;
    assert.equal((first.body as Record<string, boolean>).deduplicated, false);

    const second = await postJson(app, `/api/workspaces/${WS}/auto/jobs`, launch, "launch-2");
    assert.equal(second.status, 200);
    assert.equal((second.body as Record<string, string>).jobId, jobId);
    assert.equal((second.body as Record<string, boolean>).deduplicated, true);

    // Same key, different plan: conflict, not a second job.
    await seedImagerySnapshot("snap-4", [{ id: "img-9", sequenceId: "seq-b" }]);
    const app2 = appFor(new Map([["img-9", eligibleRecord("img-9")]]));
    const prepared2 = await postJson(
      app2,
      `/api/workspaces/${WS}/auto/prepare`,
      planBody("snap-4", ["seq-b"]),
      "launch-prep2",
    );
    const clash = await postJson(
      app2,
      `/api/workspaces/${WS}/auto/jobs`,
      { prepareSnapshotId: (prepared2.body as Record<string, string>).prepareSnapshotId, idempotencyKey: "key-1" },
      "launch-clash",
    );
    assert.equal(clash.status, 409);
    assert.equal((clash.body as { error: { code: string } }).error.code, "AUTO_JOB_CONFLICT");

    const fetched = await getJson(app, `/api/workspaces/${WS}/auto/jobs/${jobId}`, "launch-get");
    assert.equal(fetched.status, 200);
    // Contract with the web client's checkJobDetail: top-level summary
    // fields plus the plan (a raw job document misses mode/totalImages and
    // the client rejects it with BAD_RESPONSE).
    const fetchedBody = fetched.body as {
      job: Record<string, unknown>;
      progress: Record<string, number> | null;
    };
    assert.equal(fetchedBody.job.status, "queued");
    assert.equal(fetchedBody.job.mode, "locate");
    assert.equal(fetchedBody.job.totalImages, 1);
    assert.equal(fetchedBody.job.estimatedCalls, 1);
    assert.equal(typeof fetchedBody.job.callsMade, "number");
    const fetchedPlan = fetchedBody.job.plan as Record<string, unknown>;
    assert.deepEqual(fetchedPlan.sequenceIds, ["seq-a"]);
    assert.deepEqual(fetchedPlan.imageIds, ["img-1"]);
    assert.deepEqual(fetchedPlan.concepts, [
      { conceptId: "pole", text: "street light pole", category: "pole" },
    ]);
    assert.deepEqual(fetchedPlan.perSequence, [{ sequenceId: "seq-a", imageIds: ["img-1"] }]);
    assert.equal(fetchedBody.progress?.totalItems, 1);

    const listed = await getJson(app, `/api/workspaces/${WS}/auto/jobs`, "launch-list");
    assert.equal(listed.status, 200);
    assert.equal((listed.body as { jobs: unknown[] }).jobs.length, 1);

    const items = await getJson(app, `/api/workspaces/${WS}/auto/jobs/${jobId}/items`, "launch-items");
    assert.equal(items.status, 200);
    const itemList = (items.body as { items: Array<Record<string, unknown>> }).items;
    assert.equal(itemList.length, 1);
    assert.ok(!("response" in itemList[0]));
    const detail = await getJson(
      app,
      `/api/workspaces/${WS}/auto/jobs/${jobId}/items/${itemList[0].itemId}`,
      "launch-item",
    );
    assert.equal(detail.status, 200);

    const result = await getJson(app, `/api/workspaces/${WS}/auto/jobs/${jobId}/result`, "launch-result");
    assert.equal(result.status, 404);
    assert.equal((result.body as { error: { code: string } }).error.code, "AUTO_RESULT_NOT_FOUND");
  });

  it("launch requires configuration and a stored prepare", async () => {
    const app = appFor(new Map());
    const unknown = await postJson(
      app,
      `/api/workspaces/${WS}/auto/jobs`,
      { prepareSnapshotId: "aprep_missing", idempotencyKey: "key-x" },
      "launch-unknown",
    );
    assert.equal(unknown.status, 400);

    await seedImagerySnapshot("snap-5", [{ id: "img-1", sequenceId: "seq-a" }]);
    const appMeta = appFor(new Map([["img-1", eligibleRecord("img-1")]]));
    const prepared = await postJson(
      appMeta,
      `/api/workspaces/${WS}/auto/prepare`,
      planBody("snap-5", ["seq-a"]),
      "launch-cfg-prep",
    );
    assert.equal(prepared.status, 201);
    const prepareSnapshotId = (prepared.body as Record<string, string>).prepareSnapshotId;
    delete process.env.MODEL_API_KEY;
    try {
      const unconfigured = await postJson(
        app,
        `/api/workspaces/${WS}/auto/jobs`,
        { prepareSnapshotId, idempotencyKey: "key-y" },
        "launch-unconfigured",
      );
      assert.equal(unconfigured.status, 503);
      assert.equal((unconfigured.body as { error: { code: string } }).error.code, "SAM_NOT_CONFIGURED");
    } finally {
      process.env.MODEL_API_KEY = "test-key";
    }
  });

  it("stops, resumes, and rejects retry of a queued item", async () => {
    await seedImagerySnapshot("snap-6", [{ id: "img-1", sequenceId: "seq-a" }]);
    const app = appFor(new Map([["img-1", eligibleRecord("img-1")]]));
    const prepared = await postJson(
      app,
      `/api/workspaces/${WS}/auto/prepare`,
      planBody("snap-6", ["seq-a"]),
      "lifecycle-prep",
    );
    const launched = await postJson(
      app,
      `/api/workspaces/${WS}/auto/jobs`,
      {
        prepareSnapshotId: (prepared.body as Record<string, string>).prepareSnapshotId,
        idempotencyKey: "key-life",
      },
      "lifecycle-launch",
    );
    const jobId = (launched.body as Record<string, string>).jobId;

    const stopped = await postJson(app, `/api/workspaces/${WS}/auto/jobs/${jobId}/stop`, {}, "lifecycle-stop");
    assert.equal(stopped.status, 200);
    assert.equal((stopped.body as Record<string, string>).status, "stopped");

    const resumed = await postJson(app, `/api/workspaces/${WS}/auto/jobs/${jobId}/resume`, {}, "lifecycle-resume");
    assert.equal(resumed.status, 200);
    assert.equal((resumed.body as Record<string, string>).status, "queued");

    const items = await getJson(app, `/api/workspaces/${WS}/auto/jobs/${jobId}/items`, "lifecycle-items");
    const itemId = ((items.body as { items: Array<{ itemId: string }> }).items[0]).itemId;
    const retried = await postJson(
      app,
      `/api/workspaces/${WS}/auto/jobs/${jobId}/items/${itemId}/retry`,
      {},
      "lifecycle-retry",
    );
    assert.equal(retried.status, 409);
    assert.equal((retried.body as { error: { code: string } }).error.code, "AUTO_ITEM_CONFLICT");
  });

  it("derives result limitations only from counted gaps", () => {
    assert.deepEqual(buildResultLimitations({}), []);
    assert.deepEqual(buildResultLimitations({ failedItems: 0, unlocatedObservations: 0 }), []);
    assert.deepEqual(
      buildResultLimitations({
        failedItems: 2,
        haltedItems: 1,
        unlocatedObservations: 730,
        duplicateGroups: 3,
        streetSnapshotMissing: 4,
        streetLinesSkipped: 5,
      }),
      [
        "2 items failed before producing output.",
        "1 items halted before completion.",
        "730 observations unlocated (see the Unlocated list).",
        "3 possible-duplicate groups kept separate for review.",
        "4 assets lack street assignment: no street snapshot was provided.",
        "5 streets skipped during assignment (missing or ambiguous geometry).",
      ],
    );
  });

  it("serves candidate evidence with views, boxes, anchors, and masks", async () => {
    const jobId = "aj_evidence";
    await AutoCandidateModel().create({
      workspaceId: WS,
      jobId,
      candidateId: "cand-1",
      kind: "pole",
      status: "located",
      observationIds: ["obs-1", "obs-2"],
      imageIds: ["img-1", "img-2"],
      viewCount: 2,
      position: { lng: 19.0, lat: 47.0, uncertaintyM: 1.5, method: "triangulation-2view" },
      fit: { associationVersion: 1 },
      poleCandidateId: null,
      streetId: null,
    });
    await AutoObservationModel().create({
      workspaceId: WS,
      jobId,
      itemId: "item-1",
      observationId: "obs-1",
      imageId: "img-1",
      conceptId: "auto-pole",
      prompt: "street light pole",
      category: "pole",
      box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      confidence: 0.9,
      anchor: { uPx: 100, vPx: 200 },
      maskSupport: { bounds: { left: 90, top: 190, right: 130, bottom: 260 } },
      maskArtifactId: "6aeafed370a582b08ddf18ad",
    });
    await AutoObservationModel().create({
      workspaceId: WS,
      jobId,
      itemId: "item-2",
      observationId: "obs-2",
      imageId: "img-2",
      conceptId: "auto-pole",
      prompt: "street light pole",
      category: "pole",
      box: { x: 0, y: 0, w: 1, h: 1 },
      anchor: {},
    });
    await AutoWorkItemModel().create({
      workspaceId: WS,
      jobId,
      itemId: "item-1",
      sequenceId: "seq-a",
      imageId: "img-1",
      conceptId: "auto-pole",
      prompt: "street light pole",
      category: "pole",
      status: "succeeded",
      viewDescriptor: { width: 2048, height: 1152 },
      artifactId: "6aeafea870a582b08ddf1724",
      registeredAt: new Date(),
      finishedAt: new Date(),
    });
    const app = appFor(new Map());
    const response = await getJson(
      app,
      `/api/workspaces/${WS}/auto/jobs/${jobId}/candidates/cand-1/evidence`,
      "evidence-ok",
    );
    assert.equal(response.status, 200);
    const body = response.body as {
      candidateId: string;
      truncated: boolean;
      images: Array<Record<string, unknown>>;
      observations: Array<Record<string, unknown>>;
    };
    assert.equal(body.candidateId, "cand-1");
    assert.equal(body.truncated, false);
    assert.deepEqual(body.images, [
      { imageId: "img-1", viewArtifactId: "6aeafea870a582b08ddf1724", width: 2048, height: 1152 },
      { imageId: "img-2", viewArtifactId: null, width: null, height: null },
    ]);
    assert.deepEqual(body.observations, [
      {
        observationId: "obs-1",
        imageId: "img-1",
        box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        confidence: 0.9,
        anchor: { uPx: 100, vPx: 200 },
        maskArtifactId: "6aeafed370a582b08ddf18ad",
        maskBounds: { left: 90, top: 190, right: 130, bottom: 260 },
      },
      {
        observationId: "obs-2",
        imageId: "img-2",
        box: { x: 0, y: 0, w: 1, h: 1 },
        confidence: null,
        anchor: null,
        maskArtifactId: null,
        maskBounds: null,
      },
    ]);

    const missing = await getJson(
      app,
      `/api/workspaces/${WS}/auto/jobs/${jobId}/candidates/cand-nope/evidence`,
      "evidence-missing",
    );
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error: { code: string } }).error.code, "AUTO_CANDIDATE_NOT_FOUND");
  });

  it("rejects bad workspace ids and unknown statuses", async () => {
    const app = appFor(new Map());
    const badWorkspace = await getJson(app, "/api/workspaces/nope/auto/jobs", "guard-ws");
    assert.equal(badWorkspace.status, 404);
    const badStatus = await getJson(
      app,
      `/api/workspaces/${WS}/auto/jobs/aj_missing/items?status=bogus`,
      "guard-status",
    );
    assert.equal(badStatus.status, 400);
  });
});
