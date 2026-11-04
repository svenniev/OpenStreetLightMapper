import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreetWorkItem } from "../../lib/api";
import { isInRegion } from "../../lib/search";
import type {
  CommittedRoi,
  ImageResult,
  SearchStatus,
} from "../../lib/searchTypes";
import type { SequenceRef } from "../sequences/useSequences";
import type { StreetWorkflowStatus } from "../streets/streetTypes";
import type { StreetsStatus } from "../streets/useStreets";
import {
  buildStreetPlanItem,
  computeInputFingerprint,
  deepFreeze,
  hashPoolIds,
  validateStreetForPlan,
} from "./preparationPlan";
import type { PreparationPlan, PreparationState } from "./preparationTypes";

/** Streets validated per cooperative batch; keeps Cancel responsive. */
export const PREPARATION_BATCH_SIZE = 200;

export interface UsePreparationOptions {
  roi: CommittedRoi | null;
  streetsStatus: StreetsStatus;
  streets: StreetWorkItem[];
  streetSnapshotId: number;
  streetWarnings: string[];
  streetRetrievedAt: string | null;
  streetSeeded: boolean;
  checkedIds: Set<string>;
  selectionVersion: number;
  discoveryStatus: SearchStatus;
  discoveryWarnings: string[];
  /** Region pool (may include outside-RoI context members; filtered here). */
  images: ImageResult[];
  imagerySnapshotId: number;
  sequenceRefs: SequenceRef[];
  detailLoading: boolean;
  drawingActive: boolean;
  /**
   * Restored preparation for a reopened workspace (remount per workspace).
   * The live fingerprint recomputes from restored inputs; a matching plan
   * stays prepared instead of flashing stale.
   */
  initial?: {
    runState: PreparationState;
    plan: PreparationPlan | null;
    failedStreetIds: string[];
    failureReasons: Record<string, string>;
  } | null;
}

export interface PreparationProgress {
  done: number;
  total: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Start Processing: real metadata/work-plan preparation over the current
 * inputs. Freezes an immutable snapshot, validates every checked street in
 * small cancellable batches, and references the shared in-RoI image pool by
 * ID. Tracks staleness against the live inputs; a prepared plan never
 * silently adopts retried provider data.
 */
export function usePreparation(options: UsePreparationOptions) {
  const initial = options.initial ?? null;
  const [runState, setRunState] = useState<PreparationState>(initial?.runState ?? "not_started");
  const [plan, setPlan] = useState<PreparationPlan | null>(initial?.plan ?? null);
  const [failedStreetIds, setFailedStreetIds] = useState<string[]>(initial?.failedStreetIds ?? []);
  const [failureReasons, setFailureReasons] = useState<Record<string, string>>(
    initial?.failureReasons ?? {},
  );
  const [progress, setProgress] = useState<PreparationProgress | null>(null);

  const runIdRef = useRef(0);
  const generationRef = useRef(0);
  const runStateRef = useRef(runState);
  runStateRef.current = runState;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const inRegionPool = useMemo(() => options.images.filter(isInRegion), [options.images]);

  const fingerprint = useMemo(
    () =>
      options.roi
        ? computeInputFingerprint({
            roiRevision: options.roi.id,
            streetSnapshotId: options.streetSnapshotId,
            checkedIds: [...options.checkedIds],
            imagerySnapshotId: options.imagerySnapshotId,
            poolHash: hashPoolIds(inRegionPool.map((image) => image.id)),
            discoveryWarnings: options.discoveryWarnings,
            streetWarnings: options.streetWarnings,
          })
        : null,
    [
      options.roi,
      options.streetSnapshotId,
      options.checkedIds,
      options.imagerySnapshotId,
      inRegionPool,
      options.discoveryWarnings,
      options.streetWarnings,
    ],
  );

  const checkedCount = useMemo(
    () => options.streets.filter((street) => options.checkedIds.has(street.id)).length,
    [options.streets, options.checkedIds],
  );

  const disabledReason = useMemo((): string | null => {
    if (runState === "preparing") return null; // Cancel replaces Start while running.
    const opts = options;
    if (!opts.roi?.valid) return "Commit a valid region first.";
    if (opts.streetsStatus === "loading") return "Street retrieval is still running.";
    if (opts.streetsStatus !== "loaded")
      return "Street retrieval for this region has not completed.";
    if (opts.streets.length === 0) return "No eligible streets were found in this region.";
    if (checkedCount === 0) return "Check at least one street.";
    if (opts.discoveryStatus === "loading") return "Mapillary discovery is still running.";
    if (opts.discoveryStatus === "idle" || opts.discoveryStatus === "cancelled")
      return "Run Mapillary discovery for this region first.";
    if (opts.discoveryStatus === "failed")
      return "Mapillary discovery failed — search again before preparing.";
    if (opts.detailLoading) return "A sequence detail request is still running.";
    if (opts.drawingActive) return "Finish or cancel drawing first.";
    return null;
  }, [options, checkedCount, runState]);

  const cancelRun = useCallback(() => {
    if (runStateRef.current !== "preparing") return;
    generationRef.current += 1;
    setProgress(null);
    setRunState("cancelled");
  }, []);

  const start = useCallback(() => {
    const opts = optionsRef.current;
    if (runStateRef.current === "preparing") return; // duplicate starts disabled
    if (!opts.roi?.valid) return;
    if (opts.streetsStatus !== "loaded" || opts.discoveryStatus === "loading") return;
    if (
      opts.discoveryStatus !== "results" &&
      opts.discoveryStatus !== "empty"
    )
      return;
    if (opts.detailLoading || opts.drawingActive) return;
    const checked = opts.streets.filter((street) => opts.checkedIds.has(street.id));
    if (checked.length === 0) return;

    // Freeze the immutable input snapshot synchronously: later provider
    // responses must not leak into this run.
    const runId = `prep-${opts.roi.id}-${opts.imagerySnapshotId}-${opts.streetSnapshotId}`;
    runIdRef.current += 1;
    const uniqueRunId = `${runId}-r${runIdRef.current}`;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const snapshot = {
      runId: uniqueRunId,
      roiRevision: opts.roi.id,
      inputFingerprint: computeInputFingerprint({
        roiRevision: opts.roi.id,
        streetSnapshotId: opts.streetSnapshotId,
        // Same source as the live fingerprint: unknown checked IDs keep the
        // selection comparable instead of flashing prepared-then-stale.
        checkedIds: [...opts.checkedIds],
        imagerySnapshotId: opts.imagerySnapshotId,
        poolHash: hashPoolIds(opts.images.filter(isInRegion).map((image) => image.id)),
        discoveryWarnings: opts.discoveryWarnings,
        streetWarnings: opts.streetWarnings,
      }),
      selectionVersion: opts.selectionVersion,
      startedAt: new Date().toISOString(),
      streets: checked,
      streetSnapshotId: opts.streetSnapshotId,
      streetRetrievedAt: opts.streetRetrievedAt,
      streetSeeded: opts.streetSeeded,
      imageIds: opts.images.filter(isInRegion).map((image) => image.id),
      sequenceRefs: opts.sequenceRefs.map((ref) => ({ ...ref })),
      warnings: [...opts.discoveryWarnings, ...opts.streetWarnings],
    };

    setFailedStreetIds([]);
    setFailureReasons({});
    setProgress({ done: 0, total: snapshot.streets.length });
    setRunState("preparing");

    void (async () => {
      const items = [];
      const failed: string[] = [];
      const reasons: Record<string, string> = {};
      for (let index = 0; index < snapshot.streets.length; index += 1) {
        const street = snapshot.streets[index];
        const problem = validateStreetForPlan(street);
        if (problem) {
          failed.push(street.id);
          reasons[street.id] = problem;
        } else {
          items.push(buildStreetPlanItem(street));
        }
        const done = index + 1;
        if (done % PREPARATION_BATCH_SIZE === 0 || done === snapshot.streets.length) {
          if (generationRef.current !== generation) return; // cancelled/superseded
          setProgress({ done, total: snapshot.streets.length });
          await yieldToEventLoop();
          if (generationRef.current !== generation) return;
        }
      }
      if (generationRef.current !== generation) return;
      if (failed.length > 0) {
        // Partial preparations are not usable results: no plan is kept.
        setFailedStreetIds(failed);
        setFailureReasons(reasons);
        setProgress(null);
        setRunState("failed");
        return;
      }
      const completed: PreparationPlan = deepFreeze({
        runId: snapshot.runId,
        roiRevision: snapshot.roiRevision,
        inputFingerprint: snapshot.inputFingerprint,
        selectionVersion: snapshot.selectionVersion,
        startedAt: snapshot.startedAt,
        endedAt: new Date().toISOString(),
        state: "prepared" as const,
        streetSource: {
          snapshotId: snapshot.streetSnapshotId,
          retrievedAt: snapshot.streetRetrievedAt,
          status: snapshot.streetSeeded ? "seeded-demo" : "loaded",
        },
        streetItems: items,
        imagePool: { imageIds: snapshot.imageIds, count: snapshot.imageIds.length },
        sequenceRefs: snapshot.sequenceRefs.map((ref) => ({
          sequenceId: ref.sequenceId,
          loadState: ref.loadState,
          memberTotal: ref.memberTotal,
          loadedCount: ref.loadedCount,
          unresolvedCount: ref.unresolvedCount,
        })),
        warnings: snapshot.warnings,
        inventoryStatus: "not_started" as const,
      });
      if (generationRef.current !== generation) return;
      // Latest plan wins; reload clears it (in-memory only).
      setPlan(completed);
      setProgress(null);
      setRunState("prepared");
    })();
  }, []);

  // One invalidation effect: region replacement/clear discards the run and
  // the plan (and adopts the new fingerprint baseline); other live-input
  // divergence marks a prepared plan stale, or cancels a run in flight so a
  // restart builds from the new inputs.
  const roiRevision = options.roi?.id ?? null;
  const roiRevisionRef = useRef(roiRevision);
  const fingerprintRef = useRef(fingerprint);
  useEffect(() => {
    if (roiRevisionRef.current !== roiRevision) {
      roiRevisionRef.current = roiRevision;
      fingerprintRef.current = fingerprint;
      generationRef.current += 1;
      setPlan(null);
      setFailedStreetIds([]);
      setFailureReasons({});
      setProgress(null);
      setRunState("not_started");
      return;
    }
    if (fingerprintRef.current === fingerprint) return;
    fingerprintRef.current = fingerprint;
    const current = runStateRef.current;
    if (current === "preparing") {
      generationRef.current += 1;
      setProgress(null);
      setRunState("cancelled");
    } else if (current === "prepared") {
      setRunState("stale");
    }
  }, [roiRevision, fingerprint]);

  const workflowStatuses = useMemo(() => {
    const map = new Map<string, StreetWorkflowStatus>();
    const preparedIds =
      runState === "prepared" && plan ? new Set(plan.streetItems.map((item) => item.streetId)) : null;
    const failedIds = runState === "failed" ? new Set(failedStreetIds) : null;
    for (const street of options.streets) {
      if (!options.checkedIds.has(street.id)) {
        map.set(street.id, "excluded");
      } else if (runState === "preparing") {
        map.set(street.id, "preparing");
      } else if (failedIds?.has(street.id)) {
        map.set(street.id, "preparation_failed");
      } else if (preparedIds?.has(street.id)) {
        map.set(street.id, "prepared");
      } else {
        map.set(street.id, "not_prepared");
      }
    }
    return map;
  }, [options.streets, options.checkedIds, runState, plan, failedStreetIds]);

  return {
    runState,
    plan,
    /** Live input fingerprint (drives inventory session staleness). */
    liveFingerprint: fingerprint,
    progress,
    failedStreetIds,
    failureReasons,
    checkedCount,
    disabledReason,
    canStart: disabledReason === null && runState !== "preparing",
    workflowStatuses,
    start,
    cancel: cancelRun,
  };
}

export type Preparation = ReturnType<typeof usePreparation>;
