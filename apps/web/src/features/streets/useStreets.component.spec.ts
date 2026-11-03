import { StrictMode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useStreets } from "./useStreets";
import { buildDemoSeed } from "./seedDemo";
import type { CommittedRoi } from "../../lib/searchTypes";
import type { StreetSearchResponse, StreetWorkItem } from "../../lib/api";

function roi(id: number, valid = true): CommittedRoi {
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
    valid,
    errorCode: null,
    errorMessage: null,
  };
}

function street(id: string, displayName: string): StreetWorkItem {
  return {
    id,
    displayName,
    partLabel: null,
    name: displayName,
    ref: null,
    wayIds: [1],
    segments: [],
    geometry: { type: "MultiLineString", coordinates: [] },
    lengthM: 120,
  };
}

function payload(streets: StreetWorkItem[]): StreetSearchResponse {
  return {
    streets,
    query: {
      bbox: [19.04, 47.495, 19.045, 47.5],
      requestedAt: "2026-11-03T00:00:00.000Z",
      retrievedAt: "2026-11-03T00:00:01.000Z",
      candidateCount: streets.length,
      invalidWayCount: 0,
      ineligibleWayCount: 0,
      outsideCount: 0,
      streetCount: streets.length,
      status: "complete",
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

describe("useStreets", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("fetches exactly once per region, including under StrictMode", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => payload([street("a", "A St")]) };
      }),
    );
    const { result } = renderHook(() => useStreets({ roi: roi(1), backendConnected: true }), {
      wrapper: StrictMode,
    });
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
    expect(calls).toEqual(["/api/streets/search"]);
    expect(result.current.streets.map((item) => item.id)).toEqual(["a"]);
    // Default participation without bumping the user-selection version.
    expect(result.current.checkedCount).toBe(1);
    expect(result.current.selectionVersion).toBe(0);
  });

  it("ignores invalid regions and resets when the region clears", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => payload([street("a", "A St")]) };
      }),
    );
    const { result, rerender } = renderHook(
      ({ current }: { current: CommittedRoi | null }) =>
        useStreets({ roi: current, backendConnected: true }),
      { initialProps: { current: roi(1, false) as CommittedRoi | null } },
    );
    expect(calls).toEqual([]);
    expect(result.current.status).toBe("idle");
    rerender({ current: roi(1) });
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
    rerender({ current: null });
    expect(result.current.status).toBe("idle");
    expect(result.current.streets).toEqual([]);
  });

  it("aborts superseded regions and ignores their late responses", async () => {
    const gate = deferred<StreetSearchResponse>();
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        signals.push(init?.signal);
        if (signals.length === 1) {
          const body = await gate.promise;
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: true, status: 200, json: async () => payload([street("b", "B St")]) };
      }),
    );
    const { result, rerender } = renderHook(
      ({ current }: { current: CommittedRoi | null }) =>
        useStreets({ roi: current, backendConnected: true }),
      { initialProps: { current: roi(1) } },
    );
    expect(result.current.status).toBe("loading");
    rerender({ current: roi(2) });
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.streets.map((item) => item.id)).toEqual(["b"]);
    await act(async () => {
      gate.resolve(payload([street("a", "A St")]));
      await gate.promise;
    });
    expect(result.current.streets.map((item) => item.id)).toEqual(["b"]);
  });

  it("reports failures with retry and versions only explicit selection edits", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false,
            status: 502,
            json: async () => ({ error: { code: "OVERPASS_INCOMPLETE", message: "Incomplete.", retryable: true } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => payload([street("a", "A St"), street("b", "B St")]),
        };
      }),
    );
    const { result } = renderHook(() => useStreets({ roi: roi(1), backendConnected: true }));
    await waitFor(() => {
      expect(result.current.status).toBe("failed");
    });
    expect(result.current.error?.code).toBe("OVERPASS_INCOMPLETE");
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
    expect(result.current.selectionVersion).toBe(0);
    act(() => {
      result.current.setChecked("a", false);
    });
    expect(result.current.checkedCount).toBe(1);
    expect(result.current.selectionVersion).toBe(1);
    act(() => {
      result.current.toggleFocus("b");
    });
    expect(result.current.focusedId).toBe("b");
    // Focus is display-only: participation and version untouched.
    expect(result.current.checkedCount).toBe(1);
    expect(result.current.selectionVersion).toBe(1);
  });

  it("commits a demo seed as loaded+seeded, checked by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({ error: { code: "OVERPASS_TIMEOUT", message: "Timed out.", retryable: true } }),
      })),
    );
    const { result } = renderHook(() => useStreets({ roi: roi(1), backendConnected: true }));
    await waitFor(() => {
      expect(result.current.status).toBe("failed");
    });
    const seed = buildDemoSeed(
      [
        { id: "i1", lng: 19.04, lat: 47.495, sequenceId: "s1", capturedAt: 1000 },
        { id: "i2", lng: 19.041, lat: 47.496, sequenceId: "s1", capturedAt: 2000 },
      ],
      [19.04, 47.495, 19.045, 47.5],
    );
    expect(seed).not.toBeNull();
    act(() => {
      result.current.seedDemo(seed!);
    });
    expect(result.current.status).toBe("loaded");
    expect(result.current.seeded).toBe(true);
    expect(result.current.streets.map((item) => item.id)).toEqual(["demo-seeded-street"]);
    expect(result.current.checkedIds.has("demo-seeded-street")).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("replaces the seed with real data on retry, and discards it on region change", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false,
            status: 502,
            json: async () => ({ error: { code: "OVERPASS_TIMEOUT", message: "Timed out.", retryable: true } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => payload([street("a", "A St")]),
        };
      }),
    );
    const { result, rerender } = renderHook(
      ({ current }: { current: CommittedRoi | null }) =>
        useStreets({ roi: current, backendConnected: true }),
      { initialProps: { current: roi(1) as CommittedRoi | null } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe("failed");
    });
    const seed = buildDemoSeed(
      [
        { id: "i1", lng: 19.04, lat: 47.495, sequenceId: "s1", capturedAt: 1000 },
        { id: "i2", lng: 19.041, lat: 47.496, sequenceId: "s1", capturedAt: 2000 },
      ],
      [19.04, 47.495, 19.045, 47.5],
    );
    act(() => {
      result.current.seedDemo(seed!);
    });
    expect(result.current.seeded).toBe(true);
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
    expect(result.current.seeded).toBe(false);
    expect(result.current.streets.map((item) => item.id)).toEqual(["a"]);
    rerender({ current: roi(2) });
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
    expect(result.current.seeded).toBe(false);
  });
});
