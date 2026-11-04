import { useMemo, useState } from "react";
import { resolvePlacement, type InventoryAction } from "./inventoryReducer";
import type { WorkflowSession } from "./inventoryTypes";
import { DemoDiagram } from "./DemoDiagram";
import type { InventorySessions } from "./useInventorySessions";

export interface PlaceStepProps {
  sessions: InventorySessions;
  session: WorkflowSession;
  stale: boolean;
  onReturnToInventory: () => void;
  /** Scroll/focus the main map when a real placement is armed. */
  onGoToMap: () => void;
}

function placementText(session: WorkflowSession, assetId: string): string {
  const asset = session.assets[assetId];
  if (!asset) return "—";
  const placement = asset.placement;
  if (placement.kind === "geographic") {
    return `Manually placed — approximate: ${placement.lat.toFixed(5)}, ${placement.lng.toFixed(5)}`;
  }
  if (placement.kind === "diagram") {
    return `Manually placed — approximate: diagram ${placement.x.toFixed(1)}, ${placement.y.toFixed(1)}`;
  }
  if (placement.kind === "inherited") {
    const resolved = resolvePlacement(asset, session.assets);
    const supportId = asset.support?.kind === "pole" ? asset.support.poleAssetId : null;
    if (resolved.kind === "unknown" || !supportId) return "Location inherited from support — support unplaced";
    return `Location inherited from support (${supportId}) — display only, not a measured position`;
  }
  return placement.explicit ? "Position unknown (chosen)" : "Unplaced";
}

export function PlaceStep(props: PlaceStepProps) {
  const { session, sessions, stale } = props;
  const [selectedId, setSelectedId] = useState("");
  const [latInput, setLatInput] = useState("");
  const [lngInput, setLngInput] = useState("");
  const [xInput, setXInput] = useState("");
  const [yInput, setYInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const assets = useMemo(
    () => session.assetOrder.map((id) => session.assets[id]).filter(Boolean),
    [session.assetOrder, session.assets],
  );
  const effectiveId = selectedId || assets[0]?.id || "";
  const selected = effectiveId ? (session.assets[effectiveId] ?? null) : null;
  const draft = sessions.placement && sessions.placement.sessionKey === session.key ? sessions.placement : null;
  const demoMode = session.mode === "demo";

  const pins = useMemo(
    () =>
      demoMode
        ? assets.flatMap((asset) => {
            const resolved = resolvePlacement(asset, session.assets);
            if (resolved.kind !== "diagram") return [];
            return [
              {
                assetId: asset.id,
                category: asset.category,
                x: resolved.x,
                y: resolved.y,
                selected: asset.id === effectiveId,
              },
            ];
          })
        : [],
    [assets, demoMode, effectiveId, session.assets],
  );

  const placeUnknown = () => {
    if (!selected || stale) return;
    const action: InventoryAction = {
      type: "PLACE",
      assetId: selected.id,
      placement: { kind: "unknown", explicit: true },
    };
    sessions.dispatch(action);
  };

  const clearPosition = () => {
    if (!selected || stale) return;
    sessions.dispatch({
      type: "PLACE",
      assetId: selected.id,
      placement: { kind: "unknown", explicit: false },
    });
  };

  const useInherited = () => {
    if (!selected || stale) return;
    sessions.dispatch({ type: "PLACE", assetId: selected.id, placement: { kind: "inherited" } });
  };

  const applyDraft = () => {
    const message = sessions.applyPlacement();
    setError(message);
  };

  const applyCoordinates = () => {
    if (!selected) return;
    const message = demoMode
      ? sessions.placeFromCoordinates(selected.id, {
          diagram: { x: Number(xInput), y: Number(yInput) },
        })
      : sessions.placeFromCoordinates(selected.id, { geo: [Number(latInput), Number(lngInput)] });
    setError(message);
    if (!message) {
      setLatInput("");
      setLngInput("");
      setXInput("");
      setYInput("");
    }
  };

  return (
    <div className="place-step">
      {assets.length === 0 && (
        <p className="search-status" role="status">
          Create assets in Group assets first — placement needs something to place.
        </p>
      )}
      <div className="place-columns">
        <div className="place-list">
          <label className="inventory-label" htmlFor="place-asset-select">
            Asset
          </label>
          <select
            id="place-asset-select"
            className="inventory-select"
            value={effectiveId}
            disabled={assets.length === 0}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {assets.length === 0 && <option value="">No assets</option>}
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.id} ({asset.category}, {asset.observationIds.length} obs
                {asset.observationIds.length === 0 ? ", empty" : ""})
              </option>
            ))}
          </select>
          {selected && (
            <p className="search-status" role="status">
              {placementText(session, selected.id)}
            </p>
          )}
          {selected && selected.observationIds.length === 0 && (
            <p className="search-hint" role="status">
              Empty assets cannot be placed — repair or remove this asset in Group assets.
            </p>
          )}
          <div className="inventory-actions">
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={stale || !selected || selected.observationIds.length === 0}
              onClick={() => {
                if (!selected) return;
                sessions.armPlacement(selected.id);
                if (session.mode === "manual") props.onGoToMap();
              }}
            >
              Place on map
            </button>
            {selected?.category === "luminaire" && (
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                disabled={stale || !selected || selected.support?.kind !== "pole"}
                title={
                  selected?.support?.kind === "pole"
                    ? "Display at the linked support's location (not a measured position)."
                    : "Attach to a pole asset first."
                }
                onClick={useInherited}
              >
                Use support location
              </button>
            )}
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={stale || !selected}
              onClick={placeUnknown}
            >
              Position unknown
            </button>
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={stale || !selected}
              onClick={clearPosition}
            >
              Clear position
            </button>
          </div>
          {draft && (
            <div className="place-draft" role="status">
              <p className="search-status">
                Draft for {draft.assetId}:{" "}
                {draft.mode === "manual"
                  ? draft.geo
                    ? `${draft.geo[0].toFixed(5)}, ${draft.geo[1].toFixed(5)}`
                    : "click the map below, then apply"
                  : draft.diagram
                    ? `diagram ${draft.diagram.x.toFixed(1)}, ${draft.diagram.y.toFixed(1)}`
                    : "click the diagram, then apply"}
              </p>
              <div className="inventory-actions">
                <button type="button" className="toolbar-button toolbar-button--small" onClick={applyDraft}>
                  Apply placement
                </button>
                <button
                  type="button"
                  className="toolbar-button toolbar-button--small"
                  onClick={sessions.cancelPlacement}
                >
                  Cancel placement
                </button>
                <button
                  type="button"
                  className="toolbar-button toolbar-button--small"
                  onClick={props.onReturnToInventory}
                >
                  Return to inventory
                </button>
              </div>
            </div>
          )}
          <div className="place-coords">
            <h3 className="settings-heading">Keyboard entry</h3>
            {demoMode ? (
              <div className="place-coords-row">
                <label className="inventory-label">
                  X (0–100)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="inventory-input"
                    value={xInput}
                    disabled={stale || !selected}
                    onChange={(event) => setXInput(event.target.value)}
                  />
                </label>
                <label className="inventory-label">
                  Y (0–100)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="inventory-input"
                    value={yInput}
                    disabled={stale || !selected}
                    onChange={(event) => setYInput(event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <div className="place-coords-row">
                <label className="inventory-label">
                  Latitude
                  <input
                    type="text"
                    inputMode="decimal"
                    className="inventory-input"
                    value={latInput}
                    disabled={stale || !selected}
                    onChange={(event) => setLatInput(event.target.value)}
                  />
                </label>
                <label className="inventory-label">
                  Longitude
                  <input
                    type="text"
                    inputMode="decimal"
                    className="inventory-input"
                    value={lngInput}
                    disabled={stale || !selected}
                    onChange={(event) => setLngInput(event.target.value)}
                  />
                </label>
              </div>
            )}
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={stale || !selected}
              onClick={applyCoordinates}
            >
              Place from coordinates
            </button>
          </div>
          {error && (
            <p className="search-status error-text" role="alert">
              {error}
            </p>
          )}
          {!demoMode && (
            <p className="search-hint">
              Real placements stay inside the current region, boundary included. The street is
              the one you chose — nothing snaps to the nearest road, and camera positions are
              never used as asset positions.
            </p>
          )}
        </div>
        {demoMode && (
          <div className="place-map">
            <DemoDiagram
              pins={pins}
              draft={draft?.diagram ?? null}
              interactive={!stale && draft?.assetId === effectiveId && !!effectiveId}
              selectedAssetId={effectiveId}
              onSelectPin={(assetId) => setSelectedId(assetId)}
              onDiagramClick={(point) => {
                if (draft && draft.assetId === effectiveId) sessions.setPlacementDraft({ diagram: point });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
