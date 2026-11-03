import { useCallback } from "react";
import type { StreetWorkItem } from "../../lib/api";
import { formatRetrievedAt, warningMessage } from "../../lib/search";
import type { SearchError } from "../../lib/searchTypes";
import { formatStreetLength, streetHighwayTypes } from "./streetDisplay";
import { WORKFLOW_STATUS_LABELS, type StreetWorkflowStatus } from "./streetTypes";
import type { DemoSeed } from "./seedDemo";
import type { StreetsStatus } from "./useStreets";

export interface StreetPanelProps {
  status: StreetsStatus;
  streets: StreetWorkItem[];
  checkedIds: Set<string>;
  checkedCount: number;
  focusedId: string | null;
  warnings: string[];
  error: SearchError | null;
  retrievedAt: string | null;
  hasRegion: boolean;
  workflowStatuses: Map<string, StreetWorkflowStatus>;
  /** Streets with a valid completed inventory result (none this milestone). */
  resultsAvailable: Set<string>;
  /** Streets whose Results open a temporary session preview instead. */
  previewResults?: Set<string>;
  /** True when the list is demo-seeded, not Overpass data. */
  seeded: boolean;
  /** Prebuilt demo seed, or null when seeding is impossible (no sequences). */
  seedPreview: DemoSeed | null;
  onToggleChecked: (id: string, checked: boolean) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onToggleFocus: (id: string) => void;
  onRetry: () => void;
  onSeed: () => void;
  onOpenResults: (id: string) => void;
}

function StreetRow({
  street,
  checked,
  focused,
  workflowStatus,
  resultsEnabled,
  resultsPreview,
  onToggleChecked,
  onToggleFocus,
  onOpenResults,
}: {
  street: StreetWorkItem;
  checked: boolean;
  focused: boolean;
  workflowStatus: StreetWorkflowStatus;
  resultsEnabled: boolean;
  resultsPreview: boolean;
  onToggleChecked: (checked: boolean) => void;
  onToggleFocus: () => void;
  onOpenResults: () => void;
}) {
  const resultsTitle = !resultsEnabled
    ? "Available after inventory mapping is complete."
    : resultsPreview
      ? "Open session preview results (temporary, not saved)."
      : "Open completed inventory results.";
  return (
    <li className={`street-row${checked ? "" : " street-row--muted"}`}>
      <input
        type="checkbox"
        className="street-checkbox"
        checked={checked}
        onChange={(event) => onToggleChecked(event.target.checked)}
        aria-label={`Include ${street.displayName} in preparation`}
      />
      <button
        type="button"
        className="street-name"
        aria-pressed={focused}
        title={street.displayName}
        onClick={onToggleFocus}
      >
        {street.displayName}
        {street.partLabel ? ` (${street.partLabel})` : ""}
      </button>
      <span className="street-meta">
        {street.demoSequenceIds ? (
          <>
            Camera path work area · {street.demoSequenceIds.length} demo sequence
            {street.demoSequenceIds.length === 1 ? "" : "s"} · length not a road measurement
          </>
        ) : (
          <>
            {streetHighwayTypes(street).join(", ")} · {formatStreetLength(street.lengthM)}
          </>
        )}
      </span>
      <span className="street-status">{WORKFLOW_STATUS_LABELS[workflowStatus]}</span>
      <button
        type="button"
        className="toolbar-button toolbar-button--small"
        disabled={!resultsEnabled}
        title={resultsTitle}
        aria-label={
          resultsEnabled
            ? resultsPreview
              ? `Open session preview results for ${street.displayName}`
              : `Open inventory results for ${street.displayName}`
            : `Results for ${street.displayName}: available after inventory mapping is complete`
        }
        onClick={onOpenResults}
      >
        Results
      </button>
    </li>
  );
}

export function StreetPanel(props: StreetPanelProps) {
  const { streets, checkedCount } = props;
  const masterRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element) {
        element.indeterminate = checkedCount > 0 && checkedCount < streets.length;
      }
    },
    [checkedCount, streets.length],
  );

  if (!props.hasRegion) {
    return <p className="street-empty">Commit a region to list its streets.</p>;
  }

  if (props.status === "loading") {
    return (
      <p className="street-status-line" role="status" aria-live="polite">
        Loading streets…
      </p>
    );
  }

  if (props.status === "failed" && props.error) {
    return (
      <div className="street-status-line" role="alert">
        <p className="error-text">{props.error.message}</p>
        <div className="street-failed-actions">
          {props.error.retryable && (
            <button type="button" className="toolbar-button toolbar-button--small" onClick={props.onRetry}>
              Retry streets
            </button>
          )}
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={!props.seedPreview}
            title={
              props.seedPreview
                ? "Seed a labeled demo street from Mapillary sequence positions (Overpass workaround)."
                : "Discover Mapillary sequences first — seeding needs at least two sequence positions in the region."
            }
            onClick={props.onSeed}
          >
            Seed data
          </button>
        </div>
      </div>
    );
  }

  if (props.status === "loaded" && streets.length === 0) {
    return (
      <p className="street-status-line" role="status">
        No eligible streets were found in this region.
      </p>
    );
  }

  if (props.status !== "loaded") {
    return (
      <p className="street-status-line" role="status">
        Street retrieval has not started for this region.
      </p>
    );
  }

  const seededStreet = props.seeded ? streets.find((street) => street.demoSequenceIds) : undefined;
  const seededPoints = seededStreet?.geometry.coordinates[0]?.length ?? 0;

  return (
    <div className="street-panel">
      {props.seeded && (
        <p className="street-seeded-banner" role="status">
          Demo data — seeded from {seededPoints} Mapillary sequence position
          {seededPoints === 1 ? "" : "s"}
          {seededStreet?.demoSequenceIds
            ? ` across ${seededStreet.demoSequenceIds.length} sequence${seededStreet.demoSequenceIds.length === 1 ? "" : "s"}`
            : ""}
          , not OpenStreetMap. Sequence links are illustrative only.
        </p>
      )}
      <p className="street-status-line" role="status" aria-live="polite">
        {streets.length} street{streets.length === 1 ? "" : "s"} · {checkedCount} included
        {props.retrievedAt ? ` · retrieved ${formatRetrievedAt(props.retrievedAt)}` : ""}
      </p>
      {props.warnings.length > 0 && (
        <ul className="warning-list">
          {props.warnings.map((code) => (
            <li key={code}>{warningMessage(code)}</li>
          ))}
        </ul>
      )}
      <div className="street-bulk">
        <label className="street-master">
          <input
            ref={masterRef}
            type="checkbox"
            checked={checkedCount === streets.length && streets.length > 0}
            onChange={(event) => {
              if (event.target.checked) props.onSelectAll();
              else props.onDeselectAll();
            }}
            aria-label="Select all streets"
          />
          Select all
        </label>
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          onClick={props.onDeselectAll}
        >
          Deselect all
        </button>
      </div>
      <ol className="street-list" aria-label="Streets in region">
        {streets.map((street) => (
          <StreetRow
            key={street.id}
            street={street}
            checked={props.checkedIds.has(street.id)}
            focused={props.focusedId === street.id}
            workflowStatus={props.workflowStatuses.get(street.id) ?? "not_prepared"}
            resultsEnabled={props.resultsAvailable.has(street.id)}
            resultsPreview={props.previewResults?.has(street.id) ?? false}
            onToggleChecked={(checked) => props.onToggleChecked(street.id, checked)}
            onToggleFocus={() => props.onToggleFocus(street.id)}
            onOpenResults={() => props.onOpenResults(street.id)}
          />
        ))}
      </ol>
    </div>
  );
}
