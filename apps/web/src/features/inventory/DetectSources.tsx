import { useMemo, useState } from "react";
import type { ImageResult } from "../../lib/searchTypes";
import { mediaUrlFor, measureMedia } from "../../lib/detectionClient";
import { EvidenceThumb, useObservedImage } from "./EvidenceThumb";
import {
  cropPixels,
  cropViewId,
  describeView,
  fullViewId,
  isValidCrop,
  spreadSelection,
} from "./imageViews";
import {
  MAX_VIEWS_PER_RUN,
  STREET_SOURCE_LABELS,
  SUGGESTED_IMAGE_COUNT,
  type NormalizedRect,
  type SourceImage,
  type SourceView,
  type WorkflowSession,
} from "./inventoryTypes";
import { PhotoCanvas } from "./PhotoCanvas";
import type { InventorySessions } from "./useInventorySessions";
import type { ViewMedia } from "./useViewMedia";

export interface SequenceOption {
  sequenceId: string;
  count: number;
}

export interface DetectSourcesProps {
  session: WorkflowSession;
  sessions: InventorySessions;
  stale: boolean;
  poolImages: ImageResult[];
  sequenceOptions: SequenceOption[];
  currentSequenceId: string | null;
  currentImageId: string | null;
  viewMedia: ViewMedia;
}

/** At most ten source images: views cap at ten including crops. */
export const MAX_SOURCE_IMAGES = 10;
const STRIP_PAGE = 24;

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function formatDate(capturedAt: number | null): string {
  if (capturedAt === null) return "Undated";
  return new Date(capturedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function kindOf(image: ImageResult): "standard" | "panorama" | "unknown" {
  if (image.isPano === true) return "panorama";
  if (image.isPano === false) return "standard";
  return "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected failure.";
}

function StripCard(props: {
  image: ImageResult;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  viewMedia: ViewMedia;
}) {
  const { image } = props;
  const kind = kindOf(image);
  const observed = useObservedImage(image.id, props.viewMedia);
  return (
    <label className={`strip-card${props.checked ? " strip-card--checked" : ""}`}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onToggle}
        aria-label={`Select image ${image.id}`}
      />
      <EvidenceThumb imageId={image.id} viewMedia={props.viewMedia} rect={null} label={`Image ${image.id}`} />
      <span className="strip-card__meta" title={image.id}>
        {shortId(image.id)} · {kind}
        <br />
        {formatDate(image.capturedAt)}
        {image.sequenceId ? ` · seq ${shortId(image.sequenceId)}` : ""}
        <br />
        {observed.status === "ready" ? observed.detail.image.attribution : "© Mapillary contributors"}
      </span>
    </label>
  );
}

function SourceSelection(props: DetectSourcesProps) {
  const { session, sessions, stale, poolImages, sequenceOptions, viewMedia } = props;
  const defaultSequence =
    props.currentSequenceId && sequenceOptions.some((option) => option.sequenceId === props.currentSequenceId)
      ? props.currentSequenceId
      : "all";
  const [sequence, setSequence] = useState(defaultSequence);
  const [kind, setKind] = useState<"all" | "standard" | "panorama" | "unknown">("all");
  const [year, setYear] = useState<string>("all");
  const [checked, setChecked] = useState<string[]>([]);
  const [ackFor, setAckFor] = useState("");
  const [stripLimit, setStripLimit] = useState(STRIP_PAGE);
  const [shortcutMessage, setShortcutMessage] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [chooseProgress, setChooseProgress] = useState("");
  const [chooseErrors, setChooseErrors] = useState<string[]>([]);
  const [samplingNote, setSamplingNote] = useState<string | null>(null);

  const inSequence = useMemo(
    () => poolImages.filter((image) => sequence === "all" || image.sequenceId === sequence),
    [poolImages, sequence],
  );
  const years = useMemo(() => {
    const found = new Set<string>();
    for (const image of inSequence) {
      if (image.capturedAt !== null) found.add(String(new Date(image.capturedAt).getFullYear()));
    }
    return [...found].sort();
  }, [inSequence]);
  const filtered = useMemo(() => {
    const list = inSequence.filter((image) => {
      if (kind !== "all" && kindOf(image) !== kind) return false;
      if (year === "undated") return image.capturedAt === null;
      if (year !== "all") {
        if (image.capturedAt === null) return false;
        return String(new Date(image.capturedAt).getFullYear()) === year;
      }
      return true;
    });
    return [...list].sort((a, b) => (a.capturedAt ?? Number.MAX_SAFE_INTEGER) - (b.capturedAt ?? Number.MAX_SAFE_INTEGER));
  }, [inSequence, kind, year]);

  const checkedKey = [...checked].sort().join(",");
  const acked = ackFor === checkedKey && checked.length > 0;

  const toggle = (id: string) => {
    setChecked((prev) => {
      if (prev.includes(id)) return prev.filter((entry) => entry !== id);
      if (prev.length >= MAX_SOURCE_IMAGES) return prev;
      return [...prev, id];
    });
    setSamplingNote(null);
  };

  const useCurrentSequence = () => {
    const id = props.currentSequenceId;
    if (!id) {
      setShortcutMessage("No sequence is selected in the viewer.");
      return;
    }
    if (!sequenceOptions.some((option) => option.sequenceId === id)) {
      setShortcutMessage("The current sequence has no in-region images for this run.");
      return;
    }
    setSequence(id);
    setShortcutMessage(`Filtered to the current sequence (${shortId(id)}).`);
  };

  const useCurrentImage = () => {
    const id = props.currentImageId;
    if (!id) {
      setShortcutMessage("No image is open in the viewer.");
      return;
    }
    if (!poolImages.some((image) => image.id === id)) {
      setShortcutMessage("The current viewer image is outside the RoI or was not discovered.");
      return;
    }
    setChecked((prev) => (prev.includes(id) || prev.length >= MAX_SOURCE_IMAGES ? prev : [...prev, id]));
    setShortcutMessage(`Selected the current viewer image (${shortId(id)}).`);
  };

  const spread = () => {
    const count = Math.min(SUGGESTED_IMAGE_COUNT, filtered.length);
    const picked = spreadSelection(filtered, count).map((image) => image.id);
    setChecked(picked);
    setSamplingNote(
      `Spread ${picked.length} evenly across ${filtered.length} filtered image${filtered.length === 1 ? "" : "s"}.`,
    );
  };

  const choose = async () => {
    if (!acked || choosing || stale) return;
    setChoosing(true);
    setChooseErrors([]);
    const images: SourceImage[] = [];
    const views: SourceView[] = [];
    const errors: string[] = [];
    for (let index = 0; index < checked.length; index += 1) {
      const imageId = checked[index];
      setChooseProgress(`Preparing ${index + 1} of ${checked.length}…`);
      try {
        const detail = await viewMedia.ensureImage(imageId);
        const dims = await measureMedia(mediaUrlFor(detail.media.handle));
        images.push({
          imageId: detail.image.imageId,
          sequenceId: detail.image.sequenceId,
          capturedAt: detail.image.capturedAt,
          isPano: detail.image.isPano,
          attribution: detail.image.attribution,
          sourceUrl: detail.image.sourceUrl,
          cameraPosition: detail.image.cameraPosition,
          resolution: detail.image.resolution,
        });
        views.push({
          viewId: fullViewId(imageId),
          imageId,
          fullWidth: dims.width,
          fullHeight: dims.height,
          orientation: dims.orientation,
          isPano: detail.image.isPano ?? false,
          crop: null,
          width: dims.width,
          height: dims.height,
          mediaHandle: detail.media.handle,
          fullyReviewed: false,
        });
      } catch (error) {
        errors.push(`${shortId(imageId)}: ${errorMessage(error)}`);
      }
    }
    setChooseErrors(errors);
    setChooseProgress("");
    setChoosing(false);
    if (views.length > 0) {
      sessions.dispatch({
        type: "SOURCES_CHOOSE",
        images,
        views,
        samplingNote: samplingNote ?? `Hand-picked ${images.length} image${images.length === 1 ? "" : "s"}.`,
      });
    }
  };

  if (poolImages.length === 0) {
    return (
      <p className="search-status" role="status">
        No in-region images were discovered. Run Mapillary discovery for the region before
        choosing sources — or open the developer demo below for an offline illustration.
      </p>
    );
  }

  return (
    <div className="detect-sources">
      <div className="detect-filters">
        <label className="inventory-label">
          Sequence
          <select
            className="inventory-select"
            value={sequence}
            disabled={stale || choosing}
            onChange={(event) => setSequence(event.target.value)}
          >
            <option value="all">All in-region sequences ({poolImages.length})</option>
            {sequenceOptions.map((option) => (
              <option key={option.sequenceId} value={option.sequenceId}>
                {shortId(option.sequenceId)} ({option.count})
              </option>
            ))}
          </select>
        </label>
        <label className="inventory-label">
          Type
          <select
            className="inventory-select"
            value={kind}
            disabled={stale || choosing}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="all">Panoramas + standard</option>
            <option value="standard">Standard only</option>
            <option value="panorama">Panoramas only</option>
            <option value="unknown">Unknown type</option>
          </select>
        </label>
        <label className="inventory-label">
          Capture date
          <select
            className="inventory-select"
            value={year}
            disabled={stale || choosing}
            onChange={(event) => setYear(event.target.value)}
          >
            <option value="all">All dates</option>
            {years.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
            <option value="undated">Undated</option>
          </select>
        </label>
      </div>

      <div className="inventory-actions">
        <button type="button" className="toolbar-button toolbar-button--small" disabled={stale || choosing} onClick={useCurrentSequence}>
          Use current sequence
        </button>
        <button type="button" className="toolbar-button toolbar-button--small" disabled={stale || choosing} onClick={useCurrentImage}>
          Use current image
        </button>
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          disabled={stale || choosing || filtered.length === 0}
          onClick={spread}
          title={`Pick ${SUGGESTED_IMAGE_COUNT} evenly spaced images instead of consecutive near-duplicates`}
        >
          Spread {SUGGESTED_IMAGE_COUNT} across {sequence === "all" ? "all" : "sequence"}
        </button>
      </div>
      {shortcutMessage && (
        <p className="search-hint" role="status">
          {shortcutMessage}
        </p>
      )}

      <p className="search-hint" role="status">
        {filtered.length} image{filtered.length === 1 ? "" : "s"} match · {checked.length} selected
        (suggested {SUGGESTED_IMAGE_COUNT}, at most {MAX_SOURCE_IMAGES}; views cap at{" "}
        {MAX_VIEWS_PER_RUN} including crops)
      </p>
      <div className="strip-grid" role="group" aria-label="In-region images">
        {filtered.slice(0, stripLimit).map((image) => (
          <StripCard
            key={image.id}
            image={image}
            checked={checked.includes(image.id)}
            disabled={stale || choosing || (!checked.includes(image.id) && checked.length >= MAX_SOURCE_IMAGES)}
            onToggle={() => toggle(image.id)}
            viewMedia={viewMedia}
          />
        ))}
      </div>
      {filtered.length > stripLimit && (
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          onClick={() => setStripLimit((limit) => limit + STRIP_PAGE)}
        >
          Show more ({filtered.length - stripLimit} remaining)
        </button>
      )}

      <label className="inventory-check">
        <input
          type="checkbox"
          checked={acked}
          disabled={stale || choosing || checked.length === 0}
          onChange={(event) => setAckFor(event.target.checked ? checkedKey : "")}
        />
        I choose these {checked.length} image{checked.length === 1 ? "" : "s"} for{" "}
        {session.context.streetDisplayName}
      </label>
      <div className="inventory-actions">
        <button
          type="button"
          className="toolbar-button toolbar-button--primary"
          disabled={stale || choosing || !acked}
          onClick={() => void choose()}
        >
          {choosing ? chooseProgress || "Preparing…" : `Choose ${checked.length} image${checked.length === 1 ? "" : "s"} for this street`}
        </button>
      </div>
      {chooseErrors.map((message) => (
        <p key={message} className="search-status error-text" role="alert">
          {message}
        </p>
      ))}
      {samplingNote && <p className="search-hint">Sampling: {samplingNote} Replace or uncheck freely before choosing.</p>}
    </div>
  );
}

function CropAdder(props: {
  session: WorkflowSession;
  sessions: InventorySessions;
  stale: boolean;
  viewMedia: ViewMedia;
}) {
  const { session, sessions, stale, viewMedia } = props;
  const fullViews = session.viewOrder
    .map((viewId) => session.views[viewId])
    .filter((view) => view && !view.crop);
  const [imageId, setImageId] = useState(fullViews[0]?.imageId ?? "");
  const [drawing, setDrawing] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const target = fullViews.find((view) => view.imageId === imageId) ?? fullViews[0];
  const targetState = useObservedImage(target?.imageId ?? null, viewMedia);
  const atCap = session.viewOrder.length >= MAX_VIEWS_PER_RUN;

  if (fullViews.length === 0) return null;

  const addCrop = (rect: NormalizedRect) => {
    if (!target || stale) return;
    if (!isValidCrop(rect)) {
      setCropError("Draw a real sub-region (at least 2% per side, smaller than the frame).");
      return;
    }
    const pixels = cropPixels(rect, target.fullWidth, target.fullHeight);
    if (pixels.w < 32 || pixels.h < 32) {
      setCropError("That crop is smaller than 32×32 pixels — draw a larger region.");
      return;
    }
    const index = session.viewOrder.filter((viewId) => viewId.startsWith(`view-${target.imageId}-crop-`)).length + 1;
    sessions.dispatch({
      type: "VIEW_ADD_CROP",
      view: {
        viewId: cropViewId(target.imageId, index),
        imageId: target.imageId,
        fullWidth: target.fullWidth,
        fullHeight: target.fullHeight,
        orientation: target.orientation,
        isPano: target.isPano,
        crop: { ...rect },
        width: pixels.w,
        height: pixels.h,
        mediaHandle: target.mediaHandle,
        fullyReviewed: false,
      },
    });
    setDrawing(false);
    setCropError(null);
  };

  return (
    <div className="detect-crops">
      <h4 className="settings-heading">Crop views</h4>
      {atCap ? (
        <p className="search-hint">View cap reached ({MAX_VIEWS_PER_RUN} including crops).</p>
      ) : drawing && target ? (
        <div>
          <p className="search-hint">
            Drag a rectangle on the full photo. The frozen crop below is the exact inference raster.
          </p>
          {targetState.status === "ready" ? (
            <PhotoCanvas
              mediaUrl={mediaUrlFor(targetState.detail.media.handle)}
              alt={`Full photo ${target.imageId} for crop drawing`}
              view={target}
              overlays={[]}
              interactive
              drawArmed
              zoom={1}
              onSelectRect={() => undefined}
              onDrawRect={addCrop}
              onMoveRect={() => undefined}
              onDisarm={() => undefined}
            />
          ) : (
            <p className="search-hint">Loading full photo…</p>
          )}
          <div className="inventory-actions">
            <button type="button" className="toolbar-button toolbar-button--small" onClick={() => { setDrawing(false); setCropError(null); }}>
              Cancel crop
            </button>
          </div>
          {cropError && (
            <p className="search-status error-text" role="alert">
              {cropError}
            </p>
          )}
        </div>
      ) : (
        <div className="detect-filters">
          <label className="inventory-label">
            Crop from
            <select
              className="inventory-select"
              value={target?.imageId ?? ""}
              disabled={stale}
              onChange={(event) => setImageId(event.target.value)}
            >
              {fullViews.map((view) => (
                <option key={view.viewId} value={view.imageId}>
                  {shortId(view.imageId)} ({view.width}×{view.height})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={stale}
            onClick={() => {
              setCropError(null);
              setDrawing(true);
            }}
          >
            Draw crop
          </button>
        </div>
      )}
    </div>
  );
}

export function DetectSources(props: DetectSourcesProps) {
  const { session, sessions, stale, viewMedia } = props;
  if (!session.manifest) {
    return (
      <div>
        <p className="search-hint">
          Street provenance: <strong>{STREET_SOURCE_LABELS[session.context.streetSource]}</strong>
          {session.context.streetSource === "manual-work-area" &&
            " — assignments here stay explicitly unverified."}
        </p>
        <SourceSelection {...props} />
      </div>
    );
  }
  return (
    <div className="detect-manifest">
      <p className="search-status" role="status">
        {session.manifest.imageIds.length} image{session.manifest.imageIds.length === 1 ? "" : "s"} ·{" "}
        {session.viewOrder.length} view{session.viewOrder.length === 1 ? "" : "s"} chosen
        {session.manifest.samplingNote ? ` · ${session.manifest.samplingNote}` : ""}. Sources are
        frozen — reselecting needs Reset, which clears runs and observations.
      </p>
      <ul className="detect-view-list">
        {session.viewOrder.map((viewId) => {
          const view = session.views[viewId];
          if (!view) return null;
          return (
            <li key={viewId}>
              <strong>{describeView(view)}</strong> · {shortId(view.imageId)} · {view.width}×
              {view.height}
              {view.isPano ? " · panorama (flat view may distort objects)" : ""}
              {view.fullyReviewed ? " · fully reviewed" : ""}
            </li>
          );
        })}
      </ul>
      <CropAdder session={session} sessions={sessions} stale={stale} viewMedia={viewMedia} />
    </div>
  );
}
