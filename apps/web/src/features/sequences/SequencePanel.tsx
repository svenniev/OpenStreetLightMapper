import {
  RESULT_PAGE_SIZE,
  formatCapturedDate,
  formatPanoStatus,
  paginateResults,
  warningMessage,
} from "../../lib/search";
import type { ImageResult } from "../../lib/searchTypes";
import {
  groupMatchesFilter,
  imageMatchesFilter,
  type GroupedSequences,
  type SequenceFilter,
  type SequenceGroup,
} from "./sequenceGroup";
import type { SequenceLoadInfo, SequenceScope } from "./useSequences";

export interface SequencePanelProps {
  groups: GroupedSequences;
  filter: SequenceFilter;
  onFilter: (filter: SequenceFilter) => void;
  scope: SequenceScope;
  onScope: (scope: SequenceScope) => void;
  selectedSequenceId: string | null;
  selectedUngroupedId: string | null;
  selectedLoad: SequenceLoadInfo;
  scopedMembers: ImageResult[];
  unresolvedIds: string[];
  imageListOpen: boolean;
  onToggleImageList: () => void;
  imagePage: number;
  onImagePage: (page: number) => void;
  viewedId: string | null;
  pendingId: string | null;
  foreignSequence: { sequenceId: string; discovered: boolean } | null;
  hasDiscovery: boolean;
  onSelectSequence: (id: string | null) => void;
  onSelectUngrouped: (id: string | null) => void;
  onSelectImage: (id: string) => void;
  onRetryDetail: (sequenceId: string) => void;
  onFitSequence: () => void;
  canFitSequence: boolean;
  /** Automatic mode: rows gain inclusion checkboxes for the run. */
  autoMode?: boolean;
  autoSelected?: ReadonlySet<string>;
  onToggleAutoSequence?: (sequenceId: string) => void;
  onSelectAutoSequences?: (sequenceIds: string[]) => void;
  onClearAutoSelection?: () => void;
}

const FILTERS: { value: SequenceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "panoramas", label: "Contains panoramas" },
  { value: "standard", label: "Standard only" },
  { value: "unknown", label: "Unknown type" },
];

function formatRange(earliest: number | null, latest: number | null): string {
  if (earliest === null || latest === null) return "Date unknown";
  if (earliest === latest) return formatCapturedDate(earliest);
  return `${formatCapturedDate(earliest)} – ${formatCapturedDate(latest)}`;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 10)}…`;
}

function SequenceRow({
  group,
  selected,
  autoMode,
  autoChecked,
  onToggleAuto,
  onSelect,
}: {
  group: SequenceGroup;
  selected: boolean;
  autoMode: boolean;
  autoChecked: boolean;
  onToggleAuto: (() => void) | null;
  onSelect: () => void;
}) {
  return (
    <li className="sequence-row-item">
      {autoMode && onToggleAuto && (
        <input
          type="checkbox"
          className="sequence-checkbox"
          checked={autoChecked}
          onChange={onToggleAuto}
          aria-label={`Include sequence ${group.shortId} in the automatic run`}
          title="Include in the automatic run"
        />
      )}
      <button
        type="button"
        className={`sequence-row${selected ? " sequence-row--selected" : ""}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="sequence-id" title={group.sequenceId}>
          {group.shortId}
        </span>
        <span className="badge">{group.badge}</span>
        <span className="sequence-meta">
          {group.seedCount} in RoI · {formatRange(group.earliestCapture, group.latestCapture)}
        </span>
        <span className="sequence-meta">
          {group.panoCount} pano · {group.standardCount} standard · {group.unknownCount} unknown
        </span>
      </button>
    </li>
  );
}

function ImageRow({
  image,
  viewed,
  pending,
  onOpen,
}: {
  image: ImageResult;
  viewed: boolean;
  pending: boolean;
  onOpen: () => void;
}) {
  return (
    <li className={`result-row${viewed ? " result-row--selected" : ""}`}>
      <div className="result-main">
        <span className="result-id" title={image.id}>
          {image.id}
        </span>
        <span className="result-meta">
          {formatCapturedDate(image.capturedAt)} · {formatPanoStatus(image.isPano)} ·{" "}
          {image.inRoi === false ? "Outside RoI" : "Inside RoI"}
        </span>
        <span className="result-badges" aria-live="polite">
          {viewing(viewed, pending)}
        </span>
      </div>
      <button
        type="button"
        className="toolbar-button toolbar-button--small"
        onClick={onOpen}
        aria-label={`Open image ${image.id} in the viewer`}
      >
        Open image
      </button>
    </li>
  );
}

function viewing(viewed: boolean, pending: boolean) {
  return (
    <>
      {viewed && <span className="badge badge--viewing">Viewing</span>}
      {pending && <span className="badge">Loading</span>}
    </>
  );
}

export function SequencePanel(props: SequencePanelProps) {
  const { groups, selectedSequenceId, selectedLoad } = props;
  const autoMode = props.autoMode === true;
  const autoSelected = props.autoSelected ?? new Set<string>();
  const visible = groups.sequences.filter(
    (group) => groupMatchesFilter(group, props.filter) || group.sequenceId === selectedSequenceId,
  );
  const visibleUngrouped = groups.ungrouped.filter((image) => imageMatchesFilter(image, props.filter));
  const selectedGroup = groups.sequences.find((group) => group.sequenceId === selectedSequenceId) ?? null;
  const page = paginateResults(props.scopedMembers, props.imagePage, RESULT_PAGE_SIZE);

  return (
    <div className="sequence-panel">
      {props.foreignSequence && (
        <p className="foreign-sequence" role="status">
          Viewing image from sequence{" "}
          <span title={props.foreignSequence.sequenceId}>
            {shortId(props.foreignSequence.sequenceId)}
          </span>
          {!props.foreignSequence.discovered && " (not in this discovery)"}.{" "}
          {props.foreignSequence.discovered && (
            <button
              type="button"
              className="link-button"
              onClick={() => props.onSelectSequence(props.foreignSequence?.sequenceId ?? null)}
            >
              Show this sequence
            </button>
          )}
        </p>
      )}

      {!props.hasDiscovery && (
        <p className="sequence-empty">Search a region to discover Mapillary sequences.</p>
      )}
      {props.hasDiscovery && groups.sequences.length === 0 && groups.ungrouped.length === 0 && (
        <p className="sequence-empty">No sequences were discovered in this region.</p>
      )}

      {(groups.sequences.length > 0 || groups.ungrouped.length > 0) && (
        <div className="sequence-filters" role="group" aria-label="Sequence filters">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="toolbar-button toolbar-button--small"
              aria-pressed={props.filter === option.value}
              onClick={() => props.onFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {autoMode && groups.sequences.length > 0 && (
        <div className="auto-select-bar" role="group" aria-label="Automatic run sequence selection">
          <span className="sequence-meta" role="status">
            {autoSelected.size} sequence{autoSelected.size === 1 ? "" : "s"} selected for the
            automatic run
            {autoSelected.size > visible.filter((group) => autoSelected.has(group.sequenceId)).length &&
              " (including hidden by filter)"}
          </span>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            onClick={() => props.onSelectAutoSequences?.(visible.map((group) => group.sequenceId))}
          >
            Select visible
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={autoSelected.size === 0}
            onClick={() => props.onClearAutoSelection?.()}
          >
            Clear selection
          </button>
        </div>
      )}

      {visible.length > 0 && (
        <ol className="sequence-list" aria-label="Discovered sequences">
          {visible.map((group) => (
            <SequenceRow
              key={group.sequenceId}
              group={group}
              selected={group.sequenceId === selectedSequenceId}
              autoMode={autoMode}
              autoChecked={autoSelected.has(group.sequenceId)}
              onToggleAuto={
                props.onToggleAutoSequence
                  ? () => props.onToggleAutoSequence?.(group.sequenceId)
                  : null
              }
              onSelect={() =>
                props.onSelectSequence(
                  group.sequenceId === selectedSequenceId ? null : group.sequenceId,
                )
              }
            />
          ))}
        </ol>
      )}

      {visibleUngrouped.length > 0 && (
        <div className="ungrouped-block">
          <h3 className="settings-heading">Ungrouped images ({visibleUngrouped.length})</h3>
          <ol className="results-list" aria-label="Ungrouped images">
            {visibleUngrouped.slice(0, 50).map((image) => (
              <ImageRow
                key={image.id}
                image={image}
                viewed={image.id === props.viewedId}
                pending={image.id === props.pendingId}
                onOpen={() => {
                  props.onSelectUngrouped(image.id);
                  props.onSelectImage(image.id);
                }}
              />
            ))}
          </ol>
          {visibleUngrouped.length > 50 && (
            <p className="sequence-meta">Showing 50 of {visibleUngrouped.length} ungrouped images.</p>
          )}
        </div>
      )}

      {selectedGroup && (
        <div className="sequence-detail" aria-live="polite">
          <h3 className="settings-heading">
            Sequence <span title={selectedGroup.sequenceId}>{selectedGroup.shortId}</span>
          </h3>
          <p className="sequence-meta" role="status">
            {selectedLoad.state === "loading" && "Loading sequence detail…"}
            {selectedLoad.state === "discovery" && "Discovery only — detail not loaded yet."}
            {selectedLoad.state === "loaded" && "Sequence detail loaded."}
            {selectedLoad.state === "partial" && "Sequence detail partially loaded."}
            {selectedLoad.state === "failed" && "Sequence detail unavailable."}
          </p>
          {selectedLoad.counts && (
            <p className="sequence-meta">
              {selectedLoad.memberIds?.length ?? 0} members ·{" "}
              {selectedLoad.counts.inRegionCount} in RoI · {selectedLoad.counts.outRegionCount}{" "}
              outside
              {selectedLoad.counts.missingCount > 0 &&
                ` · ${selectedLoad.counts.missingCount} missing`}
              {selectedLoad.counts.invalidCount > 0 &&
                ` · ${selectedLoad.counts.invalidCount} invalid`}
              {selectedLoad.counts.unresolvedCount > 0 &&
                ` · ${selectedLoad.counts.unresolvedCount} unresolved`}
            </p>
          )}
          {selectedLoad.warnings.length > 0 && (
            <ul className="warning-list">
              {selectedLoad.warnings.map((code) => (
                <li key={code}>{warningMessage(code)}</li>
              ))}
            </ul>
          )}
          {selectedLoad.state === "failed" && selectedLoad.error && (
            <p className="error-text" role="alert">
              {selectedLoad.error.message}{" "}
              {selectedLoad.error.retryable && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => selectedSequenceId && props.onRetryDetail(selectedSequenceId)}
                >
                  Retry
                </button>
              )}
            </p>
          )}
          <div className="sequence-actions">
            <div className="scope-toggle" role="group" aria-label="Sequence display scope">
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                aria-pressed={props.scope === "inside"}
                onClick={() => props.onScope("inside")}
              >
                Inside RoI
              </button>
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                aria-pressed={props.scope === "whole"}
                onClick={() => props.onScope("whole")}
              >
                Whole sequence
              </button>
            </div>
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              onClick={props.onFitSequence}
              disabled={!props.canFitSequence}
            >
              Fit sequence
            </button>
            <button
              type="button"
              className="toolbar-button toolbar-button--small"
              aria-expanded={props.imageListOpen}
              onClick={props.onToggleImageList}
            >
              {props.imageListOpen ? "Hide images" : `Show images (${props.scopedMembers.length})`}
            </button>
          </div>
          {props.imageListOpen && (
            <div className="sequence-images">
              <p className="results-pagination" role="status">
                Page {page.page} of {page.pageCount} · {page.total} loaded images
              </p>
              <ol className="results-list" aria-label="Sequence images">
                {page.items.map((image) => (
                  <ImageRow
                    key={image.id}
                    image={image}
                    viewed={image.id === props.viewedId}
                    pending={image.id === props.pendingId}
                    onOpen={() => props.onSelectImage(image.id)}
                  />
                ))}
              </ol>
              {props.unresolvedIds.length > 0 && (
                <p className="sequence-meta">
                  {props.unresolvedIds.length} member
                  {props.unresolvedIds.length === 1 ? "" : "s"} without loaded metadata.
                </p>
              )}
              {page.pageCount > 1 && (
                <div className="results-pager">
                  <button
                    type="button"
                    className="toolbar-button toolbar-button--small"
                    onClick={() => props.onImagePage(page.page - 1)}
                    disabled={page.page <= 1}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="toolbar-button toolbar-button--small"
                    onClick={() => props.onImagePage(page.page + 1)}
                    disabled={page.page >= page.pageCount}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {props.selectedUngroupedId && (
        <p className="sequence-meta" role="status">
          Ungrouped image {shortId(props.selectedUngroupedId)} selected (discovery metadata only).
        </p>
      )}
    </div>
  );
}
