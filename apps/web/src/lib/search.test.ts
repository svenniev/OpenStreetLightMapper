import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESULT_PAGE_SIZE,
  createSearchGuard,
  formatArea,
  formatCapturedDate,
  formatPanoStatus,
  paginateResults,
  sortSearchResults,
  warningMessage,
} from "./search.js";
import type { ImageResult } from "./searchTypes.js";

function image(partial: Partial<ImageResult> & { id: string }): ImageResult {
  return {
    coordinate: [0, 0],
    coordinateSource: "geometry",
    originalCoordinate: [0, 0],
    computedCoordinate: null,
    capturedAt: null,
    isPano: null,
    sequenceId: null,
    ...partial,
  };
}

describe("sortSearchResults", () => {
  it("sorts by capture time descending, unknown last, ID for ties", () => {
    const sorted = sortSearchResults([
      image({ id: "b", capturedAt: 2000 }),
      image({ id: "u2" }),
      image({ id: "a", capturedAt: 2000 }),
      image({ id: "u1" }),
      image({ id: "c", capturedAt: 1000 }),
    ]);
    assert.deepEqual(
      sorted.map((item) => item.id),
      ["a", "b", "c", "u1", "u2"],
    );
  });

  it("does not mutate the input array", () => {
    const input = [image({ id: "b", capturedAt: 2 }), image({ id: "a", capturedAt: 3 })];
    sortSearchResults(input);
    assert.deepEqual(input.map((item) => item.id), ["b", "a"]);
  });
});

describe("paginateResults", () => {
  const images = Array.from({ length: 120 }, (_, index) => image({ id: `img-${index}` }));

  it("pages loaded results in chunks of 50", () => {
    assert.equal(RESULT_PAGE_SIZE, 50);
    const first = paginateResults(images, 1);
    assert.equal(first.items.length, 50);
    assert.equal(first.pageCount, 3);
    assert.equal(first.total, 120);
    const last = paginateResults(images, 3);
    assert.equal(last.items.length, 20);
    assert.equal(last.items[0].id, "img-100");
  });

  it("clamps out-of-range pages", () => {
    assert.equal(paginateResults(images, 0).page, 1);
    assert.equal(paginateResults(images, 99).page, 3);
    assert.equal(paginateResults([], 5).page, 1);
  });
});

describe("formatters", () => {
  it("labels capture dates in UTC and unknowns as Unknown", () => {
    assert.equal(formatCapturedDate(Date.parse("2024-05-01T12:00:00.000Z")), "2024-05-01 12:00 UTC");
    assert.equal(formatCapturedDate(null), "Unknown");
    assert.equal(formatCapturedDate(Number.NaN), "Unknown");
  });

  it("renders pano status without false defaults", () => {
    assert.equal(formatPanoStatus(true), "Panorama");
    assert.equal(formatPanoStatus(false), "Standard");
    assert.equal(formatPanoStatus(null), "Unknown");
  });

  it("formats areas as m² when small and km² otherwise", () => {
    assert.equal(formatArea(4200), "4,200 m²");
    assert.equal(formatArea(25_000_000), "25.00 km²");
    assert.equal(formatArea(Number.NaN), "Unknown");
  });

  it("maps warning codes to the specified truncation message", () => {
    assert.equal(
      warningMessage("POSSIBLY_TRUNCATED"),
      "The search reached the provider result limit. More images may exist; select a smaller region.",
    );
    assert.ok(warningMessage("SOMETHING_NEW").includes("SOMETHING_NEW"));
  });
});

describe("createSearchGuard", () => {
  it("rejects late responses from superseded searches", () => {
    const guard = createSearchGuard();
    const tokenA = guard.next();
    assert.equal(guard.isCurrent(tokenA), true);
    const tokenB = guard.next();
    assert.equal(guard.isCurrent(tokenA), false);
    assert.equal(guard.isCurrent(tokenB), true);
  });

  it("invalidates outstanding tokens on region replacement/clear", () => {
    const guard = createSearchGuard();
    const token = guard.next();
    guard.invalidate();
    assert.equal(guard.isCurrent(token), false);
  });

  it("keeps sequential searches current", () => {
    const guard = createSearchGuard();
    assert.equal(guard.isCurrent(guard.next()), true);
    assert.equal(guard.isCurrent(guard.next()), true);
  });
});
