import { useMemo, useState } from "react";
import { DEMO_IMAGES } from "./demoFixtures";
import { DemoScene, isDemoImageId } from "./demoScenes";
import { EvidenceThumb } from "./EvidenceThumb";
import { mapViewRectToFull } from "./imageViews";
import {
  assetOf,
  mergePreview,
  validateAssetMembers,
  validateMerge,
  validateSplit,
} from "./inventoryReducer";
import {
  OBSERVATION_CATEGORY_LABELS,
  OBSERVATION_ORIGIN_LABELS,
  type AssetPlacement,
  type InventoryAsset,
  type InventoryObservation,
  type SupportLink,
  type WorkflowSession,
} from "./inventoryTypes";
import type { InventorySessions } from "./useInventorySessions";
import type { ViewMedia } from "./useViewMedia";

export interface GroupStepProps {
  sessions: InventorySessions;
  session: WorkflowSession;
  stale: boolean;
  viewMedia: ViewMedia;
}

function Thumb({
  observation,
  session,
  viewMedia,
}: {
  observation: InventoryObservation;
  session: WorkflowSession;
  viewMedia: ViewMedia;
}) {
  if (isDemoImageId(observation.imageId)) {
    const meta = DEMO_IMAGES.find((image) => image.id === observation.imageId);
    return (
      <span className="group-thumb">
        <DemoScene sceneId={observation.imageId} label={meta?.label ?? observation.id} />
      </span>
    );
  }
  const view = observation.viewId ? session.views[observation.viewId] : undefined;
  const rect =
    observation.imageRegion && view
      ? mapViewRectToFull(observation.imageRegion, view)
      : observation.imageRegion;
  return (
    <EvidenceThumb
      imageId={observation.imageId}
      viewMedia={viewMedia}
      rect={rect}
      label={`${observation.id} on ${observation.imageId}`}
    />
  );
}

function placementSummary(asset: InventoryAsset): string {
  const placement = asset.placement;
  if (placement.kind === "geographic") return `Manual ${placement.lat.toFixed(4)}, ${placement.lng.toFixed(4)}`;
  if (placement.kind === "diagram") return `Diagram ${placement.x.toFixed(0)}, ${placement.y.toFixed(0)}`;
  if (placement.kind === "inherited") return "Inherited from support";
  return placement.explicit ? "Position unknown (chosen)" : "Unplaced";
}

function supportSummary(asset: InventoryAsset): string {
  if (asset.category !== "luminaire") return "—";
  const support = asset.support;
  if (!support) return "No support chosen";
  if (support.kind === "pole") return `Pole ${support.poleAssetId}`;
  if (support.kind === "wall") return "Wall-mounted";
  if (support.kind === "suspended") return "Suspended";
  return "Support unknown";
}

export function GroupStep(props: GroupStepProps) {
  const { session, sessions, stale } = props;
  const [selectedObs, setSelectedObs] = useState<string[]>([]);
  const [mergePick, setMergePick] = useState<string[]>([]);
  const [addTarget, setAddTarget] = useState("");
  const [splitting, setSplitting] = useState<string | null>(null);
  const [splitPick, setSplitPick] = useState<string[]>([]);
  const [mergeDraft, setMergeDraft] = useState<{
    retainedId: string;
    removedId: string;
    position: AssetPlacement;
    support: SupportLink | null;
  } | null>(null);
  const [attachPick, setAttachPick] = useState<Record<string, string>>({});

  const accepted = useMemo(
    () =>
      session.obsOrder
        .map((id) => session.observations[id])
        .filter((o) => o && o.decision === "accepted"),
    [session.obsOrder, session.observations],
  );
  const assets = useMemo(
    () => session.assetOrder.map((id) => session.assets[id]).filter(Boolean),
    [session.assetOrder, session.assets],
  );

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];

  const createValidation =
    selectedObs.length > 0 ? validateAssetMembers(selectedObs, session) : null;

  const startMerge = () => {
    if (mergePick.length !== 2) return;
    const [first, second] = mergePick;
    const a = session.assets[first];
    const b = session.assets[second];
    if (!a || !b || validateMerge(a, b).ok === false) return;
    setMergeDraft({ retainedId: a.id, removedId: b.id, position: a.placement, support: a.support });
  };

  const mergeAssets =
    mergeDraft !== null
      ? {
          retained: session.assets[mergeDraft.retainedId],
          removed: session.assets[mergeDraft.removedId],
        }
      : null;
  const preview =
    mergeAssets?.retained && mergeAssets?.removed
      ? mergePreview(mergeAssets.retained, mergeAssets.removed)
      : null;

  return (
    <div className="group-step">
      {accepted.length === 0 && (
        <p className="search-status" role="status">
          Accept observations in Review first — grouping needs accepted Pole/support or
          Luminaire sightings.
        </p>
      )}

      <div className="group-columns">
        <div className="group-observations">
          <h3 className="settings-heading">Accepted observations</h3>
          {accepted.length === 0 && <p className="search-hint">None yet.</p>}
          <ol className="group-obs-list">
            {accepted.map((observation) => {
              const holder = assetOf(observation.id, session.assets);
              return (
                <li key={observation.id}>
                  <label className="group-check">
                    <input
                      type="checkbox"
                      checked={selectedObs.includes(observation.id)}
                      disabled={stale}
                      onChange={() => setSelectedObs((prev) => toggle(prev, observation.id))}
                    />
                    <span className="sequence-id">{observation.id}</span>
                    <span className="search-counts">
                      {OBSERVATION_CATEGORY_LABELS[observation.category]} · {observation.imageId} ·{" "}
                      {OBSERVATION_ORIGIN_LABELS[observation.origin]}
                      {holder ? ` · in ${holder.id}` : " · unassigned"}
                    </span>
                  </label>
                </li>
              );
            })}
          </ol>

          {selectedObs.length > 0 && (
            <div className="group-compare">
              <h3 className="settings-heading">Comparison</h3>
              <div className="group-compare-cards">
                {selectedObs.map((id) => {
                  const observation = session.observations[id];
                  if (!observation) return null;
                  return (
                    <div key={id} className="group-compare-card">
                      <Thumb observation={observation} session={session} viewMedia={props.viewMedia} />
                      <p className="sequence-id">{observation.id}</p>
                      <p className="search-counts">
                        {OBSERVATION_CATEGORY_LABELS[observation.category]} · {observation.imageId} ·{" "}
                        {OBSERVATION_ORIGIN_LABELS[observation.origin]}
                      </p>
                      <p className="search-counts">{observation.description}</p>
                      {observation.provenance && (
                        <p className="search-counts">
                          {observation.provenance.model} · “{observation.provenance.prompt}”
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {createValidation && !createValidation.ok && (
                <p className="search-hint" role="status">
                  {createValidation.reason}
                </p>
              )}
              <div className="inventory-actions">
                <button
                  type="button"
                  className="toolbar-button toolbar-button--small"
                  disabled={stale || !createValidation || !createValidation.ok}
                  onClick={() => {
                    sessions.dispatch({ type: "ASSET_CREATE", observationIds: selectedObs });
                    setSelectedObs([]);
                  }}
                >
                  Create asset from selection
                </button>
                {assets.length > 0 && (
                  <>
                    <select
                      className="inventory-select"
                      aria-label="Target asset"
                      value={addTarget}
                      disabled={stale}
                      onChange={(event) => setAddTarget(event.target.value)}
                    >
                      <option value="">Add to asset…</option>
                      {assets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.id} ({asset.category}, {asset.observationIds.length} obs)
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--small"
                      disabled={stale || !addTarget || !createValidation || !createValidation.ok}
                      title={
                        createValidation && !createValidation.ok ? createValidation.reason : undefined
                      }
                      onClick={() => {
                        if (!addTarget) return;
                        sessions.dispatch({
                          type: "ASSET_ADD_OBS",
                          assetId: addTarget,
                          observationIds: selectedObs,
                        });
                        setSelectedObs([]);
                      }}
                    >
                      Add selected observations
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="group-assets">
          <h3 className="settings-heading">Assets</h3>
          {assets.length === 0 && <p className="search-hint">No assets yet.</p>}
          <ol className="group-asset-list">
            {assets.map((asset) => (
              <li key={asset.id} className="group-asset-card">
                <div className="obs-card-head">
                  <label className="group-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${asset.id} for merging`}
                      checked={mergePick.includes(asset.id)}
                      disabled={stale}
                      onChange={() => {
                        setMergeDraft(null);
                        setMergePick((prev) => toggle(prev, asset.id).slice(-2));
                      }}
                    />
                    <span className="sequence-id">{asset.id}</span>
                  </label>
                  <span className="badge">
                    {asset.category === "pole" ? "Pole/support" : "Luminaire"}
                  </span>
                  {asset.confirmed && <span className="badge">Confirmed</span>}
                  {asset.observationIds.length === 0 && <span className="badge">Empty</span>}
                </div>
                <p className="search-counts">
                  Evidence: {asset.observationIds.length === 0 ? "none — repair or remove" : ""}
                </p>
                <ul className="group-evidence">
                  {asset.observationIds.map((obsId) => {
                    const observation = session.observations[obsId];
                    return (
                      <li key={obsId}>
                        <span className="sequence-id">{obsId}</span>{" "}
                        <span className="search-counts">
                          {observation
                            ? `${OBSERVATION_CATEGORY_LABELS[observation.category]} · ${observation.imageId} · ${OBSERVATION_ORIGIN_LABELS[observation.origin]}`
                            : "missing"}
                        </span>{" "}
                        <button
                          type="button"
                          className="link-button"
                          disabled={stale}
                          onClick={() =>
                            sessions.dispatch({ type: "ASSET_REMOVE_OBS", assetId: asset.id, observationId: obsId })
                          }
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="search-counts">
                  Support: {supportSummary(asset)} · {placementSummary(asset)}
                </p>
                {asset.category === "luminaire" && (
                  <div className="inventory-actions">
                    <select
                      className="inventory-select"
                      aria-label={`Support for ${asset.id}`}
                      value={attachPick[asset.id] ?? ""}
                      disabled={stale}
                      onChange={(event) =>
                        setAttachPick((prev) => ({ ...prev, [asset.id]: event.target.value }))
                      }
                    >
                      <option value="">Attach support…</option>
                      {assets
                        .filter((candidate) => candidate.category === "pole" && candidate.observationIds.length > 0)
                        .map((candidate) => (
                          <option key={candidate.id} value={`pole:${candidate.id}`}>
                            Pole {candidate.id}
                          </option>
                        ))}
                      <option value="wall">Wall-mounted</option>
                      <option value="suspended">Suspended</option>
                      <option value="unknown">Support unknown</option>
                    </select>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--small"
                      disabled={stale || !attachPick[asset.id]}
                      onClick={() => {
                        const pick = attachPick[asset.id];
                        if (!pick) return;
                        const support: SupportLink = pick.startsWith("pole:")
                          ? { kind: "pole", poleAssetId: pick.slice(5) }
                          : pick === "wall"
                            ? { kind: "wall" }
                            : pick === "suspended"
                              ? { kind: "suspended" }
                              : { kind: "unknown" };
                        sessions.dispatch({ type: "SUPPORT_ATTACH", luminaireId: asset.id, support });
                        setAttachPick((prev) => ({ ...prev, [asset.id]: "" }));
                      }}
                    >
                      Attach luminaire to support
                    </button>
                    {asset.support && (
                      <button
                        type="button"
                        className="toolbar-button toolbar-button--small"
                        disabled={stale}
                        onClick={() => sessions.dispatch({ type: "SUPPORT_DETACH", luminaireId: asset.id })}
                      >
                        Detach
                      </button>
                    )}
                  </div>
                )}
                <div className="inventory-actions">
                  {splitting === asset.id ? (
                    <span className="inventory-confirm">
                      Move to new asset:{" "}
                      {asset.observationIds.map((obsId) => (
                        <label key={obsId} className="group-check group-check--inline">
                          <input
                            type="checkbox"
                            checked={splitPick.includes(obsId)}
                            onChange={() => setSplitPick((prev) => toggle(prev, obsId))}
                          />
                          <span className="sequence-id">{obsId}</span>
                        </label>
                      ))}{" "}
                      <button
                        type="button"
                        className="toolbar-button toolbar-button--small"
                        disabled={stale || validateSplit(asset, splitPick).ok === false}
                        onClick={() => {
                          sessions.dispatch({ type: "ASSET_SPLIT", assetId: asset.id, movingIds: splitPick });
                          setSplitting(null);
                          setSplitPick([]);
                        }}
                      >
                        Split into new asset
                      </button>{" "}
                      <button
                        type="button"
                        className="toolbar-button toolbar-button--small"
                        onClick={() => {
                          setSplitting(null);
                          setSplitPick([]);
                        }}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--small"
                      disabled={stale || asset.observationIds.length < 2}
                      onClick={() => {
                        setSplitting(asset.id);
                        setSplitPick([]);
                      }}
                    >
                      Split…
                    </button>
                  )}
                  <button
                    type="button"
                    className="toolbar-button toolbar-button--small"
                    disabled={stale}
                    onClick={() => sessions.dispatch({ type: "ASSET_REMOVE", assetId: asset.id })}
                  >
                    Remove asset
                  </button>
                </div>
              </li>
            ))}
          </ol>

          {mergePick.length === 2 && !mergeDraft && (
            <div className="inventory-actions">
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                disabled={
                  stale ||
                  validateMerge(session.assets[mergePick[0]], session.assets[mergePick[1]]).ok === false
                }
                title={(() => {
                  const check = validateMerge(session.assets[mergePick[0]], session.assets[mergePick[1]]);
                  return check.ok === false ? check.reason : undefined;
                })()}
                onClick={startMerge}
              >
                Merge assets…
              </button>
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                onClick={() => setMergePick([])}
              >
                Clear merge selection
              </button>
            </div>
          )}
          {(() => {
            const check =
              mergePick.length === 2
                ? validateMerge(session.assets[mergePick[0]], session.assets[mergePick[1]])
                : null;
            return check && check.ok === false ? (
              <p className="search-hint" role="status">
                {check.reason}
              </p>
            ) : null;
          })()}

          {mergeDraft && mergeAssets?.retained && mergeAssets?.removed && preview && (
            <div className="merge-preview" role="group" aria-label="Merge preview">
              <h3 className="settings-heading">Merge preview</h3>
              <p className="search-status">
                {preview.retainedId} + {preview.removedId} → {preview.combinedCount} observations
                in {mergeDraft.retainedId}; {mergeDraft.removedId} is removed. One undoable
                operation.
              </p>
              <label className="inventory-label">
                Retained asset
                <select
                  className="inventory-select"
                  value={mergeDraft.retainedId}
                  onChange={(event) => {
                    const retainedId = event.target.value;
                    const removedId =
                      retainedId === mergeDraft.retainedId ? mergeDraft.removedId : mergeDraft.retainedId;
                    const retained = session.assets[retainedId];
                    setMergeDraft({
                      retainedId,
                      removedId,
                      position: retained.placement,
                      support: retained.support,
                    });
                  }}
                >
                  <option value={mergeDraft.retainedId}>{mergeDraft.retainedId}</option>
                  <option value={mergeDraft.removedId}>{mergeDraft.removedId}</option>
                </select>
              </label>
              {preview.positionsDiffer && (
                <div className="merge-conflict">
                  <p className="search-status">Positions differ — choose the retained value:</p>
                  <label className="group-check">
                    <input
                      type="radio"
                      name="merge-position"
                      checked={JSON.stringify(mergeDraft.position) === JSON.stringify(mergeAssets.retained.placement)}
                      onChange={() => setMergeDraft({ ...mergeDraft, position: mergeAssets.retained.placement })}
                    />
                    Keep {mergeDraft.retainedId}: {placementSummary(mergeAssets.retained)}
                  </label>
                  <label className="group-check">
                    <input
                      type="radio"
                      name="merge-position"
                      checked={JSON.stringify(mergeDraft.position) === JSON.stringify(mergeAssets.removed.placement)}
                      onChange={() => setMergeDraft({ ...mergeDraft, position: mergeAssets.removed.placement })}
                    />
                    Keep {mergeDraft.removedId}: {placementSummary(mergeAssets.removed)}
                  </label>
                  <label className="group-check">
                    <input
                      type="radio"
                      name="merge-position"
                      checked={mergeDraft.position.kind === "unknown"}
                      onChange={() => setMergeDraft({ ...mergeDraft, position: { kind: "unknown", explicit: false } })}
                    />
                    Clear position
                  </label>
                </div>
              )}
              {preview.supportsDiffer && (
                <div className="merge-conflict">
                  <p className="search-status">Support links differ — choose the retained link:</p>
                  <label className="group-check">
                    <input
                      type="radio"
                      name="merge-support"
                      checked={JSON.stringify(mergeDraft.support) === JSON.stringify(mergeAssets.retained.support)}
                      onChange={() => setMergeDraft({ ...mergeDraft, support: mergeAssets.retained.support })}
                    />
                    Keep {mergeDraft.retainedId}: {supportSummary(mergeAssets.retained)}
                  </label>
                  <label className="group-check">
                    <input
                      type="radio"
                      name="merge-support"
                      checked={JSON.stringify(mergeDraft.support) === JSON.stringify(mergeAssets.removed.support)}
                      onChange={() => setMergeDraft({ ...mergeDraft, support: mergeAssets.removed.support })}
                    />
                    Keep {mergeDraft.removedId}: {supportSummary(mergeAssets.removed)}
                  </label>
                  <label className="group-check">
                    <input
                      type="radio"
                      name="merge-support"
                      checked={mergeDraft.support === null}
                      onChange={() => setMergeDraft({ ...mergeDraft, support: null })}
                    />
                    Clear link
                  </label>
                </div>
              )}
              <div className="inventory-actions">
                <button
                  type="button"
                  className="toolbar-button toolbar-button--small"
                  disabled={stale}
                  onClick={() => {
                    sessions.dispatch({
                      type: "ASSET_MERGE",
                      retainedId: mergeDraft.retainedId,
                      removedId: mergeDraft.removedId,
                      position: mergeDraft.position,
                      support: mergeDraft.support,
                    });
                    setMergeDraft(null);
                    setMergePick([]);
                  }}
                >
                  Apply merge
                </button>
                <button
                  type="button"
                  className="toolbar-button toolbar-button--small"
                  onClick={() => {
                    setMergeDraft(null);
                    setMergePick([]);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
