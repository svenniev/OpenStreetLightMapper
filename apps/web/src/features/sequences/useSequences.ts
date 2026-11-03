import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchSequenceDetail, type SequenceDetailResponse } from "../../lib/api";
import { createSearchGuard, isInRegion } from "../../lib/search";
import type {
  CommittedRoi,
  ImageResult,
  SearchError,
  ViewerActual,
} from "../../lib/searchTypes";
import {
  groupSeedRecords,
  pickRepresentative,
  type SequenceFilter,
  type SequenceGroup,
} from "./sequenceGroup";

export type SequenceScope = "inside" | "whole";
export type SequenceLoadState = "discovery" | "loading" | "loaded" | "partial" | "failed";

export interface SequenceLoadInfo {
  state: SequenceLoadState;
  /** Membership order when known (null until first detail response). */
  memberIds: string[] | null;
  membershipStatus: SequenceDetailResponse["membership"]["status"] | null;
  counts: SequenceDetailResponse["detail"] | null;
  warnings: string[];
  error: SearchError | null;
  retrievedAt: string | null;
}

export interface SequencePoints {
  inside: ImageResult[];
  outside: ImageResult[];
  unresolvedIds: string[];
}

/** Discovery + hydration state of one sequence for the preparation snapshot. */
export interface SequenceRef {
  sequenceId: string;
  loadState: SequenceLoadState;
  memberTotal: number | null;
  loadedCount: number | null;
  unresolvedCount: number;
}

export interface UseSequencesOptions {
  roi: CommittedRoi | null;
  /** Discovery seeds (grouping input). */
  seeds: ImageResult[];
  /** Full region pool (seeds + hydrated members). */
  pool: ImageResult[];
  mergeHydratedImages: (records: ImageResult[]) => number;
  requestViewerImage: (id: string) => void;
  viewerActual: ViewerActual;
}

const DISCOVERY_INFO: SequenceLoadInfo = {
  state: "discovery",
  memberIds: null,
  membershipStatus: null,
  counts: null,
  warnings: [],
  error: null,
  retrievedAt: null,
};

interface CachedDetail {
  memberIds: string[];
  membershipComplete: boolean;
  info: SequenceLoadInfo;
}

/**
 * Sequence browsing over discovery seeds: grouping, selection, on-demand
 * metadata hydration with a bounded session cache, display scopes, and the
 * "show this sequence" follow-up. One active selected-sequence load; RoI
 * replacement discards dependent state and aborts outstanding work.
 */
export function useSequences(options: UseSequencesOptions) {
  const [selectedSequenceId, setSelectedSequenceId] = useState<string | null>(null);
  const [selectedUngroupedId, setSelectedUngroupedId] = useState<string | null>(null);
  const [scope, setScope] = useState<SequenceScope>("inside");
  const [filter, setFilter] = useState<SequenceFilter>("all");
  const [imageListOpen, setImageListOpen] = useState(false);
  const [imagePage, setImagePage] = useState(1);
  const [loads, setLoads] = useState<Record<string, SequenceLoadInfo>>({});

  const guardRef = useRef(createSearchGuard());
  const inFlightRef = useRef(new Map<string, AbortController>());
  const cacheRef = useRef(new Map<string, CachedDetail>());

  const roiRef = useRef(options.roi);
  roiRef.current = options.roi;
  const poolRef = useRef(options.pool);
  poolRef.current = options.pool;
  const seedsRef = useRef(options.seeds);
  seedsRef.current = options.seeds;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const groups = useMemo(() => groupSeedRecords(options.seeds), [options.seeds]);
  const poolById = useMemo(() => {
    const map = new Map<string, ImageResult>();
    for (const image of options.pool) map.set(image.id, image);
    return map;
  }, [options.pool]);

  // RoI replacement/clear discards dependent lists and aborts outstanding work.
  const roiKey = options.roi?.id ?? null;
  useEffect(() => {
    for (const controller of inFlightRef.current.values()) controller.abort();
    inFlightRef.current.clear();
    cacheRef.current.clear();
    guardRef.current.invalidate();
    setSelectedSequenceId(null);
    setSelectedUngroupedId(null);
    setImageListOpen(false);
    setImagePage(1);
    setLoads({});
  }, [roiKey]);

  const loadDetail = useCallback(async (sequenceId: string, force = false): Promise<void> => {
    const roi = roiRef.current;
    if (!roi?.valid) return;
    // Request dedup: an in-flight load for this sequence already covers it.
    if (inFlightRef.current.has(sequenceId)) return;
    // Cache hit: complete membership with every member already pooled.
    const cached = cacheRef.current.get(sequenceId);
    if (!force && cached?.membershipComplete) {
      const poolIds = new Set(poolRef.current.map((image) => image.id));
      if (cached.memberIds.every((id) => poolIds.has(id))) {
        setLoads((prev) => ({ ...prev, [sequenceId]: { ...cached.info, state: "loaded" } }));
        return;
      }
    }

    const previous = cacheRef.current.get(sequenceId)?.info ?? DISCOVERY_INFO;
    const token = guardRef.current.next();
    const roiId = roi.id;
    const controller = new AbortController();
    inFlightRef.current.set(sequenceId, controller);
    setLoads((prev) => ({ ...prev, [sequenceId]: { ...previous, state: "loading", error: null } }));
    try {
      const knownIds = poolRef.current.map((image) => image.id).slice(0, 20_000);
      const response = await fetchSequenceDetail(sequenceId, roi.polygon, knownIds, controller.signal);
      if (!guardRef.current.isCurrent(token) || (roiRef.current?.id ?? null) !== roiId) return;
      optionsRef.current.mergeHydratedImages(response.images);
      const info: SequenceLoadInfo = {
        state: response.detail.status,
        memberIds: response.memberIds,
        membershipStatus: response.membership.status,
        counts: response.detail,
        warnings: response.warnings,
        error: null,
        retrievedAt: response.retrievedAt,
      };
      cacheRef.current.set(sequenceId, {
        memberIds: response.memberIds,
        membershipComplete: response.membership.status === "complete",
        info,
      });
      setLoads((prev) => ({ ...prev, [sequenceId]: info }));
    } catch (error) {
      if (!guardRef.current.isCurrent(token) || (roiRef.current?.id ?? null) !== roiId) return;
      if (controller.signal.aborted) {
        // Superseded/cancelled: restore the prior state, no error retained.
        setLoads((prev) => ({ ...prev, [sequenceId]: previous }));
        return;
      }
      const failure: SearchError =
        error instanceof ApiError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : { code: "SEQUENCE_FAILED", message: "Sequence detail failed unexpectedly.", retryable: true };
      setLoads((prev) => ({
        ...prev,
        [sequenceId]: { ...previous, state: "failed", error: failure },
      }));
    } finally {
      if (inFlightRef.current.get(sequenceId) === controller) {
        inFlightRef.current.delete(sequenceId);
      }
    }
  }, []);

  const abortOthers = useCallback((except: string | null) => {
    for (const [sequenceId, controller] of inFlightRef.current) {
      if (sequenceId !== except) controller.abort();
    }
  }, []);

  const selectSequence = useCallback(
    (sequenceId: string | null) => {
      setSelectedSequenceId(sequenceId);
      setSelectedUngroupedId(null);
      setImagePage(1);
      if (!sequenceId) return;
      abortOthers(sequenceId);
      // Load a representative in-RoI seed unless the viewer already shows
      // an image of this sequence.
      const opts = optionsRef.current;
      const actual = opts.viewerActual;
      const cached = cacheRef.current.get(sequenceId);
      const belongs =
        (actual.imageId !== null && cached?.memberIds.includes(actual.imageId)) ||
        (actual.sequenceId !== null && actual.sequenceId === sequenceId);
      if (!belongs) {
        const group = groupSeedRecords(seedsRef.current).sequences.find(
          (candidate) => candidate.sequenceId === sequenceId,
        );
        const representative = group ? pickRepresentative(group.seeds) : null;
        if (representative) opts.requestViewerImage(representative.id);
      }
      void loadDetail(sequenceId);
    },
    [abortOthers, loadDetail],
  );

  const selectUngrouped = useCallback(
    (imageId: string | null) => {
      setSelectedUngroupedId(imageId);
      setSelectedSequenceId(null);
      abortOthers(null);
      if (imageId && optionsRef.current.viewerActual.imageId !== imageId) {
        optionsRef.current.requestViewerImage(imageId);
      }
    },
    [abortOthers],
  );

  const retryDetail = useCallback(
    (sequenceId: string) => {
      void loadDetail(sequenceId, true);
    },
    [loadDetail],
  );

  const selectedGroup: SequenceGroup | null = useMemo(
    () => groups.sequences.find((group) => group.sequenceId === selectedSequenceId) ?? null,
    [groups, selectedSequenceId],
  );

  const selectedLoad: SequenceLoadInfo = selectedSequenceId
    ? (loads[selectedSequenceId] ?? DISCOVERY_INFO)
    : DISCOVERY_INFO;

  /** Ordered display members for the selection (membership order when known). */
  const selectedMembers: ImageResult[] = useMemo(() => {
    if (selectedUngroupedId) {
      const single = poolById.get(selectedUngroupedId);
      return single ? [single] : [];
    }
    if (!selectedSequenceId) return [];
    const memberIds = loads[selectedSequenceId]?.memberIds;
    if (memberIds) {
      const ordered: ImageResult[] = [];
      for (const id of memberIds) {
        const record = poolById.get(id);
        if (record) ordered.push(record);
      }
      return ordered;
    }
    return selectedGroup?.seeds ?? [];
  }, [loads, poolById, selectedGroup, selectedSequenceId, selectedUngroupedId]);

  const unresolvedIds: string[] = useMemo(() => {
    if (!selectedSequenceId) return [];
    const memberIds = loads[selectedSequenceId]?.memberIds;
    if (!memberIds) return [];
    return memberIds.filter((id) => !poolById.has(id));
  }, [loads, poolById, selectedSequenceId]);

  const scopedMembers: ImageResult[] = useMemo(
    () => (scope === "inside" ? selectedMembers.filter(isInRegion) : selectedMembers),
    [scope, selectedMembers],
  );

  const points: SequencePoints = useMemo(() => {
    const inside: ImageResult[] = [];
    const outside: ImageResult[] = [];
    for (const member of scope === "inside" ? scopedMembers : selectedMembers) {
      (isInRegion(member) ? inside : outside).push(member);
    }
    return {
      inside,
      outside: scope === "inside" ? [] : outside,
      unresolvedIds: scope === "inside" ? [] : unresolvedIds,
    };
  }, [scopedMembers, scope, selectedMembers, unresolvedIds]);

  const sequenceRefs: SequenceRef[] = useMemo(
    () =>
      groups.sequences.map((group) => {
        const load = loads[group.sequenceId];
        const memberIds = load?.memberIds ?? null;
        return {
          sequenceId: group.sequenceId,
          loadState: load?.state ?? "discovery",
          memberTotal: memberIds?.length ?? null,
          loadedCount: memberIds
            ? memberIds.filter((id) => poolById.has(id)).length
            : null,
          unresolvedCount: memberIds
            ? memberIds.filter((id) => !poolById.has(id)).length
            : 0,
        };
      }),
    [groups, loads, poolById],
  );

  const detailLoading = useMemo(
    () => Object.values(loads).some((load) => load.state === "loading"),
    [loads],
  );

  /** "Show this sequence" offer when the viewer left the working selection. */
  const foreignSequence: { sequenceId: string; discovered: boolean } | null = useMemo(() => {
    const actualSequence = options.viewerActual.sequenceId;
    if (!actualSequence || actualSequence === selectedSequenceId) return null;
    const discovered = groups.sequences.some((group) => group.sequenceId === actualSequence);
    return { sequenceId: actualSequence, discovered };
  }, [groups, options.viewerActual.sequenceId, selectedSequenceId]);

  return {
    groups,
    filter,
    setFilter,
    scope,
    setScope,
    selectedSequenceId,
    selectedUngroupedId,
    selectedGroup,
    selectedLoad,
    selectedMembers,
    scopedMembers,
    unresolvedIds,
    points,
    sequenceRefs,
    detailLoading,
    foreignSequence,
    imageListOpen,
    setImageListOpen,
    imagePage,
    setImagePage,
    selectSequence,
    selectUngrouped,
    retryDetail,
  };
}

export type Sequences = ReturnType<typeof useSequences>;
