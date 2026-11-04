import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useInventorySessions,
  type InventorySessions,
  type UseInventorySessionsOptions,
} from "./useInventorySessions";
import { DEMO_IMAGES } from "./demoFixtures";
import type { InventoryObservation } from "./inventoryTypes";

const LIVE = { roiRevision: 1, runId: "prep-1", fingerprint: "aaa" };
const RING = [
  [19.04, 47.495],
  [19.045, 47.495],
  [19.045, 47.5],
  [19.04, 47.5],
  [19.04, 47.495],
] as [number, number][];

function options(overrides: Partial<UseInventorySessionsOptions> = {}): UseInventorySessionsOptions {
  return { liveContext: LIVE, roiRing: RING, ...overrides };
}

function manualObs(id: string, mode: "manual" | "demo" = "manual"): InventoryObservation {
  return {
    id,
    imageId: mode === "demo" ? "demo-image-01" : "img-1",
    viewId: null,
    category: "pole",
    description: "a pole",
    imageRegion: null,
    mask: null,
    maskStale: false,
    origin: "manual",
    provenance: null,
    mode,
    decision: "pending",
    note: "",
  };
}

function sourceImage(imageId: string) {
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

function sourceView(viewId: string, imageId: string) {
  return {
    viewId,
    imageId,
    fullWidth: 800,
    fullHeight: 600,
    orientation: 1,
    isPano: false,
    crop: null,
    width: 800,
    height: 600,
    mediaHandle: `h-${viewId}`,
    artifactId: null,
    fullyReviewed: false,
  };
}

function samResponse(requestId: string, viewId: string, count: number): Record<string, unknown> {
  const objects = Array.from({ length: count }, (_, index) => ({
    providerObjectId: String(index),
    box: { left: 80, top: 60, right: 240, bottom: 300 },
    boxNorm: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
    confidence: 0.9,
    mask: null,
  }));
  return {
    requestId,
    viewId,
    provider: "meta-sam",
    model: "sam-3.1",
    prompt: "street light pole",
    categoryIntent: "pole",
    inputWidth: 800,
    inputHeight: 600,
    objects,
    truncated: false,
    retrievedAt: "2026-11-03T12:00:00.000Z",
  };
}

/** Mock SAM fetch that echoes each request's IDs with a scripted object count. */
function mockSamFetch(script: { count: number }[]) {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string; view: { viewId: string } };
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(samResponse(body.requestId, body.view.viewId, step.count)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  };
}

function detectionOptions(overrides: Partial<UseInventorySessionsOptions> = {}): UseInventorySessionsOptions {
  return options({
    prepareRaster: async () => ({ mimeType: "image/jpeg", dataBase64: "QUJD", width: 800, height: 600 }),
    ...overrides,
  });
}

function openStreetWithSources(sessions: { current: InventorySessions }, views = 1) {
  act(() => {
    sessions.current.openStreet("street-1", "Main Street");
  });
  const images = Array.from({ length: views }, (_, index) => sourceImage(`img-${index + 1}`));
  const viewRecords = Array.from({ length: views }, (_, index) => sourceView(`view-${index + 1}`, `img-${index + 1}`));
  act(() => {
    sessions.current.dispatch({ type: "SOURCES_CHOOSE", images, views: viewRecords, samplingNote: null });
  });
}

const ALL_IMAGES = DEMO_IMAGES.map((image) => image.id);

describe("useInventorySessions", () => {
  it("opens isolated demo and street sessions and preserves both on switch", () => {
    const { result } = renderHook(() => useInventorySessions(options()));
    act(() => {
      result.current.openDemo();
    });
    expect(result.current.activeKey).toBe("demo");
    expect(result.current.activeSession?.observations).toEqual({});
    act(() => {
      result.current.openStreet("street-1", "Main Street");
    });
    expect(result.current.activeKey).toBe("street-1");
    expect(result.current.activeSession?.mode).toBe("manual");
    expect(result.current.activeSession?.context.runId).toBe("prep-1");
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-1") });
    });
    act(() => {
      result.current.switchSession("demo");
    });
    expect(result.current.activeSession?.observations).toEqual({});
    act(() => {
      result.current.switchSession("street-1");
    });
    expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual(["obs-1"]);
    act(() => {
      result.current.closeWorkspace();
    });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeSession?.observations["obs-1"]).toBeDefined();
  });

  it("runs demo detection atomically and suppresses late callbacks after cancel", async () => {
    const { result } = renderHook(() => useInventorySessions(options()));
    act(() => {
      result.current.openDemo();
    });
    act(() => {
      result.current.runDetection("happy", ALL_IMAGES, false);
    });
    expect(result.current.activeSession?.detection.status).toBe("running");
    await waitFor(() => {
      expect(result.current.activeSession?.detection.status).toBe("finished");
    });
    expect(Object.keys(result.current.activeSession?.observations ?? {})).toHaveLength(11);

    // A second run without replace is refused; cancel mid-replace stays atomic.
    act(() => {
      result.current.runDetection("happy", ALL_IMAGES, false);
    });
    expect(result.current.activeSession?.detection.status).toBe("finished");
    act(() => {
      result.current.runDetection("happy", ALL_IMAGES, true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      result.current.cancelDetection();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(result.current.activeSession?.detection.status).toBe("cancelled");
    // The cancelled rerun left the previous observation set untouched.
    expect(Object.keys(result.current.activeSession?.observations ?? {})).toHaveLength(11);
  });

  it("reports empty and error demo scenarios distinctly", async () => {
    const { result } = renderHook(() => useInventorySessions(options()));
    act(() => {
      result.current.openDemo();
    });
    act(() => {
      result.current.runDetection("empty", ALL_IMAGES, false);
    });
    await waitFor(() => {
      expect(result.current.activeSession?.detection.status).toBe("finished");
    });
    expect(result.current.activeSession?.detection).toMatchObject({ empty: true, observationCount: 0 });
    act(() => {
      result.current.resetSession();
    });
    act(() => {
      result.current.runDetection("error", ALL_IMAGES, false);
    });
    await waitFor(() => {
      expect(result.current.activeSession?.detection.status).toBe("failed");
    });
    expect(Object.keys(result.current.activeSession?.observations ?? {})).toHaveLength(0);
  });

  it("undoes grouping operations with labels and invalidates finished results", async () => {
    const { result } = renderHook(() => useInventorySessions(options()));
    act(() => {
      result.current.openDemo();
    });
    act(() => {
      result.current.runDetection("happy", ["demo-image-01"], false);
    });
    await waitFor(() => {
      expect(result.current.activeSession?.detection.status).toBe("finished");
    });
    act(() => {
      result.current.dispatch({ type: "OBS_DECIDE", id: "demo-obs-01", decision: "accepted" });
    });
    act(() => {
      result.current.dispatch({ type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoLabel).toBe("Create asset");
    act(() => {
      result.current.undo();
    });
    expect(result.current.activeSession?.assets).toEqual({});
    expect(result.current.undoLabel).toBe("accepted demo-obs-01");
    act(() => {
      result.current.undo();
    });
    expect(result.current.activeSession?.observations["demo-obs-01"].decision).toBe("pending");
    expect(result.current.canUndo).toBe(false);
  });

  it("refuses undo while the active session is stale", () => {
    const { result, rerender } = renderHook(
      ({ opts }: { opts: UseInventorySessionsOptions }) => useInventorySessions(opts),
      { initialProps: { opts: options() } },
    );
    act(() => {
      result.current.openStreet("street-1", "Main Street");
    });
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-1") });
    });
    expect(result.current.canUndo).toBe(true);
    rerender({ opts: options({ liveContext: { roiRevision: 2, runId: "prep-1", fingerprint: "aaa" } }) });
    expect(result.current.isStale(result.current.activeSession!)).toBe(true);
    expect(result.current.canUndo).toBe(false);
    act(() => {
      result.current.undo();
    });
    // The stale session is read-only: work and history survive the refused undo.
    expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual(["obs-1"]);
    expect(result.current.histories["street-1"]).toHaveLength(1);
  });

  it("marks sessions stale on context change and restarts explicitly", () => {
    const { result, rerender } = renderHook(
      ({ opts }: { opts: UseInventorySessionsOptions }) => useInventorySessions(opts),
      { initialProps: { opts: options() } },
    );
    act(() => {
      result.current.openStreet("street-1", "Main Street");
    });
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-1") });
    });
    rerender({ opts: options({ liveContext: { roiRevision: 1, runId: "prep-1", fingerprint: "bbb" } }) });
    const stale = result.current.activeSession;
    expect(stale && result.current.isStale(stale)).toBe(true);
    expect(stale && result.current.staleReason(stale)).toContain("selection or imagery");
    // Read-only while stale: mutations are ignored.
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-2") });
    });
    expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual(["obs-1"]);
    act(() => {
      result.current.restartSession();
    });
    expect(result.current.activeSession?.observations).toEqual({});
    expect(result.current.activeSession?.context.fingerprint).toBe("bbb");
    expect(result.current.isStale(result.current.activeSession!)).toBe(false);
  });

  it("finishes a reviewed manual session and reopens review on later edits", () => {
    const { result } = renderHook(() => useInventorySessions(options()));
    act(() => {
      result.current.openStreet("street-1", "Main Street");
    });
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-1") });
    });
    let assessment = result.current.finishPreview(false, false);
    expect(assessment.finished).toBe(false);
    expect(assessment.blockers.some((blocker) => blocker.includes("pending"))).toBe(true);
    act(() => {
      result.current.dispatch({ type: "OBS_DECIDE", id: "obs-1", decision: "accepted" });
    });
    act(() => {
      result.current.dispatch({ type: "ASSET_CREATE", observationIds: ["obs-1"] });
    });
    act(() => {
      result.current.dispatch({
        type: "PLACE",
        assetId: "asset-1",
        placement: { kind: "unknown", explicit: true },
      });
    });
    act(() => {
      result.current.dispatch({ type: "ASSET_CONFIRM", assetId: "asset-1" });
    });
    assessment = result.current.finishPreview(false, false);
    expect(assessment.finished).toBe(false);
    expect(assessment.needsUnresolvedAck).toBe(true);
    act(() => {
      assessment = result.current.finishPreview(true, false);
    });
    expect(assessment.finished).toBe(true);
    expect(result.current.activeSession?.finishedPreview?.kind).toBe("session-preview");
    expect(result.current.activeSession?.finishedPreview?.counts.poles).toBe(1);
    act(() => {
      result.current.dispatch({ type: "OBS_EDIT", id: "obs-1", description: "changed" });
    });
    expect(result.current.activeSession?.finishedPreview).toBeNull();
  });

  it("applies geographic placements inside the region and rejects outside ones", () => {
    const { result } = renderHook(() => useInventorySessions(options()));
    act(() => {
      result.current.openStreet("street-1", "Main Street");
    });
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-1") });
    });
    act(() => {
      result.current.dispatch({ type: "OBS_DECIDE", id: "obs-1", decision: "accepted" });
    });
    act(() => {
      result.current.dispatch({ type: "ASSET_CREATE", observationIds: ["obs-1"] });
    });
    act(() => {
      result.current.armPlacement("asset-1");
    });
    act(() => {
      result.current.setPlacementDraft({ geo: [47.0, 19.0] });
    });
    let error: string | null = null;
    act(() => {
      error = result.current.applyPlacement();
    });
    expect(error).toContain("inside the current region");
    act(() => {
      result.current.setPlacementDraft({ geo: [47.497, 19.042] });
    });
    act(() => {
      error = result.current.applyPlacement();
    });
    expect(error).toBeNull();
    expect(result.current.activeSession?.assets["asset-1"].placement).toEqual({
      kind: "geographic",
      lng: 19.042,
      lat: 47.497,
    });
  });

  describe("SAM test/batch queue", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("stages one test and imports it exactly once", async () => {
      const sam = mockSamFetch([{ count: 2 }]);
      vi.stubGlobal("fetch", sam.fetch);
      const { result } = renderHook(() => useInventorySessions(detectionOptions()));
      openStreetWithSources(result);
      let error: string | null = "unset";
      act(() => {
        error = result.current.runTest("view-1", "concept-pole");
      });
      expect(error).toBeNull();
      await waitFor(() => {
        expect(result.current.activeSession?.stagedTest).toEqual({ runId: "run-1", itemId: "run-1-item-1" });
      });
      expect(sam.calls()).toBe(1);
      act(() => {
        error = result.current.importStagedTest();
      });
      expect(error).toBeNull();
      const observations = result.current.activeSession?.observations ?? {};
      expect(Object.keys(observations)).toEqual(["obs-1", "obs-2"]);
      expect(observations["obs-1"].origin).toBe("sam-text");
      expect(observations["obs-1"].provenance?.model).toBe("sam-3.1");
      expect(observations["obs-1"].provenance?.requestId).toBe(
        result.current.activeSession?.runs[0].items[0].requestId,
      );
      expect(result.current.activeSession?.stagedTest).toBeNull();
      // Re-importing the cleared stage adds nothing.
      act(() => {
        error = result.current.importStagedTest();
      });
      expect(error).toContain("No staged test");
      expect(Object.keys(result.current.activeSession?.observations ?? {})).toHaveLength(2);
      expect(sam.calls()).toBe(1);
    });

    it("cancels a batch without touching completed items, then resumes", async () => {
      let releaseSecond!: (response: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        releaseSecond = resolve;
      });
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { requestId: string; view: { viewId: string } };
          calls += 1;
          if (calls === 2) return gate;
          return new Response(JSON.stringify(samResponse(body.requestId, body.view.viewId, 1)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      );
      const { result } = renderHook(() => useInventorySessions(detectionOptions()));
      openStreetWithSources(result, 2);
      act(() => {
        result.current.dispatch({ type: "CONCEPT_UPDATE", id: "concept-fixture", patch: { enabled: false } });
      });
      let error: string | null = "unset";
      act(() => {
        error = result.current.runBatch(false);
      });
      expect(error).toBeNull();
      await waitFor(() => {
        expect(result.current.activeSession?.runs[0]?.items[0]?.status).toBe("succeeded");
      });
      // Second view × concept is still detecting; cancel it.
      act(() => {
        result.current.cancelBatch();
      });
      releaseSecond(
        new Response(JSON.stringify(samResponse("late", "view-1", 5)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await waitFor(() => {
        expect(result.current.activeSession?.runs[0]?.cancelled).toBe(true);
      });
      const run = result.current.activeSession?.runs[0];
      expect(run?.items.map((item) => item.status)).toEqual(["succeeded", "cancelled"]);
      // Late success is orphaned: only the first item's sighting exists.
      expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual(["obs-1"]);
      expect(result.current.busyKeys).toEqual([]);
      act(() => {
        error = result.current.retryFailed("run-1");
      });
      expect(error).toBeNull();
      // Retry appends a superseding attempt; the cancelled item keeps its outcome.
      await waitFor(() => {
        expect(result.current.activeSession?.runs[0]?.items[2]?.status).toBe("succeeded");
      });
      expect(result.current.activeSession?.runs[0]?.items[1]?.status).toBe("cancelled");
      expect(result.current.activeSession?.runs[0]?.items[2]?.supersedes).toBe(
        result.current.activeSession?.runs[0]?.items[1]?.itemId,
      );
      expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual(["obs-1", "obs-2"]);
    });

    it("refuses silent replacement and guards stale sessions", async () => {
      const sam = mockSamFetch([{ count: 1 }]);
      vi.stubGlobal("fetch", sam.fetch);
      const { result, rerender } = renderHook(
        ({ opts }: { opts: UseInventorySessionsOptions }) => useInventorySessions(opts),
        { initialProps: { opts: detectionOptions() } },
      );
      openStreetWithSources(result);
      act(() => {
        result.current.dispatch({ type: "CONCEPT_UPDATE", id: "concept-fixture", patch: { enabled: false } });
      });
      act(() => {
        expect(result.current.runBatch(false)).toBeNull();
      });
      await waitFor(() => {
        expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual(["obs-1"]);
      });
      // A second batch without replace is refused; nothing is re-spent.
      expect(result.current.runBatch(false)).toContain("replace it explicitly");
      expect(sam.calls()).toBe(1);
      // Stale sessions cannot start runs or accept late item updates.
      rerender({ opts: detectionOptions({ liveContext: { roiRevision: 2, runId: "prep-1", fingerprint: "aaa" } }) });
      expect(result.current.runTest("view-1", "concept-pole")).toContain("restart the preview");
      act(() => {
        result.current.dispatch({
          type: "RUN_ITEM",
          runId: "run-1",
          itemId: "run-1-item-1",
          patch: { status: "failed", error: "late" },
        });
      });
      expect(result.current.activeSession?.runs[0]?.items[0]?.status).toBe("succeeded");
    });

    it("retries one item as a linked attempt and refuses superseded or usable ones", async () => {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { requestId: string; view: { viewId: string } };
          calls += 1;
          const requestId = calls === 1 ? "wrong-request" : body.requestId;
          return new Response(JSON.stringify(samResponse(requestId, body.view.viewId, 1)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      );
      const { result } = renderHook(() => useInventorySessions(detectionOptions()));
      openStreetWithSources(result);
      act(() => {
        result.current.dispatch({ type: "CONCEPT_UPDATE", id: "concept-fixture", patch: { enabled: false } });
      });
      act(() => {
        expect(result.current.runBatch(false)).toBeNull();
      });
      await waitFor(() => {
        expect(result.current.activeSession?.runs[0]?.items[0]?.status).toBe("failed");
      });
      const firstId = result.current.activeSession?.runs[0]?.items[0]?.itemId ?? "";
      act(() => {
        expect(result.current.retryItem("run-1", firstId)).toBeNull();
      });
      await waitFor(() => {
        expect(result.current.activeSession?.runs[0]?.items[1]?.status).toBe("succeeded");
      });
      const items = result.current.activeSession?.runs[0]?.items ?? [];
      expect(items[1]?.supersedes).toBe(firstId);
      expect(items[0]?.status).toBe("failed");
      // The superseded failure and the usable retry are not retryable again.
      expect(result.current.retryItem("run-1", firstId)).toContain("supersedes");
      expect(result.current.retryItem("run-1", items[1]?.itemId ?? "")).toContain("Nothing to retry");
      expect(result.current.retryItem("run-1", "missing-item")).toContain("Nothing to retry");
      expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual(["obs-1"]);
    });

    it("fails items on mismatched responses instead of attaching them", async () => {
      vi.stubGlobal(
        "fetch",
        (async () =>
          new Response(JSON.stringify(samResponse("wrong-request", "view-1", 3)), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      );
      const { result } = renderHook(() => useInventorySessions(detectionOptions()));
      openStreetWithSources(result);
      act(() => {
        expect(result.current.runTest("view-1", "concept-pole")).toBeNull();
      });
      await waitFor(() => {
        expect(result.current.activeSession?.runs[0]?.items[0]?.status).toBe("failed");
      });
      expect(result.current.activeSession?.runs[0]?.items[0]?.error).toContain("did not match");
      expect(result.current.activeSession?.stagedTest).toBeNull();
      expect(Object.keys(result.current.activeSession?.observations ?? {})).toEqual([]);
    });
  });

  it("tracks dirty state and discards everything on workspace clear", () => {
    const { result } = renderHook(() => useInventorySessions(options()));
    act(() => {
      result.current.openDemo();
    });
    expect(result.current.hasDirty).toBe(false);
    act(() => {
      result.current.dispatch({ type: "SET_STEP", step: "review" });
    });
    expect(result.current.hasDirty).toBe(false);
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-9", "demo") });
    });
    expect(result.current.hasDirty).toBe(true);
    act(() => {
      result.current.resetSession();
    });
    expect(result.current.hasDirty).toBe(false);
    act(() => {
      result.current.dispatch({ type: "OBS_ADD", observation: manualObs("obs-9", "demo") });
    });
    act(() => {
      result.current.discardAll();
    });
    expect(result.current.sessions).toEqual({});
    expect(result.current.isOpen).toBe(false);
    expect(result.current.hasDirty).toBe(false);
  });
});
