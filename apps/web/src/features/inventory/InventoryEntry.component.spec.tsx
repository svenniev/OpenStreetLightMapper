import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InventoryEntry } from "./InventoryEntry";
import type { InventorySessions } from "./useInventorySessions";

function inventoryStub(): InventorySessions & { openStreet: ReturnType<typeof vi.fn>; openDemo: ReturnType<typeof vi.fn> } {
  return { openStreet: vi.fn(), openDemo: vi.fn() } as unknown as InventorySessions & {
    openStreet: ReturnType<typeof vi.fn>;
    openDemo: ReturnType<typeof vi.fn>;
  };
}

describe("InventoryEntry", () => {
  it("opens real streets on queried imagery as the primary action", () => {
    const inventory = inventoryStub();
    render(
      <InventoryEntry
        inventory={inventory}
        streetOptions={[{ id: "street-1", displayName: "Main Street", streetSource: "osm" }]}
        canOpen
        disabledReason={null}
      />,
    );
    expect(screen.getByText(/Street provenance:/)).toBeTruthy();
    expect(screen.getByText("OpenStreetMap street")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use queried images" }));
    expect(inventory.openStreet).toHaveBeenCalledWith("street-1", "Main Street", "osm");
    // The demo is present but collapsed, never the primary action.
    expect(screen.getByText("Developer examples — illustrations")).toBeTruthy();
    const details = screen.getByText("Developer examples — illustrations").closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("labels work areas unverified and keeps the demo offline-capable", () => {
    const inventory = inventoryStub();
    render(
      <InventoryEntry
        inventory={inventory}
        streetOptions={[{ id: "demo-seeded-street", displayName: "Meta Way", streetSource: "manual-work-area" }]}
        canOpen
        disabledReason={null}
      />,
    );
    expect(screen.getByText("Manual work area — street unverified")).toBeTruthy();
    expect(screen.getByText(/camera path, not an OpenStreetMap street/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with selected imagery — street unverified" }),
    );
    expect(inventory.openStreet).toHaveBeenCalledWith("demo-seeded-street", "Meta Way", "manual-work-area");
  });
});
