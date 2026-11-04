import { createHash } from "node:crypto";
import {
  MAX_REPROJECTION_PX,
  MAX_RAY_GAP_M,
  MIN_LOCATED_VIEWS,
  MIN_PARALLAX_DEG,
  validateCameraDescriptor,
} from "@openstreetlightmapper/geo";
import { checkClientId, checkJsonBytes, fail, isRecord } from "./validation.js";
import type { ResolvedAutoPlan } from "../auto/plan.js";

/**
 * Validation for the automatic (headless) pipeline: job plans, prepared view
 * descriptors, observations, candidates, and published results.
 */

// ---------------------------------------------------------------------------
// Plan bounds (spec defaults; the worker enforces them again at runtime).
// ---------------------------------------------------------------------------

/** Maximum sequences selectable per job (images bound dominates). */
export const AUTO_SEQUENCES_MAX = 50;
/** Maximum concepts per job (matches the manual concept cap). */
export const AUTO_CONCEPTS_MAX = 4;
/** Default/maximum images per job. */
export const AUTO_IMAGES_DEFAULT = 100;
export const AUTO_IMAGES_MAX = 100;
/** Default/maximum model calls per job. */
export const AUTO_CALLS_DEFAULT = 200;
export const AUTO_CALLS_MAX = 200;
/** Default/maximum minimum spacing between planned images, in metres (0 disables thinning). */
export const AUTO_SPACING_DEFAULT_M = 10;
export const AUTO_SPACING_MAX_M = 1000;
/** Concept prompt text bounds. */
export const AUTO_CONCEPT_TEXT_MAX = 120;
/** Selection list bound (sequence IDs are small; images dominate bytes). */
export const AUTO_PLAN_JSON_BYTES_MAX = 64 * 1024;

export interface ValidatedAutoConcept {
  conceptId: string;
  text: string;
  category: "pole" | "luminaire";
}

export interface ValidatedAutoPlanRequest {
  mode: "detect" | "locate";
  snapshotId: string;
  streetSnapshotId: string | null;
  sequenceIds: string[];
  concepts: ValidatedAutoConcept[];
  maxImages: number;
  maxCalls: number;
  minSpacingM: number;
}

function checkConceptText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > AUTO_CONCEPT_TEXT_MAX) {
    fail("AUTO_PLAN_REJECTED", `Concept text must be 1..${AUTO_CONCEPT_TEXT_MAX} characters.`);
  }
  return (value as string).trim();
}

export function validateAutoPlanRequest(body: unknown): ValidatedAutoPlanRequest {
  if (!isRecord(body)) fail("AUTO_PLAN_REJECTED", "Auto plan body must be an object.");
  checkJsonBytes(body, AUTO_PLAN_JSON_BYTES_MAX, "auto plan");
  const record = body as Record<string, unknown>;
  if (record.mode !== "detect" && record.mode !== "locate") {
    fail("AUTO_PLAN_REJECTED", "Auto plan mode must be detect or locate.");
  }
  const sequenceIds = record.sequenceIds;
  if (!Array.isArray(sequenceIds) || sequenceIds.length === 0 || sequenceIds.length > AUTO_SEQUENCES_MAX) {
    fail("AUTO_PLAN_REJECTED", `Select 1..${AUTO_SEQUENCES_MAX} sequences.`);
  }
  const concepts = record.concepts;
  if (!Array.isArray(concepts) || concepts.length === 0 || concepts.length > AUTO_CONCEPTS_MAX) {
    fail("AUTO_PLAN_REJECTED", `Provide 1..${AUTO_CONCEPTS_MAX} concepts.`);
  }
  const maxImages = record.maxImages ?? AUTO_IMAGES_DEFAULT;
  const maxCalls = record.maxCalls ?? AUTO_CALLS_DEFAULT;
  for (const [name, value, max] of [
    ["maxImages", maxImages, AUTO_IMAGES_MAX],
    ["maxCalls", maxCalls, AUTO_CALLS_MAX],
  ] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
      fail("AUTO_PLAN_REJECTED", `${name} must be an integer 1..${max}.`);
    }
  }
  const minSpacingM = record.minSpacingM ?? AUTO_SPACING_DEFAULT_M;
  if (typeof minSpacingM !== "number" || !Number.isFinite(minSpacingM) || minSpacingM < 0 || minSpacingM > AUTO_SPACING_MAX_M) {
    fail("AUTO_PLAN_REJECTED", `minSpacingM must be a number 0..${AUTO_SPACING_MAX_M} (0 disables spacing thinning).`);
  }
  const parsedSequenceIds = (sequenceIds as unknown[]).map((entry, index) =>
    checkClientId(entry, `sequenceIds[${index}]`),
  );
  const parsedConcepts = (concepts as unknown[]).map((entry, index) => {
    if (!isRecord(entry)) fail("AUTO_PLAN_REJECTED", `concepts[${index}] must be an object.`);
    const concept = entry as Record<string, unknown>;
    if (concept.category !== "pole" && concept.category !== "luminaire") {
      fail("AUTO_PLAN_REJECTED", `concepts[${index}].category must be pole or luminaire.`);
    }
    return {
      conceptId: checkClientId(concept.conceptId, `concepts[${index}].conceptId`),
      text: checkConceptText(concept.text),
      category: concept.category as "pole" | "luminaire",
    };
  });
  const conceptIds = new Set(parsedConcepts.map((concept) => concept.conceptId));
  if (conceptIds.size !== parsedConcepts.length) {
    fail("AUTO_PLAN_REJECTED", "Concept ids must be unique.");
  }
  const streetSnapshotId = record.streetSnapshotId;
  if (streetSnapshotId !== null && streetSnapshotId !== undefined) {
    checkClientId(streetSnapshotId, "streetSnapshotId");
  }
  return {
    mode: record.mode as "detect" | "locate",
    snapshotId: checkClientId(record.snapshotId, "snapshotId"),
    streetSnapshotId: (streetSnapshotId ?? null) as string | null,
    // Duplicate sequence selections resolve to the same images; dedupe here so
    // the resolved plan (and its hash) is order- and repetition-stable.
    sequenceIds: [...new Set(parsedSequenceIds)].sort(),
    concepts: parsedConcepts,
    maxImages: maxImages as number,
    maxCalls: maxCalls as number,
    minSpacingM: minSpacingM as number,
  };
}

export interface ValidatedAutoLaunch extends ValidatedAutoPlanRequest {
  idempotencyKey: string;
}

export function validateAutoLaunch(body: unknown): ValidatedAutoLaunch {
  const plan = validateAutoPlanRequest(body);
  const record = body as Record<string, unknown>;
  return { ...plan, idempotencyKey: checkClientId(record.idempotencyKey, "idempotencyKey") };
}

/** Canonical plan hash for launch idempotency comparison and auditing. */
export function canonicalPlanHash(plan: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(plan), "utf8").digest("hex");
}

/** Frozen view-generation recipe (v1: one flat view per image). */
export interface AutoViewRecipe {
  version: 1;
  panoViews: "flat";
  thumbKind: "thumb_2048_url";
  analysisLongSidePx: 2048;
  encodeMime: "image/jpeg";
  encodeQuality: 90;
}

export function autoViewRecipe(): AutoViewRecipe {
  return {
    version: 1,
    panoViews: "flat",
    thumbKind: "thumb_2048_url",
    analysisLongSidePx: 2048,
    encodeMime: "image/jpeg",
    encodeQuality: 90,
  };
}

/** Frozen per-image geometry/eligibility record inside a resolved plan. */
export interface ValidatedPlanImageMeta {
  imageId: string;
  sequenceId: string;
  cameraType: string | null;
  cameraParameters: number[] | null;
  originalWidth: number | null;
  originalHeight: number | null;
  exifOrientation: number | null;
  computedLngLat: [number, number] | null;
  originalLngLat: [number, number] | null;
  computedAltitudeM: number | null;
  originalAltitudeM: number | null;
  rotationAxisAngle: [number, number, number] | null;
  computedCompassDeg: number | null;
  compassDeg: number | null;
  mergeCc: number | null;
  atomicScale: number | null;
  capturedAt: number | null;
  isPano: boolean | null;
  /** Provider field names present in the raw record (bounded). */
  metadataFields: string[];
  eligible: boolean;
  ineligibleReason: string | null;
}

export interface AutoPrepareCounts {
  totalImages: number;
  eligibleImages: number;
  detectionOnlyImages: number;
  perspectiveImages: number;
  panoImages: number;
  fisheyeImages: number;
  unknownCameraImages: number;
  missingMetadataImages: number;
}

/** Hash input for plan fingerprints (frozen inputs only; counts/warnings derive). */
export interface PlanHashInput {
  mode: string;
  snapshotId: string;
  streetSnapshotId: string | null;
  sequenceIds: string[];
  imageIds: string[];
  concepts: ValidatedAutoConcept[];
  thresholds: AutoThresholds;
  recipe: AutoViewRecipe;
  images: ValidatedPlanImageMeta[];
}

export function planHashInput(plan: PlanHashInput): Record<string, unknown> {
  return {
    mode: plan.mode,
    snapshotId: plan.snapshotId,
    streetSnapshotId: plan.streetSnapshotId,
    sequenceIds: plan.sequenceIds,
    imageIds: plan.imageIds,
    concepts: [...plan.concepts]
      .sort((a, b) => (a.conceptId < b.conceptId ? -1 : 1))
      .map((concept) => ({ ...concept })),
    thresholds: { ...plan.thresholds },
    recipe: { ...plan.recipe },
    images: plan.images.map((image) => ({ ...image })),
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Geometry thresholds snapshotted into each plan (single source: geo).
// ---------------------------------------------------------------------------

export interface AutoThresholds {
  minLocatedViews: number;
  minParallaxDeg: number;
  maxRayGapM: number;
  maxReprojectionPx: number;
}

export function currentAutoThresholds(): AutoThresholds {
  return {
    minLocatedViews: MIN_LOCATED_VIEWS,
    minParallaxDeg: MIN_PARALLAX_DEG,
    maxRayGapM: MAX_RAY_GAP_M,
    maxReprojectionPx: MAX_REPROJECTION_PX,
  };
}

// ---------------------------------------------------------------------------
// Per-image provider metadata (Mapillary image entity fields).
// ---------------------------------------------------------------------------

/**
 * Documented Graph image-entity fields consumed here: camera_type,
 * camera_parameters, width, height, exif_orientation, geometry,
 * computed_geometry, altitude, computed_altitude, computed_rotation,
 * compass_angle, computed_compass_angle, merge_cc, atomic_scale,
 * captured_at, is_pano. See the official Mapillary API documentation.
 *
 * Lenient by design: malformed or missing values become null and disable
 * the affected geometric capability instead of breaking imagery loading.
 */
export function validateAutoImageMetadata(
  raw: unknown,
  imageId: string,
  sequenceId: string,
): ValidatedPlanImageMeta {
  const record = isRecord(raw) ? (raw as Record<string, unknown>) : {};
  const asFinite = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const asPositiveInt = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  const asTriple = (value: unknown): [number, number, number] | null =>
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ? (value as [number, number, number])
      : null;
  const asLngLat = (value: unknown): [number, number] | null => {
    if (!isRecord(value)) return null;
    const point = value as Record<string, unknown>;
    if (point.type !== "Point" || !Array.isArray(point.coordinates)) return null;
    const [lng, lat] = point.coordinates as unknown[];
    if (
      typeof lng !== "number" ||
      typeof lat !== "number" ||
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      Math.abs(lng) > 180 ||
      Math.abs(lat) > 90
    ) {
      return null;
    }
    return [lng, lat];
  };
  const rawCameraType = record.camera_type;
  const cameraType =
    typeof rawCameraType === "string" && rawCameraType.length > 0 && rawCameraType.length <= 40
      ? rawCameraType
      : null;
  const rawParams = record.camera_parameters;
  const cameraParameters =
    Array.isArray(rawParams) && rawParams.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ? (rawParams as number[])
      : null;
  const originalWidth = asPositiveInt(record.width);
  const originalHeight = asPositiveInt(record.height);
  const exifOrientation = asPositiveInt(record.exif_orientation);
  const computedLngLat = asLngLat(record.computed_geometry);
  const originalLngLat = asLngLat(record.geometry);
  const computedAltitudeM = asFinite(record.computed_altitude);
  const originalAltitudeM = asFinite(record.altitude);
  const rotationAxisAngle = asTriple(record.computed_rotation);
  const computedCompassDeg = asFinite(record.computed_compass_angle);
  const compassDeg = asFinite(record.compass_angle);
  const mergeCc =
    typeof record.merge_cc === "number" && Number.isSafeInteger(record.merge_cc) && record.merge_cc >= 0
      ? record.merge_cc
      : null;
  const atomicScale = asFinite(record.atomic_scale);
  const capturedAt =
    typeof record.captured_at === "number" && Number.isFinite(record.captured_at)
      ? record.captured_at
      : null;
  const isPano = typeof record.is_pano === "boolean" ? record.is_pano : null;
  const metadataFields = Object.keys(record)
    .filter((key) => key.length > 0 && key.length <= 80)
    .slice(0, 60);

  // Eligibility: usable calibration, known dimensions, a coherent position,
  // a computed rotation, and an altitude. Compass-only orientation never
  // qualifies; absent values stay absent.
  let ineligibleReason: string | null = null;
  if (!originalWidth || !originalHeight) {
    ineligibleReason = "unknown-dimensions";
  } else {
    const verdict = validateCameraDescriptor({
      cameraType,
      cameraParameters,
      width: originalWidth,
      height: originalHeight,
    });
    if (!verdict.ok) {
      ineligibleReason =
        cameraType === "fisheye"
          ? "fisheye"
          : cameraType !== "perspective" &&
              cameraType !== "equirectangular" &&
              cameraType !== "spherical"
            ? "unknown-camera"
            : "bad-calibration";
    } else if (!computedLngLat && !originalLngLat) {
      ineligibleReason = "no-position";
    } else if (!rotationAxisAngle) {
      ineligibleReason = "no-rotation";
    } else if (computedAltitudeM === null && originalAltitudeM === null) {
      ineligibleReason = "no-altitude";
    }
  }
  return {
    imageId,
    sequenceId,
    cameraType,
    cameraParameters,
    originalWidth,
    originalHeight,
    exifOrientation,
    computedLngLat,
    originalLngLat,
    computedAltitudeM,
    originalAltitudeM,
    rotationAxisAngle,
    computedCompassDeg,
    compassDeg,
    mergeCc,
    atomicScale,
    capturedAt,
    isPano,
    metadataFields,
    eligible: ineligibleReason === null,
    ineligibleReason,
  };
}

/** Counts derived from a frozen image table (recomputed, never trusted). */
export function autoPrepareCounts(images: ValidatedPlanImageMeta[]): AutoPrepareCounts {
  const counts: AutoPrepareCounts = {
    totalImages: images.length,
    eligibleImages: 0,
    detectionOnlyImages: 0,
    perspectiveImages: 0,
    panoImages: 0,
    fisheyeImages: 0,
    unknownCameraImages: 0,
    missingMetadataImages: 0,
  };
  for (const image of images) {
    if (image.eligible) counts.eligibleImages += 1;
    else counts.detectionOnlyImages += 1;
    if (image.ineligibleReason === "metadata-unavailable") counts.missingMetadataImages += 1;
    if (image.cameraType === "perspective") counts.perspectiveImages += 1;
    else if (image.cameraType === "equirectangular" || image.cameraType === "spherical") {
      counts.panoImages += 1;
    } else if (image.cameraType === "fisheye") counts.fisheyeImages += 1;
    else counts.unknownCameraImages += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Prepared view descriptors.
// ---------------------------------------------------------------------------

export type AutoViewOp =
  | { op: "orient"; exif: 1 | 3 | 6 | 8; fromW: number; fromH: number }
  | { op: "resize"; fromW: number; fromH: number; toW: number; toH: number }
  | { op: "crop"; x: number; y: number; w: number; h: number };

export interface ValidatedAutoViewPose {
  centerEnu: [number, number, number];
  rotationWcAxisAngle: [number, number, number];
  positionSource: "computed" | "original";
  rotationSource: "computed";
}

export interface ValidatedAutoViewSource {
  imageId: string;
  thumbKind: string | null;
  geometrySource: "plan" | "prep-refetch";
  originalWidth: number | null;
  originalHeight: number | null;
  providerExifOrientation: number | null;
  observedExifOrientation: number | null;
  originalLngLat: [number, number] | null;
  computedLngLat: [number, number] | null;
  compassDeg: number | null;
  altitudeM: number | null;
  mergeCc: number | null;
  atomicScale: number | null;
  metadataFields: string[];
  prepWarnings: string[];
}

export interface ValidatedAutoViewDescriptor {
  width: number;
  height: number;
  chain: { ops: AutoViewOp[] };
  /**
   * Usable calibration, or null when the camera model is unknown or
   * unsupported. Absent stays absent: never an invented focal length.
   */
  camera: Record<string, unknown> | null;
  /**
   * Coherent positioning pose, or null when unusable (detection-only view).
   * A compass heading alone never produces a pose.
   */
  pose: ValidatedAutoViewPose | null;
  anchor: { lngLat: [number, number]; altM: number };
  source: ValidatedAutoViewSource;
}

function checkPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a positive integer.`);
  }
  return value as number;
}

function checkFiniteTriple(value: unknown, field: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    fail("STORAGE_BAD_REQUEST", `${field} must be three finite numbers.`);
  }
  return value as [number, number, number];
}

function checkViewOp(value: unknown, field: string): AutoViewOp {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be an object.`);
  const op = value as Record<string, unknown>;
  if (op.op === "orient") {
    if (op.exif !== 1 && op.exif !== 3 && op.exif !== 6 && op.exif !== 8) {
      fail("STORAGE_BAD_REQUEST", `${field}.exif must be 1, 3, 6, or 8.`);
    }
    return {
      op: "orient",
      exif: op.exif as 1 | 3 | 6 | 8,
      fromW: checkPositiveInt(op.fromW, `${field}.fromW`),
      fromH: checkPositiveInt(op.fromH, `${field}.fromH`),
    };
  }
  if (op.op === "resize") {
    return {
      op: "resize",
      fromW: checkPositiveInt(op.fromW, `${field}.fromW`),
      fromH: checkPositiveInt(op.fromH, `${field}.fromH`),
      toW: checkPositiveInt(op.toW, `${field}.toW`),
      toH: checkPositiveInt(op.toH, `${field}.toH`),
    };
  }
  if (op.op === "crop") {
    for (const key of ["x", "y", "w", "h"] as const) {
      const entry = op[key];
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
        fail("STORAGE_BAD_REQUEST", `${field}.${key} must be a non-negative integer.`);
      }
    }
    return {
      op: "crop",
      x: op.x as number,
      y: op.y as number,
      w: op.w as number,
      h: op.h as number,
    };
  }
  fail("STORAGE_BAD_REQUEST", `${field}.op must be orient, resize, or crop.`);
}

function checkOptionalPositiveInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return checkPositiveInt(value, field);
}

function checkOptionalFinite(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("STORAGE_BAD_REQUEST", `${field} must be finite or null.`);
  }
  return value as number;
}

function checkOptionalLngLat(value: unknown, field: string): [number, number] | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    fail("STORAGE_BAD_REQUEST", `${field} must be two finite numbers or null.`);
  }
  return value as [number, number];
}

function checkOptionalComponentId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.source.mergeCc must be a non-negative integer or null.");
  }
  return value as number;
}

function checkShortStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    fail("STORAGE_BAD_REQUEST", `${field} must list at most ${maxItems} strings.`);
  }
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maxLength) {
      fail("STORAGE_BAD_REQUEST", `${field}[${index}] must be 1..${maxLength} characters.`);
    }
  }
  return value as string[];
}

function checkViewSource(value: unknown): ValidatedAutoViewSource {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", "viewDescriptor.source must be an object.");
  const source = value as Record<string, unknown>;
  // Unknown provider keys are dropped: the stored descriptor keeps a known,
  // bounded provenance record, not the whole provider response.
  const geometrySource = source.geometrySource;
  if (geometrySource !== "plan" && geometrySource !== "prep-refetch") {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.source.geometrySource must be plan or prep-refetch.");
  }
  const thumbKind = source.thumbKind;
  if (thumbKind !== null && thumbKind !== undefined && typeof thumbKind !== "string") {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.source.thumbKind must be a string or null.");
  }
  return {
    imageId: checkClientId(source.imageId, "viewDescriptor.source.imageId"),
    thumbKind: (thumbKind ?? null) as string | null,
    geometrySource,
    originalWidth: checkOptionalPositiveInt(source.originalWidth, "viewDescriptor.source.originalWidth"),
    originalHeight: checkOptionalPositiveInt(source.originalHeight, "viewDescriptor.source.originalHeight"),
    providerExifOrientation: checkOptionalPositiveInt(
      source.providerExifOrientation,
      "viewDescriptor.source.providerExifOrientation",
    ),
    observedExifOrientation: checkOptionalPositiveInt(
      source.observedExifOrientation,
      "viewDescriptor.source.observedExifOrientation",
    ),
    originalLngLat: checkOptionalLngLat(source.originalLngLat, "viewDescriptor.source.originalLngLat"),
    computedLngLat: checkOptionalLngLat(source.computedLngLat, "viewDescriptor.source.computedLngLat"),
    compassDeg: checkOptionalFinite(source.compassDeg, "viewDescriptor.source.compassDeg"),
    altitudeM: checkOptionalFinite(source.altitudeM, "viewDescriptor.source.altitudeM"),
    mergeCc: checkOptionalComponentId(source.mergeCc),
    atomicScale: checkOptionalFinite(source.atomicScale, "viewDescriptor.source.atomicScale"),
    metadataFields: checkShortStringArray(source.metadataFields, "viewDescriptor.source.metadataFields", 60, 80),
    prepWarnings: checkShortStringArray(source.prepWarnings, "viewDescriptor.source.prepWarnings", 10, 200),
  };
}

function checkViewPose(value: unknown): ValidatedAutoViewPose | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", "viewDescriptor.pose must be an object or null.");
  const pose = value as Record<string, unknown>;
  if (pose.positionSource !== "computed" && pose.positionSource !== "original") {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.pose.positionSource must be computed or original.");
  }
  if (pose.rotationSource !== "computed") {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.pose.rotationSource must be computed.");
  }
  return {
    centerEnu: checkFiniteTriple(pose.centerEnu, "viewDescriptor.pose.centerEnu"),
    rotationWcAxisAngle: checkFiniteTriple(
      pose.rotationWcAxisAngle,
      "viewDescriptor.pose.rotationWcAxisAngle",
    ),
    positionSource: pose.positionSource,
    rotationSource: pose.rotationSource,
  };
}

export function validateAutoViewDescriptor(value: unknown): ValidatedAutoViewDescriptor {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", "viewDescriptor must be an object.");
  const record = value as Record<string, unknown>;
  const width = checkPositiveInt(record.width, "viewDescriptor.width");
  const height = checkPositiveInt(record.height, "viewDescriptor.height");
  const chain = record.chain;
  if (!isRecord(chain) || !Array.isArray(chain.ops) || chain.ops.length > 8) {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.chain.ops must be an array of at most 8 ops.");
  }
  const ops = (chain.ops as unknown[]).map((entry, index) =>
    checkViewOp(entry, `viewDescriptor.chain.ops[${index}]`),
  );
  const camera = record.camera;
  let parsedCamera: Record<string, unknown> | null = null;
  if (camera !== null && camera !== undefined) {
    if (!isRecord(camera)) fail("STORAGE_BAD_REQUEST", "viewDescriptor.camera must be an object or null.");
    const verdict = validateCameraDescriptor({
      cameraType: (camera as Record<string, unknown>).cameraType,
      cameraParameters: (camera as Record<string, unknown>).cameraParameters,
      width,
      height,
    });
    if (!verdict.ok) fail("STORAGE_BAD_REQUEST", `Unusable camera: ${verdict.reason}`);
    parsedCamera = camera as Record<string, unknown>;
  }
  const anchor = record.anchor;
  if (!isRecord(anchor)) fail("STORAGE_BAD_REQUEST", "viewDescriptor.anchor must be an object.");
  const anchorRecord = anchor as Record<string, unknown>;
  const lngLat = anchorRecord.lngLat;
  if (
    !Array.isArray(lngLat) ||
    lngLat.length !== 2 ||
    lngLat.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.anchor.lngLat must be two finite numbers.");
  }
  if (typeof anchorRecord.altM !== "number" || !Number.isFinite(anchorRecord.altM)) {
    fail("STORAGE_BAD_REQUEST", "viewDescriptor.anchor.altM must be finite.");
  }
  return {
    width,
    height,
    chain: { ops },
    camera: parsedCamera,
    pose: checkViewPose(record.pose),
    anchor: { lngLat: lngLat as [number, number], altM: anchorRecord.altM as number },
    source: checkViewSource(record.source),
  };
}

// ---------------------------------------------------------------------------
// Observations, candidates, results.
// ---------------------------------------------------------------------------

export const AUTO_BOX_MAX = 1;

export interface ValidatedAutoObservation {
  observationId: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number | null;
  anchor: Record<string, unknown>;
  maskSupport: Record<string, unknown> | null;
  maskArtifactId: string | null;
  ray: { origin: [number, number, number]; direction: [number, number, number] } | null;
  rayFailure: string | null;
  nearSeam: boolean;
  truncated: boolean;
}

function checkUnitBox(value: unknown, field: string): { x: number; y: number; w: number; h: number } {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be an object.`);
  const box = value as Record<string, unknown>;
  for (const key of ["x", "y", "w", "h"] as const) {
    const entry = box[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > AUTO_BOX_MAX) {
      fail("STORAGE_BAD_REQUEST", `${field}.${key} must be within [0, 1].`);
    }
  }
  return { x: box.x as number, y: box.y as number, w: box.w as number, h: box.h as number };
}

export function validateAutoObservation(value: unknown): ValidatedAutoObservation {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", "Observation must be an object.");
  const record = value as Record<string, unknown>;
  const confidence = record.confidence;
  if (confidence !== null && confidence !== undefined) {
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      fail("STORAGE_BAD_REQUEST", "Observation confidence must be within [0, 1].");
    }
  }
  const anchor = record.anchor;
  if (!isRecord(anchor)) fail("STORAGE_BAD_REQUEST", "Observation anchor must be an object.");
  const maskSupport = record.maskSupport;
  if (maskSupport !== null && maskSupport !== undefined && !isRecord(maskSupport)) {
    fail("STORAGE_BAD_REQUEST", "Observation maskSupport must be an object or null.");
  }
  const ray = record.ray;
  let parsedRay: ValidatedAutoObservation["ray"] = null;
  if (ray !== null && ray !== undefined) {
    if (!isRecord(ray)) fail("STORAGE_BAD_REQUEST", "Observation ray must be an object or null.");
    const rayRecord = ray as Record<string, unknown>;
    parsedRay = {
      origin: checkFiniteTriple(rayRecord.origin, "observation.ray.origin"),
      direction: checkFiniteTriple(rayRecord.direction, "observation.ray.direction"),
    };
  }
  const rayFailure = record.rayFailure;
  if (rayFailure !== null && rayFailure !== undefined && typeof rayFailure !== "string") {
    fail("STORAGE_BAD_REQUEST", "Observation rayFailure must be a string or null.");
  }
  if (parsedRay && rayFailure) {
    fail("STORAGE_BAD_REQUEST", "Observation must not carry both a ray and a rayFailure.");
  }
  if (!parsedRay && !rayFailure) {
    fail("STORAGE_BAD_REQUEST", "Observation without a ray needs a rayFailure reason.");
  }
  const maskArtifactId = record.maskArtifactId;
  if (maskArtifactId !== null && maskArtifactId !== undefined) {
    if (typeof maskArtifactId !== "string" || !/^[0-9a-f]{24}$/.test(maskArtifactId)) {
      fail("STORAGE_BAD_REQUEST", "Observation maskArtifactId must be a 24-hex id or null.");
    }
  }
  return {
    observationId: checkClientId(record.observationId, "observationId"),
    box: checkUnitBox(record.box, "observation.box"),
    confidence: (confidence ?? null) as number | null,
    anchor: anchor as Record<string, unknown>,
    maskSupport: (maskSupport ?? null) as Record<string, unknown> | null,
    maskArtifactId: (maskArtifactId ?? null) as string | null,
    ray: parsedRay,
    rayFailure: (rayFailure ?? null) as string | null,
    nearSeam: record.nearSeam === true,
    truncated: record.truncated === true,
  };
}

export type ValidatedCandidateStatus = "candidate" | "located" | "needs-review" | "rejected";

export interface ValidatedAutoCandidate {
  candidateId: string;
  kind: "pole" | "luminaire";
  status: ValidatedCandidateStatus;
  observationIds: string[];
  imageIds: string[];
  streetId: string | null;
  viewCount: number;
  position: {
    lng: number;
    lat: number;
    uncertaintyM: number;
    method: string;
  } | null;
  fit: Record<string, unknown> | null;
  poleCandidateId: string | null;
  luminaireCandidateIds: string[];
  checks: string[];
}

const CANDIDATE_STATUSES: ValidatedCandidateStatus[] = ["candidate", "located", "needs-review", "rejected"];

export function validateAutoCandidate(body: unknown): ValidatedAutoCandidate {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Candidate body must be an object.");
  const record = body as Record<string, unknown>;
  if (record.kind !== "pole" && record.kind !== "luminaire") {
    fail("STORAGE_BAD_REQUEST", "Candidate kind must be pole or luminaire.");
  }
  if (!CANDIDATE_STATUSES.includes(record.status as ValidatedCandidateStatus)) {
    fail("STORAGE_BAD_REQUEST", "Candidate status must be candidate, located, needs-review, or rejected.");
  }
  const status = record.status as ValidatedCandidateStatus;
  const observationIds = record.observationIds;
  if (!Array.isArray(observationIds) || observationIds.length === 0 || observationIds.length > 500) {
    fail("STORAGE_BAD_REQUEST", "Candidate observationIds must list 1..500 observations.");
  }
  const imageIds = record.imageIds;
  if (!Array.isArray(imageIds) || imageIds.length === 0 || imageIds.length > 500) {
    fail("STORAGE_BAD_REQUEST", "Candidate imageIds must list 1..500 images.");
  }
  const parsedImageIds = (imageIds as unknown[]).map((entry, index) =>
    checkClientId(entry, `imageIds[${index}]`),
  );
  if (new Set(parsedImageIds).size !== parsedImageIds.length) {
    fail("STORAGE_BAD_REQUEST", "Candidate imageIds must be unique.");
  }
  if (record.viewCount !== parsedImageIds.length) {
    fail("STORAGE_BAD_REQUEST", "Candidate viewCount must equal the image count.");
  }
  const position = record.position;
  let parsedPosition: ValidatedAutoCandidate["position"] = null;
  if (position !== null && position !== undefined) {
    if (!isRecord(position)) fail("STORAGE_BAD_REQUEST", "Candidate position must be an object or null.");
    const pos = position as Record<string, unknown>;
    for (const key of ["lng", "lat", "uncertaintyM"] as const) {
      if (typeof pos[key] !== "number" || !Number.isFinite(pos[key] as number)) {
        fail("STORAGE_BAD_REQUEST", `Candidate position.${key} must be finite.`);
      }
    }
    if (typeof pos.method !== "string" || pos.method.length === 0 || pos.method.length > 120) {
      fail("STORAGE_BAD_REQUEST", "Candidate position.method must be 1..120 characters.");
    }
    parsedPosition = {
      lng: pos.lng as number,
      lat: pos.lat as number,
      uncertaintyM: pos.uncertaintyM as number,
      method: pos.method as string,
    };
  }
  if (status === "located" && !parsedPosition) {
    fail("STORAGE_BAD_REQUEST", "Located candidates need a position.");
  }
  if (status !== "located" && parsedPosition) {
    fail("STORAGE_BAD_REQUEST", "Only located candidates may carry a position.");
  }
  const fit = record.fit;
  if (fit !== null && fit !== undefined && !isRecord(fit)) {
    fail("STORAGE_BAD_REQUEST", "Candidate fit must be an object or null.");
  }
  const poleCandidateId = record.poleCandidateId;
  if (poleCandidateId !== null && poleCandidateId !== undefined) {
    checkClientId(poleCandidateId, "poleCandidateId");
  }
  const streetId = record.streetId;
  if (streetId !== null && streetId !== undefined) {
    checkClientId(streetId, "streetId");
  }
  const luminaireCandidateIds = record.luminaireCandidateIds ?? [];
  if (!Array.isArray(luminaireCandidateIds) || luminaireCandidateIds.length > 50) {
    fail("STORAGE_BAD_REQUEST", "Candidate luminaireCandidateIds must list at most 50 ids.");
  }
  const checks = record.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 50 || checks.some((entry) => typeof entry !== "string")) {
    fail("STORAGE_BAD_REQUEST", "Candidate checks must list at most 50 strings.");
  }
  return {
    candidateId: checkClientId(record.candidateId, "candidateId"),
    kind: record.kind as "pole" | "luminaire",
    status,
    observationIds: (observationIds as unknown[]).map((entry, index) =>
      checkClientId(entry, `observationIds[${index}]`),
    ),
    imageIds: parsedImageIds,
    streetId: (streetId ?? null) as string | null,
    viewCount: parsedImageIds.length,
    position: parsedPosition,
    fit: (fit ?? null) as Record<string, unknown> | null,
    poleCandidateId: (poleCandidateId ?? null) as string | null,
    luminaireCandidateIds: (luminaireCandidateIds as unknown[]).map((entry, index) =>
      checkClientId(entry, `luminaireCandidateIds[${index}]`),
    ),
    checks: checks as string[],
  };
}

// ---------------------------------------------------------------------------
// Prepare snapshots (launch-time re-validation of the frozen plan).
// ---------------------------------------------------------------------------

export interface ValidatedAutoPrepare {
  plan: ResolvedAutoPlan;
  planHash: string;
  counts: AutoPrepareCounts;
  warnings: string[];
}

function checkStoredPlanImage(value: unknown, field: string): ValidatedPlanImageMeta {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be an object.`);
  const image = value as Record<string, unknown>;
  const asNullable = <T>(entry: unknown): T | null => (entry === undefined ? null : (entry as T | null));
  const parsed: ValidatedPlanImageMeta = {
    imageId: checkClientId(image.imageId, `${field}.imageId`),
    sequenceId: checkClientId(image.sequenceId, `${field}.sequenceId`),
    cameraType: asNullable<string>(image.cameraType),
    cameraParameters: asNullable<number[]>(image.cameraParameters),
    originalWidth: asNullable<number>(image.originalWidth),
    originalHeight: asNullable<number>(image.originalHeight),
    exifOrientation: asNullable<number>(image.exifOrientation),
    computedLngLat: asNullable<[number, number]>(image.computedLngLat),
    originalLngLat: asNullable<[number, number]>(image.originalLngLat),
    computedAltitudeM: asNullable<number>(image.computedAltitudeM),
    originalAltitudeM: asNullable<number>(image.originalAltitudeM),
    rotationAxisAngle: asNullable<[number, number, number]>(image.rotationAxisAngle),
    computedCompassDeg: asNullable<number>(image.computedCompassDeg),
    compassDeg: asNullable<number>(image.compassDeg),
    mergeCc: asNullable<number>(image.mergeCc),
    atomicScale: asNullable<number>(image.atomicScale),
    capturedAt: asNullable<number>(image.capturedAt),
    isPano: asNullable<boolean>(image.isPano),
    metadataFields: checkShortStringArray(image.metadataFields, `${field}.metadataFields`, 60, 80),
    eligible: image.eligible as boolean,
    ineligibleReason: asNullable<string>(image.ineligibleReason),
  };
  if (typeof parsed.eligible !== "boolean") {
    fail("STORAGE_BAD_REQUEST", `${field}.eligible must be a boolean.`);
  }
  // The eligibility flag must agree with its own record: an eligible image
  // carries calibration, position, rotation, and altitude with no reason.
  if (parsed.eligible) {
    if (
      !parsed.cameraParameters ||
      !parsed.originalWidth ||
      !parsed.originalHeight ||
      (!parsed.computedLngLat && !parsed.originalLngLat) ||
      !parsed.rotationAxisAngle ||
      (parsed.computedAltitudeM === null && parsed.originalAltitudeM === null) ||
      parsed.ineligibleReason !== null
    ) {
      fail("STORAGE_BAD_REQUEST", `${field} claims eligibility without complete geometry.`);
    }
  } else if (typeof parsed.ineligibleReason !== "string" || parsed.ineligibleReason.length === 0) {
    fail("STORAGE_BAD_REQUEST", `${field} needs an ineligibleReason.`);
  }
  return parsed;
}

/**
 * Re-validate a stored auto-prepare snapshot before launch. Corrupt or
 * tampered prepares fail closed with an actionable message (re-prepare);
 * the plan hash is recomputed, counts are re-derived, never trusted.
 */
export function validateAutoPrepare(value: unknown): ValidatedAutoPrepare {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", "Prepare payload must be an object.");
  const record = value as Record<string, unknown>;
  if (!isRecord(record.plan)) fail("STORAGE_BAD_REQUEST", "Prepare payload needs a plan object.");
  const plan = record.plan as Record<string, unknown>;
  if (plan.mode !== "detect" && plan.mode !== "locate") {
    fail("STORAGE_BAD_REQUEST", "Prepare plan mode must be detect or locate.");
  }
  const snapshotId = checkClientId(plan.snapshotId, "plan.snapshotId");
  const streetSnapshotId = plan.streetSnapshotId;
  if (streetSnapshotId !== null && streetSnapshotId !== undefined) {
    checkClientId(streetSnapshotId, "plan.streetSnapshotId");
  }
  const sequenceIds = plan.sequenceIds;
  if (!Array.isArray(sequenceIds) || sequenceIds.length === 0 || sequenceIds.length > AUTO_SEQUENCES_MAX) {
    fail("STORAGE_BAD_REQUEST", `Prepare plan needs 1..${AUTO_SEQUENCES_MAX} sequenceIds.`);
  }
  const parsedSequenceIds = (sequenceIds as unknown[]).map((entry, index) =>
    checkClientId(entry, `plan.sequenceIds[${index}]`),
  );
  const imageIds = plan.imageIds;
  if (!Array.isArray(imageIds) || imageIds.length === 0 || imageIds.length > AUTO_IMAGES_MAX) {
    fail("STORAGE_BAD_REQUEST", `Prepare plan needs 1..${AUTO_IMAGES_MAX} imageIds.`);
  }
  const parsedImageIds = (imageIds as unknown[]).map((entry, index) =>
    checkClientId(entry, `plan.imageIds[${index}]`),
  );
  if (plan.totalImages !== parsedImageIds.length) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan totalImages must match its imageIds.");
  }
  const perSequence = plan.perSequence;
  if (!Array.isArray(perSequence) || perSequence.length !== parsedSequenceIds.length) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan perSequence must cover every sequence.");
  }
  const grouped = new Set<string>();
  for (const [index, entry] of (perSequence as unknown[]).entries()) {
    if (!isRecord(entry)) fail("STORAGE_BAD_REQUEST", `Prepare plan perSequence[${index}] must be an object.`);
    const group = entry as Record<string, unknown>;
    if (!parsedSequenceIds.includes(group.sequenceId as string)) {
      fail("STORAGE_BAD_REQUEST", `Prepare plan perSequence[${index}] names an unknown sequence.`);
    }
    if (!Array.isArray(group.imageIds)) {
      fail("STORAGE_BAD_REQUEST", `Prepare plan perSequence[${index}].imageIds must be an array.`);
    }
    for (const imageId of group.imageIds as unknown[]) {
      if (typeof imageId !== "string" || !parsedImageIds.includes(imageId)) {
        fail("STORAGE_BAD_REQUEST", `Prepare plan perSequence[${index}] lists an unknown image.`);
      }
      grouped.add(imageId);
    }
  }
  if (grouped.size !== parsedImageIds.length) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan perSequence must group every image exactly once.");
  }
  const concepts = plan.concepts;
  if (!Array.isArray(concepts) || concepts.length === 0 || concepts.length > AUTO_CONCEPTS_MAX) {
    fail("STORAGE_BAD_REQUEST", `Prepare plan needs 1..${AUTO_CONCEPTS_MAX} concepts.`);
  }
  const parsedConcepts = (concepts as unknown[]).map((entry, index) => {
    if (!isRecord(entry)) fail("STORAGE_BAD_REQUEST", `Prepare plan concepts[${index}] must be an object.`);
    const concept = entry as Record<string, unknown>;
    if (concept.category !== "pole" && concept.category !== "luminaire") {
      fail("STORAGE_BAD_REQUEST", `Prepare plan concepts[${index}].category must be pole or luminaire.`);
    }
    return {
      conceptId: checkClientId(concept.conceptId, `plan.concepts[${index}].conceptId`),
      text: checkConceptText(concept.text),
      category: concept.category as "pole" | "luminaire",
    };
  });
  if (plan.estimatedCalls !== parsedImageIds.length * parsedConcepts.length) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan estimatedCalls must equal images times concepts.");
  }
  for (const [name, max] of [
    ["maxImages", AUTO_IMAGES_MAX],
    ["maxCalls", AUTO_CALLS_MAX],
  ] as const) {
    const bound = plan[name];
    if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 1 || bound > max) {
      fail("STORAGE_BAD_REQUEST", `Prepare plan ${name} must be an integer 1..${max}.`);
    }
  }
  if (parsedImageIds.length > (plan.maxImages as number)) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan exceeds its maxImages bound.");
  }
  if ((plan.estimatedCalls as number) > (plan.maxCalls as number)) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan exceeds its maxCalls bound.");
  }
  if (!isRecord(plan.anchor)) fail("STORAGE_BAD_REQUEST", "Prepare plan needs an anchor object.");
  const anchor = plan.anchor as Record<string, unknown>;
  const lngLat = anchor.lngLat;
  if (
    !Array.isArray(lngLat) ||
    lngLat.length !== 2 ||
    lngLat.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan anchor.lngLat must be two finite numbers.");
  }
  if (typeof anchor.altM !== "number" || !Number.isFinite(anchor.altM)) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan anchor.altM must be finite.");
  }
  if (!isRecord(plan.thresholds)) fail("STORAGE_BAD_REQUEST", "Prepare plan needs a thresholds object.");
  const thresholds = plan.thresholds as Record<string, unknown>;
  for (const key of ["minLocatedViews", "minParallaxDeg", "maxRayGapM", "maxReprojectionPx"] as const) {
    if (typeof thresholds[key] !== "number" || !Number.isFinite(thresholds[key] as number)) {
      fail("STORAGE_BAD_REQUEST", `Prepare plan thresholds.${key} must be finite.`);
    }
  }
  const recipe = plan.recipe as Record<string, unknown> | undefined;
  const expectedRecipe = autoViewRecipe();
  if (
    !isRecord(recipe) ||
    recipe.version !== expectedRecipe.version ||
    recipe.panoViews !== expectedRecipe.panoViews ||
    recipe.thumbKind !== expectedRecipe.thumbKind ||
    recipe.analysisLongSidePx !== expectedRecipe.analysisLongSidePx ||
    recipe.encodeMime !== expectedRecipe.encodeMime ||
    recipe.encodeQuality !== expectedRecipe.encodeQuality
  ) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan recipe must be the current view recipe.");
  }
  const images = plan.images;
  if (!Array.isArray(images) || images.length !== parsedImageIds.length) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan needs one image record per imageId.");
  }
  const parsedImages = (images as unknown[]).map((entry, index) =>
    checkStoredPlanImage(entry, `plan.images[${index}]`),
  );
  for (const image of parsedImages) {
    if (!parsedImageIds.includes(image.imageId) || !parsedSequenceIds.includes(image.sequenceId)) {
      fail("STORAGE_BAD_REQUEST", `Prepare plan image ${image.imageId} is outside the selection.`);
    }
  }
  if (typeof plan.plannedAt !== "number" || !Number.isFinite(plan.plannedAt)) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan plannedAt must be finite.");
  }
  if (typeof plan.droppedSeeds !== "number" || !Number.isSafeInteger(plan.droppedSeeds) || plan.droppedSeeds < 0) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan droppedSeeds must be a non-negative integer.");
  }
  for (const key of ["excludedOutsideRoi", "thinnedBySpacing"] as const) {
    const value = (plan as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      fail("STORAGE_BAD_REQUEST", `Prepare plan ${key} must be a non-negative integer.`);
    }
  }
  if (
    typeof plan.minSpacingM !== "number" ||
    !Number.isFinite(plan.minSpacingM) ||
    plan.minSpacingM < 0 ||
    plan.minSpacingM > AUTO_SPACING_MAX_M
  ) {
    fail("STORAGE_BAD_REQUEST", `Prepare plan minSpacingM must be a number 0..${AUTO_SPACING_MAX_M}.`);
  }
  const warnings = record.warnings ?? plan.warnings;
  if (!Array.isArray(warnings) || warnings.length > 50 || warnings.some((entry) => typeof entry !== "string")) {
    fail("STORAGE_BAD_REQUEST", "Prepare warnings must list at most 50 strings.");
  }
  const parsedPlan = {
    mode: plan.mode as "detect" | "locate",
    snapshotId,
    streetSnapshotId: (streetSnapshotId ?? null) as string | null,
    sequenceIds: parsedSequenceIds,
    imageIds: parsedImageIds,
    perSequence: (perSequence as Array<{ sequenceId: string; imageIds: string[] }>).map((group) => ({
      sequenceId: group.sequenceId,
      imageIds: [...group.imageIds],
    })),
    totalImages: parsedImageIds.length,
    droppedSeeds: plan.droppedSeeds as number,
    excludedOutsideRoi: plan.excludedOutsideRoi as number,
    thinnedBySpacing: plan.thinnedBySpacing as number,
    concepts: parsedConcepts,
    estimatedCalls: plan.estimatedCalls as number,
    maxImages: plan.maxImages as number,
    maxCalls: plan.maxCalls as number,
    minSpacingM: plan.minSpacingM as number,
    anchor: { lngLat: (lngLat as [number, number]).slice() as [number, number], altM: anchor.altM as number },
    thresholds: {
      minLocatedViews: thresholds.minLocatedViews as number,
      minParallaxDeg: thresholds.minParallaxDeg as number,
      maxRayGapM: thresholds.maxRayGapM as number,
      maxReprojectionPx: thresholds.maxReprojectionPx as number,
    },
    recipe: { ...expectedRecipe },
    images: parsedImages,
    counts: autoPrepareCounts(parsedImages),
    warnings: warnings as string[],
    plannedAt: plan.plannedAt as number,
  };
  const planHash = record.planHash;
  if (typeof planHash !== "string" || !/^[0-9a-f]{64}$/.test(planHash)) {
    fail("STORAGE_BAD_REQUEST", "Prepare planHash must be 64 hex characters.");
  }
  if (canonicalPlanHash(planHashInput(parsedPlan)) !== planHash) {
    fail("STORAGE_BAD_REQUEST", "Prepare plan fingerprint mismatch; re-prepare the run.");
  }
  return { plan: parsedPlan, planHash, counts: parsedPlan.counts, warnings: parsedPlan.warnings };
}


