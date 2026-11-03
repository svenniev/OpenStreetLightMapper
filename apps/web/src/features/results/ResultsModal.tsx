import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { formatRetrievedAt, warningMessage } from "../../lib/search";
import { EvidenceThumb } from "../inventory/EvidenceThumb";
import { isDemoImageId } from "../inventory/demoScenes";
import { mapViewRectToFull } from "../inventory/imageViews";
import {
  OBSERVATION_ORIGIN_LABELS,
  STREET_SOURCE_LABELS,
  type InventoryObservation,
  type SessionPreviewResult,
  type SourceView,
} from "../inventory/inventoryTypes";
import type { ViewMedia } from "../inventory/useViewMedia";
import {
  validateInventoryResult,
  validateSessionPreview,
  type InventoryRecord,
  type PreviewExpectation,
  type ResultExpectation,
} from "./resultTypes";

export interface ResultsEvidence {
  observations: Record<string, InventoryObservation>;
  views: Record<string, SourceView>;
  viewMedia: ViewMedia;
}

export interface ResultsModalProps {
  /** Street the modal was opened for (row identity, always known). */
  streetDisplayName: string;
  /** Expected current revision/run; the payload must match to render. */
  expected: ResultExpectation;
  /**
   * Supplied completed result, session preview, or null when none exists.
   * Completed results have no production producer; fixtures exercise that
   * boundary in tests. Session previews come from the in-memory workflow.
   */
  payload: unknown;
  /** Expected preview identity; required when the payload is a preview. */
  previewExpected?: PreviewExpectation | null;
  /** Session evidence for photo rendering; omitted in completed-result fixtures. */
  evidence?: ResultsEvidence | null;
  /** Shown as "Return to review" when the workflow view is available. */
  onReturnToReview?: (() => void) | null;
  onClose: () => void;
}

function MeasurementList({ record }: { record: InventoryRecord }) {
  if (record.measurements.length === 0) return <span>no supplied measurements</span>;
  return (
    <ul className="result-measurements">
      {record.measurements.map((measurement, index) => (
        <li key={`${measurement.kind}:${index}`}>
          {measurement.kind}:{" "}
          {measurement.value === null
            ? "unknown"
            : `${measurement.value}${measurement.unit ? ` ${measurement.unit}` : ""}`}
        </li>
      ))}
    </ul>
  );
}

function supportLabel(support: SessionPreviewResult["assets"][number]["support"]): string {
  if (!support) return "—";
  if (support.kind === "pole") return `Pole ${support.poleAssetId}`;
  if (support.kind === "wall") return "Wall-mounted";
  if (support.kind === "suspended") return "Suspended";
  return "Support unknown";
}

function positionLabel(asset: SessionPreviewResult["assets"][number]): string {
  const position = asset.position;
  if (position.kind === "geographic") {
    return `Manual ${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
  }
  if (position.kind === "diagram") {
    return `Diagram ${position.x.toFixed(1)}, ${position.y.toFixed(1)} (schematic)`;
  }
  if (position.kind === "inherited") {
    return `Inherited from ${position.fromAssetId}`;
  }
  return "Unknown";
}

function EvidencePhotos({
  asset,
  evidence,
}: {
  asset: SessionPreviewResult["assets"][number];
  evidence: ResultsEvidence;
}) {
  const photos = asset.observationIds
    .map((obsId) => evidence.observations[obsId])
    .filter(
      (observation): observation is InventoryObservation =>
        Boolean(observation) && !isDemoImageId(observation.imageId),
    );
  if (photos.length === 0) return null;
  return (
    <span className="evidence-photos">
      {photos.map((observation) => {
        const view = observation.viewId ? evidence.views[observation.viewId] : undefined;
        const rect =
          observation.imageRegion && view
            ? mapViewRectToFull(observation.imageRegion, view)
            : observation.imageRegion;
        return (
          <EvidenceThumb
            key={observation.id}
            imageId={observation.imageId}
            viewMedia={evidence.viewMedia}
            rect={rect}
            label={`${observation.id} (${OBSERVATION_ORIGIN_LABELS[observation.origin]})`}
          />
        );
      })}
    </span>
  );
}

function PreviewBody({ preview, evidence }: { preview: SessionPreviewResult; evidence: ResultsEvidence | null }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const counts = preview.counts;
  const processing = preview.processing;
  return (
    <div className="result-body">
      <p className="street-seeded-banner" role="status">
        {preview.mode === "demo"
          ? "Demo inventory preview — schematic sample data. No AI has run."
          : preview.model
            ? `SAM-assisted session preview — every sighting was manually reviewed. Inventory reviewed — session only.`
            : "Manual session preview — no model detections were used. Inventory reviewed — session only."}
      </p>
      {preview.streetSource === "manual-work-area" && (
        <p className="search-status error-text" role="note">
          Street unverified: a manual imagery work area, not an OpenStreetMap street. Do not use
          these assignments as street inventory.
        </p>
      )}
      <p className="search-status" role="status">
        <strong>Not saved — temporary preview.</strong> Reloading the page loses this work.
      </p>
      <dl className="config-status">
        <div className="config-row">
          <dt>Session</dt>
          <dd>{preview.sessionId}</dd>
        </div>
        <div className="config-row">
          <dt>Street provenance</dt>
          <dd>{STREET_SOURCE_LABELS[preview.streetSource]}</dd>
        </div>
        <div className="config-row">
          <dt>Region revision</dt>
          <dd>{preview.roiRevision ?? "demo (no region)"}</dd>
        </div>
        <div className="config-row">
          <dt>Run</dt>
          <dd>{preview.runId ?? "demo"}</dd>
        </div>
        <div className="config-row">
          <dt>Finished</dt>
          <dd>{formatRetrievedAt(preview.finishedAt)}</dd>
        </div>
        <div className="config-row">
          <dt>Origins</dt>
          <dd>
            {preview.origins.length > 0
              ? preview.origins.map((origin) => OBSERVATION_ORIGIN_LABELS[origin]).join(", ")
              : "none"}
            {preview.model ? ` · model ${preview.model}` : ""}
          </dd>
        </div>
        {processing.views > 0 && (
          <div className="config-row">
            <dt>Processing</dt>
            <dd>
              {processing.succeededViews} of {processing.views} views produced results
              {processing.failedViews > 0 ? ` · ${processing.failedViews} failed` : ""}
              {processing.unprocessedViews > 0 ? ` · ${processing.unprocessedViews} unprocessed` : ""}
              {processing.concepts.length > 0 ? ` · ${processing.concepts.join("; ")}` : ""}
            </dd>
          </div>
        )}
      </dl>
      <p className="search-status" role="status">
        {counts.poles} pole{counts.poles === 1 ? "" : "s"} · {counts.luminaires} luminaire
        {counts.luminaires === 1 ? "" : "s"} (counted separately) · {counts.placed} placed ·{" "}
        {counts.unplaced} unplaced
      </p>
      {preview.assets.length === 0 ? (
        <p className="search-status" role="status">
          No assets recorded in this preview.
        </p>
      ) : (
        <div className="result-table-wrap">
          <table className="result-table">
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Category</th>
                <th scope="col">Support</th>
                <th scope="col">Position</th>
                <th scope="col">Evidence</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {preview.assets.map((asset) => (
                <Fragment key={asset.assetId}>
                  <tr>
                    <td>{asset.assetId}</td>
                    <td>{asset.category === "pole" ? "Pole/support" : "Luminaire"}</td>
                    <td>{supportLabel(asset.support)}</td>
                    <td>{positionLabel(asset)}</td>
                    <td>
                      {asset.observationIds.length} obs · {asset.imageIds.length} images
                    </td>
                    <td>
                      <button
                        type="button"
                        className="toolbar-button toolbar-button--small"
                        aria-expanded={expandedId === asset.assetId}
                        onClick={() =>
                          setExpandedId((current) => (current === asset.assetId ? null : asset.assetId))
                        }
                      >
                        {expandedId === asset.assetId ? "Hide evidence" : "View evidence"}
                      </button>
                    </td>
                  </tr>
                  {expandedId === asset.assetId && (
                    <tr>
                      <td colSpan={6}>
                        Observations: {asset.observationIds.join(", ") || "none"}; images:{" "}
                        {asset.imageIds.join(", ") || "none"}; review: {asset.reviewState}
                        {asset.note ? `; note: ${asset.note}` : ""}
                        {evidence && <EvidencePhotos asset={asset} evidence={evidence} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="warning-list" role="status">
        {preview.limitations.map((limitation, index) => (
          <li key={index}>{limitation}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Completed-inventory and session-preview modal. Renders only a validated
 * payload for the current street and run/session; anything else is refused
 * with an explicit reason. Escape and Close dismiss; focus is contained while
 * open and restored on close.
 */
export function ResultsModal(props: ResultsModalProps) {
  const { onClose } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const isPreviewPayload =
    typeof props.payload === "object" &&
    props.payload !== null &&
    (props.payload as { kind?: unknown }).kind === "session-preview";

  const previewValidation = useMemo(
    () =>
      !isPreviewPayload
        ? null
        : !props.previewExpected
          ? ({ ok: false as const, reason: "no preview context for this street" })
          : validateSessionPreview(props.payload, props.previewExpected),
    [isPreviewPayload, props.payload, props.previewExpected],
  );

  const legacyValidation = useMemo(
    () =>
      isPreviewPayload || props.payload === null
        ? null
        : validateInventoryResult(props.payload, props.expected),
    [isPreviewPayload, props.payload, props.expected],
  );

  // Initial focus, Escape dismissal, focus containment, and focus restoration.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  const previewMode =
    previewValidation && previewValidation.ok ? previewValidation.preview.mode : null;
  const title = isPreviewPayload
    ? previewMode === "demo"
      ? `Demo inventory preview — ${props.streetDisplayName}`
      : `Session preview — ${props.streetDisplayName}`
    : `Inventory results — ${props.streetDisplayName}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="results-modal-title"
        className="modal-dialog modal-dialog--wide"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="results-modal-title" className="panel-title">
          {title}
        </h2>

        {!isPreviewPayload && legacyValidation === null && (
          <p className="search-status" role="status">
            No completed inventory result for this street yet. Inventory mapping runs in a
            later stage; preparation alone does not produce results.
          </p>
        )}

        {isPreviewPayload && previewValidation && !previewValidation.ok && (
          <p className="search-status error-text" role="alert">
            This preview cannot be shown: {previewValidation.reason}.
          </p>
        )}

        {!isPreviewPayload && legacyValidation !== null && !legacyValidation.ok && (
          <p className="search-status error-text" role="alert">
            This result cannot be shown: {legacyValidation.reason}.
          </p>
        )}

        {isPreviewPayload && previewValidation && previewValidation.ok && (
          <PreviewBody preview={previewValidation.preview} evidence={props.evidence ?? null} />
        )}

        {!isPreviewPayload && legacyValidation !== null && legacyValidation.ok && (
          <div className="result-body">
            <dl className="config-status">
              <div className="config-row">
                <dt>Region revision</dt>
                <dd>{legacyValidation.result.roiRevision}</dd>
              </div>
              <div className="config-row">
                <dt>Run</dt>
                <dd>{legacyValidation.result.runId}</dd>
              </div>
              <div className="config-row">
                <dt>Mapped</dt>
                <dd>{formatRetrievedAt(legacyValidation.result.completedAt)}</dd>
              </div>
              <div className="config-row">
                <dt>Source ways</dt>
                <dd>
                  {legacyValidation.result.wayIds.length === 0
                    ? "none recorded"
                    : legacyValidation.result.wayIds.map((id) => `OSM way ${id}`).join(", ")}
                </dd>
              </div>
            </dl>
            {legacyValidation.result.records.length === 0 ? (
              <p className="search-status" role="status">
                Completed inventory with zero assets recorded for this street.
              </p>
            ) : (
              <ol className="result-records">
                {legacyValidation.result.records.map((record) => (
                  <li key={record.assetId} className="result-record">
                    <p className="result-asset">
                      Asset {record.assetId} · review: {record.reviewState}
                    </p>
                    <p className="search-counts">
                      Source images:{" "}
                      {record.sourceImageIds.length === 0
                        ? "none recorded"
                        : record.sourceImageIds.join(", ")}
                    </p>
                    <MeasurementList record={record} />
                  </li>
                ))}
              </ol>
            )}
            {legacyValidation.result.warnings.length > 0 && (
              <ul className="warning-list" role="status">
                {legacyValidation.result.warnings.map((code, index) => (
                  <li key={`${code}:${index}`}>{warningMessage(code)}</li>
                ))}
              </ul>
            )}
            <p className="coverage-note">
              Inventory geometry alone is not EN 13201 compliance.
            </p>
          </div>
        )}

        <div className="modal-actions">
          {isPreviewPayload && props.onReturnToReview && (
            <button type="button" className="toolbar-button" onClick={props.onReturnToReview}>
              Return to review
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            className="toolbar-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
