import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RoiSearch } from "../../hooks/useRoiSearch";
import type { SamStatus } from "../inventory/useSamStatus";
import { SamSection } from "./SettingsPanel";

function samStatus(overrides: Partial<SamStatus> = {}): SamStatus {
  return {
    readiness: { status: "not-configured", model: "sam-3.1" },
    model: "sam-3.1",
    testing: false,
    lastTest: null,
    testOnImage: async () => ({
      at: "2026-11-03T12:00:00.000Z",
      ok: true,
      objects: 0,
      truncated: false,
      message: "ok",
      imageId: "",
      concept: "",
    }),
    ...overrides,
  };
}

function searchWithImage(imageId: string | null): RoiSearch {
  return { viewerActual: { imageId } } as unknown as RoiSearch;
}

describe("SamSection", () => {
  it("shows not-configured status with setup instructions", () => {
    render(<SamSection search={searchWithImage("img-1")} sam={samStatus()} />);
    expect(screen.getByText(/SAM detection:/)).toBeTruthy();
    expect(screen.getByText("Not configured")).toBeTruthy();
    fireEvent.click(screen.getByText("Setup instructions"));
    expect(screen.getByText(/MODEL_API_KEY/)).toBeTruthy();
    const links = screen.getAllByRole("link").map((link) => (link as HTMLAnchorElement).href);
    expect(links).toContain("https://dev.meta.ai/");
    expect(links).toContain("https://dev.meta.ai/docs/sam/prompting");
    const button = screen.getByRole("button", { name: "Test on selected image" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("MODEL_API_KEY");
  });

  it("tests on the viewer image with the credit notice", () => {
    const testOnImage = vi.fn(async () => ({
      at: "2026-11-03T12:00:00.000Z",
      ok: true,
      objects: 2,
      truncated: false,
      message: "Test succeeded — 2 matches.",
      imageId: "img-1",
      concept: "street light pole",
    }));
    render(
      <SamSection
        search={searchWithImage("img-1")}
        sam={samStatus({ readiness: { status: "configured-unverified", model: "sam-3.1" }, testOnImage })}
      />,
    );
    expect(screen.getByText("Configured — not tested")).toBeTruthy();
    expect(screen.getByText(/transmits it to Meta and uses model credits/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test on selected image" }));
    expect(testOnImage).toHaveBeenCalledWith("img-1", "street light pole");
  });

  it("requires a viewer image and surfaces the last outcome", () => {
    const { unmount } = render(
      <SamSection
        search={searchWithImage(null)}
        sam={samStatus({ readiness: { status: "configured-unverified", model: "sam-3.1" } })}
      />,
    );
    const button = screen.getByRole("button", { name: "Test on selected image" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("Open an image in the viewer");
    unmount();

    render(
      <SamSection
        search={searchWithImage("img-1")}
        sam={samStatus({
          readiness: {
            status: "last-test-failed",
            model: "sam-3.1",
            lastTest: {
              at: "2026-11-03T12:00:00.000Z",
              ok: false,
              objects: 0,
              truncated: false,
              message: "The Meta Model API rejected the configured key (provider status 401).",
              imageId: "img-1",
              concept: "street light pole",
            },
          },
          lastTest: {
            at: "2026-11-03T12:00:00.000Z",
            ok: false,
            objects: 0,
            truncated: false,
            message: "The Meta Model API rejected the configured key (provider status 401).",
            imageId: "img-1",
            concept: "street light pole",
          },
        })}
      />,
    );
    expect(screen.getByText("Last test failed")).toBeTruthy();
    expect(screen.getByText(/rejected the configured key/)).toBeTruthy();
  });
});
