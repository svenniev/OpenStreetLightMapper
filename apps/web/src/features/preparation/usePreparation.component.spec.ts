import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StreetWorkItem } from "../../lib/api";
import type { CommittedRoi, ImageResult } from "../../lib/searchTypes";
import type { SequenceRef } from "../sequences/useSequences";
import { usePreparation, type UsePreparationOptions } from "./usePreparation";

function roi(id: number): CommittedRoi {
  return {
    id,
    shape: "rectangle",
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [19, 47],
          [19.01, 47],
          [19.01, 47.01],
          [19, 47],
        ],
      ],
    },
    areaSqM: 50000,
    bbox: [19, 47, 19.01, 47.01],
    valid: true,
    errorCode: null,
    errorMessage: null,
  };
}

function street(id: string, name: string): StreetWorkItem {
  return {
    id,
    displayName: name,
    partLabel: null,
    name,
    ref: null,
    wayIds: [100 + id.length],
    segments: [],
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [
          [19.0, 47.5],
          [19.001, 47.501],
        ],
      ],
    },
    lengthM: 120,
  };
}

function image(id: string, inRoi?: boolean): ImageResult {
  return {
    id,
    coordinate: [19.0, 47.5],
    coordinateSource: "geometry",
    originalCoordinate: null,
    computedCoordinate: null,
    capturedAt: null,
    isPano: null,
    sequenceId: "seq-1",
    ...(inRoi === undefined ? {} : { inRoi }),
  };
}

const sequenceRefs: SequenceRef[] = [
  { sequenceId: "seq-1", loadState: "loaded", memberTotal: 3, loadedCount: 2, unresolvedCount: 1 },
];

function options(overrides: Partial<UsePreparationOptions> = {}): UsePreparationOptions {
  return {
    roi: roi(1),
    streetsStatus: "loaded",
    streets: [street("a", "Main Street"), street("b", "Side Lane")],
    streetSnapshotId: 1,
    streetWarnings: [],
    streetRetrievedAt: "2026-11-03T10:00:00.000Z",
    streetSeeded: false,
    checkedIds: new Set(["a", "b"]),
    selectionVersion: 0,
    discoveryStatus: "results",
    discoveryWarnings: [],
    images: [image("img-1"), image("img-2", true), image("img-out", false)],
    imagerySnapshotId: 1,
    sequenceRefs,
    detailLoading: false,
    drawingActive: false,
    ...overrides,
  };
}

describe("usePreparation", () => {
  it("reports a specific disabled reason for each unmet input", () => {
    const cases: Array<[Partial<UsePreparationOptions>, string]> = [
      [{ roi: null }, "Commit a valid region first."],
      [{ streetsStatus: "loading" }, "Street retrieval is still running."],
      [{ streetsStatus: "failed" }, "Street retrieval for this region has not completed."],
      [{ streets: [], checkedIds: new Set() }, "No eligible streets were found in this region."],
      [{ checkedIds: new Set() }, "Check at least one street."],
      [{ discoveryStatus: "loading" }, "Mapillary discovery is still running."],
      [{ discoveryStatus: "idle" }, "Run Mapillary discovery for this region first."],
      [{ discoveryStatus: "failed" }, "Mapillary discovery failed — search again before preparing."],
      [{ detailLoading: true }, "A sequence detail request is still running."],
      [{ drawingActive: true }, "Finish or cancel drawing first."],
    ];
    for (const [override, reason] of cases) {
      const { result, unmount } = renderHook(() => usePreparation(options(override)));
      expect(result.current.disabledReason).toBe(reason);
      expect(result.current.canStart).toBe(false);
      unmount();
    }
    const { result } = renderHook(() => usePreparation(options()));
    expect(result.current.disabledReason).toBeNull();
    expect(result.current.canStart).toBe(true);
  });

  it("builds one work item per checked street over the in-RoI pool", async () => {
    const { result } = renderHook(() =>
      usePreparation(options({ checkedIds: new Set(["b"]) })),
    );
    act(() => {
      result.current.start();
    });
    expect(result.current.runState).toBe("preparing");
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    const plan = result.current.plan;
    expect(plan?.streetItems).toEqual([
      {
        streetId: "b",
        displayName: "Side Lane",
        wayIds: [101],
        lengthM: 120,
        imageAssociation: "pending",
      },
    ]);
    // Outside-RoI context members never enter the processing input pool.
    expect(plan?.imagePool.imageIds).toEqual(["img-1", "img-2"]);
    expect(plan?.imagePool.count).toBe(2);
    expect(plan?.roiRevision).toBe(1);
    expect(plan?.inventoryStatus).toBe("not_started");
    expect(plan?.sequenceRefs).toHaveLength(1);
    expect(result.current.workflowStatuses.get("a")).toBe("excluded");
    expect(result.current.workflowStatuses.get("b")).toBe("prepared");
  });

  it("preserves provider warnings in the plan without claiming completeness", async () => {
    const { result } = renderHook(() =>
      usePreparation(
        options({
          discoveryWarnings: ["POSSIBLY_TRUNCATED"],
          streetWarnings: ["OVERPASS_TIMEOUT"],
        }),
      ),
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    expect(result.current.plan?.warnings).toEqual(["POSSIBLY_TRUNCATED", "OVERPASS_TIMEOUT"]);
  });

  it("ignores display-only sequence browsing that leaves the pool unchanged", async () => {
    const initial = options();
    const { result, rerender } = renderHook(
      ({ opts }: { opts: UsePreparationOptions }) => usePreparation(opts),
      { initialProps: { opts: initial } },
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    // A detail load that resolves with zero new pool members changes browsing
    // state only; the prepared inputs are identical.
    rerender({
      opts: options({
        sequenceRefs: [
          { sequenceId: "seq-1", loadState: "loaded", memberTotal: 2, loadedCount: 2, unresolvedCount: 0 },
        ],
      }),
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(result.current.runState).toBe("prepared");
  });

  it("records a seeded-demo street source without real association", async () => {
    const { result } = renderHook(() => usePreparation(options({ streetSeeded: true })));
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    expect(result.current.plan?.streetSource.status).toBe("seeded-demo");
    for (const item of result.current.plan?.streetItems ?? []) {
      expect(item.imageAssociation).toBe("pending");
    }
  });

  it("prepares an empty-imagery plan without inventing results", async () => {
    const { result } = renderHook(() =>
      usePreparation(options({ discoveryStatus: "empty", images: [] })),
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    expect(result.current.plan?.imagePool.count).toBe(0);
    expect(result.current.plan?.streetItems).toHaveLength(2);
  });

  it("keeps at most the latest plan on repeated starts", async () => {
    const { result } = renderHook(() => usePreparation(options()));
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    const firstRunId = result.current.plan?.runId;
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.plan?.runId).not.toBe(firstRunId);
    });
    expect(result.current.runState).toBe("prepared");
    expect(result.current.plan?.streetItems).toHaveLength(2);
  });

  it("cancels immediately and blocks the late success", async () => {
    const { result } = renderHook(() => usePreparation(options()));
    act(() => {
      result.current.start();
    });
    expect(result.current.runState).toBe("preparing");
    act(() => {
      result.current.cancel();
    });
    expect(result.current.runState).toBe("cancelled");
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(result.current.runState).toBe("cancelled");
    expect(result.current.plan).toBeNull();
  });

  it("marks the plan stale when participation or imagery changes", async () => {
    const initial = options();
    const { result, rerender } = renderHook(
      ({ opts }: { opts: UsePreparationOptions }) => usePreparation(opts),
      { initialProps: { opts: initial } },
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    rerender({ opts: options({ checkedIds: new Set(["a"]), selectionVersion: 1 }) });
    await waitFor(() => {
      expect(result.current.runState).toBe("stale");
    });
    // The stale plan stays inspectable until replaced.
    expect(result.current.plan?.streetItems).toHaveLength(2);
  });

  it("marks the plan stale when retried provider data expands the pool", async () => {
    const initial = options();
    const { result, rerender } = renderHook(
      ({ opts }: { opts: UsePreparationOptions }) => usePreparation(opts),
      { initialProps: { opts: initial } },
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    const before = result.current.plan?.imagePool.count;
    rerender({
      opts: options({
        images: [...initial.images, image("img-3")],
        imagerySnapshotId: 2,
      }),
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("stale");
    });
    // The prepared plan never silently adopts the new inputs.
    expect(result.current.plan?.imagePool.count).toBe(before);
  });

  it("discards the run and plan when the region is replaced", async () => {
    const { result, rerender } = renderHook(
      ({ opts }: { opts: UsePreparationOptions }) => usePreparation(opts),
      { initialProps: { opts: options() } },
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("prepared");
    });
    rerender({ opts: options({ roi: roi(2) }) });
    await waitFor(() => {
      expect(result.current.runState).toBe("not_started");
    });
    expect(result.current.plan).toBeNull();
  });

  it("fails the run without a usable plan when a street is invalid", async () => {
    const bad = street("bad", "Broken Road");
    bad.geometry = { type: "MultiLineString", coordinates: [] };
    const { result } = renderHook(() =>
      usePreparation(
        options({
          streets: [street("a", "Main Street"), bad],
          checkedIds: new Set(["a", "bad"]),
        }),
      ),
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.runState).toBe("failed");
    });
    expect(result.current.plan).toBeNull();
    expect(result.current.failedStreetIds).toEqual(["bad"]);
    expect(result.current.failureReasons.bad).toBe("missing or invalid clipped geometry");
    expect(result.current.workflowStatuses.get("bad")).toBe("preparation_failed");
    expect(result.current.workflowStatuses.get("a")).toBe("not_prepared");
  });
});
