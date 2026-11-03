import { useCallback, useState } from "react";
import { ApiError, createDeadlineSignal } from "../../lib/api";
import {
  mediaUrlFor,
  postSamDetection,
  rasterizeView,
} from "../../lib/detectionClient";
import { SAM_CLIENT_TIMEOUT_MS } from "./useInventorySessions";
import type { ViewMedia } from "./useViewMedia";

/**
 * SAM readiness state: server configuration (from health, never a billable
 * probe) plus the session's explicit single-image test outcome. Testing
 * transmits the selected image to Meta and spends model credits — the UI
 * must say so at the button.
 */

export interface SamTestOutcome {
  at: string;
  ok: boolean;
  objects: number;
  truncated: boolean;
  message: string;
  imageId: string;
  concept: string;
}

export type SamReadiness =
  | { status: "unknown" }
  | { status: "not-configured"; model: string }
  | { status: "configured-unverified"; model: string }
  | { status: "available"; model: string; lastTest: SamTestOutcome }
  | { status: "last-test-failed"; model: string; lastTest: SamTestOutcome };

export interface SamStatus {
  readiness: SamReadiness;
  model: string;
  testing: boolean;
  lastTest: SamTestOutcome | null;
  testOnImage: (imageId: string, concept: string) => Promise<SamTestOutcome>;
}

export function useSamStatus(options: {
  configured: boolean | null;
  model: string;
  viewMedia: ViewMedia;
}): SamStatus {
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState<SamTestOutcome | null>(null);

  const testOnImage = useCallback(
    async (imageId: string, concept: string): Promise<SamTestOutcome> => {
      const trimmed = concept.trim();
      const fail = (message: string): SamTestOutcome => {
        const outcome: SamTestOutcome = {
          at: new Date().toISOString(),
          ok: false,
          objects: 0,
          truncated: false,
          message,
          imageId,
          concept: trimmed,
        };
        setLastTest(outcome);
        return outcome;
      };
      if (trimmed.length === 0) return fail("Enter a concept to test.");
      setTesting(true);
      try {
        const detail = await options.viewMedia.ensureImage(imageId);
        const raster = await rasterizeView({ crop: null }, mediaUrlFor(detail.media.handle));
        const controller = new AbortController();
        const { signal, release } = createDeadlineSignal(SAM_CLIENT_TIMEOUT_MS, controller.signal);
        try {
          const response = await postSamDetection(
            {
              view: { viewId: `test-${imageId}`, imageId, width: raster.width, height: raster.height },
              concept: trimmed,
              categoryIntent: "pole",
              requestId:
                typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                  ? crypto.randomUUID()
                  : `test-${Date.now().toString(36)}`,
              image: {
                mimeType: raster.mimeType,
                dataBase64: raster.dataBase64,
                width: raster.width,
                height: raster.height,
              },
            },
            signal,
          );
          const outcome: SamTestOutcome = {
            at: new Date().toISOString(),
            ok: true,
            objects: response.objects.length,
            truncated: response.truncated,
            message:
              response.objects.length === 0
                ? "Test succeeded — the model returned no matches for this concept."
                : `Test succeeded — ${response.objects.length} match${response.objects.length === 1 ? "" : "es"}.`,
            imageId,
            concept: trimmed,
          };
          setLastTest(outcome);
          return outcome;
        } finally {
          release();
        }
      } catch (error) {
        if (error instanceof ApiError) return fail(error.message);
        return fail("The SAM test failed unexpectedly.");
      } finally {
        setTesting(false);
      }
    },
    [options.viewMedia],
  );

  // options.configured/options.model are render inputs; compute readiness inline.
  const readiness: SamReadiness = (() => {
    if (options.configured === null) return { status: "unknown" };
    if (!options.configured) return { status: "not-configured", model: options.model };
    if (!lastTest) return { status: "configured-unverified", model: options.model };
    return lastTest.ok
      ? { status: "available", model: options.model, lastTest }
      : { status: "last-test-failed", model: options.model, lastTest };
  })();

  return { readiness, model: options.model, testing, lastTest, testOnImage };
}
