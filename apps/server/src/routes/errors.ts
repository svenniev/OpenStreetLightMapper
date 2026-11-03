import type express from "express";
import { ClientAbortedError, MapillaryError } from "../mapillary.js";
import { SamError } from "../sam.js";

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

export function errorBody(code: string, message: string, retryable: boolean): ErrorBody {
  return { error: { code, message, retryable } };
}

/**
 * Shared Mapillary error mapping for discovery and sequence routes.
 * Returns true when the error was a handled MapillaryError (response sent).
 */
export function sendMapillaryError(res: express.Response, error: unknown): boolean {
  if (error instanceof ClientAbortedError) return true; // Caller is gone; nothing to send.
  if (error instanceof MapillaryError) {
    const status =
      error.code === "MAPILLARY_RATE_LIMITED"
        ? 429
        : error.code === "MAPILLARY_TIMEOUT"
          ? 504
          : 502;
    if (error.code === "MAPILLARY_RATE_LIMITED" && error.retryAfterSec !== undefined) {
      res.setHeader("Retry-After", String(error.retryAfterSec));
    }
    res.status(status).json(errorBody(error.code, error.message, error.retryable));
    return true;
  }
  return false;
}

/** SAM error mapping: 429 stays 429, timeouts 504, provider failures 502. */
export function sendSamError(res: express.Response, error: SamError): void {
  const status =
    error.code === "SAM_RATE_LIMITED" ? 429 : error.code === "SAM_TIMEOUT" ? 504 : 502;
  if (error.code === "SAM_RATE_LIMITED" && error.retryAfterSec !== undefined) {
    res.setHeader("Retry-After", String(error.retryAfterSec));
  }
  res.status(status).json(errorBody(error.code, error.message, error.retryable));
}

/**
 * Abort the given controller when the HTTP client disconnects mid-request.
 * Returns a cleanup function for the route's finally block.
 */
export function abortOnDisconnect(
  res: express.Response,
  controller: AbortController,
): () => void {
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  return () => {
    res.off("close", onClose);
  };
}
