import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRoiSearch } from "./useRoiSearch";
import type { ImageResult, SearchResponse } from "../lib/searchTypes";

function image(id: string): ImageResult {
  return {
    id,
    coordinate: [19.04, 47.497],
    coordinateSource: "geometry",
    originalCoordinate: [19.04, 47.497],
    computedCoordinate: null,
    capturedAt: null,
    isPano: null,
    sequenceId: null,
  };
}

function payload(ids: string[]): SearchResponse {
  return {
    images: ids.map(image),
    query: {
      bbox: [19.04, 47.497, 19.041, 47.498],
      requestedAt: "2026-11-03T00:00:00.000Z",
      retrievedAt: "2026-11-03T00:00:01.000Z",
      providerLimit: 2000,
      rawReturnedCount: ids.length,
      matchedCount: ids.length,
      invalidRecordCount: 0,
      outsideRoiCount: 0,
      duplicateCount: 0,
      retrievalStatus: "not_capped",
    },
    warnings: [],
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

interface CapturedCall {
  signal: AbortSignal | undefined;
}

describe("useRoiSearch cancellation and races", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  function commitRectangle(result: { current: ReturnType<typeof useRoiSearch> }, dx = 0): void {
    act(() => {
      result.current.startDrawing("rectangle");
    });
    act(() => {
      result.current.handleMapClick([47.497, 19.04 + dx]);
    });
    act(() => {
      result.current.handleMapClick([47.498, 19.041 + dx]);
    });
    expect(result.current.roi?.valid).toBe(true);
  }

  it("cancels immediately and ignores a transport that resolves after abort", async () => {
    const gate = deferred<SearchResponse>();
    const calls: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        calls.push({ signal: init?.signal });
        const body = await gate.promise;
        return { ok: true, status: 200, json: async () => body };
      }),
    );
    const { result } = renderHook(() =>
      useRoiSearch({ backendConnected: true, searchConfigured: true }),
    );
    commitRectangle(result);
    act(() => {
      void result.current.runSearch();
    });
    expect(result.current.status).toBe("loading");
    act(() => {
      result.current.cancelSearch();
    });
    // Cancelled synchronously, without waiting for the transport.
    expect(result.current.status).toBe("cancelled");
    expect(calls[0].signal?.aborted).toBe(true);
    // The transport resolves anyway: acceptance was invalidated, so nothing applies.
    await act(async () => {
      gate.resolve(payload(["late"]));
      await gate.promise;
    });
    expect(result.current.status).toBe("cancelled");
    expect(result.current.images).toEqual([]);
  });

  it("aborts outstanding discovery work on unmount", async () => {
    const gate = deferred<SearchResponse>();
    const calls: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        calls.push({ signal: init?.signal });
        const body = await gate.promise;
        return { ok: true, status: 200, json: async () => body };
      }),
    );
    const { result, unmount } = renderHook(() =>
      useRoiSearch({ backendConnected: true, searchConfigured: true }),
    );
    commitRectangle(result);
    act(() => {
      void result.current.runSearch();
    });
    expect(result.current.status).toBe("loading");
    unmount();
    expect(calls[0].signal?.aborted).toBe(true);
    gate.resolve(payload(["orphan"]));
    await gate.promise;
    // No crash, no state to corrupt: the generation was invalidated.
  });

  it("ignores a response that races a committed replacement region", async () => {
    const gateA = deferred<SearchResponse>();
    const calls: CapturedCall[] = [];
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        calls.push({ signal: init?.signal });
        if (first) {
          first = false;
          const body = await gateA.promise;
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: true, status: 200, json: async () => payload(["b1"]) };
      }),
    );
    const { result } = renderHook(() =>
      useRoiSearch({ backendConnected: true, searchConfigured: true }),
    );
    commitRectangle(result, 0);
    act(() => {
      void result.current.runSearch();
    });
    // Replace the region while A is in flight, then search B to completion.
    commitRectangle(result, 0.01);
    await act(async () => {
      await result.current.runSearch();
    });
    expect(result.current.images.map((item) => item.id)).toEqual(["b1"]);
    // A resolves late: it must not overwrite B's results.
    await act(async () => {
      gateA.resolve(payload(["a1"]));
      await gateA.promise;
    });
    expect(result.current.status).toBe("results");
    expect(result.current.images.map((item) => item.id)).toEqual(["b1"]);
  });
});
