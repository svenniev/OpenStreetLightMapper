import { Fragment, useMemo, useState } from "react";
import {
  assessFinish,
  confirmChecks,
  resolvePlacement,
  summarizeProcessing,
} from "./inventoryReducer";
import {
  OBSERVATION_CATEGORY_LABELS,
  OBSERVATION_DECISION_LABELS,
  type InventoryAsset,
  type WorkflowSession,
} from "./inventoryTypes";
import { DemoDiagram } from "./DemoDiagram";
import type { InventorySessions } from "./useInventorySessions";

export interface InventoryStepProps {
  sessions: InventorySessions;
  session: WorkflowSession;
  stale: boolean;
  onOpenResults: () => void;
}

function supportText(asset: InventoryAsset): string {
  if (asset.category !== "luminaire") return "—";
  const support = asset.support;
  if (!support) return "No support chosen";
  if (support.kind === "pole") return `Pole ${support.poleAssetId}`;
  if (support.kind === "wall") return "Wall-mounted";
  if (support.kind === "suspended") return "Suspended";
  return "Support unknown";
}

function positionText(session: WorkflowSession, asset: InventoryAsset): string {
  const placement = asset.placement;
  if (placement.kind === "geographic") {
    return `Manual ${placement.lat.toFixed(5)}, ${placement.lng.toFixed(5)}`;
  }
  if (placement.kind === "diagram") {
    return `Diagram ${placement.x.toFixed(1)}, ${placement.y.toFixed(1)}`;
  }
  if (placement.kind === "inherited") {
    const resolved = resolvePlacement(asset, session.assets);
    return resolved.kind === "unknown"
      ? "Inherited — support unplaced"
      : `Inherited from ${asset.support?.kind === "pole" ? asset.support.poleAssetId : "support"}`;
  }
  return "Unknown";
}

export function InventoryStep(props: InventoryStepProps) {
  const { session, sessions, stale } = props;
  const [categoryFilter, setCategoryFilter] = useState<"all" | "pole" | "luminaire">("all");
  const [confirmedFilter, setConfirmedFilter] = useState<"all" | "confirmed" | "unconfirmed">("all");
  const [placedFilter, setPlacedFilter] = useState<"all" | "placed" | "unplaced">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ackUnresolved, setAckUnresolved] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [ackIncomplete, setAckIncomplete] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const assets = useMemo(
    () => session.assetOrder.map((id) => session.assets[id]).filter(Boolean),
    [session.assetOrder, session.assets],
  );
  const assessment = useMemo(() => assessFinish(session), [session]);
  const finished = session.finishedPreview;

  const visible = assets.filter((asset) => {
    if (categoryFilter !== "all" && asset.category !== categoryFilter) return false;
    if (confirmedFilter === "confirmed" && !asset.confirmed) return false;
    if (confirmedFilter === "unconfirmed" && asset.confirmed) return false;
    const placed = resolvePlacement(asset, session.assets).kind !== "unknown";
    if (placedFilter === "placed" && !placed) return false;
    if (placedFilter === "unplaced" && placed) return false;
    return true;
  });

  const counts = useMemo(() => {
    let poles = 0;
    let luminaires = 0;
    for (const asset of assets) {
      if (asset.observationIds.length === 0) continue;
      if (asset.category === "pole") poles += 1;
      else luminaires += 1;
    }
    return { poles, luminaires };
  }, [assets]);

  const pins = useMemo(
    () =>
      session.mode === "demo"
        ? assets.flatMap((asset) => {
            const resolved = resolvePlacement(asset, session.assets);
            if (resolved.kind !== "diagram") return [];
            return [
              {
                assetId: asset.id,
                category: asset.category,
                x: resolved.x,
                y: resolved.y,
                selected:
                  sessions.highlight?.sessionKey === session.key &&
                  sessions.highlight.assetId === asset.id,
              },
            ];
          })
        : [],
    [assets, session.assets, session.key, session.mode, sessions.highlight],
  );

  const finish = () => {
    const outcome = sessions.finishPreview(ackUnresolved, confirmEmpty, ackIncomplete);
    if (!outcome.finished) {
      setFinishError(outcome.blockers.join(" "));
      return;
    }
    setFinishError(null);
    setAckUnresolved(false);
    setConfirmEmpty(false);
    setAckIncomplete(false);
  };

  const processing = summarizeProcessing(session);
  const samEvidence = Object.values(session.observations).some(
    (observation) => observation.origin === "sam-text" || observation.origin === "sam-assisted",
  );

  return (
    <div className="inventory-step">
      {finished ? (
        <p className="search-status" role="status">
          <strong>Inventory reviewed — session only.</strong> Finished preview from{" "}
          {finished.finishedAt}. Later edits reopen review and invalidate this snapshot until
          finished again.
        </p>
      ) : (
        <p className="search-status" role="status">
          Draft preview — live below. Finish to freeze a session result.
        </p>
      )}
      {session.context.streetSource === "manual-work-area" && (
        <p className="search-status error-text" role="note">
          Street unverified: a manual imagery work area, not an OpenStreetMap street. Do not use
          these assignments as street inventory.
        </p>
      )}

      <p className="search-status" role="status">
        {counts.poles} pole{counts.poles === 1 ? "" : "s"} · {counts.luminaires} luminaire
        {counts.luminaires === 1 ? "" : "s"} (counted separately)
      </p>
      {samEvidence && (
        <p className="search-hint">
          Origins include SAM text-prompt sightings — each was manually accepted and grouped here.
        </p>
      )}
      {processing.views > 0 && (
        <p className="search-hint">
          Processing: {processing.succeededViews} of {processing.views} views produced results
          {processing.failedViews > 0 ? ` · ${processing.failedViews} failed` : ""}
          {processing.unprocessedViews > 0 ? ` · ${processing.unprocessedViews} unprocessed` : ""}
          {processing.concepts.length > 0 ? ` · concepts: ${processing.concepts.join("; ")}` : ""}.
        </p>
      )}

      <div className="inventory-columns">
        <div className="inventory-table-pane">
          <div className="review-filters" role="group" aria-label="Asset filters">
            <label className="inventory-label">
              Category
              <select
                className="inventory-select"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value as "all" | "pole" | "luminaire")}
              >
                <option value="all">All</option>
                <option value="pole">Pole/support</option>
                <option value="luminaire">Luminaire</option>
              </select>
            </label>
            <label className="inventory-label">
              Review
              <select
                className="inventory-select"
                value={confirmedFilter}
                onChange={(event) => setConfirmedFilter(event.target.value as "all" | "confirmed" | "unconfirmed")}
              >
                <option value="all">All</option>
                <option value="confirmed">Confirmed</option>
                <option value="unconfirmed">Unconfirmed</option>
              </select>
            </label>
            <label className="inventory-label">
              Position
              <select
                className="inventory-select"
                value={placedFilter}
                onChange={(event) => setPlacedFilter(event.target.value as "all" | "placed" | "unplaced")}
              >
                <option value="all">All</option>
                <option value="placed">Placed</option>
                <option value="unplaced">Unplaced</option>
              </select>
            </label>
          </div>

          {assets.length === 0 && (
            <p className="search-status" role="status">
              No assets yet. Group accepted observations first, or finish an explicitly
              reviewed empty set below.
            </p>
          )}
          {assets.length > 0 && visible.length === 0 && (
            <p className="search-status" role="status">
              No assets match these filters.
            </p>
          )}
          {visible.length > 0 && (
            <div className="result-table-wrap">
              <table className="result-table">
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Category</th>
                    <th scope="col">Support</th>
                    <th scope="col">Position</th>
                    <th scope="col">Evidence</th>
                    <th scope="col">Review</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((asset) => {
                    const imageIds = new Set<string>();
                    for (const obsId of asset.observationIds) {
                      const imageId = session.observations[obsId]?.imageId;
                      if (imageId) imageIds.add(imageId);
                    }
                    const checks = confirmChecks(asset, session);
                    const highlighted =
                      sessions.highlight?.sessionKey === session.key &&
                      sessions.highlight.assetId === asset.id;
                    return (
                      <Fragment key={asset.id}>
                        <tr className={highlighted ? "result-row--highlight" : undefined}>
                          <td>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() =>
                                sessions.setHighlight(
                                  highlighted ? null : { sessionKey: session.key, assetId: asset.id },
                                )
                              }
                            >
                              {asset.id}
                            </button>
                          </td>
                          <td>{asset.category === "pole" ? "Pole/support" : "Luminaire"}</td>
                          <td>{supportText(asset)}</td>
                          <td>{positionText(session, asset)}</td>
                          <td>
                            {asset.observationIds.length} obs · {imageIds.size} images
                          </td>
                          <td>{asset.confirmed ? "Confirmed" : "Unconfirmed"}</td>
                          <td>
                            <div className="inventory-actions">
                              <button
                                type="button"
                                className="toolbar-button toolbar-button--small"
                                aria-expanded={expandedId === asset.id}
                                onClick={() =>
                                  setExpandedId((current) => (current === asset.id ? null : asset.id))
                                }
                              >
                                {expandedId === asset.id ? "Hide evidence" : "View evidence"}
                              </button>
                              <button
                                type="button"
                                className="toolbar-button toolbar-button--small"
                                disabled={stale}
                                onClick={() => sessions.dispatch({ type: "SET_STEP", step: "group" })}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="toolbar-button toolbar-button--small"
                                disabled={stale || asset.confirmed || !checks.ok}
                                title={checks.ok ? undefined : checks.reasons.join(" ")}
                                onClick={() => sessions.dispatch({ type: "ASSET_CONFIRM", assetId: asset.id })}
                              >
                                Confirm asset
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expandedId === asset.id && (
                          <tr>
                            <td colSpan={7}>
                              <ul className="result-measurements">
                                {asset.observationIds.map((obsId) => {
                                  const observation = session.observations[obsId];
                                  if (!observation) return <li key={obsId}>{obsId}: missing</li>;
                                  return (
                                    <li key={obsId}>
                                      {obsId} · {observation.imageId} ·{" "}
                                      {OBSERVATION_CATEGORY_LABELS[observation.category]} ·{" "}
                                      {OBSERVATION_DECISION_LABELS[observation.decision]} ·{" "}
                                      {observation.description}
                                    </li>
                                  );
                                })}
                              </ul>
                              <p className="search-counts">
                                Mounting height, power, spacing: unknown / not assessed.
                              </p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {session.mode === "demo" && (
          <div className="inventory-map-pane">
            <DemoDiagram
              pins={pins}
              draft={null}
              interactive={false}
              selectedAssetId={sessions.highlight?.assetId ?? null}
              onSelectPin={(assetId) =>
                sessions.setHighlight({ sessionKey: session.key, assetId })
              }
              onDiagramClick={() => {}}
            />
          </div>
        )}
      </div>

      <div className="finish-block">
        <h3 className="settings-heading">Finish preview</h3>
        {assessment.unassigned.length > 0 && (
          <p className="search-status" role="status">
            Unassigned accepted observations: {assessment.unassigned.join(", ")}.
          </p>
        )}
        {assessment.emptyAssetCount > 0 && (
          <p className="search-status" role="status">
            {assessment.emptyAssetCount} empty asset{assessment.emptyAssetCount === 1 ? "" : "s"}{" "}
            excluded from the preview until repaired or removed.
          </p>
        )}
        {(assessment.deferredCount > 0 || assessment.unknownPositionCount > 0) && (
          <label className="group-check">
            <input
              type="checkbox"
              checked={ackUnresolved}
              disabled={stale}
              onChange={(event) => setAckUnresolved(event.target.checked)}
            />
            <span className="search-status">
              I acknowledge {assessment.deferredCount} deferred observation
              {assessment.deferredCount === 1 ? "" : "s"} and {assessment.unknownPositionCount}{" "}
              unknown position{assessment.unknownPositionCount === 1 ? "" : "s"}.
            </span>
          </label>
        )}
        {assessment.needsEmptyConfirm && (
          <label className="group-check">
            <input
              type="checkbox"
              checked={confirmEmpty}
              disabled={stale}
              onChange={(event) => setConfirmEmpty(event.target.checked)}
            />
            <span className="search-status">
              I reviewed the empty set: no assets recorded in this preview.
            </span>
          </label>
        )}
        {assessment.needsIncompleteAck && (
          <label className="group-check">
            <input
              type="checkbox"
              checked={ackIncomplete}
              disabled={stale}
              onChange={(event) => setAckIncomplete(event.target.checked)}
            />
            <span className="search-status">
              I acknowledge incomplete image processing: {assessment.incompleteItemCount}{" "}
              detection call{assessment.incompleteItemCount === 1 ? " did" : "s did"} not produce a
              result.
            </span>
          </label>
        )}
        <div className="inventory-actions">
          <button
            type="button"
            className="toolbar-button toolbar-button--primary"
            disabled={stale || !assessment.ok}
            title={stale ? "Stale sessions cannot finish — restart the preview." : assessment.blockers.join(" ") || undefined}
            onClick={finish}
          >
            Finish preview
          </button>
          {finished && (
            <button type="button" className="toolbar-button" onClick={props.onOpenResults}>
              {session.mode === "demo" ? "Open demo results preview" : "Open results preview"}
            </button>
          )}
        </div>
        {finishError && (
          <p className="search-status error-text" role="alert">
            {finishError}
          </p>
        )}
        {assessment.blockers.length > 0 && (
          <ul className="warning-list" role="status">
            {assessment.blockers.map((blocker, index) => (
              <li key={index}>{blocker}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
