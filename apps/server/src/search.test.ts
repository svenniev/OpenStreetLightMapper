import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rectangleRingFromBbox, type LngLat } from "@openstreetlightmapper/geo";
import { MAPILLARY_SEARCH_LIMIT } from "./mapillary.js";
import { processProviderRecords } from "./search.js";

function point(lng: number, lat: number) {
  return { type: "Point", coordinates: [lng, lat] };
}

function record(partial: Record<string, unknown>) {
  return { id: "img-1", geometry: point(10.5, 20.5), ...partial };
}

const RING = rectangleRingFromBbox([10, 20, 11, 21]);

describe("processProviderRecords", () => {
  it("normalizes a complete record, preferring original geometry", () => {
    const processed = processProviderRecords(
      RING,
      [
        record({
          id: "mly123",
          geometry: point(10.5, 20.5),
          computed_geometry: point(10.5001, 20.5001),
          captured_at: "2024-05-01T12:00:00.000Z",
          is_pano: true,
          sequence: "seq-9",
        }),
      ],
    );
    assert.equal(processed.images.length, 1);
    assert.deepEqual(processed.images[0], {
      id: "mly123",
      coordinate: [10.5, 20.5],
      coordinateSource: "geometry",
      originalCoordinate: [10.5, 20.5],
      computedCoordinate: [10.5001, 20.5001],
      capturedAt: Date.parse("2024-05-01T12:00:00.000Z"),
      isPano: true,
      sequenceId: "seq-9",
    });
    assert.equal(processed.invalidRecordCount, 0);
  });

  it("falls back to computed geometry when the original point is unavailable", () => {
    const processed = processProviderRecords(
      RING,
      [record({ id: "c1", geometry: null, computed_geometry: point(10.6, 20.6) })],
    );
    assert.equal(processed.images.length, 1);
    assert.equal(processed.images[0].coordinateSource, "computed_geometry");
    assert.deepEqual(processed.images[0].coordinate, [10.6, 20.6]);
    assert.equal(processed.images[0].originalCoordinate, null);
  });

  it("excludes records with no valid coordinate or ID, keeping metadata nulls", () => {
    const processed = processProviderRecords(RING, [
      record({ id: "n1", geometry: null, computed_geometry: null }),
      record({ id: "", geometry: point(10.5, 20.5) }),
      record({ id: "ok", geometry: point(10.5, 20.5), captured_at: null }),
      "garbage",
    ]);
    assert.equal(processed.images.length, 1);
    assert.equal(processed.images[0].id, "ok");
    assert.equal(processed.images[0].capturedAt, null);
    assert.equal(processed.images[0].isPano, null);
    assert.equal(processed.images[0].sequenceId, null);
    assert.equal(processed.invalidRecordCount, 3);
    assert.ok(processed.warnings.includes("INVALID_RECORDS_EXCLUDED"));
  });

  it("preserves IDs as strings", () => {
    const processed = processProviderRecords(RING, [record({ id: 12345 })]);
    assert.equal(processed.images[0].id, "12345");
  });

  it("rejects unsafe numeric IDs instead of stringifying rounded numbers", () => {
    const processed = processProviderRecords(RING, [
      record({ id: Number.MAX_SAFE_INTEGER + 1 }),
      record({ id: 12.5 }),
    ]);
    assert.equal(processed.images.length, 0);
    assert.equal(processed.invalidRecordCount, 2);
  });

  it("treats numeric captured_at as milliseconds without magnitude inference", () => {
    const processed = processProviderRecords(
      RING,
      [record({ id: "t1", captured_at: 1_714_561_200 })],
    );
    assert.equal(processed.images[0].capturedAt, 1_714_561_200);
  });

  it("excludes bbox points outside the polygon but includes boundary points", () => {
    const lShape: LngLat[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
      [0, 0],
    ];
    const processed = processProviderRecords(lShape, [
      record({ id: "outside", geometry: point(1.5, 1.5) }),
      record({ id: "edge", geometry: point(1, 1.5) }),
      record({ id: "vertex", geometry: point(2, 0) }),
      record({ id: "inside", geometry: point(0.5, 0.5) }),
    ]);
    assert.deepEqual(
      processed.images.map((image) => image.id),
      ["edge", "vertex", "inside"],
    );
    assert.equal(processed.outsideRoiCount, 1);
  });

  it("deduplicates by image ID while keeping distinct IDs at one position", () => {
    const processed = processProviderRecords(RING, [
      record({ id: "dup", geometry: point(10.5, 20.5) }),
      record({ id: "dup", geometry: point(10.5, 20.5), captured_at: "2024-01-02T00:00:00Z" }),
      record({ id: "other", geometry: point(10.5, 20.5) }),
    ]);
    assert.deepEqual(
      processed.images.map((image) => image.id),
      ["dup", "other"],
    );
    assert.equal(processed.duplicateCount, 1);
    // First occurrence wins.
    assert.equal(processed.images[0].capturedAt, null);
  });

  it("reports possibly_truncated at the raw limit even with few final matches", () => {
    const raw: unknown[] = [];
    for (let i = 0; i < MAPILLARY_SEARCH_LIMIT; i += 1) {
      raw.push(
        i < 2
          ? record({ id: `in-${i}`, geometry: point(10.5, 20.5) })
          : record({ id: `out-${i}`, geometry: point(50, 50) }),
      );
    }
    const processed = processProviderRecords(RING, raw);
    assert.equal(processed.rawReturnedCount, MAPILLARY_SEARCH_LIMIT);
    assert.equal(processed.matchedCount, 2);
    assert.equal(processed.retrievalStatus, "possibly_truncated");
    assert.ok(processed.warnings.includes("POSSIBLY_TRUNCATED"));
  });

  it("reports truncation when the provider hints at more results", () => {
    const processed = processProviderRecords(RING, [record({ id: "a" })], {
      hasMoreIndication: true,
    });
    assert.equal(processed.retrievalStatus, "possibly_truncated");
    assert.ok(processed.warnings.includes("POSSIBLY_TRUNCATED"));
  });

  it("reports not_capped below the limit with no truncation", () => {
    const processed = processProviderRecords(RING, [record({ id: "a" })]);
    assert.equal(processed.retrievalStatus, "not_capped");
    assert.deepEqual(processed.warnings, []);
  });
});
