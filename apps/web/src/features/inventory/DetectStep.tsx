import { useState } from "react";
import type { ImageResult } from "../../lib/searchTypes";
import { DEMO_IMAGES, DEMO_SCENARIO_LABELS, type DemoScenario } from "./demoFixtures";
import { DemoScene } from "./demoScenes";
import { DetectReal } from "./DetectReal";
import type { SequenceOption } from "./DetectSources";
import type { WorkflowSession } from "./inventoryTypes";
import type { InventorySessions } from "./useInventorySessions";
import type { SamStatus } from "./useSamStatus";
import type { ViewMedia } from "./useViewMedia";

export interface DetectStepProps {
  sessions: InventorySessions;
  session: WorkflowSession;
  stale: boolean;
  poolImages: ImageResult[];
  onSelectImage: (id: string) => void;
  sequenceOptions: SequenceOption[];
  currentSequenceId: string | null;
  currentImageId: string | null;
  viewMedia: ViewMedia;
  sam: SamStatus;
}

function ManualDetect(props: DetectStepProps) {
  return (
    <DetectReal
      session={props.session}
      sessions={props.sessions}
      stale={props.stale}
      imageOptions={props.poolImages.map((image) => ({ id: image.id, label: image.id }))}
      poolImages={props.poolImages}
      sequenceOptions={props.sequenceOptions}
      currentSequenceId={props.currentSequenceId}
      currentImageId={props.currentImageId}
      viewMedia={props.viewMedia}
      sam={props.sam}
    />
  );
}

function DemoDetect(props: DetectStepProps) {
  const { session, sessions, stale } = props;
  const [selectedIds, setSelectedIds] = useState<string[]>(DEMO_IMAGES.map((image) => image.id));
  const [scenario, setScenario] = useState<DemoScenario>("happy");
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const detection = session.detection;
  const hasObservations = Object.keys(session.observations).length > 0;
  const hasDecisions = Object.values(session.observations).some((o) => o.decision !== "pending");
  const running = detection.status === "running";

  const toggleImage = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]));
  };

  const startRun = (replace: boolean) => {
    setConfirmingReplace(false);
    sessions.runDetection(scenario, selectedIds, replace);
  };

  return (
    <div className="detect-step">
      <fieldset className="detect-images" disabled={running || stale}>
        <legend>Sample images</legend>
        {DEMO_IMAGES.map((image) => (
          <label key={image.id} className="detect-image-option">
            <input
              type="checkbox"
              checked={selectedIds.includes(image.id)}
              onChange={() => toggleImage(image.id)}
            />
            <span className="detect-thumb">
              <DemoScene sceneId={image.id} label={image.label} />
            </span>
            <span className="search-hint">
              {image.label} · {image.id}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="detect-controls">
        <label className="inventory-label" htmlFor="demo-scenario">
          Demo scenario
        </label>
        <select
          id="demo-scenario"
          className="inventory-select"
          value={scenario}
          disabled={running || stale}
          onChange={(event) => setScenario(event.target.value as DemoScenario)}
        >
          {(Object.keys(DEMO_SCENARIO_LABELS) as DemoScenario[]).map((key) => (
            <option key={key} value={key}>
              {DEMO_SCENARIO_LABELS[key]}
            </option>
          ))}
        </select>
      </div>

      {detection.status === "running" && (
        <div className="search-status" role="status" aria-live="polite">
          <p>
            Running demo detection… {detection.staged} of {detection.total} staged.
          </p>
          <button type="button" className="toolbar-button" onClick={sessions.cancelDetection}>
            Cancel
          </button>
        </div>
      )}

      {detection.status !== "running" && (
        <div className="inventory-actions">
          {!hasObservations && (
            <button
              type="button"
              className="toolbar-button toolbar-button--primary"
              disabled={stale}
              onClick={() => startRun(false)}
            >
              Run demo detection ({selectedIds.length} image{selectedIds.length === 1 ? "" : "s"})
            </button>
          )}
          {detection.status === "failed" && (
            <button
              type="button"
              className="toolbar-button toolbar-button--primary"
              disabled={stale}
              onClick={() => startRun(hasObservations)}
            >
              Retry detection
            </button>
          )}
          {hasObservations &&
            (confirmingReplace ? (
              <span className="inventory-confirm">
                Replace {Object.keys(session.observations).length} observations and{" "}
                {Object.keys(session.assets).length} assets? Manual observations are kept.{" "}
                <button
                  type="button"
                  className="toolbar-button toolbar-button--small"
                  onClick={() => startRun(true)}
                >
                  Confirm replace
                </button>{" "}
                <button
                  type="button"
                  className="toolbar-button toolbar-button--small"
                  onClick={() => setConfirmingReplace(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="toolbar-button"
                disabled={stale}
                onClick={() => {
                  if (hasDecisions) setConfirmingReplace(true);
                  else startRun(true);
                }}
              >
                Replace demo observations
              </button>
            ))}
          {(detection.status === "finished" || (hasObservations && detection.status !== "failed")) && (
            <button
              type="button"
              className="toolbar-button"
              onClick={() => sessions.dispatch({ type: "SET_STEP", step: "review" })}
            >
              Continue to Review
            </button>
          )}
        </div>
      )}

      {detection.status === "finished" && (
        <p className="search-status" role="status">
          {detection.empty
            ? "No sample detections in the selected images. Add observations manually in Review, or explicitly review this empty set."
            : `Returned ${detection.observationCount} sample observation${detection.observationCount === 1 ? "" : "s"}.`}
        </p>
      )}
      {detection.status === "failed" && (
        <p className="search-status error-text" role="alert">
          {detection.message} This is a failed run, not zero detections.
        </p>
      )}
      {detection.status === "cancelled" && !hasObservations && (
        <p className="search-status" role="status">
          Detection cancelled. Nothing was applied — retry when ready.
        </p>
      )}
      <p className="search-hint">
        Deterministic sample adapter: no model runs, no timings or confidence are shown.
      </p>
    </div>
  );
}

export function DetectStep(props: DetectStepProps) {
  if (props.session.mode === "manual") return <ManualDetect {...props} />;
  return <DemoDetect {...props} />;
}
