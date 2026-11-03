import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StreetWorkItem } from "../../lib/api.js";
import {
  buildStreetPlanItem,
  computeInputFingerprint,
  deepFreeze,
  hashPoolIds,
  validateStreetForPlan,
} from "./preparationPlan.js";

function street(overrides: Partial<StreetWorkItem> = {}): StreetWorkItem {
  return {
    id: "s1",
    displayName: "Main Street",
    partLabel: null,
    name: "Main Street",
    ref: null,
    wayIds: [101, 102],
    segments: [],
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [
          [19.0, 47.5],
          [19.001, 47.501],
        ],
      ],
    },
    lengthM: 141.2,
    ...overrides,
  };
}

function parts() {
  return {
    roiRevision: 3,
    streetSnapshotId: 1,
    checkedIds: ["b", "a"],
    imagerySnapshotId: 2,
    poolHash: hashPoolIds(["img2", "img1"]),
    discoveryWarnings: ["POSSIBLY_TRUNCATED"],
    streetWarnings: [],
  };
}

describe("computeInputFingerprint", () => {
  it("is stable and order-independent", () => {
    const a = computeInputFingerprint(parts());
    const b = computeInputFingerprint({
      ...parts(),
      checkedIds: ["a", "b"],
      discoveryWarnings: ["POSSIBLY_TRUNCATED"],
    });
    assert.strictEqual(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
  });

  it("changes when any input part changes", () => {
    const base = computeInputFingerprint(parts());
    assert.notStrictEqual(computeInputFingerprint({ ...parts(), roiRevision: 4 }), base);
    assert.notStrictEqual(computeInputFingerprint({ ...parts(), streetSnapshotId: 2 }), base);
    assert.notStrictEqual(computeInputFingerprint({ ...parts(), checkedIds: ["a"] }), base);
    assert.notStrictEqual(computeInputFingerprint({ ...parts(), imagerySnapshotId: 3 }), base);
    assert.notStrictEqual(
      computeInputFingerprint({ ...parts(), poolHash: hashPoolIds(["img1"]) }),
      base,
    );
    assert.notStrictEqual(
      computeInputFingerprint({ ...parts(), discoveryWarnings: [] }),
      base,
    );
    assert.notStrictEqual(
      computeInputFingerprint({ ...parts(), streetWarnings: ["OVERPASS_TIMEOUT"] }),
      base,
    );
  });
});

describe("validateStreetForPlan", () => {
  it("accepts a well-formed street", () => {
    assert.strictEqual(validateStreetForPlan(street()), null);
  });

  it("rejects streets without identity, ways, geometry, or length", () => {
    assert.strictEqual(validateStreetForPlan(street({ id: "" })), "missing street ID");
    assert.strictEqual(validateStreetForPlan(street({ wayIds: [] })), "no source OSM ways");
    assert.strictEqual(
      validateStreetForPlan(
        street({ geometry: { type: "MultiLineString", coordinates: [] } }),
      ),
      "missing or invalid clipped geometry",
    );
    assert.strictEqual(
      validateStreetForPlan(
        street({
          geometry: {
            type: "MultiLineString",
            coordinates: [[[19.0, Number.NaN]]],
          },
        }),
      ),
      "missing or invalid clipped geometry",
    );
    assert.strictEqual(validateStreetForPlan(street({ lengthM: Number.NaN })), "invalid in-region length");
    assert.strictEqual(validateStreetForPlan(street({ lengthM: -1 })), "invalid in-region length");
  });
});

describe("buildStreetPlanItem", () => {
  it("references the street with pending image association", () => {
    assert.deepStrictEqual(buildStreetPlanItem(street()), {
      streetId: "s1",
      displayName: "Main Street",
      wayIds: [101, 102],
      lengthM: 141.2,
      imageAssociation: "pending",
    });
  });
});

describe("deepFreeze", () => {
  it("freezes nested snapshot data", () => {
    const plan = deepFreeze({ items: [{ id: "s1" }], pool: { ids: ["i1"] } });
    assert.strictEqual(Object.isFrozen(plan), true);
    assert.strictEqual(Object.isFrozen(plan.items), true);
    assert.strictEqual(Object.isFrozen(plan.items[0]), true);
    assert.strictEqual(Object.isFrozen(plan.pool.ids), true);
  });
});
