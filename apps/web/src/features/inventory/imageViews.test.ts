import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SourceView } from "./inventoryTypes.js";
import {
  clampNormalized,
  cropPixels,
  cropViewId,
  describeView,
  displayDims,
  exifOrientation,
  fullViewId,
  isNormalizedRect,
  isValidCrop,
  mapViewRectToFull,
  normalizedToPixels,
  pixelsToNormalized,
  spreadSelection,
} from "./imageViews.js";

/** Minimal JPEG with one EXIF orientation tag (or none when orientation is null). */
function jpegWithExif(littleEndian: boolean, orientation: number | null): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  if (orientation !== null) {
    const order = littleEndian ? [0x49, 0x49] : [0x4d, 0x4d];
    const u16 = (value: number): number[] =>
      littleEndian ? [value & 0xff, (value >> 8) & 0xff] : [(value >> 8) & 0xff, value & 0xff];
    const u32 = (value: number): number[] =>
      littleEndian
        ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]
        : [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    const tiff = [
      ...order,
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112),
      ...u16(3),
      ...u32(1),
      ...u16(orientation),
      ...u16(0),
    ];
    const app1 = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
    // JPEG segment lengths are always big-endian, independent of TIFF order.
    const segmentLength = app1.length + 2;
    bytes.push(0xff, 0xe1, (segmentLength >> 8) & 0xff, segmentLength & 0xff, ...app1);
  }
  bytes.push(0xff, 0xd9);
  return new Uint8Array(bytes);
}

function view(crop: SourceView["crop"]): SourceView {
  return {
    viewId: "view-1",
    imageId: "img-1",
    fullWidth: 2000,
    fullHeight: 1000,
    orientation: 1,
    isPano: false,
    crop,
    width: 2000,
    height: 1000,
    mediaHandle: "h",
    fullyReviewed: false,
  };
}

describe("EXIF orientation", () => {
  it("reads orientations in both byte orders and defaults safely", () => {
    assert.equal(exifOrientation(jpegWithExif(true, 1)), 1);
    assert.equal(exifOrientation(jpegWithExif(true, 6)), 6);
    assert.equal(exifOrientation(jpegWithExif(false, 3)), 3);
    assert.equal(exifOrientation(jpegWithExif(false, 8)), 8);
    assert.equal(exifOrientation(jpegWithExif(true, 9)), 1);
    assert.equal(exifOrientation(jpegWithExif(true, null)), 1);
    assert.equal(exifOrientation(new Uint8Array([1, 2, 3])), 1);
    assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), 1);
  });

  it("swaps displayed dimensions for transposed orientations", () => {
    assert.deepEqual(displayDims(2000, 1000, 1), [2000, 1000]);
    assert.deepEqual(displayDims(2000, 1000, 3), [2000, 1000]);
    assert.deepEqual(displayDims(2000, 1000, 6), [1000, 2000]);
    assert.deepEqual(displayDims(2000, 1000, 8), [1000, 2000]);
  });
});

describe("coordinate transforms", () => {
  it("round-trips normalized and pixel rects", () => {
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const pixels = normalizedToPixels(rect, 2000, 1000);
    assert.deepEqual(pixels, { x: 200, y: 200, w: 600, h: 400 });
    assert.deepEqual(pixelsToNormalized(pixels, 2000, 1000), rect);
    assert.deepEqual(pixelsToNormalized(pixels, 0, 0), { x: 0, y: 0, w: 0, h: 0 });
  });

  it("clamps rects into the unit square", () => {
    assert.deepEqual(clampNormalized({ x: -0.1, y: 0.75, w: 0.5, h: 0.5 }), {
      x: 0,
      y: 0.75,
      w: 0.5,
      h: 0.25,
    });
    assert.equal(isNormalizedRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), true);
    assert.equal(isNormalizedRect({ x: 0.9, y: 0.1, w: 0.2, h: 0.2 }), false);
    assert.equal(isNormalizedRect(null), false);
  });

  it("maps integer crops inside the raster", () => {
    assert.deepEqual(cropPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 2000, 1000), {
      x: 500,
      y: 500,
      w: 1000,
      h: 500,
    });
    const tiny = cropPixels({ x: 0.999, y: 0.999, w: 0.0001, h: 0.0001 }, 2000, 1000);
    assert.ok(tiny.w >= 1 && tiny.h >= 1 && tiny.x + tiny.w <= 2000 && tiny.y + tiny.h <= 1000);
  });

  it("lifts crop-space rects to full-photo space for context", () => {
    const cropView = view({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    assert.deepEqual(mapViewRectToFull({ x: 0, y: 0, w: 1, h: 1 }, cropView), {
      x: 0.25,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    });
    assert.deepEqual(mapViewRectToFull({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, cropView), {
      x: 0.5,
      y: 0.75,
      w: 0.25,
      h: 0.25,
    });
    const full = view(null);
    assert.deepEqual(mapViewRectToFull({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, full), {
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2,
    });
  });
});

describe("selection and view helpers", () => {
  it("spreads picks evenly and stably", () => {
    assert.deepEqual(spreadSelection([1, 2, 3, 4, 5, 6, 7, 8, 9], 3), [1, 5, 9]);
    assert.deepEqual(spreadSelection(["a", "b"], 5), ["a", "b"]);
    assert.deepEqual(spreadSelection([1, 2, 3], 1), [2]);
    assert.deepEqual(spreadSelection([1, 2, 3], 0), []);
  });

  it("validates crops and names views", () => {
    assert.equal(isValidCrop({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }), true);
    assert.equal(isValidCrop({ x: 0.1, y: 0.1, w: 0.001, h: 0.3 }), false);
    assert.equal(isValidCrop({ x: 0, y: 0, w: 1, h: 1 }), false);
    assert.equal(fullViewId("123"), "view-123");
    assert.equal(cropViewId("123", 2), "view-123-crop-2");
    assert.equal(describeView(view(null)), "Full photo");
    assert.equal(describeView(view({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 })), "Crop 50%×50% at 25%, 50%");
  });
});
