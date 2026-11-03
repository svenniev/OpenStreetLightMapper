/**
 * Shared provider HTTP transport with deadline-through-body semantics.
 *
 * Every provider call (Mapillary search/membership/batches, Overpass) goes
 * through `fetchJsonWithLimits` so timeouts and caller cancellation cover the
 * entire request INCLUDING body consumption and parsing — a response that
 * sends headers then stalls cannot outlive the advertised timeout.
 *
 * Diagnostics are codes and statuses only: raw upstream bodies are never
 * logged or returned, so credentials inside provider messages cannot leak.
 */

/** 10 MiB response-body cap per provider request. Fail, don't buffer forever. */
export const PROVIDER_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export type TransportFailureKind =
  | "timeout"
  | "aborted"
  | "network"
  | "too_large"
  | "bad_json";

export class TransportError extends Error {
  readonly kind: TransportFailureKind;

  constructor(kind: TransportFailureKind, message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

export interface FetchJsonOptions {
  fetchImpl: typeof fetch;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Deadline covering connect, headers, body, and parse. */
  timeoutMs: number;
  maxBytes?: number;
  /** External cancellation (client disconnect, user cancel, total deadline). */
  signal?: AbortSignal;
}

export interface FetchBytesOptions extends FetchJsonOptions {
  /**
   * Redirect policy for the single request. Media fetches use "manual" so
   * each hop's destination can be validated before following it.
   */
  redirect?: "error" | "follow" | "manual";
}

export interface FetchBytesResult {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export interface FetchJsonResult {
  status: number;
  headers: Headers;
  json: unknown;
}

function throwForAbort(external: AbortSignal | undefined): never {
  if (external?.aborted) {
    throw new TransportError("aborted", "Caller cancelled the provider request.");
  }
  throw new TransportError("timeout", "Provider request timed out.");
}

export async function fetchJsonWithLimits(
  url: string,
  options: FetchJsonOptions,
): Promise<FetchJsonResult> {
  const { fetchImpl, timeoutMs } = options;
  const maxBytes = options.maxBytes ?? PROVIDER_BODY_LIMIT_BYTES;
  const external = options.signal;

  // Already-aborted callers stop before any socket work.
  if (external?.aborted) throwForAbort(external);

  // Explicit ref'd timer: AbortSignal.timeout() does not keep the event loop
  // alive. Released in the outer finally, after body reading and parsing.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  external?.addEventListener("abort", forwardAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (external?.aborted) throwForAbort(external);
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new TransportError("timeout", "Provider request timed out.");
      }
      throw new TransportError("network", "Could not reach the provider (network failure).");
    }

    // Stream the body with a byte cap; cancellation stays wired throughout.
    let text: string;
    if (!response.body) {
      text = "";
    } else {
      const reader = response.body.getReader();
      const cancelReader = () => {
        reader.cancel().catch(() => undefined);
      };
      // Timeout/caller aborts must interrupt a stalled body read.
      if (controller.signal.aborted) {
        cancelReader();
        throwForAbort(external);
      }
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch {
            if (external?.aborted || controller.signal.aborted) throwForAbort(external);
            throw new TransportError("network", "Provider response stream failed.");
          }
          if (read.done) {
            // cancel() resolves a pending read as done instead of rejecting:
            // an aborted stream is a timeout/cancellation, not an empty body.
            if (controller.signal.aborted) throwForAbort(external);
            break;
          }
          total += read.value.byteLength;
          if (total > maxBytes) {
            cancelReader();
            throw new TransportError(
              "too_large",
              `Provider response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MiB safety limit.`,
            );
          }
          chunks.push(read.value);
        }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        text = new TextDecoder().decode(merged);
      } finally {
        controller.signal.removeEventListener("abort", cancelReader);
        try {
          reader.releaseLock();
        } catch {
          // Best-effort; the reader may already be closed after cancel().
        }
      }
    }

    // Error statuses often carry XML/text bodies (Overpass especially):
    // those must reach the caller's status handling with json null, never
    // mask as malformed JSON. Only a 2xx body is required to parse.
    const ok = response.status >= 200 && response.status < 300;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      if (ok) throw new TransportError("bad_json", "Provider returned malformed JSON.");
      json = null;
    }
    return { status: response.status, headers: response.headers, json };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Byte variant of `fetchJsonWithLimits` for media payloads: same
 * deadline-through-body semantics, caller cancellation, and byte cap, but no
 * JSON parsing — the caller validates status, content type, and redirects.
 */
export async function fetchBytesWithLimits(
  url: string,
  options: FetchBytesOptions,
): Promise<FetchBytesResult> {
  const { fetchImpl, timeoutMs } = options;
  const maxBytes = options.maxBytes ?? PROVIDER_BODY_LIMIT_BYTES;
  const external = options.signal;

  if (external?.aborted) throwForAbort(external);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  external?.addEventListener("abort", forwardAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        redirect: options.redirect,
        signal: controller.signal,
      });
    } catch (error) {
      if (external?.aborted) throwForAbort(external);
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new TransportError("timeout", "Provider request timed out.");
      }
      throw new TransportError("network", "Could not reach the provider (network failure).");
    }

    let bytes: Uint8Array;
    if (!response.body) {
      bytes = new Uint8Array(0);
    } else {
      const reader = response.body.getReader();
      const cancelReader = () => {
        reader.cancel().catch(() => undefined);
      };
      if (controller.signal.aborted) {
        cancelReader();
        throwForAbort(external);
      }
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch {
            if (external?.aborted || controller.signal.aborted) throwForAbort(external);
            throw new TransportError("network", "Provider response stream failed.");
          }
          if (read.done) {
            if (controller.signal.aborted) throwForAbort(external);
            break;
          }
          total += read.value.byteLength;
          if (total > maxBytes) {
            cancelReader();
            throw new TransportError(
              "too_large",
              `Provider response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MiB safety limit.`,
            );
          }
          chunks.push(read.value);
        }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        bytes = merged;
      } finally {
        controller.signal.removeEventListener("abort", cancelReader);
        try {
          reader.releaseLock();
        } catch {
          // Best-effort; the reader may already be closed after cancel().
        }
      }
    }

    return { status: response.status, headers: response.headers, bytes };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", forwardAbort);
  }
}
