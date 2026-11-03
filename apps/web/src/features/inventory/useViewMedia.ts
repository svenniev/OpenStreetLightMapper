import { useCallback, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  fetchImagery,
  mediaUrlFor,
  type ImageryResponse,
} from "../../lib/detectionClient";

/**
 * Lazy photograph metadata cache: thumbnails and annotation surfaces fetch
 * their Mapillary metadata on demand, bounded and deduplicated. Reads never
 * touch session state, so lazy retrieval cannot mutate the preparation
 * fingerprint or invalidate review.
 */

export type ViewImageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; detail: ImageryResponse }
  | { status: "failed"; error: string; retryable: boolean };

/** Bounded session cache: oldest ready entries drop off past the cap. */
export const VIEW_MEDIA_CACHE_MAX = 30;

export interface ViewMedia {
  states: Record<string, ViewImageState>;
  ensureImage: (imageId: string) => Promise<ImageryResponse>;
  refreshImage: (imageId: string) => Promise<ImageryResponse>;
  mediaUrl: (handle: string) => string;
}

export function useViewMedia(): ViewMedia {
  const [states, setStates] = useState<Record<string, ViewImageState>>({});
  const inflight = useRef(new Map<string, Promise<ImageryResponse>>());
  const order = useRef<string[]>([]);
  const ready = useRef(new Map<string, ImageryResponse>());

  const store = useCallback((imageId: string, detail: ImageryResponse) => {
    ready.current.set(imageId, detail);
    setStates((prev) => {
      const next = { ...prev, [imageId]: { status: "ready", detail } as ViewImageState };
      const keys = order.current.filter((key) => key !== imageId);
      keys.push(imageId);
      while (keys.length > VIEW_MEDIA_CACHE_MAX) {
        const oldest = keys.shift();
        if (oldest !== undefined && oldest !== imageId) {
          delete next[oldest];
          ready.current.delete(oldest);
        }
      }
      order.current = keys;
      return next;
    });
  }, []);

  const load = useCallback(
    (imageId: string, force: boolean): Promise<ImageryResponse> => {
      const pending = inflight.current.get(imageId);
      if (pending && !force) return pending;
      if (!force) {
        const cached = ready.current.get(imageId);
        if (cached) return Promise.resolve(cached);
      }
      setStates((prev) => ({ ...prev, [imageId]: { status: "loading" } }));
      const task = fetchImagery(imageId)
        .then((detail) => {
          store(imageId, detail);
          return detail;
        })
        .catch((error: unknown) => {
          const message =
            error instanceof ApiError ? error.message : "The photograph metadata failed to load.";
          const retryable = error instanceof ApiError ? error.retryable : true;
          setStates((prev) => ({ ...prev, [imageId]: { status: "failed", error: message, retryable } }));
          throw error;
        })
        .finally(() => {
          if (inflight.current.get(imageId) === task) inflight.current.delete(imageId);
        });
      inflight.current.set(imageId, task);
      return task;
    },
    [store],
  );

  const ensureImage = useCallback((imageId: string) => load(imageId, false), [load]);
  const refreshImage = useCallback((imageId: string) => load(imageId, true), [load]);

  return { states, ensureImage, refreshImage, mediaUrl: mediaUrlFor };
}
