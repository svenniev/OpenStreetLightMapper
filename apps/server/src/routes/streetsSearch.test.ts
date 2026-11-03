import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { jsonResponse, mockJsonProvider, postJson } from "./httpTestUtils.js";
import type { LngLat } from "@openstreetlightmapper/geo";

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

const ROUTE = "/api/streets/search";

function way(wayId: number, coords: LngLat[], tags: Record<string, string>, base = 0) {
  return {
    type: "way",
    id: wayId,
    nodes: coords.map((_, index) => base + index),
    geometry: coords.map(([lng, lat]) => ({ lat, lon: lng })),
    tags,
    version: 1,
    timestamp: "2024-01-01T00:00:00Z",
  };
}

describe("POST /api/streets/search", () => {
  it("returns street work items with query metadata", async () => {
    const posted: string[] = [];
    const app = createApp({
      overpassFetch: (async (_url: string, init?: { body?: unknown }) => {
        posted.push(String(init?.body ?? ""));
        return jsonResponse({
          elements: [
            way(1, [[19.038, 47.497], [19.047, 47.497]], {
              highway: "residential",
              name: "Cross St",
            }),
          ],
        });
      }) as unknown as typeof fetch,
      overpassUrl: "https://overpass-test.invalid/api/interpreter",
    });
    const response = await postJson(app, ROUTE, { roi: VALID_ROI }, "streets-success");
    assert.equal(response.status, 200);
    const body = response.body as {
      streets: { id: string; displayName: string; lengthM: number; wayIds: number[] }[];
      query: Record<string, number | string>;
      warnings: string[];
    };
    assert.equal(body.streets.length, 1);
    assert.equal(body.streets[0].displayName, "Cross St");
    assert.ok(body.streets[0].lengthM > 0);
    assert.equal(body.query.streetCount, 1);
    assert.equal(body.query.status, "complete");
    assert.deepEqual(body.warnings, []);
    assert.equal(posted.length, 1);
    const decoded = decodeURIComponent(posted[0].replace(/^data=/, ""));
    assert.ok(decoded.includes("(47.495,19.04,47.5,19.045)"));
    assert.ok(decoded.includes("around:1,47.495,19.04"));
  });

  it("rejects invalid geometry without calling Overpass", async () => {
    let calls = 0;
    const app = createApp({
      overpassFetch: mockJsonProvider(() => {
        calls += 1;
        return jsonResponse({ elements: [] });
      }),
      overpassUrl: "https://overpass-test.invalid/api/interpreter",
    });
    const response = await postJson(app, ROUTE, { roi: { type: "Point" } }, "streets-bad-roi");
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  });

  it("distinguishes successful empty results from failures", async () => {
    const empty = createApp({
      overpassFetch: mockJsonProvider(() => jsonResponse({ elements: [] })),
      overpassUrl: "https://overpass-test.invalid/api/interpreter",
    });
    const response = await postJson(empty, ROUTE, { roi: VALID_ROI }, "streets-empty");
    assert.equal(response.status, 200);
    const body = response.body as { streets: unknown[]; query: { streetCount: number; status: string } };
    assert.deepEqual(body.streets, []);
    assert.equal(body.query.streetCount, 0);
    assert.equal(body.query.status, "complete");

    const remarked = createApp({
      overpassFetch: mockJsonProvider(() =>
        jsonResponse({ remark: "runtime error: timeout", elements: [] }),
      ),
      overpassUrl: "https://overpass-test.invalid/api/interpreter",
    });
    const failed = await postJson(remarked, ROUTE, { roi: VALID_ROI }, "streets-remark");
    assert.equal(failed.status, 502);
    assert.equal((failed.body as { error: { code: string } }).error.code, "OVERPASS_INCOMPLETE");
  });

  it("maps throttling with Retry-After and rejects oversized candidate sets", async () => {
    const throttled = createApp({
      overpassFetch: mockJsonProvider(() => jsonResponse({}, 429, { "retry-after": "9" })),
      overpassUrl: "https://overpass-test.invalid/api/interpreter",
    });
    const limited = await postJson(throttled, ROUTE, { roi: VALID_ROI }, "streets-throttle");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["retry-after"], "9");

    const huge = createApp({
      overpassFetch: mockJsonProvider(() =>
        jsonResponse({
          elements: Array.from({ length: 5001 }, (_, index) =>
            way(5000 + index, [[19.041, 47.496], [19.042, 47.497]], { highway: "residential" }, 900000 + index * 2),
          ),
        }),
      ),
      overpassUrl: "https://overpass-test.invalid/api/interpreter",
    });
    const oversized = await postJson(huge, ROUTE, { roi: VALID_ROI }, "streets-huge");
    assert.equal(oversized.status, 400);
    assert.equal((oversized.body as { error: { code: string } }).error.code, "STREET_LIMIT_EXCEEDED");
  });

  it("reports endpoint misconfiguration as a server error", async () => {
    const app = createApp({
      overpassFetch: mockJsonProvider(() => jsonResponse({ elements: [] })),
      overpassUrl: "gopher://example.invalid/",
    });
    const response = await postJson(app, ROUTE, { roi: VALID_ROI }, "streets-misconfigured");
    assert.equal(response.status, 500);
    assert.equal((response.body as { error: { code: string } }).error.code, "OVERPASS_MISCONFIGURED");
  });
});
