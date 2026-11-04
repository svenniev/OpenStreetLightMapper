import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  axisAngleToMatrix,
  enuToLla,
  projectWorldToPixel,
  type Mat3,
  type Vec3,
} from "@openstreetlightmapper/geo";
import {
  cleanTestDatabase,
  closeTestDatabase,
  connectTestDatabase,
  useIsolatedTestDatabase,
} from "../db/testDb.js";
import { validateAutoImageMetadata } from "../db/autoValidation.js";
import { resolveAutoPlan, type ResolvedAutoPlan } from "./plan.js";
import {
  getAutoJob,
  getAutoResult,
  launchAutoJob,
  listAutoCandidates,
  listAutoItems,
  listAutoObservations,
  requestAutoStop,
} from "./store.js";
import { SamError, type SamObject, type SamRequest, type SamResult } from "../sam.js";
import { runOneAutoJob, type SamPort } from "./worker.js";

// Own database: this file's cleanups must not wipe parallel test files.
useIsolatedTestDatabase("auto_worker");

const ANCHOR_LNGLAT: [number, number] = [19.0, 47.0];
const AXIS_ANGLE: [number, number, number] = [Math.PI / 2, 0, 0];
const CAMERAS: Record<string, Vec3> = {
  "img-1": [0, 0, 2],
  "img-2": [4, 0, 2],
  "img-3": [8, 0, 2],
};
const POLE_BASE: Vec3 = [4, 15, 0];
const VIEW_W = 2048;
const VIEW_H = 1536;
const FOCAL = 0.8;

const maybeRotation = axisAngleToMatrix(AXIS_ANGLE);
if (!maybeRotation) throw new Error("fixture rotation must exist");
const ROTATION: Mat3 = maybeRotation;

function cameraLngLat(imageId: string): [number, number] {
  const [lng, lat] = enuToLla(CAMERAS[imageId][0], CAMERAS[imageId][1], CAMERAS[imageId][2], {
    lngLat: ANCHOR_LNGLAT,
    altM: 0,
  });
  return [lng, lat];
}

function providerRecord(imageId: string): Record<string, unknown> {
  const [lng, lat] = cameraLngLat(imageId);
  return {
    camera_type: "perspective",
    camera_parameters: [FOCAL, 0, 0],
    width: VIEW_W,
    height: VIEW_H,
    exif_orientation: 1,
    geometry: { type: "Point", coordinates: [lng, lat] },
    computed_geometry: { type: "Point", coordinates: [lng, lat] },
    altitude: 2,
    computed_altitude: 2,
    computed_rotation: [...AXIS_ANGLE],
    compass_angle: 0,
    merge_cc: 1,
    captured_at: 1000,
    is_pano: false,
    creator: { username: "tester" },
    thumb_2048_url: `https://scontent.xx.fbcdn.net/${imageId}.jpg`,
  };
}

async function thumbBytes(): Promise<Buffer> {
  return sharp({
    create: { width: VIEW_W, height: VIEW_H, channels: 3, background: { r: 20, g: 30, b: 40 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function mockFetch(thumbs: Map<string, Buffer>): typeof fetch {
  return (async (url: string) => {
    const raw = String(url);
    if (raw.includes("fbcdn.net")) {
      const body = [...thumbs.values()][0];
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    const parsed = new URL(raw);
    if (parsed.pathname === "/images") {
      const ids = (parsed.searchParams.get("image_ids") ?? "").split(",").filter(Boolean);
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id, ...providerRecord(id) })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const imageId = parsed.pathname.slice(1);
    return new Response(JSON.stringify({ id: imageId, ...providerRecord(imageId) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** SAM mock whose boxes land pole anchors exactly on the pole-base projection. */
function mockSamPort(plan: ResolvedAutoPlan, behavior: "ok" | "rate-limit-img-2" | "timeout-img-2" = "ok"): SamPort {
  return {
    isSamConfigured: () => true,
    samModelName: () => "sam-worker-test",
    samTimeoutMs: () => 5000,
    segmentImage: (async (request: SamRequest): Promise<SamResult> => {
      if (behavior === "rate-limit-img-2" && request.imageId === "img-2") {
        throw new SamError("SAM_RATE_LIMITED", "Model rate limited.", { retryable: true, retryAfterSec: 0 });
      }
      if (behavior === "timeout-img-2" && request.imageId === "img-2") {
        throw new SamError("SAM_TIMEOUT", "Model call timed out.", { retryable: true });
      }
      const center = CAMERAS[request.imageId];
      const projected = projectWorldToPixel(POLE_BASE, { centerEnu: center, rotationWc: ROTATION }, {
        kind: "perspective",
        width: request.width,
        height: request.height,
        focal: FOCAL,
        k1: 0,
        k2: 0,
      });
      assert.equal(projected.ok, true);
      if (!projected.ok) throw new Error("fixture projection failed");
      // Invert the pole ground-contact margin so the anchor lands exactly.
      const focalPx = FOCAL * Math.max(request.width, request.height);
      const marginPx = ((3 * Math.PI) / 180) * focalPx;
      const boxW = 0.05;
      const boxH = 0.2;
      const bottomY = (projected.py - marginPx) / request.height;
      const boxNorm = { x: projected.px / request.width - boxW / 2, y: bottomY - boxH, w: boxW, h: boxH };
      const objects: SamObject[] = [
        {
          providerObjectId: `${request.imageId}-pole-1`,
          box: {
            left: Math.round(boxNorm.x * request.width),
            top: Math.round(boxNorm.y * request.height),
            right: Math.round((boxNorm.x + boxNorm.w) * request.width),
            bottom: Math.round((boxNorm.y + boxNorm.h) * request.height),
          },
          boxNorm,
          confidence: 0.95,
          mask: null,
        },
      ];
      void plan;
      return {
        requestId: request.requestId,
        viewId: request.viewId,
        model: "sam-worker-test",
        prompt: request.concept,
        categoryIntent: request.categoryIntent,
        inputWidth: request.width,
        inputHeight: request.height,
        objects,
        truncated: false,
        retrievedAt: new Date(0).toISOString(),
      };
    }) as SamPort["segmentImage"],
  };
}

async function launchTestJob(key: string): Promise<{ plan: ResolvedAutoPlan; planHash: string; jobId: string }> {
  const seeds = ["img-1", "img-2", "img-3"].map((id) => {
    const [lng, lat] = cameraLngLat(id);
    return {
      id,
      coordinate: [lng, lat],
      coordinateSource: "geometry",
      originalCoordinate: null,
      computedCoordinate: null,
      capturedAt: null,
      isPano: false,
      sequenceId: "seq-a",
    };
  });
  const metadata = ["img-1", "img-2", "img-3"].map((id) =>
    validateAutoImageMetadata(providerRecord(id), id, "seq-a"),
  );
  const { plan, planHash } = resolveAutoPlan(
    {
      mode: "locate",
      snapshotId: "snap-1",
      streetSnapshotId: null,
      sequenceIds: ["seq-a"],
      concepts: [{ conceptId: "pole", text: "street light pole", category: "pole" }],
      maxImages: 100,
      maxCalls: 200,
      minSpacingM: 0,
    },
    { query: {}, warnings: [], status: "ok", everSearched: true, seeds, hydrated: [], truncatedCount: 0 },
    metadata,
  );
  const launched = await launchAutoJob({
    workspaceId: "ws-worker",
    jobId: `aj-worker-${key}`,
    idempotencyKey: `key-worker-${key}`,
    plan,
    planHash,
  });
  return { plan, planHash, jobId: launched.job.jobId };
}

describe("auto worker", () => {
  before(connectTestDatabase);
  beforeEach(cleanTestDatabase);
  after(closeTestDatabase);

  it("runs a full job from claim to located result", async () => {
    const { plan, jobId } = await launchTestJob("e2e");
    const thumbs = new Map([
      ["img-1", await thumbBytes()],
      ["img-2", await thumbBytes()],
      ["img-3", await thumbBytes()],
    ]);
    const events: Array<{ type: string }> = [];
    const outcome = await runOneAutoJob({
      workerId: "worker-e2e",
      fetchImpl: mockFetch(thumbs),
      sam: mockSamPort(plan),
      token: "test-token",
      apiKey: "test-key",
      events: (event) => events.push(event),
    });
    assert.deepEqual(outcome, { jobId, status: "completed" });
    assert.ok(events.some((event) => event.type === "job-claimed"));

    const job = await getAutoJob("ws-worker", jobId);
    assert.equal(job?.model, "sam-worker-test");
    assert.ok(job?.resultId);
    const result = await getAutoResult("ws-worker", jobId);
    assert.equal(result?.status, "inventory-complete");
    assert.equal(result?.counts.totalItems, 3);
    assert.equal(result?.counts.doneItems, 3);
    assert.equal(result?.counts.observations, 3);
    assert.equal(result?.counts.located, 1);
    assert.equal(result?.counts.callsMade, 3);
    const candidates = await listAutoCandidates("ws-worker", jobId);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "located");
    assert.ok(candidates[0].position);
    // POLE_BASE is absolute ENU about ANCHOR_LNGLAT; plan.anchor is the
    // mean-seed job frame, so the expectation must use the original anchor.
    const [expectedLng, expectedLat] = enuToLla(POLE_BASE[0], POLE_BASE[1], POLE_BASE[2], {
      lngLat: ANCHOR_LNGLAT,
      altM: 0,
    });
    assert.ok(Math.abs(candidates[0].position.lng - expectedLng) < 1e-6);
    assert.ok(Math.abs(candidates[0].position.lat - expectedLat) < 1e-6);
    const observations = await listAutoObservations("ws-worker", jobId, { limit: 10 });
    assert.equal(observations.length, 3);
    assert.ok(observations.every((observation) => observation.ray));
    const items = await listAutoItems("ws-worker", jobId, { limit: 10 });
    assert.ok(items.every((item) => item.status === "succeeded" && item.artifactId));
  });

  it("completes with gaps when one item is rate limited", async () => {
    const { plan, jobId } = await launchTestJob("ratelimit");
    const thumbs = new Map([["img-1", await thumbBytes()]]);
    const outcome = await runOneAutoJob({
      workerId: "worker-rl",
      fetchImpl: mockFetch(thumbs),
      sam: mockSamPort(plan, "rate-limit-img-2"),
      token: "test-token",
      apiKey: "test-key",
    });
    assert.deepEqual(outcome, { jobId, status: "completed_with_gaps" });
    const result = await getAutoResult("ws-worker", jobId);
    assert.equal(result?.counts.failedItems, 1);
    assert.equal(result?.counts.doneItems, 2);
    // Two views cannot locate: the pair stays an unresolved hypothesis.
    assert.equal(result?.counts.located, 0);
    const candidates = await listAutoCandidates("ws-worker", jobId);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "needs-review");
  });

  it("parks ambiguous timeouts as unknown instead of reissuing them", async () => {
    const { plan, jobId } = await launchTestJob("timeout");
    const thumbs = new Map([["img-1", await thumbBytes()]]);
    const outcome = await runOneAutoJob({
      workerId: "worker-to",
      fetchImpl: mockFetch(thumbs),
      sam: mockSamPort(plan, "timeout-img-2"),
      token: "test-token",
      apiKey: "test-key",
    });
    assert.deepEqual(outcome, { jobId, status: "completed_with_gaps" });
    const items = await listAutoItems("ws-worker", jobId, { limit: 10 });
    const timedOut = items.find((item) => item.imageId === "img-2");
    assert.equal(timedOut?.status, "interrupted");
    assert.match(timedOut?.error ?? "", /Outcome unknown/);
  });

  it("fails fast without SAM configuration or a Mapillary token", async () => {
    const { jobId } = await launchTestJob("nosam");
    const thumbs = new Map([["img-1", await thumbBytes()]]);
    const unconfiguredSam: SamPort = {
      ...mockSamPort({} as ResolvedAutoPlan),
      isSamConfigured: () => false,
    };
    const noSam = await runOneAutoJob({
      workerId: "worker-nosam",
      fetchImpl: mockFetch(thumbs),
      sam: unconfiguredSam,
      token: "test-token",
      apiKey: "test-key",
    });
    assert.deepEqual(noSam, { jobId, status: "failed" });
    const job = await getAutoJob("ws-worker", jobId);
    assert.match(job?.error ?? "", /MODEL_API_KEY/);

    const { jobId: jobId2 } = await launchTestJob("notoken");
    const noToken = await runOneAutoJob({
      workerId: "worker-notoken",
      fetchImpl: mockFetch(thumbs),
      sam: mockSamPort({} as ResolvedAutoPlan),
      token: "",
      apiKey: "test-key",
    });
    assert.deepEqual(noToken, { jobId: jobId2, status: "failed" });
  });

  it("leaves stopped jobs for explicit resume instead of claiming them", async () => {
    const { jobId } = await launchTestJob("stopped");
    await requestAutoStop({ workspaceId: "ws-worker", jobId });
    const thumbs = new Map([["img-1", await thumbBytes()]]);
    const outcome = await runOneAutoJob({
      workerId: "worker-stop",
      fetchImpl: mockFetch(thumbs),
      sam: mockSamPort({} as ResolvedAutoPlan),
      token: "test-token",
      apiKey: "test-key",
    });
    assert.equal(outcome, null);
    const job = await getAutoJob("ws-worker", jobId);
    assert.equal(job?.status, "stopped");
  });
});
