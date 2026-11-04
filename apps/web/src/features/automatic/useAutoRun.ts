import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  getAutoJob,
  getAutoResult,
  isActiveAutoJobStatus,
  launchAutoJob,
  listAutoCandidates,
  listAutoJobs,
  listAutoObservations,
  prepareAutoRun,
  resumeAutoJob,
  retryAutoItem,
  stopAutoJob,
  type AutoCandidateSummary,
  type AutoJobDetail,
  type AutoJobSummary,
  type AutoObservationSummary,
  type AutoPrepareResponse,
  type AutoResultSummary,
} from "../../lib/autoApi";
import { DEFAULT_CONCEPTS } from "../inventory/inventoryTypes";

export type AutoConceptsChoice = "poles-and-fixtures" | "poles-only";

/** Poll cadence while a job is active; tab-close safe (server owns the work). */
export const AUTO_POLL_INTERVAL_MS = 3000;

export interface UseAutoRunOptions {
  workspaceId: string | null;
  backendConnected: boolean;
  /** Local bump counters: any input change invalidates the displayed plan. */
  imageryRevision: number;
  streetRevision: number;
  sequenceIds: string[];
  pinnedSnapshotIds: () => Promise<
    { imagerySnapshotId: string; streetSnapshotId: string | null } | { error: string }
  >;
}

function autoConcepts(choice: AutoConceptsChoice): { conceptId: string; text: string; category: "pole" | "luminaire" }[] {
  const pole = DEFAULT_CONCEPTS.find((concept) => concept.categoryIntent === "pole");
  const fixture = DEFAULT_CONCEPTS.find((concept) => concept.categoryIntent === "luminaire");
  const concepts: { conceptId: string; text: string; category: "pole" | "luminaire" }[] = [];
  if (pole) concepts.push({ conceptId: "auto-pole", text: pole.text, category: "pole" });
  if (choice === "poles-and-fixtures" && fixture) {
    concepts.push({ conceptId: "auto-luminaire", text: fixture.text, category: "luminaire" });
  }
  return concepts;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : "The request failed unexpectedly.";
}

/**
 * Automatic-run client state: plan preparation (no SAM calls), idempotent
 * launch, polling progress, stop/resume/retry, and saved-result reads. All
 * durable state lives server-side; reopening restores from the job list.
 */
export function useAutoRun(options: UseAutoRunOptions) {
  const [mode, setMode] = useState<"detect" | "locate">("locate");
  const [conceptsChoice, setConceptsChoice] = useState<AutoConceptsChoice>("poles-and-fixtures");
  /** Minimum spacing between planned images in metres (0 disables thinning). */
  const [minSpacingM, setMinSpacingM] = useState(10);
  const [prepare, setPrepare] = useState<AutoPrepareResponse | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AutoJobSummary[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutoJobDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AutoCandidateSummary[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoResultSummary | null>(null);
  const [observations, setObservations] = useState<AutoObservationSummary[] | null>(null);
  const idempotencyRef = useRef<string | null>(null);

  const workspaceId = options.workspaceId;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // A new selection/plan invalidates the displayed prepare: the launch button
  // must always authorize the exact plan shown.
  const selectionKey = useMemo(
    () =>
      JSON.stringify({
        mode,
        conceptsChoice,
        minSpacingM,
        imagery: options.imageryRevision,
        streets: options.streetRevision,
        sequences: [...options.sequenceIds].sort(),
      }),
    [mode, conceptsChoice, minSpacingM, options.imageryRevision, options.streetRevision, options.sequenceIds],
  );
  const lastSelectionKeyRef = useRef(selectionKey);
  useEffect(() => {
    if (selectionKey === lastSelectionKeyRef.current) return;
    lastSelectionKeyRef.current = selectionKey;
    setPrepare(null);
    setPrepareError(null);
    idempotencyRef.current = null;
  }, [selectionKey]);

  const refreshJobs = useCallback(async () => {
    const current = optionsRef.current;
    if (!current.workspaceId || !current.backendConnected) return;
    try {
      const listed = await listAutoJobs(current.workspaceId);
      setJobs(listed);
      setJobsError(null);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setJobsError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    setJobs([]);
    setJobsError(null);
    setSelectedJobId(null);
    setDetail(null);
    setCandidates(null);
    setResult(null);
    setObservations(null);
    void refreshJobs();
  }, [workspaceId, options.backendConnected, refreshJobs]);

  const refreshDetail = useCallback(
    async (jobId: string) => {
      const current = optionsRef.current;
      if (!current.workspaceId) return;
      try {
        const fetched = await getAutoJob(current.workspaceId, jobId);
        setDetail(fetched);
        setDetailError(null);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setDetailError(errorMessage(error));
      }
    },
    [],
  );

  const refreshOutputs = useCallback(async (jobId: string) => {
    const current = optionsRef.current;
    if (!current.workspaceId) return;
    try {
      const [fetchedCandidates, fetchedResult, fetchedObservations] = await Promise.all([
        listAutoCandidates(current.workspaceId, jobId),
        getAutoResult(current.workspaceId, jobId).catch((error: unknown) => {
          // No published result yet (job still running): not an error.
          if (error instanceof ApiError && error.code === "AUTO_RESULT_NOT_FOUND") return null;
          throw error;
        }),
        listAutoObservations(current.workspaceId, jobId, { limit: 500 }).catch(() => []),
      ]);
      setCandidates(fetchedCandidates);
      setResult(fetchedResult);
      setObservations(fetchedObservations);
      setCandidatesError(null);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setCandidatesError(errorMessage(error));
    }
  }, []);

  const selectJob = useCallback(
    (jobId: string | null) => {
      setSelectedJobId(jobId);
      setDetail(null);
      setDetailError(null);
      setCandidates(null);
      setCandidatesError(null);
      setResult(null);
      setObservations(null);
      if (jobId) {
        void refreshDetail(jobId);
        void refreshOutputs(jobId);
      }
    },
    [refreshDetail, refreshOutputs],
  );

  // Poll the selected job while the worker may still advance it. Closing the
  // tab only stops this polling; the server job continues.
  const detailStatus = detail?.job.status ?? null;
  const detailJobId = detail?.job.jobId ?? null;
  useEffect(() => {
    if (!selectedJobId || !detailStatus || !isActiveAutoJobStatus(detailStatus)) return;
    const timer = setInterval(() => {
      void refreshDetail(selectedJobId);
      void refreshJobs();
    }, AUTO_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [selectedJobId, detailStatus, refreshDetail, refreshJobs]);

  // First terminal read of a polled job also fetches its outputs once.
  const outputsFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detailJobId || !detailStatus || isActiveAutoJobStatus(detailStatus)) return;
    if (outputsFetchedRef.current === detailJobId) return;
    outputsFetchedRef.current = detailJobId;
    void refreshOutputs(detailJobId);
    void refreshJobs();
  }, [detailJobId, detailStatus, refreshOutputs, refreshJobs]);

  const runPrepare = useCallback(async () => {
    const current = optionsRef.current;
    if (!current.workspaceId || !current.backendConnected) return;
    if (current.sequenceIds.length === 0) {
      setPrepareError("Check at least one sequence for the automatic run.");
      return;
    }
    setPreparing(true);
    setPrepareError(null);
    try {
      const pinned = await current.pinnedSnapshotIds();
      if ("error" in pinned) {
        setPrepareError(pinned.error);
        return;
      }
      const response = await prepareAutoRun(current.workspaceId, {
        mode,
        snapshotId: pinned.imagerySnapshotId,
        streetSnapshotId: pinned.streetSnapshotId,
        sequenceIds: current.sequenceIds,
        concepts: autoConcepts(conceptsChoice),
        minSpacingM,
      });
      setPrepare(response);
      idempotencyRef.current = null;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setPrepareError(errorMessage(error));
    } finally {
      setPreparing(false);
    }
  }, [conceptsChoice, minSpacingM, mode]);

  const runLaunch = useCallback(async () => {
    const current = optionsRef.current;
    if (!current.workspaceId || !prepare || acting) return;
    if (!idempotencyRef.current) {
      idempotencyRef.current = `auto_${crypto.randomUUID().replace(/-/g, "")}`;
    }
    setActing(true);
    setActionError(null);
    try {
      const launched = await launchAutoJob(current.workspaceId, {
        prepareSnapshotId: prepare.prepareSnapshotId,
        idempotencyKey: idempotencyRef.current,
      });
      await refreshJobs();
      selectJob(launched.jobId);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      // A failed launch keeps its key: retrying the same plan reuses it, so a
      // timeout followed by a retry cannot launch the plan twice.
      setActionError(errorMessage(error));
    } finally {
      setActing(false);
    }
  }, [acting, prepare, refreshJobs, selectJob]);

  const runStop = useCallback(async () => {
    const current = optionsRef.current;
    if (!current.workspaceId || !selectedJobId || acting) return;
    setActing(true);
    setActionError(null);
    try {
      await stopAutoJob(current.workspaceId, selectedJobId);
      await refreshDetail(selectedJobId);
      await refreshJobs();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setActionError(errorMessage(error));
    } finally {
      setActing(false);
    }
  }, [acting, refreshDetail, refreshJobs, selectedJobId]);

  const runResume = useCallback(async () => {
    const current = optionsRef.current;
    if (!current.workspaceId || !selectedJobId || acting) return;
    setActing(true);
    setActionError(null);
    try {
      await resumeAutoJob(current.workspaceId, selectedJobId);
      outputsFetchedRef.current = null;
      await refreshDetail(selectedJobId);
      await refreshJobs();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setActionError(errorMessage(error));
    } finally {
      setActing(false);
    }
  }, [acting, refreshDetail, refreshJobs, selectedJobId]);

  const runRetryItem = useCallback(
    async (itemId: string) => {
      const current = optionsRef.current;
      if (!current.workspaceId || !selectedJobId || acting) return;
      setActing(true);
      setActionError(null);
      try {
        await retryAutoItem(current.workspaceId, selectedJobId, itemId);
        await refreshDetail(selectedJobId);
        await refreshJobs();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setActionError(errorMessage(error));
      } finally {
        setActing(false);
      }
    },
    [acting, refreshDetail, refreshJobs, selectedJobId],
  );

  return {
    mode,
    setMode,
    conceptsChoice,
    setConceptsChoice,
    minSpacingM,
    setMinSpacingM,
    prepare,
    preparing,
    prepareError,
    runPrepare,
    runLaunch,
    jobs,
    jobsError,
    refreshJobs,
    selectedJobId,
    selectJob,
    detail,
    detailError,
    acting,
    actionError,
    runStop,
    runResume,
    runRetryItem,
    candidates,
    candidatesError,
    result,
    observations,
    refreshOutputs,
  };
}

export type AutoRun = ReturnType<typeof useAutoRun>;
