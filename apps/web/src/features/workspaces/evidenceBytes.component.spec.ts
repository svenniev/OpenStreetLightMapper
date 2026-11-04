import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes, sha256HexAsync } from "./evidenceBytes";

describe("evidenceBytes", () => {
  beforeEach(() => {
    // Browsers have no Node Buffer; the helpers must not touch it.
    vi.stubGlobal("Buffer", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes base64 to bytes without Node Buffer", () => {
    expect(typeof Buffer).toBe("undefined");
    const bytes = base64ToBytes("QUJD"); // "ABC"
    expect([...bytes]).toEqual([65, 66, 67]);
    expect(bytes.length).toBe(3);
  });

  it("hashes bytes to hex with SHA-256 without Node Buffer", async () => {
    expect(typeof Buffer).toBe("undefined");
    const bytes = base64ToBytes("YWJj"); // "abc"
    await expect(sha256HexAsync(bytes)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
