import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateStreetForPlan } from "../preparation/preparationPlan.js";
import {
  buildDemoSeed,
  DEMO_STREET_ID,
  DEMO_STREET_NAME,
  SEEDED_DEMO_DATA,
  type SeedPoint,
} from "./seedDemo.js";

const BBOX = [19.03, 47.49, 19.05, 47.5] as [number, number, number, number];

function point(overrides: Partial<SeedPoint> & { id: string }): SeedPoint {
  return {
    lng: 19.04,
    lat: 47.495,
    sequenceId: "seq-1",
    capturedAt: null,
    ...overrides,
  };
}

describe("buildDemoSeed", () => {
  it("follows sequenced positions in capture order with stable ties", () => {
    const seed = buildDemoSeed(
      [
        point({ id: "c", lng: 19.041, capturedAt: 3000, sequenceId: "seq-2" }),
        point({ id: "b", lng: 19.0405, capturedAt: null, sequenceId: "seq-1" }),
        point({ id: "a", lng: 19.04, capturedAt: 1000, sequenceId: "seq-1" }),
      ],
      BBOX,
      "2026-11-03T12:00:00.000Z",
    );
    assert.ok(seed);
    assert.deepEqual(seed.street.geometry.coordinates, [
      [
        [19.04, 47.495],
        [19.041, 47.495],
        [19.0405, 47.495],
      ],
    ]);
    assert.deepEqual(seed.sequenceIds, ["seq-1", "seq-2"]);
    assert.equal(seed.pointCount, 3);
  });

  it("labels the demo street and records the seeded source", () => {
    const seed = buildDemoSeed(
      [point({ id: "a", lng: 19.04 }), point({ id: "b", lng: 19.041 })],
      BBOX,
      "2026-11-03T12:00:00.000Z",
    );
    assert.ok(seed);
    assert.equal(seed.street.id, DEMO_STREET_ID);
    assert.equal(seed.street.displayName, DEMO_STREET_NAME);
    assert.ok(seed.street.partLabel?.includes("demo"));
    assert.ok(seed.street.lengthM > 0);
    assert.deepEqual(seed.street.demoSequenceIds, ["seq-1"]);
    assert.equal(seed.query.status, "seeded-demo");
    assert.equal(seed.query.retrievedAt, "2026-11-03T12:00:00.000Z");
    assert.deepEqual(seed.warnings, [SEEDED_DEMO_DATA]);
    // The seed must flow into preparation like any street.
    assert.equal(validateStreetForPlan(seed.street), null);
  });

  it("returns null when no line can be formed", () => {
    assert.equal(buildDemoSeed([], BBOX), null);
    assert.equal(buildDemoSeed([point({ id: "a" })], BBOX), null);
    // Same position twice: one unique coordinate.
    assert.equal(
      buildDemoSeed([point({ id: "a" }), point({ id: "b" })], BBOX),
      null,
    );
    // Unusable coordinates are dropped, not fabricated.
    assert.equal(
      buildDemoSeed(
        [point({ id: "a", lng: Number.NaN }), point({ id: "b", lng: 19.041 })],
        BBOX,
      ),
      null,
    );
  });
});
