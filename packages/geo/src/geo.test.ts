import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ROI_AREA_SQ_M,
  bboxAngularAreaSqDeg,
  bboxMeetsProviderLimit,
  bboxOfRing,
  checkRoiLimits,
  latLngToLngLat,
  pointInRing,
  rectangleRingFromBbox,
  ringAreaSqM,
  validateRoiPolygon,
  type LngLat,
} from "./geo.js";

function rectRing(west: number, south: number, east: number, north: number): LngLat[] {
  return rectangleRingFromBbox([west, south, east, north]);
}

describe("validateRoiPolygon", () => {
  it("accepts a rectangle with [lng, lat] ordering preserved", () => {
    const result = validateRoiPolygon({
      type: "Polygon",
      coordinates: [rectRing(19.04, 47.495, 19.045, 47.5)],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.bbox, [19.04, 47.495, 19.045, 47.5]);
    assert.ok(result.areaSqM > 0);
  });

  it("computes a sane geodesic area (0.01° square at the equator ≈ 1.24 km²)", () => {
    const ring = rectRing(0, 0, 0.01, 0.01);
    const area = ringAreaSqM(ring);
    // (0.01 * 111319.9 m)² ≈ 1.2392e6 m²; allow 1% tolerance.
    assert.ok(Math.abs(area - 1_239_200) / 1_239_200 < 0.01, `area was ${area}`);
  });

  it("closes an unclosed ring during normalization", () => {
    const result = validateRoiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ring[result.ring.length - 1], result.ring[0]);
  });

  it("rejects non-polygon input", () => {
    for (const input of [null, {}, { type: "Point" }, { type: "Polygon" }, []] as const) {
      const result = validateRoiPolygon(input);
      assert.equal(result.ok, false);
      assert.equal(result.code, "NOT_POLYGON");
    }
  });

  it("rejects holes and multi-rings", () => {
    const result = validateRoiPolygon({
      type: "Polygon",
      coordinates: [rectRing(0, 0, 1, 1), rectRing(0.2, 0.2, 0.8, 0.8)],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MULTIPLE_RINGS");
  });

  it("rejects too few and too many vertices", () => {
    const few = validateRoiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
    assert.equal(few.ok, false);
    assert.equal(few.code, "TOO_FEW_VERTICES");

    const many: LngLat[] = [];
    for (let i = 0; i < 101; i += 1) {
      const angle = (2 * Math.PI * i) / 101;
      many.push([Math.cos(angle), Math.sin(angle)]);
    }
    const crowded = validateRoiPolygon({ type: "Polygon", coordinates: [many] });
    assert.equal(crowded.ok, false);
    assert.equal(crowded.code, "TOO_MANY_VERTICES");
  });

  it("rejects non-finite coordinates", () => {
    for (const bad of [Number.NaN, Infinity, "1", null] as const) {
      const result = validateRoiPolygon({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [bad as unknown as number, 0],
            [0, 1],
            [0, 0],
          ],
        ],
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "NON_FINITE_COORDINATE");
    }
  });

  it("rejects out-of-range coordinates", () => {
    const lat = validateRoiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [0, 86],
          [1, 86],
          [0, 87],
          [0, 86],
        ],
      ],
    });
    assert.equal(lat.ok, false);
    assert.equal(lat.code, "LATITUDE_OUT_OF_RANGE");

    const lng = validateRoiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [181, 0],
          [182, 0],
          [181, 1],
          [181, 0],
        ],
      ],
    });
    assert.equal(lng.ok, false);
    assert.equal(lng.code, "LONGITUDE_OUT_OF_RANGE");
  });

  it("rejects degenerate zero-height shapes", () => {
    const result = validateRoiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [0, 5],
          [1, 5],
          [2, 5],
          [0, 5],
        ],
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "DEGENERATE_BBOX");
  });

  it("rejects antimeridian-crossing selections", () => {
    const result = validateRoiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [179, 10],
          [-179, 10],
          [-179, 11],
          [179, 11],
          [179, 10],
        ],
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ANTIMERIDIAN_CROSSING");
  });

  it("rejects self-intersecting bowties", () => {
    const result = validateRoiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 2],
          [2, 0],
          [0, 2],
          [0, 0],
        ],
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SELF_INTERSECTION");
  });
});

describe("checkRoiLimits", () => {
  it("accepts exactly 25 km² and rejects above it", () => {
    const smallBbox = bboxOfRing(rectRing(0, 0, 0.001, 0.001));
    assert.equal(checkRoiLimits(MAX_ROI_AREA_SQ_M, smallBbox).ok, true);
    const over = checkRoiLimits(MAX_ROI_AREA_SQ_M + 1, smallBbox);
    assert.equal(over.ok, false);
    assert.equal(over.code, "AREA_TOO_LARGE");
  });

  it("rejects a thin polygon with a large bounding box despite a small area", () => {
    // L-shape: bbox 0.15° × 0.07° = 0.0105 sq deg, area ≈ 21 km².
    const ring: LngLat[] = [
      [0, 0],
      [0.15, 0],
      [0.15, 0.008],
      [0.008, 0.008],
      [0.008, 0.07],
      [0, 0.07],
      [0, 0],
    ];
    const validated = validateRoiPolygon({ type: "Polygon", coordinates: [ring] });
    assert.equal(validated.ok, true);
    assert.ok(validated.areaSqM <= MAX_ROI_AREA_SQ_M, `area was ${validated.areaSqM}`);
    const limits = checkRoiLimits(validated.areaSqM, validated.bbox);
    assert.equal(limits.ok, false);
    assert.equal(limits.code, "BBOX_TOO_LARGE");
  });
});

describe("provider bbox constraint", () => {
  it("is strict: exactly 0.01 square degrees fails", () => {
    // 1 * 0.01 is exactly the double nearest 0.01: equality must fail.
    assert.equal(bboxAngularAreaSqDeg([0, 0, 1, 0.01]), 0.01);
    assert.equal(bboxMeetsProviderLimit([0, 0, 1, 0.01]), false);
    // 0.1 * 0.1 is 0.010000000000000002 in floating point: also fails.
    assert.equal(bboxMeetsProviderLimit([0, 0, 0.1, 0.1]), false);
  });

  it("accepts areas just below the boundary", () => {
    assert.equal(bboxMeetsProviderLimit([0, 0, 0.09, 0.11]), true);
    assert.equal(bboxMeetsProviderLimit([0, 0, 0.099, 0.1]), true);
  });
});

describe("pointInRing", () => {
  const ring = rectRing(10, 20, 11, 21);

  it("includes interior points and excludes exterior points", () => {
    assert.equal(pointInRing([10.5, 20.5], ring), true);
    assert.equal(pointInRing([12, 20.5], ring), false);
  });

  it("includes edge and vertex points", () => {
    assert.equal(pointInRing([10, 20.5], ring), true);
    assert.equal(pointInRing([10.5, 20], ring), true);
    assert.equal(pointInRing([10, 20], ring), true);
  });

  it("excludes bbox-interior points outside a concave polygon", () => {
    const lShape: LngLat[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
      [0, 0],
    ];
    assert.equal(pointInRing([1.5, 1.5], lShape), false); // inside bbox, outside shape
    assert.equal(pointInRing([0.5, 1.5], lShape), true);
  });
});

describe("helpers", () => {
  it("converts Leaflet [lat, lng] to GeoJSON [lng, lat] explicitly", () => {
    assert.deepEqual(latLngToLngLat(47.5, 19.04), [19.04, 47.5]);
  });

  it("builds closed rectangle rings from bboxes", () => {
    const ring = rectangleRingFromBbox([1, 2, 3, 4]);
    assert.deepEqual(ring, [
      [1, 2],
      [3, 2],
      [3, 4],
      [1, 4],
      [1, 2],
    ]);
  });
});
