import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../inventory/inventoryReducer";
import type { SessionPreviewResult, WorkflowSession } from "../inventory/inventoryTypes";
import { saveReviewedResult, saveSession } from "../../lib/workspaceApi";
import { useWorkspaceStore, type TrackedState } from "./useWorkspaceStore";

vi.mock("../../lib/workspaceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspaceApi")>();
  return {
    ...actual,
    completeDetectionItem: vi.fn(),
  createWorkspace: vi.fn(async (name: string) => ({
    workspaceId: "ws_1",
    revision: 1,
    name,
  })),
  fetchDetectionItem: vi.fn(),
  fetchSession: vi.fn(),
  fetchSnapshot: vi.fn(),
  fetchWorkspace: vi.fn(),
  interruptDetectionItem: vi.fn(),
  listDetectionItems: vi.fn(async () => ({ items: [], nextCursor: null })),
  listReviewedResults: vi.fn(async () => []),
  listWorkspaces: vi.fn(async () => []),
  registerDetectionItem: vi.fn(),
  saveReviewedResult: vi.fn(async () => ({ resultId: "rs-1" })),
  saveSession: vi.fn(async () => 1),
  saveWorkspace: vi.fn(async () => 1),
  storeSnapshot: vi.fn(),
  uploadArtifact: vi.fn(),
  };
});

const mocked = vi.mocked;
const saveSessionMock = mocked(saveSession);
const saveReviewedResultMock = mocked(saveReviewedResult);

function finishedPreview(): SessionPreviewResult {
  return {
    kind: "session-preview",
    mode: "manual",
    sessionId: "s-k",
    streetId: "street-1",
    streetDisplayName: "Main St",
    streetSource: "osm",
    origins: ["manual"],
    model: "sam-3.1",
    processing: { views: 1, concepts: 1 },
    roiRevision: 3,
    runId: "prep-3-1-1-r1",
    fingerprint: "aaa",
    finishedAt: "2026-11-04T10:00:00.000Z",
    assets: [],
    counts: { poles: 0, luminaires: 0 },
    limitations: [],
    temporary: true,
  } as unknown as SessionPreviewResult;
}

function sessionWithNote(note: string): Record<string, unknown> {
  const session = createSession({
    key: "k",
    sessionId: "s-k",
    mode: "manual",
    streetId: "street-1",
    streetDisplayName: "Main St",
    context: {
      streetId: "street-1",
      streetDisplayName: "Main St",
      streetSource: "osm",
      roiRevision: 3,
      runId: "prep-3-1-1-r1",
      fingerprint: "aaa",
    },
  });
  const full: WorkflowSession = {
    ...session,
    finishedPreview: finishedPreview(),
    observations: {
      "obs-1": {
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
        note,
      },
    },
    obsOrder: ["obs-1"],
  };
  return full as unknown as Record<string, unknown>;
}

function trackedWith(body: Record<string, unknown>): TrackedState {
  return {
    name: "t",
    roi: null,
    imagery: null,
    imagerySelection: {},
    imagerySelectionJson: "{}",
    street: null,
    streetSelection: {},
    streetSelectionJson: "{}",
    preparation: {},
    preparationJson: "{}",
    sessions: { k: { json: JSON.stringify(body), body } },
    activeSessionKey: "k",
  };
}

describe("useWorkspaceStore result pinning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a reviewed result from the flushed body, not edits that land mid-save", async () => {
    const prepareRaster = vi.fn();
    const { result, unmount } = renderHook(() =>
      useWorkspaceStore({ dbState: "connected", prepareRaster }),
    );
    try {
      await act(async () => {
        expect(await result.current.createNewWorkspace("t")).toBeNull();
      });
      expect(result.current.seedState.workspaceId).toBe("ws_1");

      const v1 = sessionWithNote("v1-note");
      act(() => {
        result.current.track(trackedWith(v1));
      });

      // An edit lands while the save is in flight; the PUT below is gated so
      // the test deterministically reproduces the mid-save race.
      let releaseSave!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let revision = 0;
      saveSessionMock.mockImplementationOnce(async () => {
        await gate;
        revision += 1;
        return revision;
      });
      saveSessionMock.mockImplementation(async () => {
        revision += 1;
        return revision;
      });

      const v2 = sessionWithNote("v2-note");
      act(() => {
        result.current.track(trackedWith(v2));
      });

      const pending = result.current.saveReviewedResultVersion("k", "rs-1");
      await waitFor(() => expect(saveSessionMock).toHaveBeenCalledTimes(1));
      const v3 = sessionWithNote("v3-note");
      act(() => {
        result.current.track(trackedWith(v3));
      });
      releaseSave();
      const outcome = await pending;
      expect(outcome).toEqual({ resultId: "rs-1" });

      // The result pins revision 1's flushed body (v2), not the live v3 edit.
      expect(saveReviewedResultMock).toHaveBeenCalledTimes(1);
      const input = saveReviewedResultMock.mock.calls[0][2] as {
        sessionRevision: number;
        snapshot: { observations: { note: string | null }[] };
      };
      expect(input.sessionRevision).toBe(1);
      expect(input.snapshot.observations).toHaveLength(1);
      expect(input.snapshot.observations[0].note).toBe("v2-note");

      // The newer edit still saves afterwards, as the next revision.
      await waitFor(() => expect(saveSessionMock).toHaveBeenCalledTimes(2));
      const secondBody = saveSessionMock.mock.calls[1][2].session as {
        observations: Record<string, { note: string | null }>;
      };
      expect(secondBody.observations["obs-1"].note).toBe("v3-note");
    } finally {
      unmount();
    }
  });
});
