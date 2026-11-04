import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AutoInspectModal } from "./AutoInspectModal";
import type { AutoCandidateSummary } from "../../lib/autoApi";

const CANDIDATE: AutoCandidateSummary = {
  candidateId: "cand-1",
  category: "pole",
  status: "located",
  position: { lng: 19.0, lat: 47.0, uncertaintyM: 1.5, method: "triangulation-3view" },
  observationIds: ["obs-1"],
  imageIds: ["img-1"],
  sequenceIds: ["seq-a"],
  unlocatedReason: null,
  supportId: null,
  streetId: null,
  flags: [],
};

const EVIDENCE = {
  candidateId: "cand-1",
  truncated: false,
  images: [{ imageId: "img-1", viewArtifactId: "view-1", width: 2000, height: 1000 }],
  observations: [
    {
      observationId: "obs-1",
      imageId: "img-1",
      box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      confidence: 0.9,
      anchor: { uPx: 500, vPx: 600 },
      maskArtifactId: null,
      maskBounds: null,
    },
  ],
};

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      status === 200
        ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AutoInspectModal", () => {
  it("renders the stored view with the detection box and anchor overlaid", async () => {
    stubFetch(EVIDENCE);
    render(
      <AutoInspectModal workspaceId="ws_1" jobId="aj_1" candidate={CANDIDATE} onClose={() => {}} />,
    );
    expect(screen.getByText("Loading segmented views…")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByAltText("Analysis view for image img-1")).toBeDefined();
    });
    const raster = screen.getByAltText("Analysis view for image img-1") as HTMLImageElement;
    expect(raster.getAttribute("src")).toBe("/api/artifacts/view-1");
    const dialog = screen.getByRole("dialog");
    const rect = dialog.querySelector("rect");
    expect(rect?.getAttribute("x")).toBe("10");
    expect(rect?.getAttribute("y")).toBe("20");
    expect(rect?.getAttribute("width")).toBe("30");
    expect(rect?.getAttribute("height")).toBe("40");
    const dot = dialog.querySelector("circle");
    expect(dot?.getAttribute("cx")).toBe("25");
    expect(dot?.getAttribute("cy")).toBe("60");
    expect(screen.getByText(/90% confidence/)).toBeDefined();
  });

  it("reports a missing view honestly instead of rendering overlays", async () => {
    stubFetch({
      ...EVIDENCE,
      images: [{ imageId: "img-1", viewArtifactId: null, width: null, height: null }],
    });
    render(
      <AutoInspectModal workspaceId="ws_1" jobId="aj_1" candidate={CANDIDATE} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("The analysis view for this image was not stored.")).toBeDefined();
    });
    expect(screen.queryByAltText("Analysis view for image img-1")).toBeNull();
  });

  it("closes on Escape and on the Close button", async () => {
    stubFetch(EVIDENCE);
    const onClose = vi.fn();
    render(<AutoInspectModal workspaceId="ws_1" jobId="aj_1" candidate={CANDIDATE} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByAltText("Analysis view for image img-1")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
