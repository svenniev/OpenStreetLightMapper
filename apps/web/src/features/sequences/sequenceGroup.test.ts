import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  groupMatchesFilter,
  groupSeedRecords,
  imageMatchesFilter,
  pickRepresentative,
  shortSequenceId,
} from "./sequenceGroup.js";
import type { ImageResult } from "../../lib/searchTypes.js";

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

describe("groupSeedRecords", () => {
  it("groups by sequence ID and keeps ungrouped images separate", () => {
    const grouped = groupSeedRecords([
      image({ id: "a1", sequenceId: "seq-a", capturedAt: 100 }),
      image({ id: "solo" }),
      image({ id: "a2", sequenceId: "seq-a", capturedAt: 200 }),
      image({ id: "blank", sequenceId: "" }),
    ]);
    assert.equal(grouped.sequences.length, 1);
    assert.equal(grouped.sequences[0].sequenceId, "seq-a");
    assert.deepEqual(
      grouped.sequences[0].seeds.map((seed) => seed.id),
      ["a2", "a1"],
    );
    assert.deepEqual(
      grouped.ungrouped.map((item) => item.id),
      ["blank", "solo"],
    );
  });

  it("computes badges over the pano matrix", () => {
    const pano = groupSeedRecords([image({ id: "p", sequenceId: "s", isPano: true })]);
    assert.equal(pano.sequences[0].badge, "Panorama");
    const standard = groupSeedRecords([image({ id: "s1", sequenceId: "s", isPano: false })]);
    assert.equal(standard.sequences[0].badge, "Standard");
    const unknown = groupSeedRecords([image({ id: "u", sequenceId: "s" })]);
    assert.equal(unknown.sequences[0].badge, "Unknown");
    const mixed = groupSeedRecords([
      image({ id: "p", sequenceId: "s", isPano: true }),
      image({ id: "f", sequenceId: "s", isPano: false }),
    ]);
    assert.equal(mixed.sequences[0].badge, "Mixed");
  });

  it("orders pano-containing first, then most recent, then stable ID", () => {
    const grouped = groupSeedRecords([
      image({ id: "old-pano", sequenceId: "seq-old", isPano: true, capturedAt: 100 }),
      image({ id: "new-flat", sequenceId: "seq-new", isPano: false, capturedAt: 9999 }),
      image({ id: "b-flat", sequenceId: "seq-b", isPano: false, capturedAt: 50 }),
      image({ id: "a-flat", sequenceId: "seq-a", isPano: false, capturedAt: 50 }),
    ]);
    assert.deepEqual(
      grouped.sequences.map((group) => group.sequenceId),
      ["seq-old", "seq-new", "seq-a", "seq-b"],
    );
  });

  it("shortens long sequence IDs while keeping short ones intact", () => {
    assert.equal(shortSequenceId("abc"), "abc");
    assert.equal(shortSequenceId("123456789012"), "123456789012");
    assert.equal(shortSequenceId("12345678901234567890"), "1234567890…");
  });
});

describe("filters", () => {
  const panoGroup = groupSeedRecords([image({ id: "p", sequenceId: "s", isPano: true })]).sequences[0];
  const standardGroup = groupSeedRecords([image({ id: "s1", sequenceId: "s", isPano: false })]).sequences[0];
  const unknownGroup = groupSeedRecords([image({ id: "u", sequenceId: "s" })]).sequences[0];

  it("matches groups by pano presence, standard purity, and unknown presence", () => {
    assert.equal(groupMatchesFilter(panoGroup, "panoramas"), true);
    assert.equal(groupMatchesFilter(standardGroup, "panoramas"), false);
    assert.equal(groupMatchesFilter(standardGroup, "standard"), true);
    assert.equal(groupMatchesFilter(panoGroup, "standard"), false);
    assert.equal(groupMatchesFilter(unknownGroup, "standard"), false);
    assert.equal(groupMatchesFilter(unknownGroup, "unknown"), true);
    assert.equal(groupMatchesFilter(panoGroup, "unknown"), false);
    assert.equal(groupMatchesFilter(panoGroup, "all"), true);
  });

  it("matches individual images for the ungrouped rows", () => {
    const pano = image({ id: "p", isPano: true });
    assert.equal(imageMatchesFilter(pano, "panoramas"), true);
    assert.equal(imageMatchesFilter(pano, "standard"), false);
    assert.equal(imageMatchesFilter(image({ id: "u" }), "unknown"), true);
    assert.equal(imageMatchesFilter(image({ id: "f", isPano: false }), "standard"), true);
  });
});

describe("pickRepresentative", () => {
  it("prefers panoramas, then earliest capture, then stable ID", () => {
    const rep = pickRepresentative([
      image({ id: "flat-early", isPano: false, capturedAt: 100 }),
      image({ id: "pano-late", isPano: true, capturedAt: 900 }),
      image({ id: "flat-late", isPano: false, capturedAt: 800 }),
    ]);
    assert.equal(rep?.id, "pano-late");
    const earliest = pickRepresentative([
      image({ id: "b", isPano: false, capturedAt: 500 }),
      image({ id: "a", isPano: false, capturedAt: 200 }),
    ]);
    assert.equal(earliest?.id, "a");
  });

  it("skips outside-RoI candidates and returns null when none qualify", () => {
    const rep = pickRepresentative([
      image({ id: "out", isPano: true, inRoi: false }),
      image({ id: "in", isPano: false }),
    ]);
    assert.equal(rep?.id, "in");
    assert.equal(pickRepresentative([image({ id: "out", inRoi: false })]), null);
    assert.equal(pickRepresentative([]), null);
  });
});
