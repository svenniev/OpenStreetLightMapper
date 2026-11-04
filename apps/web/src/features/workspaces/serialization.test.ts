import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../inventory/inventoryReducer.js";
import type { WorkflowSession } from "../inventory/inventoryTypes.js";
import {
  buildImagerySnapshotPayload,
  buildWorkspaceBody,
  normalizeDiscoveryStatus,
  normalizePreparationState,
  restoreSession,
  restoreWorkspaceSeed,
  serializeSession,
} from "./serialization.js";

function manualSession(): WorkflowSession {
  return createSession({
    key: "street-1",
    sessionId: "s-street-1",
    mode: "manual",
    streetId: "street-1",
    streetDisplayName: "Main St",
    context: {
      streetId: "street-1",
      streetDisplayName: "Main St",
      streetSource: "osm",
      roiRevision: 3,
      runId: "prep-3-1-1-r1",
      fingerprint: "abc123",
    },
  });
}

describe("workspace serialization", () => {
  it("normalizes in-flight states at save time", () => {
    assert.equal(normalizeDiscoveryStatus("loading", 0), "idle");
    assert.equal(normalizeDiscoveryStatus("results", 0), "empty");
    assert.equal(normalizeDiscoveryStatus("failed", 2), "failed");
    assert.equal(normalizePreparationState("preparing"), "cancelled");
    assert.equal(normalizePreparationState("prepared"), "prepared");
  });

  it("caps imagery snapshots with an explicit truncated count", () => {
    const seeds = Array.from({ length: 4000 }, (_, index) => ({
      id: `seed-${index}`,
      coordinate: [19.04, 47.49] as [number, number],
      coordinateSource: "geometry" as const,
      originalCoordinate: null,
      computedCoordinate: null,
      capturedAt: null,
      isPano: false as const,
      sequenceId: "seq-1",
    }));
    const pool = [...seeds, ...Array.from({ length: 2000 }, (_, index) => ({
      id: `hyd-${index}`,
      coordinate: [19.05, 47.5] as [number, number],
      coordinateSource: "geometry" as const,
      originalCoordinate: null,
      computedCoordinate: null,
      capturedAt: null,
      isPano: false as const,
      sequenceId: "seq-1",
      inRoi: true,
    }))];
    const payload = buildImagerySnapshotPayload({
      query: { matchedCount: 6000 } as never,
      warnings: [],
      status: "results",
      everSearched: true,
      seeds,
      pool,
    });
    assert.equal(payload.seeds.length + payload.hydrated.length, 5000);
    assert.equal(payload.truncatedCount, 1000);
    assert.ok(payload.hydrated.every((image) => !image.id.startsWith("seed-")));
  });

  it("strips masks, handles, and parsed objects from stored sessions", () => {
    const session = manualSession();
    session.views["view-1"] = {
      viewId: "view-1",
      imageId: "img-1",
      fullWidth: 800,
      fullHeight: 600,
      orientation: 1,
      isPano: false,
      crop: null,
      width: 800,
      height: 600,
      mediaHandle: "live-handle",
      artifactId: "0123456789abcdef01234567",
      fullyReviewed: false,
    };
    session.viewOrder = ["view-1"];
    session.observations["obs-1"] = {
      id: "obs-1",
      imageId: "img-1",
      viewId: "view-1",
      category: "pole",
      description: "SAM pole",
      imageRegion: { x: 0, y: 0, w: 0.5, h: 0.5 },
      mask: { svgPath: "M0 0h1v1H0z", width: 8, height: 8, bounds: { left: 0, top: 0, right: 8, bottom: 8 } },
      maskStale: false,
      origin: "sam-text",
      provenance: {
        provider: "meta-sam",
        model: "sam-3.1",
        prompt: "street light pole",
        categoryIntent: "pole",
        runId: "run-1",
        itemId: "run-1-item-1",
        requestId: "req-1",
        providerObjectId: "0",
        confidence: 0.9,
        geometrySource: "model",
      },
      mode: "manual",
      decision: "pending",
      note: "",
    };
    session.obsOrder = ["obs-1"];
    session.runs = [
      {
        runId: "run-1",
        kind: "batch",
        createdAt: "2026-11-03T12:00:00.000Z",
        finishedAt: null,
        cancelled: false,
        viewIds: ["view-1"],
        conceptIds: ["concept-pole"],
        items: [
          {
            itemId: "run-1-item-1",
            requestId: "req-1",
            viewId: "view-1",
            conceptId: "concept-pole",
            conceptText: "street light pole",
            categoryIntent: "pole",
            status: "succeeded",
            objects: [
              { providerObjectId: "0", box: { x: 0, y: 0, w: 0.5, h: 0.5 }, confidence: 0.9, mask: null },
            ],
            model: "sam-3.1",
            error: null,
            attempts: 1,
            truncated: false,
            invalidDiscarded: 0,
            artifactId: "0123456789abcdef01234567",
            supersedes: null,
            imported: true,
            resultSaved: true,
            registered: true,
            startedAt: "2026-11-03T12:00:00.000Z",
            finishedAt: "2026-11-03T12:00:01.000Z",
          },
        ],
      },
    ];
    const stored = serializeSession(session);
    const views = stored.views as Record<string, { mediaHandle: string; artifactId: string | null }>;
    assert.equal(views["view-1"].mediaHandle, "");
    assert.equal(views["view-1"].artifactId, "0123456789abcdef01234567");
    const observations = stored.observations as Record<string, { mask: null }>;
    assert.equal(observations["obs-1"].mask, null);
    const runs = stored.runs as { items: { objects: unknown[] }[] }[];
    assert.deepEqual(runs[0].items[0].objects, []);
    // The live session keeps its pixels; only the stored copy is stripped.
    assert.equal(session.views["view-1"].mediaHandle, "live-handle");
    assert.ok(session.observations["obs-1"].mask);

    const restored = restoreSession(stored);
    assert.equal(restored.views["view-1"].mediaHandle, "");
    assert.equal(restored.views["view-1"].artifactId, "0123456789abcdef01234567");
    assert.equal(restored.observations["obs-1"].provenance?.itemId, "run-1-item-1");
    assert.deepEqual(restored.runs[0].items[0].objects, []);
  });

  it("refuses demo sessions and malformed restores", () => {
    const demo = createSession({
      key: "demo",
      sessionId: "demo",
      mode: "demo",
      streetId: "demo-street",
      streetDisplayName: "Demo",
      context: {
        streetId: "demo-street",
        streetDisplayName: "Demo",
        streetSource: "synthetic-demo",
        roiRevision: null,
        runId: null,
        fingerprint: null,
      },
    });
    assert.throws(() => serializeSession(demo), /Only manual sessions persist/);
    assert.throws(() => restoreSession({ mode: "manual" }), /malformed/);
  });

  it("round-trips a workspace body through its restore seed", () => {
    const body = buildWorkspaceBody({
      name: "Round trip",
      roi: {
        revision: 3,
        shape: "rectangle",
        polygon: { type: "Polygon", coordinates: [[[19, 47], [20, 47], [20, 48], [19, 48], [19, 47]]] },
        areaSqM: 1000,
        bbox: [19, 47, 20, 48],
        valid: true,
        errorCode: null,
        errorMessage: null,
        center: { lng: 19.5, lat: 47.5 },
        zoom: 14,
      },
      imagerySnapshotId: "sn-a",
      imagerySelection: {
        status: "results",
        everSearched: true,
        imagerySnapshotId: 2,
        warnings: ["w1"],
        searchError: null,
        selectedSequenceId: "seq-1",
        selectedUngroupedId: null,
        scope: "inside",
        filter: "all",
        loads: {
          "seq-1": {
            state: "loaded",
            memberIds: ["img-1"],
            membershipStatus: "complete",
            counts: null,
            warnings: [],
            error: null,
            retrievedAt: "2026-11-03T12:00:00.000Z",
          },
        },
        requestedImageId: "img-1",
        viewerImageId: "img-1",
        truncatedCount: 0,
        autoSequenceIds: ["seq-1", "seq-gone"],
      },
      streetSnapshotId: "sn-b",
      streetSelection: {
        status: "loaded",
        checkedIds: ["street-1"],
        focusedId: null,
        seeded: false,
        snapshotId: 1,
        warnings: [],
        error: null,
      },
      preparation: { runState: "prepared", plan: { runId: "prep-1" } as never, failedStreetIds: [], failureReasons: {} },
      activeSessionKey: "street-1",
      sessionKeys: ["street-1"],
    });
    const seed = restoreWorkspaceSeed(
      body,
      {
        seeds: [
          {
            id: "img-1",
            coordinate: [19.5, 47.5],
            coordinateSource: "geometry",
            originalCoordinate: null,
            computedCoordinate: null,
            capturedAt: null,
            isPano: false,
            sequenceId: "seq-1",
          },
        ],
        hydrated: [],
        query: { matchedCount: 1 },
      },
      { streets: [], query: null },
    );
    assert.equal(seed.roi?.id, 3);
    assert.deepEqual(seed.mapView, { center: [47.5, 19.5], zoom: 14 });
    assert.equal(seed.imagery?.images.length, 1);
    assert.equal(seed.imagery?.requestedImageId, "img-1");
    assert.equal(seed.sequences.selectedSequenceId, "seq-1");
    assert.deepEqual(seed.sequences.loads["seq-1"].memberIds, ["img-1"]);
    assert.deepEqual(seed.sequences.autoSequenceIds, ["seq-1", "seq-gone"]);
    assert.deepEqual(seed.streets.checkedIds, ["street-1"]);
    assert.equal(seed.preparation.runState, "prepared");
    assert.equal(seed.activeSessionKey, "street-1");
  });

  it("restores an empty workspace without snapshots", () => {
    const seed = restoreWorkspaceSeed(
      buildWorkspaceBody({
        name: "Empty",
        roi: null,
        imagerySnapshotId: null,
        imagerySelection: {
          status: "idle",
          everSearched: false,
          imagerySnapshotId: 0,
          warnings: [],
          searchError: null,
          selectedSequenceId: null,
          selectedUngroupedId: null,
          scope: "inside",
          filter: "all",
          loads: {},
          requestedImageId: null,
          viewerImageId: null,
          truncatedCount: 0,
          autoSequenceIds: [],
        },
        streetSnapshotId: null,
        streetSelection: {
          status: "idle",
          checkedIds: [],
          focusedId: null,
          seeded: false,
          snapshotId: 0,
          warnings: [],
          error: null,
        },
        preparation: { runState: "not_started", plan: null, failedStreetIds: [], failureReasons: {} },
        activeSessionKey: null,
        sessionKeys: [],
      }),
      null,
      null,
    );
    assert.equal(seed.roi, null);
    assert.equal(seed.imagery, null);
    assert.deepEqual(seed.sessionKeys, []);
  });
});
