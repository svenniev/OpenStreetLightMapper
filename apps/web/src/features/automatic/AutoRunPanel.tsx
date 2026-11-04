import { isActiveAutoJobStatus, type AutoJobStatus } from "../../lib/autoApi";
import type { AutoRun, AutoConceptsChoice } from "./useAutoRun";

export interface AutoRunPanelProps {
  auto: AutoRun;
  backendConnected: boolean;
  samConfigured: boolean;
  selectedSequences: number;
  hasDiscovery: boolean;
}

function statusLabel(status: AutoJobStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "preparing":
      return "Preparing views";
    case "detecting":
      return "Detecting";
    case "locating":
      return "Locating";
    case "publishing":
      return "Publishing";
    case "completed":
      return "Completed";
    case "completed_with_gaps":
      return "Completed with gaps";
    case "stopped":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 12)}…`;
}

function ConceptsToggle(props: { value: AutoConceptsChoice; onChange: (value: AutoConceptsChoice) => void }) {
  return (
    <div className="scope-toggle" role="group" aria-label="Automatic run concepts">
      <button
        type="button"
        className="toolbar-button toolbar-button--small"
        aria-pressed={props.value === "poles-and-fixtures"}
        onClick={() => props.onChange("poles-and-fixtures")}
      >
        Poles + fixtures
      </button>
      <button
        type="button"
        className="toolbar-button toolbar-button--small"
        aria-pressed={props.value === "poles-only"}
        onClick={() => props.onChange("poles-only")}
      >
        Poles only
      </button>
    </div>
  );
}

export function AutoRunPanel(props: AutoRunPanelProps) {
  const { auto } = props;
  const detail = auto.detail;
  const active = detail ? isActiveAutoJobStatus(detail.job.status) : false;
  const resumable =
    detail?.job.status === "stopped" ||
    detail?.job.status === "interrupted" ||
    detail?.job.status === "failed";

  return (
    <div className="auto-run-panel">
      <p className="search-hint">
        Automatically generated — not human reviewed. The server runs the whole job; you can close
        this tab while it continues.
      </p>
      {!props.backendConnected && (
        <p className="error-text" role="alert">
          The backend is not connected — automatic runs need the local server.
        </p>
      )}
      {props.backendConnected && !props.samConfigured && (
        <p className="error-text" role="alert">
          SAM detection is not configured on the server (MODEL_API_KEY). Launch will refuse until
          it is set.
        </p>
      )}

      <div className="auto-run-row" role="group" aria-label="Automatic run mode">
        <div className="scope-toggle" role="group" aria-label="Run goal">
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            aria-pressed={auto.mode === "locate"}
            onClick={() => auto.setMode("locate")}
          >
            Detect + locate
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            aria-pressed={auto.mode === "detect"}
            onClick={() => auto.setMode("detect")}
          >
            Detect only
          </button>
        </div>
        <ConceptsToggle value={auto.conceptsChoice} onChange={auto.setConceptsChoice} />
        <label className="inventory-label">
          Min spacing (m)
          <input
            type="number"
            className="inventory-select"
            min={0}
            max={1000}
            step="any"
            value={auto.minSpacingM}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              auto.setMinSpacingM(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1000) : 10);
            }}
            title="Images closer than this to an already-included image are skipped in sequence order. 0 disables thinning."
          />
        </label>
      </div>

      <div className="auto-run-row">
        <button
          type="button"
          className="toolbar-button"
          disabled={auto.preparing || !props.backendConnected || !props.hasDiscovery || props.selectedSequences === 0}
          title={
            !props.hasDiscovery
              ? "Search a region first."
              : props.selectedSequences === 0
                ? "Check at least one sequence above."
                : "Freeze the bounded plan (no SAM calls)."
          }
          onClick={() => void auto.runPrepare()}
        >
          {auto.preparing ? "Preparing…" : "Prepare run"}
        </button>
        {auto.prepare && (
          <button
            type="button"
            className="toolbar-button toolbar-button--primary"
            disabled={auto.acting || !props.backendConnected}
            title="Authorize the displayed bounded plan. One SAM call in flight, server-side."
            onClick={() => void auto.runLaunch()}
          >
            {auto.acting ? "Launching…" : "Launch automatic mapping"}
          </button>
        )}
      </div>
      {auto.prepareError && (
        <p className="error-text" role="alert">
          {auto.prepareError}
        </p>
      )}

      {auto.prepare && (
        <div className="auto-plan" aria-live="polite">
          <h3 className="settings-heading">Bounded plan</h3>
          <p className="sequence-meta">
            {auto.prepare.totalImages} in-RoI images · {auto.prepare.estimatedCalls} estimated SAM
            calls · {auto.prepare.counts.eligibleImages} locatable,{" "}
            {auto.prepare.counts.detectionOnlyImages} detection-only,{" "}
            {auto.prepare.counts.missingMetadataImages} without metadata
          </p>
          {(auto.prepare.excludedOutsideRoi > 0 || auto.prepare.thinnedBySpacing > 0) && (
            <p className="sequence-meta">
              {auto.prepare.excludedOutsideRoi} outside-RoI images excluded ·{" "}
              {auto.prepare.thinnedBySpacing} skipped within {auto.prepare.minSpacingM} m of an
              included image
            </p>
          )}
          <ul className="sequence-list auto-plan-sequences">
            {auto.prepare.perSequence.map((group) => (
              <li key={group.sequenceId} className="sequence-meta">
                <span title={group.sequenceId}>{shortId(group.sequenceId)}</span>: {group.imageCount}{" "}
                images ({group.eligibleCount} locatable)
              </li>
            ))}
          </ul>
          {auto.prepare.warnings.length > 0 && (
            <ul className="warning-list">
              {auto.prepare.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {auto.actionError && (
        <p className="error-text" role="alert">
          {auto.actionError}
        </p>
      )}

      <div className="auto-jobs">
        <h3 className="settings-heading">Automatic runs</h3>
        {auto.jobsError && (
          <p className="error-text" role="alert">
            {auto.jobsError}{" "}
            <button type="button" className="link-button" onClick={() => void auto.refreshJobs()}>
              Retry
            </button>
          </p>
        )}
        {auto.jobs.length === 0 && !auto.jobsError && (
          <p className="sequence-meta">No automatic runs yet in this workspace.</p>
        )}
        {auto.jobs.length > 0 && (
          <ol className="sequence-list" aria-label="Automatic runs">
            {auto.jobs.map((job) => (
              <li key={job.jobId}>
                <button
                  type="button"
                  className={`sequence-row${job.jobId === auto.selectedJobId ? " sequence-row--selected" : ""}`}
                  aria-pressed={job.jobId === auto.selectedJobId}
                  onClick={() => auto.selectJob(job.jobId === auto.selectedJobId ? null : job.jobId)}
                >
                  <span className="sequence-id" title={job.jobId}>
                    {shortId(job.jobId)}
                  </span>
                  <span className="badge">{statusLabel(job.status)}</span>
                  <span className="sequence-meta">
                    {job.mode === "locate" ? "locate" : "detect"} · {job.callsMade}/
                    {job.estimatedCalls} calls · {job.totalImages} images
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      {auto.detailError && (
        <p className="error-text" role="alert">
          {auto.detailError}
        </p>
      )}
      {detail && (
        <div className="auto-progress" aria-live="polite">
          <h3 className="settings-heading">
            Run <span title={detail.job.jobId}>{shortId(detail.job.jobId)}</span> —{" "}
            {statusLabel(detail.job.status)}
          </h3>
          {detail.progress && (
            <p className="sequence-meta" role="status">
              {detail.progress.doneItems}/{detail.progress.totalItems} items done ·{" "}
              {detail.progress.runningItems} running · {detail.progress.failedItems} failed ·{" "}
              {detail.progress.haltedItems} halted · {detail.progress.observationCount} observations ·{" "}
              {detail.progress.locatedCount} located · {detail.progress.callsMade} calls made
            </p>
          )}
          {detail.job.error && (
            <p className="error-text" role="alert">
              {detail.job.error}
            </p>
          )}
          {detail.job.stopRequested && active && (
            <p className="sequence-meta" role="status">
              Stop requested — the current call settles first.
            </p>
          )}
          <div className="auto-run-row">
            {active && (
              <button
                type="button"
                className="toolbar-button"
                disabled={auto.acting}
                onClick={() => void auto.runStop()}
              >
                Stop
              </button>
            )}
            {resumable && (
              <button
                type="button"
                className="toolbar-button"
                disabled={auto.acting}
                title="Continue never-started items; unknown-outcome calls need explicit per-item retry."
                onClick={() => void auto.runResume()}
              >
                Resume
              </button>
            )}
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              onClick={() => {
                if (detail.job.jobId) {
                  void auto.refreshOutputs(detail.job.jobId);
                }
              }}
            >
              Refresh results
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
