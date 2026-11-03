import type { NormalizedRect, SourceView } from "./inventoryTypes";

/**
 * Pure image/view math: EXIF orientation, normalized/pixel transforms, crop
 * mapping, and spread sampling. No DOM, no network — fully node-testable.
 *
 * Coordinate rule: inference boxes and masks live in the DECODED display
 * raster (EXIF orientation applied), the same pixels the browser shows and
 * the model analyzes. Normalized rects are fractions of a VIEW raster (whole
 * photo or recorded crop); `mapViewRectToFull` lifts crop-space rects to
 * full-photo space for context display.
 */

export function clampNormalized(rect: NormalizedRect): NormalizedRect {
  const x = Math.min(Math.max(rect.x, 0), 1);
  const y = Math.min(Math.max(rect.y, 0), 1);
  const w = Math.min(Math.max(rect.w, 0), 1 - x);
  const h = Math.min(Math.max(rect.h, 0), 1 - y);
  return { x, y, w, h };
}

export function isNormalizedRect(value: unknown): value is NormalizedRect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (
    typeof rect.x === "number" &&
    typeof rect.y === "number" &&
    typeof rect.w === "number" &&
    typeof rect.h === "number" &&
    [rect.x, rect.y, rect.w, rect.h].every((entry) => Number.isFinite(entry)) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.w > 0 &&
    rect.h > 0 &&
    rect.x + rect.w <= 1 + 1e-9 &&
    rect.y + rect.h <= 1 + 1e-9
  );
}

/**
 * EXIF orientation (1..8) from raw file bytes, or 1 when absent/unparseable.
 * Parses JPEG APP1/Exif directly so orientation is explicit and testable;
 * the raster pipeline cross-checks this against the decoded bitmap.
 */
export function exifOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return 1; // scan data / end: no more metadata
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2; // standalone markers carry no length
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return 1;
    if (marker === 0xe1) {
      const orientation = readExifApp1(bytes.subarray(offset + 4, offset + 2 + length));
      if (orientation !== null) return orientation;
    }
    offset += 2 + length;
  }
  return 1;
}

function readExifApp1(segment: Uint8Array): number | null {
  if (
    segment.length < 14 ||
    segment[0] !== 0x45 || // "Exif\0\0"
    segment[1] !== 0x78 ||
    segment[2] !== 0x69 ||
    segment[3] !== 0x66 ||
    segment[4] !== 0x00 ||
    segment[5] !== 0x00
  ) {
    return null;
  }
  const tiff = segment.subarray(6);
  const little =
    tiff[0] === 0x49 && tiff[1] === 0x49
      ? true
      : tiff[0] === 0x4d && tiff[1] === 0x4d
        ? false
        : null;
  if (little === null) return null;
  const u16 = (at: number): number =>
    little ? tiff[at] | (tiff[at + 1] << 8) : (tiff[at] << 8) | tiff[at + 1];
  const u32 = (at: number): number =>
    little
      ? tiff[at] | (tiff[at + 1] << 8) | (tiff[at + 2] << 16) | (tiff[at + 3] << 24)
      : (tiff[at] << 24) | (tiff[at + 1] << 16) | (tiff[at + 2] << 8) | tiff[at + 3];
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) return null;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const total = u32(entry + 4);
    if (tag === 0x0112 && type === 3 && total === 1) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** Displayed dimensions for raw bitmap dims under an EXIF orientation. */
export function displayDims(rawWidth: number, rawHeight: number, orientation: number): [number, number] {
  if (orientation >= 5 && orientation <= 8) return [rawHeight, rawWidth];
  return [rawWidth, rawHeight];
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function normalizedToPixels(rect: NormalizedRect, width: number, height: number): PixelRect {
  return { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height };
}

export function pixelsToNormalized(rect: PixelRect, width: number, height: number): NormalizedRect {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  return clampNormalized({
    x: rect.x / width,
    y: rect.y / height,
    w: rect.w / width,
    h: rect.h / height,
  });
}

/** Integer pixel crop inside the full raster (at least 1×1). */
export function cropPixels(crop: NormalizedRect, fullWidth: number, fullHeight: number): PixelRect {
  const x = Math.min(Math.max(Math.round(crop.x * fullWidth), 0), Math.max(fullWidth - 1, 0));
  const y = Math.min(Math.max(Math.round(crop.y * fullHeight), 0), Math.max(fullHeight - 1, 0));
  const w = Math.min(Math.max(Math.round(crop.w * fullWidth), 1), fullWidth - x);
  const h = Math.min(Math.max(Math.round(crop.h * fullHeight), 1), fullHeight - y);
  return { x, y, w, h };
}

/** Lift a view-space rect (crop or full) to full-photo normalized space. */
export function mapViewRectToFull(rect: NormalizedRect, view: SourceView): NormalizedRect {
  if (!view.crop) return clampNormalized(rect);
  return clampNormalized({
    x: view.crop.x + rect.x * view.crop.w,
    y: view.crop.y + rect.y * view.crop.h,
    w: rect.w * view.crop.w,
    h: rect.h * view.crop.h,
  });
}

/** Evenly spaced sampling across an ordered list (stable, deterministic). */
export function spreadSelection<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= items.length) return [...items];
  if (count === 1) return [items[Math.floor(items.length / 2)]];
  const picked: T[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const index = Math.round((slot * (items.length - 1)) / (count - 1));
    const item = items[index];
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}

/** A crop must be a real sub-region, not a sliver or the whole frame. */
export function isValidCrop(rect: NormalizedRect): boolean {
  if (!isNormalizedRect(rect)) return false;
  if (rect.w < 0.02 || rect.h < 0.02) return false;
  if (rect.w * rect.h > 0.999) return false;
  return true;
}

export function fullViewId(imageId: string): string {
  return `view-${imageId}`;
}

export function cropViewId(imageId: string, index: number): string {
  return `view-${imageId}-crop-${index}`;
}

export function describeView(view: SourceView): string {
  if (!view.crop) return "Full photo";
  const percent = (value: number): string => `${Math.round(value * 100)}%`;
  return `Crop ${percent(view.crop.w)}×${percent(view.crop.h)} at ${percent(view.crop.x)}, ${percent(view.crop.y)}`;
}
