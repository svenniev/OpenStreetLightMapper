import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attributionFor,
  fetchImageDetail,
  fetchMediaBytes,
  isValidImageId,
  issueMediaHandle,
  normalizeImageDetail,
  resolveMediaHandle,
  sourceUrlFor,
  UnknownHandleError,
  type NormalizedImageDetail,
} from "./imagery.js";
import { MapillaryError } from "./mapillary.js";

const DETAIL = {
  id: "123",
  sequence: "seq-9",
  captured_at: 1700000000000,
  is_pano: false,
  geometry: { type: "Point", coordinates: [19.04, 47.49] },
  computed_geometry: { type: "Point", coordinates: [19.041, 47.491] },
  compass_angle: 90,
  computed_compass_angle: 95,
  creator: { username: "tester", id: "u-1" },
  thumb_1024_url: "https://images.mapillary.com/secret-1024.jpg?sig=abc",
  thumb_2048_url: "https://images.mapillary.com/secret-2048.jpg?sig=abc",
};

function mockFetch(respond: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((url: string, init?: RequestInit) => Promise.resolve(respond(url, init))) as unknown as typeof fetch;
}

function detailEntry(): { detail: NormalizedImageDetail; handle: string } {
  const detail = normalizeImageDetail("123", DETAIL)!;
  const { handle } = issueMediaHandle(detail);
  return { detail, handle };
}

describe("image ID validation", () => {
  it("accepts numeric IDs and rejects anything else", () => {
    assert.equal(isValidImageId("123"), true);
    assert.equal(isValidImageId(""), false);
    assert.equal(isValidImageId("abc"), false);
    assert.equal(isValidImageId("../123"), false);
    assert.equal(isValidImageId("12.3"), false);
    assert.equal(isValidImageId(`${Number.MAX_SAFE_INTEGER}9`), false);
  });
});

describe("image detail normalization", () => {
  it("prefers the largest verified thumbnail and computed orientation", () => {
    const detail = normalizeImageDetail("123", DETAIL);
    assert.ok(detail);
    assert.equal(detail.thumbUrl, "https://images.mapillary.com/secret-2048.jpg?sig=abc");
    assert.equal(detail.resolution, "2048px thumbnail");
    assert.equal(detail.creator, "tester");
    assert.equal(detail.compassAngle, 95);
    assert.deepEqual(detail.cameraPosition, [19.04, 47.49]);
    assert.equal(detail.coordinateSource, "geometry");
    assert.equal(detail.sequenceId, "seq-9");
  });

  it("falls back through thumbnails and geometry without inventing data", () => {
    const detail = normalizeImageDetail("123", {
      ...DETAIL,
      thumb_2048_url: "http://insecure.example/x.jpg",
      geometry: null,
      computed_compass_angle: null,
      creator: null,
    });
    assert.ok(detail);
    assert.equal(detail.thumbUrl, "https://images.mapillary.com/secret-1024.jpg?sig=abc");
    assert.equal(detail.resolution, "1024px thumbnail");
    assert.deepEqual(detail.cameraPosition, [19.041, 47.491]);
    assert.equal(detail.coordinateSource, "computed_geometry");
    assert.equal(detail.compassAngle, 90);
    assert.equal(detail.creator, null);
  });

  it("fails closed on ID mismatch, missing thumbs, and non-objects", () => {
    assert.equal(normalizeImageDetail("123", { ...DETAIL, id: "999" }), null);
    assert.equal(normalizeImageDetail("123", { ...DETAIL, thumb_1024_url: null, thumb_2048_url: null }), null);
    assert.equal(normalizeImageDetail("123", null), null);
    assert.equal(normalizeImageDetail("123", { ...DETAIL, id: 123.5 }), null);
  });

  it("builds attribution and source links without signed URLs", () => {
    const detail = normalizeImageDetail("123", DETAIL)!;
    assert.equal(attributionFor(detail), "© Mapillary contributors — tester");
    assert.equal(attributionFor({ creator: null }), "© Mapillary contributors");
    assert.equal(sourceUrlFor("123"), "https://www.mapillary.com/map/im/123");
  });
});

describe("image detail fetch", () => {
  it("sends the OAuth header and normalizes one record", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = mockFetch((url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") });
      return new Response(JSON.stringify(DETAIL), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const detail = await fetchImageDetail({ imageId: "123", token: "tok", fetchImpl });
    assert.equal(detail.imageId, "123");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.startsWith("https://graph.mapillary.com/123?"));
    assert.ok(seen[0].url.includes("fields="));
    assert.equal(seen[0].auth, "OAuth tok");
  });

  it("maps provider failures to stable codes", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 4 } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        }),
    );
    const error = await fetchImageDetail({ imageId: "123", token: "tok", fetchImpl }).catch(
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof MapillaryError);
    assert.equal(error.code, "MAPILLARY_RATE_LIMITED");
    assert.equal(error.retryAfterSec, 7);
  });
});

describe("media handles", () => {
  it("issues opaque handles and resolves them server-side", () => {
    const { detail, handle } = detailEntry();
    assert.match(handle, /^[0-9a-f-]{36}$/);
    assert.ok(!handle.includes("123"));
    const entry = resolveMediaHandle(handle);
    assert.equal(entry?.imageId, detail.imageId);
    assert.equal(resolveMediaHandle("00000000-0000-0000-0000-000000000000"), null);
  });

  it("follows one redirect and serves bytes without credentials", async () => {
    const { handle } = detailEntry();
    const seenAuth: (string | null)[] = [];
    const fetchImpl = mockFetch((url, init) => {
      seenAuth.push(new Headers(init?.headers).get("authorization"));
      if (url === "https://images.mapillary.com/secret-2048.jpg?sig=abc") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/final.jpg" },
        });
      }
      assert.equal(url, "https://cdn.example/final.jpg");
      return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });
    const media = await fetchMediaBytes(handle, { fetchImpl });
    assert.equal(media.contentType, "image/jpeg");
    assert.deepEqual([...media.bytes], [0xff, 0xd8, 0xff]);
    assert.deepEqual(seenAuth, [null, null]);
  });

  it("rejects unknown handles, downgrades, loops, and non-images", async () => {
    await assert.rejects(
      fetchMediaBytes("00000000-0000-0000-0000-000000000001"),
      UnknownHandleError,
    );
    const { handle: downgrade } = detailEntry();
    await assert.rejects(
      fetchMediaBytes(downgrade, {
        fetchImpl: mockFetch(
          () => new Response(null, { status: 302, headers: { location: "http://evil.example/x" } }),
        ),
      }),
      /trusted HTTPS/,
    );
    const { handle: loop } = detailEntry();
    await assert.rejects(
      fetchMediaBytes(loop, {
        fetchImpl: mockFetch(
          (url) => new Response(null, { status: 302, headers: { location: `${url}/hop` } }),
        ),
        timeoutMs: 5000,
      }),
      /too many times/,
    );
    const { handle: html } = detailEntry();
    await assert.rejects(
      fetchMediaBytes(html, {
        fetchImpl: mockFetch(
          () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
        ),
      }),
      /not an image/,
    );
  });

  it("caches bytes per handle and maps upstream media failures", async () => {
    const { handle } = detailEntry();
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    await fetchMediaBytes(handle, { fetchImpl });
    await fetchMediaBytes(handle, { fetchImpl });
    assert.equal(calls, 1);

    const { handle: failing } = detailEntry();
    const error = await fetchMediaBytes(failing, {
      fetchImpl: mockFetch(() => new Response("oops", { status: 500 })),
    }).catch((failure: unknown) => failure);
    assert.ok(error instanceof MapillaryError);
    assert.equal(error.code, "MAPILLARY_REQUEST_FAILED");
    assert.equal(error.retryable, true);
  });
});
