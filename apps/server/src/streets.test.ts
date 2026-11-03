import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rectangleRingFromBbox, type LngLat } from "@openstreetlightmapper/geo";
import {
  OVERPASS_USER_AGENT,
  STREET_CANDIDATE_LIMIT,
  StreetError,
  buildOverpassQuery,
  fetchOverpassWays,
  processOverpassElements,
} from "./streets.js";

const RING = rectangleRingFromBbox([19.04, 47.495, 19.045, 47.5]);

function way(
  wayId: number,
  coords: LngLat[],
  tags: Record<string, string>,
  nodeIds?: number[],
) {
  const nodes =
    nodeIds ?? coords.map((_, index) => wayId * 1000 + index);
  return {
    type: "way",
    id: wayId,
    nodes,
    geometry: coords.map(([lng, lat]) => ({ lat, lon: lng })),
    tags,
    version: 3,
    timestamp: "2024-06-01T00:00:00Z",
  };
}

describe("buildOverpassQuery", () => {
  it("orders the bbox south,west,north,east and the polyline lat,lng", () => {
    const query = buildOverpassQuery([19.04, 47.495, 19.045, 47.5], RING);
    assert.ok(query.includes("(47.495,19.04,47.5,19.045)"));
    assert.ok(query.includes("(around:1,47.495,19.04,47.495,19.045,47.5,19.045,47.5,19.04,47.495,19.04)"));
    assert.ok(query.includes('[out:json][timeout:25]'));
    assert.ok(query.includes("out meta geom;"));
  });

  it("filters the fixed eligible highway classes", () => {
    const query = buildOverpassQuery([0, 0, 0.001, 0.001], rectangleRingFromBbox([0, 0, 0.001, 0.001]));
    assert.ok(query.includes("motorway_link"));
    assert.ok(query.includes("living_street"));
    assert.ok(query.includes("bridleway"));
    assert.ok(!query.includes("railway"));
  });
});

describe("fetchOverpassWays", () => {
  function postCapture(
    response: Response,
    onBody?: (body: string) => void,
    onInit?: (init?: { body?: unknown; headers?: unknown }) => void,
  ): typeof fetch {
    return (async (url: string, init?: { body?: unknown; headers?: unknown }) => {
      assert.ok(String(url).includes("overpass-test.invalid"));
      onBody?.(String(init?.body ?? ""));
      onInit?.(init);
      return response;
    }) as unknown as typeof fetch;
  }

  it("POSTs the query as form data and returns elements", async () => {
    let posted = "";
    const fetchImpl = postCapture(
      new Response(JSON.stringify({ elements: [{ type: "way" }] }), { status: 200 }),
      (body) => {
        posted = body;
      },
    );
    const result = await fetchOverpassWays({
      endpoint: "https://overpass-test.invalid/api/interpreter",
      query: "[out:json];way(1,2,3,4);out geom;",
      fetchImpl,
    });
    assert.ok(posted.startsWith("data="));
    assert.ok(posted.includes("way(1%2C2%2C3%2C4)"));
    assert.equal(result.elements.length, 1);
  });

  it("identifies requests with a descriptive User-Agent (406 regression)", async () => {
    // overpass-api.de answers requests without a descriptive User-Agent with
    // 406 Not Acceptable; Node's fetch sends none by default. The response
    // format is driven by [out:json], so Accept stays permissive.
    let headers: Record<string, string> = {};
    const fetchImpl = postCapture(
      new Response(JSON.stringify({ elements: [] }), { status: 200 }),
      undefined,
      (init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
      },
    );
    await fetchOverpassWays({
      endpoint: "https://overpass-test.invalid/api/interpreter",
      query: "[out:json];way(1,2,3,4);out geom;",
      fetchImpl,
    });
    assert.equal(headers["User-Agent"], OVERPASS_USER_AGENT);
    assert.ok(OVERPASS_USER_AGENT.startsWith("OpenStreetLightMapper/"));
    assert.equal(headers["Accept"], "*/*");
  });

  it("treats error remarks with HTTP 200 as incomplete retrieval, not success", async () => {
    const fetchImpl = postCapture(
      new Response(JSON.stringify({ remark: "runtime error: Query timed out", elements: [] }), {
        status: 200,
      }),
    );
    await assert.rejects(
      fetchOverpassWays({ endpoint: "https://overpass-test.invalid/", query: "q", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof StreetError);
        assert.equal(error.code, "OVERPASS_INCOMPLETE");
        return true;
      },
    );
  });

  it("maps throttling, timeouts, and malformed bodies to stable codes", async () => {
    const throttled = postCapture(
      new Response(JSON.stringify({}), {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
    await assert.rejects(
      fetchOverpassWays({ endpoint: "https://overpass-test.invalid/", query: "q", fetchImpl: throttled }),
      (error: unknown) => {
        assert.ok(error instanceof StreetError);
        assert.equal(error.code, "OVERPASS_RATE_LIMITED");
        assert.equal(error.retryAfterSec, 7);
        return true;
      },
    );
    const malformed = postCapture(new Response("nope{", { status: 200 }));
    await assert.rejects(
      fetchOverpassWays({ endpoint: "https://overpass-test.invalid/", query: "q", fetchImpl: malformed }),
      (error: unknown) => error instanceof StreetError && error.code === "OVERPASS_BAD_RESPONSE",
    );
  });

  it("maps non-JSON error statuses to stable codes without leaking bodies", async () => {
    const throttledText = postCapture(
      new Response("RateLimitedMarker: too many requests", {
        status: 429,
        headers: { "retry-after": "11" },
      }),
    );
    await assert.rejects(
      fetchOverpassWays({ endpoint: "https://overpass-test.invalid/", query: "q", fetchImpl: throttledText }),
      (error: unknown) => {
        assert.ok(error instanceof StreetError);
        assert.equal(error.code, "OVERPASS_RATE_LIMITED");
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterSec, 11);
        assert.ok(!error.message.includes("RateLimitedMarker"));
        assert.ok(error.message.includes("Wait a little before retrying"));
        return true;
      },
    );
    const gatewayText = postCapture(
      new Response("<html><body>GatewayTimeoutMarker</body></html>", { status: 504 }),
    );
    await assert.rejects(
      fetchOverpassWays({ endpoint: "https://overpass-test.invalid/", query: "q", fetchImpl: gatewayText }),
      (error: unknown) => {
        assert.ok(error instanceof StreetError);
        assert.equal(error.code, "OVERPASS_REQUEST_FAILED");
        assert.equal(error.retryable, true);
        assert.ok(error.message.includes("504"));
        assert.ok(!error.message.includes("GatewayTimeoutMarker"));
        assert.ok(error.message.includes("OVERPASS_URL"));
        return true;
      },
    );
    const badRequestXml = postCapture(
      new Response('<?xml version="1.0"?><osm><note>BadRequestMarker</note></osm>', {
        status: 400,
      }),
    );
    await assert.rejects(
      fetchOverpassWays({ endpoint: "https://overpass-test.invalid/", query: "q", fetchImpl: badRequestXml }),
      (error: unknown) => {
        assert.ok(error instanceof StreetError);
        assert.equal(error.code, "OVERPASS_REQUEST_FAILED");
        assert.equal(error.retryable, false);
        assert.ok(error.message.includes("400"));
        assert.ok(!error.message.includes("BadRequestMarker"));
        assert.ok(!error.message.includes("OVERPASS_URL"));
        return true;
      },
    );
  });

  it("rejects misconfigured endpoints without sending requests", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    for (const endpoint of ["not a url", "ftp://example.invalid/x"]) {
      await assert.rejects(
        fetchOverpassWays({ endpoint, query: "q", fetchImpl }),
        (error: unknown) => error instanceof StreetError && error.code === "OVERPASS_MISCONFIGURED",
      );
    }
    assert.equal(calls, 0);
  });
});

describe("processOverpassElements", () => {
  it("retains a crossing way, clips it, and drops outside/point-touch ways", async () => {
    const crossing = way(
      1,
      [
        [19.03, 47.497],
        [19.055, 47.497],
      ],
      { highway: "residential", name: "Cross St" },
    );
    const outside = way(
      2,
      [
        [19.06, 47.497],
        [19.07, 47.497],
      ],
      { highway: "residential", name: "Far St" },
    );
    const touch = way(
      3,
      [
        [19.05, 47.51],
        [19.045, 47.5], // touches the corner exactly, then leaves
      ],
      { highway: "residential", name: "Touch St" },
    );
    const { dataset } = processOverpassElements([crossing, outside, touch], RING);
    assert.equal(dataset.streets.length, 1);
    const street = dataset.streets[0];
    assert.equal(street.displayName, "Cross St");
    assert.equal(street.geometry.coordinates.length, 1);
    const fragment = street.geometry.coordinates[0];
    const first = fragment[0];
    const last = fragment[fragment.length - 1];
    assert.ok(Math.abs(first[0] - 19.04) < 1e-6);
    assert.ok(Math.abs(last[0] - 19.045) < 1e-6);
    assert.ok(street.lengthM > 300 && street.lengthM < 500);
    assert.equal(dataset.outsideCount, 2);
  });

  it("clips concave crossings into fragments and excludes gaps from length", async () => {
    const cShape: LngLat[] = [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
      [0, 2],
      [2, 2],
      [2, 1],
      [0, 1],
      [0, 0],
    ];
    const road = way(
      10,
      [
        [1, -1],
        [1, 4],
      ],
      { highway: "secondary", name: "Notch Road" },
    );
    const { dataset } = processOverpassElements([road], cShape);
    assert.equal(dataset.streets.length, 1);
    assert.equal(dataset.streets[0].geometry.coordinates.length, 2);
    // Two 1° latitude fragments ≈ 2 × 111.2 km; the 1° notch gap is excluded.
    assert.ok(Math.abs(dataset.streets[0].lengthM - 222_390) < 500);
  });

  it("groups connected named ways but splits disconnected same-name parts", async () => {
    const segA = way(
      20,
      [
        [19.041, 47.496],
        [19.042, 47.497],
      ],
      { highway: "residential", name: "Main Street" },
      [200, 201],
    );
    const segB = way(
      21,
      [
        [19.042, 47.497],
        [19.043, 47.498],
      ],
      { highway: "residential", name: "Main Street" },
      [201, 202], // shares node 201 with segA
    );
    const farAway = way(
      22,
      [
        [19.044, 47.499],
        [19.0445, 47.4995],
      ],
      { highway: "residential", name: "Main Street" },
      [220, 221], // no shared nodes
    );
    const { dataset } = processOverpassElements([segA, segB, farAway], RING);
    assert.equal(dataset.streets.length, 2);
    const connected = dataset.streets.find((street) => street.wayIds.includes(20));
    assert.deepEqual(connected?.wayIds, [20, 21]);
    assert.equal(connected?.partLabel, "Part 1 of 2");
    const separate = dataset.streets.find((street) => street.wayIds.includes(22));
    assert.deepEqual(separate?.wayIds, [22]);
    assert.equal(separate?.partLabel, "Part 2 of 2");
    assert.notEqual(connected?.id, separate?.id);
  });

  it("keeps grade-separated crossings and parallel carriageways separate", async () => {
    const lower = way(
      30,
      [
        [19.041, 47.496],
        [19.044, 47.499],
      ],
      { highway: "primary", name: "Bridge Ave", bridge: "yes", layer: "1" },
      [300, 301],
    );
    const upper = way(
      31,
      [
        [19.041, 47.499],
        [19.044, 47.496],
      ],
      { highway: "primary", name: "Bridge Ave" },
      [310, 311], // geometric crossing, no shared OSM node
    );
    const { dataset } = processOverpassElements([lower, upper], RING);
    assert.equal(dataset.streets.length, 2);
    const bridged = dataset.streets.find((street) => street.wayIds.includes(30));
    assert.equal(bridged?.segments[0].tags.bridge, "yes");
    assert.equal(bridged?.segments[0].tags.layer, "1");
  });

  it("labels unnamed ways individually and groups ref ways", async () => {
    const unnamed = way(40, [[19.041, 47.496], [19.042, 47.497]], { highway: "service" });
    const refA = way(
      41,
      [[19.041, 47.498], [19.042, 47.4985]],
      { highway: "primary", ref: "B 14" },
      [410, 411],
    );
    const refB = way(
      42,
      [[19.042, 47.4985], [19.043, 47.499]],
      { highway: "primary", ref: "B 14" },
      [411, 412],
    );
    const { dataset } = processOverpassElements([unnamed, refA, refB], RING);
    assert.equal(dataset.streets.length, 2);
    const single = dataset.streets.find((street) => street.wayIds.includes(40));
    assert.equal(single?.id, "way-40");
    assert.equal(single?.displayName, "Unnamed service · OSM way 40");
    const grouped = dataset.streets.find((street) => street.wayIds.includes(41));
    assert.deepEqual(grouped?.wayIds, [41, 42]);
    assert.equal(grouped?.displayName, "B 14");
  });

  it("includes pedestrian/cycle ways and excludes areas, lifecycle, and rail", async () => {
    const elements = [
      way(50, [[19.041, 47.496], [19.042, 47.497]], { highway: "footway", name: "Walk" }),
      way(51, [[19.041, 47.496], [19.042, 47.497]], { highway: "cycleway", name: "Ride" }),
      way(52, [[19.041, 47.496], [19.042, 47.497]], { highway: "path", lit: "yes", name: "Lit Path" }),
      way(53, [[19.041, 47.496], [19.042, 47.497]], { highway: "residential", area: "yes", name: "Plaza" }),
      way(54, [[19.041, 47.496], [19.042, 47.497]], { highway: "construction", name: "Future" }),
      way(55, [[19.041, 47.496], [19.042, 47.497]], { railway: "rail", name: "Tracks" }),
    ];
    const { dataset } = processOverpassElements(elements, RING);
    assert.deepEqual(
      dataset.streets.map((street) => street.displayName).sort(),
      ["Lit Path", "Ride", "Walk"],
    );
    const lit = dataset.streets.find((street) => street.displayName === "Lit Path");
    assert.equal(lit?.segments[0].tags.lit, "yes");
    assert.equal(dataset.ineligibleWayCount, 3);
  });

  it("counts invalid ways and deduplicates union overlap", async () => {
    const good = way(60, [[19.041, 47.496], [19.042, 47.497]], { highway: "residential", name: "Ok" });
    const { dataset, invalidWayCount } = processOverpassElements(
      [
        good,
        { ...good }, // same way id from the second union branch
        { type: "way", id: 61, nodes: [1], geometry: [{ lat: 1 }], tags: {} },
        { type: "node", id: 1, lat: 1, lon: 1 },
      ],
      RING,
    );
    assert.equal(dataset.candidateCount, 1);
    assert.equal(invalidWayCount, 1);
    assert.equal(dataset.invalidWayCount, 1);
    assert.equal(dataset.streets.length, 1);
  });

  it("rejects oversized candidate sets instead of silently truncating", async () => {
    const elements = Array.from({ length: STREET_CANDIDATE_LIMIT + 1 }, (_, index) =>
      way(1000 + index, [[19.041, 47.496], [19.042, 47.497]], { highway: "residential" }),
    );
    assert.throws(() => processOverpassElements(elements, RING), (error: unknown) => {
      assert.ok(error instanceof StreetError);
      assert.equal(error.code, "STREET_LIMIT_EXCEEDED");
      return true;
    });
  });

  it("produces deterministic IDs and ordering", async () => {
    const elements = [
      way(70, [[19.041, 47.496], [19.042, 47.497]], { highway: "residential", name: "Zebra Way" }),
      way(71, [[19.041, 47.496], [19.042, 47.497]], { highway: "residential", name: "apple way" }),
    ];
    const first = processOverpassElements(elements, RING).dataset.streets;
    const second = processOverpassElements([...elements].reverse(), RING).dataset.streets;
    assert.deepEqual(
      first.map((street) => [street.id, street.displayName]),
      second.map((street) => [street.id, street.displayName]),
    );
    assert.deepEqual(
      first.map((street) => street.displayName),
      ["apple way", "Zebra Way"],
    );
  });
});
