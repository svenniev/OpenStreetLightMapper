/**
 * Preparation vocabulary: the immutable work-plan snapshot built by Start
 * Processing, and the state machine around it. A plan references shared
 * region data by ID; it never duplicates image records per street and never
 * implies analysis (segmentation, detection) that has not run.
 */

export type PreparationState =
  | "not_started"
  | "preparing"
  | "prepared"
  | "failed"
  | "cancelled"
  | "stale";

/** The only inventory state this milestone can produce. */
export type InventoryStatus = "not_started";

export interface StreetPlanItem {
  streetId: string;
  displayName: string;
  wayIds: number[];
  lengthM: number;
  /** Image-to-street association needs a later specification. */
  imageAssociation: "pending";
}

export interface SequencePlanRef {
  sequenceId: string;
  loadState: string;
  memberTotal: number | null;
  loadedCount: number | null;
  unresolvedCount: number;
}

export interface PreparationPlan {
  runId: string;
  roiRevision: number;
  /** Fingerprint of the exact inputs this plan was built from. */
  inputFingerprint: string;
  selectionVersion: number;
  startedAt: string;
  endedAt: string;
  state: "prepared";
  streetSource: {
    snapshotId: number;
    retrievedAt: string | null;
    status: string;
  };
  streetItems: StreetPlanItem[];
  /** Shared region-imagery pool: in-RoI records only, referenced by ID. */
  imagePool: {
    imageIds: string[];
    count: number;
  };
  sequenceRefs: SequencePlanRef[];
  warnings: string[];
  inventoryStatus: InventoryStatus;
}

export const PREPARATION_STATE_LABELS: Record<PreparationState, string> = {
  not_started: "Not started",
  preparing: "Preparing…",
  prepared: "Prepared",
  failed: "Preparation failed",
  cancelled: "Preparation cancelled",
  stale: "Stale — prepare again",
};
