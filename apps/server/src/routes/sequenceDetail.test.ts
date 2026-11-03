import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { jsonResponse, mockJsonProvider, postJson } from "./httpTestUtils.js";

const VALID_ROI = {
  type: "Polygon",
  coordinates: [
    [
      [19.04, 47.495],
      [19.045, 47.495],
      [19.045, 47.5],
      [19.04, 47.5],
      [19.04, 47.495],
    ],
  ],
};

const ROUTE = "/api/mapillary/sequences/seq-1/images";

function entity(id: string, lng: number, lat: number) {
  return {
    id,
    geometry: { type: "Point", coordinates: [lng, lat] },
    computed_geometry: null,
    captured_at: "2024-05-01T12:00:00.000Z",
    is_pano: true,
    sequence: "seq-1",
  };
}

describe("POST /api/mapillary/sequences/:sequenceId/images", () => {
  const previousToken = process.env.MAPILLARY_ACCESS_TOKEN;

  beforeEach(() => {
    process.env.MAPILLARY_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = previousToken;
  });

  it("returns ordered membership plus hydrated records with in-RoI flags", async () => {
    const urls: string[] = [];
    const app = createApp({
      mapillaryFetch: mockJsonProvider(
        (url) => {
          if (url.includes("/image_ids?")) {
            return jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] });
          }
          return jsonResponse({ data: [entity("m1", 19.042, 47.497), entity("m2", 50, 50)] });
        },
        (url) => {
          urls.push(url);
        },
      ),
    });
    const response = await postJson(app, ROUTE, { roi: VALID_ROI }, "seq-success");
    assert.equal(response.status, 200);
    const body = response.body as {
      sequenceId: string;
      memberIds: string[];
      images: { id: string; inRoi: boolean }[];
      membership: { status: string };
      detail: Record<string, number | string>;
      warnings: string[];
      retrievedAt: string;
      requestedAt: string;
    };
    assert.equal(body.sequenceId, "seq-1");
    assert.deepEqual(body.memberIds, ["m1", "m2"]);
    assert.deepEqual(
      body.images.map((image) => [image.id, image.inRoi]),
      [
        ["m1", true],
        ["m2", false],
      ],
    );
    assert.equal(body.membership.status, "complete");
    assert.equal(body.detail.status, "loaded");
    assert.equal(typeof body.retrievedAt, "string");
    assert.ok(urls.some((url) => url.includes("/image_ids?sequence_id=seq-1")));
    assert.ok(urls.some((url) => url.includes("image_ids=m1%2Cm2") || url.includes("image_ids=m1,m2")));
  });

  it("skips known IDs and validates the sequence ID param", async () => {
    const batchUrls: string[] = [];
    const app = createApp({
      mapillaryFetch: mockJsonProvider((url) => {
        if (url.includes("/image_ids?")) {
          return jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] });
        }
        batchUrls.push(url);
        return jsonResponse({ data: [entity("m2", 19.042, 47.497)] });
      }),
    });
    const response = await postJson(
      app,
      ROUTE,
      { roi: VALID_ROI, knownIds: ["m1"] },
      "seq-known",
    );
    assert.equal(response.status, 200);
    const body = response.body as { detail: { skippedKnownCount: number; loadedCount: number } };
    assert.equal(body.detail.skippedKnownCount, 1);
    assert.equal(body.detail.loadedCount, 1);
    assert.equal(batchUrls.length, 1);
    assert.ok(!batchUrls[0].includes("m1"));

    const badId = await postJson(
      app,
      "/api/mapillary/sequences/../../etc/images",
      { roi: VALID_ROI },
      "seq-bad-id",
    );
    assert.equal(badId.status, 404); // Express normalizes the traversal out of the route
  });

  it("rejects invalid sequence IDs, geometry, and unbounded knownIds", async () => {
    let calls = 0;
    const app = createApp({
      mapillaryFetch: mockJsonProvider(() => {
        calls += 1;
        return jsonResponse({ data: [] });
      }),
    });
    const badSequence = await postJson(
      app,
      "/api/mapillary/sequences/bad%20id%21/images",
      { roi: VALID_ROI },
      "seq-invalid",
    );
    assert.equal(badSequence.status, 400);
    assert.equal((badSequence.body as { error: { code: string } }).error.code, "SEQUENCE_INVALID_ID");

    const badRoi = await postJson(app, ROUTE, { roi: { type: "Point" } }, "seq-bad-roi");
    assert.equal(badRoi.status, 400);

    const tooMany = await postJson(
      app,
      ROUTE,
      { roi: VALID_ROI, knownIds: new Array(20_001).fill("m1") },
      "seq-too-many",
    );
    assert.equal(tooMany.status, 400);
    assert.equal((tooMany.body as { error: { code: string } }).error.code, "KNOWN_IDS_TOO_MANY");
    assert.equal(calls, 0);
  });

  it("returns 503 without a token and 502 on provider auth failure", async () => {
    delete process.env.MAPILLARY_ACCESS_TOKEN;
    const unconfigured = createApp({
      mapillaryFetch: mockJsonProvider(() => jsonResponse({ data: [] })),
    });
    const missing = await postJson(unconfigured, ROUTE, { roi: VALID_ROI }, "seq-no-token");
    assert.equal(missing.status, 503);

    process.env.MAPILLARY_ACCESS_TOKEN = "test-token";
    const denied = createApp({
      mapillaryFetch: mockJsonProvider(() =>
        jsonResponse({ error: { code: 190, message: "bad" } }, 401),
      ),
    });
    const auth = await postJson(denied, ROUTE, { roi: VALID_ROI }, "seq-auth");
    assert.equal(auth.status, 502);
    assert.equal((auth.body as { error: { code: string } }).error.code, "MAPILLARY_AUTH_ERROR");
  });

  it("preserves Retry-After on provider throttling", async () => {
    const app = createApp({
      mapillaryFetch: mockJsonProvider(() =>
        jsonResponse({ error: { message: "slow" } }, 429, { "retry-after": "11" }),
      ),
    });
    const response = await postJson(app, ROUTE, { roi: VALID_ROI }, "seq-throttle");
    assert.equal(response.status, 429);
    assert.equal(response.headers["retry-after"], "11");
  });
});
