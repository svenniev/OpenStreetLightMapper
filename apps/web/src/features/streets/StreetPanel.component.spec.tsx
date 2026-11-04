import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StreetPanel, type StreetPanelProps } from "./StreetPanel";
import type { DemoSeed } from "./seedDemo";
import type { StreetWorkItem } from "../../lib/api";

function street(id: string, displayName: string, partLabel: string | null = null): StreetWorkItem {
  return {
    id,
    displayName,
    partLabel,
    name: displayName,
    ref: null,
    wayIds: [1, 2],
    segments: [
      { wayId: 1, highway: "residential", nodeIds: [1, 2], tags: {}, version: 1, timestamp: null },
    ],
    geometry: { type: "MultiLineString", coordinates: [] },
    lengthM: 1500,
  };
}

const STREETS = [
  street("a", "Apple Way"),
  street("m", "Main Street", "Part 1 of 2"),
];

function props(overrides: Partial<StreetPanelProps> = {}): StreetPanelProps {
  return {
    status: "loaded",
    streets: STREETS,
    checkedIds: new Set(["a", "m"]),
    checkedCount: 2,
    focusedId: null,
    warnings: [],
    error: null,
    retrievedAt: "2026-11-03T00:00:01.000Z",
    hasRegion: true,
    workflowStatuses: new Map([
      ["a", "not_prepared"],
      ["m", "not_prepared"],
    ]),
    onToggleChecked: vi.fn(),
    onSelectAll: vi.fn(),
    onDeselectAll: vi.fn(),
    onToggleFocus: vi.fn(),
    onRetry: vi.fn(),
    resultsAvailable: new Set(),
    seeded: false,
    seedPreview: null,
    onSeed: vi.fn(),
    onOpenResults: vi.fn(),
    ...overrides,
  };
}

function demoPreview(): DemoSeed {
  return {
    street: {
      ...street("demo-seeded-street", "Meta Way"),
      partLabel: "demo seed — not OSM data",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [19.04, 47.495],
            [19.041, 47.496],
          ],
        ],
      },
      demoSequenceIds: ["s1", "s2"],
    },
    query: {
      bbox: [19.04, 47.495, 19.045, 47.5],
      requestedAt: "2026-11-03T00:00:00.000Z",
      retrievedAt: "2026-11-03T00:00:01.000Z",
      candidateCount: 4,
      invalidWayCount: 0,
      ineligibleWayCount: 0,
      outsideCount: 0,
      streetCount: 1,
      status: "seeded-demo",
    },
    warnings: ["SEEDED_DEMO_DATA"],
    sequenceIds: ["s1", "s2"],
    pointCount: 4,
  };
}

describe("StreetPanel", () => {
  it("renders rows with names, types, lengths, and statuses", () => {
    render(<StreetPanel {...props()} />);
    expect(screen.getByText("Apple Way")).toBeDefined();
    expect(screen.getByText("Main Street (Part 1 of 2)")).toBeDefined();
    expect(screen.getAllByText(/Residential · 1.50 km in RoI/)).toHaveLength(2);
    expect(screen.getAllByText("Not prepared")).toHaveLength(2);
    expect(screen.getByText(/2 streets · 2 included/)).toBeDefined();
  });

  it("toggles participation without focusing, and focuses without participating", () => {
    const onToggleChecked = vi.fn();
    const onToggleFocus = vi.fn();
    render(<StreetPanel {...props({ onToggleChecked, onToggleFocus })} />);
    fireEvent.click(screen.getByLabelText("Include Apple Way in preparation"));
    expect(onToggleChecked).toHaveBeenCalledWith("a", false);
    expect(onToggleFocus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Apple Way"));
    expect(onToggleFocus).toHaveBeenCalledWith("a");
    expect(onToggleChecked).toHaveBeenCalledTimes(1);
  });

  it("supports select-all, deselect-all, and the indeterminate master", () => {
    const onSelectAll = vi.fn();
    const onDeselectAll = vi.fn();
    const { rerender } = render(
      <StreetPanel {...props({ onSelectAll, onDeselectAll })} />,
    );
    fireEvent.click(screen.getByText("Deselect all"));
    expect(onDeselectAll).toHaveBeenCalled();
    rerender(
      <StreetPanel
        {...props({ onSelectAll, onDeselectAll, checkedIds: new Set(["a"]), checkedCount: 1 })}
      />,
    );
    const master = screen.getByLabelText("Select all streets") as HTMLInputElement;
    expect(master.indeterminate).toBe(true);
    fireEvent.click(master);
    expect(onSelectAll).toHaveBeenCalled();
  });

  it("mutes excluded rows and reports failures with retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <StreetPanel
        {...props({
          checkedIds: new Set(["a"]),
          checkedCount: 1,
          workflowStatuses: new Map([
            ["a", "not_prepared"],
            ["m", "excluded"],
          ]),
        })}
      />,
    );
    expect(screen.getByText("Excluded")).toBeDefined();
    rerender(
      <StreetPanel
        {...props({
          status: "failed",
          streets: [],
          error: { code: "OVERPASS_TIMEOUT", message: "Overpass request timed out.", retryable: true },
          onRetry,
        })}
      />,
    );
    expect(screen.getByText("Overpass request timed out.")).toBeDefined();
    fireEvent.click(screen.getByText("Retry streets"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("keeps Results disabled without a completed inventory, and opens on availability", () => {
    const onOpenResults = vi.fn();
    const { rerender } = render(<StreetPanel {...props({ onOpenResults })} />);
    const buttons = screen.getAllByText("Results");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(button.getAttribute("title")).toBe(
        "Available after a reviewed result is saved.",
      );
    }
    // Preparation alone must not enable Results.
    rerender(
      <StreetPanel
        {...props({
          onOpenResults,
          workflowStatuses: new Map([
            ["a", "prepared"],
            ["m", "prepared"],
          ]),
        })}
      />,
    );
    expect(screen.getAllByText("Results").every((b) => (b as HTMLButtonElement).disabled)).toBe(
      true,
    );
    // Only a matching completed result (future stage) enables the button.
    rerender(
      <StreetPanel
        {...props({ onOpenResults, resultsAvailable: new Set(["m"]) })}
      />,
    );
    const rows = screen.getAllByText("Results");
    expect((rows[0] as HTMLButtonElement).disabled).toBe(true);
    expect((rows[1] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(rows[1]);
    expect(onOpenResults).toHaveBeenCalledWith("m");
  });

  it("labels saved-results buttons as saved inventory results", () => {
    render(
      <StreetPanel
        {...props({
          resultsAvailable: new Set(["a"]),
        })}
      />,
    );
    const saved = screen.getByRole("button", {
      name: /open saved inventory results for apple way/i,
    }) as HTMLButtonElement;
    expect(saved.disabled).toBe(false);
    expect(saved.title).toBe("Open saved inventory results.");
  });

  it("offers Seed data next to Retry on failure, gated on sequences", () => {
    const onSeed = vi.fn();
    const failed = {
      status: "failed" as const,
      streets: [],
      error: { code: "OVERPASS_TIMEOUT", message: "Overpass request timed out.", retryable: true },
      onSeed,
    };
    const { rerender } = render(<StreetPanel {...props(failed)} />);
    expect(screen.getByText("Retry streets")).toBeDefined();
    const seed = screen.getByText("Seed data") as HTMLButtonElement;
    expect(seed.disabled).toBe(true);
    expect(seed.title).toContain("Discover Mapillary sequences first");
    rerender(<StreetPanel {...props({ ...failed, seedPreview: demoPreview() })} />);
    const enabled = screen.getByText("Seed data") as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    expect(onSeed).toHaveBeenCalledTimes(1);
  });

  it("labels seeded demo data in the banner and row", () => {
    const preview = demoPreview();
    render(
      <StreetPanel
        {...props({
          streets: [preview.street],
          checkedIds: new Set(["demo-seeded-street"]),
          checkedCount: 1,
          seeded: true,
          seedPreview: preview,
          warnings: ["SEEDED_DEMO_DATA"],
          workflowStatuses: new Map([["demo-seeded-street", "not_prepared"]]),
        })}
      />,
    );
    expect(screen.getByText(/Demo data — seeded from 2 Mapillary sequence positions/)).toBeDefined();
    expect(screen.getByText(/across 2 sequences, not OpenStreetMap/)).toBeDefined();
    expect(screen.getByText(/2 demo sequences/)).toBeDefined();
    expect(
      screen.getByText("Demo street seeded from Mapillary sequence positions — not OpenStreetMap data. Retry streets when Overpass answers."),
    ).toBeDefined();
  });

  it("covers empty states for missing regions and empty results", () => {
    const { rerender } = render(<StreetPanel {...props({ hasRegion: false, status: "idle", streets: [] })} />);
    expect(screen.getByText("Commit a region to list its streets.")).toBeDefined();
    rerender(<StreetPanel {...props({ streets: [], checkedIds: new Set(), checkedCount: 0 })} />);
    expect(screen.getByText("No eligible streets were found in this region.")).toBeDefined();
  });
});
