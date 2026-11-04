import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAutoPlan } from "./plan.js";
import {
  validateAutoImageMetadata,
  type ValidatedAutoPlanRequest,
  type ValidatedPlanImageMeta,
} from "../db/autoValidation.js";
import { StorageValidationError } from "../db/validation.js";

function seed(
  id: string,
  sequenceId: string | null,
  lng: number,
  lat: number,
  inRoi?: boolean,
) {
  return {
    id,
    coordinate: [lng, lat],
    coordinateSource: "geometry",
    originalCoordinate: null,
    computedCoordinate: null,
    capturedAt: null,
    isPano: false,
    sequenceId,
    ...(inRoi === undefined ? {} : { inRoi }),
  };
}

/** Metres east at 47N as longitude degrees (dense-sequence fixtures). */
function eastM(metres: number): number {
  return 19 + metres / 75835;
}

function payload() {
  return {
    query: {},
    warnings: [],
    status: "ok",
    everSearched: true,
    seeds: [seed("img-a1", "seq-a", 19.0, 47.0), seed("img-a2", "seq-a", 19.002, 47.0)],
    hydrated: [seed("img-b1", "seq-b", 19.004, 47.002)],
    truncatedCount: 0,
  };
}

function request(overrides: Partial<ValidatedAutoPlanRequest> = {}): ValidatedAutoPlanRequest {
  return {
    mode: "locate",
    snapshotId: "snap-1",
    streetSnapshotId: null,
    sequenceIds: ["seq-a", "seq-b"],
    concepts: [{ conceptId: "pole", text: "pole", category: "pole" }],
    maxImages: 100,
    maxCalls: 200,
    minSpacingM: 10,
    ...overrides,
  };
}

function providerRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    camera_type: "perspective",
    camera_parameters: [0.8, 0, 0],
    width: 4000,
    height: 3000,
    exif_orientation: 1,
    geometry: { type: "Point", coordinates: [19.0, 47.0] },
    computed_geometry: { type: "Point", coordinates: [19.0001, 47.0001] },
    altitude: 110,
    computed_altitude: 120,
    computed_rotation: [0.1, 0.2, 0.3],
    compass_angle: 90,
    computed_compass_angle: 91,
    merge_cc: 7,
    atomic_scale: 1,
    captured_at: 1700000000000,
    is_pano: false,
    ...overrides,
  };
}

function metadata(ids: Array<{ imageId: string; sequenceId: string }>): ValidatedPlanImageMeta[] {
  return ids.map((entry) => validateAutoImageMetadata(providerRecord(), entry.imageId, entry.sequenceId));
}

describe("resolveAutoPlan", () => {
  it("resolves images in snapshot order with per-sequence counts", () => {
    const meta = metadata([
      { imageId: "img-a1", sequenceId: "seq-a" },
      { imageId: "img-a2", sequenceId: "seq-a" },
      { imageId: "img-b1", sequenceId: "seq-b" },
    ]);
    const { plan } = resolveAutoPlan(request(), payload(), meta, 1000);
    assert.deepEqual(plan.imageIds, ["img-a1", "img-a2", "img-b1"]);
    assert.deepEqual(plan.perSequence, [
      { sequenceId: "seq-a", imageIds: ["img-a1", "img-a2"] },
      { sequenceId: "seq-b", imageIds: ["img-b1"] },
    ]);
    assert.equal(plan.totalImages, 3);
    assert.equal(plan.estimatedCalls, 3);
    assert.equal(plan.plannedAt, 1000);
    assert.equal(plan.droppedSeeds, 0);
    assert.deepEqual(plan.counts, {
      totalImages: 3,
      eligibleImages: 3,
      detectionOnlyImages: 0,
      perspectiveImages: 3,
      panoImages: 0,
      fisheyeImages: 0,
      unknownCameraImages: 0,
      missingMetadataImages: 0,
    });
    assert.equal(plan.recipe.version, 1);
  });

  it("centroids the anchor over selected images with altM 0", () => {
    const meta = metadata([{ imageId: "img-a1", sequenceId: "seq-a" }]);
    const { plan } = resolveAutoPlan(request({ sequenceIds: ["seq-a"] }), payload(), meta);
    assert.ok(Math.abs(plan.anchor.lngLat[0] - 19.001) < 1e-9);
    assert.ok(Math.abs(plan.anchor.lngLat[1] - 47.0) < 1e-9);
    assert.equal(plan.anchor.altM, 0);
  });

  it("dedupes overlapping seed/hydrated ids and counts malformed seeds", () => {
    const broken = payload();
    broken.hydrated.push(seed("img-a1", "seq-a", 19.0, 47.0));
    (broken.seeds as unknown[]).push({ id: "bad", coordinate: [Number.NaN, 0], sequenceId: "seq-a" });
    const meta = metadata([
      { imageId: "img-a1", sequenceId: "seq-a" },
      { imageId: "img-a2", sequenceId: "seq-a" },
    ]);
    const resolved = resolveAutoPlan(request({ sequenceIds: ["seq-a"] }), broken, meta);
    assert.deepEqual(resolved.plan.imageIds, ["img-a1", "img-a2"]);
    assert.equal(resolved.plan.droppedSeeds, 1);
    assert.match(resolved.plan.warnings.join(" "), /malformed seed/);
  });

  it("marks images without metadata as unavailable with a warning", () => {
    const { plan } = resolveAutoPlan(request({ mode: "detect" }), payload(), []);
    assert.equal(plan.counts.missingMetadataImages, 3);
    assert.equal(plan.counts.eligibleImages, 0);
    assert.match(plan.warnings.join(" "), /no provider metadata/);
    assert.equal(plan.images[0].ineligibleReason, "metadata-unavailable");
  });

  it("rejects empty selections, image overruns, and call overruns", () => {
    assert.throws(() => resolveAutoPlan(request({ sequenceIds: ["seq-zzz"] }), payload(), []), (error) => {
      assert.ok(error instanceof StorageValidationError);
      assert.equal(error.code, "AUTO_PLAN_REJECTED");
      return true;
    });
    assert.throws(() => resolveAutoPlan(request({ maxImages: 2 }), payload(), []), /over the maxImages bound/);
    assert.throws(() => resolveAutoPlan(request({ maxCalls: 2 }), payload(), []), /over the maxCalls bound/);
  });

  it("refuses locate launches without usable geometry but allows detection", () => {
    assert.throws(() => resolveAutoPlan(request({ mode: "locate" }), payload(), []), (error) => {
      assert.ok(error instanceof StorageValidationError);
      assert.equal(error.code, "AUTO_PLAN_REJECTED");
      assert.equal(error.message, "No usable geometry: detections can run, map placement unavailable.");
      return true;
    });
    const { plan } = resolveAutoPlan(request({ mode: "detect" }), payload(), []);
    assert.equal(plan.mode, "detect");
    assert.equal(plan.counts.eligibleImages, 0);
  });

  it("hashes stably across concept reorderings and timestamps", () => {
    const concepts = [
      { conceptId: "pole", text: "pole", category: "pole" as const },
      { conceptId: "lamp", text: "lamp", category: "luminaire" as const },
    ];
    const meta = metadata([
      { imageId: "img-a1", sequenceId: "seq-a" },
      { imageId: "img-a2", sequenceId: "seq-a" },
      { imageId: "img-b1", sequenceId: "seq-b" },
    ]);
    const first = resolveAutoPlan(request({ concepts }), payload(), meta, 1000);
    const second = resolveAutoPlan(request({ concepts: [...concepts].reverse() }), payload(), meta, 2000);
    assert.equal(first.planHash, second.planHash);
    assert.notEqual(first.plan.plannedAt, second.plan.plannedAt);
    const changed = resolveAutoPlan(request({ sequenceIds: ["seq-a"], concepts }), payload(), meta, 1000);
    assert.notEqual(changed.planHash, first.planHash);
  });

  it("throws a plain error for corrupt snapshot payloads and duplicate metadata", () => {
    assert.throws(() => resolveAutoPlan(request(), { seeds: [] }, []), /corrupt/);
    assert.throws(() => resolveAutoPlan(request(), null, []), /corrupt/);
    const dup = metadata([{ imageId: "img-a1", sequenceId: "seq-a" }]);
    assert.throws(() => resolveAutoPlan(request(), payload(), [...dup, ...dup]), /Duplicate image metadata/);
  });

  it("excludes outside-RoI seeds and reports the count", () => {
    const body = payload();
    body.seeds = [
      seed("img-a1", "seq-a", 19.0, 47.0, true),
      seed("img-a2", "seq-a", 19.002, 47.0, false),
      seed("img-a3", "seq-a", 19.004, 47.0, false),
    ];
    body.hydrated = [];
    const { plan } = resolveAutoPlan(
      request({ sequenceIds: ["seq-a"], minSpacingM: 0 }),
      body,
      metadata([{ imageId: "img-a1", sequenceId: "seq-a" }]),
    );
    assert.deepEqual(plan.imageIds, ["img-a1"]);
    assert.equal(plan.excludedOutsideRoi, 2);
    assert.match(plan.warnings.join(" "), /2 outside-RoI images excluded/);
  });

  it("includes legacy seeds without RoI flags with a warning", () => {
    const { plan } = resolveAutoPlan(request({ mode: "detect" }), payload(), []);
    assert.deepEqual(plan.imageIds, ["img-a1", "img-a2", "img-b1"]);
    assert.equal(plan.excludedOutsideRoi, 0);
    assert.match(plan.warnings.join(" "), /3 images without RoI flags were included/);
  });

  it("thins dense sequences greedily by minSpacingM in snapshot order", () => {
    const body = payload();
    body.seeds = [
      seed("img-c0", "seq-c", eastM(0), 47.0, true),
      seed("img-c5", "seq-c", eastM(5), 47.0, true),
      seed("img-c12", "seq-c", eastM(12), 47.0, true),
      seed("img-c17", "seq-c", eastM(17), 47.0, true),
    ];
    body.hydrated = [];
    const { plan } = resolveAutoPlan(
      request({ sequenceIds: ["seq-c"], mode: "detect", minSpacingM: 10 }),
      body,
      [],
    );
    assert.deepEqual(plan.imageIds, ["img-c0", "img-c12"]);
    assert.equal(plan.thinnedBySpacing, 2);
    assert.match(plan.warnings.join(" "), /2 images within 10 m of an included image/);
  });

  it("disables spacing thinning at minSpacingM 0", () => {
    const body = payload();
    body.seeds = [
      seed("img-c0", "seq-c", eastM(0), 47.0, true),
      seed("img-c5", "seq-c", eastM(5), 47.0, true),
    ];
    body.hydrated = [];
    const { plan } = resolveAutoPlan(
      request({ sequenceIds: ["seq-c"], mode: "detect", minSpacingM: 0 }),
      body,
      [],
    );
    assert.deepEqual(plan.imageIds, ["img-c0", "img-c5"]);
    assert.equal(plan.thinnedBySpacing, 0);
  });

  it("rejects selections left empty by RoI filtering", () => {
    const body = payload();
    body.seeds = [seed("img-a1", "seq-a", 19.0, 47.0, false)];
    body.hydrated = [];
    assert.throws(() => resolveAutoPlan(request({ sequenceIds: ["seq-a"] }), body, []), (error) => {
      assert.ok(error instanceof StorageValidationError);
      assert.equal(error.code, "AUTO_PLAN_REJECTED");
      assert.match(error.message, /no in-RoI images/);
      return true;
    });
  });
});
