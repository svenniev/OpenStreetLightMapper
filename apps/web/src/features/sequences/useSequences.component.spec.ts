import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSequences } from "./useSequences";
import type {
  CommittedRoi,
  ImageResult,
  ViewerActual,
} from "../../lib/searchTypes";
import type { SequenceDetailResponse } from "../../lib/api";

function image(partial: Partial<ImageResult> & { id: string }): ImageResult {
  return {
    coordinate: [19.04, 47.497],
    coordinateSource: "geometry",
    originalCoordinate: [19.04, 47.497],
    computedCoordinate: null,
    capturedAt: null,
    isPano: null,
    sequenceId: null,
    ...partial,
  };
}

function roi(id: number): CommittedRoi {
  return {
    id,
    shape: "rectangle",
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [19.04, 47.495],
          [19.045, 47.495],
          [19.045, 47.5],
          [19.04, 47.5],
          [19.04, 47.495],
        ],
      ],
    },
    areaSqM: 1000,
    bbox: [19.04, 47.495, 19.045, 47.5],
    valid: true,
    errorCode: null,
    errorMessage: null,
  };
}

function detailResponse(sequenceId: string, memberIds: string[]): SequenceDetailResponse {
  return {
    sequenceId,
    memberIds,
    images: memberIds.map((id) => ({
      ...image({ id, sequenceId, capturedAt: 1000 }),
      inRoi: true,
    })),
    membership: { status: "complete", returnedCount: memberIds.length, capped: false },
    detail: {
      status: "loaded",
      loadedCount: memberIds.length,
      missingCount: 0,
      invalidCount: 0,
      inRegionCount: memberIds.length,
      outRegionCount: 0,
      unresolvedCount: 0,
      skippedKnownCount: 0,
    },
    warnings: [],
    retrievedAt: "2026-11-03T00:00:00.000Z",
    requestedAt: "2026-11-03T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SEEDS = [
  image({ id: "a1", sequenceId: "seq-a", isPano: true, capturedAt: 300 }),
  image({ id: "a2", sequenceId: "seq-a", isPano: false, capturedAt: 200 }),
  image({ id: "b1", sequenceId: "seq-b", isPano: false, capturedAt: 100 }),
];

describe("useSequences", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  function setup(viewerActual: ViewerActual = { imageId: null, sequenceId: null, position: null }) {
    const mergeHydratedImages = vi.fn((_records: ImageResult[]) => 0);
    const requestViewerImage = vi.fn();
    const state = {
      pool: [...SEEDS] as ImageResult[],
      roi: roi(1),
      viewerActual,
    };
    const rendered = renderHook(
      ({ pool, roi: currentRoi, actual }) =>
        useSequences({
          roi: currentRoi,
          seeds: SEEDS,
          pool,
          mergeHydratedImages: (records) => {
            state.pool = [...state.pool, ...records.filter((record) => !state.pool.some((known) => known.id === record.id))];
            return mergeHydratedImages(records);
          },
          requestViewerImage,
          viewerActual: actual,
        }),
      { initialProps: { pool: state.pool, roi: state.roi, actual: state.viewerActual } },
    );
    return { ...rendered, mergeHydratedImages, requestViewerImage, state };
  }

  it("loads detail on selection and skips refetch when reselecting loaded data", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => detailResponse("seq-a", ["a1", "a2", "a3"]) };
      }),
    );
    const { result, rerender, mergeHydratedImages } = setup();
    await act(async () => {
      result.current.selectSequence("seq-a");
    });
    expect(calls.length).toBe(1);
    expect(mergeHydratedImages).toHaveBeenCalledTimes(1);
    expect(result.current.selectedLoad.state).toBe("loaded");
    // Pool update flows back in; reselecting must not refetch.
    rerender({
      pool: [...SEEDS, image({ id: "a3", sequenceId: "seq-a" })],
      roi: roi(1),
      actual: { imageId: null, sequenceId: null, position: null },
    });
    await act(async () => {
      result.current.selectSequence(null);
      result.current.selectSequence("seq-a");
    });
    expect(calls.length).toBe(1);
    expect(result.current.selectedLoad.state).toBe("loaded");
  });

  it("aborts superseded selections and ignores their late responses", async () => {
    const gateA = deferred<SequenceDetailResponse>();
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
        signals.push(init?.signal);
        if (String(url).includes("seq-a")) {
          const body = await gateA.promise;
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: true, status: 200, json: async () => detailResponse("seq-b", ["b1"]) };
      }),
    );
    const { result } = setup();
    act(() => {
      result.current.selectSequence("seq-a");
    });
    expect(result.current.selectedLoad.state).toBe("loading");
    await act(async () => {
      result.current.selectSequence("seq-b");
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.selectedSequenceId).toBe("seq-b");
    expect(result.current.selectedLoad.state).toBe("loaded");
    // A's transport resolves late anyway: nothing of A may apply to B.
    await act(async () => {
      gateA.resolve(detailResponse("seq-a", ["a1", "a2"]));
      await gateA.promise;
    });
    expect(result.current.selectedSequenceId).toBe("seq-b");
    expect(result.current.selectedLoad.memberIds).toEqual(["b1"]);
  });

  it("loads a representative seed and keeps the current image when it belongs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => detailResponse("seq-a", ["a1", "a2"]) })),
    );
    const { result, requestViewerImage } = setup();
    await act(async () => {
      result.current.selectSequence("seq-a");
    });
    // Panorama seed preferred even though it is the later capture.
    expect(requestViewerImage).toHaveBeenCalledWith("a1");

    requestViewerImage.mockClear();
    const belonging = setup({ imageId: "a2", sequenceId: "seq-a", position: null });
    await act(async () => {
      belonging.result.current.selectSequence("seq-a");
    });
    expect(belonging.requestViewerImage).not.toHaveBeenCalled();
    expect(result.current).toBeDefined();
  });

  it("selects ungrouped images individually without detail requests", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => detailResponse("seq-a", ["a1"]) };
      }),
    );
    const { result, requestViewerImage } = setup();
    act(() => {
      result.current.selectUngrouped("solo-1");
    });
    expect(result.current.selectedUngroupedId).toBe("solo-1");
    expect(result.current.selectedSequenceId).toBe(null);
    expect(requestViewerImage).toHaveBeenCalledWith("solo-1");
    expect(calls).toEqual([]);
  });

  it("discards dependent state and aborts work when the region changes", async () => {
    const gate = deferred<SequenceDetailResponse>();
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        signals.push(init?.signal);
        const body = await gate.promise;
        return { ok: true, status: 200, json: async () => body };
      }),
    );
    const { result, rerender } = setup();
    act(() => {
      result.current.selectSequence("seq-a");
    });
    expect(result.current.selectedLoad.state).toBe("loading");
    rerender({
      pool: [],
      roi: roi(2),
      actual: { imageId: null, sequenceId: null, position: null },
    });
    expect(result.current.selectedSequenceId).toBe(null);
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      gate.resolve(detailResponse("seq-a", ["a1"]));
      await gate.promise;
    });
    expect(result.current.selectedLoad.state).toBe("discovery");
  });
});
