import { useEffect } from "react";
import type { NormalizedRect } from "./inventoryTypes";
import { mediaUrlFor } from "../../lib/detectionClient";
import { useViewMedia, type ViewImageState, type ViewMedia } from "./useViewMedia";

/** Ensure one image's metadata, returning its cache state (never session state). */
export function useObservedImage(imageId: string | null, viewMedia: ViewMedia): ViewImageState {
  useEffect(() => {
    if (imageId) {
      viewMedia.ensureImage(imageId).catch(() => undefined);
    }
  }, [imageId, viewMedia]);
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
}

/**
 * Small photograph thumbnail with one highlighted region and full-image
 * context. Metadata loads lazily through the shared cache; a missing photo
 * renders an honest placeholder, never a broken icon.
 */
export function EvidenceThumb(props: EvidenceThumbProps) {
  const state = useObservedImage(props.imageId, props.viewMedia);

  const body = (() => {
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
          {props.rect && (
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
          )}
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
