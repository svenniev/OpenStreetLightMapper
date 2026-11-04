import type { AutoCandidateSummary, AutoResultSummary } from "../../lib/autoApi";

export interface AutoResultsTableProps {
  candidates: AutoCandidateSummary[] | null;
  result: AutoResultSummary | null;
  error: string | null;
  jobId: string | null;
  onInspect: (candidate: AutoCandidateSummary) => void;
  onOpenManual: (candidate: AutoCandidateSummary) => void;
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 12)}…`;
}

function reasonLabel(reason: string | null): string {
  if (!reason) return "Unresolved";
  // Stored unresolvedReason codes (associate.ts); unknown codes show raw.
  const labels: Record<string, string> = {
    "single-view": "Seen in one usable view only",
    "two-views": "Seen in two views only — needs a third for a trusted position",
    uncertainty: "Geometry too uncertain for a trusted position",
    "duplicate-in-image": "Duplicate sighting within one image",
    gap: "Rays do not meet",
    parallax: "Insufficient parallax between views",
    baseline: "Views too close together",
    reprojection: "Reprojection mismatch",
    depth: "Outside the trusted depth range",
    assignment: "Ambiguous assignment to nearby sightings",
    degenerate: "Degenerate geometry",
    "view-missing": "View data missing",
    "multi-obs-image": "Conflicting sightings in one image",
    "fit-rejected": "Rejected by the geometric fit",
  };
  return labels[reason] ?? reason;
}

export function AutoResultsTable(props: AutoResultsTableProps) {
  const { candidates, result, error, jobId } = props;
  if (!jobId) return null;
  if (error) {
    return (
      <p className="error-text" role="alert">
        {error}
      </p>
    );
  }
  if (!candidates) {
    return (
      <p className="sequence-meta" role="status">
        Loading automatic results…
      </p>
    );
  }
  const located = candidates.filter((candidate) => candidate.status === "located");
  const unlocated = candidates.filter((candidate) => candidate.status !== "located");
  const poles = located.filter((candidate) => candidate.category === "pole").length;
  const fixtures = located.filter((candidate) => candidate.category === "luminaire").length;
  const duplicates = candidates.filter((candidate) => candidate.flags.includes("possible-duplicate")).length;

  return (
    <div className="auto-results">
      <h3 className="settings-heading">Automatic inventory</h3>
      <p className="sequence-meta" role="status">
        {located.length} mapped ({poles} poles, {fixtures} fixtures) · {unlocated.length}{" "}
        unresolved · {duplicates} possible duplicates
        {result && (
          <>
            {" "}
            · {result.status === "inventory-complete" ? "Inventory complete" : "Detection complete"}{" "}
            ({shortId(result.resultId)})
          </>
        )}
      </p>
      {result?.limitations.map((limitation) => (
        <p key={limitation} className="search-hint">
          Limitation: {limitation}
        </p>
      ))}
      {located.length > 0 && (
        <table className="auto-table">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Category</th>
              <th scope="col">Views</th>
              <th scope="col">Uncertainty</th>
              <th scope="col">Flags</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {located.map((candidate) => (
              <tr key={candidate.candidateId}>
                <td title={candidate.candidateId}>{shortId(candidate.candidateId)}</td>
                <td>{candidate.category === "pole" ? "Pole" : "Fixture"}</td>
                <td>
                  {candidate.imageIds.length} images / {candidate.sequenceIds.length} sequences
                </td>
                <td>
                  {candidate.position
                    ? `±${candidate.position.uncertaintyM.toFixed(1)} m (${candidate.position.method})`
                    : "unknown"}
                </td>
                <td>{candidate.flags.length > 0 ? candidate.flags.join(", ") : "—"}</td>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => props.onInspect(candidate)}
                  >
                    Inspect
                  </button>{" "}
                  <button
                    type="button"
                    className="link-button"
                    title="Open this street in the manual workflow for corrections"
                    onClick={() => props.onOpenManual(candidate)}
                  >
                    Open in manual
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unlocated.length > 0 && (
        <>
          <h4 className="settings-heading">Unlocated ({unlocated.length})</h4>
          <ul className="sequence-list">
            {unlocated.map((candidate) => (
              <li key={candidate.candidateId} className="sequence-meta">
                <span title={candidate.candidateId}>{shortId(candidate.candidateId)}</span> (
                {candidate.category}) — {reasonLabel(candidate.unlocatedReason)} ·{" "}
                {candidate.imageIds.length} image{candidate.imageIds.length === 1 ? "" : "s"}{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => props.onInspect(candidate)}
                >
                  Inspect
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
