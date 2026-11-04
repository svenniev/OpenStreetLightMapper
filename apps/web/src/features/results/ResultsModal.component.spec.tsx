import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  InventoryObservation,
  SessionPreviewResult,
  SourceView,
} from "../inventory/inventoryTypes";
import type { ViewMedia } from "../inventory/useViewMedia";
import {
  ResultsModal,
  type ResultOccurrenceEditing,
  type ResultsEvidence,
  type SavedResultMeta,
} from "./ResultsModal";
import type { PreviewExpectation, StreetInventoryResult } from "./resultTypes";

/**
 * Fixtures for the result-view boundary. No production code path supplies
 * these; they verify the modal contract for the future inventory stage.
 */
function completeResult(): StreetInventoryResult {
  return {
    streetId: "street-1",
    streetDisplayName: "Main Street",
    wayIds: [101, 102],
    roiRevision: 3,
    runId: "prep-3-1-1-r1",
    completedAt: "2026-11-03T11:00:00.000Z",
    records: [
      {
        assetId: "lamp-1",
        sourceImageIds: ["img-1", "img-2"],
        reviewState: "unreviewed",
        measurements: [
          { kind: "mounting height", value: 6, unit: "m" },
          { kind: "arm length", value: null, unit: null },
        ],
      },
      {
        assetId: "lamp-2",
        sourceImageIds: ["img-9"],
        reviewState: "accepted",
        measurements: [],
      },
    ],
    warnings: [],
  };
}

const expected = { streetId: "street-1", roiRevision: 3, runId: "prep-3-1-1-r1" };

function renderModal(payload: unknown, onClose: () => void = () => {}) {
  return render(
    <ResultsModal
      streetDisplayName="Main Street"
      expected={expected}
      payload={payload}
      onClose={onClose}
    />,
  );
}

describe("ResultsModal", () => {
  it("renders a matching completed result with provenance and units", () => {
    renderModal(completeResult());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Asset lamp-1 · review: unreviewed")).toBeTruthy();
    expect(screen.getAllByText(/Source images:/)).toHaveLength(2);
    expect(screen.getByText(/img-1, img-2/)).toBeTruthy();
    expect(screen.getByText(/mounting height:/)).toBeTruthy();
    expect(screen.getByText(/OSM way 101, OSM way 102/)).toBeTruthy();
    expect(screen.getByText("Inventory geometry alone is not EN 13201 compliance.")).toBeTruthy();
  });

  it("distinguishes zero-asset completion from no completed result", () => {
    const zero = { ...completeResult(), records: [] };
    const { unmount } = renderModal(zero);
    expect(
      screen.getByText("Completed inventory with zero assets recorded for this street."),
    ).toBeTruthy();
    unmount();

    renderModal(null);
    expect(
      screen.getByText(/No completed inventory result for this street yet\./),
    ).toBeTruthy();
  });

  it("refuses wrong-street, stale-run, and malformed payloads", () => {
    const cases: Array<[unknown, string]> = [
      [{ ...completeResult(), streetId: "other" }, "result is for a different street"],
      [{ ...completeResult(), roiRevision: 2 }, "result is for a different region revision or run"],
      [{ ...completeResult(), runId: "prep-3-1-1-r0" }, "result is for a different region revision or run"],
      [{ ...completeResult(), records: [{ nope: true }] }, "malformed inventory records"],
      [{ nope: true }, "result is for a different street"],
      ["not-an-object", "malformed result payload"],
    ];
    for (const [payload, reason] of cases) {
      const { unmount } = renderModal(payload);
      expect(screen.getByRole("alert").textContent).toContain(reason);
      // The refused payload never renders its records.
      expect(screen.queryByText(/Asset lamp-1/)).toBeNull();
      unmount();
    }
  });

  it("closes on Escape and returns focus to the opener", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <div>
        <button type="button">Results</button>
      </div>,
    );
    const opener = screen.getByText("Results");
    opener.focus();
    rerender(
      <div>
        <button type="button">Results</button>
        <ResultsModal
          streetDisplayName="Main Street"
          expected={expected}
          payload={completeResult()}
          onClose={onClose}
        />
      </div>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing the modal restores focus to the originating control.
    rerender(
      <div>
        <button type="button">Results</button>
      </div>,
    );
    expect(document.activeElement).toBe(opener);
  });

  it("contains Tab focus inside the dialog", () => {
    renderModal(completeResult());
    const close = screen.getByText("Close");
    expect(document.activeElement).toBe(close);
    // A single focusable control wraps to itself.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("closes via the Close button and backdrop click", () => {
    const onClose = vi.fn();
    const { unmount } = renderModal(completeResult(), onClose);
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const onClose2 = vi.fn();
    const { container } = renderModal(completeResult(), onClose2);
    const backdrop = container.querySelector(".modal-backdrop");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose2).toHaveBeenCalledTimes(1);
  });
});

function previewPayload(mode: "demo" | "manual"): SessionPreviewResult {
  return {
    kind: "session-preview",
    mode,
    sessionId: mode === "demo" ? "demo" : "s-street-1",
    streetId: mode === "demo" ? "demo-street" : "street-1",
    streetDisplayName: mode === "demo" ? "Demo Street" : "Main Street",
    streetSource: mode === "demo" ? "synthetic-demo" : "osm",
    origins: mode === "demo" ? ["demo"] : ["manual"],
    model: null,
    processing: { views: 0, succeededViews: 0, failedViews: 0, unprocessedViews: 0, partialViews: 0, truncatedItems: 0, interruptedItems: 0, invalidDiscarded: 0, concepts: [] },
    roiRevision: mode === "demo" ? null : 3,
    runId: mode === "demo" ? null : "prep-3-1-1-r1",
    fingerprint: mode === "demo" ? null : "abc123",
    finishedAt: "2026-11-03T12:00:00.000Z",
    assets: [
      {
        assetId: "asset-1",
        category: "pole",
        support: null,
        position: { kind: "unknown" },
        positionMethod: "unknown",
        observationIds: ["obs-1", "obs-2"],
        imageIds: ["img-1"],
        reviewState: "confirmed",
        streetSource: mode === "demo" ? "synthetic-demo" : "osm",
        note: "",
      },
      {
        assetId: "asset-2",
        category: "luminaire",
        support: { kind: "pole", poleAssetId: "asset-1" },
        position: { kind: "inherited", fromAssetId: "asset-1" },
        positionMethod: "inherited",
        observationIds: ["obs-3"],
        imageIds: ["img-1", "img-2"],
        reviewState: "confirmed",
        streetSource: mode === "demo" ? "synthetic-demo" : "osm",
        note: "",
      },
    ],
    counts: { poles: 1, luminaires: 1, placed: 0, unplaced: 2, deferred: 1, observations: 4 },
    limitations: ["Manual preview — no model detections were used.", "Unsaved preview — use Save reviewed result to keep it durably."],
    temporary: true,
  };
}

function previewExpected(mode: "demo" | "manual"): PreviewExpectation {
  return {
    streetId: mode === "demo" ? "demo-street" : "street-1",
    sessionId: mode === "demo" ? "demo" : "s-street-1",
    roiRevision: mode === "demo" ? null : 3,
    runId: mode === "demo" ? null : "prep-3-1-1-r1",
    fingerprint: mode === "demo" ? null : "abc123",
  };
}

function renderPreview(
  mode: "demo" | "manual",
  overrides: {
    payload?: unknown;
    expected?: PreviewExpectation | null;
    onReturnToReview?: (() => void) | null;
    evidence?: ResultsEvidence | null;
    savedMeta?: SavedResultMeta | null;
    occurrenceEditing?: ResultOccurrenceEditing | null;
  } = {},
) {
  const payload = overrides.payload !== undefined ? overrides.payload : previewPayload(mode);
  return render(
    <ResultsModal
      streetDisplayName={mode === "demo" ? "Demo Street" : "Main Street"}
      expected={{ streetId: "street-1", roiRevision: 3, runId: "prep-3-1-1-r1" }}
      payload={payload}
      previewExpected={overrides.expected !== undefined ? overrides.expected : previewExpected(mode)}
      evidence={overrides.evidence ?? null}
      savedMeta={overrides.savedMeta ?? null}
      occurrenceEditing={overrides.occurrenceEditing ?? null}
      onReturnToReview={overrides.onReturnToReview ?? null}
      onClose={() => {}}
    />,
  );
}

function readyViewMedia(imageId: string, handle: string): ViewMedia {
  const detail = {
    image: {
      imageId,
      sequenceId: "seq-1",
      capturedAt: 1700000000000,
      isPano: false,
      compassAngle: 90,
      creator: "tester",
      attribution: "© Mapillary contributors — tester",
      sourceUrl: `https://www.mapillary.com/map/im/${imageId}`,
      cameraPosition: { lng: 19.04, lat: 47.49 },
      coordinateSource: "computed_geometry" as const,
      resolution: "2048px thumbnail",
    },
    media: { handle, url: `/api/imagery/media/${handle}`, expiresAt: "2026-11-03T13:00:00.000Z" },
  };
  return {
    states: { [imageId]: { status: "ready", detail } },
    ensureImage: async () => detail,
    refreshImage: async () => detail,
    mediaUrl: (entry: string) => `/api/imagery/media/${entry}`,
  };
}

describe("ResultsModal session previews", () => {
  it("renders demo and manual previews with unmistakable mode labels", () => {
    const { unmount } = renderPreview("demo");
    expect(screen.getByText("Demo inventory preview — Demo Street")).toBeTruthy();
    expect(screen.getByText(/schematic sample data\. No AI has run\./)).toBeTruthy();
    expect(screen.getByText("Not saved — temporary preview.")).toBeTruthy();
    expect(screen.getByText(/1 pole · 1 luminaire \(counted separately\)/)).toBeTruthy();
    unmount();

    renderPreview("manual");
    expect(screen.getByText("Session preview — Main Street")).toBeTruthy();
    expect(screen.getByText(/Manual session preview — no model detections were used\./)).toBeTruthy();
  });

  it("shows provenance, processing, and the work-area warning", () => {
    const payload = previewPayload("manual");
    payload.streetSource = "manual-work-area";
    payload.origins = ["sam-text", "manual"];
    payload.model = "sam-3.1";
    payload.processing = {
      views: 2,
      succeededViews: 1,
      failedViews: 0,
      unprocessedViews: 0,
      partialViews: 1,
      truncatedItems: 1,
      interruptedItems: 0,
      invalidDiscarded: 0,
      concepts: ["street light pole"],
    };
    payload.limitations = [
      "Assisted by sam-3.1 text-prompt detection; every sighting was manually reviewed.",
      "Street assignment unverified — a manual imagery work area, not an OpenStreetMap street.",
      "Unsaved preview — use Save reviewed result to keep it durably.",
    ];
    const { unmount } = renderPreview("manual", { payload });
    expect(screen.getByText(/SAM-assisted session preview/)).toBeTruthy();
    expect(screen.getByText(/Street unverified: a manual imagery work area/)).toBeTruthy();
    expect(screen.getByText("Street provenance")).toBeTruthy();
    expect(screen.getByText(/Manual work area — street unverified/)).toBeTruthy();
    expect(screen.getByText(/SAM text, Manual/)).toBeTruthy();
    expect(screen.getByText(/model sam-3\.1/)).toBeTruthy();
    expect(screen.getByText(/1 of 2 views fully produced results/)).toBeTruthy();
    expect(screen.getByText(/1 partial/)).toBeTruthy();
    expect(screen.getByText(/1 truncated/)).toBeTruthy();
    unmount();
  });

  it("opens photo evidence for expanded assets", () => {
    const observation: InventoryObservation = {
      id: "obs-1",
      imageId: "img-1",
      viewId: "view-img-1-crop-1",
      category: "pole",
      description: "a pole",
      imageRegion: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      mask: null,
      maskStale: false,
      origin: "sam-text",
      provenance: {
        provider: "meta-sam",
        model: "sam-3.1",
        prompt: "street light pole",
        categoryIntent: "pole",
        runId: "run-1",
        itemId: "run-1-item-1",
        requestId: "req-1",
        providerObjectId: "0",
        confidence: 0.9,
        geometrySource: "model",
      },
      mode: "manual",
      decision: "accepted",
      note: "",
    };
    const cropView: SourceView = {
      viewId: "view-img-1-crop-1",
      imageId: "img-1",
      fullWidth: 2000,
      fullHeight: 1000,
      orientation: 1,
      isPano: false,
      crop: { x: 0, y: 0, w: 0.5, h: 0.5 },
      width: 1000,
      height: 500,
      mediaHandle: "handle-img-1",
      artifactId: null,
      fullyReviewed: false,
    };
    renderPreview("manual", {
      evidence: {
        observations: { "obs-1": observation },
        views: { "view-img-1-crop-1": cropView },
        viewMedia: readyViewMedia("img-1", "handle-img-1"),
      },
    });
    fireEvent.click(screen.getAllByText("View evidence")[0]);
    const photo = screen.getByAltText("obs-1 (SAM text)") as HTMLImageElement;
    expect(photo.getAttribute("src")).toBe("/api/imagery/media/handle-img-1");
    // Crop-space rect (0.25..0.75) maps to full-photo space (0.125..0.375).
    const overlay = photo.parentElement?.querySelector("svg.evidence-thumb__overlay rect");
    expect(overlay?.getAttribute("x")).toBe("12.5");
    expect(overlay?.getAttribute("width")).toBe("25");
  });

  it("expands per-asset evidence and offers Return to review", () => {
    const onReturnToReview = vi.fn();
    renderPreview("manual", { onReturnToReview });
    expect(screen.queryByText(/Observations: obs-1, obs-2/)).toBeNull();
    fireEvent.click(screen.getAllByText("View evidence")[0]);
    expect(screen.getByText(/Observations: obs-1, obs-2/)).toBeTruthy();
    expect(screen.getByText(/Pole asset-1/)).toBeTruthy();
    fireEvent.click(screen.getByText("Return to review"));
    expect(onReturnToReview).toHaveBeenCalledTimes(1);
  });

  it("edits occurrence labels and unconfirms assets on live previews only", () => {
    const observation: InventoryObservation = {
      id: "obs-1",
      imageId: "img-1",
      viewId: null,
      category: "pole",
      description: "a pole",
      imageRegion: null,
      mask: null,
      maskStale: false,
      origin: "manual",
      provenance: null,
      mode: "manual",
      decision: "accepted",
      note: "old label",
    };
    const evidence: ResultsEvidence = {
      observations: { "obs-1": observation },
      views: {},
      viewMedia: readyViewMedia("img-1", "handle-img-1"),
    };
    const updateNote = vi.fn();
    const unconfirmAsset = vi.fn();
    const { unmount } = renderPreview("manual", {
      evidence,
      occurrenceEditing: { updateNote, unconfirmAsset },
    });
    fireEvent.click(screen.getAllByText("View evidence")[0]);
    const input = screen.getByLabelText("Label") as HTMLInputElement;
    expect(input.value).toBe("old label");
    expect(screen.getByText("Save label")).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "pole A" } });
    fireEvent.click(screen.getByText("Save label"));
    expect(updateNote).toHaveBeenCalledWith("obs-1", "pole A");
    fireEvent.click(screen.getByText("Unconfirm asset"));
    expect(unconfirmAsset).toHaveBeenCalledWith("asset-1");
    unmount();

    // Historical saved versions never offer editing.
    const onSelectVersion = vi.fn();
    renderPreview("manual", {
      evidence,
      occurrenceEditing: { updateNote, unconfirmAsset },
      savedMeta: {
        resultId: "r1",
        createdAt: "2026-11-03T12:00:00.000Z",
        history: [{ resultId: "r1", sessionRevision: 2, createdAt: "2026-11-03T12:00:00.000Z" }],
        draftAfterResult: true,
        onSelectVersion,
      },
    });
    expect(screen.getByText(/This result is saved as v1/)).toBeTruthy();
    expect(screen.getByText(/Draft changes since save\./)).toBeTruthy();
    fireEvent.click(screen.getAllByText("View evidence")[0]);
    expect(screen.queryByText("Save label")).toBeNull();
    expect(screen.queryByText("Unconfirm asset")).toBeNull();
  });

  it("refuses mismatched preview identity without showing assets", () => {
    const cases: Array<[unknown, PreviewExpectation | null, string]> = [
      [previewPayload("manual"), { ...previewExpected("manual"), streetId: "other" }, "different street or session"],
      [previewPayload("manual"), { ...previewExpected("manual"), fingerprint: "zzz" }, "different region revision or run"],
      [previewPayload("demo"), { ...previewExpected("manual") }, "different street or session"],
      [previewPayload("manual"), null, "no preview context"],
      [{ ...previewPayload("manual"), assets: [{ broken: true }] }, previewExpected("manual"), "malformed preview assets"],
    ];
    for (const [payload, expected, reason] of cases) {
      const { unmount } = renderPreview("manual", { payload, expected });
      expect(screen.getByRole("alert").textContent).toContain(reason);
      expect(screen.queryByText("asset-1")).toBeNull();
      unmount();
    }
  });
});
