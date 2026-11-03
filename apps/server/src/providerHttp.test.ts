import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TransportError,
  fetchJsonWithLimits,
} from "./providerHttp.js";

function streamResponse(chunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/json" } });
}

describe("fetchJsonWithLimits", () => {
  it("returns status, headers, and parsed JSON on success", async () => {
    const fetchImpl = (async () =>
      streamResponse([new TextEncoder().encode('{"data":[1,2]}')])) as unknown as typeof fetch;
    const result = await fetchJsonWithLimits("https://example.invalid/x", {
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { data: [1, 2] });
  });

  it("keeps the deadline active through a stalled body (P1 regression)", async () => {
    // Headers arrive, then the body stalls forever: the timeout must still fire.
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchJsonWithLimits("https://example.invalid/slow", { fetchImpl, timeoutMs: 30 }),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.equal(error.kind, "timeout");
        return true;
      },
    );
  });

  it("propagates caller cancellation after headers were received", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const pending = fetchJsonWithLimits("https://example.invalid/hang", {
      fetchImpl,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    // Cancel once headers/body streaming has started.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.kind, "aborted");
      return true;
    });
  });

  it("stops already-aborted callers before any socket work", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchJsonWithLimits("https://example.invalid/x", {
        fetchImpl,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.equal(error.kind, "aborted");
        return true;
      },
    );
    assert.equal(calls, 0);
  });

  it("fails clearly past the body limit instead of buffering", async () => {
    const big = new Uint8Array(128).fill(120);
    const fetchImpl = (async () =>
      streamResponse([big, big, big, big])) as unknown as typeof fetch;
    await assert.rejects(
      fetchJsonWithLimits("https://example.invalid/big", {
        fetchImpl,
        timeoutMs: 1000,
        maxBytes: 100,
      }),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.equal(error.kind, "too_large");
        return true;
      },
    );
  });

  it("surfaces error statuses with non-JSON bodies for status mapping", async () => {
    // Providers (Overpass especially) answer errors with XML/text bodies.
    // Those must reach the caller's status handling, not mask as bad_json.
    for (const [status, body] of [
      [429, "Rate limit exceeded, retry later."],
      [504, "<html><body>Gateway Timeout</body></html>"],
      [400, '<?xml version="1.0"?><osm><note>parse error</note></osm>'],
    ] as const) {
      const fetchImpl = (async () =>
        streamResponse([new TextEncoder().encode(body)], status)) as unknown as typeof fetch;
      const result = await fetchJsonWithLimits("https://example.invalid/e", {
        fetchImpl,
        timeoutMs: 1000,
      });
      assert.equal(result.status, status);
      assert.equal(result.json, null);
    }
  });

  it("maps malformed JSON and network failures distinctly", async () => {
    const badJson = (async () =>
      streamResponse([new TextEncoder().encode("nope{")])) as unknown as typeof fetch;
    await assert.rejects(
      fetchJsonWithLimits("https://example.invalid/j", { fetchImpl: badJson, timeoutMs: 1000 }),
      (error: unknown) => error instanceof TransportError && error.kind === "bad_json",
    );
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchJsonWithLimits("https://example.invalid/n", { fetchImpl: failing, timeoutMs: 1000 }),
      (error: unknown) => error instanceof TransportError && error.kind === "network",
    );
  });
});
