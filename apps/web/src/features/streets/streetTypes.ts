/**
 * Street workflow vocabulary shared by the street list, preparation, and the
 * future inventory results. Statuses describe actual state only: nothing here
 * may imply analysis that has not run.
 */
export type StreetWorkflowStatus =
  | "excluded"
  | "not_prepared"
  | "preparing"
  | "prepared"
  | "preparation_failed";

export const WORKFLOW_STATUS_LABELS: Record<StreetWorkflowStatus, string> = {
  excluded: "Excluded",
  not_prepared: "Not prepared",
  preparing: "Preparing…",
  prepared: "Prepared",
  preparation_failed: "Preparation failed",
};
