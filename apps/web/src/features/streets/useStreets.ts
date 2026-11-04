import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createDeadlineSignal,
  fetchStreets,
  type StreetSearchResponse,
  type StreetWorkItem,
} from "../../lib/api";
import { createSearchGuard } from "../../lib/search";
import type { CommittedRoi, SearchError } from "../../lib/searchTypes";
import type { DemoSeed } from "./seedDemo";

export type StreetsStatus = "idle" | "loading" | "loaded" | "failed";

/** Client deadline for street retrieval (server governs ~25 s upstream). */
export const STREETS_CLIENT_TIMEOUT_MS = 35_000;

export interface UseStreetsOptions {
  roi: CommittedRoi | null;
  backendConnected: boolean;
  /**
   * Restored street snapshot for a reopened workspace (remount per
   * workspace). Seeds the list without re-querying Overpass.
   */
  initial?: {
    status: StreetsStatus;
    streets: StreetWorkItem[];
    query: StreetSearchResponse["query"] | null;
    warnings: string[];
    error: SearchError | null;
    checkedIds: string[];
    focusedId: string | null;
    seeded: boolean;
    snapshotId: number;
  } | null;
}

/**
 * Region street retrieval and participation state. Exactly one request runs
 * per committed region: the change-detector effect is StrictMode-safe (the
 * second mount pass sees the same key and skips), while region replacement
 * and clearing abort outstanding work and discard dependent lists. Selection
 * survives imagery browsing and rerenders; only explicit checkbox actions
 * bump the selection version.
 */
export function useStreets(options: UseStreetsOptions) {
  const initial = options.initial ?? null;
  const [status, setStatus] = useState<StreetsStatus>(initial?.status ?? "idle");
  const [streets, setStreets] = useState<StreetWorkItem[]>(initial?.streets ?? []);
  const [query, setQuery] = useState<StreetSearchResponse["query"] | null>(initial?.query ?? null);
  const [warnings, setWarnings] = useState<string[]>(initial?.warnings ?? []);
  const [error, setError] = useState<SearchError | null>(initial?.error ?? null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(initial?.checkedIds ?? []),
  );
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(initial?.focusedId ?? null);
  const [snapshotId, setSnapshotId] = useState(initial?.snapshotId ?? 0);
  const [seeded, setSeeded] = useState(initial?.seeded ?? false);

  const guardRef = useRef(createSearchGuard());
  const abortRef = useRef<AbortController | null>(null);
  // Prime the change detector so opening a workspace never fetches on
  // mount — not for its own snapshot, and not for a region whose streets
  // were never loaded (explicit Retry covers that).
  const lastKeyRef = useRef<string | null>(
    initial ? (options.roi && options.roi.valid ? `roi-${options.roi.id}` : null) : null,
  );

  const roiRef = useRef(options.roi);
  roiRef.current = options.roi;
  const statusRef = useRef(status);
  statusRef.current = status;

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    guardRef.current.invalidate();
    setStatus("idle");
    setStreets([]);
    setQuery(null);
    setWarnings([]);
    setError(null);
    setCheckedIds(new Set());
    setFocusedId(null);
    setSeeded(false);
  }, []);

  const startFetch = useCallback(async (roi: CommittedRoi) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = guardRef.current.next();
    const roiId = roi.id;
    // A new region replaces the list immediately: streets of one region must
    // never display under another, even while loading.
    setStatus("loading");
    setStreets([]);
    setQuery(null);
    setWarnings([]);
    setError(null);
    setCheckedIds(new Set());
    setFocusedId(null);
    setSeeded(false);
    const deadline = createDeadlineSignal(STREETS_CLIENT_TIMEOUT_MS, controller.signal);
    try {
      const response = await fetchStreets(roi.polygon, deadline.signal);
      if (!guardRef.current.isCurrent(token) || (roiRef.current?.id ?? null) !== roiId) return;
      setStreets(response.streets);
      setQuery(response.query);
      setWarnings(response.warnings);
      setCheckedIds(new Set(response.streets.map((street) => street.id)));
      setStatus("loaded");
      setSeeded(false);
      setSnapshotId((value) => value + 1);
    } catch (fetchError) {
      if (!guardRef.current.isCurrent(token) || (roiRef.current?.id ?? null) !== roiId) return;
      if (controller.signal.aborted) return; // superseded/cleared: a newer state owns the UI
      if (deadline.signal.aborted) {
        setError({
          code: "STREETS_TIMEOUT",
          message: "Street retrieval timed out. Retry with the same region.",
          retryable: true,
        });
        setStatus("failed");
        return;
      }
      if (fetchError instanceof ApiError) {
        setError({ code: fetchError.code, message: fetchError.message, retryable: fetchError.retryable });
      } else {
        setError({
          code: "STREETS_FAILED",
          message: "Street retrieval failed unexpectedly.",
          retryable: true,
        });
      }
      setStatus("failed");
    } finally {
      deadline.release();
    }
  }, []);

  // Change detector (not a fetch effect): StrictMode's second pass sees the
  // same key and skips, so exactly one request runs per committed region.
  useEffect(() => {
    const roi = roiRef.current;
    const key = roi && roi.valid ? `roi-${roi.id}` : null;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    if (!roi || !roi.valid) {
      abortRef.current?.abort();
      abortRef.current = null;
      guardRef.current.invalidate();
      setStatus("idle");
      setStreets([]);
      setQuery(null);
      setWarnings([]);
      setError(null);
      setCheckedIds(new Set());
      setFocusedId(null);
      setSeeded(false);
      return;
    }
    void startFetch(roi);
  });

  // No unmount abort: StrictMode's simulated unmount would kill the
  // in-flight request while the change detector (same key) skips the
  // restart. Region replacement, clearing, and retry abort explicitly;
  // a late response after a true unmount is dropped by the guard checks.
  const retry = useCallback(() => {
    const roi = roiRef.current;
    if (!roi?.valid || statusRef.current === "loading") return;
    void startFetch(roi);
  }, [startFetch]);

  /**
   * Commit a demo seed built from sequence positions (explicit workaround
   * for Overpass outages). A later successful fetch replaces it with real
   * data; region replacement/clearing discards it.
   */
  const seedDemo = useCallback((seed: DemoSeed) => {
    setStreets([seed.street]);
    setQuery(seed.query);
    setWarnings(seed.warnings);
    setError(null);
    setCheckedIds(new Set([seed.street.id]));
    setFocusedId(null);
    setSeeded(true);
    setStatus("loaded");
    setSnapshotId((value) => value + 1);
  }, []);

  const setChecked = useCallback((id: string, checked: boolean) => {
    setCheckedIds((prev) => {
      if (prev.has(id) === checked) return prev;
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setSelectionVersion((value) => value + 1);
  }, []);

  const selectAll = useCallback(() => {
    setCheckedIds(new Set(streets.map((street) => street.id)));
    setSelectionVersion((value) => value + 1);
  }, [streets]);

  const deselectAll = useCallback(() => {
    setCheckedIds(new Set());
    setSelectionVersion((value) => value + 1);
  }, []);

  const toggleFocus = useCallback((id: string) => {
    // Focus highlights geometry only; participation is the checkbox alone.
    setFocusedId((prev) => (prev === id ? null : id));
  }, []);

  const checkedCount = streets.filter((street) => checkedIds.has(street.id)).length;

  return {
    status,
    streets,
    query,
    warnings,
    error,
    checkedIds,
    checkedCount,
    selectionVersion,
    focusedId,
    snapshotId,
    seeded,
    retry,
    seedDemo,
    setChecked,
    selectAll,
    deselectAll,
    toggleFocus,
    reset,
  };
}

export type Streets = ReturnType<typeof useStreets>;
