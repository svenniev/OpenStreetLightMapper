import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RAY_GAP_M,
  MAX_REPROJECTION_PX,
  MIN_LOCATED_VIEWS,
  MIN_PARALLAX_DEG,
} from "@openstreetlightmapper/geo";
import {
  canonicalPlanHash,
  currentAutoThresholds,
  validateAutoCandidate,
  validateAutoImageMetadata,
  validateAutoLaunch,
  validateAutoObservation,
  validateAutoPlanRequest,
  validateAutoPrepare,
  validateAutoViewDescriptor,
} from "./autoValidation.js";
import { resolveAutoPlan } from "../auto/plan.js";
import { StorageValidationError } from "./validation.js";

function planBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "locate",
    snapshotId: "snap-1",
    sequenceIds: ["seq-b", "seq-a", "seq-a"],
    concepts: [{ conceptId: "pole", text: "pole", category: "pole" }],
    maxImages: 100,
    maxCalls: 200,
    ...overrides,
  };
}

function expectRejected(fn: () => unknown, code: string): void {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof StorageValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

function descriptorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    width: 1024,
    height: 768,
    chain: { ops: [{ op: "resize", fromW: 2048, fromH: 1536, toW: 1024, toH: 768 }] },
    camera: { cameraType: "perspective", cameraParameters: [0.8, 0, 0] },
    pose: {
      centerEnu: [1, 2, 3],
      rotationWcAxisAngle: [0, 0, 0],
      positionSource: "computed",
      rotationSource: "computed",
    },
    anchor: { lngLat: [19, 47], altM: 120 },
    source: { imageId: "img-1", geometrySource: "plan" },
    ...overrides,
  };
}

describe("auto validation", () => {
  it("parses plan requests and stabilizes the sequence selection", () => {
    const parsed = validateAutoPlanRequest(planBody());
    assert.equal(parsed.mode, "locate");
    assert.equal(parsed.snapshotId, "snap-1");
    assert.deepEqual(parsed.sequenceIds, ["seq-a", "seq-b"]);
    assert.deepEqual(parsed.concepts, [{ conceptId: "pole", text: "pole", category: "pole" }]);
  });

  it("defaults minSpacingM to 10 m and bounds it", () => {
    assert.equal(validateAutoPlanRequest(planBody()).minSpacingM, 10);
    assert.equal(validateAutoPlanRequest(planBody({ minSpacingM: 0 })).minSpacingM, 0);
    assert.equal(validateAutoPlanRequest(planBody({ minSpacingM: 2.5 })).minSpacingM, 2.5);
    expectRejected(() => validateAutoPlanRequest(planBody({ minSpacingM: -1 })), "AUTO_PLAN_REJECTED");
    expectRejected(() => validateAutoPlanRequest(planBody({ minSpacingM: 1001 })), "AUTO_PLAN_REJECTED");
    expectRejected(() => validateAutoPlanRequest(planBody({ minSpacingM: "10" })), "AUTO_PLAN_REJECTED");
  });

  it("rejects plan requests with bad mode, snapshot, concepts, or bounds", () => {
    expectRejected(() => validateAutoPlanRequest(planBody({ mode: "map" })), "AUTO_PLAN_REJECTED");
    expectRejected(() => validateAutoPlanRequest(planBody({ snapshotId: "has space" })), "STORAGE_BAD_REQUEST");
    expectRejected(() => validateAutoPlanRequest(planBody({ sequenceIds: [] })), "AUTO_PLAN_REJECTED");
    expectRejected(() => validateAutoPlanRequest(planBody({ maxImages: 101 })), "AUTO_PLAN_REJECTED");
    expectRejected(() => validateAutoPlanRequest(planBody({ concepts: [] })), "AUTO_PLAN_REJECTED");
    expectRejected(
      () =>
        validateAutoPlanRequest(
          planBody({
            concepts: [
              { conceptId: "pole", text: "pole", category: "pole" },
              { conceptId: "pole", text: "lamp", category: "luminaire" },
            ],
          }),
        ),
      "AUTO_PLAN_REJECTED",
    );
    expectRejected(() => validateAutoLaunch(planBody()), "STORAGE_BAD_REQUEST");
    const launched = validateAutoLaunch({ ...planBody(), idempotencyKey: "key-1" });
    assert.equal(launched.idempotencyKey, "key-1");
  });

  it("hashes plans canonically and snapshots geo thresholds", () => {
    assert.equal(canonicalPlanHash({ b: 1, a: 2 }), canonicalPlanHash({ a: 2, b: 1 }));
    assert.deepEqual(currentAutoThresholds(), {
      minLocatedViews: MIN_LOCATED_VIEWS,
      minParallaxDeg: MIN_PARALLAX_DEG,
      maxRayGapM: MAX_RAY_GAP_M,
      maxReprojectionPx: MAX_REPROJECTION_PX,
    });
  });

  it("parses full view descriptors and drops unknown source keys", () => {
    const parsed = validateAutoViewDescriptor(
      descriptorBody({ source: { imageId: "img-1", geometrySource: "plan", thumb_1024_url: "https://x/y.jpg" } }),
    );
    assert.equal(parsed.width, 1024);
    assert.ok(parsed.camera);
    assert.equal(parsed.pose?.rotationSource, "computed");
    assert.deepEqual(parsed.source.metadataFields, []);
    assert.equal("thumb_1024_url" in parsed.source, false);
  });

  it("accepts detection-only descriptors with null camera and pose", () => {
    const parsed = validateAutoViewDescriptor(descriptorBody({ camera: null, pose: null }));
    assert.equal(parsed.camera, null);
    assert.equal(parsed.pose, null);
  });

  it("rejects compass rotations, bad cameras, and bad chains", () => {
    expectRejected(
      () =>
        validateAutoViewDescriptor(
          descriptorBody({
            pose: { centerEnu: [0, 0, 0], rotationWcAxisAngle: [0, 0, 0], positionSource: "computed", rotationSource: "compass" },
          }),
        ),
      "STORAGE_BAD_REQUEST",
    );
    expectRejected(
      () => validateAutoViewDescriptor(descriptorBody({ camera: { cameraType: "fisheye" } })),
      "STORAGE_BAD_REQUEST",
    );
    expectRejected(
      () => validateAutoViewDescriptor(descriptorBody({ chain: { ops: [{ op: "warp" }] } })),
      "STORAGE_BAD_REQUEST",
    );
    expectRejected(
      () => validateAutoViewDescriptor(descriptorBody({ source: { imageId: "img-1" } })),
      "STORAGE_BAD_REQUEST",
    );
  });

  it("parses observations with exactly one of ray or rayFailure", () => {
    const base = {
      observationId: "o1",
      box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      confidence: 0.9,
      anchor: { uPx: 1, vPx: 2 },
    };
    const withRay = validateAutoObservation({ ...base, ray: { origin: [0, 0, 0], direction: [0, 0, 1] } });
    assert.ok(withRay.ray);
    const withoutRay = validateAutoObservation({ ...base, rayFailure: "no-orientation" });
    assert.equal(withoutRay.ray, null);
    expectRejected(
      () => validateAutoObservation({ ...base, ray: { origin: [0, 0, 0], direction: [0, 0, 1] }, rayFailure: "x" }),
      "STORAGE_BAD_REQUEST",
    );
    expectRejected(() => validateAutoObservation({ ...base }), "STORAGE_BAD_REQUEST");
    expectRejected(
      () => validateAutoObservation({ ...base, box: { x: 0, y: 0, w: 2, h: 1 }, rayFailure: "x" }),
      "STORAGE_BAD_REQUEST",
    );
  });

  it("parses candidates with consistent views and honest positions", () => {
    const base = {
      candidateId: "ca-1",
      kind: "pole",
      status: "located",
      observationIds: ["o1", "o2", "o3"],
      imageIds: ["img-1", "img-2", "img-3"],
      viewCount: 3,
      position: { lng: 19, lat: 47, uncertaintyM: 2, method: "triangulation-3view" },
    };
    assert.equal(validateAutoCandidate(base).viewCount, 3);
    expectRejected(() => validateAutoCandidate({ ...base, viewCount: 2 }), "STORAGE_BAD_REQUEST");
    expectRejected(() => validateAutoCandidate({ ...base, position: null }), "STORAGE_BAD_REQUEST");
    expectRejected(
      () => validateAutoCandidate({ ...base, status: "candidate" }),
      "STORAGE_BAD_REQUEST",
    );
    expectRejected(() => validateAutoCandidate({ ...base, kind: "tree" }), "STORAGE_BAD_REQUEST");
  });
});

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

describe("auto image metadata", () => {
  it("extracts a coherent eligible record preferring computed values", () => {
    const meta = validateAutoImageMetadata(providerRecord(), "img-1", "seq-a");
    assert.equal(meta.eligible, true);
    assert.equal(meta.ineligibleReason, null);
    assert.deepEqual(meta.computedLngLat, [19.0001, 47.0001]);
    assert.deepEqual(meta.originalLngLat, [19.0, 47.0]);
    assert.equal(meta.computedAltitudeM, 120);
    assert.equal(meta.originalAltitudeM, 110);
    assert.deepEqual(meta.rotationAxisAngle, [0.1, 0.2, 0.3]);
    assert.equal(meta.computedCompassDeg, 91);
    assert.equal(meta.compassDeg, 90);
    assert.equal(meta.mergeCc, 7);
  });

  it("falls back to original values and nulls instead of throwing", () => {
    const meta = validateAutoImageMetadata(
      providerRecord({ computed_geometry: null, computed_altitude: null, computed_compass_angle: null }),
      "img-1",
      "seq-a",
    );
    assert.equal(meta.eligible, true);
    assert.equal(meta.computedLngLat, null);
    assert.deepEqual(meta.originalLngLat, [19.0, 47.0]);
    assert.equal(meta.computedAltitudeM, null);
    assert.equal(meta.originalAltitudeM, 110);
    const garbage = validateAutoImageMetadata({ width: "wide", geometry: [19, 47] }, "img-1", "seq-a");
    assert.equal(garbage.eligible, false);
    assert.equal(garbage.ineligibleReason, "unknown-dimensions");
    const empty = validateAutoImageMetadata(null, "img-1", "seq-a");
    assert.equal(empty.ineligibleReason, "unknown-dimensions");
  });

  it("classifies cameras and missing pose parts with reasons", () => {
    assert.equal(
      validateAutoImageMetadata(providerRecord({ camera_type: "fisheye" }), "img-1", "seq-a").ineligibleReason,
      "fisheye",
    );
    assert.equal(
      validateAutoImageMetadata(providerRecord({ camera_type: "catadioptric" }), "img-1", "seq-a").ineligibleReason,
      "unknown-camera",
    );
    assert.equal(
      validateAutoImageMetadata(providerRecord({ camera_parameters: [99, 0, 0] }), "img-1", "seq-a").ineligibleReason,
      "bad-calibration",
    );
    // Compass alone never qualifies for positioning.
    const compassOnly = validateAutoImageMetadata(
      providerRecord({ computed_rotation: null }),
      "img-1",
      "seq-a",
    );
    assert.equal(compassOnly.eligible, false);
    assert.equal(compassOnly.ineligibleReason, "no-rotation");
    assert.equal(compassOnly.computedCompassDeg, 91);
    assert.equal(
      validateAutoImageMetadata(providerRecord({ geometry: null, computed_geometry: null }), "img-1", "seq-a")
        .ineligibleReason,
      "no-position",
    );
    assert.equal(
      validateAutoImageMetadata(providerRecord({ altitude: null, computed_altitude: null }), "img-1", "seq-a")
        .ineligibleReason,
      "no-altitude",
    );
  });
});

describe("auto prepare payload", () => {
  function resolved() {
    const meta = [
      validateAutoImageMetadata(providerRecord(), "img-a1", "seq-a"),
      validateAutoImageMetadata(providerRecord({ computed_rotation: null }), "img-a2", "seq-a"),
    ];
    return resolveAutoPlan(
      {
        mode: "locate",
        snapshotId: "snap-1",
        streetSnapshotId: null,
        sequenceIds: ["seq-a"],
        concepts: [{ conceptId: "pole", text: "pole", category: "pole" }],
        maxImages: 100,
        maxCalls: 200,
        minSpacingM: 0,
      },
      {
        query: {},
        warnings: [],
        status: "ok",
        everSearched: true,
        seeds: [
          { id: "img-a1", coordinate: [19.0, 47.0], sequenceId: "seq-a" },
          { id: "img-a2", coordinate: [19.002, 47.0], sequenceId: "seq-a" },
        ],
        hydrated: [],
        truncatedCount: 0,
      },
      meta,
      1000,
    );
  }

  it("round-trips a resolved plan with recomputed counts", () => {
    const { plan, planHash } = resolved();
    const parsed = validateAutoPrepare({ plan, planHash });
    assert.equal(parsed.planHash, planHash);
    assert.deepEqual(parsed.counts, {
      totalImages: 2,
      eligibleImages: 1,
      detectionOnlyImages: 1,
      perspectiveImages: 2,
      panoImages: 0,
      fisheyeImages: 0,
      unknownCameraImages: 0,
      missingMetadataImages: 0,
    });
    assert.match(parsed.warnings.join(" "), /detection-only/);
  });

  it("rejects tampered flags, hashes, and shapes", () => {
    const { plan, planHash } = resolved();
    const tamperedFlag = JSON.parse(JSON.stringify(plan)) as typeof plan;
    tamperedFlag.images[1].eligible = true;
    expectRejected(() => validateAutoPrepare({ plan: tamperedFlag, planHash }), "STORAGE_BAD_REQUEST");
    expectRejected(() => validateAutoPrepare({ plan, planHash: "0".repeat(64) }), "STORAGE_BAD_REQUEST");
    expectRejected(() => validateAutoPrepare({ plan: { ...plan, images: [] }, planHash }), "STORAGE_BAD_REQUEST");
    expectRejected(() => validateAutoPrepare({ planHash }), "STORAGE_BAD_REQUEST");
  });
});
