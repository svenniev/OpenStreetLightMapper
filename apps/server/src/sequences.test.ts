import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rectangleRingFromBbox } from "@openstreetlightmapper/geo";
import {
  ClientAbortedError,
  MapillaryError,
} from "./mapillary.js";
import {
  SEQUENCE_BATCH_SIZE,
  SEQUENCE_MAX_MEMBERS,
  loadSequenceDetail,
} from "./sequences.js";

const RING = rectangleRingFromBbox([10, 20, 11, 21]);

function entity(id: string, lng: number, lat: number, sequence = "seq-1") {
  return {
    id,
    geometry: { type: "Point", coordinates: [lng, lat] },
    computed_geometry: null,
    captured_at: "2024-05-01T12:00:00.000Z",
    is_pano: false,
    sequence,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface BatchCall {
  ids: string[];
}

/** Routes membership vs batch URLs to canned fixtures, tracking batch calls. */
function mockProvider(options: {
  memberIds: string[];
  pagingNext?: boolean;
  entities?: (ids: string[]) => unknown[];
  failBatch?: (ids: string[], attempt: number) => Response | null;
  onBatch?: (call: BatchCall) => void;
  membershipStatus?: number;
}): typeof fetch {
  let attempts = 0;
  return (async (url: string) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/image_ids")) {
      assert.equal(parsed.searchParams.get("sequence_id"), "seq-1");
      const body: Record<string, unknown> = {
        data: options.memberIds.map((id) => ({ id })),
      };
      if (options.pagingNext) body.paging = { next: "https://graph.mapillary.com/more" };
      return jsonResponse(body, options.membershipStatus ?? 200);
    }
    const ids = (parsed.searchParams.get("image_ids") ?? "").split(",").filter(Boolean);
    assert.ok(parsed.searchParams.get("fields")?.includes("id,geometry"));
    options.onBatch?.({ ids });
    attempts += 1;
    const failure = options.failBatch?.(ids, attempts) ?? null;
    if (failure) return failure;
    const data = (options.entities ?? ((wanted: string[]) => wanted.map((id, index) => entity(id, 10.1 + index * 0.001, 20.1))))(ids);
    return jsonResponse({ data });
  }) as unknown as typeof fetch;
}

describe("loadSequenceDetail", () => {
  it("hydrates membership in provider order with in-RoI flags", async () => {
    const fetchImpl = mockProvider({
      memberIds: ["m1", "m2", "m3"],
      entities: () => [
        entity("m1", 10.5, 20.5),
        entity("m2", 50, 50), // outside the RoI: kept with an explicit flag
        entity("m3", 10, 20.5), // on the boundary: inside
      ],
    });
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      token: "t",
      fetchImpl,
    });
    assert.deepEqual(detail.memberIds, ["m1", "m2", "m3"]);
    assert.equal(detail.membership.status, "complete");
    assert.equal(detail.detail.status, "loaded");
    assert.equal(detail.detail.loadedCount, 3);
    assert.equal(detail.detail.inRegionCount, 2);
    assert.equal(detail.detail.outRegionCount, 1);
    assert.deepEqual(
      detail.images.map((image) => [image.id, image.inRoi]),
      [
        ["m1", true],
        ["m2", false],
        ["m3", true],
      ],
    );
    assert.deepEqual(detail.warnings, []);
  });

  it("skips caller-known IDs without re-requesting them", async () => {
    const calls: BatchCall[] = [];
    const fetchImpl = mockProvider({
      memberIds: ["m1", "m2", "m3"],
      onBatch: (call) => calls.push(call),
    });
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      knownIds: ["m1", "m3", "not-a-member", "bogus id!!"],
      token: "t",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].ids, ["m2"]);
    assert.equal(detail.detail.skippedKnownCount, 2);
    assert.equal(detail.detail.loadedCount, 1);
  });

  it("batches 50 IDs with at most two concurrent requests", async () => {
    const members = Array.from({ length: 120 }, (_, index) => `img-${index}`);
    const sizes: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const base = mockProvider({ memberIds: members });
    const fetchImpl = (async (url: string, init?: Record<string, unknown>) => {
      if (!String(url).includes("image_ids=")) return base(url, init);
      const ids = new URL(String(url)).searchParams.get("image_ids")!.split(",");
      sizes.push(ids.length);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await base(url, init);
      inFlight -= 1;
      return response;
    }) as unknown as typeof fetch;
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      token: "t",
      fetchImpl,
    });
    assert.deepEqual(sizes, [SEQUENCE_BATCH_SIZE, SEQUENCE_BATCH_SIZE, 20]);
    assert.ok(maxInFlight <= 2, `maxInFlight was ${maxInFlight}`);
    assert.equal(detail.detail.loadedCount, 120);
  });

  it("counts missing, mismatched, and invalid members without fabricating locations", async () => {
    const fetchImpl = mockProvider({
      memberIds: ["ok", "gone", "wrong-seq", "broken"],
      entities: () => [
        entity("ok", 10.5, 20.5),
        // "gone" absent: deleted/unavailable upstream
        entity("wrong-seq", 10.5, 20.5, "seq-other"),
        { id: "broken", geometry: null, computed_geometry: null },
      ],
    });
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      token: "t",
      fetchImpl,
    });
    assert.equal(detail.detail.status, "partial");
    assert.equal(detail.detail.loadedCount, 1);
    assert.equal(detail.detail.missingCount, 1);
    assert.equal(detail.detail.invalidCount, 2);
    assert.deepEqual(detail.images.map((image) => image.id), ["ok"]);
    assert.ok(detail.warnings.includes("SEQUENCE_MEMBERS_MISSING"));
    assert.ok(detail.warnings.includes("SEQUENCE_MEMBERS_INVALID"));
    assert.ok(detail.warnings.includes("SEQUENCE_HYDRATION_PARTIAL"));
  });

  it("reports membership paging as unknown without following it", async () => {
    let calls = 0;
    const base = mockProvider({ memberIds: ["m1"], pagingNext: true });
    const fetchImpl = (async (url: string, init?: Record<string, unknown>) => {
      calls += 1;
      return base(url, init);
    }) as unknown as typeof fetch;
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      token: "t",
      fetchImpl,
    });
    assert.equal(detail.membership.status, "unknown");
    assert.ok(detail.warnings.includes("SEQUENCE_MEMBERSHIP_UNKNOWN"));
    assert.equal(calls, 2); // membership + one batch; paging.next never followed
  });

  it("caps hydration at 5,000 members with an explicit partial status", async () => {
    const members = Array.from({ length: SEQUENCE_MAX_MEMBERS + 5 }, (_, index) => `m-${index}`);
    const known = members.slice(0, SEQUENCE_MAX_MEMBERS - 10);
    const calls: BatchCall[] = [];
    const fetchImpl = mockProvider({
      memberIds: members,
      onBatch: (call) => calls.push(call),
    });
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      knownIds: known,
      token: "t",
      fetchImpl,
    });
    assert.equal(detail.memberIds.length, SEQUENCE_MAX_MEMBERS);
    assert.equal(detail.membership.status, "partial");
    assert.equal(detail.membership.capped, true);
    assert.ok(detail.warnings.includes("SEQUENCE_MEMBERS_CAPPED"));
    assert.equal(detail.detail.skippedKnownCount, SEQUENCE_MAX_MEMBERS - 10);
    assert.equal(detail.detail.loadedCount, 10);
  });

  it("leaves a failed batch explicitly unresolved instead of failing silently", async () => {
    const members = Array.from({ length: 60 }, (_, index) => `m-${index}`);
    const fetchImpl = mockProvider({
      memberIds: members,
      failBatch: (ids) =>
        ids[0] === "m-0" ? jsonResponse({ error: { message: "boom" } }, 500) : null,
    });
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      token: "t",
      fetchImpl,
    });
    assert.equal(detail.detail.status, "partial");
    assert.equal(detail.detail.loadedCount, 10);
    assert.equal(detail.detail.unresolvedCount, 50);
    assert.ok(detail.warnings.includes("SEQUENCE_HYDRATION_PARTIAL"));
  });

  it("surfaces batch authorization failures as errors, not gaps", async () => {
    const fetchImpl = mockProvider({
      memberIds: ["m1"],
      failBatch: () => jsonResponse({ error: { code: 190, message: "bad" } }, 401),
    });
    await assert.rejects(
      loadSequenceDetail({ sequenceId: "seq-1", ring: RING, token: "t", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(error.code, "MAPILLARY_AUTH_ERROR");
        return true;
      },
    );
  });

  it("propagates caller cancellation as ClientAbortedError", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;
    const pending = loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      token: "t",
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ClientAbortedError);
  });

  it("treats total-deadline expiry as partial progress, not a silent abort", async () => {
    // Membership answers; hydration hangs until the total deadline fires.
    const fetchImpl = (async (url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).includes("/image_ids?")) {
        return jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] });
      }
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const detail = await loadSequenceDetail({
      sequenceId: "seq-1",
      ring: RING,
      token: "t",
      fetchImpl,
      timeoutMs: 5000,
      totalTimeoutMs: 40,
    });
    assert.equal(detail.detail.status, "partial");
    assert.equal(detail.detail.unresolvedCount, 2);
    assert.deepEqual(detail.memberIds, ["m1", "m2"]);
  });
});
