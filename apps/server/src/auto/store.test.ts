import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  cleanTestDatabase,
  closeTestDatabase,
  connectTestDatabase,
  useIsolatedTestDatabase,
} from "../db/testDb.js";
import { StorageValidationError } from "../db/validation.js";
import {
  validateAutoCandidate,
  validateAutoObservation,
  validateAutoViewDescriptor,
  type ValidatedAutoCandidate,
  type ValidatedAutoObservation,
} from "../db/autoValidation.js";
import { AutoJobModel, AutoWorkItemModel } from "../db/autoModels.js";
import { resolveAutoPlan, type ResolvedAutoPlan } from "./plan.js";
import {
  advanceAutoJobPhase,
  claimAutoItem,
  claimAutoJob,
  completeAutoItem,
  failAutoItem,
  finalizeAutoJob,
  getAutoItem,
  getAutoJob,
  getAutoJobProgress,
  heartbeatAutoJob,
  launchAutoJob,
  listAutoItems,
  markAutoItemCallSent,
  markAutoItemUnknown,
  publishAutoResult,
  releaseAutoItem,
  replaceAutoCandidates,
  requestAutoStop,
  reserveAutoJobCall,
  resumeAutoJob,
  retryAutoItem,
  setAutoItemPrepared,
  setAutoJobModel,
  setAutoJobResult,
  sweepAutoJobItems,
  sweepInterruptedJobs,
  writeAutoObservations,
  type AutoResultInput,
} from "./store.js";

// Own database: this file's cleanups must not wipe parallel test files.
useIsolatedTestDatabase("auto_store");

function seed(id: string, sequenceId: string, lng: number, lat: number) {
  return {
    id,
    coordinate: [lng, lat],
    coordinateSource: "geometry",
    originalCoordinate: null,
    computedCoordinate: null,
    capturedAt: null,
    isPano: false,
    sequenceId,
  };
}

function testPlan(): { plan: ResolvedAutoPlan; planHash: string } {
  const payload = {
    query: {},
    warnings: [],
    status: "ok",
    everSearched: true,
    seeds: [seed("img-a1", "seq-a", 19.0, 47.0), seed("img-a2", "seq-a", 19.002, 47.0)],
    hydrated: [seed("img-b1", "seq-b", 19.004, 47.002)],
    truncatedCount: 0,
  };
  return resolveAutoPlan(
    {
      mode: "detect",
      snapshotId: "snap-1",
      streetSnapshotId: null,
      sequenceIds: ["seq-a", "seq-b"],
      concepts: [
        { conceptId: "pole", text: "pole", category: "pole" },
        { conceptId: "lamp", text: "lamp", category: "luminaire" },
      ],
      maxImages: 100,
      maxCalls: 200,
      minSpacingM: 0,
    },
    payload,
    [],
    1000,
  );
}

let jobCounter = 0;

async function launchJob(overrides: { workspaceId?: string; key?: string } = {}) {
  jobCounter += 1;
  const { plan, planHash } = testPlan();
  return launchAutoJob({
    workspaceId: overrides.workspaceId ?? "ws-auto",
    jobId: `aj-test-${jobCounter}`,
    idempotencyKey: overrides.key ?? `key-${jobCounter}`,
    plan,
    planHash,
  });
}

function observationFixture(observationId: string): ValidatedAutoObservation {
  return validateAutoObservation({
    observationId,
    box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    confidence: 0.9,
    anchor: { uPx: 100, vPx: 200, marginPx: 8, clamped: false },
    maskSupport: null,
    ray: { origin: [0, 0, 0], direction: [0, 0, 1] },
    rayFailure: null,
    nearSeam: false,
    truncated: false,
  });
}

function candidateFixture(overrides: Record<string, unknown> = {}): ValidatedAutoCandidate {
  return validateAutoCandidate({
    candidateId: "ca-pole-1",
    kind: "pole",
    status: "located",
    observationIds: ["img-a1--v0--pole--a0--o0"],
    imageIds: ["img-a1", "img-a2", "img-b1"],
    viewCount: 3,
    position: { lng: 19.001, lat: 47.0, uncertaintyM: 1.5, method: "triangulation-3view" },
    fit: { reprojectionPx: 1.2 },
    poleCandidateId: null,
    luminaireCandidateIds: [],
    checks: ["parallax-ok"],
    ...overrides,
  });
}

function viewDescriptorFixture(imageId = "img-a1") {
  return validateAutoViewDescriptor({
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
    source: {
      imageId,
      thumbKind: "thumb_2048_url",
      geometrySource: "plan",
      originalWidth: 2048,
      originalHeight: 1536,
      providerExifOrientation: 1,
      observedExifOrientation: 1,
      originalLngLat: [19, 47],
      computedLngLat: [19.0001, 47.0001],
      compassDeg: 90,
      altitudeM: 120,
      mergeCc: 7,
      atomicScale: 1,
      metadataFields: ["camera_type", "computed_rotation"],
      prepWarnings: [],
    },
  });
}

function resultFixture(planHash: string): AutoResultInput {
  return {
    status: "inventory-complete",
    counts: { located: 1, needsReview: 0, unlocated: 0 },
    locatedCandidateIds: ["ca-pole-1"],
    needsReviewCandidateIds: [],
    unlocatedObservationIds: [],
    unlocatedReasons: {},
    thresholds: { minLocatedViews: 3 },
    model: "sam-test",
    planHash,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof StorageValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

async function backdateJobLease(jobId: string): Promise<void> {
  await AutoJobModel().updateOne(
    { workspaceId: "ws-auto", jobId },
    { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } },
  );
}

async function backdateItemLease(jobId: string, itemId: string): Promise<void> {
  await AutoWorkItemModel().updateOne(
    { workspaceId: "ws-auto", jobId, itemId },
    { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } },
  );
}

describe("auto store", () => {
  before(connectTestDatabase);
  beforeEach(cleanTestDatabase);
  after(closeTestDatabase);

  it("launches a queued job with one item per image-view-concept", async () => {
    const { job, deduplicated } = await launchJob();
    assert.equal(deduplicated, false);
    assert.equal(job.status, "queued");
    const items = await listAutoItems("ws-auto", job.jobId, { limit: 500 });
    assert.equal(items.length, 6);
    const first = items.find((item) => item.itemId === "img-a1--v0--pole");
    assert.ok(first);
    assert.equal(first.sequenceId, "seq-a");
    assert.equal(first.prompt, "pole");
    assert.equal(first.category, "pole");
    assert.equal(first.status, "queued");
    assert.equal(first.attempts, 0);
    assert.equal(first.callSent, false);
    assert.equal(first.response, null);
  });

  it("dedupes relaunch by idempotency key and rejects key reuse with another plan", async () => {
    const first = await launchJob({ key: "key-dedup" });
    const { plan, planHash } = testPlan();
    const second = await launchAutoJob({
      workspaceId: "ws-auto",
      jobId: "aj-other",
      idempotencyKey: "key-dedup",
      plan,
      planHash,
    });
    assert.equal(second.deduplicated, true);
    assert.equal(second.job.jobId, first.job.jobId);
    const items = await listAutoItems("ws-auto", first.job.jobId, { limit: 500 });
    assert.equal(items.length, 6);

    const other = await resolveAutoPlan(
      {
        mode: "detect",
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
        seeds: [seed("img-a1", "seq-a", 19.0, 47.0)],
        hydrated: [],
        truncatedCount: 0,
      },
      [],
    );
    await expectCode(
      launchAutoJob({
        workspaceId: "ws-auto",
        jobId: "aj-clash",
        idempotencyKey: "key-dedup",
        plan: other.plan,
        planHash: other.planHash,
      }),
      "AUTO_JOB_CONFLICT",
    );
  });

  it("serializes concurrent launches to one job", async () => {
    const { plan, planHash } = testPlan();
    const attempts = await Promise.all([
      launchAutoJob({ workspaceId: "ws-auto", jobId: "aj-race-1", idempotencyKey: "key-race", plan, planHash }),
      launchAutoJob({ workspaceId: "ws-auto", jobId: "aj-race-2", idempotencyKey: "key-race", plan, planHash }),
    ]);
    assert.equal(attempts[0].job.jobId, attempts[1].job.jobId);
    assert.deepEqual(
      attempts.map((attempt) => attempt.deduplicated).sort(),
      [false, true],
    );
    const items = await listAutoItems("ws-auto", attempts[0].job.jobId, { limit: 500 });
    assert.equal(items.length, 6);
  });

  it("claims queued jobs oldest-first and never silently adopts stale ones", async () => {
    const first = await launchJob();
    const second = await launchJob();
    const claimed = await claimAutoJob({ workerId: "worker-a" });
    assert.ok(claimed);
    assert.equal(claimed.jobId, first.job.jobId);
    assert.equal(claimed.status, "preparing");
    assert.equal(claimed.owner, "worker-a");
    const next = await claimAutoJob({ workerId: "worker-b" });
    assert.ok(next);
    assert.equal(next.jobId, second.job.jobId);
    assert.equal(await claimAutoJob({ workerId: "worker-c" }), null);

    // A stale lease is not an adoption: only the sweep settles dead workers.
    await backdateJobLease(first.job.jobId);
    assert.equal(await claimAutoJob({ workerId: "worker-c" }), null);
  });

  it("advances worker-owned phases and rejects stale or invalid moves", async () => {
    const { job } = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    const base = { workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" };
    assert.equal(await advanceAutoJobPhase({ ...base, from: "preparing", to: "detecting" }), true);
    assert.equal(await advanceAutoJobPhase({ ...base, from: "preparing", to: "detecting" }), false);
    assert.equal(
      await advanceAutoJobPhase({ ...base, workerId: "worker-b", from: "detecting", to: "locating" }),
      false,
    );
    assert.equal(await advanceAutoJobPhase({ ...base, from: "detecting", to: "locating" }), true);
    await assert.rejects(advanceAutoJobPhase({ ...base, from: "locating", to: "completed" }), /active phases/);
  });

  it("heartbeats only for the owning worker of an active job", async () => {
    const { job } = await launchJob();
    assert.equal(
      await heartbeatAutoJob({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" }),
      false,
    );
    await claimAutoJob({ workerId: "worker-a" });
    assert.equal(
      await heartbeatAutoJob({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" }),
      true,
    );
    assert.equal(
      await heartbeatAutoJob({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-b" }),
      false,
    );
  });

  it("reserves model calls in the detecting phase and stops at the budget", async () => {
    const { job } = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    const base = { workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", maxCalls: 2 };
    // Wrong phase: no reservation outside detecting.
    assert.deepEqual(await reserveAutoJobCall(base), { allowed: false, callsMade: -1 });
    await advanceAutoJobPhase({ ...base, from: "preparing", to: "detecting" });
    assert.deepEqual(await reserveAutoJobCall(base), { allowed: true, callsMade: 1 });
    assert.deepEqual(await reserveAutoJobCall(base), { allowed: true, callsMade: 2 });
    assert.deepEqual(await reserveAutoJobCall(base), { allowed: false, callsMade: 3 });
    assert.deepEqual(await reserveAutoJobCall({ ...base, workerId: "worker-b" }), {
      allowed: false,
      callsMade: -1,
    });
  });

  it("records the SAM model label once and finalizes only for the owner", async () => {
    const { job } = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    await advanceAutoJobPhase({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      workerId: "worker-a",
      from: "preparing",
      to: "detecting",
    });
    assert.equal(
      await setAutoJobModel({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", model: "sam-a" }),
      true,
    );
    assert.equal(
      await setAutoJobModel({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", model: "sam-b" }),
      false,
    );
    assert.equal(
      await finalizeAutoJob({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-b", status: "failed" }),
      false,
    );
    assert.equal(
      await finalizeAutoJob({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", status: "failed", error: "boom" }),
      true,
    );
  });

  it("stops queued jobs immediately and flags live workers idempotently", async () => {
    const queued = await launchJob();
    assert.deepEqual(await requestAutoStop({ workspaceId: "ws-auto", jobId: queued.job.jobId }), {
      status: "stopped",
      stopped: true,
      requeued: 0,
      interrupted: 0,
    });
    assert.deepEqual(await requestAutoStop({ workspaceId: "ws-auto", jobId: queued.job.jobId }), {
      status: "stopped",
      stopped: false,
      requeued: 0,
      interrupted: 0,
    });

    const live = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    assert.deepEqual(await requestAutoStop({ workspaceId: "ws-auto", jobId: live.job.jobId }), {
      status: "preparing",
      stopped: true,
      requeued: 0,
      interrupted: 0,
    });
    // Second stop observes the flag instead of re-stopping.
    assert.deepEqual(await requestAutoStop({ workspaceId: "ws-auto", jobId: live.job.jobId }), {
      status: "preparing",
      stopped: false,
      requeued: 0,
      interrupted: 0,
    });

    await finalizeAutoJob({ workspaceId: "ws-auto", jobId: live.job.jobId, workerId: "worker-a", status: "completed" });
    await expectCode(requestAutoStop({ workspaceId: "ws-auto", jobId: live.job.jobId }), "AUTO_JOB_CONFLICT");
    await expectCode(requestAutoStop({ workspaceId: "ws-auto", jobId: "aj-missing" }), "AUTO_JOB_NOT_FOUND");
  });

  it("halts stale jobs directly and settles their items by the callSent rule", async () => {
    const { job } = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    const sent = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(sent);
    assert.equal(
      await markAutoItemCallSent({ workspaceId: "ws-auto", jobId: job.jobId, itemId: sent.itemId, workerId: "worker-a" }),
      true,
    );
    const unsent = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(unsent);
    await backdateJobLease(job.jobId);
    await backdateItemLease(job.jobId, sent.itemId);
    await backdateItemLease(job.jobId, unsent.itemId);

    assert.deepEqual(await requestAutoStop({ workspaceId: "ws-auto", jobId: job.jobId }), {
      status: "stopped",
      stopped: true,
      requeued: 1,
      interrupted: 1,
    });
    const sentAfter = await getAutoItem("ws-auto", job.jobId, sent.itemId);
    assert.equal(sentAfter?.status, "interrupted");
    assert.match(sentAfter?.error ?? "", /Outcome unknown/);
    const unsentAfter = await getAutoItem("ws-auto", job.jobId, unsent.itemId);
    assert.equal(unsentAfter?.status, "queued");
  });

  it("resumes halted jobs without blanket retries and sweeps leftovers", async () => {
    const { job } = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    const failed = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(failed);
    await completeAutoItem({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: failed.itemId,
      workerId: "worker-a",
      status: "failed",
      observationIds: [],
      error: "fetch failed",
    });
    // Simulates a fatal worker exit: job halted, item left running.
    const leftover = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(leftover);
    await finalizeAutoJob({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", status: "failed", error: "fatal" });

    const resumed = await resumeAutoJob({ workspaceId: "ws-auto", jobId: job.jobId });
    assert.deepEqual(resumed, { status: "queued", requeued: 1, interrupted: 0 });
    const failedAfter = await getAutoItem("ws-auto", job.jobId, failed.itemId);
    assert.equal(failedAfter?.status, "failed");
    const leftoverAfter = await getAutoItem("ws-auto", job.jobId, leftover.itemId);
    assert.equal(leftoverAfter?.status, "queued");

    await expectCode(resumeAutoJob({ workspaceId: "ws-auto", jobId: job.jobId }), "AUTO_JOB_CONFLICT");
    await expectCode(resumeAutoJob({ workspaceId: "ws-auto", jobId: "aj-missing" }), "AUTO_JOB_NOT_FOUND");
  });

  it("retries interrupted items explicitly and refuses completed jobs", async () => {
    const { job } = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    const queued = await listAutoItems("ws-auto", job.jobId, { status: "queued", limit: 1 });
    await setAutoItemPrepared({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: queued[0].itemId,
      viewDescriptor: viewDescriptorFixture(queued[0].imageId),
      artifactId: new mongoose.Types.ObjectId(),
    });
    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(item);
    assert.equal(item.itemId, queued[0].itemId);
    await markAutoItemCallSent({ workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId, workerId: "worker-a" });
    assert.deepEqual(
      await sweepAutoJobItems({ workspaceId: "ws-auto", jobId: job.jobId, ignoreLease: true }),
      { requeued: 0, interrupted: 1 },
    );

    const retried = await retryAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId });
    assert.deepEqual(retried, { status: "queued", attempts: 1 });
    const after = await getAutoItem("ws-auto", job.jobId, item.itemId);
    assert.ok(after?.viewDescriptor);
    assert.equal(after?.callSent, false);
    await expectCode(retryAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId }), "AUTO_ITEM_CONFLICT");
    await expectCode(retryAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: "img-missing--v0--pole" }), "AUTO_ITEM_NOT_FOUND");

    await finalizeAutoJob({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", status: "completed" });
    // Re-interrupt one item artificially to prove the job gate fires first.
    await AutoWorkItemModel().updateOne(
      { workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId },
      { $set: { status: "interrupted" } },
    );
    await expectCode(retryAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId }), "AUTO_JOB_CONFLICT");
    await expectCode(retryAutoItem({ workspaceId: "ws-auto", jobId: "aj-missing", itemId: item.itemId }), "AUTO_JOB_NOT_FOUND");
  });

  it("sweeps active jobs to interrupted at server startup", async () => {
    const active = await launchJob();
    await claimAutoJob({ workerId: "worker-a" });
    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: active.job.jobId, workerId: "worker-a" });
    assert.ok(item);
    const idle = await launchJob();
    assert.equal(idle.job.status, "queued");

    const swept = await sweepInterruptedJobs();
    assert.equal(swept.jobs.length, 1);
    assert.deepEqual(swept.jobs[0], {
      workspaceId: "ws-auto",
      jobId: active.job.jobId,
      requeued: 1,
      interrupted: 0,
    });
    const jobAfter = await getAutoJob("ws-auto", active.job.jobId);
    assert.equal(jobAfter?.status, "interrupted");
    assert.match(jobAfter?.error ?? "", /resume to continue/);
    const idleAfter = await getAutoJob("ws-auto", idle.job.jobId);
    assert.equal(idleAfter?.status, "queued");
  });

  it("claims queued items in order and leaves stale ones for the sweep", async () => {
    const { job } = await launchJob();
    const first = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(first);
    assert.equal(first.status, "running");
    assert.equal(first.attempts, 0);
    const second = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-b" });
    assert.ok(second);
    assert.notEqual(second.itemId, first.itemId);

    await backdateItemLease(job.jobId, first.itemId);
    // Drain the queue; the stale running item is never adopted.
    const seen = new Set([first.itemId, second.itemId]);
    for (;;) {
      const next = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-c" });
      if (!next) break;
      assert.equal(seen.has(next.itemId), false);
      seen.add(next.itemId);
    }
    assert.equal(seen.size, 6);
    assert.equal(await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-c" }), null);
  });

  it("records preparation on queued items without a claim", async () => {
    const { job } = await launchJob();
    const queued = await listAutoItems("ws-auto", job.jobId, { status: "queued", limit: 1 });
    const descriptor = viewDescriptorFixture(queued[0].imageId);
    const artifactId = new mongoose.Types.ObjectId();
    await setAutoItemPrepared({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: queued[0].itemId,
      viewDescriptor: descriptor,
      artifactId,
    });
    const stored = await getAutoItem("ws-auto", job.jobId, queued[0].itemId);
    assert.equal(stored?.status, "queued");
    assert.deepEqual(
      (stored?.viewDescriptor as unknown as Record<string, unknown>)?.width,
      1024,
    );
    assert.equal(String(stored?.artifactId), String(artifactId));

    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(item);
    await expectCode(
      setAutoItemPrepared({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        itemId: item.itemId,
        viewDescriptor: descriptor,
        artifactId: null,
      }),
      "AUTO_ITEM_CLAIMED",
    );
    await completeAutoItem({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: item.itemId,
      workerId: "worker-a",
      status: "empty",
      observationIds: [],
    });
    await expectCode(
      setAutoItemPrepared({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        itemId: item.itemId,
        viewDescriptor: descriptor,
        artifactId: null,
      }),
      "AUTO_ITEM_ALREADY_COMPLETE",
    );
    await expectCode(
      setAutoItemPrepared({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        itemId: "img-missing--v0--pole",
        viewDescriptor: descriptor,
        artifactId: null,
      }),
      "AUTO_ITEM_NOT_FOUND",
    );
  });

  it("fails queued items during preparation", async () => {
    const { job } = await launchJob();
    const queued = await listAutoItems("ws-auto", job.jobId, { status: "queued", limit: 2 });
    assert.equal(
      await failAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: queued[0].itemId, error: "fetch failed" }),
      true,
    );
    const stored = await getAutoItem("ws-auto", job.jobId, queued[0].itemId);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.error, "fetch failed");
    assert.ok(stored?.finishedAt);
    const claimed = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(claimed);
    assert.notEqual(claimed.itemId, queued[0].itemId);
    assert.equal(
      await failAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: claimed.itemId, error: "late" }),
      false,
    );
  });

  it("releases uncalled items and parks ambiguous ones as unknown", async () => {
    const { job } = await launchJob();
    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(item);
    assert.equal(
      await releaseAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId, workerId: "worker-b" }),
      false,
    );
    assert.equal(
      await releaseAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId, workerId: "worker-a" }),
      true,
    );
    const released = await getAutoItem("ws-auto", job.jobId, item.itemId);
    assert.equal(released?.status, "queued");
    assert.equal(released?.owner, null);

    const again = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(again);
    await markAutoItemCallSent({ workspaceId: "ws-auto", jobId: job.jobId, itemId: again.itemId, workerId: "worker-a" });
    assert.equal(
      await releaseAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, itemId: again.itemId, workerId: "worker-a" }),
      false,
    );
    assert.equal(
      await markAutoItemUnknown({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        itemId: again.itemId,
        workerId: "worker-a",
        error: "model call timed out; outcome unknown",
      }),
      true,
    );
    const parked = await getAutoItem("ws-auto", job.jobId, again.itemId);
    assert.equal(parked?.status, "interrupted");
    assert.match(parked?.error ?? "", /outcome unknown/);
    assert.equal(
      await markAutoItemUnknown({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        itemId: again.itemId,
        workerId: "worker-a",
        error: "again",
      }),
      false,
    );
  });

  it("marks calls sent only for the running owner", async () => {
    const { job } = await launchJob();
    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(item);
    const base = { workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId };
    assert.equal(await markAutoItemCallSent({ ...base, workerId: "worker-b" }), false);
    assert.equal(await markAutoItemCallSent({ ...base, workerId: "worker-a" }), true);
    await completeAutoItem({ ...base, workerId: "worker-a", status: "empty", observationIds: [] });
    assert.equal(await markAutoItemCallSent({ ...base, workerId: "worker-a" }), false);
  });

  it("completes items with referenced observations and dedupes identical retries", async () => {
    const { job } = await launchJob();
    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(item);
    const observationId = `${item.itemId}--a0--o0`;
    const written = await writeAutoObservations({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: item.itemId,
      imageId: item.imageId,
      concept: { conceptId: item.conceptId, text: item.prompt, category: item.category as "pole" | "luminaire" },
      observations: [observationFixture(observationId)],
    });
    assert.deepEqual(written, { written: 1, deduplicated: 0 });

    const base = {
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: item.itemId,
      workerId: "worker-a",
      status: "succeeded" as const,
      observationIds: [observationId],
      providerRequestId: "req-1",
      response: { objectCount: 1, warnings: [] },
    };
    assert.deepEqual(await completeAutoItem(base), { status: "succeeded", deduplicated: false });
    assert.deepEqual(await completeAutoItem(base), { status: "succeeded", deduplicated: true });
    await expectCode(
      completeAutoItem({ ...base, response: { objectCount: 2, warnings: [] } }),
      "AUTO_ITEM_ALREADY_COMPLETE",
    );
    await expectCode(
      completeAutoItem({ ...base, status: "empty", observationIds: [], response: null }),
      "AUTO_ITEM_ALREADY_COMPLETE",
    );
  });

  it("rejects completions that cite unwritten observations or break shape rules", async () => {
    const { job } = await launchJob();
    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(item);
    const base = { workspaceId: "ws-auto", jobId: job.jobId, itemId: item.itemId, workerId: "worker-a" };
    await expectCode(
      completeAutoItem({ ...base, status: "succeeded", observationIds: ["ghost--o0"] }),
      "AUTO_ITEM_CONFLICT",
    );
    await expectCode(completeAutoItem({ ...base, status: "succeeded", observationIds: [] }), "AUTO_ITEM_CONFLICT");
    await expectCode(completeAutoItem({ ...base, status: "empty", observationIds: ["ghost--o0"] }), "AUTO_ITEM_CONFLICT");
    await expectCode(completeAutoItem({ ...base, status: "failed", observationIds: [] }), "AUTO_ITEM_CONFLICT");
    await expectCode(
      completeAutoItem({ ...base, status: "empty", observationIds: [], error: "nope" }),
      "AUTO_ITEM_CONFLICT",
    );

    const queued = await listAutoItems("ws-auto", job.jobId, { status: "queued", limit: 1 });
    assert.equal(queued.length > 0, true);
    await expectCode(
      completeAutoItem({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        itemId: queued[0].itemId,
        workerId: "worker-a",
        status: "empty",
        observationIds: [],
      }),
      "AUTO_ITEM_CONFLICT",
    );
    await expectCode(
      completeAutoItem({ ...base, status: "empty", observationIds: [], workerId: "worker-b" }),
      "AUTO_ITEM_CLAIMED",
    );
  });

  it("dedupes identical observations and conflicts on same-id content changes", async () => {
    const { job } = await launchJob();
    const item = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a" });
    assert.ok(item);
    const input = {
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: item.itemId,
      imageId: item.imageId,
      concept: { conceptId: item.conceptId, text: item.prompt, category: item.category as "pole" | "luminaire" },
    };
    const observationId = `${item.itemId}--a0--o0`;
    assert.deepEqual(await writeAutoObservations({ ...input, observations: [observationFixture(observationId)] }), {
      written: 1,
      deduplicated: 0,
    });
    assert.deepEqual(await writeAutoObservations({ ...input, observations: [observationFixture(observationId)] }), {
      written: 0,
      deduplicated: 1,
    });
    const changed = observationFixture(observationId);
    changed.box = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    await expectCode(writeAutoObservations({ ...input, observations: [changed] }), "AUTO_OBSERVATION_CONFLICT");
    await expectCode(
      writeAutoObservations({ ...input, observations: [observationFixture("dup"), observationFixture("dup")] }),
      "AUTO_OBSERVATION_CONFLICT",
    );
  });

  it("replaces candidates wholesale per association run", async () => {
    const { job } = await launchJob();
    assert.deepEqual(
      await replaceAutoCandidates({ workspaceId: "ws-auto", jobId: job.jobId, candidates: [candidateFixture()] }),
      { count: 1 },
    );
    assert.deepEqual(
      await replaceAutoCandidates({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        candidates: [
          candidateFixture({ candidateId: "ca-pole-2", status: "candidate", position: null }),
          candidateFixture({
            candidateId: "ca-lamp-1",
            kind: "luminaire",
            status: "candidate",
            position: null,
            observationIds: ["img-a1--v0--lamp--a0--o0"],
          }),
        ],
      }),
      { count: 2 },
    );
    await expectCode(
      replaceAutoCandidates({
        workspaceId: "ws-auto",
        jobId: job.jobId,
        candidates: [candidateFixture(), candidateFixture()],
      }),
      "AUTO_CANDIDATE_CONFLICT",
    );
  });

  it("publishes one result per job and dedupes identical republishes", async () => {
    const { job } = await launchJob();
    const { planHash } = testPlan();
    const first = await publishAutoResult({ workspaceId: "ws-auto", jobId: job.jobId, result: resultFixture(planHash) });
    assert.deepEqual(first, { resultId: `ar_${job.jobId}`, deduplicated: false });
    const second = await publishAutoResult({ workspaceId: "ws-auto", jobId: job.jobId, result: resultFixture(planHash) });
    assert.deepEqual(second, { resultId: `ar_${job.jobId}`, deduplicated: true });
    const changed = resultFixture(planHash);
    changed.counts = { located: 2, needsReview: 0, unlocated: 0 };
    await expectCode(publishAutoResult({ workspaceId: "ws-auto", jobId: job.jobId, result: changed }), "AUTO_RESULT_EXISTS");
  });

  it("derives progress from items and ignores orphaned partials", async () => {
    const { job } = await launchJob();
    const workerId = "worker-a";
    await claimAutoJob({ workerId });
    await advanceAutoJobPhase({ workspaceId: "ws-auto", jobId: job.jobId, workerId, from: "preparing", to: "detecting" });
    const mkConcept = (item: { conceptId: string; prompt: string; category: string }) => ({
      conceptId: item.conceptId,
      text: item.prompt,
      category: item.category as "pole" | "luminaire",
    });
    const itemA = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId });
    assert.ok(itemA);
    const obsA = [`${itemA.itemId}--a0--o0`, `${itemA.itemId}--a0--o1`];
    await writeAutoObservations({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: itemA.itemId,
      imageId: itemA.imageId,
      concept: mkConcept(itemA),
      observations: obsA.map((id) => observationFixture(id)),
    });
    await completeAutoItem({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: itemA.itemId,
      workerId,
      status: "succeeded",
      observationIds: obsA,
    });
    const itemB = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId });
    assert.ok(itemB);
    await completeAutoItem({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: itemB.itemId,
      workerId,
      status: "empty",
      observationIds: [],
    });
    const itemC = await claimAutoItem({ workspaceId: "ws-auto", jobId: job.jobId, workerId });
    assert.ok(itemC);
    // Orphaned partial: written but never referenced by a completion.
    await writeAutoObservations({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: itemC.itemId,
      imageId: itemC.imageId,
      concept: mkConcept(itemC),
      observations: [observationFixture(`${itemC.itemId}--a0--o0`)],
    });
    await completeAutoItem({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      itemId: itemC.itemId,
      workerId,
      status: "failed",
      observationIds: [],
      error: "inference failed",
    });
    await replaceAutoCandidates({ workspaceId: "ws-auto", jobId: job.jobId, candidates: [candidateFixture()] });
    await reserveAutoJobCall({ workspaceId: "ws-auto", jobId: job.jobId, workerId, maxCalls: 200 });

    const progress = await getAutoJobProgress("ws-auto", job.jobId);
    assert.deepEqual(progress, {
      totalItems: 6,
      queuedItems: 3,
      runningItems: 0,
      doneItems: 2,
      failedItems: 1,
      haltedItems: 0,
      observationCount: 2,
      locatedCount: 1,
      callsMade: 1,
    });
    assert.equal(await getAutoJobProgress("ws-auto", "aj-missing"), null);
  });

  it("attaches the published result only for the publishing owner", async () => {
    const { job } = await launchJob();
    const { planHash } = testPlan();
    await claimAutoJob({ workerId: "worker-a" });
    const published = await publishAutoResult({
      workspaceId: "ws-auto",
      jobId: job.jobId,
      result: resultFixture(planHash),
    });
    const base = { workspaceId: "ws-auto", jobId: job.jobId, resultId: published.resultId, status: "completed" as const };
    // Wrong phase: the job is still preparing.
    assert.equal(await setAutoJobResult({ ...base, workerId: "worker-a" }), false);
    await advanceAutoJobPhase({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", from: "preparing", to: "detecting" });
    await advanceAutoJobPhase({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", from: "detecting", to: "locating" });
    await advanceAutoJobPhase({ workspaceId: "ws-auto", jobId: job.jobId, workerId: "worker-a", from: "locating", to: "publishing" });
    assert.equal(await setAutoJobResult({ ...base, workerId: "worker-b" }), false);
    assert.equal(await setAutoJobResult({ ...base, workerId: "worker-a" }), true);
    const attached = await getAutoJob("ws-auto", job.jobId);
    assert.equal(attached?.status, "completed");
    assert.equal(attached?.resultId, published.resultId);
  });
});
