import type { RoiSearch } from "../../hooks/useRoiSearch";
import { MAPILLARY_CLIENT_TOKEN, OSM_TILE_URL_IS_DEFAULT } from "../../lib/config";
import { formatArea, formatRetrievedAt, warningMessage } from "../../lib/search";
import { ResultsList } from "../search/ResultsList";

export interface SettingsPanelProps {
  search: RoiSearch;
  backendConnected: boolean;
  /** Null while unknown (backend unreachable). */
  searchConfigured: boolean | null;
}

function RegionSummary({ search }: { search: RoiSearch }) {
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

function SearchControls(props: SettingsPanelProps) {
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
        Find Mapillary images
      </button>
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

function SearchResults({ search }: { search: RoiSearch }) {
  const { status, images, query, warnings } = search;
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
        evidence about streetlights.
      </p>
      <ResultsList
        images={images}
        selectedId={search.selectedId}
        viewedId={search.viewerActual.imageId}
        page={search.resultPage}
        onPage={search.setResultPage}
        onSelect={search.selectResult}
      />
    </div>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { search, backendConnected, searchConfigured } = props;
  const searchStatusLabel = !backendConnected
    ? "Unknown (backend unavailable)"
    : searchConfigured === true
      ? "Configured"
      : searchConfigured === false
        ? "Not configured"
        : "Checking…";
  return (
    <div className="settings-panel">
      <section aria-label="Region">
        <h3 className="settings-heading">Region</h3>
        <RegionSummary search={search} />
      </section>

      <section aria-label="Mapillary search">
        <h3 className="settings-heading">Mapillary search</h3>
        <SearchControls {...props} />
        <SearchResults search={search} />
      </section>

      <section aria-label="Provider and configuration status">
        <h3 className="settings-heading">Status</h3>
        <dl className="config-status">
          <div className="config-row">
            <dt>Mapillary viewer</dt>
            <dd>{MAPILLARY_CLIENT_TOKEN ? "Configured" : "Not configured"}</dd>
          </div>
          <div className="config-row">
            <dt>Mapillary search</dt>
            <dd>{searchStatusLabel}</dd>
          </div>
          <div className="config-row">
            <dt>Basemap</dt>
            <dd>{OSM_TILE_URL_IS_DEFAULT ? "OpenStreetMap default tiles" : "Custom tile URL"}</dd>
          </div>
          <div className="config-row">
            <dt>Database</dt>
            <dd>Pending — no connection in this milestone</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
