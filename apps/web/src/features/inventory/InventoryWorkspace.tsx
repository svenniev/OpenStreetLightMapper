import { useState } from "react";
import type { ImageResult } from "../../lib/searchTypes";
import { DetectStep } from "./DetectStep";
import type { SequenceOption } from "./DetectSources";
import { GroupStep } from "./GroupStep";
import { InventoryStep } from "./InventoryStep";
import { deriveCounts } from "./inventoryReducer";
import {
  STREET_SOURCE_LABELS,
  WORKFLOW_STEPS,
  WORKFLOW_STEP_LABELS,
  type WorkflowStep,
} from "./inventoryTypes";
import { PlaceStep } from "./PlaceStep";
import { ReviewStep } from "./ReviewStep";
import type { InventorySessions } from "./useInventorySessions";
import type { SamStatus } from "./useSamStatus";
import type { ViewMedia } from "./useViewMedia";

export interface InventoryWorkspaceProps {
  sessions: InventorySessions;
  /** In-region Mapillary pool for manual image references. */
  poolImages: ImageResult[];
  /** Load a real image in the Mapillary viewer (never demo IDs). */
  onSelectImage: (id: string) => void;
  /** Open the Results modal for a finished session preview. */
  onOpenResults: () => void;
  /** In-region sequences for the Detect source selector. */
  sequenceOptions: SequenceOption[];
  /** Sequence currently selected in discovery, if any. */
  currentSequenceId: string | null;
  /** Image currently open in the viewer, if any. */
  currentImageId: string | null;
  /** Shared lazy photograph cache. */
  viewMedia: ViewMedia;
  /** SAM readiness + explicit test state. */
  sam: SamStatus;
}

function stepIndex(step: WorkflowStep): number {
  return WORKFLOW_STEPS.indexOf(step);
}

/**
 * Substantial in-app inventory workspace: header with session/mode/counts,
 * a non-mutating step strip, the active step, and reset/undo controls.
 * Closing preserves all temporary state; Reset asks only when edited work
 * would be discarded.
 */
export function InventoryWorkspace(props: InventoryWorkspaceProps) {
  const { sessions } = props;
  const [confirmingReset, setConfirmingReset] = useState(false);
  const session = sessions.activeSession;

  if (!sessions.isOpen || !session) return null;

  const stale = sessions.isStale(session);
  const counts = deriveCounts(session);
  const openSessions = Object.values(sessions.sessions);
  const isDirty = sessions.dirtyKeys.has(session.key);

  const goStep = (step: WorkflowStep) => {
    setConfirmingReset(false);
    sessions.dispatch({ type: "SET_STEP", step });
  };

  return (
    <div className="inventory-workspace">
      <div className="inventory-header">
        <div className="inventory-context">
          <strong>{session.context.streetDisplayName}</strong>
          <span className="inventory-mode">
            {session.mode === "demo"
              ? "Demo workflow — sample observations, no AI has run"
              : Object.values(session.observations).some(
                    (observation) => observation.origin === "sam-text" || observation.origin === "sam-assisted",
                  )
                ? "SAM-assisted preview — every sighting needs manual review"
                : "Manual preview — no model detections"}
          </span>
          <span className="inventory-source">{STREET_SOURCE_LABELS[session.context.streetSource]}</span>
        </div>
        <p className="inventory-temp" role="status">
          Temporary session — refresh loses this work. Positions and counts are review inputs, not
          measurements.
        </p>
        <div className="inventory-session-row">
          <label className="inventory-label" htmlFor="inventory-session-select">
            Session
          </label>
          <select
            id="inventory-session-select"
            className="inventory-select"
            value={session.key}
            onChange={(event) => sessions.switchSession(event.target.value)}
          >
            {openSessions.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.context.streetDisplayName} ({entry.mode}
                {sessions.isStale(entry) ? ", stale" : ""})
              </option>
            ))}
          </select>
          <button type="button" className="toolbar-button toolbar-button--small" onClick={sessions.closeWorkspace}>
            Back to workspace
          </button>
        </div>
      </div>

      {stale && (
        <p className="inventory-stale" role="alert">
          This preview is stale: {sessions.staleReason(session)} Observations and placements
          stay read-only and cannot open as a current result.{" "}
          <button type="button" className="toolbar-button toolbar-button--small" onClick={sessions.restartSession}>
            Restart preview
          </button>
        </p>
      )}

      <ol className="inventory-steps" aria-label="Workflow steps">
        {WORKFLOW_STEPS.map((step) => (
          <li key={step}>
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              aria-current={session.activeStep === step ? "step" : undefined}
              onClick={() => goStep(step)}
            >
              {WORKFLOW_STEP_LABELS[step]}
            </button>
          </li>
        ))}
      </ol>

      <p className="search-status" role="status">
        {counts.pending} pending · {counts.accepted} accepted · {counts.rejected} rejected ·{" "}
        {counts.deferred} deferred · {counts.assets} assets · {counts.placed} placed ·{" "}
        {counts.unplaced} unplaced
      </p>

      <div className="inventory-nav">
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          disabled={stepIndex(session.activeStep) === 0}
          onClick={() => goStep(WORKFLOW_STEPS[stepIndex(session.activeStep) - 1])}
        >
          Back
        </button>
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          disabled={stepIndex(session.activeStep) === WORKFLOW_STEPS.length - 1}
          onClick={() => goStep(WORKFLOW_STEPS[stepIndex(session.activeStep) + 1])}
        >
          Next
        </button>
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          disabled={!sessions.canUndo}
          title={
            sessions.undoBlockedStale
              ? "Stale session is read-only — restart the preview to edit."
              : sessions.undoLabel
                ? `Undo: ${sessions.undoLabel}`
                : "Nothing to undo"
          }
          onClick={sessions.undo}
        >
          Undo
        </button>
        {confirmingReset ? (
          <span className="inventory-confirm">
            Discard this preview&apos;s edits?{" "}
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              onClick={() => {
                setConfirmingReset(false);
                sessions.resetSession();
              }}
            >
              Confirm reset
            </button>{" "}
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => {
              if (isDirty) setConfirmingReset(true);
              else sessions.resetSession();
            }}
          >
            Reset this preview
          </button>
        )}
      </div>

      <div className="inventory-step">
        {session.activeStep === "detect" && (
          <DetectStep
            sessions={sessions}
            session={session}
            stale={stale}
            poolImages={props.poolImages}
            onSelectImage={props.onSelectImage}
            sequenceOptions={props.sequenceOptions}
            currentSequenceId={props.currentSequenceId}
            currentImageId={props.currentImageId}
            viewMedia={props.viewMedia}
            sam={props.sam}
          />
        )}
        {session.activeStep === "review" && (
          <ReviewStep
            sessions={sessions}
            session={session}
            stale={stale}
            poolImages={props.poolImages}
            onSelectImage={props.onSelectImage}
            viewMedia={props.viewMedia}
          />
        )}
        {session.activeStep === "group" && (
          <GroupStep sessions={sessions} session={session} stale={stale} viewMedia={props.viewMedia} />
        )}
        {session.activeStep === "place" && (
          <PlaceStep sessions={sessions} session={session} stale={stale} />
        )}
        {session.activeStep === "inventory" && (
          <InventoryStep sessions={sessions} session={session} stale={stale} onOpenResults={props.onOpenResults} />
        )}
      </div>
    </div>
  );
}
