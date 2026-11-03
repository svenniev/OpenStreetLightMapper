import { formatCapturedDate, formatPanoStatus, paginateResults } from "../../lib/search";
import type { ImageResult } from "../../lib/searchTypes";

export interface ResultsListProps {
  images: ImageResult[];
  selectedId: string | null;
  viewedId: string | null;
  page: number;
  onPage: (page: number) => void;
  onSelect: (id: string) => void;
}

export function ResultsList(props: ResultsListProps) {
  const { items, page, pageCount, total } = paginateResults(props.images, props.page);
  return (
    <div className="results-list-block">
      <p className="results-pagination" role="status" aria-live="polite">
        Page {page} of {pageCount} · {total} loaded result{total === 1 ? "" : "s"}
      </p>
      <ol className="results-list">
        {items.map((image) => {
          const selected = image.id === props.selectedId;
          const viewing = image.id === props.viewedId;
          return (
            <li
              key={image.id}
              className={`result-row${selected ? " result-row--selected" : ""}`}
            >
              <div className="result-main">
                <span className="result-id" title={image.id}>
                  {image.id}
                </span>
                <span className="result-meta">
                  {formatCapturedDate(image.capturedAt)} · {formatPanoStatus(image.isPano)}
                </span>
                <span className="result-badges" aria-live="polite">
                  {selected && <span className="badge">Selected</span>}
                  {viewing && <span className="badge badge--viewing">Viewing</span>}
                </span>
              </div>
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                onClick={() => props.onSelect(image.id)}
                aria-label={`Open image ${image.id} in the viewer`}
              >
                Open image
              </button>
            </li>
          );
        })}
      </ol>
      {pageCount > 1 && (
        <div className="results-pager">
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => props.onPage(page - 1)}
            disabled={page <= 1}
          >
            Previous
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => props.onPage(page + 1)}
            disabled={page >= pageCount}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
