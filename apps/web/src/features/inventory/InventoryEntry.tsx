import { useState } from "react";
import { STREET_SOURCE_LABELS, type StreetSource } from "./inventoryTypes";
import type { InventorySessions } from "./useInventorySessions";

export interface StreetOption {
  id: string;
  displayName: string;
  streetSource: Extract<StreetSource, "osm" | "manual-work-area">;
}

interface InventoryEntryProps {
  inventory: InventorySessions;
  streetOptions: StreetOption[];
  canOpen: boolean;
  disabledReason: string | null;
}

/**
 * Inventory workflow entry: the primary action opens the real workflow on
 * queried imagery. The synthetic demo lives in a collapsed developer section
 * so nobody mistakes illustrations for evidence.
 */
export function InventoryEntry(props: InventoryEntryProps) {
  const { inventory, streetOptions } = props;
  const [selectedId, setSelectedId] = useState("");
  const selected = streetOptions.find((option) => option.id === (selectedId || streetOptions[0]?.id));
  const isWorkArea = selected?.streetSource === "manual-work-area";

  return (
    <div className="inventory-entry">
      <h3 className="settings-heading">Inventory workflow</h3>
      {streetOptions.length === 0 ? (
        <p className="search-hint">Include a street to open its inventory workflow.</p>
      ) : (
        <>
          <label className="inventory-label">
            Street or work area
            <select
              className="inventory-select"
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {streetOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                  {option.streetSource === "manual-work-area" ? " (unverified work area)" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="search-hint">
            Street provenance:{" "}
            <strong>
              {selected ? STREET_SOURCE_LABELS[selected.streetSource] : STREET_SOURCE_LABELS.osm}
            </strong>
          </p>
          {isWorkArea && (
            <p className="search-status error-text" role="note">
              Street unverified — this work area is a camera path, not an OpenStreetMap street.
              Assignments here stay explicitly unverified.
            </p>
          )}
          <div className="inventory-actions">
            <button
              type="button"
              className="toolbar-button toolbar-button--primary"
              disabled={!props.canOpen || !selected}
              title={props.disabledReason ?? undefined}
              onClick={() => {
                if (selected) inventory.openStreet(selected.id, selected.displayName, selected.streetSource);
              }}
            >
              {isWorkArea ? "Continue with selected imagery — street unverified" : "Use queried images"}
            </button>
          </div>
          {props.disabledReason && <p className="search-hint">{props.disabledReason}</p>}
        </>
      )}
      <details className="inventory-demo-details">
        <summary>Developer examples — illustrations</summary>
        <p className="search-hint">
          A fully offline demo with schematic illustrations (no photographs, no Mapillary IDs, no
          AI). Demo positions are diagram coordinates, never geographic.
        </p>
        <div className="inventory-actions">
          <button type="button" className="toolbar-button" onClick={inventory.openDemo}>
            Try demo workflow
          </button>
        </div>
      </details>
    </div>
  );
}
