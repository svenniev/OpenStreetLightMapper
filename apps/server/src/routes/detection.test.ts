import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { getJson, postJson } from "./httpTestUtils.js";

const LINE =
  "<0f>0<|box;x1=10;y1=20;x2=39;y2=59;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";

function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function successStream(): string {
  return sse(
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: LINE,
    },
    {
      type: "response.content_part.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: LINE },
    },
    { type: "response.completed" },
  );
}

function validBody(): Record<string, unknown> {
  return {
    view: { viewId: "view-1", imageId: "img-1", width: 320, height: 334 },
    concept: "street light pole",
    categoryIntent: "pole",
    requestId: "req-route-1",
    image: {
      mimeType: "image/jpeg",
      dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20]).toString("base64"),
      width: 320,
      height: 334,
    },
  };
}

function mockSam(respond: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((url: string, init?: RequestInit) => Promise.resolve(respond(url, init))) as unknown as typeof fetch;
}

describe("POST /api/detection/sam", () => {
  const previousKey = process.env.MODEL_API_KEY;

  beforeEach(() => {
    process.env.MODEL_API_KEY = "route-test-key";
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previousKey;
  });

  it("runs one concept on one raster and returns typed objects", async () => {
    const seen: string[] = [];
    const app = createApp({
      samFetch: mockSam((url) => {
        seen.push(url);
        return new Response(successStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });
    const response = await postJson(app, "/api/detection/sam", validBody(), "sam-route-ok");
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ["https://api.meta.ai/v1/responses"]);
    const body = response.body as {
      requestId: string;
      viewId: string;
      provider: string;
      model: string;
      prompt: string;
      categoryIntent: string;
      inputWidth: number;
      inputHeight: number;
      objects: {
        providerObjectId: string;
        box: unknown;
        boxNorm: { x: number; y: number; w: number; h: number };
        confidence: unknown;
        mask: { svgPath: string; width: number; height: number; bounds: unknown } | null;
      }[];
      truncated: boolean;
    };
    assert.equal(body.requestId, "req-route-1");
    assert.equal(body.viewId, "view-1");
    assert.equal(body.provider, "meta-sam");
    assert.equal(body.model, "sam-3.1");
    assert.equal(body.prompt, "street light pole");
    assert.equal(body.objects.length, 1);
    assert.equal(body.objects[0].providerObjectId, "0");
    assert.deepEqual(body.objects[0].box, { left: 10, top: 20, right: 40, bottom: 60 });
    assert.deepEqual(body.objects[0].boxNorm, {
      x: 10 / 320,
      y: 20 / 334,
      w: 30 / 320,
      h: 40 / 334,
    });
    assert.equal(body.objects[0].confidence, null);
    assert.ok(body.objects[0].mask?.svgPath.startsWith("M"));
    assert.equal(body.truncated, false);
    // No credentials or raster bytes echo back.
    assert.ok(!JSON.stringify(body).includes("route-test-key"));
  });

  it("validates requests before spending model calls", async () => {
    let calls = 0;
    const app = createApp({
      samFetch: mockSam(() => {
        calls += 1;
        return new Response(successStream(), { status: 200 });
      }),
    });
    const cases: Record<string, unknown>[] = [
      { ...validBody(), concept: "  " },
      { ...validBody(), concept: "pole\nluminaire" },
      { ...validBody(), categoryIntent: "bridge" },
      { ...validBody(), image: { ...(validBody().image as object), mimeType: "image/gif" } },
      { ...validBody(), image: { ...(validBody().image as object), width: 321 } },
      { ...validBody(), image: { ...(validBody().image as object), dataBase64: "not-base64!!" } },
      {
        ...validBody(),
        image: {
          ...(validBody().image as object),
          mimeType: "image/png",
          dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
        },
      },
    ];
    for (const [index, payload] of cases.entries()) {
      const response = await postJson(app, "/api/detection/sam", payload, `sam-route-bad-${index}`);
      assert.equal(response.status, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, "SAM_BAD_REQUEST");
    }
    assert.equal(calls, 0);
  });

  it("returns 503 when the model key is missing", async () => {
    delete process.env.MODEL_API_KEY;
    const app = createApp({
      samFetch: mockSam(() => new Response(successStream(), { status: 200 })),
    });
    const response = await postJson(app, "/api/detection/sam", validBody(), "sam-route-nokey");
    assert.equal(response.status, 503);
    assert.equal((response.body as { error: { code: string } }).error.code, "SAM_NOT_CONFIGURED");
  });

  it("maps provider failures to stable statuses without raw bodies", async () => {
    const denied = createApp({
      samFetch: mockSam(() => new Response(JSON.stringify({ error: "nope" }), { status: 403 })),
    });
    const deniedResponse = await postJson(denied, "/api/detection/sam", validBody(), "sam-route-403");
    assert.equal(deniedResponse.status, 502);
    const deniedBody = deniedResponse.body as { error: { code: string; message: string } };
    assert.equal(deniedBody.error.code, "SAM_AUTH_ERROR");
    assert.ok(!JSON.stringify(deniedBody).includes("nope"));

    const throttled = createApp({
      samFetch: mockSam(
        () => new Response("{}", { status: 429, headers: { "retry-after": "9" } }),
      ),
    });
    const throttledResponse = await postJson(
      throttled,
      "/api/detection/sam",
      validBody(),
      "sam-route-429",
    );
    assert.equal(throttledResponse.status, 429);
    assert.equal(throttledResponse.headers["retry-after"], "9");

    const broken = createApp({
      samFetch: mockSam(
        () =>
          new Response(sse({ type: "response.output_text.delta" }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    });
    const brokenResponse = await postJson(broken, "/api/detection/sam", validBody(), "sam-route-bad");
    assert.equal(brokenResponse.status, 502);
    assert.equal((brokenResponse.body as { error: { code: string } }).error.code, "SAM_BAD_RESPONSE");
  });

  it("reports SAM configuration (only) on the health endpoint", async () => {
    const app = createApp({});
    const response = await getJson(app, "/api/health", "sam-health");
    assert.equal(response.status, 200);
    const providers = (response.body as { providers: Record<string, unknown> }).providers;
    assert.deepEqual(providers.samDetection, { configured: true, model: "sam-3.1" });
  });
});
