import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allDemoObservations,
} from "./demoFixtures.js";
import type {
  InventoryObservation,
  SourceImage,
  SourceView,
  WorkflowSession,
} from "./inventoryTypes.js";
import {
  assessFinish,
  assetOf,
  buildPreviewResult,
  confirmChecks,
  createSession,
  deriveCounts,
  incompleteRunItems,
  inventoryReducer,
  mergePreview,
  resolvePlacement,
  summarizeProcessing,
  validateAssetMembers,
  validateMerge,
  validateSplit,
} from "./inventoryReducer.js";

function session(): WorkflowSession {
  return createSession({
    key: "demo",
    sessionId: "demo",
    mode: "demo",
    streetId: "demo-street",
    streetDisplayName: "Demo Street",
    context: {
      streetId: "demo-street",
      streetDisplayName: "Demo Street",
      streetSource: "synthetic-demo",
      roiRevision: null,
      runId: null,
      fingerprint: null,
    },
  });
}

function withDetections(): WorkflowSession {
  return inventoryReducer(session(), { type: "DETECT_APPLY", observations: allDemoObservations() });
}

function decide(session: WorkflowSession, id: string, decision: InventoryObservation["decision"]): WorkflowSession {
  return inventoryReducer(session, { type: "OBS_DECIDE", id, decision });
}

function accept(session: WorkflowSession, ...ids: string[]): WorkflowSession {
  let next = session;
  for (const id of ids) next = decide(next, id, "accepted");
  return next;
}

function manualSession(streetSource: "osm" | "manual-work-area" = "osm"): WorkflowSession {
  return createSession({
    key: "s",
    sessionId: "s",
    mode: "manual",
    streetId: "s",
    streetDisplayName: "S",
    context: {
      streetId: "s",
      streetDisplayName: "S",
      streetSource,
      roiRevision: 1,
      runId: "r",
      fingerprint: "f",
    },
  });
}

function sourceImage(imageId: string): SourceImage {
  return {
    imageId,
    sequenceId: "seq-1",
    capturedAt: 1700000000000,
    isPano: false,
    attribution: "© Mapillary contributors — tester",
    sourceUrl: `https://www.mapillary.com/map/im/${imageId}`,
    cameraPosition: { lng: 19.04, lat: 47.49 },
    resolution: "2048px thumbnail",
  };
}

function sourceView(viewId: string, imageId: string, crop: SourceView["crop"] = null): SourceView {
  return {
    viewId,
    imageId,
    fullWidth: 2048,
    fullHeight: 1024,
    orientation: 1,
    isPano: false,
    crop,
    width: crop ? 512 : 2048,
    height: crop ? 512 : 1024,
    mediaHandle: `h-${viewId}`,
    fullyReviewed: false,
  };
}

function samObs(id: string, origin: "sam-text" | "sam-assisted" = "sam-text"): InventoryObservation {
  return {
    id,
    imageId: "img-1",
    viewId: "view-1",
    category: "pole",
    description: "SAM pole",
    imageRegion: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 },
    mask: { svgPath: "M0 0L10 0L10 10Z", width: 60, height: 27, bounds: { left: 204, top: 102, right: 614, bottom: 410 } },
    maskStale: false,
    origin,
    provenance: {
      provider: "meta-sam",
      model: "sam-3.1",
      prompt: "street light pole",
      categoryIntent: "pole",
      runId: "run-1",
      requestId: "req-1",
      providerObjectId: "0",
      confidence: 0.9,
      geometrySource: "model",
    },
    mode: "manual",
    decision: "pending",
    note: "",
  };
}

function withManifest(count = 1): WorkflowSession {
  const images = Array.from({ length: count }, (_, index) => sourceImage(`img-${index + 1}`));
  const views = Array.from({ length: count }, (_, index) => sourceView(`view-${index + 1}`, `img-${index + 1}`));
  return inventoryReducer(manualSession(), {
    type: "SOURCES_CHOOSE",
    images,
    views,
    samplingNote: "evenly spaced",
  });
}

describe("detection apply", () => {
  it("applies fixtures once and blocks silent reruns", () => {
    const applied = withDetections();
    assert.equal(Object.keys(applied.observations).length, 11);
    assert.equal(applied.detection.status, "finished");
    const rerun = inventoryReducer(applied, { type: "DETECT_APPLY", observations: allDemoObservations() });
    assert.equal(rerun, applied);
  });

  it("replaces demo evidence with confirmation semantics, keeping manual work", () => {
    let next = withDetections();
    next = accept(next, "demo-obs-01");
    next = inventoryReducer(next, {
      type: "OBS_ADD",
      observation: {
        id: "obs-1",
        imageId: "demo-image-01",
        viewId: null,
        category: "pole",
        description: "manual",
        imageRegion: null,
        mask: null,
        maskStale: false,
        origin: "manual",
        provenance: null,
        mode: "demo",
        decision: "accepted",
        note: "",
      },
    });
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    assert.equal(Object.keys(next.assets).length, 1);
    next = inventoryReducer(next, { type: "DETECT_REPLACE", observations: allDemoObservations().slice(0, 1) });
    assert.deepEqual(Object.keys(next.observations).sort(), ["demo-obs-01", "obs-1"]);
    assert.equal(Object.keys(next.assets).length, 0);
    assert.equal(next.observations["obs-1"].decision, "accepted");
  });
});

describe("grouping rules", () => {
  it("creates one asset from many observations of one category", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-05", "demo-obs-09");
    assert.equal(validateAssetMembers(["demo-obs-01", "demo-obs-05", "demo-obs-09"], next).ok, true);
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01", "demo-obs-05", "demo-obs-09"] });
    const asset = next.assets["asset-1"];
    assert.deepEqual(asset.observationIds, ["demo-obs-01", "demo-obs-05", "demo-obs-09"]);
    assert.equal(asset.confirmed, false);
    assert.deepEqual(asset.placement, { kind: "unknown", explicit: false });
  });

  it("rejects mixed, uncertain, unaccepted, and duplicate assignments", () => {
    const next = accept(withDetections(), "demo-obs-01", "demo-obs-02", "demo-obs-08");
    assert.equal(
      validateAssetMembers(["demo-obs-01", "demo-obs-02"], next).ok,
      false,
    );
    const uncertain = validateAssetMembers(["demo-obs-08"], next);
    assert.equal(uncertain.ok, false);
    if (!uncertain.ok) assert.ok(uncertain.reason.includes("Uncertain"));
    const pending = validateAssetMembers(["demo-obs-03"], next);
    assert.equal(pending.ok, false);
    const assigned = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    assert.equal(validateAssetMembers(["demo-obs-01"], assigned).ok, false);
    assert.equal(assetOf("demo-obs-01", assigned.assets)?.id, "asset-1");
    assert.equal(assigned, inventoryReducer(assigned, { type: "ASSET_CREATE", observationIds: ["demo-obs-01", "demo-obs-05"] }));
  });

  it("merges compatibly with retained identity and remapped dependents", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-05", "demo-obs-02");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-05"] });
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-02"] });
    assert.equal(validateMerge(next.assets["asset-1"], next.assets["asset-2"]).ok, true);
    assert.equal(validateMerge(next.assets["asset-1"], next.assets["asset-3"]).ok, false);
    const preview = mergePreview(next.assets["asset-1"], next.assets["asset-2"]);
    assert.equal(preview.combinedCount, 2);
    next = inventoryReducer(next, { type: "SUPPORT_ATTACH", luminaireId: "asset-3", support: { kind: "pole", poleAssetId: "asset-2" } });
    next = inventoryReducer(next, {
      type: "ASSET_MERGE",
      retainedId: "asset-1",
      removedId: "asset-2",
      position: { kind: "unknown", explicit: false },
      support: null,
    });
    assert.deepEqual(next.assets["asset-1"].observationIds, ["demo-obs-01", "demo-obs-05"]);
    assert.ok(!next.assets["asset-2"]);
    assert.deepEqual(next.assets["asset-3"].support, { kind: "pole", poleAssetId: "asset-1" });
    assert.deepEqual(next.assetOrder, ["asset-1", "asset-3"]);
  });

  it("splits evidence into an unplaced, unconfirmed asset", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-05", "demo-obs-09");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01", "demo-obs-05", "demo-obs-09"] });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-1", placement: { kind: "diagram", x: 10, y: 20 } });
    assert.equal(validateSplit(next.assets["asset-1"], ["demo-obs-09"]).ok, true);
    assert.equal(validateSplit(next.assets["asset-1"], ["demo-obs-01", "demo-obs-05", "demo-obs-09"]).ok, false);
    next = inventoryReducer(next, { type: "ASSET_SPLIT", assetId: "asset-1", movingIds: ["demo-obs-09"] });
    assert.deepEqual(next.assets["asset-1"].observationIds, ["demo-obs-01", "demo-obs-05"]);
    assert.deepEqual(next.assets["asset-1"].placement, { kind: "diagram", x: 10, y: 20 });
    assert.deepEqual(next.assets["asset-2"].observationIds, ["demo-obs-09"]);
    assert.deepEqual(next.assets["asset-2"].placement, { kind: "unknown", explicit: false });
    assert.equal(next.assets["asset-2"].confirmed, false);
  });

  it("removing evidence can empty an asset, and removal returns the rest", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-05");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    next = inventoryReducer(next, { type: "ASSET_ADD_OBS", assetId: "asset-1", observationIds: ["demo-obs-05"] });
    assert.deepEqual(next.assets["asset-1"].observationIds, ["demo-obs-01", "demo-obs-05"]);
    next = inventoryReducer(next, { type: "ASSET_REMOVE_OBS", assetId: "asset-1", observationId: "demo-obs-05" });
    assert.deepEqual(next.assets["asset-1"].observationIds, ["demo-obs-01"]);
    assert.equal(assetOf("demo-obs-05", next.assets), null);
    assert.equal(next.observations["demo-obs-05"].decision, "accepted");
    next = inventoryReducer(next, { type: "ASSET_REMOVE_OBS", assetId: "asset-1", observationId: "demo-obs-01" });
    assert.deepEqual(next.assets["asset-1"].observationIds, []);
  });
});

describe("review validity", () => {
  it("rejecting assigned evidence detaches it and unconfirms the asset", () => {
    let next = accept(withDetections(), "demo-obs-01");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-1", placement: { kind: "unknown", explicit: true } });
    next = inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-1" });
    assert.equal(next.assets["asset-1"].confirmed, true);
    next = decide(next, "demo-obs-01", "rejected");
    assert.deepEqual(next.assets["asset-1"].observationIds, []);
    assert.equal(next.assets["asset-1"].confirmed, false);
  });

  it("blocks category changes while assigned", () => {
    let next = accept(withDetections(), "demo-obs-01");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    const blocked = inventoryReducer(next, { type: "OBS_EDIT", id: "demo-obs-01", category: "luminaire" });
    assert.equal(blocked, next);
    const edited = inventoryReducer(next, { type: "OBS_EDIT", id: "demo-obs-01", description: "tweaked" });
    assert.equal(edited.observations["demo-obs-01"].description, "tweaked");
  });

  it("removing a linked pole forces a new explicit support choice", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-02");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-02"] });
    next = inventoryReducer(next, { type: "SUPPORT_ATTACH", luminaireId: "asset-2", support: { kind: "pole", poleAssetId: "asset-1" } });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-2", placement: { kind: "inherited" } });
    next = inventoryReducer(next, { type: "ASSET_REMOVE", assetId: "asset-1" });
    assert.equal(next.assets["asset-2"].support, null);
    assert.deepEqual(next.assets["asset-2"].placement, { kind: "unknown", explicit: false });
  });
});

describe("placement and confirmation", () => {
  it("separates diagram and geographic coordinates by mode", () => {
    let next = accept(withDetections(), "demo-obs-01");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    const geoBlocked = inventoryReducer(next, {
      type: "PLACE", assetId: "asset-1", placement: { kind: "geographic", lng: 19, lat: 47 },
    });
    assert.equal(geoBlocked, next);
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-1", placement: { kind: "diagram", x: 1, y: 2 } });
    assert.deepEqual(resolvePlacement(next.assets["asset-1"], next.assets), { kind: "diagram", x: 1, y: 2 });
  });

  it("inherited display resolves through placed supports only", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-02");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-02"] });
    const noLink = inventoryReducer(next, { type: "PLACE", assetId: "asset-2", placement: { kind: "inherited" } });
    assert.equal(noLink, next);
    next = inventoryReducer(next, { type: "SUPPORT_ATTACH", luminaireId: "asset-2", support: { kind: "pole", poleAssetId: "asset-1" } });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-2", placement: { kind: "inherited" } });
    assert.deepEqual(resolvePlacement(next.assets["asset-2"], next.assets), { kind: "unknown" });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-1", placement: { kind: "diagram", x: 5, y: 6 } });
    assert.deepEqual(resolvePlacement(next.assets["asset-2"], next.assets), { kind: "diagram", x: 5, y: 6 });
  });

  it("unconfirms the asset when assigned evidence changes review state", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-05");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01", "demo-obs-05"] });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-1", placement: { kind: "diagram", x: 10, y: 20 } });
    next = inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-1" });
    assert.equal(next.assets["asset-1"].confirmed, true);
    // Returning evidence to pending keeps membership but reopens confirmation.
    next = inventoryReducer(next, { type: "OBS_DECIDE", id: "demo-obs-01", decision: "pending" });
    assert.deepEqual(next.assets["asset-1"].observationIds, ["demo-obs-01", "demo-obs-05"]);
    assert.equal(next.assets["asset-1"].confirmed, false);
    // Reaccepting does not reconfirm on its own: finishing stays blocked.
    next = decide(next, "demo-obs-01", "accepted");
    assert.equal(next.assets["asset-1"].confirmed, false);
    assert.ok(assessFinish(next).blockers.some((blocker) => blocker.includes("Unconfirmed assets")));
  });

  it("confirm requires evidence, support choice, and position-or-explicit-unknown", () => {
    let next = accept(withDetections(), "demo-obs-02");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-02"] });
    assert.equal(confirmChecks(next.assets["asset-1"], next).ok, false);
    assert.equal(inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-1" }), next);
    next = inventoryReducer(next, { type: "SUPPORT_ATTACH", luminaireId: "asset-1", support: { kind: "wall" } });
    assert.equal(confirmChecks(next.assets["asset-1"], next).ok, false);
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-1", placement: { kind: "unknown", explicit: true } });
    assert.equal(confirmChecks(next.assets["asset-1"], next).ok, true);
    next = inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-1" });
    assert.equal(next.assets["asset-1"].confirmed, true);
  });
});

describe("source and run provenance", () => {
  it("keeps fixtures and model output in their own session modes", () => {
    const demo = withDetections();
    const fixture = demo.observations["demo-obs-01"];
    const base = manualSession();
    const intoManual = inventoryReducer(base, { type: "OBS_ADD", observation: fixture });
    assert.equal(intoManual, base);
    assert.deepEqual(Object.keys(intoManual.observations), []);
    const samIntoDemo = inventoryReducer(demo, { type: "OBS_ADD", observation: samObs("sam-1") });
    assert.equal(samIntoDemo, demo);
    const wrongMode = inventoryReducer(manualSession(), {
      type: "OBS_ADD",
      observation: { ...samObs("sam-1"), mode: "demo" },
    });
    assert.deepEqual(Object.keys(wrongMode.observations), []);
    const allowed = inventoryReducer(manualSession(), { type: "OBS_ADD", observation: samObs("sam-1") });
    assert.deepEqual(Object.keys(allowed.observations), ["sam-1"]);
  });

  it("freezes one manifest and caps total views including crops", () => {
    const chosen = withManifest(2);
    assert.equal(chosen.manifest?.acked, true);
    assert.deepEqual(chosen.manifest?.viewIds, ["view-1", "view-2"]);
    assert.equal(chosen.manifest?.samplingNote, "evenly spaced");
    // Refining the selection is allowed until work starts.
    const reselect = inventoryReducer(chosen, {
      type: "SOURCES_CHOOSE",
      images: [sourceImage("img-9")],
      views: [sourceView("view-9", "img-9")],
      samplingNote: null,
    });
    assert.deepEqual(reselect.manifest?.viewIds, ["view-9"]);
    const worked = inventoryReducer(reselect, { type: "OBS_ADD", observation: samObs("sam-1") });
    const frozen = inventoryReducer(worked, {
      type: "SOURCES_CHOOSE",
      images: [sourceImage("img-9")],
      views: [sourceView("view-9", "img-9")],
      samplingNote: null,
    });
    assert.equal(frozen, worked);
    const noCrop = inventoryReducer(chosen, { type: "VIEW_ADD_CROP", view: sourceView("view-3", "img-1") });
    assert.equal(noCrop, chosen);
    let next = inventoryReducer(chosen, {
      type: "VIEW_ADD_CROP",
      view: sourceView("crop-1", "img-1", { x: 0, y: 0, w: 0.5, h: 0.5 }),
    });
    assert.ok(next.views["crop-1"]);
    for (let index = 2; index <= 8; index += 1) {
      next = inventoryReducer(next, {
        type: "VIEW_ADD_CROP",
        view: sourceView(`crop-${index}`, "img-1", { x: 0, y: 0, w: 0.5, h: 0.5 }),
      });
    }
    assert.equal(next.viewOrder.length, 10);
    const over = inventoryReducer(next, {
      type: "VIEW_ADD_CROP",
      view: sourceView("crop-9", "img-1", { x: 0, y: 0, w: 0.5, h: 0.5 }),
    });
    assert.equal(over, next);
  });

  it("tracks batch items and flags incomplete processing for acknowledgement", () => {
    let next = withManifest(2);
    next = inventoryReducer(next, {
      type: "RUN_START",
      run: {
        runId: "run-1",
        kind: "batch",
        createdAt: "2026-11-03T12:00:00.000Z",
        finishedAt: null,
        cancelled: false,
        items: [
          { itemId: "a", requestId: "r-a", viewId: "view-1", conceptId: "concept-pole", conceptText: "street light pole", categoryIntent: "pole", status: "queued", objects: [], model: null, error: null, attempts: 0, imported: false, startedAt: null, finishedAt: null },
          { itemId: "b", requestId: "r-b", viewId: "view-2", conceptId: "concept-pole", conceptText: "street light pole", categoryIntent: "pole", status: "queued", objects: [], model: null, error: null, attempts: 0, imported: false, startedAt: null, finishedAt: null },
        ],
      },
    });
    next = inventoryReducer(next, { type: "RUN_ITEM", runId: "run-1", itemId: "a", patch: { status: "succeeded", objects: [], imported: true } });
    assert.equal(incompleteRunItems(next).length, 1);
    assert.equal(assessFinish(next).needsIncompleteAck, true);
    assert.deepEqual(summarizeProcessing(next), {
      views: 2,
      succeededViews: 1,
      failedViews: 0,
      unprocessedViews: 1,
      concepts: ["street light pole"],
    });
    const unknown = inventoryReducer(next, { type: "RUN_ITEM", runId: "run-9", itemId: "a", patch: { status: "failed" } });
    assert.equal(unknown, next);
  });

  it("marks model masks stale when the annotation is manually changed", () => {
    let next = inventoryReducer(manualSession(), { type: "OBS_ADD", observation: samObs("sam-1") });
    next = inventoryReducer(next, {
      type: "OBS_SET_RECT",
      id: "sam-1",
      rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
    });
    assert.equal(next.observations["sam-1"].maskStale, true);
    assert.equal(next.observations["sam-1"].provenance?.geometrySource, "manual-adjusted");
    assert.equal(next.observations["sam-1"].origin, "sam-assisted");
  });

  it("reads recategorized model output as assisted, description edits as not", () => {
    let next = inventoryReducer(manualSession(), { type: "OBS_ADD", observation: samObs("sam-1") });
    next = inventoryReducer(next, { type: "OBS_EDIT", id: "sam-1", description: "tweaked wording" });
    assert.equal(next.observations["sam-1"].origin, "sam-text");
    next = inventoryReducer(next, { type: "OBS_EDIT", id: "sam-1", category: "uncertain" });
    assert.equal(next.observations["sam-1"].origin, "sam-assisted");
  });

  it("replaces sam-text output while keeping manual work and pruning assets", () => {
    let next = withManifest(1);
    next = inventoryReducer(next, { type: "OBS_ADD", observation: samObs("sam-1") });
    next = inventoryReducer(next, { type: "OBS_ADD", observation: samObs("sam-2", "sam-assisted") });
    next = decide(decide(next, "sam-1", "accepted"), "sam-2", "accepted");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["sam-1", "sam-2"] });
    next = inventoryReducer(next, {
      type: "PLACE",
      assetId: "asset-1",
      placement: { kind: "geographic", lng: 19.042, lat: 47.497 },
    });
    next = inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-1" });
    assert.equal(next.assets["asset-1"].confirmed, true);
    next = inventoryReducer(next, { type: "SAM_REPLACE", observations: [samObs("sam-3")] });
    assert.deepEqual(Object.keys(next.observations).sort(), ["sam-2", "sam-3"]);
    assert.deepEqual(next.assets["asset-1"].observationIds, ["sam-2"]);
    assert.equal(next.assets["asset-1"].confirmed, false);
    assert.equal(next.assets["asset-1"].streetSource, "osm");
  });

  it("carries street, origin, and processing provenance into the preview", () => {
    let next = withManifest(1);
    next = inventoryReducer(manualSession("manual-work-area"), {
      type: "SOURCES_CHOOSE",
      images: [sourceImage("img-1")],
      views: [sourceView("view-1", "img-1")],
      samplingNote: null,
    });
    next = inventoryReducer(next, { type: "OBS_ADD", observation: samObs("sam-1") });
    next = decide(next, "sam-1", "accepted");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["sam-1"] });
    next = inventoryReducer(next, {
      type: "PLACE",
      assetId: "asset-1",
      placement: { kind: "unknown", explicit: true },
    });
    next = inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-1" });
    const preview = buildPreviewResult(next, "2026-11-03T12:00:00.000Z");
    assert.equal(preview.streetSource, "manual-work-area");
    assert.deepEqual(preview.origins, ["sam-text"]);
    assert.equal(preview.model, "sam-3.1");
    assert.equal(preview.assets[0].streetSource, "manual-work-area");
    assert.ok(preview.limitations.some((line) => line.includes("Street assignment unverified")));
    assert.ok(preview.limitations.some((line) => line.includes("sam-3.1")));
  });
});

describe("finish assessment and preview", () => {
  it("blocks pending, unassigned, and unconfirmed work with specifics", () => {
    const fresh = assessFinish(withDetections());
    assert.equal(fresh.ok, false);
    assert.ok(fresh.blockers.some((blocker) => blocker.includes("pending")));
    let next = withDetections();
    for (const id of next.obsOrder) next = decide(next, id, "accepted");
    const unassigned = assessFinish(next);
    assert.ok(unassigned.blockers.some((blocker) => blocker.includes("not assigned")));
    assert.ok(unassigned.unassigned.length > 0);
  });

  it("blocks unfinished demo detection but allows manual sessions", () => {
    const demo = assessFinish(session());
    assert.ok(demo.blockers.some((blocker) => blocker.includes("demo detection")));
    const manual = createSession({
      key: "s", sessionId: "s", mode: "manual", streetId: "s", streetDisplayName: "S",
      context: { streetId: "s", streetDisplayName: "S", streetSource: "osm", roiRevision: 1, runId: "r", fingerprint: "f" },
    });
    const assessed = assessFinish(manual);
    assert.ok(!assessed.blockers.some((blocker) => blocker.includes("demo detection")));
    assert.equal(assessed.needsEmptyConfirm, true);
  });

  it("builds a frozen preview with separate pole/luminaire counts", () => {
    let next = accept(withDetections(), "demo-obs-01", "demo-obs-02");
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    next = inventoryReducer(next, { type: "ASSET_CREATE", observationIds: ["demo-obs-02"] });
    next = inventoryReducer(next, { type: "SUPPORT_ATTACH", luminaireId: "asset-2", support: { kind: "pole", poleAssetId: "asset-1" } });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-1", placement: { kind: "diagram", x: 1, y: 1 } });
    next = inventoryReducer(next, { type: "PLACE", assetId: "asset-2", placement: { kind: "inherited" } });
    next = inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-1" });
    next = inventoryReducer(next, { type: "ASSET_CONFIRM", assetId: "asset-2" });
    for (const id of next.obsOrder) {
      if (next.observations[id].decision === "pending") next = decide(next, id, "rejected");
    }
    assert.equal(assessFinish(next).ok, true);
    const preview = buildPreviewResult(next, "2026-11-03T12:00:00.000Z");
    assert.equal(preview.kind, "session-preview");
    assert.equal(preview.counts.poles, 1);
    assert.equal(preview.counts.luminaires, 1);
    assert.equal(preview.counts.placed, 2);
    assert.equal(preview.temporary, true);
    assert.ok(preview.limitations.some((line) => line.includes("not saved")));
    const finished = inventoryReducer(next, { type: "FINISH", result: preview });
    assert.equal(finished.finishedPreview?.finishedAt, "2026-11-03T12:00:00.000Z");
    const edited = inventoryReducer(finished, { type: "OBS_EDIT", id: "demo-obs-01", description: "changed" });
    assert.equal(edited.finishedPreview, null);
    const counts = deriveCounts(next);
    assert.equal(counts.assets, 2);
    assert.equal(counts.confirmed, 2);
  });
});
