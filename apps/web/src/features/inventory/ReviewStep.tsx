import { useEffect, useMemo, useState } from "react";
import { mediaUrlFor, measureMedia } from "../../lib/detectionClient";
import { formatCapturedDate } from "../../lib/search";
import type { ImageResult } from "../../lib/searchTypes";
import { DEMO_IMAGES } from "./demoFixtures";
import { isDemoImageId } from "./demoScenes";
import { useObservedImage } from "./EvidenceThumb";
import { describeView } from "./imageViews";
import {
  assetOf,
  type InventoryAction,
} from "./inventoryReducer";
import {
  OBSERVATION_CATEGORY_LABELS,
  OBSERVATION_DECISION_LABELS,
  OBSERVATION_ORIGIN_LABELS,
  type InventoryObservation,
  type ObservationCategory,
  type ObservationDecision,
  type SourceView,
  type WorkflowSession,
} from "./inventoryTypes";
import { PhotoCanvas, type PhotoOverlay } from "./PhotoCanvas";
import { SceneCanvas, type OverlayRect } from "./SceneCanvas";
import type { InventorySessions } from "./useInventorySessions";
import type { ViewMedia } from "./useViewMedia";

export interface ReviewStepProps {
  sessions: InventorySessions;
  session: WorkflowSession;
  stale: boolean;
  poolImages: ImageResult[];
  onSelectImage: (id: string) => void;
  viewMedia: ViewMedia;
}

const DECISIONS: ObservationDecision[] = ["pending", "accepted", "rejected", "deferred"];
const CATEGORIES: ObservationCategory[] = ["pole", "luminaire", "uncertain"];

interface CardNotices {
  [obsId: string]: string | undefined;
}

function ObservationCard(props: {
  observation: InventoryObservation;
  session: WorkflowSession;
  sessions: InventorySessions;
  stale: boolean;
  selected: boolean;
  notice: string | undefined;
  onNotice: (obsId: string, text: string | undefined) => void;
  onJump: (obsId: string) => void;
  onViewImage: (imageId: string) => void;
  onDrawRequest: (obsId: string) => void;
}) {
  const { observation, session, sessions, stale } = props;
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState<ObservationCategory>(observation.category);
  const [description, setDescription] = useState(observation.description);
  const [note, setNote] = useState(observation.note);
  const holder = assetOf(observation.id, session.assets);
  const needsRect = session.mode === "demo" && !observation.imageRegion;

  const decide = (decision: ObservationDecision) => {
    if (holder && (decision === "rejected" || decision === "deferred")) {
      props.onNotice(
        observation.id,
        `Removed from ${holder.id}; the asset is unconfirmed and needs re-review.`,
      );
    } else {
      props.onNotice(observation.id, undefined);
    }
    sessions.dispatch({ type: "OBS_DECIDE", id: observation.id, decision });
  };

  return (
    <li className={`obs-card${props.selected ? " obs-card--selected" : ""}`}>
      <div className="obs-card-head">
        <span className="sequence-id">{observation.id}</span>
        <span className="badge">{OBSERVATION_ORIGIN_LABELS[observation.origin]}</span>
        <span className="badge">{OBSERVATION_DECISION_LABELS[observation.decision]}</span>
      </div>
      <p className="search-counts">
        {OBSERVATION_CATEGORY_LABELS[observation.category]} · {observation.description || "no description"}
      </p>
      {observation.provenance && (
        <p className="search-counts">
          {observation.provenance.model} · “{observation.provenance.prompt}” · #
          {observation.provenance.providerObjectId}
          {observation.provenance.confidence !== null &&
            ` · ${Math.round(observation.provenance.confidence * 100)}%`}
          {observation.provenance.geometrySource === "manual-adjusted" ? " · manually adjusted" : ""}
        </p>
      )}
      {observation.maskStale && (
        <p className="search-hint">Model mask hidden — the rectangle was moved by hand.</p>
      )}
      <p className="search-counts">
        Image {observation.imageId}{" "}
        {observation.viewId && session.views[observation.viewId]
          ? `· ${describeView(session.views[observation.viewId])} `
          : ""}
        <button type="button" className="link-button" onClick={() => props.onJump(observation.id)}>
          View
        </button>
        {!isDemoImageId(observation.imageId) && (
          <>
            {" · "}
            <button
              type="button"
              className="link-button"
              onClick={() => props.onViewImage(observation.imageId)}
            >
              Open in viewer
            </button>
          </>
        )}
        {holder && <span> · in {holder.id}</span>}
      </p>
      {observation.note && <p className="search-counts">Note: {observation.note}</p>}
      {props.notice && (
        <p className="search-status" role="status">
          {props.notice}
        </p>
      )}
      {editing ? (
        <div className="obs-edit">
          <label className="inventory-label">
            Category
            <select
              className="inventory-select"
              value={category}
              disabled={stale || !!holder}
              title={holder ? "Detach from the asset before changing category." : undefined}
              onChange={(event) => setCategory(event.target.value as ObservationCategory)}
            >
              {CATEGORIES.map((entry) => (
                <option key={entry} value={entry}>
                  {OBSERVATION_CATEGORY_LABELS[entry]}
                </option>
              ))}
            </select>
          </label>
          <label className="inventory-label">
            Description
            <input
              type="text"
              className="inventory-input"
              value={description}
              disabled={stale}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="inventory-label">
            Note (optional)
            <input
              type="text"
              className="inventory-input"
              value={note}
              disabled={stale}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="inventory-actions">
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={stale}
              onClick={() => {
                const action: InventoryAction = {
                  type: "OBS_EDIT",
                  id: observation.id,
                  category,
                  description: description.trim(),
                  note,
                };
                sessions.dispatch(action);
                setEditing(false);
              }}
            >
              Apply
            </button>
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              onClick={() => {
                setCategory(observation.category);
                setDescription(observation.description);
                setNote(observation.note);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="inventory-actions">
          {DECISIONS.filter((decision) => decision !== observation.decision).map((decision) => (
            <button
              key={decision}
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={stale || (decision === "accepted" && needsRect)}
              title={
                decision === "accepted" && needsRect
                  ? "Draw a rectangle on the illustration first (required for demo scenes)."
                  : decision === "pending"
                    ? "Return to pending"
                    : undefined
              }
              onClick={() => decide(decision)}
            >
              {decision === "pending"
                ? "Return to pending"
                : decision === "accepted"
                  ? "Accept"
                  : decision === "rejected"
                    ? "Reject"
                    : "Defer"}
            </button>
          ))}
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={stale}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={stale}
            onClick={() => props.onDrawRequest(observation.id)}
          >
            {observation.imageRegion ? "Redraw rectangle" : "Draw rectangle"}
          </button>
          {observation.imageRegion && (
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              disabled={stale}
              onClick={() => sessions.dispatch({ type: "OBS_SET_RECT", id: observation.id, rect: null })}
            >
              Remove rectangle
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PhotoPanel(props: {
  session: WorkflowSession;
  sessions: InventorySessions;
  stale: boolean;
  imageId: string;
  viewMedia: ViewMedia;
  selectedObsId: string | null;
  drawArmed: boolean;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onSelectObs: (obsId: string) => void;
  onDisarm: () => void;
  onViewImage: (imageId: string) => void;
}) {
  const { session, sessions, stale, imageId, viewMedia } = props;
  const [viewOverride, setViewOverride] = useState<string | null>(null);
  const [displayDims, setDisplayDims] = useState<{ width: number; height: number } | null>(null);
  const observed = useObservedImage(imageId, viewMedia);
  const onImage = useMemo(
    () => session.obsOrder.map((id) => session.observations[id]).filter((o) => o && o.imageId === imageId),
    [session.obsOrder, session.observations, imageId],
  );
  const imageViews = useMemo(
    () => session.viewOrder.map((viewId) => session.views[viewId]).filter((v) => v && v.imageId === imageId),
    [session.viewOrder, session.views, imageId],
  );
  const selectedViewId =
    session.observations[props.selectedObsId ?? ""]?.viewId ?? onImage.find((o) => o.viewId)?.viewId ?? null;

  useEffect(() => {
    setViewOverride(null);
    setDisplayDims(null);
  }, [imageId]);

  useEffect(() => {
    if (imageViews.length > 0 || observed.status !== "ready") return;
    let cancelled = false;
    measureMedia(mediaUrlFor(observed.detail.media.handle))
      .then((dims) => {
        if (!cancelled) setDisplayDims({ width: dims.width, height: dims.height });
      })
      .catch(() => {
        if (!cancelled) setDisplayDims(null);
      });
    return () => {
      cancelled = true;
    };
  }, [imageId, imageViews.length, observed]);

  const view: SourceView | null =
    (viewOverride ? session.views[viewOverride] : undefined) ??
    (selectedViewId ? session.views[selectedViewId] : undefined) ??
    imageViews.find((entry) => !entry.crop) ??
    imageViews[0] ??
    (displayDims
      ? {
          viewId: `display-${imageId}`,
          imageId,
          fullWidth: displayDims.width,
          fullHeight: displayDims.height,
          orientation: 1,
          isPano: session.sources[imageId]?.isPano ?? false,
          crop: null,
          width: displayDims.width,
          height: displayDims.height,
          mediaHandle: "",
          fullyReviewed: false,
        }
      : null);
  const isDisplayView = view !== null && view.viewId.startsWith("display-");
  const overlays: PhotoOverlay[] = view
    ? onImage
        .filter((observation) =>
          isDisplayView ? observation.viewId === null : observation.viewId === view.viewId,
        )
        .map((observation) => ({
          obsId: observation.id,
          label: observation.id,
          rect: observation.imageRegion ? { ...observation.imageRegion } : null,
          mask: observation.mask,
          maskStale: observation.maskStale,
          selected: observation.id === props.selectedObsId,
          decision: observation.decision,
        }))
    : [];
  const selectedObs = props.selectedObsId ? (session.observations[props.selectedObsId] ?? null) : null;
  const source = session.sources[imageId];

  return (
    <figure className="review-figure">
      {imageViews.length > 1 && (
        <div className="detect-filters">
          <label className="inventory-label">
            View
            <select
              className="inventory-select"
              value={view?.viewId ?? ""}
              onChange={(event) => setViewOverride(event.target.value)}
            >
              {imageViews.map((entry) => (
                <option key={entry.viewId} value={entry.viewId}>
                  {describeView(entry)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {observed.status === "ready" && view ? (
        <PhotoCanvas
          mediaUrl={mediaUrlFor(observed.detail.media.handle)}
          alt={`Mapillary photograph ${imageId}`}
          view={view}
          overlays={overlays}
          interactive={!stale}
          drawArmed={props.drawArmed && selectedObs !== null && selectedObs.imageId === imageId}
          zoom={props.zoom}
          onZoomChange={props.onZoomChange}
          onSelectRect={props.onSelectObs}
          onDrawRect={(rect) => {
            if (selectedObs && selectedObs.imageId === imageId) {
              sessions.dispatch({ type: "OBS_SET_RECT", id: selectedObs.id, rect });
            }
          }}
          onMoveRect={(obsId, rect) => {
            sessions.dispatch({ type: "OBS_SET_RECT", id: obsId, rect });
          }}
          onDisarm={props.onDisarm}
          onMediaError={() => viewMedia.refreshImage(imageId).catch(() => undefined)}
        />
      ) : observed.status === "failed" ? (
        <p className="search-status error-text" role="alert">
          The photograph failed to load: {observed.error}{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => viewMedia.refreshImage(imageId).catch(() => undefined)}
          >
            Retry
          </button>
        </p>
      ) : (
        <p className="search-hint">Loading photograph…</p>
      )}
      <figcaption className="search-hint">
        {imageId} · {observed.status === "ready" ? observed.detail.image.attribution : "…"}{" "}
        {view ? `· ${view.width}×${view.height}${view.isPano ? " · panorama (flat view may distort objects)" : ""}` : ""}
        {source ? ` · ${source.resolution}` : ""}
        {isDisplayView ? " · reference only (not an inference view)" : " · inference view"}
        {selectedObs && !selectedObs.imageRegion ? " Selected observation has no rectangle yet." : ""}{" "}
        <a href={observed.status === "ready" ? observed.detail.image.sourceUrl : undefined} target="_blank" rel="noreferrer">
          Source
        </a>{" "}
        ·{" "}
        <button type="button" className="link-button" onClick={() => props.onViewImage(imageId)}>
          Open in viewer
        </button>
      </figcaption>
    </figure>
  );
}

export function ReviewStep(props: ReviewStepProps) {
  const { session, sessions, stale } = props;
  const [selectedObsId, setSelectedObsId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [decisionFilter, setDecisionFilter] = useState<ObservationDecision | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<ObservationCategory | "all">("all");
  const [drawArmed, setDrawArmed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [notices, setNotices] = useState<CardNotices>({});
  const [addImageId, setAddImageId] = useState("");
  const [addCategory, setAddCategory] = useState<ObservationCategory>("pole");
  const [addDescription, setAddDescription] = useState("");

  const observations = useMemo(
    () => session.obsOrder.map((id) => session.observations[id]).filter(Boolean),
    [session.obsOrder, session.observations],
  );
  const demoMode = session.mode === "demo";
  const manifestImageIds = session.manifest?.imageIds ?? [];
  const imageOptions = useMemo(
    () =>
      demoMode
        ? DEMO_IMAGES.map((image) => ({ id: image.id, label: `${image.label} · ${image.id}` }))
        : props.poolImages.map((image) => ({
            id: image.id,
            label: manifestImageIds.includes(image.id)
              ? `${image.id} · chosen source · ${formatCapturedDate(image.capturedAt)}`
              : `${image.id} · ${formatCapturedDate(image.capturedAt)}`,
          })),
    [demoMode, props.poolImages, manifestImageIds],
  );
  const effectiveImageId =
    selectedImageId ?? observations[0]?.imageId ?? imageOptions[0]?.id ?? null;
  const visible = observations.filter(
    (observation) =>
      (decisionFilter === "all" || observation.decision === decisionFilter) &&
      (categoryFilter === "all" || observation.category === categoryFilter),
  );

  const selectedObs = selectedObsId ? (session.observations[selectedObsId] ?? null) : null;

  const jumpTo = (obsId: string) => {
    const observation = session.observations[obsId];
    if (!observation) return;
    setSelectedObsId(obsId);
    setSelectedImageId(observation.imageId);
  };

  const viewInViewer = (imageId: string) => {
    if (isDemoImageId(imageId)) return; // demo IDs must never reach Mapillary
    props.onSelectImage(imageId);
  };

  const overlays: OverlayRect[] = observations
    .filter((observation) => observation.imageId === effectiveImageId && observation.imageRegion)
    .map((observation) => ({
      obsId: observation.id,
      label: observation.id,
      rect: observation.imageRegion!,
      selected: observation.id === selectedObsId,
      decision: observation.decision,
    }));

  const addObservation = () => {
    const imageId = addImageId || effectiveImageId;
    const description = addDescription.trim();
    if (!imageId || !description || stale) return;
    const id = `obs-${session.obsCounter + 1}`;
    // Manual additions on a chosen image join its full view; other pool
    // images stay reference-only until chosen in Detect.
    const fullView = session.viewOrder
      .map((viewId) => session.views[viewId])
      .find((view) => view && view.imageId === imageId && !view.crop);
    sessions.dispatch({
      type: "OBS_ADD",
      observation: {
        id,
        imageId,
        viewId: fullView?.viewId ?? null,
        category: addCategory,
        description,
        imageRegion: null,
        mask: null,
        maskStale: false,
        origin: "manual",
        provenance: null,
        mode: session.mode,
        decision: "pending",
        note: "",
      },
    });
    setAddDescription("");
    setSelectedObsId(id);
    setSelectedImageId(imageId);
  };

  return (
    <div className="review-step">
      <div className="review-main">
        {effectiveImageId && demoMode && (
          <figure className="review-figure">
            <SceneCanvas
              sceneId={effectiveImageId}
              label={DEMO_IMAGES.find((image) => image.id === effectiveImageId)?.label ?? effectiveImageId}
              rects={overlays}
              interactive={!stale}
              drawArmed={drawArmed && selectedObs !== null}
              onSelectRect={(obsId) => setSelectedObsId(obsId)}
              onDrawRect={(rect) => {
                if (selectedObs) {
                  sessions.dispatch({ type: "OBS_SET_RECT", id: selectedObs.id, rect });
                }
              }}
              onMoveRect={(obsId, rect) => {
                sessions.dispatch({ type: "OBS_SET_RECT", id: obsId, rect });
              }}
              onDisarm={() => setDrawArmed(false)}
            />
            <figcaption className="search-hint">
              {effectiveImageId} — schematic illustration, not a photograph. Rectangles use
              normalized illustration coordinates.
              {selectedObs && !selectedObs.imageRegion && " Selected observation has no rectangle yet."}
            </figcaption>
          </figure>
        )}
        {effectiveImageId && !demoMode && (
          <PhotoPanel
            key={effectiveImageId}
            session={session}
            sessions={sessions}
            stale={stale}
            imageId={effectiveImageId}
            viewMedia={props.viewMedia}
            selectedObsId={selectedObsId}
            drawArmed={drawArmed}
            zoom={zoom}
            onZoomChange={setZoom}
            onSelectObs={(obsId) => setSelectedObsId(obsId)}
            onDisarm={() => setDrawArmed(false)}
            onViewImage={viewInViewer}
          />
        )}
        {!effectiveImageId && (
          <p className="search-status" role="status">
            No source images available.
          </p>
        )}
        {demoMode && (
          <div className="inventory-actions" role="group" aria-label="Demo images">
            {DEMO_IMAGES.map((image) => (
              <button
                key={image.id}
                type="button"
                className="toolbar-button toolbar-button--small"
                aria-pressed={effectiveImageId === image.id}
                onClick={() => setSelectedImageId(image.id)}
              >
                {image.id}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="review-side">
        <div className="review-filters">
          <label className="inventory-label">
            Decision
            <select
              className="inventory-select"
              value={decisionFilter}
              onChange={(event) => setDecisionFilter(event.target.value as ObservationDecision | "all")}
            >
              <option value="all">All decisions</option>
              {DECISIONS.map((decision) => (
                <option key={decision} value={decision}>
                  {OBSERVATION_DECISION_LABELS[decision]}
                </option>
              ))}
            </select>
          </label>
          <label className="inventory-label">
            Category
            <select
              className="inventory-select"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value as ObservationCategory | "all")}
            >
              <option value="all">All categories</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {OBSERVATION_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="obs-add">
          <h3 className="settings-heading">Add missed observation</h3>
          {imageOptions.length === 0 && (
            <p className="inventory-hint" role="note">
              No in-region image references are available for this street. Run Mapillary
              discovery for the region or choose a region with imagery before adding
              manual observations.
            </p>
          )}
          <label className="inventory-label">
            Source image
            <select
              className="inventory-select"
              value={addImageId || effectiveImageId || ""}
              disabled={stale || imageOptions.length === 0}
              onChange={(event) => setAddImageId(event.target.value)}
            >
              {imageOptions.length === 0 && <option value="">No images</option>}
              {imageOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inventory-label">
            Category
            <select
              className="inventory-select"
              value={addCategory}
              disabled={stale}
              onChange={(event) => setAddCategory(event.target.value as ObservationCategory)}
            >
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {OBSERVATION_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
          <label className="inventory-label">
            Description
            <input
              type="text"
              className="inventory-input"
              value={addDescription}
              disabled={stale}
              placeholder="e.g. lamp head behind the pole"
              onChange={(event) => setAddDescription(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={stale || !addDescription.trim() || imageOptions.length === 0}
            onClick={addObservation}
          >
            Add observation
          </button>
        </div>

        {observations.length === 0 && (
          <p className="search-status" role="status">
            {demoMode
              ? "No observations yet. Run demo detection or add one manually."
              : "No observations yet. Detect in the previous step or add one manually."}
          </p>
        )}
        {observations.length > 0 && visible.length === 0 && (
          <p className="search-status" role="status">
            No observations match these filters.
          </p>
        )}
        <ol className="obs-list">
          {visible.map((observation) => (
            <ObservationCard
              key={observation.id}
              observation={observation}
              session={session}
              sessions={sessions}
              stale={stale}
              selected={observation.id === selectedObsId}
              notice={notices[observation.id]}
              onNotice={(obsId, text) => setNotices((prev) => ({ ...prev, [obsId]: text }))}
              onJump={jumpTo}
              onViewImage={viewInViewer}
              onDrawRequest={(obsId) => {
                jumpTo(obsId);
                setDrawArmed(true);
              }}
            />
          ))}
        </ol>
        {selectedObs && (
          <p className="search-hint">
            Selected: {selectedObs.id}. {drawArmed ? "Drag on the illustration to draw its rectangle." : ""}
          </p>
        )}
      </div>
    </div>
  );
}
