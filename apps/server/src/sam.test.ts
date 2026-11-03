import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizedEvents,
  parseSseEvents,
  SamError,
  segmentImage,
  verifyWireDimensions,
  type SamRequest,
} from "./sam.js";

// Grammar examples follow the documented SAM output format: one <0f> line per
// image, inclusive wire boxes, height,width mask rasters.
const LINE_TWO_OBJECTS =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>";
const LINE_CONFIDENCE =
  "<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|>" +
  "<|mask;x=0;y=0;c=0.9609375;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";

function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function delta(text: string): unknown {
  return {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: text,
  };
}

function partDone(text: string): unknown {
  return {
    type: "response.content_part.done",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text },
  };
}

const COMPLETED = { type: "response.completed" };

function request(overrides: Partial<SamRequest> = {}): SamRequest {
  return {
    viewId: "view-1",
    imageId: "img-1",
    width: 320,
    height: 334,
    concept: "street light pole",
    categoryIntent: "pole",
    requestId: "req-1",
    mimeType: "image/jpeg",
    dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
    ...overrides,
  };
}

function mockFetch(respond: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((url: string, init?: RequestInit) => Promise.resolve(respond(url, init))) as unknown as typeof fetch;
}

describe("SSE parsing and event normalization", () => {
  it("collects data payloads and rejects malformed lines", () => {
    const events = parseSseEvents(': comment\n\ndata: {"a":1}\n\ndata: [DONE]\n\n');
    assert.deepEqual(events, [{ a: 1 }]);
    assert.throws(() => parseSseEvents("data: {oops}\n\n"), SamError);
  });

  it("synthesizes the text finalizer the live API omits", async () => {
    const out: Record<string, unknown>[] = [];
    for await (const event of normalizedEvents([delta("a"), partDone("a"), COMPLETED])) {
      out.push(event);
    }
    const types = out.map((event) => event.type);
    assert.deepEqual(types, [
      "response.output_text.delta",
      "response.content_part.done",
      "response.output_text.done",
      "response.completed",
    ]);
    assert.equal(out[2].text, "a");
  });

  it("treats a bare completion as the valid empty outcome", async () => {
    const out: Record<string, unknown>[] = [];
    for await (const event of normalizedEvents([COMPLETED])) {
      out.push(event);
    }
    assert.deepEqual(
      out.map((event) => event.type),
      ["response.output_text.done", "response.completed"],
    );
    assert.equal(out[0].text, "");
  });
});

describe("wire dimension verification", () => {
  it("accepts matching frames and empty output, rejects the rest", () => {
    verifyWireDimensions(LINE_TWO_OBJECTS, 320, 334);
    verifyWireDimensions("", 320, 334);
    assert.throws(() => verifyWireDimensions(LINE_TWO_OBJECTS, 640, 334), SamError);
    assert.throws(
      () =>
        verifyWireDimensions(
          "<0f>0<|box;x1=1;y1=1;x2=2;y2=2;w=320;h=334|>,1<|box;x1=1;y1=1;x2=2;y2=2;w=321;h=334|>",
          320,
          334,
        ),
      SamError,
    );
  });
});

describe("segmentImage", () => {
  it("sends one documented request and parses boxes, masks, and confidence", async () => {
    const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const fetchImpl = mockFetch((url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const half = Math.floor(LINE_CONFIDENCE.length / 2);
      return new Response(
        sse(delta(LINE_CONFIDENCE.slice(0, half)), delta(LINE_CONFIDENCE.slice(half)), partDone(LINE_CONFIDENCE), COMPLETED),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const result = await segmentImage(
      request({ width: 1800, height: 1200, requestId: "req-9" }),
      { apiKey: "MODEL-KEY", fetchImpl },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.meta.ai/v1/responses");
    assert.equal(seen[0].auth, "Bearer MODEL-KEY");
    const sent = seen[0].body;
    assert.equal(sent.model, "sam-3.1");
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.metadata, { mask_encoding: "one_bit", include_confidence: "true" });
    const content = (
      (sent.input as Record<string, unknown>[])[0].content as Record<string, unknown>[]
    );
    assert.equal(content[0].type, "input_text");
    assert.equal(content[0].text, "street light pole");
    assert.equal(content[1].type, "input_image");
    assert.ok(String(content[1].image_url).startsWith("data:image/jpeg;base64,"));

    assert.equal(result.requestId, "req-9");
    assert.equal(result.model, "sam-3.1");
    assert.equal(result.objects.length, 1);
    const object = result.objects[0];
    assert.equal(object.providerObjectId, "1");
    // Inclusive wire x2=679 becomes half-open right=680.
    assert.deepEqual(object.box, { left: 444, top: 625, right: 680, bottom: 851 });
    assert.deepEqual(object.boxNorm, {
      x: 444 / 1800,
      y: 625 / 1200,
      w: (680 - 444) / 1800,
      h: (851 - 625) / 1200,
    });
    assert.equal(object.confidence, 0.9609375);
    assert.ok(object.mask);
    assert.equal(object.mask!.width, 60);
    assert.equal(object.mask!.height, 27);
    assert.deepEqual(object.mask!.bounds, { left: 444, top: 625, right: 680, bottom: 851 });
    assert.equal(result.truncated, false);
  });

  it("pairs masks to boxes across a multi-object line", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(sse(delta(LINE_TWO_OBJECTS), partDone(LINE_TWO_OBJECTS), COMPLETED), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await segmentImage(request(), { apiKey: "MODEL-KEY", fetchImpl });
    assert.equal(result.objects.length, 2);
    assert.deepEqual(
      result.objects.map((object) => object.providerObjectId),
      ["0", "1"],
    );
    assert.ok(result.objects.every((object) => object.mask));
    assert.equal(result.objects[0].mask!.width, 60);
    assert.equal(result.objects[0].mask!.height, 27);
    assert.equal(result.objects[0].confidence, null);
  });

  it("treats completed empty output as zero matches, not an error", async () => {
    for (const payload of [sse(partDone(""), COMPLETED), sse(COMPLETED)]) {
      const fetchImpl = mockFetch(
        () => new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
      const result = await segmentImage(request(), { apiKey: "MODEL-KEY", fetchImpl });
      assert.deepEqual(result.objects, []);
      assert.equal(result.truncated, false);
    }
  });

  it("maps auth, throttle, timeout, and failure outcomes to stable codes", async () => {
    const denied = segmentImage(request(), {
      apiKey: "bad",
      fetchImpl: mockFetch(() => new Response("{}", { status: 401 })),
    });
    await assert.rejects(denied, (error: unknown) => {
      assert.ok(error instanceof SamError);
      assert.equal(error.code, "SAM_AUTH_ERROR");
      assert.equal(error.retryable, false);
      return true;
    });

    let throttledBody: unknown = null;
    const throttled = segmentImage(request(), {
      apiKey: "key",
      fetchImpl: mockFetch(() => {
        throttledBody = { status: 429 };
        return new Response("{}", { status: 429, headers: { "retry-after": "12" } });
      }),
    });
    await assert.rejects(throttled, (error: unknown) => {
      assert.ok(error instanceof SamError);
      assert.equal(error.code, "SAM_RATE_LIMITED");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSec, 12);
      return true;
    });
    assert.deepEqual(throttledBody, { status: 429 });

    const hanging = segmentImage(request(), {
      apiKey: "key",
      fetchImpl: mockFetch(
        () =>
          new Response(
            new ReadableStream({
              start() {
                // Never produces bytes: the deadline must fire.
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
      timeoutMs: 50,
    });
    await assert.rejects(hanging, (error: unknown) => {
      assert.ok(error instanceof SamError);
      assert.equal(error.code, "SAM_TIMEOUT");
      return true;
    });

    const failed = segmentImage(request(), {
      apiKey: "key",
      fetchImpl: mockFetch(
        () =>
          new Response(sse({ type: "response.failed", response: { error: { message: "boom" } } }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    });
    await assert.rejects(failed, (error: unknown) => {
      assert.ok(error instanceof SamError);
      assert.equal(error.code, "SAM_REQUEST_FAILED");
      return true;
    });
  });

  it("never interprets malformed output as zero matches", async () => {
    const garbage = segmentImage(request(), {
      apiKey: "key",
      fetchImpl: mockFetch(
        () => new Response(sse(delta("definitely not grammar"), partDone("definitely not grammar"), COMPLETED), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    });
    await assert.rejects(garbage, /could not be parsed|different image size|contained errors|no usable detections/);

    const truncated = segmentImage(request(), {
      apiKey: "key",
      fetchImpl: mockFetch(
        () => new Response(sse(delta(LINE_TWO_OBJECTS.slice(0, 40))), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    });
    await assert.rejects(truncated, SamError);
  });
});
