import { useState } from "react";
import { formatRetrievedAt, warningMessage } from "../../lib/search";
import type { Preparation } from "./usePreparation";
import { PREPARATION_STATE_LABELS } from "./preparationTypes";

export interface PreparationPanelProps {
  preparation: Preparation;
  streetTotal: number;
}

function PreparationDetails({ preparation }: { preparation: Preparation }) {
  const plan = preparation.plan;
  if (!plan) return null;
  return (
    <dl className="preparation-details">
      <div className="config-row">
        <dt>Run</dt>
        <dd>{plan.runId}</dd>
      </div>
      <div className="config-row">
        <dt>Region revision</dt>
        <dd>{plan.roiRevision}</dd>
      </div>
      <div className="config-row">
        <dt>Input fingerprint</dt>
        <dd>{plan.inputFingerprint}</dd>
      </div>
      <div className="config-row">
        <dt>Prepared</dt>
        <dd>
          {formatRetrievedAt(plan.startedAt)} – {formatRetrievedAt(plan.endedAt)}
        </dd>
      </div>
      <div className="config-row">
        <dt>Streets</dt>
        <dd>
          {plan.streetItems.length} work item{plan.streetItems.length === 1 ? "" : "s"} (street
          snapshot {plan.streetSource.snapshotId}
          {plan.streetSource.status === "seeded-demo" ? ", seeded demo — not OSM data" : ""}
          {plan.streetSource.retrievedAt
            ? `, retrieved ${formatRetrievedAt(plan.streetSource.retrievedAt)}`
            : ""}
          )
        </dd>
      </div>
      <div className="config-row">
        <dt>Imagery pool</dt>
        <dd>
          {plan.imagePool.count} in-region image{plan.imagePool.count === 1 ? "" : "s"} referenced
          by ID; image-to-street association pending
        </dd>
      </div>
      <div className="config-row">
        <dt>Sequences</dt>
        <dd>
          {plan.sequenceRefs.length === 0
            ? "none discovered"
            : plan.sequenceRefs
                .map(
                  (ref) =>
                    `${ref.sequenceId} (${ref.loadState}` +
                    (ref.memberTotal === null
                      ? ""
                      : `, ${ref.loadedCount}/${ref.memberTotal} loaded`) +
                    (ref.unresolvedCount > 0 ? `, ${ref.unresolvedCount} unresolved` : "") +
                    ")",
                )
                .join("; ")}
        </dd>
      </div>
      <div className="config-row">
        <dt>Inventory</dt>
        <dd>not started — preparation is not mapping</dd>
      </div>
    </dl>
  );
}

export function PreparationPanel(props: PreparationPanelProps) {
  const { preparation, streetTotal } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { runState, plan, progress } = preparation;

  return (
    <div className="preparation-panel">
      <p className="search-status" role="status">
        {preparation.checkedCount} of {streetTotal} street{streetTotal === 1 ? "" : "s"} included
      </p>

      {runState === "preparing" && (
        <div className="search-controls">
          <p className="search-status" role="status" aria-live="polite">
            Preparing…
            {progress ? ` ${progress.done} of ${progress.total} streets validated.` : ""}
          </p>
          <button type="button" className="toolbar-button" onClick={preparation.cancel}>
            Cancel preparation
          </button>
        </div>
      )}

      {runState !== "preparing" && (
        <div className="search-controls">
          <button
            type="button"
            className="toolbar-button toolbar-button--primary"
            onClick={preparation.start}
            disabled={!preparation.canStart}
          >
            Prepare selected streets
          </button>
          <p className="search-hint">
            Prepares selected streets and available imagery for mapping. Detection runs per
            street in the inventory workflow below.
          </p>
          {preparation.disabledReason && (
            <p className="search-hint" role="status">
              {preparation.disabledReason}
            </p>
          )}
        </div>
      )}

      {(runState === "prepared" || runState === "stale") && plan && (
        <div className="search-results">
          <p className="search-status" role="status" aria-live="polite">
            {runState === "prepared"
              ? `Preparation complete — ${plan.streetItems.length} street${plan.streetItems.length === 1 ? "" : "s"} ready; open the inventory workflow per street below.`
              : "Inputs changed since preparation — the plan below is stale. Prepare selected streets again to rebuild it."}
          </p>
          {plan.imagePool.count === 0 && (
            <p className="search-status" role="status">
              No imagery available in this region. This says nothing about whether its streets
              have lights.
            </p>
          )}
          {plan.warnings.length > 0 && (
            <ul className="warning-list" role="status">
              {plan.warnings.map((code, index) => (
                <li key={`${code}:${index}`}>{warningMessage(code)}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
          >
            {detailsOpen ? "Hide preparation details" : "View preparation details"}
          </button>
          {detailsOpen && <PreparationDetails preparation={preparation} />}
          <p className="coverage-note">
            The plan is kept in memory only; reloading clears it.
          </p>
        </div>
      )}

      {runState === "failed" && (
        <div className="search-status" role="alert">
          <p className="error-text">
            Preparation failed — no usable plan was produced. Fix the input and start again.
          </p>
          {preparation.failedStreetIds.length > 0 && (
            <ul className="warning-list">
              {preparation.failedStreetIds.map((id) => (
                <li key={id}>
                  {id}: {preparation.failureReasons[id] ?? "invalid street"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {runState === "cancelled" && (
        <p className="search-status" role="status">
          Preparation cancelled. No partial plan was kept; start again when ready.
        </p>
      )}

      {runState !== "not_started" && (
        <p className="search-counts">State: {PREPARATION_STATE_LABELS[runState]}</p>
      )}
    </div>
  );
}
