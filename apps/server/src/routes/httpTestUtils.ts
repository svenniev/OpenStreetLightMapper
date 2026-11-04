import http from "node:http";
import os from "node:os";
import path from "node:path";
import type express from "express";

/**
 * Portable route-test transport: unix socket (posix) or named pipe (Windows).
 * No TCP needed, so tests run in restricted sandboxes too.
 */
export interface RouteResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export function socketPathFor(suffix: string): string {
  const tag = suffix.replace(/[^a-z0-9-]+/gi, "-");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\oslm-test-${process.pid}-${tag}`
    : path.join(os.tmpdir(), `oslm-test-${process.pid}-${tag}.sock`);
}

async function withServer<T>(
  app: express.Express,
  suffix: string,
  run: (socketPath: string) => Promise<T>,
): Promise<T> {
  const socketPath = socketPathFor(suffix);
  const server = app.listen(socketPath);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  try {
    return await run(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function readJson(response: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = "";
    response.on("data", (chunk) => {
      text += chunk;
    });
    response.on("end", () => {
      try {
        resolve(text ? (JSON.parse(text) as unknown) : null);
      } catch (error) {
        reject(error);
      }
    });
    response.on("error", reject);
  });
}

export async function postJson(
  app: express.Express,
  routePath: string,
  payload: unknown,
  suffix: string,
): Promise<RouteResponse> {
  return withServer(app, suffix, async (socketPath) => {
    const data = JSON.stringify(payload);
    return new Promise<RouteResponse>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: routePath,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
          },
        },
        (response) => {
          readJson(response).then(
            (body) =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
            reject,
          );
        },
      );
      request.on("error", reject);
      request.end(data);
    });
  });
}

export async function putJson(
  app: express.Express,
  routePath: string,
  payload: unknown,
  suffix: string,
): Promise<RouteResponse> {
  return withServer(app, suffix, async (socketPath) => {
    const data = JSON.stringify(payload);
    return new Promise<RouteResponse>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: routePath,
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
          },
        },
        (response) => {
          readJson(response).then(
            (body) =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
            reject,
          );
        },
      );
      request.on("error", reject);
      request.end(data);
    });
  });
}

export async function getJson(
  app: express.Express,
  routePath: string,
  suffix: string,
): Promise<RouteResponse> {
  return withServer(app, suffix, async (socketPath) => {
    return new Promise<RouteResponse>((resolve, reject) => {
      http
        .get({ socketPath, path: routePath }, (response) => {
          readJson(response).then(
            (body) =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
            reject,
          );
        })
        .on("error", reject);
    });
  });
}

export interface RouteBytesResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
}

export async function getBytes(
  app: express.Express,
  routePath: string,
  suffix: string,
): Promise<RouteBytesResponse> {
  return withServer(app, suffix, async (socketPath) => {
    return new Promise<RouteBytesResponse>((resolve, reject) => {
      http
        .get({ socketPath, path: routePath }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              bytes: Buffer.concat(chunks),
            });
          });
          response.on("error", reject);
        })
        .on("error", reject);
    });
  });
}

export function mockJsonProvider(
  respond: (url: string) => Response,
  onCall?: (url: string) => void,
): typeof fetch {
  return (async (url: string) => {
    onCall?.(String(url));
    return respond(String(url));
  }) as unknown as typeof fetch;
}

export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}
