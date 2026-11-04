import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "./api.js";
import {
  getAutoCandidateEvidence,
  getAutoJob,
  getAutoResult,
  isActiveAutoJobStatus,
  listAutoCandidates,
  listAutoItems,
  listAutoJobs,
  prepareAutoRun,
  resumeAutoJob,
  retryAutoItem,
  stopAutoJob,
} from "./autoApi.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch<T>(respond: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string) => respond(String(url))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = saved;
  }
}

const COUNTS = {
  totalImages: 2,
  eligibleImages: 2,
  detectionOnlyImages: 0,
  missingMetadataImages: 0,
  panoImages: 0,
  perspectiveImages: 2,
  unknownCameraImages: 0,
};

const PREPARE = {
  prepareSnapshotId: "aprep_1",
  planHash: "ab".repeat(32),
  mode: "locate",
  totalImages: 2,
  estimatedCalls: 4,
  minSpacingM: 10,
  excludedOutsideRoi: 1,
  thinnedBySpacing: 0,
  counts: COUNTS,
  warnings: [],
  perSequence: [{ sequenceId: "seq-a", imageCount: 2, eligibleCount: 2 }],
};

const JOB = {
  jobId: "aj_1",
  status: "detecting",
  mode: "locate",
  totalImages: 2,
  estimatedCalls: 4,
  callsMade: 1,
  stopRequested: false,
  model: "sam-3.1",
  error: null,
  resultId: null,
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:01.000Z",
};

describe("autoApi validators", () => {
  it("parses prepare responses and rejects malformed counts", async () => {
    const parsed = await withFetch(() => jsonResponse(PREPARE), () =>
      prepareAutoRun("ws_1", {
        mode: "locate",
        snapshotId: "sn_1",
        streetSnapshotId: null,
        sequenceIds: ["seq-a"],
        concepts: [{ conceptId: "auto-pole", text: "street light pole", category: "pole" }],
      }),
    );
    assert.equal(parsed.prepareSnapshotId, "aprep_1");
    assert.equal(parsed.perSequence[0].eligibleCount, 2);
    assert.equal(parsed.minSpacingM, 10);
    assert.equal(parsed.excludedOutsideRoi, 1);
    assert.equal(parsed.thinnedBySpacing, 0);

    await assert.rejects(
      withFetch(() => jsonResponse({ ...PREPARE, counts: { totalImages: 2 } }), () =>
        prepareAutoRun("ws_1", {
          mode: "locate",
          snapshotId: "sn_1",
          streetSnapshotId: null,
          sequenceIds: ["seq-a"],
          concepts: [{ conceptId: "auto-pole", text: "street light pole", category: "pole" }],
        }),
      ),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "BAD_RESPONSE");
        return true;
      },
    );
  });

  it("parses job lists, details with progress, and items", async () => {
    const jobs = await withFetch(() => jsonResponse({ jobs: [JOB] }), () => listAutoJobs("ws_1"));
    assert.equal(jobs[0].jobId, "aj_1");

    const detail = await withFetch(
      () =>
        jsonResponse({
          job: {
            ...JOB,
            plan: {
              sequenceIds: ["seq-a"],
              imageIds: ["img-1"],
              concepts: [{ conceptId: "auto-pole", text: "street light pole", category: "pole" }],
              perSequence: [{ sequenceId: "seq-a", imageIds: ["img-1"] }],
            },
          },
          progress: {
            totalItems: 1,
            queuedItems: 0,
            runningItems: 1,
            doneItems: 0,
            failedItems: 0,
            haltedItems: 0,
            observationCount: 0,
            locatedCount: 0,
            callsMade: 1,
          },
        }),
      () => getAutoJob("ws_1", "aj_1"),
    );
    assert.equal(detail.progress?.runningItems, 1);
    assert.equal(detail.job.plan.concepts[0].category, "pole");

    const items = await withFetch(
      () =>
        jsonResponse({
          items: [
            {
              itemId: "img-1--v0--auto-pole",
              sequenceId: "seq-a",
              imageId: "img-1",
              conceptId: "auto-pole",
              category: "pole",
              status: "running",
              attempts: 1,
              error: null,
              artifactId: null,
              observationIds: [],
              callSent: true,
              finishedAt: null,
            },
          ],
        }),
      () => listAutoItems("ws_1", "aj_1"),
    );
    assert.equal(items[0].callSent, true);
  });

  it("parses candidates and results in the stored document shape", async () => {
    // Fixtures mirror the stored AutoCandidateDocument shape (kind, checks,
    // poleCandidateId, fit.unresolvedReason) — not an idealized contract.
    const candidates = await withFetch(
      () =>
        jsonResponse({
          candidates: [
            {
              candidateId: "cand-1",
              kind: "pole",
              status: "located",
              position: { lng: 19.0, lat: 47.0, uncertaintyM: 1.5, method: "triangulation-3view" },
              observationIds: ["o1"],
              imageIds: ["img-1"],
              viewCount: 3,
              fit: { associationVersion: 1, method: "triangulation-3view" },
              poleCandidateId: null,
              luminaireCandidateIds: [],
              streetId: "street-1",
              checks: ["possible-duplicate"],
            },
            {
              candidateId: "cand-2",
              kind: "luminaire",
              status: "needs-review",
              position: null,
              observationIds: ["o2"],
              imageIds: ["img-2"],
              viewCount: 2,
              fit: { associationVersion: 1, method: "two-view-seed", unresolvedReason: "two-views" },
              poleCandidateId: "cand-1",
              luminaireCandidateIds: [],
              streetId: null,
              checks: [],
            },
          ],
        }),
      () => listAutoCandidates("ws_1", "aj_1"),
    );
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].category, "pole");
    assert.deepEqual(candidates[0].flags, ["possible-duplicate"]);
    assert.equal(candidates[1].position, null);
    assert.equal(candidates[1].unlocatedReason, "two-views");
    assert.equal(candidates[1].supportId, "cand-1");
    assert.deepEqual(candidates[1].sequenceIds, []);

    const result = await withFetch(
      () =>
        jsonResponse({
          result: {
            resultId: "ar_1",
            status: "inventory-complete",
            counts: { totalItems: 2, located: 1 },
            limitations: ["2 images lacked usable geometry."],
            createdAt: "2026-11-04T00:00:02.000Z",
          },
        }),
      () => getAutoResult("ws_1", "aj_1"),
    );
    assert.equal(result.counts.located, 1);
    assert.deepEqual(result.limitations, ["2 images lacked usable geometry."]);

    const legacy = await withFetch(
      () =>
        jsonResponse({
          result: {
            resultId: "ar_1",
            status: "detection-complete",
            counts: { totalItems: 2 },
            createdAt: "2026-11-04T00:00:02.000Z",
          },
        }),
      () => getAutoResult("ws_1", "aj_1"),
    );
    assert.deepEqual(legacy.limitations, []);
  });

  it("parses stop/resume/retry outcomes and surfaces server errors", async () => {
    const stopped = await withFetch(() => jsonResponse({ status: "detecting", stopped: true }), () =>
      stopAutoJob("ws_1", "aj_1"),
    );
    assert.equal(stopped.stopped, true);
    const resumed = await withFetch(() => jsonResponse({ status: "queued" }), () =>
      resumeAutoJob("ws_1", "aj_1"),
    );
    assert.equal(resumed.status, "queued");
    const retried = await withFetch(() => jsonResponse({ status: "queued", attempts: 2 }), () =>
      retryAutoItem("ws_1", "aj_1", "img-1--v0--auto-pole"),
    );
    assert.equal(retried.attempts, 2);

    await assert.rejects(
      withFetch(
        () => jsonResponse({ error: { code: "AUTO_ITEM_CONFLICT", message: "Only interrupted items retry.", retryable: false } }, 409),
        () => retryAutoItem("ws_1", "aj_1", "img-1--v0--auto-pole"),
      ),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "AUTO_ITEM_CONFLICT");
        assert.equal(error.httpStatus, 409);
        return true;
      },
    );
  });

  it("parses candidate evidence with views, boxes, anchors, and masks", async () => {
    const evidence = await withFetch(
      () =>
        jsonResponse({
          candidateId: "cand-1",
          truncated: false,
          images: [
            { imageId: "img-1", viewArtifactId: "6aeafea870a582b08ddf1724", width: 2048, height: 1152 },
            { imageId: "img-2", viewArtifactId: null, width: null, height: null },
          ],
          observations: [
            {
              observationId: "obs-1",
              imageId: "img-1",
              box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
              confidence: 0.9,
              anchor: { uPx: 100, vPx: 200 },
              maskArtifactId: "6aeafed370a582b08ddf18ad",
              maskBounds: { left: 90, top: 190, right: 130, bottom: 260 },
            },
            {
              observationId: "obs-2",
              imageId: "img-2",
              box: { x: 0, y: 0, w: 1, h: 1 },
              confidence: null,
              anchor: null,
              maskArtifactId: null,
              maskBounds: null,
            },
          ],
        }),
      () => getAutoCandidateEvidence("ws_1", "aj_1", "cand-1"),
    );
    assert.equal(evidence.images.length, 2);
    assert.equal(evidence.images[0].viewArtifactId, "6aeafea870a582b08ddf1724");
    assert.equal(evidence.images[1].viewArtifactId, null);
    assert.deepEqual(evidence.observations[0].maskBounds, { left: 90, top: 190, right: 130, bottom: 260 });
    assert.equal(evidence.observations[1].anchor, null);

    await assert.rejects(
      withFetch(
        () =>
          jsonResponse({
            candidateId: "cand-1",
            truncated: false,
            images: [],
            observations: [
              {
                observationId: "obs-1",
                imageId: "img-1",
                box: { x: 0.1, y: "high", w: 0.3, h: 0.4 },
                confidence: null,
                anchor: null,
                maskArtifactId: null,
                maskBounds: null,
              },
            ],
          }),
        () => getAutoCandidateEvidence("ws_1", "aj_1", "cand-1"),
      ),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "BAD_RESPONSE");
        return true;
      },
    );
  });

  it("classifies active job statuses", () => {
    assert.equal(isActiveAutoJobStatus("queued"), true);
    assert.equal(isActiveAutoJobStatus("locating"), true);
    assert.equal(isActiveAutoJobStatus("completed"), false);
    assert.equal(isActiveAutoJobStatus("completed_with_gaps"), false);
    assert.equal(isActiveAutoJobStatus("stopped"), false);
    assert.equal(isActiveAutoJobStatus("failed"), false);
  });
});
