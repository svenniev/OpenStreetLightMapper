import { useState } from "react";
import type { ImageResult } from "../../lib/searchTypes";
import { DetectSources, type SequenceOption } from "./DetectSources";
import { describeView } from "./imageViews";
import {
  assessViewCompletion,
  viewConceptStates,
} from "./inventoryReducer";
import {
  DETECTION_ITEM_STATUS_LABELS,
  MAX_CALLS_PER_BATCH,
  OBSERVATION_ORIGIN_LABELS,
  RUN_HISTORY_PAGE,
  type AssetCategory,
  type DetectionItem,
  type WorkflowSession,
} from "./inventoryTypes";
import { PhotoCanvas, type PhotoOverlay } from "./PhotoCanvas";
import { useViewSourceUrl } from "./useEvidence";
import { conceptTextError, type InventorySessions } from "./useInventorySessions";
import type { SamStatus } from "./useSamStatus";
import type { ViewMedia } from "./useViewMedia";

export interface DetectRealProps {
  session: WorkflowSession;
  sessions: InventorySessions;
  stale: boolean;
  imageOptions: { id: string; label: string }[];
  poolImages: ImageResult[];
  sequenceOptions: SequenceOption[];
  currentSequenceId: string | null;
  currentImageId: string | null;
  viewMedia: ViewMedia;
  sam: SamStatus;
}

const MAX_CONCEPTS = 4;

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function samBlockReason(sam: SamStatus): string | null {
  switch (sam.readiness.status) {
    case "unknown":
      return "SAM status is still loading.";
    case "not-configured":
      return "SAM is not configured. Set MODEL_API_KEY on the server (see Settings), then test here.";
    default:
      return null;
  }
}

function ConceptRow(props: {
  session: WorkflowSession;
  sessions: InventorySessions;
  stale: boolean;
  conceptId: string;
  busy: boolean;
}) {
  const concept = props.session.concepts.find((entry) => entry.id === props.conceptId);
  const [draft, setDraft] = useState<string | null>(null);
  if (!concept) return null;
  const text = draft ?? concept.text;
  const textError = concept.enabled ? conceptTextError(text) : null;
  const listHint = /[,;+]|\band\b/i.test(text)
    ? "One concept per request — lists and “and” return zero matches."
    : null;
  const disabled = props.stale || props.busy;
  return (
    <li className="concept-row">
      <input
        type="checkbox"
        checked={concept.enabled}
        disabled={disabled}
        onChange={() =>
          props.sessions.dispatch({ type: "CONCEPT_UPDATE", id: concept.id, patch: { enabled: !concept.enabled } })
        }
        aria-label={`Enable concept ${concept.text}`}
      />
      <input
        className="inventory-input"
        value={text}
        maxLength={80}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft.trim().length > 0 && draft !== concept.text) {
            props.sessions.dispatch({ type: "CONCEPT_UPDATE", id: concept.id, patch: { text: draft } });
          }
          setDraft(null);
        }}
        aria-label="Concept text"
      />
      <select
        className="inventory-select"
        value={concept.categoryIntent}
        disabled={disabled}
        onChange={(event) =>
          props.sessions.dispatch({
            type: "CONCEPT_UPDATE",
            id: concept.id,
            patch: { categoryIntent: event.target.value as AssetCategory },
          })
        }
        aria-label="Category intent"
      >
        <option value="pole">Pole/support</option>
        <option value="luminaire">Luminaire</option>
      </select>
      <button
        type="button"
        className="toolbar-button toolbar-button--small"
        disabled={disabled}
        onClick={() => props.sessions.dispatch({ type: "CONCEPT_REMOVE", id: concept.id })}
        aria-label={`Remove concept ${concept.text}`}
      >
        Remove
      </button>
      {textError && (
        <span className="search-status error-text" role="alert">
          {textError}
        </span>
      )}
      {!textError && listHint && <span className="search-hint">{listHint}</span>}
    </li>
  );
}

function ConceptsEditor(props: { session: WorkflowSession; sessions: InventorySessions; stale: boolean; busy: boolean }) {
  const { session, sessions, stale, busy } = props;
  return (
    <div>
      <h4 className="settings-heading">Concepts</h4>
      <ul className="concept-list">
        {session.concepts.map((concept) => (
          <ConceptRow
            key={concept.id}
            session={session}
            sessions={sessions}
            stale={stale}
            conceptId={concept.id}
            busy={busy}
          />
        ))}
      </ul>
      <div className="inventory-actions">
        <button
          type="button"
          className="toolbar-button toolbar-button--small"
          disabled={stale || busy || session.concepts.length >= MAX_CONCEPTS}
          onClick={() =>
            sessions.dispatch({
              type: "CONCEPT_ADD",
              concept: {
                id: `concept-${session.conceptCounter + 1}`,
                text: "streetlight",
                categoryIntent: "luminaire",
                enabled: false,
              },
            })
          }
        >
          Add concept
        </button>
      </div>
    </div>
  );
}

function RetrySaveButton(props: { sessions: InventorySessions; runId: string; itemId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <span className="retry-save">
      <button
        type="button"
        className="link-button"
        disabled={saving}
        onClick={() => {
          setError(null);
          setSaving(true);
          void props.sessions.retryItemSave(props.runId, props.itemId).then((message) => {
            setSaving(false);
            setError(message);
          });
        }}
      >
        {saving ? "Saving…" : "Retry save"}
      </button>
      {error && <span className="error-text"> {error}</span>}
    </span>
  );
}

function ItemOutcomeNotes(props: { sessions: InventorySessions; runId: string; item: DetectionItem }) {
  const { item } = props;
  const terminal =
    item.status === "succeeded" ||
    item.status === "empty" ||
    item.status === "failed" ||
    item.status === "cancelled";
  return (
    <>
      {item.truncated && (
        <span className="search-status"> · partial output (truncated at the object cap)</span>
      )}
      {item.invalidDiscarded > 0 && (
        <span className="search-status"> · {item.invalidDiscarded} invalid discarded</span>
      )}
      {item.supersedes && <span className="search-hint"> · retry of {item.supersedes}</span>}
      {terminal && !item.resultSaved && (
        <span className="error-text" role="alert">
          {" "}
          · {item.status === "succeeded" || item.status === "empty"
            ? "Detection completed, result not saved."
            : "Outcome not saved."}{" "}
          <RetrySaveButton sessions={props.sessions} runId={props.runId} itemId={item.itemId} />
        </span>
      )}
    </>
  );
}

function StagedPreview(props: {
  session: WorkflowSession;
  sessions: InventorySessions;
  viewMedia: ViewMedia;
  stale: boolean;
  onError: (message: string | null) => void;
}) {
  const { session, sessions, viewMedia } = props;
  const staged = session.stagedTest
    ? (() => {
        const run = session.runs.find((entry) => entry.runId === session.stagedTest?.runId);
        const item = run?.items.find((entry) => entry.itemId === session.stagedTest?.itemId);
        return run && item ? { run, item } : null;
      })()
    : null;
  const view = staged ? session.views[staged.item.viewId] : undefined;
  const pixels = useViewSourceUrl(view ?? null, viewMedia);
  if (!staged || !view) return null;
  const { run, item } = staged;
  if (item.status !== "succeeded" && item.status !== "empty") return null;
  const overlays: PhotoOverlay[] = item.objects.map((object, index) => ({
    obsId: `staged-${object.providerObjectId}`,
    label: `#${index + 1}`,
    rect: { ...object.box },
    mask: object.mask,
    maskStale: false,
    selected: false,
    decision: "pending",
  }));
  return (
    <div className="staged-preview">
      <p className="search-status" role="status">
        {item.objects.length === 0
          ? `No matches for “${item.conceptText}” on ${describeView(view)}. Nothing to import.`
          : `${item.objects.length} match${item.objects.length === 1 ? "" : "es"} for “${item.conceptText}” on ${describeView(view)}. Review before importing.`}
        <ItemOutcomeNotes sessions={sessions} runId={run.runId} item={item} />
      </p>
      {pixels.status === "ready" && pixels.url ? (
        <PhotoCanvas
          mediaUrl={pixels.url}
          alt={`Staged test result for ${describeView(view)}`}
          view={view}
          overlays={overlays}
          interactive={false}
          drawArmed={false}
          zoom={1}
          onSelectRect={() => undefined}
          onDrawRect={() => undefined}
          onMoveRect={() => undefined}
          onDisarm={() => undefined}
        />
      ) : pixels.status === "unavailable" ? (
        <p className="search-status error-text" role="alert">
          Source image unavailable locally.{" "}
          <button type="button" className="link-button" onClick={() => pixels.refetch()}>
            Refetch
          </button>
        </p>
      ) : (
        <p className="search-hint">Loading staged photo…</p>
      )}
      <div className="inventory-actions">
        {item.objects.length > 0 && (
          <button
            type="button"
            className="toolbar-button toolbar-button--primary"
            disabled={props.stale}
            onClick={() => props.onError(sessions.importStagedTest())}
          >
            Use these detections
          </button>
        )}
        <button
          type="button"
          className="toolbar-button"
          disabled={props.stale}
          onClick={() => {
            sessions.discardStagedTest();
            props.onError(null);
          }}
        >
          Discard test
        </button>
      </div>
    </div>
  );
}

function TestPanel(props: {
  session: WorkflowSession;
  sessions: InventorySessions;
  viewMedia: ViewMedia;
  sam: SamStatus;
  stale: boolean;
  busy: boolean;
}) {
  const { session, sessions, sam, stale, busy } = props;
  const views = session.viewOrder.map((viewId) => session.views[viewId]).filter(Boolean);
  const enabledConcepts = session.concepts.filter((concept) => concept.enabled);
  const [viewId, setViewId] = useState(views[0]?.viewId ?? "");
  const [conceptId, setConceptId] = useState(enabledConcepts[0]?.id ?? "");
  const [testError, setTestError] = useState<string | null>(null);
  const effectiveView = views.find((view) => view.viewId === viewId) ?? views[0];
  const effectiveConcept = enabledConcepts.find((concept) => concept.id === conceptId) ?? enabledConcepts[0];
  const blocked = samBlockReason(sam);
  const latestTest = [...session.runs].reverse().find((run) => run.kind === "test");
  const latestItem = latestTest?.items[0];
  const failed = latestTest && !latestTest.finishedAt ? null : latestItem?.status === "failed" ? latestItem : null;

  return (
    <div>
      <h4 className="settings-heading">Test one view</h4>
      {blocked ? (
        <p className="search-status" role="status">
          {blocked}
        </p>
      ) : (
        <>
          <div className="detect-filters">
            <label className="inventory-label">
              View
              <select
                className="inventory-select"
                value={effectiveView?.viewId ?? ""}
                disabled={stale || busy}
                onChange={(event) => setViewId(event.target.value)}
              >
                {views.map((view) => (
                  <option key={view.viewId} value={view.viewId}>
                    {describeView(view)} · {shortId(view.imageId)}
                  </option>
                ))}
              </select>
            </label>
            <label className="inventory-label">
              Concept
              <select
                className="inventory-select"
                value={effectiveConcept?.id ?? ""}
                disabled={stale || busy}
                onChange={(event) => setConceptId(event.target.value)}
              >
                {enabledConcepts.map((concept) => (
                  <option key={concept.id} value={concept.id}>
                    {concept.text}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="search-hint">
            One model call: transmits this view to Meta and uses model credits.
          </p>
          <div className="inventory-actions">
            <button
              type="button"
              className="toolbar-button toolbar-button--primary"
              disabled={stale || busy || !effectiveView || !effectiveConcept}
              onClick={() => {
                setTestError(null);
                if (effectiveView && effectiveConcept) setTestError(sessions.runTest(effectiveView.viewId, effectiveConcept.id));
              }}
            >
              {busy ? "Testing…" : "Test prompt on this view"}
            </button>
            {busy && (
              <button type="button" className="toolbar-button" onClick={sessions.cancelBatch}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {testError && (
        <p className="search-status error-text" role="alert">
          {testError}
        </p>
      )}
      {failed && (
        <div className="search-status error-text" role="alert">
          <p>Test failed: {failed.error ?? "unknown error"} A failed test is not zero matches.</p>
          <button
            type="button"
            className="toolbar-button toolbar-button--small"
            disabled={stale || busy}
            onClick={() => latestTest && setTestError(sessions.retryFailed(latestTest.runId))}
          >
            Retry test
          </button>
        </div>
      )}
      <StagedPreview session={session} sessions={sessions} viewMedia={props.viewMedia} stale={stale} onError={setTestError} />
    </div>
  );
}

function BatchPanel(props: {
  session: WorkflowSession;
  sessions: InventorySessions;
  sam: SamStatus;
  stale: boolean;
  busy: boolean;
}) {
  const { session, sessions, sam, stale, busy } = props;
  const views = session.viewOrder.length;
  const concepts = session.concepts.filter((concept) => concept.enabled);
  const calls = views * concepts.length;
  const samTexts = Object.values(session.observations).filter(
    (observation) => observation.origin === "sam-text",
  );
  const [replace, setReplace] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const blocked = samBlockReason(sam);
  const latestBatch = [...session.runs].reverse().find((run) => run.kind === "batch");
  const finished = latestBatch?.items.filter((item) => item.status === "succeeded" || item.status === "empty").length ?? 0;
  const failedCount = latestBatch?.items.filter((item) => item.status === "failed" || item.status === "cancelled").length ?? 0;
  const interruptedCount = latestBatch?.items.filter((item) => item.status === "interrupted").length ?? 0;
  const resumable = latestBatch?.items.some((item) => item.status === "failed" || item.status === "cancelled" || item.status === "interrupted") ?? false;

  return (
    <div>
      <h4 className="settings-heading">Detect selected views</h4>
      {blocked ? (
        <p className="search-status" role="status">
          {blocked} Manual annotation in Review stays available.
        </p>
      ) : (
        <>
          <p className="search-hint" role="status">
            {views} view{views === 1 ? "" : "s"} × {concepts.length} concept{concepts.length === 1 ? "" : "s"} ={" "}
            {calls} model call{calls === 1 ? "" : "s"} (cap {MAX_CALLS_PER_BATCH}).
          </p>
          {samTexts.length > 0 && (
            <label className="inventory-check">
              <input
                type="checkbox"
                checked={replace}
                disabled={stale || busy}
                onChange={(event) => setReplace(event.target.checked)}
              />
              Replace previous text-prompt output — drops {samTexts.length} sighting
              {samTexts.length === 1 ? "" : "s"}, keeps manual and corrected work, unconfirms
              affected assets.
            </label>
          )}
          <div className="inventory-actions">
            <button
              type="button"
              className="toolbar-button toolbar-button--primary"
              disabled={stale || busy || views === 0 || concepts.length === 0 || calls > MAX_CALLS_PER_BATCH || (samTexts.length > 0 && !replace)}
              onClick={() => {
                setBatchError(null);
                setBatchError(sessions.runBatch(replace));
                setReplace(false);
              }}
            >
              {samTexts.length > 0 ? "Replace and detect" : "Detect selected views"}
            </button>
            {busy && (
              <button type="button" className="toolbar-button" onClick={sessions.cancelBatch}>
                Cancel batch
              </button>
            )}
          </div>
        </>
      )}
      {batchError && (
        <p className="search-status error-text" role="alert">
          {batchError}
        </p>
      )}
      {latestBatch && (
        <div className="batch-progress">
          <p className="search-status" role="status" aria-live="polite">
            {finished} of {latestBatch.items.length} calls produced results
            {failedCount > 0 ? ` · ${failedCount} failed or cancelled` : ""}
            {interruptedCount > 0 ? ` · ${interruptedCount} interrupted` : ""}
            {latestBatch.cancelled ? " · partial batch (cancelled)" : ""}
            {interruptedCount > 0 && !latestBatch.finishedAt ? " · interrupted (recovery pending)" : ""}
            {!latestBatch.finishedAt && interruptedCount === 0 ? " · running…" : ""}
          </p>
          <ul className="batch-items">
            {latestBatch.items.map((item: DetectionItem) => {
              const view = session.views[item.viewId];
              const retryable =
                item.status === "failed" || item.status === "cancelled" || item.status === "interrupted";
              return (
                <li key={item.itemId}>
                  {view ? describeView(view) : item.viewId} · {item.conceptText} —{" "}
                  <strong>{DETECTION_ITEM_STATUS_LABELS[item.status]}</strong>
                  {(item.status === "succeeded" || item.status === "empty") &&
                    ` (${item.objects.length} match${item.objects.length === 1 ? "" : "es"})`}
                  {item.status === "failed" && item.error ? `: ${item.error}` : ""}
                  {item.status === "interrupted" && item.error ? `: ${item.error}` : ""}
                  <ItemOutcomeNotes sessions={sessions} runId={latestBatch.runId} item={item} />
                  {retryable && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="link-button"
                        disabled={stale || busy}
                        onClick={() => setBatchError(sessions.retryItem(latestBatch.runId, item.itemId))}
                      >
                        Retry
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {resumable && (
            <div className="inventory-actions">
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                disabled={stale || busy}
                onClick={() => setBatchError(sessions.retryFailed(latestBatch.runId))}
              >
                {latestBatch.items.some((item) => item.status === "failed")
                  ? "Retry failed"
                  : "Resume run"}
              </button>
            </div>
          )}
        </div>
      )}
      <CompletionSection session={session} sessions={sessions} stale={stale} busy={busy} />
    </div>
  );
}

function CompletionSection(props: {
  session: WorkflowSession;
  sessions: InventorySessions;
  stale: boolean;
  busy: boolean;
}) {
  const { session } = props;
  const views = session.viewOrder.map((viewId) => session.views[viewId]).filter(Boolean);
  if (views.length === 0 || session.concepts.length === 0) return null;
  const states = new Map<string, ReturnType<typeof viewConceptStates>>();
  const completion = new Map<string, ReturnType<typeof assessViewCompletion>>();
  let partial = 0;
  let outstanding = 0;
  for (const view of views) {
    const rows = viewConceptStates(session, view.viewId);
    states.set(view.viewId, rows);
    const assessment = assessViewCompletion(session, view.viewId);
    completion.set(view.viewId, assessment);
    if (assessment !== "succeeded" && rows.length > 0) {
      partial += 1;
      outstanding += rows.filter((row) => row.outcome !== "usable").length;
    }
  }
  return (
    <div className="batch-completion">
      <h4 className="settings-heading">Completion</h4>
      <p className="search-status" role="status">
        {partial === 0
          ? "All views complete."
          : `${partial} partial view${partial === 1 ? "" : "s"} · ${outstanding} outstanding concept${outstanding === 1 ? "" : "s"}.`}
      </p>
      {partial > 0 && (
        <ul className="batch-items">
          {views
            .filter((view) => completion.get(view.viewId) !== "succeeded")
            .map((view) => (
              <li key={view.viewId}>
                {describeView(view)} ({completion.get(view.viewId)}):{" "}
                {(states.get(view.viewId) ?? [])
                  .map((row) =>
                    row.outcome === "usable"
                      ? `“${row.conceptText}” complete`
                      : `“${row.conceptText}” ${row.outcome}${
                          row.item ? ` (${DETECTION_ITEM_STATUS_LABELS[row.item.status]})` : ""
                        }`,
                  )
                  .join(" · ")}
              </li>
            ))}
        </ul>
      )}
      {partial > 0 && (
        <p className="search-hint">
          Retry individual items above or re-run the outstanding concepts with “Detect selected
          views”.
        </p>
      )}
    </div>
  );
}

function RunHistoryPanel(props: { session: WorkflowSession; stale: boolean }) {
  const { session } = props;
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(RUN_HISTORY_PAGE);
  if (session.runs.length <= 1) return null;
  const runs = [...session.runs].reverse();
  return (
    <div className="run-history">
      <button
        type="button"
        className="link-button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide run history" : `Show run history (${session.runs.length} runs)`}
      </button>
      {open && (
        <>
          <ul className="batch-items">
            {runs.slice(0, visible).map((run) => {
              const ok = run.items.filter(
                (item) => item.status === "succeeded" || item.status === "empty",
              ).length;
              const failed = run.items.filter(
                (item) => item.status === "failed" || item.status === "cancelled" || item.status === "interrupted",
              ).length;
              const interrupted = run.items.some((item) => item.status === "interrupted");
              return (
                <li key={run.runId}>
                  {run.kind === "test" ? "Test" : "Batch"} · started{" "}
                  {new Date(run.createdAt).toLocaleString()} · {ok}/{run.items.length} results
                  {failed > 0 ? ` · ${failed} failed, cancelled, or interrupted` : ""}
                  {run.cancelled ? " · cancelled" : ""}
                  {interrupted ? " · interrupted" : ""}
                </li>
              );
            })}
          </ul>
          {visible < runs.length && (
            <div className="inventory-actions">
              <button
                type="button"
                className="toolbar-button toolbar-button--small"
                onClick={() => setVisible((value) => value + RUN_HISTORY_PAGE)}
              >
                Show more ({runs.length - visible} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EvaluationPanel(props: { session: WorkflowSession; sessions: InventorySessions; stale: boolean }) {
  const { session, sessions, stale } = props;
  const latestBatch = [...session.runs].reverse().find((run) => run.kind === "batch");
  const views = session.viewOrder.map((viewId) => session.views[viewId]).filter(Boolean);
  if (!latestBatch) return null;
  return (
    <div>
      <h4 className="settings-heading">Prompt check (latest batch)</h4>
      <table className="eval-table">
        <thead>
          <tr>
            <th scope="col">View</th>
            <th scope="col">Returned</th>
            <th scope="col">Accepted</th>
            <th scope="col">Rejected</th>
            <th scope="col">Deferred</th>
            <th scope="col">Manual</th>
            <th scope="col">Fully reviewed</th>
            <th scope="col">Precision / recall</th>
          </tr>
        </thead>
        <tbody>
          {views.map((view) => {
            const items = latestBatch.items.filter((item) => item.viewId === view.viewId);
            const returned = items
              .filter((item) => item.status === "succeeded")
              .reduce((total, item) => total + item.objects.length, 0);
            const onView = Object.values(session.observations).filter(
              (observation) => observation.viewId === view.viewId,
            );
            const sam = onView.filter(
              (observation) => observation.origin === "sam-text" || observation.origin === "sam-assisted",
            );
            const accepted = sam.filter((observation) => observation.decision === "accepted").length;
            const rejected = sam.filter((observation) => observation.decision === "rejected").length;
            const deferred = sam.filter((observation) => observation.decision === "deferred").length;
            const pending = sam.filter((observation) => observation.decision === "pending").length;
            const manual = onView.filter((observation) => observation.origin === "manual").length;
            const assisted = sam.filter(
              (observation) => observation.origin === "sam-assisted" && observation.decision === "accepted",
            ).length;
            let score = "—";
            let reason = "";
            if (!view.fullyReviewed) reason = "mark fully reviewed";
            else if (pending > 0) reason = "resolve pending first";
            else if (accepted + rejected + manual === 0) reason = "no sightings";
            else {
              const precision = accepted + rejected > 0 ? accepted / (accepted + rejected) : null;
              const recall = accepted + manual > 0 ? accepted / (accepted + manual) : null;
              const format = (value: number | null): string => (value === null ? "—" : value.toFixed(2));
              score = `${format(precision)} / ${format(recall)}`;
              reason = `n=${accepted + rejected + manual}`;
            }
            return (
              <tr key={view.viewId}>
                <td>
                  {describeView(view)} · {shortId(view.imageId)}
                </td>
                <td>{returned}</td>
                <td>
                  {accepted}
                  {assisted > 0 ? ` (${assisted} ${OBSERVATION_ORIGIN_LABELS["sam-assisted"].toLowerCase()})` : ""}
                </td>
                <td>{rejected}</td>
                <td>{deferred}</td>
                <td>{manual}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={view.fullyReviewed}
                    disabled={stale}
                    onChange={() =>
                      sessions.dispatch({
                        type: "VIEW_SET_REVIEWED",
                        viewId: view.viewId,
                        fullyReviewed: !view.fullyReviewed,
                      })
                    }
                    aria-label={`Mark ${describeView(view)} fully reviewed`}
                  />
                </td>
                <td>
                  {score}
                  {reason ? ` (${reason})` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="search-hint">
        Precision = accepted ÷ (accepted + rejected); recall = accepted ÷ (accepted + manual
        additions). Scores cover this reviewed sample only — never detection quality in general.
      </p>
    </div>
  );
}

export function DetectReal(props: DetectRealProps) {
  const { session, sessions, stale } = props;
  const busy = sessions.busyKeys.includes(session.key);
  const hasManifest = session.manifest !== null;
  return (
    <div className="detect-step">
      <DetectSources
        session={session}
        sessions={sessions}
        stale={stale}
        poolImages={props.poolImages}
        sequenceOptions={props.sequenceOptions}
        currentSequenceId={props.currentSequenceId}
        currentImageId={props.currentImageId}
        viewMedia={props.viewMedia}
      />
      {hasManifest && (
        <>
          <ConceptsEditor session={session} sessions={sessions} stale={stale} busy={busy} />
          <TestPanel
            session={session}
            sessions={sessions}
            viewMedia={props.viewMedia}
            sam={props.sam}
            stale={stale}
            busy={busy}
          />
          <BatchPanel session={session} sessions={sessions} sam={props.sam} stale={stale} busy={busy} />
          <RunHistoryPanel session={session} stale={stale} />
          <EvaluationPanel session={session} sessions={sessions} stale={stale} />
        </>
      )}
      <div className="inventory-actions">
        <button
          type="button"
          className="toolbar-button"
          onClick={() => sessions.dispatch({ type: "SET_STEP", step: "review" })}
        >
          {hasManifest ? "Continue to Review" : "Continue without detection"}
        </button>
      </div>
      {session.finishedPreview && (
        <p className="search-hint">A finished preview exists — edits will reopen review.</p>
      )}
    </div>
  );
}
