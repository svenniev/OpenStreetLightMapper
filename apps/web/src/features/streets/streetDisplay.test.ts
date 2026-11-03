import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStreetLength, highwayLabel, streetHighwayTypes } from "./streetDisplay.js";
import type { StreetWorkItem } from "../../lib/api.js";

function street(highways: string[]): StreetWorkItem {
  return {
    id: "s",
    displayName: "Test",
    partLabel: null,
    name: "Test",
    ref: null,
    wayIds: [1],
    segments: highways.map((highway, index) => ({
      wayId: index + 1,
      highway,
      nodeIds: [1, 2],
      tags: {},
      version: null,
      timestamp: null,
    })),
    geometry: { type: "MultiLineString", coordinates: [] },
    lengthM: 10,
  };
}

describe("streetDisplay", () => {
  it("labels highway values readably and passes unknowns through", () => {
    assert.equal(highwayLabel("living_street"), "Living Street");
    assert.equal(highwayLabel("motorway_link"), "Motorway Link");
    assert.equal(highwayLabel("mystery_kind"), "Mystery Kind");
  });

  it("lists distinct highway types in first-seen order", () => {
    assert.deepEqual(
      streetHighwayTypes(street(["residential", "service", "residential"])),
      ["Residential", "Service"],
    );
  });

  it("formats lengths in metres below 1 km and kilometres above", () => {
    assert.equal(formatStreetLength(42), "42 m in RoI");
    assert.equal(formatStreetLength(999.4), "999 m in RoI");
    assert.equal(formatStreetLength(1500), "1.50 km in RoI");
    assert.equal(formatStreetLength(Number.NaN), "Unknown length");
  });
});
