import { useState } from "react";
import type { RoiSearch } from "../../hooks/useRoiSearch";
import { formatArea, formatRetrievedAt, warningMessage } from "../../lib/search";
import type { SamStatus } from "../inventory/useSamStatus";

/**
 * Workflow action sections, rendered in their owning panels (map, sequences,
 * streets) — not in a settings sidebar. The settings drawer keeps only
 * provider/database/developer configuration.
 */
export interface SearchControlsProps {
  search: RoiSearch;
  backendConnected: boolean;
  /** Null while unknown (backend unreachable). */
  searchConfigured: boolean | null;
}

export function SamSection({ search, sam }: { search: RoiSearch; sam: SamStatus }) {
  const [concept, setConcept] = useState("street light pole");
  const imageId = search.viewerActual.imageId;
  const readiness = sam.readiness;
  const statusLabel =
    readiness.status === "unknown"
      ? "Checking…"
      : readiness.status === "not-configured"
        ? "Not configured"
        : readiness.status === "configured-unverified"
          ? "Configured — not tested"
          : readiness.status === "available"
            ? `Available — last test succeeded ${formatRetrievedAt(readiness.lastTest.at)}`
            : "Last test failed";
  const testDisabledReason = sam.testing
    ? "Testing…"
    : readiness.status === "unknown"
      ? "SAM status is still loading."
      : readiness.status === "not-configured"
        ? "Configure MODEL_API_KEY first (see setup below)."
        : !imageId
          ? "Open an image in the viewer to test on it."
          : concept.trim().length === 0
            ? "Enter a concept to test."
            : null;

  return (
    <div className="sam-section">
      <p className="search-status" role="status">
        SAM detection: <strong>{statusLabel}</strong> · model {sam.model}
      </p>
      <details className="inventory-demo-details">
        <summary>Setup instructions</summary>
        <ol className="sam-steps">
          <li>
            Create a Meta Model API key at{" "}
            <a href="https://dev.meta.ai/" target="_blank" rel="noreferrer">
              dev.meta.ai
            </a>{" "}
            (select the account/project; claim hackathon credits if applicable).
          </li>
          <li>
            Set <code>MODEL_API_KEY</code> in <code>apps/server/.env</code> (see{" "}
            <code>apps/server/.env.example</code>) — server-only, never a VITE_* variable.
          </li>
          <li>Restart the server, then run the test below: only a successful inference proves access.</li>
        </ol>
        <p className="search-hint">
          Docs:{" "}
          <a href="https://dev.meta.ai/docs/sam/overview" target="_blank" rel="noreferrer">
            SAM overview
          </a>
          ,{" "}
          <a href="https://dev.meta.ai/docs/sam/prompting" target="_blank" rel="noreferrer">
            prompting guide
          </a>
          ,{" "}
          <a
            href="https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/01_api_basics"
            target="_blank"
            rel="noreferrer"
          >
            API basics example
          </a>
          . A present-but-wrong key or missing SAM entitlement surfaces as an authentication error
          on explicit Test/Detect work.
        </p>
      </details>
      <label className="inventory-label">
        Test concept
        <input
          type="text"
          className="inventory-input"
          value={concept}
          maxLength={80}
          disabled={sam.testing}
          onChange={(event) => setConcept(event.target.value)}
        />
      </label>
      <p className="search-hint">
        Test on {imageId ? `the viewer image (${imageId})` : "a viewer image"} — transmits it to
        Meta and uses model credits.
      </p>
      <div className="inventory-actions">
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          disabled={testDisabledReason !== null}
          title={testDisabledReason ?? undefined}
          onClick={() => {
            if (imageId) void sam.testOnImage(imageId, concept);
          }}
        >
          {sam.testing ? "Testing…" : "Test on selected image"}
        </button>
      </div>
      {sam.lastTest && (
        <p className={sam.lastTest.ok ? "search-status" : "search-status error-text"} role="status">
          Last test {formatRetrievedAt(sam.lastTest.at)}: {sam.lastTest.message}
        </p>
      )}
    </div>
  );
}

export function RegionSummary({ search }: { search: RoiSearch }) {
  const { roi, drawing } = search;
  if (drawing) {
    return (
      <p className="region-line">
        Drawing a {drawing}… finish or cancel; the committed region is unchanged until then.
      </p>
    );
  }
  if (!roi) {
    return <p className="region-line">Select a region to find Mapillary images.</p>;
  }
  const shapeLabel = roi.shape === "rectangle" ? "Rectangle" : "Polygon";
  return (
    <div className="region-summary">
      <p className="region-line">
        <strong>
          {shapeLabel} · {roi.areaSqM > 0 ? formatArea(roi.areaSqM) : "area unknown"}
        </strong>
      </p>
      {roi.valid ? (
        <p className="region-line region-line--ok">Region ready for search.</p>
      ) : (
        <p className="region-line error-text" role="alert">
          {roi.errorMessage ?? "Region is not searchable."} Redraw a smaller, simple shape; the
          selection was not clipped or changed.
        </p>
      )}
      <button type="button" className="toolbar-button toolbar-button--small" onClick={search.fitRegion}>
        Fit region
      </button>
    </div>
  );
}

export function SearchControls(props: SearchControlsProps) {
  const { search, backendConnected, searchConfigured } = props;
  const { status, roi } = search;

  if (status === "loading") {
    return (
      <div className="search-controls">
        <p className="search-status" role="status" aria-live="polite">
          Searching Mapillary images…
        </p>
        <button type="button" className="toolbar-button" onClick={search.cancelSearch}>
          Cancel search
        </button>
      </div>
    );
  }

  let disabledHint: string | null = null;
  if (roi && !roi.valid) disabledHint = null; // region error already shown above
  else if (!backendConnected) disabledHint = "Backend unavailable — search needs the local server.";
  else if (searchConfigured === false)
    disabledHint = "Mapillary search is not configured on the server (MAPILLARY_ACCESS_TOKEN).";
  else if (searchConfigured === null) disabledHint = "Checking search configuration…";

  return (
    <div className="search-controls">
      <button
        type="button"
        className="toolbar-button toolbar-button--primary"
        onClick={() => void search.runSearch()}
        disabled={!search.findEnabled}
      >
        Find Mapillary sequences
      </button>
      <p className="search-hint">
        Sequences are discovered from available image records in the region.
      </p>
      {disabledHint && search.roi?.valid && (
        <p className="search-hint" role="status">
          {disabledHint}
        </p>
      )}
      {status === "cancelled" && (
        <p className="search-status" role="status">
          Search cancelled. The region is unchanged; search again when ready.
        </p>
      )}
      {status === "failed" && search.searchError && (
        <div className="search-status" role="alert">
          <p className="error-text">{search.searchError.message}</p>
          {search.searchError.retryable && (
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              onClick={() => void search.runSearch()}
            >
              Retry search
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SearchResults({ search }: { search: RoiSearch }) {
  const { status, query, warnings } = search;
  if (status === "empty") {
    return (
      <div className="search-results">
        <p className="search-status" role="status">
          No matching Mapillary images were returned for this region.
        </p>
        {warnings.length > 0 && (
          <ul className="warning-list" role="status">
            {warnings.map((code) => (
              <li key={code}>{warningMessage(code)}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (status !== "results" || !query) return null;
  return (
    <div className="search-results">
      <p className="search-status" role="status" aria-live="polite">
        {query.matchedCount} unique image{query.matchedCount === 1 ? "" : "s"} · retrieved{" "}
        {formatRetrievedAt(query.retrievedAt)}
      </p>
      <p className="search-counts">
        {query.rawReturnedCount} returned · {query.outsideRoiCount} outside region ·{" "}
        {query.duplicateCount} duplicates · {query.invalidRecordCount} invalid
      </p>
      {warnings.length > 0 && (
        <ul className="warning-list" role="status">
          {warnings.map((code) => (
            <li key={code}>{warningMessage(code)}</li>
          ))}
        </ul>
      )}
      <p className="coverage-note">
        These are the images returned for this search only — not complete coverage, and not
        evidence about streetlights. Browse them as sequences in the panel below the map.
      </p>
    </div>
  );
}


