import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageResult } from "../../lib/searchTypes";
import { InventoryWorkspace } from "./InventoryWorkspace";
import { useInventorySessions, type InventorySessions } from "./useInventorySessions";
import type { SamStatus } from "./useSamStatus";
import { useViewMedia } from "./useViewMedia";

const LIVE = { roiRevision: 1, runId: "prep-1", fingerprint: "aaa" };
const RING = [
  [19.04, 47.495],
  [19.045, 47.495],
  [19.045, 47.5],
  [19.04, 47.5],
  [19.04, 47.495],
] as [number, number][];

function poolImage(id: string): ImageResult {
  return {
    id,
    coordinate: [19.042, 47.497],
    coordinateSource: "geometry",
    originalCoordinate: null,
    computedCoordinate: null,
    capturedAt: 1700000000000,
    isPano: false,
    sequenceId: "seq-1",
    inRoi: true,
  };
}

interface HarnessProps {
  api: { current: InventorySessions | null };
  live: { roiRevision: number; runId: string; fingerprint: string } | null;
  poolImages: ImageResult[];
  onSelectImage: (id: string) => void;
  onOpenResults: () => void;
}

const OFFLINE_SAM: SamStatus = {
  readiness: { status: "not-configured", model: "sam-3.1" },
  model: "sam-3.1",
  testing: false,
  lastTest: null,
  testOnImage: async () => ({
    at: "2026-11-03T12:00:00.000Z",
    ok: false,
    objects: 0,
    truncated: false,
    message: "offline",
    imageId: "",
    concept: "",
  }),
};

function Harness(props: HarnessProps) {
  const sessions = useInventorySessions({ liveContext: props.live, roiRing: RING });
  const viewMedia = useViewMedia();
  props.api.current = sessions;
  return (
    <InventoryWorkspace
      sessions={sessions}
      poolImages={props.poolImages}
      onSelectImage={props.onSelectImage}
      onOpenResults={props.onOpenResults}
      sequenceOptions={[{ sequenceId: "seq-1", count: props.poolImages.length }]}
      currentSequenceId={null}
      currentImageId={null}
      viewMedia={viewMedia}
      sam={OFFLINE_SAM}
    />
  );
}

function setup(poolImages: ImageResult[] = []) {
  const api: { current: InventorySessions | null } = { current: null };
  const onSelectImage = vi.fn();
  const onOpenResults = vi.fn();
  const utils = render(
    <Harness api={api} live={LIVE} poolImages={poolImages} onSelectImage={onSelectImage} onOpenResults={onOpenResults} />,
  );
  return { ...utils, api, onSelectImage, onOpenResults };
}

function cardFor(container: HTMLElement, id: string): HTMLElement {
  const list = container.querySelector(".obs-list");
  if (!list) throw new Error("observation list not found");
  const card = within(list as HTMLElement).getByText(id).closest("li");
  if (!card) throw new Error(`card for ${id} not found`);
  return card as HTMLElement;
}

function goStep(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("InventoryWorkspace demo walkthrough", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs detect → review → group → place → finish → results fully offline", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("demo must not fetch");
    });
    const { container, api, onSelectImage, onOpenResults } = setup();
    act(() => {
      api.current!.openDemo();
    });
    expect(screen.getByText(/Demo workflow — sample observations, no AI has run/)).toBeTruthy();
    expect(screen.getByText(/Temporary session — refresh loses this work/)).toBeTruthy();

    // Detect: run the deterministic adapter over all three illustrations.
    fireEvent.click(screen.getByRole("button", { name: "Run demo detection (3 images)" }));
    await waitFor(() => {
      expect(screen.getByText("Returned 11 sample observations.")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review" }));

    // Review: accept the poles and heads, reject the distractor, defer the blob.
    for (const id of ["demo-obs-01", "demo-obs-02", "demo-obs-03", "demo-obs-04", "demo-obs-05", "demo-obs-06", "demo-obs-07", "demo-obs-09", "demo-obs-10"]) {
      fireEvent.click(within(cardFor(container, id)).getByRole("button", { name: "Accept" }));
    }
    fireEvent.click(within(cardFor(container, "demo-obs-11")).getByRole("button", { name: "Reject" }));
    fireEvent.click(within(cardFor(container, "demo-obs-08")).getByRole("button", { name: "Defer" }));
    goStep("3 Group assets");

    // Group: four assets, both luminaires attached to the double-arm pole.
    const obsList = container.querySelector(".group-obs-list") as HTMLElement;
    const checkObs = (id: string) => {
      fireEvent.click(within(within(obsList).getByText(id).closest("li")!).getByRole("checkbox"));
    };
    const createAsset = (ids: string[]) => {
      for (const id of ids) checkObs(id);
      fireEvent.click(screen.getByRole("button", { name: "Create asset from selection" }));
    };
    createAsset(["demo-obs-01", "demo-obs-05", "demo-obs-09"]);
    createAsset(["demo-obs-04", "demo-obs-06"]);
    createAsset(["demo-obs-02", "demo-obs-07"]);
    createAsset(["demo-obs-03", "demo-obs-10"]);
    for (const assetId of ["asset-3", "asset-4"]) {
      const card = screen.getByLabelText(`Select ${assetId} for merging`).closest("li")!;
      fireEvent.change(within(card).getByLabelText(`Support for ${assetId}`), {
        target: { value: "pole:asset-1" },
      });
      fireEvent.click(within(card).getByText("Attach luminaire to support"));
    }
    goStep("4 Place assets");

    // Place: diagram click for the pole, keyboard entry for the second, inherit the heads.
    const assetSelect = screen.getByLabelText("Asset") as HTMLSelectElement;
    expect(assetSelect.value).toBe("asset-1");
    fireEvent.click(screen.getByRole("button", { name: "Place on map" }));
    const diagram = container.querySelector(".demo-diagram")!;
    vi.spyOn(diagram, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.click(diagram, { clientX: 200, clientY: 200 });
    expect(screen.getByText(/diagram 50\.0, 50\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply placement" }));
    fireEvent.change(assetSelect, { target: { value: "asset-2" } });
    fireEvent.change(screen.getByLabelText("X (0–100)"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Y (0–100)"), { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "Place from coordinates" }));
    for (const assetId of ["asset-3", "asset-4"]) {
      fireEvent.change(screen.getByLabelText("Asset"), { target: { value: assetId } });
      fireEvent.click(screen.getByRole("button", { name: "Use support location" }));
    }
    goStep("5 Inventory");

    // Inventory: confirm everything, acknowledge the deferred blob, finish.
    for (const button of screen.getAllByRole("button", { name: "Confirm asset" })) {
      fireEvent.click(button);
    }
    fireEvent.click(screen.getByRole("checkbox", { name: /acknowledge/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finish preview" }));
    await waitFor(() => {
      expect(screen.getByText(/Finished preview from/)).toBeTruthy();
    });
    expect(screen.getByText(/2 poles · 2 luminaires \(counted separately\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open demo results preview" }));
    expect(onOpenResults).toHaveBeenCalledTimes(1);

    // Demo isolation: no Mapillary loads, no storage writes, no fetches.
    expect(onSelectImage).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    vi.unstubAllGlobals();
  }, 30000);

  it("syncs inventory rows with diagram pins in both directions", async () => {
    const { api } = setup();
    act(() => {
      api.current!.openDemo();
    });
    act(() => {
      api.current!.runDetection("happy", ["demo-image-01"], false);
    });
    await waitFor(() => {
      expect(screen.getByText("Returned 4 sample observations.")).toBeTruthy();
    });
    act(() => {
      const sessions = api.current!;
      sessions.dispatch({ type: "OBS_DECIDE", id: "demo-obs-01", decision: "accepted" });
      sessions.dispatch({ type: "OBS_DECIDE", id: "demo-obs-04", decision: "accepted" });
      sessions.dispatch({ type: "ASSET_CREATE", observationIds: ["demo-obs-01"] });
      sessions.dispatch({ type: "ASSET_CREATE", observationIds: ["demo-obs-04"] });
      sessions.dispatch({
        type: "PLACE",
        assetId: "asset-1",
        placement: { kind: "diagram", x: 20, y: 30 },
      });
      sessions.dispatch({
        type: "PLACE",
        assetId: "asset-2",
        placement: { kind: "diagram", x: 60, y: 70 },
      });
      sessions.dispatch({ type: "SET_STEP", step: "inventory" });
    });
    const rowLink1 = screen.getByRole("button", { name: "asset-1" });
    const row1 = rowLink1.closest("tr")!;
    const row2 = screen.getByRole("button", { name: "asset-2" }).closest("tr")!;
    // Row click highlights the matching diagram pin.
    fireEvent.click(rowLink1);
    expect(row1.className).toContain("result-row--highlight");
    expect(
      screen
        .getByRole("button", { name: "Highlight asset-1 (pole)" })
        .querySelector("polygon")!
        .getAttribute("stroke"),
    ).toBe("#0b3b47");
    // Pin click moves the highlight to the other row.
    fireEvent.click(screen.getByRole("button", { name: "Highlight asset-2 (pole)" }));
    expect(row2.className).toContain("result-row--highlight");
    expect(row1.className).not.toContain("result-row--highlight");
  });

  it("explains mixed selections, previews merges, and undoes grouping", async () => {
    const { container, api } = setup();
    act(() => {
      api.current!.openDemo();
    });
    // Narrow detection to the first illustration (4 observations).
    for (const imageId of ["demo-image-02", "demo-image-03"]) {
      const label = screen.getByText(new RegExp(`${imageId}$`)).closest("label")!;
      fireEvent.click(within(label as HTMLElement).getByRole("checkbox"));
    }
    fireEvent.click(screen.getByRole("button", { name: "Run demo detection (1 image)" }));
    await waitFor(() => {
      expect(screen.getByText("Returned 4 sample observations.")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review" }));
    for (const id of ["demo-obs-01", "demo-obs-02", "demo-obs-03", "demo-obs-04"]) {
      fireEvent.click(within(cardFor(container, id)).getByRole("button", { name: "Accept" }));
    }
    goStep("3 Group assets");

    const obsList = container.querySelector(".group-obs-list") as HTMLElement;
    const checkObs = (id: string) => {
      fireEvent.click(within(within(obsList).getByText(id).closest("li")!).getByRole("checkbox"));
    };
    checkObs("demo-obs-01");
    checkObs("demo-obs-02"); // pole + luminaire: related, not duplicates
    expect(screen.getByText(/related objects, not duplicates/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create asset from selection" })).toHaveProperty("disabled", true);
    checkObs("demo-obs-02");
    checkObs("demo-obs-04");
    fireEvent.click(screen.getByRole("button", { name: "Create asset from selection" }));
    checkObs("demo-obs-02");
    fireEvent.click(screen.getByRole("button", { name: "Create asset from selection" }));

    // Split asset-1, then merge the parts back with a preview + undo.
    expect(screen.getByLabelText("Select asset-1 for merging")).toBeTruthy();
    const assetCard = screen.getByLabelText("Select asset-1 for merging").closest("li")!;
    fireEvent.click(within(assetCard as HTMLElement).getByRole("button", { name: "Split…" }));
    fireEvent.click(within(assetCard as HTMLElement).getByLabelText("demo-obs-04"));
    fireEvent.click(within(assetCard as HTMLElement).getByRole("button", { name: "Split into new asset" }));
    fireEvent.click(screen.getByLabelText("Select asset-1 for merging"));
    fireEvent.click(screen.getByLabelText("Select asset-3 for merging"));
    fireEvent.click(screen.getByRole("button", { name: "Merge assets…" }));
    expect(screen.getByText(/2 observations in asset-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply merge" }));
    expect(screen.queryByLabelText("Select asset-3 for merging")).toBeNull();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.getAttribute("title")).toContain("Merge into asset-1");
    fireEvent.click(undo);
    expect(screen.getByLabelText("Select asset-3 for merging")).toBeTruthy();

    // Category edits while assigned stay blocked until detached.
    goStep("2 Review");
    fireEvent.click(within(cardFor(container, "demo-obs-01")).getByRole("button", { name: "Edit" }));
    const categorySelect = within(cardFor(container, "demo-obs-01")).getByLabelText("Category") as HTMLSelectElement;
    expect(categorySelect.disabled).toBe(true);
    expect(categorySelect.title).toContain("Detach");
  }, 30000);

  it("walks a manual street from empty detection to keyboard-placed finish", () => {
    const { container, api, onSelectImage, onOpenResults } = setup([poolImage("img-1"), poolImage("img-2")]);
    act(() => {
      api.current!.openStreet("street-1", "Main Street");
    });
    expect(screen.getByText("Manual preview — no model detections")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue without detection" }));
    const addForm = within(container.querySelector(".obs-add") as HTMLElement);
    fireEvent.change(addForm.getByLabelText("Source image"), { target: { value: "img-1" } });
    fireEvent.change(addForm.getByLabelText("Category"), { target: { value: "luminaire" } });
    fireEvent.change(addForm.getByLabelText("Description"), { target: { value: "corner head" } });
    fireEvent.click(screen.getByRole("button", { name: "Add observation" }));
    fireEvent.click(screen.getByRole("button", { name: "Add observation" }));
    // Manual observations accept without pixel annotation.
    const cards = document.querySelectorAll(".obs-card");
    expect(cards.length).toBe(1);
    fireEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: "Accept" }));
    goStep("3 Group assets");
    fireEvent.click(screen.getByRole("checkbox", { name: /obs-1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create asset from selection" }));
    const assetCard = screen.getByLabelText("Select asset-1 for merging").closest("li")!;
    fireEvent.change(within(assetCard as HTMLElement).getByLabelText("Support for asset-1"), {
      target: { value: "wall" },
    });
    fireEvent.click(within(assetCard as HTMLElement).getByText("Attach luminaire to support"));
    goStep("4 Place assets");
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "47.0" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "19.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Place from coordinates" }));
    expect(screen.getByRole("alert").textContent).toContain("inside the current region");
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "47.497" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "19.042" } });
    fireEvent.click(screen.getByRole("button", { name: "Place from coordinates" }));
    goStep("5 Inventory");
    fireEvent.click(screen.getByRole("button", { name: "Confirm asset" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish preview" }));
    expect(screen.getByText(/Finished preview from/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open results preview" }));
    expect(onOpenResults).toHaveBeenCalledTimes(1);
    expect(onSelectImage).not.toHaveBeenCalled();
    expect(api.current!.sessions["street-1"].finishedPreview?.counts.luminaires).toBe(1);
  });

  it("requires rectangles for demo accepts, confirms resets, and freezes stale work", async () => {
    const { container, api } = setup();
    act(() => {
      api.current!.openDemo();
    });
    // Clean sessions reset without a confirmation step.
    fireEvent.click(screen.getByRole("button", { name: "Reset this preview" }));
    expect(screen.queryByText("Confirm reset")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run demo detection (3 images)" }));
    await waitFor(() => {
      expect(screen.getByText("Returned 11 sample observations.")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "missed head" } });
    fireEvent.click(screen.getByRole("button", { name: "Add observation" }));
    const added = within(cardFor(container, "obs-1")).getByRole("button", { name: "Accept" }) as HTMLButtonElement;
    expect(added.disabled).toBe(true);
    expect(added.title).toContain("rectangle");
    act(() => {
      api.current!.dispatch({ type: "OBS_SET_RECT", id: "obs-1", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
    });
    expect((within(cardFor(container, "obs-1")).getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(false);

    // Edited work asks before reset; cancel keeps everything.
    fireEvent.click(screen.getByRole("button", { name: "Reset this preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cardFor(container, "obs-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset this preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    expect(screen.getByRole("button", { name: "Run demo detection (3 images)" })).toBeTruthy();
  }, 30000);
});
