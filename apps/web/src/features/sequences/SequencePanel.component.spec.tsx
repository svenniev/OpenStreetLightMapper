import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SequencePanel, type SequencePanelProps } from "./SequencePanel";
import { groupSeedRecords } from "./sequenceGroup";
import type { ImageResult } from "../../lib/searchTypes";

function image(partial: Partial<ImageResult> & { id: string }): ImageResult {
  return {
    coordinate: [19.04, 47.497],
    coordinateSource: "geometry",
    originalCoordinate: [19.04, 47.497],
    computedCoordinate: null,
    capturedAt: null,
    isPano: null,
    sequenceId: null,
    ...partial,
  };
}

const SEEDS = [
  image({ id: "p1", sequenceId: "seq-pano-123456789", isPano: true, capturedAt: 2000 }),
  image({ id: "f1", sequenceId: "seq-flat", isPano: false, capturedAt: 3000 }),
  image({ id: "solo-1", capturedAt: 1000 }),
];

function props(overrides: Partial<SequencePanelProps> = {}): SequencePanelProps {
  return {
    groups: groupSeedRecords(SEEDS),
    filter: "all",
    onFilter: vi.fn(),
    scope: "inside",
    onScope: vi.fn(),
    selectedSequenceId: null,
    selectedUngroupedId: null,
    selectedLoad: {
      state: "discovery",
      memberIds: null,
      membershipStatus: null,
      counts: null,
      warnings: [],
      error: null,
      retrievedAt: null,
    },
    scopedMembers: [],
    unresolvedIds: [],
    imageListOpen: false,
    onToggleImageList: vi.fn(),
    imagePage: 1,
    onImagePage: vi.fn(),
    viewedId: null,
    pendingId: null,
    foreignSequence: null,
    hasDiscovery: true,
    onSelectSequence: vi.fn(),
    onSelectUngrouped: vi.fn(),
    onSelectImage: vi.fn(),
    onRetryDetail: vi.fn(),
    onFitSequence: vi.fn(),
    canFitSequence: true,
    ...overrides,
  };
}

describe("SequencePanel", () => {
  it("renders sequence rows with badges, counts, and full-ID access", () => {
    render(<SequencePanel {...props()} />);
    expect(screen.getByText("seq-pano-1…")).toBeDefined();
    expect(screen.getByText("Panorama")).toBeDefined();
    expect(screen.getByText("Standard")).toBeDefined();
    expect(screen.getByTitle("seq-pano-123456789")).toBeDefined();
    expect(screen.getAllByText(/1 in RoI/)).toHaveLength(2);
  });

  it("filters rows and selects a sequence on click", () => {
    const onFilter = vi.fn();
    const onSelectSequence = vi.fn();
    const rendered = render(<SequencePanel {...props({ onFilter, onSelectSequence })} />);
    fireEvent.click(screen.getByText("Contains panoramas"));
    expect(onFilter).toHaveBeenCalledWith("panoramas");
    rendered.rerender(<SequencePanel {...props({ onFilter, onSelectSequence, filter: "panoramas" })} />);
    expect(screen.queryByText("seq-flat")).toBeNull();
    fireEvent.click(screen.getByText("seq-pano-1…"));
    expect(onSelectSequence).toHaveBeenCalledWith("seq-pano-123456789");
  });

  it("lists ungrouped images separately with individual selection", () => {
    const onSelectUngrouped = vi.fn();
    const onSelectImage = vi.fn();
    render(<SequencePanel {...props({ onSelectUngrouped, onSelectImage })} />);
    expect(screen.getByText(/Ungrouped images \(1\)/)).toBeDefined();
    const buttons = screen.getAllByRole("button", { name: /Open image solo-1/ });
    fireEvent.click(buttons[0]);
    expect(onSelectUngrouped).toHaveBeenCalledWith("solo-1");
    expect(onSelectImage).toHaveBeenCalledWith("solo-1");
  });

  it("shows detail states, scopes, warnings, and retry for the selection", () => {
    const onRetryDetail = vi.fn();
    const onScope = vi.fn();
    render(
      <SequencePanel
        {...props({
          selectedSequenceId: "seq-flat",
          selectedLoad: {
            state: "partial",
            memberIds: ["f1", "f2"],
            membershipStatus: "complete",
            counts: {
              status: "partial",
              loadedCount: 1,
              missingCount: 1,
              invalidCount: 0,
              inRegionCount: 1,
              outRegionCount: 0,
              unresolvedCount: 0,
              skippedKnownCount: 0,
            },
            warnings: ["SEQUENCE_MEMBERS_MISSING"],
            error: null,
            retrievedAt: "2026-11-03T00:00:00.000Z",
          },
          scopedMembers: [image({ id: "f1", sequenceId: "seq-flat", isPano: false, inRoi: true })],
          onRetryDetail,
          onScope,
        })}
      />,
    );
    expect(screen.getByText(/partially loaded/)).toBeDefined();
    expect(screen.getByText(/1 missing/)).toBeDefined();
    expect(screen.getByText(/unavailable upstream/)).toBeDefined();
    fireEvent.click(screen.getByText("Whole sequence"));
    expect(onScope).toHaveBeenCalledWith("whole");
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("offers retry on failed detail and shows the foreign-sequence banner", () => {
    const onRetryDetail = vi.fn();
    const onSelectSequence = vi.fn();
    render(
      <SequencePanel
        {...props({
          selectedSequenceId: "seq-flat",
          selectedLoad: {
            state: "failed",
            memberIds: null,
            membershipStatus: null,
            counts: null,
            warnings: [],
            error: { code: "MAPILLARY_TIMEOUT", message: "Mapillary sequence request timed out.", retryable: true },
            retrievedAt: null,
          },
          foreignSequence: { sequenceId: "seq-elsewhere", discovered: true },
          onRetryDetail,
          onSelectSequence,
        })}
      />,
    );
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetryDetail).toHaveBeenCalledWith("seq-flat");
    fireEvent.click(screen.getByText("Show this sequence"));
    expect(onSelectSequence).toHaveBeenCalledWith("seq-elsewhere");
  });

  it("expands the selected image list with viewing badges and pagination", () => {
    const members = Array.from({ length: 60 }, (_, index) =>
      image({ id: `m-${index}`, sequenceId: "seq-flat", isPano: false, inRoi: true }),
    );
    const onImagePage = vi.fn();
    render(
      <SequencePanel
        {...props({
          selectedSequenceId: "seq-flat",
          selectedLoad: {
            state: "loaded",
            memberIds: members.map((member) => member.id),
            membershipStatus: "complete",
            counts: {
              status: "loaded",
              loadedCount: 60,
              missingCount: 0,
              invalidCount: 0,
              inRegionCount: 60,
              outRegionCount: 0,
              unresolvedCount: 0,
              skippedKnownCount: 0,
            },
            warnings: [],
            error: null,
            retrievedAt: null,
          },
          scopedMembers: members,
          imageListOpen: true,
          viewedId: "m-0",
          onImagePage,
        })}
      />,
    );
    expect(screen.getByText(/Page 1 of 2/)).toBeDefined();
    expect(screen.getByText("Viewing")).toBeDefined();
    fireEvent.click(screen.getByText("Next"));
    expect(onImagePage).toHaveBeenCalledWith(2);
  });
});
