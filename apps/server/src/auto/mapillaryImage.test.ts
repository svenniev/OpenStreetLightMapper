import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MapillaryError } from "../mapillary.js";
import {
  fetchImageMetadata,
  MAPILLARY_IMAGE_FIELDS,
  refreshImageMetadata,
  thumbUrl,
} from "./mapillaryImage.js";

interface CapturedRequest {
  url: string;
  init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal };
}

function mockFetch(respond: (captured: CapturedRequest) => Response | Promise<Response>): typeof fetch {
  return (async (url: string, init?: Record<string, unknown>) => {
    const captured: CapturedRequest = {
      url: String(url),
      init: (init ?? {}) as CapturedRequest["init"],
    };
    return respond(captured);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

describe("fetchImageMetadata", () => {
  it("requests documented fields with the OAuth header and indexes by id", async () => {
    let seen: CapturedRequest | null = null;
    const fetchImpl = mockFetch((captured) => {
      seen = captured;
      return jsonResponse({ data: [{ id: "img-1", camera_type: "perspective" }] });
    });
    const { found, missing } = await fetchImageMetadata(["img-1", "img-2"], {
      token: "tok",
      fetchImpl,
    });
    assert.ok(seen);
    const url = new URL((seen as unknown as CapturedRequest).url);
    assert.equal(url.origin + url.pathname, "https://graph.mapillary.com/images");
    assert.equal(url.searchParams.get("image_ids"), "img-1,img-2");
    assert.equal(url.searchParams.get("fields"), MAPILLARY_IMAGE_FIELDS);
    assert.ok(MAPILLARY_IMAGE_FIELDS.includes("computed_rotation"));
    assert.ok(MAPILLARY_IMAGE_FIELDS.includes("camera_parameters"));
    assert.equal((seen as unknown as CapturedRequest).init.headers?.Authorization, "OAuth tok");
    assert.deepEqual([...found.keys()], ["img-1"]);
    assert.deepEqual(missing, ["img-2"]);
  });

  it("retries retryable failures and surfaces auth errors immediately", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return calls < 3 ? jsonResponse({ error: { code: 4 } }, 500) : jsonResponse({ data: [] });
    });
    const result = await fetchImageMetadata(["img-1"], { token: "tok", fetchImpl });
    assert.equal(calls, 3);
    assert.deepEqual(result.missing, ["img-1"]);

    let authCalls = 0;
    const authFetch = mockFetch(() => {
      authCalls += 1;
      return jsonResponse({ error: { message: "bad" } }, 401);
    });
    await assert.rejects(fetchImageMetadata(["img-1"], { token: "tok", fetchImpl: authFetch }), (error) => {
      assert.ok(error instanceof MapillaryError);
      assert.equal(error.code, "MAPILLARY_AUTH_ERROR");
      return true;
    });
    assert.equal(authCalls, 1);
  });

  it("rejects responses without a data array", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ datum: [] }));
    await assert.rejects(fetchImageMetadata(["img-1"], { token: "tok", fetchImpl }), (error) => {
      assert.ok(error instanceof MapillaryError);
      assert.equal(error.code, "MAPILLARY_BAD_RESPONSE");
      return true;
    });
  });
});

describe("refreshImageMetadata", () => {
  it("fetches one image and verifies the returned id", async () => {
    let seen = "";
    const fetchImpl = mockFetch((captured) => {
      seen = captured.url;
      return jsonResponse({ id: "img-9", thumb_2048_url: "https://cdn.example.com/t.jpg" });
    });
    const record = await refreshImageMetadata("img-9", { token: "tok", fetchImpl });
    assert.ok(seen.startsWith("https://graph.mapillary.com/img-9?"));
    assert.equal((record as { id: string }).id, "img-9");

    const wrongFetch = mockFetch(() => jsonResponse({ id: "img-other" }));
    await assert.rejects(refreshImageMetadata("img-9", { token: "tok", fetchImpl: wrongFetch }), (error) => {
      assert.ok(error instanceof MapillaryError);
      assert.equal(error.code, "MAPILLARY_BAD_RESPONSE");
      return true;
    });
  });
});

describe("thumbUrl", () => {
  it("accepts https URLs and rejects credentials, http, and missing values", () => {
    assert.equal(thumbUrl({ thumb_2048_url: "https://cdn.example.com/t.jpg" }, "thumb_2048_url"), "https://cdn.example.com/t.jpg");
    assert.equal(thumbUrl({ thumb_2048_url: "http://cdn.example.com/t.jpg" }, "thumb_2048_url"), null);
    assert.equal(thumbUrl({ thumb_2048_url: "https://user:pass@cdn.example.com/t.jpg" }, "thumb_2048_url"), null);
    assert.equal(thumbUrl({ thumb_2048_url: "not a url" }, "thumb_2048_url"), null);
    assert.equal(thumbUrl({}, "thumb_2048_url"), null);
    assert.equal(thumbUrl(null, "thumb_2048_url"), null);
  });
});
