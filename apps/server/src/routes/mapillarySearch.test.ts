import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type express from "express";
import { createApp } from "../app.js";

const VALID_ROI = {
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
};

function mockProvider(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

interface RouteResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** Portable request helper: unix socket (posix) or named pipe (Windows); no TCP needed. */
async function postSearch(
  app: express.Express,
  payload: unknown,
  socketSuffix: string,
): Promise<RouteResponse> {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\oslm-test-${process.pid}-${socketSuffix}`
      : path.join(os.tmpdir(), `oslm-test-${process.pid}-${socketSuffix}.sock`);
  const server = app.listen(socketPath);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  try {
    const data = JSON.stringify(payload);
    return await new Promise<RouteResponse>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: "/api/mapillary/images/search",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: text ? (JSON.parse(text) as unknown) : null,
            });
          });
        },
      );
      request.on("error", reject);
      request.end(data);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("POST /api/mapillary/images/search", () => {
  const previousToken = process.env.MAPILLARY_ACCESS_TOKEN;

  beforeEach(() => {
    process.env.MAPILLARY_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = previousToken;
  });

  it("returns the normalized envelope on success", async () => {
    const app = createApp({
      mapillaryFetch: mockProvider({
        data: [
          {
            id: "img-1",
            geometry: { type: "Point", coordinates: [19.042, 47.497] },
            captured_at: "2024-05-01T12:00:00.000Z",
            is_pano: false,
            sequence: "seq-1",
          },
        ],
      }),
    });
    const response = await postSearch(app, { roi: VALID_ROI }, "success");
    assert.equal(response.status, 200);
    const body = response.body as {
      images: unknown[];
      query: Record<string, unknown>;
      warnings: unknown[];
    };
    assert.equal(body.images.length, 1);
    assert.equal(body.query.matchedCount, 1);
    assert.equal(body.query.rawReturnedCount, 1);
    assert.equal(body.query.retrievalStatus, "not_capped");
    assert.deepEqual(body.query.bbox, [19.04, 47.495, 19.045, 47.5]);
    assert.deepEqual(body.warnings, []);
  });

  it("returns 200 with an empty array for zero matches", async () => {
    const app = createApp({ mapillaryFetch: mockProvider({ data: [] }) });
    const response = await postSearch(app, { roi: VALID_ROI }, "empty");
    assert.equal(response.status, 200);
    const body = response.body as { images: unknown[]; query: Record<string, unknown> };
    assert.deepEqual(body.images, []);
    assert.equal(body.query.matchedCount, 0);
  });

  it("rejects invalid geometry with 400 and no provider call", async () => {
    let calls = 0;
    const app = createApp({
      mapillaryFetch: (async () => {
        calls += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const response = await postSearch(
      app,
      { roi: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] } },
      "bad-geo",
    );
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, "TOO_FEW_VERTICES");
    assert.equal(calls, 0);
  });

  it("rejects oversized regions with 400", async () => {
    const app = createApp({ mapillaryFetch: mockProvider({ data: [] }) });
    const response = await postSearch(
      app,
      {
        roi: {
          type: "Polygon",
          coordinates: [[[18, 46], [20, 46], [20, 48], [18, 48], [18, 46]]],
        },
      },
      "too-big",
    );
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, "AREA_TOO_LARGE");
  });

  it("returns 503 when the server search token is missing", async () => {
    delete process.env.MAPILLARY_ACCESS_TOKEN;
    const app = createApp({ mapillaryFetch: mockProvider({ data: [] }) });
    const response = await postSearch(app, { roi: VALID_ROI }, "no-token");
    assert.equal(response.status, 503);
    const body = response.body as { error: { code: string; message: string } };
    assert.equal(body.error.code, "MAPILLARY_NOT_CONFIGURED");
    assert.ok(!body.error.message.includes("test-token"));
  });

  it("maps provider auth failures to sanitized 502", async () => {
    const app = createApp({
      mapillaryFetch: mockProvider({ error: { code: 190, message: "bad" } }, 401),
    });
    const response = await postSearch(app, { roi: VALID_ROI }, "auth");
    assert.equal(response.status, 502);
    const body = response.body as { error: { code: string; message: string } };
    assert.equal(body.error.code, "MAPILLARY_AUTH_ERROR");
    assert.ok(!JSON.stringify(body).includes("test-token"));
  });

  it("keeps fake tokens out of error responses and server logs", async () => {
    const leaked = "MLY|FAKE_TOKEN_abc123";
    const app = createApp({
      mapillaryFetch: mockProvider(
        {
          error: {
            code: 190,
            message: `invalid ${leaked} see https://graph.mapillary.com/x?access_token=${leaked}`,
          },
        },
        401,
      ),
    });
    const logged: string[] = [];
    const methods = ["log", "warn", "error", "debug", "info"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) {
      console[method] = ((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }) as never;
    }
    try {
      const response = await postSearch(app, { roi: VALID_ROI }, "leak");
      assert.equal(response.status, 502);
      assert.ok(!JSON.stringify(response.body).includes("FAKE_TOKEN"));
      assert.ok(!JSON.stringify(response.body).includes("access_token="));
      assert.ok(!logged.join("\n").includes("FAKE_TOKEN"));
    } finally {
      methods.forEach((method, index) => {
        console[method] = originals[index];
      });
    }
  });

  it("keeps the health contract with the provider configuration flag", async () => {
    const app = createApp();
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\oslm-test-${process.pid}-health`
        : path.join(os.tmpdir(), `oslm-test-${process.pid}-health.sock`);
    const server = app.listen(socketPath);
    await new Promise<void>((resolve) => server.on("listening", resolve));
    try {
      const body = (await new Promise<unknown>((resolve, reject) => {
        http
          .get({ socketPath, path: "/api/health" }, (response) => {
            let text = "";
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("end", () => resolve(JSON.parse(text) as unknown));
          })
          .on("error", reject);
      })) as {
        service: string;
        status: string;
        providers: { mapillarySearch: { configured: boolean } };
      };
      assert.equal(body.service, "openstreetlightmapper-server");
      assert.equal(body.status, "ok");
      assert.equal(body.providers.mapillarySearch.configured, true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
