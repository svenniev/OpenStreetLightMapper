import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  getAutoCandidateEvidence,
  type AutoCandidateEvidence,
  type AutoCandidateSummary,
} from "../../lib/autoApi";

export interface AutoInspectModalProps {
  workspaceId: string;
  jobId: string;
  candidate: AutoCandidateSummary;
  onClose: () => void;
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 12)}…`;
}

/** Path-data whitelist: rebuilt paths can only draw, never break out into markup. */
const PATH_DATA_PATTERN = /^[MmZzLlHhVvCcSsQqTtAa0-9\s,.\-+eE]*$/;

function MaskLayer(props: {
  show: boolean;
  observations: { maskArtifactId: string | null; maskBounds: AutoCandidateEvidence["observations"][number]["maskBounds"] }[];
  viewWidth: number | null;
  viewHeight: number | null;
  fill: string;
}) {
  const { show, observations, viewWidth, viewHeight, fill } = props;
  if (!show || !viewWidth || !viewHeight) return null;
  return (
    <>
      {observations.map((obs, index) =>
        obs.maskArtifactId && obs.maskBounds ? (
          <MaskOverlay
            key={`${obs.maskArtifactId}-${index}`}
            artifactId={obs.maskArtifactId}
            bounds={obs.maskBounds}
            viewWidth={viewWidth}
            viewHeight={viewHeight}
            fill={fill}
          />
        ) : null,
      )}
    </>
  );
}

function MaskOverlay(props: {
  artifactId: string;
  bounds: { left: number; top: number; right: number; bottom: number };
  viewWidth: number;
  viewHeight: number;
  fill: string;
}) {
  const [path, setPath] = useState<{ viewBox: string; d: string } | null>(null);
  useEffect(() => {
    let live = true;
    setPath(null);
    fetch(`/api/artifacts/${props.artifactId}`, { signal: AbortSignal.timeout(15000) })
      .then((response) => {
        if (!response.ok) throw new Error(`mask ${response.status}`);
        return response.text();
      })
      .then((text) => {
        if (!live) return;
        // Never inline stored markup: extract the viewBox and one path's data,
        // reject anything outside the path-data alphabet, rebuild the element.
        const viewBox = text.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
        const d = text.match(/<path[^>]*\sd="([^"]*)"/);
        if (!viewBox || !d || d[1].length === 0 || !PATH_DATA_PATTERN.test(d[1])) return;
        setPath({ viewBox: `0 0 ${viewBox[1]} ${viewBox[2]}`, d: d[1] });
      })
      .catch(() => {
        // A mask that cannot be verified stays hidden; the box still shows.
      });
    return () => {
      live = false;
    };
  }, [props.artifactId]);
  if (!path) return null;
  const { bounds, viewWidth, viewHeight } = props;
  const widthPx = Math.max(0, bounds.right - bounds.left);
  const heightPx = Math.max(0, bounds.bottom - bounds.top);
  if (widthPx <= 0 || heightPx <= 0) return null;
  return (
    <svg
      className="auto-inspect-mask"
      viewBox={path.viewBox}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{
        left: `${(bounds.left / viewWidth) * 100}%`,
        top: `${(bounds.top / viewHeight) * 100}%`,
        width: `${(widthPx / viewWidth) * 100}%`,
        height: `${(heightPx / viewHeight) * 100}%`,
      }}
    >
      <path d={path.d} fill={props.fill} fillOpacity={0.45} stroke="none" />
    </svg>
  );
}

/**
 * Inspect one automatic candidate: its stored analysis views with the
 * segmentation boxes, anchor points, and SAM masks overlaid. Everything
 * shown is read back from the run's own records — no live provider fetch.
 */
export function AutoInspectModal(props: AutoInspectModalProps) {
  const { workspaceId, jobId, candidate } = props;
  const [evidence, setEvidence] = useState<AutoCandidateEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [showMasks, setShowMasks] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setEvidence(null);
    setError(null);
    setImageIndex(0);
    getAutoCandidateEvidence(workspaceId, jobId, candidate.candidateId, controller.signal).then(
      (fetched) => {
        setEvidence(fetched);
      },
      (fetchError: unknown) => {
        if (fetchError instanceof Error && fetchError.name === "AbortError") return;
        setError(
          fetchError instanceof ApiError
            ? `${fetchError.message} (${fetchError.code})`
            : "The evidence could not be loaded.",
        );
      },
    );
    return () => controller.abort();
  }, [workspaceId, jobId, candidate.candidateId]);

  const close = useCallback(() => props.onClose(), [props]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const images = evidence?.images ?? [];
  const current = images[imageIndex] ?? null;
  const currentObservations =
    current ? (evidence?.observations.filter((obs) => obs.imageId === current.imageId) ?? []) : [];
  const masksAvailable = currentObservations.some((obs) => obs.maskArtifactId !== null);
  const stroke = candidate.category === "pole" ? "#0e7490" : "#b45309";

  return (
    <div
      className="auto-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Inspect automatic ${candidate.category} ${candidate.candidateId}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="auto-modal">
        <div className="auto-modal-header">
          <h3 className="settings-heading">
            {candidate.category === "pole" ? "Pole" : "Fixture"}{" "}
            <span title={candidate.candidateId}>{shortId(candidate.candidateId)}</span> —{" "}
            {candidate.status}
            {candidate.position
              ? ` (±${candidate.position.uncertaintyM.toFixed(1)} m, ${candidate.position.method})`
              : ` (${candidate.unlocatedReason ?? "unresolved"})`}
          </h3>
          <button type="button" className="toolbar-button toolbar-button--small" onClick={close}>
            Close
          </button>
        </div>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {!evidence && !error && (
          <p className="sequence-meta" role="status">
            Loading segmented views…
          </p>
        )}
        {evidence && images.length === 0 && (
          <p className="sequence-meta" role="status">
            This candidate has no evidence images recorded.
          </p>
        )}

        {evidence && current && (
          <>
            <div className="auto-inspect-nav" role="group" aria-label="Evidence images">
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                disabled={imageIndex === 0}
                onClick={() => setImageIndex((index) => Math.max(0, index - 1))}
              >
                Previous
              </button>
              <span className="sequence-meta" role="status" title={current.imageId}>
                Image {imageIndex + 1} of {images.length} ({shortId(current.imageId)})
              </span>
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                disabled={imageIndex >= images.length - 1}
                onClick={() => setImageIndex((index) => Math.min(images.length - 1, index + 1))}
              >
                Next
              </button>
              {masksAvailable && (
                <label className="sequence-meta">
                  <input
                    type="checkbox"
                    checked={showMasks}
                    onChange={(event) => setShowMasks(event.target.checked)}
                  />{" "}
                  Masks
                </label>
              )}
            </div>

            <div className="auto-inspect-stage">
              {current.viewArtifactId ? (
                <img
                  key={current.imageId}
                  className="auto-inspect-raster"
                  src={`/api/artifacts/${current.viewArtifactId}`}
                  alt={`Analysis view for image ${current.imageId}`}
                />
              ) : (
                <p className="sequence-meta" role="status">
                  The analysis view for this image was not stored.
                </p>
              )}
              {current.viewArtifactId && currentObservations.length > 0 && (
                <svg
                  className="auto-inspect-overlay"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {currentObservations.map((obs) => (
                    <g key={obs.observationId}>
                      <rect
                        x={obs.box.x * 100}
                        y={obs.box.y * 100}
                        width={obs.box.w * 100}
                        height={obs.box.h * 100}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                      {obs.anchor && current.width && current.height && (
                        <circle
                          cx={(obs.anchor.uPx / current.width) * 100}
                          cy={(obs.anchor.vPx / current.height) * 100}
                          r={4}
                          fill={stroke}
                          stroke="#fff"
                          strokeWidth={1}
                        />
                      )}
                    </g>
                  ))}
                </svg>
              )}
              {current.viewArtifactId && (
                <MaskLayer
                  show={showMasks}
                  observations={currentObservations}
                  viewWidth={current.width}
                  viewHeight={current.height}
                  fill={stroke}
                />
              )}
            </div>

            <ul className="sequence-list">
              {currentObservations.map((obs) => (
                <li key={obs.observationId} className="sequence-meta">
                  <span title={obs.observationId}>{shortId(obs.observationId)}</span>
                  {obs.confidence !== null && ` · ${(obs.confidence * 100).toFixed(0)}% confidence`}
                  {obs.maskArtifactId ? " · mask" : " · box only"}
                </li>
              ))}
              {currentObservations.length === 0 && (
                <li className="sequence-meta">No observations of this candidate in this view.</li>
              )}
            </ul>
          </>
        )}

        {evidence?.truncated && (
          <p className="search-hint">
            Showing the first 200 observations; this candidate has more.
          </p>
        )}
      </div>
    </div>
  );
}
