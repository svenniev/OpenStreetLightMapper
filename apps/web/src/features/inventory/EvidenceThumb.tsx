import { useEffect, useState } from "react";
import type { NormalizedRect } from "./inventoryTypes";
import { mediaUrlFor } from "../../lib/detectionClient";
import { useViewMedia, type ViewImageState, type ViewMedia } from "./useViewMedia";

/**
 * Ensure one image's metadata, returning its cache state (never session
 * state). Auto-fetch runs once per image; failures wait for explicit Retry
 * instead of refetching on every render.
 */
export function useObservedImage(imageId: string | null, viewMedia: ViewMedia): ViewImageState {
  const status = imageId ? (viewMedia.states[imageId]?.status ?? "idle") : "idle";
  useEffect(() => {
    if (imageId && status === "idle") {
      viewMedia.ensureImage(imageId).catch(() => undefined);
    }
  }, [imageId, status, viewMedia]);
  if (!imageId) return { status: "idle" };
  return viewMedia.states[imageId] ?? { status: "idle" };
}

export { useViewMedia };

interface EvidenceThumbProps {
  imageId: string;
  viewMedia: ViewMedia;
  /** Highlight rect in FULL-photo normalized space (callers map crop views). */
  rect: NormalizedRect | null;
  label: string;
  selected?: boolean;
  onSelect?: () => void;
  /** Durable local evidence URL; preferred over live provider media. */
  artifactUrl?: string | null;
}

/**
 * Small photograph thumbnail with one highlighted region and full-image
 * context. Metadata loads lazily through the shared cache; a missing photo
 * renders an honest placeholder, never a broken icon.
 */
export function EvidenceThumb(props: EvidenceThumbProps) {
  const [artifactFailed, setArtifactFailed] = useState(false);
  const useArtifact = Boolean(props.artifactUrl) && !artifactFailed;
  const state = useObservedImage(useArtifact ? null : props.imageId, props.viewMedia);

  const overlay = props.rect ? (
    <svg className="evidence-thumb__overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <rect
        x={props.rect.x * 100}
        y={props.rect.y * 100}
        width={Math.max(props.rect.w * 100, 2)}
        height={Math.max(props.rect.h * 100, 2)}
        fill="none"
        stroke="#0e7490"
        strokeWidth={2}
      />
    </svg>
  ) : null;

  const body = (() => {
    if (useArtifact && props.artifactUrl) {
      return (
        <>
          <img
            className="evidence-thumb__img"
            src={props.artifactUrl}
            alt={props.label}
            loading="lazy"
            draggable={false}
            onError={() => setArtifactFailed(true)}
          />
          {overlay}
        </>
      );
    }
    if (state.status === "ready") {
      return (
        <>
          <img
            className="evidence-thumb__img"
            src={mediaUrlFor(state.detail.media.handle)}
            alt={props.label}
            loading="lazy"
            draggable={false}
          />
          {overlay}
        </>
      );
    }
    if (state.status === "failed") {
      return (
        <span className="evidence-thumb__placeholder">
          Photo unavailable.{" "}
          <button
            type="button"
            className="link-button"
            onClick={(event) => {
              event.stopPropagation();
              props.viewMedia.refreshImage(props.imageId).catch(() => undefined);
            }}
          >
            Retry
          </button>
        </span>
      );
    }
    return <span className="evidence-thumb__placeholder">Loading photo…</span>;
  })();

  if (props.onSelect) {
    return (
      <button
        type="button"
        className={`evidence-thumb${props.selected ? " evidence-thumb--selected" : ""}`}
        onClick={props.onSelect}
        aria-label={props.label}
        title={props.label}
      >
        {body}
      </button>
    );
  }
  return <span className="evidence-thumb" title={props.label}>{body}</span>;
}
