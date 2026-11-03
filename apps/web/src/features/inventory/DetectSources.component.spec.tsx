import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageResult } from "../../lib/searchTypes";
import { createSession } from "./inventoryReducer";
import type { WorkflowSession } from "./inventoryTypes";
import type { InventorySessions } from "./useInventorySessions";
import { useViewMedia } from "./useViewMedia";
import { DetectSources } from "./DetectSources";

vi.mock("../../lib/detectionClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/detectionClient")>();
  return {
    ...original,
    measureMedia: vi.fn(async () => ({ width: 800, height: 600, orientation: 1 })),
  };
});

function poolImage(id: string, sequenceId: string | null, capturedAt: number | null, isPano: boolean | null): ImageResult {
  return {
    id,
    coordinate: [19.04, 47.49],
    coordinateSource: "computed_geometry",
    originalCoordinate: null,
    computedCoordinate: [19.04, 47.49],
    capturedAt,
    isPano,
    sequenceId,
  };
}

const POOL: ImageResult[] = [
  poolImage("img-1", "seq-1", Date.UTC(2024, 0, 10), false),
  poolImage("img-2", "seq-1", Date.UTC(2024, 0, 11), false),
  poolImage("img-3", "seq-1", Date.UTC(2024, 0, 12), true),
  poolImage("img-4", "seq-2", Date.UTC(2023, 5, 1), false),
  poolImage("img-5", "seq-2", null, null),
  poolImage("img-6", "seq-2", Date.UTC(2023, 5, 3), false),
];

function manualSession(): WorkflowSession {
  return createSession({
    key: "street-1",
    sessionId: "street-1",
    mode: "manual",
    streetId: "street-1",
    streetDisplayName: "Main Street",
    context: {
      streetId: "street-1",
      streetDisplayName: "Main Street",
      streetSource: "osm",
      roiRevision: 1,
      runId: "prep-1",
      fingerprint: "aaa",
    },
  });
}

function imageryBody(imageId: string): Record<string, unknown> {
  return {
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
      coordinateSource: "computed_geometry",
      resolution: "2048px thumbnail",
    },
    media: { handle: `handle-${imageId}`, url: `/api/imagery/media/handle-${imageId}`, expiresAt: "2026-11-03T13:00:00.000Z" },
  };
}

function Harness(props: {
  dispatch: (...args: unknown[]) => void;
  pool?: ImageResult[];
  currentImageId?: string | null;
}) {
  const viewMedia = useViewMedia();
  return (
    <DetectSources
      session={manualSession()}
      sessions={{ dispatch: props.dispatch } as unknown as InventorySessions}
      stale={false}
      poolImages={props.pool ?? POOL}
      sequenceOptions={[
        { sequenceId: "seq-1", count: 3 },
        { sequenceId: "seq-2", count: 3 },
      ]}
      currentSequenceId="seq-2"
      currentImageId={props.currentImageId ?? null}
      viewMedia={viewMedia}
    />
  );
}

describe("DetectSources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("spreads, acknowledges, and freezes chosen sources with decoded dims", async () => {
    vi.stubGlobal(
      "fetch",
      (async (url: string) => {
        const imageId = url.split("/").pop() ?? "";
        if (imageId === "img-5") return new Response("{}", { status: 404 });
        return new Response(JSON.stringify(imageryBody(imageId)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );
    const dispatch = vi.fn();
    render(<Harness dispatch={dispatch} />);
    // Sequence defaults to the current viewer sequence.
    expect(screen.getByText(/3 images match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Spread 5 across sequence/ }));
    expect(screen.getByText(/3 selected/)).toBeTruthy();
    expect(screen.getByText(/Sampling: Spread 3 evenly across 3 filtered images/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I choose these 3 images/ }));
    fireEvent.click(screen.getByRole("button", { name: /Choose 3 images for this street/ }));
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SOURCES_CHOOSE", samplingNote: expect.stringContaining("Spread") }),
      );
    });
    const action = dispatch.mock.calls[0][0] as {
      images: { imageId: string }[];
      views: { viewId: string; width: number; height: number; mediaHandle: string }[];
    };
    // img-5 failed metadata: reported and skipped, the rest frozen.
    expect(action.images.map((image) => image.imageId).sort()).toEqual(["img-4", "img-6"]);
    expect(action.views[0]).toMatchObject({ viewId: "view-img-4", width: 800, height: 600, mediaHandle: "handle-img-4" });
    await waitFor(() => {
      expect(screen.getByText(/img-5:/)).toBeTruthy();
    });
  });

  it("uses viewer shortcuts without admitting out-of-RoI images", () => {
    const dispatch = vi.fn();
    const { rerender } = render(<Harness dispatch={dispatch} currentImageId="img-2" />);
    fireEvent.click(screen.getByRole("button", { name: "Use current image" }));
    expect(screen.getByText(/Selected the current viewer image/)).toBeTruthy();
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    rerender(<Harness dispatch={dispatch} currentImageId="img-outside" />);
    fireEvent.click(screen.getByRole("button", { name: "Use current image" }));
    expect(screen.getByText(/outside the RoI/)).toBeTruthy();
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use current sequence" }));
    expect(screen.getByText(/Filtered to the current sequence/)).toBeTruthy();
  });

  it("caps source images at ten", () => {
    const big = Array.from({ length: 11 }, (_, index) =>
      poolImage(`big-${index + 1}`, "seq-1", Date.UTC(2024, 0, 1 + index), false),
    );
    render(<Harness dispatch={vi.fn()} pool={big} currentImageId={null} />);
    const sequenceSelect = screen.getByLabelText("Sequence") as HTMLSelectElement;
    fireEvent.change(sequenceSelect, { target: { value: "all" } });
    const boxes = screen.getAllByRole("checkbox", { name: /Select image/ });
    expect(boxes).toHaveLength(11);
    for (const box of boxes.slice(0, 10)) fireEvent.click(box);
    expect(screen.getByText(/10 selected/)).toBeTruthy();
    expect((boxes[10] as HTMLInputElement).disabled).toBe(true);
  });
});
