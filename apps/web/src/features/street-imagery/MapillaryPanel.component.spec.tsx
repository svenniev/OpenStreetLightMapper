import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MapillaryPanel } from "./MapillaryPanel";

interface MockViewerInstance {
  moveToImpl: (id: string) => Promise<unknown>;
  emit: (event: string, payload: unknown) => void;
  removed: boolean;
}

const mockControl = vi.hoisted(() => ({
  impl: null as null | ((id: string) => Promise<unknown>),
}));

vi.mock("mapillary-js", () => {
  class Viewer {
    static instances: Viewer[] = [];
    listeners = new Map<string, Set<(event: unknown) => void>>();
    moveToImpl: (id: string) => Promise<unknown> =
      mockControl.impl ??
      (async (id: string) => ({
        id,
        sequenceId: `seq-of-${id}`,
        lngLat: { lat: 47.5, lng: 19.04 },
      }));
    removed = false;
    constructor() {
      Viewer.instances.push(this);
    }
    on(event: string, handler: (event: unknown) => void): void {
      const set = this.listeners.get(event) ?? new Set();
      set.add(handler);
      this.listeners.set(event, set);
    }
    off(event: string, handler: (event: unknown) => void): void {
      this.listeners.get(event)?.delete(handler);
    }
    remove(): void {
      this.removed = true;
    }
    resize(): void {}
    moveTo(id: string): Promise<unknown> {
      return this.moveToImpl(id);
    }
    emit(event: string, payload: unknown): void {
      for (const handler of this.listeners.get(event) ?? []) handler(payload);
    }
  }
  return { Viewer };
});

async function mockViewer(): Promise<MockViewerInstance> {
  const { Viewer } = await import("mapillary-js");
  const instances = (Viewer as unknown as { instances: MockViewerInstance[] }).instances;
  if (instances.length === 0) throw new Error("viewer was not created");
  return instances[instances.length - 1];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockControl.impl = null;
});

describe("MapillaryPanel viewer wiring", () => {
  it("loads a requested image and reports actual image, sequence, and position", async () => {
    const onActualImage = vi.fn();
    const onCameraPosition = vi.fn();
    render(
      <MapillaryPanel
        onCameraPosition={onCameraPosition}
        onActualImage={onActualImage}
        requestedImage={{ id: "img-a", token: 1 }}
        isActualOutsideResults={false}
      />,
    );
    await waitFor(() => {
      expect(onActualImage).toHaveBeenCalledWith({ imageId: "img-a", sequenceId: "seq-of-img-a" });
    });
    expect(onCameraPosition).toHaveBeenCalledWith({ lat: 47.5, lng: 19.04 });
    expect(screen.getByText(/Showing img-a/)).toBeDefined();
  });

  it("follows viewer navigation to another image, including outside the result set", async () => {
    const onActualImage = vi.fn();
    const onCameraPosition = vi.fn();
    const { rerender } = render(
      <MapillaryPanel
        onCameraPosition={onCameraPosition}
        onActualImage={onActualImage}
        requestedImage={{ id: "img-a", token: 1 }}
        isActualOutsideResults={false}
      />,
    );
    await waitFor(() => expect(onActualImage).toHaveBeenCalled());
    const viewer = await mockViewer();
    // Viewer sequence navigation to an image outside the loaded set.
    viewer.emit("image", {
      image: { id: "img-far", sequenceId: "seq-other", lngLat: { lat: 48, lng: 20 } },
    });
    await waitFor(() => {
      expect(onActualImage).toHaveBeenCalledWith({ imageId: "img-far", sequenceId: "seq-other" });
    });
    expect(onCameraPosition).toHaveBeenCalledWith({ lat: 48, lng: 20 });
    rerender(
      <MapillaryPanel
        onCameraPosition={onCameraPosition}
        onActualImage={onActualImage}
        requestedImage={{ id: "img-a", token: 1 }}
        isActualOutsideResults
      />,
    );
    expect(screen.getByText(/Outside current search results/)).toBeDefined();
  });

  it("settles rapid A→B requests on B through the real component", async () => {
    const onActualImage = vi.fn();
    const gateA = deferred<unknown>();
    const gateB = deferred<unknown>();
    mockControl.impl = (id: string) => (id === "img-a" ? gateA.promise : gateB.promise);
    const rendered = render(
      <MapillaryPanel
        onCameraPosition={vi.fn()}
        onActualImage={onActualImage}
        requestedImage={{ id: "img-a", token: 1 }}
        isActualOutsideResults={false}
      />,
    );
    await mockViewer();
    rendered.rerender(
      <MapillaryPanel
        onCameraPosition={vi.fn()}
        onActualImage={onActualImage}
        requestedImage={{ id: "img-b", token: 2 }}
        isActualOutsideResults={false}
      />,
    );
    // A resolves late, after B was requested: it must not become actual.
    gateA.resolve({ id: "img-a", sequenceId: "seq-a", lngLat: { lat: 1, lng: 1 } });
    await Promise.resolve();
    gateB.resolve({ id: "img-b", sequenceId: "seq-b", lngLat: { lat: 2, lng: 2 } });
    await waitFor(() => {
      expect(onActualImage).toHaveBeenCalledWith({ imageId: "img-b", sequenceId: "seq-b" });
    });
    expect(onActualImage).not.toHaveBeenCalledWith(
      expect.objectContaining({ imageId: "img-a" }),
    );
    expect(screen.getByText(/Showing img-b/)).toBeDefined();
  });

  it("shows a stable message when the failure carries a fake token, without leaking it", async () => {
    const logged: string[] = [];
    const outputs = ["log", "warn", "error", "debug", "info"] as const;
    const spies = outputs.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    try {
      const leaked = "MLY|FAKE_TOKEN_xyz";
      const rendered = render(
        <MapillaryPanel
          onCameraPosition={vi.fn()}
          onActualImage={vi.fn()}
          requestedImage={{ id: "img-x", token: 7 }}
          isActualOutsideResults={false}
        />,
      );
      // First load succeeds; the failure below must not disturb this actual.
      await waitFor(() => {
        expect(screen.getByText(/Showing img-x/)).toBeDefined();
      });
      const instance = await mockViewer();
      instance.moveToImpl = async () => {
        throw new Error(`401 for ${leaked} at https://x.test/?access_token=${leaked}`);
      };
      rendered.rerender(
        <MapillaryPanel
          onCameraPosition={vi.fn()}
          onActualImage={vi.fn()}
          requestedImage={{ id: "img-y", token: 8 }}
          isActualOutsideResults={false}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText(/Mapillary authorization failed\./)).toBeDefined();
      });
      expect(screen.getByText(/Still showing img-x/)).toBeDefined();
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("FAKE_TOKEN");
      expect(text).not.toContain("access_token=");
      expect(logged.join("\n")).not.toContain("FAKE_TOKEN");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
