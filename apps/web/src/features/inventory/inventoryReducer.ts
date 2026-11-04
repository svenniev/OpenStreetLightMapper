import { DEFAULT_CONCEPTS, MAX_VIEWS_PER_RUN } from "./inventoryTypes";
import type {
  AssetCategory,
  AssetPlacement,
  ConceptPrompt,
  DetectionItem,
  DetectionRun,
  InventoryAsset,
  InventoryMode,
  InventoryObservation,
  ObservationCategory,
  ObservationDecision,
  ObservationOrigin,
  SessionContext,
  SessionCounts,
  SessionPreviewResult,
  SourceImage,
  SourceView,
  SupportLink,
  WorkflowSession,
  WorkflowStep,
} from "./inventoryTypes";

/**
 * Session reducer: all detect/review/group/place mutations in one place.
 * Membership (observation → asset) derives from assets' observation ID lists,
 * the single source of truth; every operation validates category, ownership,
 * and IDs, and ignores invalid requests (the UI prevents them with reasons
 * via the same exported validators).
 *
 * Undo history, dirty/stale derivation, and finished-preview invalidation on
 * external edits live in the sessions coordinator; the reducer clears the
 * finished snapshot on every domain mutation except step navigation.
 */

export type InventoryAction =
  | { type: "SET_STEP"; step: WorkflowStep }
  | { type: "DETECT_START"; runId: number; total: number }
  | { type: "DETECT_PROGRESS"; runId: number; staged: number }
  | { type: "DETECT_APPLY"; observations: InventoryObservation[] }
  | { type: "DETECT_REPLACE"; observations: InventoryObservation[] }
  | { type: "DETECT_FAILED"; message: string }
  | { type: "DETECT_CANCELLED" }
  | { type: "OBS_DECIDE"; id: string; decision: ObservationDecision; note?: string }
  | { type: "OBS_EDIT"; id: string; category?: ObservationCategory; description?: string; note?: string }
  | { type: "OBS_ADD"; observation: InventoryObservation }
  | { type: "OBS_SET_RECT"; id: string; rect: InventoryObservation["imageRegion"] }
  | { type: "ASSET_CREATE"; observationIds: string[] }
  | { type: "ASSET_ADD_OBS"; assetId: string; observationIds: string[] }
  | { type: "ASSET_REMOVE_OBS"; assetId: string; observationId: string }
  | { type: "ASSET_SPLIT"; assetId: string; movingIds: string[] }
  | {
      type: "ASSET_MERGE";
      retainedId: string;
      removedId: string;
      position: AssetPlacement;
      support: SupportLink | null;
    }
  | { type: "ASSET_REMOVE"; assetId: string }
  | { type: "SUPPORT_ATTACH"; luminaireId: string; support: SupportLink }
  | { type: "SUPPORT_DETACH"; luminaireId: string }
  | { type: "PLACE"; assetId: string; placement: AssetPlacement }
  | { type: "ASSET_CONFIRM"; assetId: string }
  | { type: "SOURCES_CHOOSE"; images: SourceImage[]; views: SourceView[]; samplingNote: string | null }
  | { type: "VIEW_ADD_CROP"; view: SourceView }
  | { type: "VIEW_SET_REVIEWED"; viewId: string; fullyReviewed: boolean }
  | { type: "VIEW_SET_ARTIFACT"; viewId: string; artifactId: string }
  | { type: "CONCEPT_UPDATE"; id: string; patch: Partial<Pick<ConceptPrompt, "text" | "categoryIntent" | "enabled">> }
  | { type: "CONCEPT_ADD"; concept: ConceptPrompt }
  | { type: "CONCEPT_REMOVE"; id: string }
  | { type: "RUN_START"; run: DetectionRun }
  | {
      type: "RUN_ITEM";
      runId: string;
      itemId: string;
      patch: Partial<
        Pick<
          DetectionItem,
          | "status"
          | "objects"
          | "model"
          | "error"
          | "imported"
          | "startedAt"
          | "finishedAt"
          | "requestId"
          | "attempts"
          | "truncated"
          | "invalidDiscarded"
          | "artifactId"
          | "supersedes"
          | "resultSaved"
          | "registered"
        >
      >;
    }
  | { type: "RUN_FINISH"; runId: string; finishedAt: string; cancelled: boolean }
  | { type: "RUN_REOPEN"; runId: string }
  | { type: "RUN_ADD_ITEMS"; runId: string; items: DetectionItem[] }
  | { type: "INTERRUPT_ITEMS"; runId: string | null; finishedAt: string }
  | { type: "RESULT_SAVED"; resultId: string; sessionRevision: number; createdAt: string }
  | { type: "TEST_STAGE"; runId: string; itemId: string }
  | { type: "TEST_CLEAR" }
  | { type: "SAM_REPLACE"; observations: InventoryObservation[] }
  | { type: "FINISH"; result: SessionPreviewResult }
  | { type: "INVALIDATE" }
  | { type: "RESET_SESSION" };

export interface SessionInit {
  key: string;
  sessionId: string;
  mode: InventoryMode;
  streetId: string;
  streetDisplayName: string;
  context: SessionContext;
}

export function createSession(init: SessionInit): WorkflowSession {
  return {
    key: init.key,
    sessionId: init.sessionId,
    mode: init.mode,
    context: init.context,
    activeStep: "detect",
    detection: { status: "idle" },
    observations: {},
    assets: {},
    obsOrder: [],
    assetOrder: [],
    obsCounter: 0,
    assetCounter: 0,
    sources: {},
    views: {},
    viewOrder: [],
    manifest: null,
    concepts: DEFAULT_CONCEPTS.map((concept) => ({ ...concept })),
    conceptCounter: DEFAULT_CONCEPTS.length,
    runs: [],
    runCounter: 0,
    stagedTest: null,
    finishedPreview: null,
    savedResultRefs: [],
    draftAfterResult: false,
  };
}

/** Single source of truth for membership: which asset holds an observation. */
export function assetOf(
  observationId: string,
  assets: Record<string, InventoryAsset>,
): InventoryAsset | null {
  for (const asset of Object.values(assets)) {
    if (asset.observationIds.includes(observationId)) return asset;
  }
  return null;
}

export type ResolvedPosition =
  | { kind: "geographic"; lng: number; lat: number }
  | { kind: "diagram"; x: number; y: number }
  | { kind: "unknown" };

/** Resolve inherited luminaire display positions through the linked support. */
export function resolvePlacement(
  asset: InventoryAsset,
  assets: Record<string, InventoryAsset>,
): ResolvedPosition {
  const placement = asset.placement;
  if (placement.kind === "geographic" || placement.kind === "diagram") return placement;
  if (placement.kind === "inherited") {
    const support = asset.support;
    if (support?.kind === "pole") {
      const pole = assets[support.poleAssetId];
      if (pole && (pole.placement.kind === "geographic" || pole.placement.kind === "diagram")) {
        return pole.placement;
      }
    }
  }
  return { kind: "unknown" };
}

export function deriveCounts(session: WorkflowSession): SessionCounts {
  let pending = 0;
  let accepted = 0;
  let rejected = 0;
  let deferred = 0;
  for (const observation of Object.values(session.observations)) {
    if (observation.decision === "pending") pending += 1;
    else if (observation.decision === "accepted") accepted += 1;
    else if (observation.decision === "rejected") rejected += 1;
    else deferred += 1;
  }
  const assets = Object.values(session.assets);
  let placed = 0;
  let confirmed = 0;
  let unassignedAccepted = 0;
  for (const observation of Object.values(session.observations)) {
    if (observation.decision === "accepted" && !assetOf(observation.id, session.assets)) {
      unassignedAccepted += 1;
    }
  }
  for (const asset of assets) {
    if (asset.observationIds.length > 0 && resolvePlacement(asset, session.assets).kind !== "unknown") {
      placed += 1;
    }
    if (asset.confirmed) confirmed += 1;
  }
  return {
    pending,
    accepted,
    rejected,
    deferred,
    assets: assets.length,
    placed,
    unplaced: assets.length - placed,
    confirmed,
    unassignedAccepted,
    views: session.viewOrder.length,
  };
}

export type Validation = { ok: true } | { ok: false; reason: string };

export function validateAssetMembers(
  observationIds: string[],
  session: WorkflowSession,
): Validation {
  if (observationIds.length === 0) return { ok: false, reason: "Select at least one observation." };
  let category: AssetCategory | null = null;
  for (const id of observationIds) {
    const observation = session.observations[id];
    if (!observation) return { ok: false, reason: "Selected observation no longer exists." };
    if (observation.decision !== "accepted") {
      return { ok: false, reason: "Only accepted observations can enter an asset." };
    }
    if (observation.category !== "pole" && observation.category !== "luminaire") {
      return {
        ok: false,
        reason: "Uncertain observations need a Pole/support or Luminaire category first.",
      };
    }
    if (category && observation.category !== category) {
      return {
        ok: false,
        reason: "Pole and luminaire sightings are related objects, not duplicates — group them separately.",
      };
    }
    category = observation.category;
    if (assetOf(id, session.assets)) {
      return { ok: false, reason: "An observation can belong to only one asset." };
    }
  }
  return { ok: true };
}

export function validateMerge(
  retained: InventoryAsset | undefined,
  removed: InventoryAsset | undefined,
): Validation {
  if (!retained || !removed) return { ok: false, reason: "Select two existing assets." };
  if (retained.id === removed.id) return { ok: false, reason: "Select two different assets." };
  if (retained.category !== removed.category) {
    return {
      ok: false,
      reason: "Pole and luminaire assets are related objects, not duplicates — merge within one category.",
    };
  }
  return { ok: true };
}

export function validateSplit(asset: InventoryAsset | undefined, movingIds: string[]): Validation {
  if (!asset) return { ok: false, reason: "Select an existing asset." };
  if (movingIds.length === 0) return { ok: false, reason: "Select evidence to move." };
  if (movingIds.length >= asset.observationIds.length) {
    return { ok: false, reason: "A split must leave at least one observation behind." };
  }
  for (const id of movingIds) {
    if (!asset.observationIds.includes(id)) {
      return { ok: false, reason: "Split selection must come from this asset." };
    }
  }
  return { ok: true };
}

export interface MergePreview {
  retainedId: string;
  removedId: string;
  combinedCount: number;
  positionsDiffer: boolean;
  supportsDiffer: boolean;
}

export function mergePreview(a: InventoryAsset, b: InventoryAsset): MergePreview {
  const positionKey = (asset: InventoryAsset) => JSON.stringify(asset.placement);
  return {
    retainedId: a.id,
    removedId: b.id,
    combinedCount: a.observationIds.length + b.observationIds.length,
    positionsDiffer: positionKey(a) !== positionKey(b),
    supportsDiffer: JSON.stringify(a.support) !== JSON.stringify(b.support),
  };
}

export function confirmChecks(
  asset: InventoryAsset,
  session: WorkflowSession,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (asset.observationIds.length === 0) {
    reasons.push("Empty assets cannot confirm — repair or remove this asset.");
  }
  for (const id of asset.observationIds) {
    const observation = session.observations[id];
    if (!observation || observation.decision !== "accepted") {
      reasons.push("Every supporting observation must be accepted.");
      break;
    }
  }
  if (asset.category === "luminaire" && !asset.support) {
    reasons.push("Choose a pole link, wall-mounted, suspended, or support unknown.");
  }
  const positioned = resolvePlacement(asset, session.assets).kind !== "unknown";
  const explicitUnknown =
    asset.placement.kind === "unknown" && asset.placement.explicit === true;
  if (!positioned && !explicitUnknown) {
    reasons.push("Place the asset or explicitly choose Position unknown.");
  }
  return { ok: reasons.length === 0, reasons };
}

export interface FinishAssessment {
  ok: boolean;
  blockers: string[];
  needsEmptyConfirm: boolean;
  needsUnresolvedAck: boolean;
  needsIncompleteAck: boolean;
  unassigned: string[];
  deferredCount: number;
  unknownPositionCount: number;
  emptyAssetCount: number;
  includedCount: number;
  incompleteItemCount: number;
}

/** Batch items that never produced a usable result (failed, cancelled, or still open). */
export function incompleteRunItems(session: WorkflowSession): DetectionItem[] {
  const items: DetectionItem[] = [];
  for (const run of session.runs) {
    if (run.kind !== "batch") continue;
    for (const item of run.items) {
      if (item.status !== "succeeded" && item.status !== "empty") items.push(item);
    }
  }
  return items;
}

export function assessFinish(session: WorkflowSession): FinishAssessment {
  const blockers: string[] = [];
  const counts = deriveCounts(session);
  if (counts.pending > 0) {
    blockers.push(`${counts.pending} observation${counts.pending === 1 ? " is" : "s are"} still pending review.`);
  }
  const unassigned: string[] = [];
  for (const id of session.obsOrder) {
    const observation = session.observations[id];
    if (observation?.decision === "accepted" && !assetOf(id, session.assets)) {
      unassigned.push(id);
    }
  }
  if (unassigned.length > 0) {
    blockers.push(
      `${unassigned.length} accepted observation${unassigned.length === 1 ? " is" : "s are"} not assigned to an asset.`,
    );
  }
  let emptyAssetCount = 0;
  let includedCount = 0;
  const unconfirmed: string[] = [];
  for (const asset of Object.values(session.assets)) {
    if (asset.observationIds.length === 0) {
      emptyAssetCount += 1;
      continue;
    }
    includedCount += 1;
    const checks = confirmChecks(asset, session);
    if (!asset.confirmed || !checks.ok) unconfirmed.push(asset.id);
  }
  if (unconfirmed.length > 0) {
    blockers.push(`Unconfirmed assets: ${unconfirmed.join(", ")}.`);
  }
  if (
    session.mode === "demo" &&
    session.detection.status !== "finished" &&
    !Object.values(session.observations).some((o) => o.origin === "manual")
  ) {
    blockers.push("Run demo detection to a finished result before finishing.");
  }
  const unknownPositionCount = Object.values(session.assets).filter(
    (asset) =>
      asset.observationIds.length > 0 &&
      resolvePlacement(asset, session.assets).kind === "unknown",
  ).length;
  const incompleteItemCount = incompleteRunItems(session).length;
  return {
    ok: blockers.length === 0,
    blockers,
    needsEmptyConfirm: includedCount === 0,
    needsUnresolvedAck: counts.deferred > 0 || unknownPositionCount > 0,
    needsIncompleteAck: incompleteItemCount > 0,
    unassigned,
    deferredCount: counts.deferred,
    unknownPositionCount,
    emptyAssetCount,
    includedCount,
    incompleteItemCount,
  };
}

export function buildPreviewResult(session: WorkflowSession, finishedAt: string): SessionPreviewResult {
  const assets = session.assetOrder
    .map((id) => session.assets[id])
    .filter((asset) => asset && asset.observationIds.length > 0);
  const imageIds = new Set<string>();
  const origins = new Set<ObservationOrigin>();
  let poles = 0;
  let luminaires = 0;
  let placed = 0;
  let unplaced = 0;
  let model: string | null = null;
  const previewAssets = assets.map((asset) => {
    if (asset.category === "pole") poles += 1;
    else luminaires += 1;
    const resolved = resolvePlacement(asset, session.assets);
    if (resolved.kind === "unknown") unplaced += 1;
    else placed += 1;
    const images = new Set<string>();
    for (const obsId of asset.observationIds) {
      const observation = session.observations[obsId];
      if (!observation) continue;
      origins.add(observation.origin);
      if (observation.provenance && !model) model = observation.provenance.model;
      const imageId = observation.imageId;
      if (imageId) {
        images.add(imageId);
        imageIds.add(imageId);
      }
    }
    const position =
      resolved.kind === "geographic" || resolved.kind === "diagram"
        ? resolved
        : asset.placement.kind === "inherited" && asset.support?.kind === "pole"
          ? { kind: "inherited" as const, fromAssetId: asset.support.poleAssetId }
          : { kind: "unknown" as const };
    return {
      assetId: asset.id,
      category: asset.category,
      support: asset.support,
      position,
      positionMethod:
        resolved.kind !== "unknown"
          ? asset.placement.kind === "inherited"
            ? ("inherited" as const)
            : ("manual" as const)
          : ("unknown" as const),
      observationIds: [...asset.observationIds],
      imageIds: [...images],
      reviewState: "confirmed" as const,
      streetSource: asset.streetSource,
      note: asset.note,
    };
  });
  const deferred = Object.values(session.observations).filter((o) => o.decision === "deferred").length;
  const processing = summarizeProcessing(session);
  const limitations = [
    session.mode === "demo"
      ? "Demo schematic positions — not geographic measurements; no AI has run."
      : model
        ? `Assisted by ${model} text-prompt detection; every sighting was manually reviewed.`
        : "Manual preview — no model detections were used.",
    "Positions are manually placed approximations, or explicitly unknown.",
    "Heights, mounting details, power, spacing, and arrangement were not assessed.",
    "Unsaved preview — use Save reviewed result to keep it durably.",
  ];
  if (session.context.streetSource === "manual-work-area") {
    limitations.push("Street assignment unverified — a manual imagery work area, not an OpenStreetMap street.");
  }
  if (deferred > 0) limitations.push(`${deferred} deferred observation${deferred === 1 ? " remains" : "s remain"} unresolved.`);
  if (unplaced > 0) limitations.push(`${unplaced} asset${unplaced === 1 ? " has" : "s have"} no position.`);
  if (processing.failedViews > 0 || processing.unprocessedViews > 0 || processing.partialViews > 0) {
    limitations.push(
      `Incomplete image processing: ${processing.succeededViews} of ${processing.views} views fully produced results` +
        (processing.partialViews > 0 ? ` (${processing.partialViews} partial)` : "") +
        ".",
    );
  }
  if (processing.truncatedItems > 0) {
    limitations.push(
      `${processing.truncatedItems} detection${processing.truncatedItems === 1 ? " result was" : " results were"} truncated at the provider object cap; output is partial, not complete.`,
    );
  }
  if (processing.interruptedItems > 0) {
    limitations.push(
      `${processing.interruptedItems} detection${processing.interruptedItems === 1 ? " was" : "s were"} interrupted and never automatically retried.`,
    );
  }
  if (processing.invalidDiscarded > 0) {
    limitations.push(
      `${processing.invalidDiscarded} provider object${processing.invalidDiscarded === 1 ? " was" : "s were"} discarded as invalid during parsing.`,
    );
  }
  return {
    kind: "session-preview",
    mode: session.mode,
    sessionId: session.sessionId,
    streetId: session.context.streetId,
    streetDisplayName: session.context.streetDisplayName,
    streetSource: session.context.streetSource,
    origins: [...origins],
    model,
    processing,
    roiRevision: session.context.roiRevision,
    runId: session.context.runId,
    fingerprint: session.context.fingerprint,
    finishedAt,
    assets: previewAssets,
    counts: {
      poles,
      luminaires,
      placed,
      unplaced,
      deferred,
      observations: Object.keys(session.observations).length,
    },
    limitations,
    temporary: true,
  };
}

function unconfirm(asset: InventoryAsset): InventoryAsset {
  return asset.confirmed ? { ...asset, confirmed: false } : asset;
}

export type ViewConceptOutcome = "usable" | "failed" | "pending" | "missing";

export interface ViewConceptState {
  conceptId: string;
  conceptText: string;
  outcome: ViewConceptOutcome;
  item: DetectionItem | null;
}

/**
 * Latest batch outcome per enabled concept for one view. A view is complete
 * only when every enabled concept has a usable result; retries supersede
 * older attempts (runs are chronological), and prompt tests never count.
 */
export function viewConceptStates(session: WorkflowSession, viewId: string): ViewConceptState[] {
  const latest = new Map<string, DetectionItem>();
  for (const run of session.runs) {
    if (run.kind !== "batch") continue;
    for (const item of run.items) {
      if (item.viewId === viewId) latest.set(item.conceptId, item);
    }
  }
  return session.concepts
    .filter((concept) => concept.enabled)
    .map((concept) => {
      const item = latest.get(concept.id) ?? null;
      const outcome: ViewConceptOutcome = !item
        ? "missing"
        : item.status === "succeeded" || item.status === "empty"
          ? "usable"
          : item.status === "failed" || item.status === "cancelled" || item.status === "interrupted"
            ? "failed"
            : "pending";
      return { conceptId: concept.id, conceptText: concept.text, outcome, item };
    });
}

export type ViewCompletion = "succeeded" | "partial" | "failed" | "unprocessed";

export function assessViewCompletion(session: WorkflowSession, viewId: string): ViewCompletion {
  const states = viewConceptStates(session, viewId);
  if (states.length === 0) return "unprocessed";
  const usable = states.filter((state) => state.outcome === "usable").length;
  const failed = states.filter((state) => state.outcome === "failed").length;
  if (usable === states.length) return "succeeded";
  if (usable === 0 && failed === 0) return "unprocessed";
  if (usable === 0) return "failed";
  return "partial";
}

/** Per-view batch outcome summary for previews and results. */
export function summarizeProcessing(session: WorkflowSession): SessionPreviewResult["processing"] {
  const views = session.manifest?.viewIds ?? session.viewOrder;
  const concepts = new Set<string>();
  for (const run of session.runs) {
    if (run.kind !== "batch") continue;
    for (const item of run.items) concepts.add(item.conceptText);
  }
  // Latest item per (view, concept) across batch runs: retries supersede, so
  // warning counts never double-count an attempt chain.
  const latest = new Map<string, DetectionItem>();
  for (const run of session.runs) {
    if (run.kind !== "batch") continue;
    for (const item of run.items) latest.set(`${item.viewId} ${item.conceptId}`, item);
  }
  let truncatedItems = 0;
  let interruptedItems = 0;
  let invalidDiscarded = 0;
  for (const item of latest.values()) {
    if (item.truncated) truncatedItems += 1;
    if (item.status === "interrupted") interruptedItems += 1;
    invalidDiscarded += item.invalidDiscarded;
  }
  const manifestViews = views.filter((viewId) => session.views[viewId]);
  let succeededViews = 0;
  let partialViews = 0;
  let failedViews = 0;
  let unprocessedViews = 0;
  for (const viewId of manifestViews) {
    const completion = assessViewCompletion(session, viewId);
    if (completion === "succeeded") succeededViews += 1;
    else if (completion === "partial") partialViews += 1;
    else if (completion === "failed") failedViews += 1;
    else unprocessedViews += 1;
  }
  return {
    views: manifestViews.length,
    succeededViews,
    failedViews,
    unprocessedViews,
    partialViews,
    truncatedItems,
    interruptedItems,
    invalidDiscarded,
    concepts: [...concepts],
  };
}

function detachDependents(
  assets: Record<string, InventoryAsset>,
  removedPoleId: string,
): Record<string, InventoryAsset> {
  const next = { ...assets };
  for (const asset of Object.values(next)) {
    if (asset.support?.kind === "pole" && asset.support.poleAssetId === removedPoleId) {
      next[asset.id] = unconfirm({
        ...asset,
        support: null,
        placement:
          asset.placement.kind === "inherited"
            ? { kind: "unknown", explicit: false }
            : asset.placement,
      });
    }
  }
  return next;
}

function applyDomain(session: WorkflowSession, action: InventoryAction): WorkflowSession {
  switch (action.type) {
    case "SET_STEP":
      return session.activeStep === action.step ? session : { ...session, activeStep: action.step };

    case "DETECT_START":
      return { ...session, detection: { status: "running", runId: action.runId, total: action.total, staged: 0 } };

    case "DETECT_PROGRESS": {
      if (session.detection.status !== "running" || session.detection.runId !== action.runId) {
        return session;
      }
      return { ...session, detection: { ...session.detection, staged: action.staged } };
    }

    case "DETECT_APPLY": {
      if (Object.keys(session.observations).length > 0) return session; // reruns need explicit replace
      const observations: Record<string, InventoryObservation> = {};
      const obsOrder: string[] = [];
      for (const observation of action.observations) {
        observations[observation.id] = { ...observation };
        obsOrder.push(observation.id);
      }
      return {
        ...session,
        detection: {
          status: "finished",
          observationCount: action.observations.length,
          empty: action.observations.length === 0,
          at: new Date().toISOString(),
        },
        observations,
        obsOrder,
      };
    }

    case "DETECT_REPLACE": {
      const observations: Record<string, InventoryObservation> = {};
      const obsOrder: string[] = [];
      for (const [id, observation] of Object.entries(session.observations)) {
        if (observation.origin === "manual") {
          observations[id] = observation;
          obsOrder.push(id);
        }
      }
      for (const observation of action.observations) {
        observations[observation.id] = { ...observation };
        obsOrder.push(observation.id);
      }
      return {
        ...session,
        detection: {
          status: "finished",
          observationCount: action.observations.length,
          empty: action.observations.length === 0,
          at: new Date().toISOString(),
        },
        observations,
        obsOrder,
        assets: {},
        assetOrder: [],
      };
    }

    case "DETECT_FAILED":
      return { ...session, detection: { status: "failed", message: action.message } };

    case "DETECT_CANCELLED":
      return { ...session, detection: { status: "cancelled" } };

    case "OBS_DECIDE": {
      const observation = session.observations[action.id];
      if (!observation || observation.decision === action.decision) return session;
      const assets = { ...session.assets };
      const holder = assetOf(action.id, assets);
      if (holder && (action.decision === "rejected" || action.decision === "deferred")) {
        assets[holder.id] = unconfirm({
          ...holder,
          observationIds: holder.observationIds.filter((id) => id !== action.id),
        });
      } else if (holder) {
        // Any other review-state change on assigned evidence — including back
        // to pending or a re-accept — reopens confirmation without dropping
        // membership.
        assets[holder.id] = unconfirm(holder);
      }
      return {
        ...session,
        assets,
        observations: {
          ...session.observations,
          [action.id]: { ...observation, decision: action.decision, note: action.note ?? observation.note },
        },
      };
    }

    case "OBS_EDIT": {
      const observation = session.observations[action.id];
      if (!observation) return session;
      const holder = assetOf(action.id, session.assets);
      if (action.category && action.category !== observation.category && holder) {
        return session; // detach from the incompatible asset first
      }
      const assets = holder ? { ...session.assets, [holder.id]: unconfirm(holder) } : session.assets;
      const recategorized = action.category !== undefined && action.category !== observation.category;
      return {
        ...session,
        assets,
        observations: {
          ...session.observations,
          [action.id]: {
            ...observation,
            category: action.category ?? observation.category,
            description: action.description ?? observation.description,
            note: action.note ?? observation.note,
            // Recategorizing model output reads as SAM assisted; note and
            // description edits alone do not.
            origin:
              recategorized && observation.origin === "sam-text" ? "sam-assisted" : observation.origin,
          },
        },
      };
    }

    case "OBS_ADD": {
      const candidate = action.observation;
      if (session.observations[candidate.id]) return session;
      // Hard isolation: observations only enter sessions of their own mode,
      // and demo fixtures only enter demo sessions.
      if (candidate.mode !== session.mode) return session;
      if (candidate.origin === "demo" && session.mode !== "demo") return session;
      if (session.mode === "demo" && candidate.origin !== "demo" && candidate.origin !== "manual") {
        return session;
      }
      return {
        ...session,
        observations: { ...session.observations, [candidate.id]: { ...candidate } },
        obsOrder: [...session.obsOrder, candidate.id],
        obsCounter: session.obsCounter + 1,
      };
    }

    case "OBS_SET_RECT": {
      const observation = session.observations[action.id];
      if (!observation) return session;
      const holder = assetOf(action.id, session.assets);
      const assets = holder ? { ...session.assets, [holder.id]: unconfirm(holder) } : session.assets;
      const manualized =
        observation.origin === "sam-text" || observation.origin === "sam-assisted";
      return {
        ...session,
        assets,
        observations: {
          ...session.observations,
          [action.id]: {
            ...observation,
            imageRegion: action.rect ? { ...action.rect } : null,
            maskStale: observation.mask ? true : observation.maskStale,
            // A corrected rectangle reads as SAM assisted from here on.
            origin: observation.origin === "sam-text" ? "sam-assisted" : observation.origin,
            provenance:
              manualized && observation.provenance
                ? { ...observation.provenance, geometrySource: "manual-adjusted" as const }
                : observation.provenance,
          },
        },
      };
    }

    case "ASSET_CREATE": {
      if (validateAssetMembers(action.observationIds, session).ok === false) return session;
      const category = session.observations[action.observationIds[0]].category as AssetCategory;
      const id = `asset-${session.assetCounter + 1}`;
      const asset: InventoryAsset = {
        id,
        category,
        observationIds: [...action.observationIds],
        confirmed: false,
        support: null,
        placement: { kind: "unknown", explicit: false },
        mode: session.mode,
        streetSource: session.context.streetSource,
        note: "",
      };
      return {
        ...session,
        assets: { ...session.assets, [id]: asset },
        assetOrder: [...session.assetOrder, id],
        assetCounter: session.assetCounter + 1,
      };
    }

    case "ASSET_ADD_OBS": {
      const asset = session.assets[action.assetId];
      if (!asset) return session;
      if (validateAssetMembers(action.observationIds, session).ok === false) {
        return session;
      }
      const first = session.observations[action.observationIds[0]];
      if (first.category !== asset.category) return session;
      return {
        ...session,
        assets: {
          ...session.assets,
          [asset.id]: unconfirm({ ...asset, observationIds: [...asset.observationIds, ...action.observationIds] }),
        },
      };
    }

    case "ASSET_REMOVE_OBS": {
      const asset = session.assets[action.assetId];
      if (!asset || !asset.observationIds.includes(action.observationId)) return session;
      return {
        ...session,
        assets: {
          ...session.assets,
          [asset.id]: unconfirm({
            ...asset,
            observationIds: asset.observationIds.filter((id) => id !== action.observationId),
          }),
        },
      };
    }

    case "ASSET_SPLIT": {
      const asset = session.assets[action.assetId];
      if (!asset || validateSplit(asset, action.movingIds).ok === false) return session;
      const id = `asset-${session.assetCounter + 1}`;
      const created: InventoryAsset = {
        id,
        category: asset.category,
        observationIds: [...action.movingIds],
        confirmed: false,
        support: null,
        placement: { kind: "unknown", explicit: false },
        mode: session.mode,
        streetSource: session.context.streetSource,
        note: "",
      };
      return {
        ...session,
        assets: {
          ...session.assets,
          [asset.id]: unconfirm({
            ...asset,
            observationIds: asset.observationIds.filter((obsId) => !action.movingIds.includes(obsId)),
          }),
          [id]: created,
        },
        assetOrder: [...session.assetOrder, id],
        assetCounter: session.assetCounter + 1,
      };
    }

    case "ASSET_MERGE": {
      const retained = session.assets[action.retainedId];
      const removed = session.assets[action.removedId];
      if (!retained || !removed || validateMerge(retained, removed).ok === false) return session;
      const merged: InventoryAsset = {
        ...retained,
        observationIds: [...retained.observationIds, ...removed.observationIds],
        confirmed: false,
        support: action.support,
        placement: { ...action.position },
      };
      const assets = { ...session.assets, [merged.id]: merged };
      delete assets[removed.id];
      // Dependents linked to the removed pole follow the retained one.
      for (const asset of Object.values(assets)) {
        if (asset.support?.kind === "pole" && asset.support.poleAssetId === removed.id) {
          assets[asset.id] = unconfirm({
            ...asset,
            support: { kind: "pole", poleAssetId: retained.id },
          });
        }
      }
      return {
        ...session,
        assets,
        assetOrder: session.assetOrder.filter((id) => id !== removed.id),
      };
    }

    case "ASSET_REMOVE": {
      const asset = session.assets[action.assetId];
      if (!asset) return session;
      const assets = { ...session.assets };
      delete assets[action.assetId];
      return {
        ...session,
        assets: detachDependents(assets, action.assetId),
        assetOrder: session.assetOrder.filter((id) => id !== action.assetId),
      };
    }

    case "SUPPORT_ATTACH": {
      const asset = session.assets[action.luminaireId];
      if (!asset || asset.category !== "luminaire") return session;
      if (action.support.kind === "pole") {
        const pole = session.assets[action.support.poleAssetId];
        if (!pole || pole.category !== "pole" || pole.observationIds.length === 0) return session;
      }
      return {
        ...session,
        assets: { ...session.assets, [asset.id]: unconfirm({ ...asset, support: action.support }) },
      };
    }

    case "SUPPORT_DETACH": {
      const asset = session.assets[action.luminaireId];
      if (!asset || asset.category !== "luminaire" || !asset.support) return session;
      return {
        ...session,
        assets: {
          ...session.assets,
          [asset.id]: unconfirm({
            ...asset,
            support: null,
            placement:
              asset.placement.kind === "inherited"
                ? { kind: "unknown", explicit: false }
                : asset.placement,
          }),
        },
      };
    }

    case "PLACE": {
      const asset = session.assets[action.assetId];
      if (!asset || asset.observationIds.length === 0) return session;
      if (action.placement.kind === "inherited" && asset.category !== "luminaire") return session;
      if (action.placement.kind === "inherited" && asset.support?.kind !== "pole") return session;
      if (action.placement.kind === "geographic" && session.mode !== "manual") return session;
      if (action.placement.kind === "diagram" && session.mode !== "demo") return session;
      return {
        ...session,
        assets: { ...session.assets, [asset.id]: unconfirm({ ...asset, placement: { ...action.placement } }) },
      };
    }

    case "ASSET_CONFIRM": {
      const asset = session.assets[action.assetId];
      if (!asset || asset.confirmed) return session;
      if (!confirmChecks(asset, session).ok) return session;
      return {
        ...session,
        assets: { ...session.assets, [asset.id]: { ...asset, confirmed: true } },
      };
    }

    case "SOURCES_CHOOSE": {
      if (session.mode !== "manual") return session;
      // Frozen once work starts: re-choosing needs an explicit reset.
      if (session.runs.length > 0 || Object.keys(session.observations).length > 0) return session;
      if (action.views.length === 0 || action.views.length > MAX_VIEWS_PER_RUN) return session;
      const sources: Record<string, SourceImage> = {};
      for (const image of action.images) sources[image.imageId] = { ...image };
      const views: Record<string, SourceView> = {};
      const viewOrder: string[] = [];
      const imageIds: string[] = [];
      for (const view of action.views) {
        if (views[view.viewId] || !sources[view.imageId]) return session;
        views[view.viewId] = { ...view, crop: view.crop ? { ...view.crop } : null };
        viewOrder.push(view.viewId);
        if (!imageIds.includes(view.imageId)) imageIds.push(view.imageId);
      }
      return {
        ...session,
        sources,
        views,
        viewOrder,
        manifest: {
          imageIds,
          viewIds: [...viewOrder],
          chosenAt: new Date().toISOString(),
          acked: true,
          samplingNote: action.samplingNote,
        },
      };
    }

    case "VIEW_ADD_CROP": {
      if (session.mode !== "manual" || !session.manifest) return session;
      if (session.viewOrder.length >= MAX_VIEWS_PER_RUN) return session;
      const view = action.view;
      if (!view.crop || session.views[view.viewId] || !session.sources[view.imageId]) return session;
      return {
        ...session,
        views: { ...session.views, [view.viewId]: { ...view, crop: { ...view.crop } } },
        viewOrder: [...session.viewOrder, view.viewId],
        manifest: { ...session.manifest, viewIds: [...session.manifest.viewIds, view.viewId] },
      };
    }

    case "VIEW_SET_REVIEWED": {
      const view = session.views[action.viewId];
      if (!view || view.fullyReviewed === action.fullyReviewed) return session;
      return {
        ...session,
        views: { ...session.views, [action.viewId]: { ...view, fullyReviewed: action.fullyReviewed } },
      };
    }

    case "VIEW_SET_ARTIFACT": {
      const view = session.views[action.viewId];
      if (!view || view.artifactId === action.artifactId) return session;
      return {
        ...session,
        views: { ...session.views, [action.viewId]: { ...view, artifactId: action.artifactId } },
      };
    }

    case "CONCEPT_UPDATE": {
      const index = session.concepts.findIndex((concept) => concept.id === action.id);
      if (index < 0) return session;
      const text = action.patch.text !== undefined ? action.patch.text.trim() : null;
      if (text !== null && text.length === 0) return session;
      const concepts = session.concepts.map((concept, position) =>
        position === index
          ? {
              ...concept,
              text: text ?? concept.text,
              categoryIntent: action.patch.categoryIntent ?? concept.categoryIntent,
              enabled: action.patch.enabled ?? concept.enabled,
            }
          : concept,
      );
      return { ...session, concepts };
    }

    case "CONCEPT_ADD": {
      if (session.concepts.some((concept) => concept.id === action.concept.id)) return session;
      if (action.concept.text.trim().length === 0) return session;
      return {
        ...session,
        concepts: [...session.concepts, { ...action.concept, text: action.concept.text.trim() }],
        conceptCounter: session.conceptCounter + 1,
      };
    }

    case "CONCEPT_REMOVE": {
      if (!session.concepts.some((concept) => concept.id === action.id)) return session;
      return { ...session, concepts: session.concepts.filter((concept) => concept.id !== action.id) };
    }

    case "RUN_START": {
      if (session.mode !== "manual") return session;
      if (session.runs.some((run) => run.runId === action.run.runId)) return session;
      // Durable history is never sliced: the UI renders a bounded page and
      // offers "show more", while every run persists with its outcomes.
      const runs = [...session.runs, action.run];
      return { ...session, runs, runCounter: session.runCounter + 1 };
    }

    case "RUN_ITEM": {
      const index = session.runs.findIndex((run) => run.runId === action.runId);
      if (index < 0) return session;
      const run = session.runs[index];
      const itemIndex = run.items.findIndex((item) => item.itemId === action.itemId);
      if (itemIndex < 0) return session;
      const items = run.items.map((item, position) =>
        position === itemIndex ? { ...item, ...action.patch } : item,
      );
      const runs = session.runs.map((entry, position) =>
        position === index ? { ...entry, items } : entry,
      );
      return { ...session, runs };
    }

    case "RUN_FINISH": {
      const index = session.runs.findIndex((run) => run.runId === action.runId);
      if (index < 0) return session;
      const runs = session.runs.map((run, position) =>
        position === index
          ? { ...run, finishedAt: action.finishedAt, cancelled: action.cancelled }
          : run,
      );
      return { ...session, runs };
    }

    case "RUN_REOPEN": {
      const index = session.runs.findIndex((run) => run.runId === action.runId);
      if (index < 0) return session;
      const runs = session.runs.map((run, position) =>
        position === index ? { ...run, finishedAt: null, cancelled: false } : run,
      );
      return { ...session, runs };
    }

    case "RUN_ADD_ITEMS": {
      if (session.mode !== "manual") return session;
      const index = session.runs.findIndex((run) => run.runId === action.runId);
      if (index < 0 || action.items.length === 0) return session;
      const run = session.runs[index];
      const known = new Set(run.items.map((item) => item.itemId));
      for (const item of action.items) {
        if (known.has(item.itemId) || item.status !== "queued") return session;
        known.add(item.itemId);
      }
      const runs = session.runs.map((entry, position) =>
        position === index ? { ...entry, items: [...entry.items, ...action.items] } : entry,
      );
      return { ...session, runs };
    }

    case "INTERRUPT_ITEMS": {
      let changed = false;
      const runs = session.runs.map((run) => {
        if (action.runId !== null && run.runId !== action.runId) return run;
        let runChanged = false;
        const items = run.items.map((item) => {
          if (item.status !== "queued" && item.status !== "preparing" && item.status !== "detecting") {
            return item;
          }
          runChanged = true;
          return {
            ...item,
            status: "interrupted" as const,
            error: "Interrupted by restart or navigation — not automatically retried.",
            finishedAt: action.finishedAt,
          };
        });
        if (!runChanged) return run;
        changed = true;
        const finished = items.every(
          (item) =>
            item.status !== "queued" && item.status !== "preparing" && item.status !== "detecting",
        );
        return { ...run, items, finishedAt: finished ? action.finishedAt : run.finishedAt };
      });
      return changed ? { ...session, runs } : session;
    }

    case "RESULT_SAVED": {
      if (session.savedResultRefs.some((ref) => ref.resultId === action.resultId)) return session;
      return {
        ...session,
        savedResultRefs: [
          ...session.savedResultRefs,
          {
            resultId: action.resultId,
            sessionRevision: action.sessionRevision,
            createdAt: action.createdAt,
          },
        ],
        draftAfterResult: false,
      };
    }

    case "TEST_STAGE": {
      const run = session.runs.find((entry) => entry.runId === action.runId);
      if (!run || run.kind !== "test") return session;
      if (!run.items.some((item) => item.itemId === action.itemId)) return session;
      return { ...session, stagedTest: { runId: action.runId, itemId: action.itemId } };
    }

    case "TEST_CLEAR":
      return session.stagedTest ? { ...session, stagedTest: null } : session;

    case "SAM_REPLACE": {
      if (session.mode !== "manual") return session;
      const observations: Record<string, InventoryObservation> = {};
      const obsOrder: string[] = [];
      for (const [id, observation] of Object.entries(session.observations)) {
        // Manual and assisted work survives; raw text-prompt output is replaced.
        if (observation.origin !== "sam-text") {
          observations[id] = observation;
          obsOrder.push(id);
        }
      }
      const dropped = new Set(
        Object.keys(session.observations).filter((id) => !observations[id]),
      );
      const assets: Record<string, InventoryAsset> = {};
      const assetOrder: string[] = [];
      for (const id of session.assetOrder) {
        const asset = session.assets[id];
        if (!asset) continue;
        const remaining = asset.observationIds.filter((obsId) => !dropped.has(obsId));
        if (remaining.length === 0) continue; // emptied assets are removed
        assets[id] = unconfirm({ ...asset, observationIds: remaining });
        assetOrder.push(id);
      }
      for (const observation of action.observations) {
        observations[observation.id] = { ...observation };
        obsOrder.push(observation.id);
      }
      return { ...session, observations, obsOrder, assets, assetOrder, stagedTest: null };
    }

    case "FINISH":
      return { ...session, finishedPreview: action.result };

    case "INVALIDATE":
      return session.finishedPreview ? { ...session, finishedPreview: null } : session;

    case "RESET_SESSION":
      return createSession({
        key: session.key,
        sessionId: session.sessionId,
        mode: session.mode,
        streetId: session.context.streetId,
        streetDisplayName: session.context.streetDisplayName,
        context: session.context,
      });

    default:
      return session;
  }
}

/**
 * Domain edits that reopen a draft after a reviewed result was saved. Review
 * decisions, annotations, grouping, support, placement, and confirmation all
 * move the session ahead of its last saved version.
 */
const DRAFT_ACTIONS: ReadonlySet<InventoryAction["type"]> = new Set([
  "OBS_DECIDE",
  "OBS_EDIT",
  "OBS_ADD",
  "OBS_SET_RECT",
  "ASSET_CREATE",
  "ASSET_ADD_OBS",
  "ASSET_REMOVE_OBS",
  "ASSET_SPLIT",
  "ASSET_MERGE",
  "ASSET_REMOVE",
  "SUPPORT_ATTACH",
  "SUPPORT_DETACH",
  "PLACE",
  "ASSET_CONFIRM",
]);

/**
 * Every domain mutation except step navigation invalidates a finished
 * snapshot: later edits reopen review until the user finishes again. Edits
 * after a saved reviewed result additionally open a draft; the prior result
 * stays available as a historical version.
 */
export function inventoryReducer(session: WorkflowSession, action: InventoryAction): WorkflowSession {
  const next = applyDomain(session, action);
  if (next === session) return session;
  if (action.type === "SET_STEP" || action.type === "FINISH") return next;
  let out = next.finishedPreview ? { ...next, finishedPreview: null } : next;
  if (
    DRAFT_ACTIONS.has(action.type) &&
    out.savedResultRefs.length > 0 &&
    !out.draftAfterResult
  ) {
    out = { ...out, draftAfterResult: true };
  }
  return out;
}
