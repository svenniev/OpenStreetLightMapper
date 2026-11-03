import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ClientAbortedError,
  MAPILLARY_IMAGES_ENDPOINT,
  MAPILLARY_SEARCH_FIELDS,
  MAPILLARY_SEARCH_LIMIT,
  MapillaryError,
  searchMapillaryByBbox,
} from "./mapillary.js";

interface CapturedRequest {
  url: string;
  init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal };
}

function mockFetch(
  respond: (captured: CapturedRequest) => Response | Promise<Response>,
  onCall?: (captured: CapturedRequest) => void,
): typeof fetch {
  return (async (url: string, init?: Record<string, unknown>) => {
    const captured: CapturedRequest = {
      url: String(url),
      init: (init ?? {}) as CapturedRequest["init"],
    };
    onCall?.(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

describe("searchMapillaryByBbox request construction", () => {
  it("uses the fixed endpoint, bbox order, fields, limit, and OAuth header", async () => {
    let seen: CapturedRequest | null = null;
    const fetchImpl = mockFetch(() => jsonResponse({ data: [] }), (c) => {
      seen = c;
    });
    await searchMapillaryByBbox({
      bbox: [19.04, 47.495, 19.045, 47.5],
      token: "secret-token",
      fetchImpl,
    });
    assert.ok(seen);
    const url = new URL((seen as CapturedRequest).url);
    assert.equal(`${url.origin}${url.pathname}`, MAPILLARY_IMAGES_ENDPOINT);
    assert.equal(url.searchParams.get("bbox"), "19.04,47.495,19.045,47.5");
    assert.equal(url.searchParams.get("fields"), MAPILLARY_SEARCH_FIELDS);
    assert.equal(url.searchParams.get("limit"), String(MAPILLARY_SEARCH_LIMIT));
    // Token travels in the header, never in the URL.
    assert.ok(!(seen as CapturedRequest).url.includes("secret-token"));
    assert.equal((seen as CapturedRequest).init.headers?.Authorization, "OAuth secret-token");
  });

  it("makes exactly one request per search", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return jsonResponse({ data: [] });
    });
    await searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "t", fetchImpl });
    assert.equal(calls, 1);
  });
});

describe("searchMapillaryByBbox responses", () => {
  it("returns raw records and detects paging.next without following it", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return jsonResponse({ data: [{ id: "a" }, { id: "b" }], paging: { next: "https://x/y" } });
    });
    const result = await searchMapillaryByBbox({
      bbox: [0, 0, 0.01, 0.01],
      token: "t",
      fetchImpl,
    });
    assert.deepEqual(result.records, [{ id: "a" }, { id: "b" }]);
    assert.equal(result.hasMoreIndication, true);
    assert.equal(calls, 1);
  });

  it("maps 401 to MAPILLARY_AUTH_ERROR without leaking the token", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ error: { code: 190, message: "bad token" } }, 401),
    );
    await assert.rejects(
      searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "secret-token", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(error.code, "MAPILLARY_AUTH_ERROR");
        assert.ok(!error.message.includes("secret-token"));
        return true;
      },
    );
  });

  it("never surfaces raw provider text that carries a fake token or token URL", async () => {
    const leaked = "MLY|FAKE_TOKEN_abc123";
    const fetchImpl = mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: 190,
            message: `invalid ${leaked} see https://graph.mapillary.com/images?access_token=${leaked}`,
          },
        },
        401,
      ),
    );
    await assert.rejects(
      searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "real-token", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(
          error.message,
          "Mapillary rejected the configured access token (provider status 401). Correct the server search token.",
        );
        assert.ok(!error.message.includes("FAKE_TOKEN"));
        assert.ok(!error.message.includes("access_token="));
        return true;
      },
    );
  });

  it("maps 429 to MAPILLARY_RATE_LIMITED and preserves Retry-After", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "42" }));
    await assert.rejects(
      searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "t", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(error.code, "MAPILLARY_RATE_LIMITED");
        assert.equal(error.retryAfterSec, 42);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it("maps provider throttle subcodes to rate-limited even on other statuses", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: { code: 4, message: "throttled" } }, 403));
    await assert.rejects(
      searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "t", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(error.code, "MAPILLARY_RATE_LIMITED");
        return true;
      },
    );
  });

  it("maps timeouts to MAPILLARY_TIMEOUT", async () => {
    const fetchImpl = mockFetch(
      (c) =>
        new Promise<Response>((_resolve, reject) => {
          c.init.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
        }),
    );
    await assert.rejects(
      searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "t", fetchImpl, timeoutMs: 20 }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(error.code, "MAPILLARY_TIMEOUT");
        return true;
      },
    );
  });

  it("maps network failures to MAPILLARY_NETWORK_ERROR", async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "t", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(error.code, "MAPILLARY_NETWORK_ERROR");
        return true;
      },
    );
  });

  it("maps malformed JSON to MAPILLARY_BAD_RESPONSE", async () => {
    const fetchImpl = mockFetch(() => new Response("not json{", { status: 200 }));
    await assert.rejects(
      searchMapillaryByBbox({ bbox: [0, 0, 0.01, 0.01], token: "t", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof MapillaryError);
        assert.equal(error.code, "MAPILLARY_BAD_RESPONSE");
        return true;
      },
    );
  });

  it("propagates caller aborts as ClientAbortedError", async () => {
    const controller = new AbortController();
    const fetchImpl = mockFetch(
      (c) =>
        new Promise<Response>((_resolve, reject) => {
          c.init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = searchMapillaryByBbox({
      bbox: [0, 0, 0.01, 0.01],
      token: "t",
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ClientAbortedError);
  });
});
