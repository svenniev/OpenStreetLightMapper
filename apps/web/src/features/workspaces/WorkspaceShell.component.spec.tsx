import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../lib/workspaceApi";
import type { SaveStatus, WorkspaceStore } from "./useWorkspaceStore";
import { ConflictDialog, SaveBanner, WorkspaceMenu } from "./WorkspaceShell";

function mockStore(overrides: {
  status?: SaveStatus;
  workspaceId?: string | null;
  name?: string;
  workspaceList?: WorkspaceSummary[] | null;
  listError?: string | null;
}): { store: WorkspaceStore; fns: Record<string, ReturnType<typeof vi.fn>> } {
  const fns = {
    flushNow: vi.fn(async () => true),
    refreshWorkspaceList: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => null),
    createNewWorkspace: vi.fn(async () => null),
    renameWorkspace: vi.fn(() => null),
    reloadNewer: vi.fn(async () => null),
    saveAsNewWorkspace: vi.fn(async () => null),
  };
  const store = {
    seedState: {
      seedKey: 1,
      workspaceId: overrides.workspaceId ?? "ws-1",
      name: overrides.name ?? "Test workspace",
      seed: {},
      sessions: {},
      recovered: false,
    },
    status: overrides.status ?? { kind: "clean", savedAt: null },
    name: overrides.name ?? "Test workspace",
    workspaceList: overrides.workspaceList ?? null,
    listError: overrides.listError ?? null,
    ...fns,
  } as unknown as WorkspaceStore;
  return { store, fns };
}

describe("SaveBanner", () => {
  it("reports each save state and retries failures explicitly", () => {
    const { store, fns } = mockStore({ status: { kind: "failed", message: "boom" } });
    const { unmount } = render(<SaveBanner store={store} />);
    expect(screen.getByText("Save failed · boom")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry save"));
    expect(fns.flushNow).toHaveBeenCalledTimes(1);
    unmount();

    const dirty = mockStore({ status: { kind: "dirty" } });
    render(<SaveBanner store={dirty.store} />);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByText("Save now"));
    expect(dirty.fns.flushNow).toHaveBeenCalledTimes(1);
  });

  it("warns when no workspace is open", () => {
    const { store } = mockStore({ status: { kind: "no-workspace" }, workspaceId: null });
    render(<SaveBanner store={store} />);
    expect(screen.getByText("No workspace open — work is not saved.")).toBeTruthy();
    expect(screen.queryByText("Save now")).toBeNull();
  });
});

describe("WorkspaceMenu", () => {
  const entries: WorkspaceSummary[] = [
    {
      workspaceId: "ws-1",
      name: "First",
      revision: 3,
      sessionCount: 2,
      createdAt: "2026-11-03T10:00:00.000Z",
      updatedAt: "2026-11-03T11:00:00.000Z",
    },
    {
      workspaceId: "ws-2",
      name: "Second",
      revision: 1,
      sessionCount: 0,
      createdAt: "2026-11-03T10:00:00.000Z",
      updatedAt: "2026-11-03T10:30:00.000Z",
    },
  ];

  it("lists workspaces and opens another on demand", () => {
    const { store, fns } = mockStore({ workspaceList: entries, name: "First" });
    render(<WorkspaceMenu store={store} />);
    fireEvent.click(screen.getByText("Workspace: First"));
    expect(fns.refreshWorkspaceList).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Second")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Open")[0]);
    expect(fns.openWorkspace).toHaveBeenCalledWith("ws-2");
  });

  it("creates and renames workspaces", async () => {
    const { store, fns } = mockStore({ workspaceList: entries, name: "First" });
    render(<WorkspaceMenu store={store} />);
    fireEvent.click(screen.getByText("Workspace: First"));
    fireEvent.change(screen.getByLabelText("New workspace name"), { target: { value: "Third" } });
    fireEvent.click(screen.getByText("Create and open"));
    expect(fns.createNewWorkspace).toHaveBeenCalledWith("Third");

    // A successful create closes the menu; reopen it for the rename.
    await waitFor(() => {
      expect(screen.queryByText("Rename")).toBeNull();
    });
    fireEvent.click(screen.getByText("Workspace: First"));
    fireEvent.click(screen.getByText("Rename"));
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Save name"));
    expect(fns.renameWorkspace).toHaveBeenCalledWith("Renamed");
  });
});

describe("ConflictDialog", () => {
  it("stays hidden without a conflict and resolves one explicitly", async () => {
    const clean = mockStore({ status: { kind: "clean", savedAt: null } });
    const { unmount } = render(<ConflictDialog store={clean.store} />);
    expect(screen.queryByText("Newer version on the server")).toBeNull();
    unmount();

    const { store, fns } = mockStore({
      status: { kind: "conflict", record: "workspace", message: "rev mismatch", currentRevision: 7 },
    });
    render(<ConflictDialog store={store} />);
    expect(screen.getByText(/stored revision 7/)).toBeTruthy();
    fireEvent.click(screen.getByText("Reload newer (discard my edits)"));
    expect(fns.reloadNewer).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(
        (screen.getByText("Save as new workspace") as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByText("Save as new workspace"));
    expect(fns.saveAsNewWorkspace).toHaveBeenCalledWith("Test workspace (fork)");
  });
});
