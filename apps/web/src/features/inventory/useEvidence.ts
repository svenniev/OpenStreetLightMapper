import { useCallback, useEffect, useRef, useState } from "react";
import { artifactUrlFor } from "../../lib/workspaceApi";
import { mediaUrlFor } from "../../lib/detectionClient";
import type { ViewMedia } from "./useViewMedia";
import type {
  InventoryObservation,
  ObservationMask,
  SourceView,
} from "./inventoryTypes";

export type ViewSourceStatus = "ready" | "loading" | "unavailable";

export interface ViewSource {
  status: ViewSourceStatus;
  /** Usable pixel URL (local evidence first, provider media otherwise). */
  url: string | null;
  /** True when pixels come from durable local evidence. */
  fromArtifact: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Resolve one view's pixels: durable local evidence first, live provider
 * media next, one automatic refresh on stale handles. Only when none of
 * those resolve does the caller show "Source image unavailable locally"
 * with the explicit refetch action.
 */
export function useViewSourceUrl(view: SourceView | null, viewMedia: ViewMedia): ViewSource {
  const [state, setState] = useState<Omit<ViewSource, "refetch">>(() =>
    view?.artifactId
      ? { status: "ready", url: artifactUrlFor(view.artifactId), fromArtifact: true, error: null }
      : { status: "loading", url: null, fromArtifact: false, error: null },
  );
  const attemptRef = useRef(0);

  const resolve = useCallback(
    async (target: SourceView, attempt: number, forceRefresh: boolean) => {
      if (target.artifactId) {
        if (attemptRef.current === attempt) {
          setState({
            status: "ready",
            url: artifactUrlFor(target.artifactId),
            fromArtifact: true,
            error: null,
          });
        }
        return;
      }
      try {
        const detail = forceRefresh
          ? await viewMedia.refreshImage(target.imageId)
          : await viewMedia.ensureImage(target.imageId);
        if (attemptRef.current !== attempt) return;
        setState({
          status: "ready",
          url: mediaUrlFor(detail.media.handle),
          fromArtifact: false,
          error: null,
        });
      } catch (error) {
        if (attemptRef.current !== attempt) return;
        if (!forceRefresh) {
          // One automatic refresh before surfacing unavailability.
          await resolve(target, attempt, true);
          return;
        }
        setState({
          status: "unavailable",
          url: null,
          fromArtifact: false,
          error: error instanceof Error ? error.message : "The photograph failed to load.",
        });
      }
    },
    [viewMedia],
  );

  const viewId = view?.viewId ?? null;
  const artifactId = view?.artifactId ?? null;
  const imageId = view?.imageId ?? null;
  useEffect(() => {
    if (!viewId || !imageId) {
      setState({ status: "unavailable", url: null, fromArtifact: false, error: null });
      return;
    }
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    if (artifactId) {
      setState({
        status: "ready",
        url: artifactUrlFor(artifactId),
        fromArtifact: true,
        error: null,
      });
      return;
    }
    setState({ status: "loading", url: null, fromArtifact: false, error: null });
    void resolve(
      { viewId, imageId, artifactId: null } as SourceView,
      attempt,
      false,
    );
  }, [viewId, artifactId, imageId, resolve]);

  const refetch = useCallback(() => {
    if (!view) return;
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    setState({ status: "loading", url: null, fromArtifact: false, error: null });
    void resolve(view, attempt, true);
  }, [resolve, view]);

  return { ...state, refetch };
}

export interface MaskFetcher {
  fetchFullItem: (
    runId: string,
    itemId: string,
  ) => Promise<{
    status: string;
    objects: { providerObjectId: string; mask: ObservationMask | null }[];
  } | null>;
}

/**
 * Reattach model masks stripped from stored observations. Fetches each
 * backing item once per mount and maps provider objects to masks; missing
 * items stay missing (no fake geometry).
 */
export function useRecoveredMasks(
  observations: InventoryObservation[],
  sessionKey: string | null,
  fetcher: MaskFetcher | null,
): Record<string, ObservationMask> {
  const [masks, setMasks] = useState<Record<string, ObservationMask>>({});
  const doneRef = useRef(new Set<string>());
  // Rerun only when the set of mask-less model observations changes.
  const wantedKey = observations
    .filter((observation) => !observation.mask && observation.provenance)
    .map((observation) => `${observation.id}:${observation.provenance?.providerObjectId ?? ""}`)
    .sort()
    .join(",");

  useEffect(() => {
    if (!sessionKey || !fetcher || wantedKey === "") return;
    const wanted = new Map<string, { runId: string; itemId: string; obsIds: string[] }>();
    for (const observation of observations) {
      if (observation.mask || !observation.provenance) continue;
      const { runId, itemId, providerObjectId } = observation.provenance;
      const key = `${runId} ${itemId}`;
      if (doneRef.current.has(`${key} ${providerObjectId}`)) continue;
      const entry = wanted.get(key) ?? { runId, itemId, obsIds: [] as string[] };
      entry.obsIds.push(observation.id);
      wanted.set(key, entry);
    }
    if (wanted.size === 0) return;
    let cancelled = false;
    void (async () => {
      const found: Record<string, ObservationMask> = {};
      for (const { runId, itemId, obsIds } of wanted.values()) {
        const full = await fetcher.fetchFullItem(runId, itemId).catch(() => null);
        if (!full) continue;
        const byObject = new Map(
          full.objects.map((object) => [object.providerObjectId, object.mask] as const),
        );
        for (const obsId of obsIds) {
          const observation = observations.find((entry) => entry.id === obsId);
          const mask = observation?.provenance
            ? byObject.get(observation.provenance.providerObjectId)
            : undefined;
          if (observation?.provenance) {
            doneRef.current.add(`${runId} ${itemId} ${observation.provenance.providerObjectId}`);
          }
          if (mask) found[obsId] = mask;
        }
      }
      if (!cancelled && Object.keys(found).length > 0) {
        setMasks((prev) => ({ ...prev, ...found }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // wantedKey covers observation changes; doneRef keeps fetches to one
    // attempt per backing object per mount.
  }, [sessionKey, fetcher, wantedKey]);

  return masks;
}
