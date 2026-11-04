import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceView } from "./inventoryTypes";
import { PhotoCanvas } from "./PhotoCanvas";

function view(overrides: Partial<SourceView> = {}): SourceView {
  return {
    viewId: "view-1",
    imageId: "img-1",
    fullWidth: 2000,
    fullHeight: 1000,
    orientation: 1,
    isPano: false,
    crop: null,
    width: 2000,
    height: 1000,
    mediaHandle: "h-1",
    artifactId: null,
    fullyReviewed: false,
    ...overrides,
  };
}

describe("PhotoCanvas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("places overlay rects from view dimensions", () => {
    const { container } = render(
      <PhotoCanvas
        mediaUrl="/api/imagery/media/h-1"
        alt="photo"
        view={view()}
        overlays={[
          {
            obsId: "obs-1",
            label: "obs-1",
            rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
            mask: null,
            maskStale: false,
            selected: true,
            decision: "accepted",
          },
        ]}
        interactive={false}
        drawArmed={false}
        zoom={1}
        onSelectRect={() => undefined}
        onDrawRect={() => undefined}
        onMoveRect={() => undefined}
        onDisarm={() => undefined}
      />,
    );
    const img = screen.getByAltText("photo") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/imagery/media/h-1");
    const svg = container.querySelector("svg.photo-overlay")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 2000 1000");
    const rects = [...svg.querySelectorAll("g rect")];
    const rect = rects.find((entry) => entry.getAttribute("stroke") === "#15803d");
    expect(rect?.getAttribute("x")).toBe("200");
    expect(rect?.getAttribute("y")).toBe("200");
    expect(rect?.getAttribute("width")).toBe("600");
    expect(rect?.getAttribute("height")).toBe("400");
    expect(rect?.getAttribute("stroke")).toBe("#15803d");
    expect(svg.querySelector("text")?.textContent).toBe("obs-1");
  });

  it("nests model masks under their bounds and hides stale ones", () => {
    const { container } = render(
      <PhotoCanvas
        mediaUrl="/media"
        alt="photo"
        view={view()}
        overlays={[
          {
            obsId: "obs-1",
            label: "obs-1",
            rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
            mask: {
              svgPath: "M0 0L10 0L10 10Z",
              width: 60,
              height: 27,
              bounds: { left: 200, top: 100, right: 600, bottom: 300 },
            },
            maskStale: false,
            selected: false,
            decision: "pending",
          },
          {
            obsId: "obs-2",
            label: "obs-2",
            rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
            mask: {
              svgPath: "M0 0L5 0L5 5Z",
              width: 10,
              height: 10,
              bounds: { left: 1000, top: 500, right: 1200, bottom: 600 },
            },
            maskStale: true,
            selected: false,
            decision: "pending",
          },
        ]}
        interactive={false}
        drawArmed={false}
        zoom={1}
        onSelectRect={() => undefined}
        onDrawRect={() => undefined}
        onMoveRect={() => undefined}
        onDisarm={() => undefined}
      />,
    );
    const nested = container.querySelectorAll("svg.photo-overlay > g > svg");
    expect(nested.length).toBe(1);
    expect(nested[0].getAttribute("x")).toBe("200");
    expect(nested[0].getAttribute("y")).toBe("100");
    expect(nested[0].getAttribute("width")).toBe("400");
    expect(nested[0].getAttribute("height")).toBe("200");
    expect(nested[0].getAttribute("viewBox")).toBe("0 0 60 27");
    expect(nested[0].querySelector("path")?.getAttribute("d")).toBe("M0 0L10 0L10 10Z");
  });

  it("selects rects on click and scales the frame with zoom", () => {
    const onSelectRect = vi.fn();
    const onZoomChange = vi.fn();
    const { container } = render(
      <PhotoCanvas
        mediaUrl="/media"
        alt="photo"
        view={view()}
        overlays={[
          {
            obsId: "obs-7",
            label: "obs-7",
            rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
            mask: null,
            maskStale: false,
            selected: false,
            decision: "pending",
          },
        ]}
        interactive
        drawArmed={false}
        zoom={2}
        onZoomChange={onZoomChange}
        onSelectRect={onSelectRect}
        onDrawRect={() => undefined}
        onMoveRect={() => undefined}
        onDisarm={() => undefined}
      />,
    );
    expect((container.querySelector(".photo-frame") as HTMLElement).style.width).toBe("200%");
    const svg = container.querySelector("svg.photo-overlay")!;
    const rect = svg.querySelector("g rect")!;
    fireEvent.mouseDown(rect);
    expect(onSelectRect).toHaveBeenCalledWith("obs-7");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(onZoomChange).toHaveBeenCalledWith(1.5);
  });

  it("renders crop views on a canvas, not the full photo", () => {
    // Crop decoding fetches pixels; this test covers DOM structure only, so
    // the fetch stays pending deterministically instead of hitting network.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const { container } = render(
      <PhotoCanvas
        mediaUrl="/media"
        alt="crop"
        view={view({ viewId: "view-1-crop", crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, width: 1000, height: 500 })}
        overlays={[]}
        interactive={false}
        drawArmed={false}
        zoom={1}
        onSelectRect={() => undefined}
        onDrawRect={() => undefined}
        onMoveRect={() => undefined}
        onDisarm={() => undefined}
      />,
    );
    expect(container.querySelector("canvas.photo-media")).toBeTruthy();
    expect(container.querySelector("img.photo-media")).toBeNull();
    expect(container.querySelector("svg.photo-overlay")?.getAttribute("viewBox")).toBe("0 0 1000 500");
  });
});
