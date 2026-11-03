import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { getBytes, getJson, jsonResponse, mockJsonProvider } from "./httpTestUtils.js";

const DETAIL = {
  id: "4242",
  sequence: "seq-9",
  captured_at: 1700000000000,
  is_pano: true,
  geometry: { type: "Point", coordinates: [19.04, 47.49] },
  computed_geometry: { type: "Point", coordinates: [19.041, 47.491] },
  compass_angle: 90,
  computed_compass_angle: 95,
  creator: { username: "tester", id: "u-1" },
  thumb_1024_url: "https://images.mapillary.com/secret-1024.jpg?sig=SIGNED-SECRET",
  thumb_2048_url: "https://images.mapillary.com/secret-2048.jpg?sig=SIGNED-SECRET",
};

describe("GET /api/imagery/:imageId", () => {
  const previousToken = process.env.MAPILLARY_ACCESS_TOKEN;

  beforeEach(() => {
    process.env.MAPILLARY_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = previousToken;
  });

  it("returns metadata, attribution, and an opaque media handle", async () => {
    const app = createApp({ mapillaryFetch: mockJsonProvider(() => jsonResponse(DETAIL)) });
    const response = await getJson(app, "/api/imagery/4242", "imagery-metadata");
    assert.equal(response.status, 200);
    const body = response.body as {
      image: Record<string, unknown>;
      media: { handle: string; url: string; expiresAt: string };
    };
    assert.equal(body.image.imageId, "4242");
    assert.equal(body.image.sequenceId, "seq-9");
    assert.equal(body.image.capturedAt, 1700000000000);
    assert.equal(body.image.isPano, true);
    assert.equal(body.image.creator, "tester");
    assert.equal(body.image.attribution, "© Mapillary contributors — tester");
    assert.equal(body.image.sourceUrl, "https://www.mapillary.com/map/im/4242");
    assert.deepEqual(body.image.cameraPosition, { lng: 19.04, lat: 47.49 });
    assert.equal(body.image.coordinateSource, "geometry");
    assert.equal(body.image.resolution, "2048px thumbnail");
    assert.match(body.media.handle, /^[0-9a-f-]{36}$/);
    assert.equal(body.media.url, `/api/imagery/media/${body.media.handle}`);
    assert.ok(!Number.isNaN(Date.parse(body.media.expiresAt)));
    // The signed provider URL never leaves the server.
    assert.ok(!JSON.stringify(body).includes("SIGNED-SECRET"));
  });

  it("rejects invalid IDs before any provider call", async () => {
    let calls = 0;
    const app = createApp({
      mapillaryFetch: mockJsonProvider(() => jsonResponse(DETAIL), () => {
        calls += 1;
      }),
    });
    const response = await getJson(app, "/api/imagery/..%2F42", "imagery-bad-id");
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, "IMAGERY_BAD_ID");
    assert.equal(calls, 0);
  });

  it("returns 503 when the server search token is missing", async () => {
    delete process.env.MAPILLARY_ACCESS_TOKEN;
    const app = createApp({ mapillaryFetch: mockJsonProvider(() => jsonResponse(DETAIL)) });
    const response = await getJson(app, "/api/imagery/4242", "imagery-no-token");
    assert.equal(response.status, 503);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      "MAPILLARY_NOT_CONFIGURED",
    );
  });

  it("maps provider auth and throttle failures without leaking bodies", async () => {
    const denied = createApp({
      mapillaryFetch: mockJsonProvider(() => jsonResponse({ error: { code: 190 } }, 403)),
    });
    const deniedResponse = await getJson(denied, "/api/imagery/4242", "imagery-denied");
    assert.equal(deniedResponse.status, 502);
    assert.equal(
      (deniedResponse.body as { error: { code: string } }).error.code,
      "MAPILLARY_AUTH_ERROR",
    );

    const throttled = createApp({
      mapillaryFetch: mockJsonProvider(() =>
        jsonResponse({ error: { code: 4 } }, 429, { "retry-after": "5" }),
      ),
    });
    const throttledResponse = await getJson(throttled, "/api/imagery/4242", "imagery-throttled");
    assert.equal(throttledResponse.status, 429);
    assert.equal(throttledResponse.headers["retry-after"], "5");
  });
});

describe("GET /api/imagery/media/:handle", () => {
  const previousToken = process.env.MAPILLARY_ACCESS_TOKEN;

  beforeEach(() => {
    process.env.MAPILLARY_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = previousToken;
  });

  it("serves the exact bytes behind a live handle", async () => {
    const pixels = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const app = createApp({
      mapillaryFetch: mockJsonProvider((url) => {
        if (url.includes("graph.mapillary.com/4242")) return jsonResponse(DETAIL);
        return new Response(pixels, { status: 200, headers: { "content-type": "image/jpeg" } });
      }),
    });
    const metadata = await getJson(app, "/api/imagery/4242", "imagery-flow-meta");
    const handle = (metadata.body as { media: { handle: string } }).media.handle;
    const media = await getBytes(app, `/api/imagery/media/${handle}`, "imagery-flow-media");
    assert.equal(media.status, 200);
    assert.equal(media.headers["content-type"], "image/jpeg");
    assert.equal(media.headers["cache-control"], "private, max-age=300");
    assert.deepEqual(media.bytes, pixels);
  });

  it("fails closed on unknown and malformed handles", async () => {
    const app = createApp({ mapillaryFetch: mockJsonProvider(() => jsonResponse(DETAIL)) });
    const unknown = await getJson(
      app,
      "/api/imagery/media/00000000-0000-0000-0000-000000000000",
      "imagery-unknown",
    );
    assert.equal(unknown.status, 410);
    assert.equal(
      (unknown.body as { error: { code: string } }).error.code,
      "IMAGERY_UNKNOWN_HANDLE",
    );
    const malformed = await getJson(
      app,
      "/api/imagery/media/https%3A%2F%2Fevil.example%2Fx.jpg",
      "imagery-malformed",
    );
    assert.equal(malformed.status, 410);
  });
});
