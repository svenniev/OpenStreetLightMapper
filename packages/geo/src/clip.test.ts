import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clipPolylineToRing,
  clipSegmentToRing,
  fragmentsLengthM,
  polylineLengthM,
  rectangleRingFromBbox,
  type LngLat,
} from "./geo.js";

const RING = rectangleRingFromBbox([10, 20, 11, 21]);

function near(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} ≈ ${expected}`,
  );
}

describe("clipSegmentToRing", () => {
  it("keeps a fully inside segment", () => {
    const fragments = clipSegmentToRing([10.2, 20.2], [10.8, 20.8], RING);
    assert.equal(fragments.length, 1);
    assert.deepEqual(fragments[0][0], [10.2, 20.2]);
    assert.deepEqual(fragments[0][1], [10.8, 20.8]);
  });

  it("drops a fully outside segment", () => {
    assert.deepEqual(clipSegmentToRing([12, 20.5], [13, 20.5], RING), []);
  });

  it("clips a crossing segment with both endpoints outside", () => {
    const fragments = clipSegmentToRing([9.5, 20.5], [11.5, 20.5], RING);
    assert.equal(fragments.length, 1);
    near(fragments[0][0][0], 10);
    near(fragments[0][0][1], 20.5);
    near(fragments[0][1][0], 11);
    near(fragments[0][1][1], 20.5);
  });

  it("includes a boundary-collinear segment", () => {
    const fragments = clipSegmentToRing([10, 20], [11, 20], RING);
    assert.equal(fragments.length, 1);
    assert.ok(polylineLengthM(fragments[0]) > 100_000);
  });

  it("excludes a point-only touch", () => {
    // Touches the corner (11, 21) and leaves again.
    assert.deepEqual(clipSegmentToRing([11.5, 21.5], [11, 21], RING), []);
    assert.deepEqual(clipSegmentToRing([10.5, 21.5], [11.5, 21.5], RING), []);
  });

  it("drops degenerate zero-length segments", () => {
    assert.deepEqual(clipSegmentToRing([10.5, 20.5], [10.5, 20.5], RING), []);
  });
});

describe("clipPolylineToRing", () => {
  it("yields disconnected fragments for a concave polygon and excludes gaps", () => {
    // C-shape: polyline enters, leaves, and re-enters through the notch.
    const cShape: LngLat[] = [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
      [0, 2],
      [2, 2],
      [2, 1],
      [0, 1],
      [0, 0],
    ];
    const line: LngLat[] = [
      [-1, 0.5],
      [4, 0.5],
    ];
    const fragments = clipPolylineToRing(line, cShape);
    assert.equal(fragments.length, 1);
    near(fragments[0][0][0], 0);
    near(fragments[0][1][0], 3);

    // Vertical line through the notch crosses the bottom and top bars
    // with the notch gap between them.
    const notchLine: LngLat[] = [
      [1, -1],
      [1, 4],
    ];
    const notchFragments = clipPolylineToRing(notchLine, cShape);
    assert.equal(notchFragments.length, 2);
    near(notchFragments[0][0][1], 0);
    near(notchFragments[0][1][1], 1);
    near(notchFragments[1][0][1], 2);
    near(notchFragments[1][1][1], 3);
    // Length excludes the gap between fragments.
    const total = fragmentsLengthM(notchFragments);
    const gapFree = polylineLengthM([
      [1, 0],
      [1, 1],
    ]) + polylineLengthM([
      [1, 2],
      [1, 3],
    ]);
    near(total, gapFree, 1e-3);
  });
});

describe("length", () => {
  it("measures 0.001° of latitude as about 111.2 m", () => {
    const length = polylineLengthM([
      [19.04, 47.5],
      [19.04, 47.501],
    ]);
    assert.ok(Math.abs(length - 111.195) < 0.2, `length was ${length}`);
  });
});
