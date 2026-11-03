import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { SceneCanvas } from "./SceneCanvas";
import type { NormalizedRect } from "./inventoryTypes";

function mockBox(svg: Element, width = 400, height = 300) {
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function renderCanvas(overrides: Partial<ComponentProps<typeof SceneCanvas>> = {}) {
  const handlers = {
    onSelectRect: vi.fn(),
    onDrawRect: vi.fn(),
    onMoveRect: vi.fn(),
    onDisarm: vi.fn(),
  };
  const utils = render(
    <SceneCanvas
      sceneId="demo-image-01"
      label="Scene"
      rects={[]}
      interactive
      drawArmed={false}
      {...handlers}
      {...overrides}
    />,
  );
  const svg = utils.container.querySelector(".demo-scene")!;
  mockBox(svg);
  return { ...utils, svg, handlers };
}

describe("SceneCanvas", () => {
  it("draws a normalized rectangle from a drag and disarms", () => {
    const { svg, handlers } = renderCanvas({ drawArmed: true });
    fireEvent.mouseDown(svg, { clientX: 40, clientY: 30, button: 0 });
    fireEvent.mouseMove(svg, { clientX: 120, clientY: 90 });
    fireEvent.mouseUp(svg, { clientX: 120, clientY: 90 });
    expect(handlers.onDrawRect).toHaveBeenCalledTimes(1);
    const rect: NormalizedRect = handlers.onDrawRect.mock.calls[0][0];
    expect(rect.x).toBeCloseTo(0.1, 5);
    expect(rect.y).toBeCloseTo(0.1, 5);
    expect(rect.w).toBeCloseTo(0.2, 5);
    expect(rect.h).toBeCloseTo(0.2, 5);
    expect(handlers.onDisarm).toHaveBeenCalled();
  });

  it("ignores tiny drags and clamps to the illustration", () => {
    const { svg, handlers } = renderCanvas({ drawArmed: true });
    fireEvent.mouseDown(svg, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.mouseMove(svg, { clientX: 12, clientY: 11 });
    fireEvent.mouseUp(svg, { clientX: 12, clientY: 11 });
    expect(handlers.onDrawRect).not.toHaveBeenCalled();
    fireEvent.mouseDown(svg, { clientX: 380, clientY: 280, button: 0 });
    fireEvent.mouseMove(svg, { clientX: 500, clientY: 400 });
    fireEvent.mouseUp(svg, { clientX: 500, clientY: 400 });
    expect(handlers.onDrawRect).toHaveBeenCalledTimes(1);
    const rect: NormalizedRect = handlers.onDrawRect.mock.calls[0][0];
    expect(rect.x + rect.w).toBeLessThanOrEqual(1);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1);
  });

  it("selects on click and moves on drag, ignoring unchanged commits", () => {
    const { container, handlers } = renderCanvas({
      rects: [
        { obsId: "o1", label: "o1", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, selected: true, decision: "pending" },
      ],
    });
    const rect = container.querySelector('[data-obs-rect="o1"]')!;
    fireEvent.mouseDown(rect, { clientX: 80, clientY: 60, button: 0 });
    fireEvent.mouseUp(rect, { clientX: 80, clientY: 60 });
    expect(handlers.onSelectRect).toHaveBeenCalledWith("o1");
    expect(handlers.onMoveRect).not.toHaveBeenCalled();
    fireEvent.mouseDown(rect, { clientX: 80, clientY: 60, button: 0 });
    fireEvent.mouseMove(rect, { clientX: 100, clientY: 60 });
    fireEvent.mouseUp(rect, { clientX: 100, clientY: 60 });
    expect(handlers.onMoveRect).toHaveBeenCalledTimes(1);
    const moved: NormalizedRect = handlers.onMoveRect.mock.calls[0][1];
    expect(moved.x).toBeCloseTo(0.15, 5);
    expect(moved.w).toBeCloseTo(0.2, 5);
  });

  it("resizes from the corner handle and stays read-only when stale", () => {
    const { container, handlers } = renderCanvas({
      rects: [
        { obsId: "o1", label: "o1", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, selected: true, decision: "pending" },
      ],
    });
    const handle = container.querySelector('[data-obs-handle="o1"]')!;
    fireEvent.mouseDown(handle, { button: 0 });
    fireEvent.mouseMove(handle, { clientX: 160, clientY: 150 });
    fireEvent.mouseUp(handle, { clientX: 160, clientY: 150 });
    expect(handlers.onMoveRect).toHaveBeenCalledTimes(1);
    const resized: NormalizedRect = handlers.onMoveRect.mock.calls[0][1];
    expect(resized.w).toBeCloseTo(0.3, 5);
    expect(resized.h).toBeCloseTo(0.4, 5);

    const frozen = renderCanvas({ interactive: false, drawArmed: true });
    fireEvent.mouseDown(frozen.svg, { clientX: 40, clientY: 30, button: 0 });
    fireEvent.mouseMove(frozen.svg, { clientX: 120, clientY: 90 });
    fireEvent.mouseUp(frozen.svg, { clientX: 120, clientY: 90 });
    expect(frozen.handlers.onDrawRect).not.toHaveBeenCalled();
  });
});
