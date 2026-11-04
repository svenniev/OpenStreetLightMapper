import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BackendHealth } from "../../hooks/useBackendHealth";
import type { RoiSearch } from "../../hooks/useRoiSearch";
import type { SamStatus } from "../inventory/useSamStatus";
import type { WorkspaceStore } from "../workspaces/useWorkspaceStore";
import { SettingsDrawer } from "./SettingsDrawer";

function health(): BackendHealth {
  return {
    connection: "connected",
    dbState: "connected",
    searchConfigured: true,
    samConfigured: false,
    samModel: "sam-3.1",
    retry: () => {},
  };
}

function search(): RoiSearch {
  return { viewerActual: { imageId: null } } as unknown as RoiSearch;
}

function sam(): SamStatus {
  return {
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
}

function store(): WorkspaceStore {
  return {
    seedState: { seedKey: 1, workspaceId: "ws-1", name: "Demo", seed: {}, sessions: {}, recovered: false },
    status: { kind: "clean", savedAt: "2026-11-03T12:00:00.000Z" },
    name: "Demo",
  } as unknown as WorkspaceStore;
}

function setup() {
  const onManualImageId = vi.fn();
  const onClose = vi.fn();
  render(
    <SettingsDrawer
      health={health()}
      search={search()}
      sam={sam()}
      store={store()}
      onManualImageId={onManualImageId}
      onClose={onClose}
    />,
  );
  return { onManualImageId, onClose };
}

describe("SettingsDrawer", () => {
  it("opens on providers and switches tabs", () => {
    setup();
    expect(screen.getByText(/SAM detection:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Local database" }));
    expect(screen.getByText("Connected — workspaces save locally")).toBeTruthy();
    expect(screen.getByText("Demo")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Developer tools" }));
    expect(screen.getByLabelText("Mapillary image ID")).toBeTruthy();
  });

  it("validates manual image IDs before loading", () => {
    const { onManualImageId } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Developer tools" }));
    fireEvent.change(screen.getByLabelText("Mapillary image ID"), { target: { value: "bad id!" } });
    fireEvent.click(screen.getByText("Load image"));
    expect(screen.getByText(/1–64 letters, digits/)).toBeTruthy();
    expect(onManualImageId).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Mapillary image ID"), { target: { value: "img-abc_1" } });
    fireEvent.click(screen.getByText("Load image"));
    expect(onManualImageId).toHaveBeenCalledWith("img-abc_1");
  });

  it("closes on Escape, Close, and backdrop click", () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(2);
    const backdrop = document.querySelector(".drawer-backdrop")!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
