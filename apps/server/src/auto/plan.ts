import { lngLatDistanceM } from "@openstreetlightmapper/geo";
import {
  autoPrepareCounts,
  autoViewRecipe,
  canonicalPlanHash,
  currentAutoThresholds,
  planHashInput,
  type AutoPrepareCounts,
  type AutoThresholds,
  type AutoViewRecipe,
  type ValidatedAutoConcept,
  type ValidatedAutoPlanRequest,
  type ValidatedPlanImageMeta,
} from "../db/autoValidation.js";
import { fail, isRecord } from "../db/validation.js";

/**
 * Pure plan resolution for automatic jobs. Preview and launch share this
 * function so the counts the UI shows are exactly the counts the worker
 * will process: the same immutable snapshot plus the same validated
 * request always resolves the same image list.
 */

export interface ResolvedAutoPlan {
  mode: "detect" | "locate";
  snapshotId: string;
  streetSnapshotId: string | null;
  sequenceIds: string[];
  imageIds: string[];
  perSequence: { sequenceId: string; imageIds: string[] }[];
  totalImages: number;
  droppedSeeds: number;
  excludedOutsideRoi: number;
  thinnedBySpacing: number;
  concepts: ValidatedAutoConcept[];
  estimatedCalls: number;
  maxImages: number;
  maxCalls: number;
  minSpacingM: number;
  anchor: { lngLat: [number, number]; altM: number };
  thresholds: AutoThresholds;
  recipe: AutoViewRecipe;
  images: ValidatedPlanImageMeta[];
  counts: AutoPrepareCounts;
  warnings: string[];
  plannedAt: number;
}

interface SeedRecord {
  id: string;
  coordinate: [number, number];
  sequenceId: string | null;
  /** Stored polygon-containment flag; null for legacy snapshots that lack it. */
  inRoi: boolean | null;
}

function parseSeed(value: unknown): SeedRecord | null {
  if (!isRecord(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const coordinate = record.coordinate;
  if (
    !Array.isArray(coordinate) ||
    coordinate.length !== 2 ||
    typeof coordinate[0] !== "number" ||
    typeof coordinate[1] !== "number" ||
    !Number.isFinite(coordinate[0]) ||
    !Number.isFinite(coordinate[1])
  ) {
    return null;
  }
  const sequenceId = record.sequenceId;
  if (sequenceId !== null && typeof sequenceId !== "string") return null;
  const inRoi = record.inRoi;
  if (inRoi !== undefined && inRoi !== null && typeof inRoi !== "boolean") return null;
  return {
    id: record.id,
    coordinate: [coordinate[0], coordinate[1]],
    sequenceId,
    inRoi: typeof inRoi === "boolean" ? inRoi : null,
  };
}

function unavailableMeta(imageId: string, sequenceId: string): ValidatedPlanImageMeta {
  return {
    imageId,
    sequenceId,
    cameraType: null,
    cameraParameters: null,
    originalWidth: null,
    originalHeight: null,
    exifOrientation: null,
    computedLngLat: null,
    originalLngLat: null,
    computedAltitudeM: null,
    originalAltitudeM: null,
    rotationAxisAngle: null,
    computedCompassDeg: null,
    compassDeg: null,
    mergeCc: null,
    atomicScale: null,
    capturedAt: null,
    isPano: null,
    metadataFields: [],
    eligible: false,
    ineligibleReason: "metadata-unavailable",
  };
}

export interface MatchedPlanSeeds {
  matched: Array<SeedRecord & { sequenceId: string }>;
  droppedSeeds: number;
  excludedOutsideRoi: number;
  unknownRoiIncluded: number;
  thinnedBySpacing: number;
}

/**
 * Greedy spacing thin in snapshot order: an image is skipped when any
 * already-kept image is closer than minSpacingM. Deterministic: the same
 * snapshot plus the same spacing always keeps the same images.
 */
function thinBySpacing(
  seeds: Array<SeedRecord & { sequenceId: string }>,
  minSpacingM: number,
): { kept: Array<SeedRecord & { sequenceId: string }>; thinned: number } {
  if (!(minSpacingM > 0)) return { kept: seeds, thinned: 0 };
  const kept: Array<SeedRecord & { sequenceId: string }> = [];
  let thinned = 0;
  for (const seed of seeds) {
    const tooClose = kept.some(
      (other) => lngLatDistanceM(seed.coordinate, other.coordinate) < minSpacingM,
    );
    if (tooClose) {
      thinned += 1;
    } else {
      kept.push(seed);
    }
  }
  return { kept, thinned };
}

/**
 * Match selected sequences against snapshot seeds. Shared by metadata fetch
 * (which needs image ids before the plan resolves) and plan resolution, so
 * both see the identical image list. Only in-RoI images match; seeds without
 * a stored RoI flag (legacy snapshots) are included with a warning.
 */
export function matchPlanSeeds(
  request: Pick<ValidatedAutoPlanRequest, "sequenceIds" | "snapshotId" | "minSpacingM">,
  snapshotPayload: unknown,
): MatchedPlanSeeds {
  if (!isRecord(snapshotPayload)) {
    throw new Error("Imagery snapshot payload is corrupt.");
  }
  const payload = snapshotPayload as Record<string, unknown>;
  const seedLists = [payload.seeds, payload.hydrated];
  if (!seedLists.every((list) => Array.isArray(list))) {
    throw new Error("Imagery snapshot payload is corrupt.");
  }
  // Seeds and hydrated records can overlap; first occurrence (discovery
  // order) wins so the image list is stable across preview and launch.
  const seen = new Set<string>();
  const seeds: SeedRecord[] = [];
  let droppedSeeds = 0;
  for (const list of seedLists as unknown[][]) {
    for (const entry of list) {
      const parsed = parseSeed(entry);
      if (!parsed || seen.has(parsed.id)) {
        if (!parsed) droppedSeeds += 1;
        continue;
      }
      seen.add(parsed.id);
      seeds.push(parsed);
    }
  }
  const selected = new Set(request.sequenceIds);
  const sequenceMatched = seeds.filter(
    (seed): seed is SeedRecord & { sequenceId: string } =>
      seed.sequenceId !== null && selected.has(seed.sequenceId),
  );
  if (sequenceMatched.length === 0) {
    fail(
      "AUTO_PLAN_REJECTED",
      `Selected sequences contain no usable images in snapshot ${request.snapshotId}.`,
    );
  }
  // RoI containment was computed against the actual polygon at discovery
  // time and stored on each seed; outside-RoI members never enter the plan.
  // Unknown flags (legacy snapshots) stay included but are disclosed.
  const inRoi = sequenceMatched.filter((seed) => seed.inRoi !== false);
  const excludedOutsideRoi = sequenceMatched.length - inRoi.length;
  if (inRoi.length === 0) {
    fail(
      "AUTO_PLAN_REJECTED",
      `Selected sequences contain no in-RoI images in snapshot ${request.snapshotId}; ` +
        `all ${excludedOutsideRoi} matched images fall outside the region.`,
    );
  }
  const unknownRoiIncluded = inRoi.filter((seed) => seed.inRoi === null).length;
  const { kept: matched, thinned: thinnedBySpacing } = thinBySpacing(inRoi, request.minSpacingM);
  return { matched, droppedSeeds, excludedOutsideRoi, unknownRoiIncluded, thinnedBySpacing };
}

export function resolveAutoPlan(
  request: ValidatedAutoPlanRequest,
  snapshotPayload: unknown,
  metadata: ValidatedPlanImageMeta[],
  now: number = Date.now(),
): { plan: ResolvedAutoPlan; planHash: string } {
  const { matched, droppedSeeds, excludedOutsideRoi, unknownRoiIncluded, thinnedBySpacing } =
    matchPlanSeeds(request, snapshotPayload);
  if (matched.length > request.maxImages) {
    fail(
      "AUTO_PLAN_REJECTED",
      `Selection resolves to ${matched.length} images, over the maxImages bound of ${request.maxImages}.`,
    );
  }
  const estimatedCalls = matched.length * request.concepts.length;
  if (estimatedCalls > request.maxCalls) {
    fail(
      "AUTO_PLAN_REJECTED",
      `Selection needs ${estimatedCalls} model calls, over the maxCalls bound of ${request.maxCalls}.`,
    );
  }
  const perSequence = request.sequenceIds.map((sequenceId) => ({
    sequenceId,
    imageIds: matched.filter((seed) => seed.sequenceId === sequenceId).map((seed) => seed.id),
  }));
  let lngSum = 0;
  let latSum = 0;
  for (const seed of matched) {
    lngSum += seed.coordinate[0];
    latSum += seed.coordinate[1];
  }
  const byImageId = new Map<string, ValidatedPlanImageMeta>();
  for (const meta of metadata) {
    if (byImageId.has(meta.imageId)) {
      throw new Error(`Duplicate image metadata for ${meta.imageId}.`);
    }
    byImageId.set(meta.imageId, meta);
  }
  const images = matched.map((seed) => byImageId.get(seed.id) ?? unavailableMeta(seed.id, seed.sequenceId));
  const counts = autoPrepareCounts(images);
  if (request.mode === "locate" && counts.eligibleImages === 0) {
    fail("AUTO_PLAN_REJECTED", "No usable geometry: detections can run, map placement unavailable.");
  }
  const warnings: string[] = [];
  if (droppedSeeds > 0) {
    warnings.push(`Dropped ${droppedSeeds} malformed seed records from the snapshot.`);
  }
  if (excludedOutsideRoi > 0) {
    warnings.push(
      `${excludedOutsideRoi} outside-RoI images excluded from the selected sequences; only in-RoI images are planned.`,
    );
  }
  if (unknownRoiIncluded > 0) {
    warnings.push(
      `${unknownRoiIncluded} images without RoI flags were included; re-run the search for exact RoI filtering.`,
    );
  }
  if (thinnedBySpacing > 0) {
    warnings.push(
      `${thinnedBySpacing} images within ${request.minSpacingM} m of an included image were skipped (minSpacingM ${request.minSpacingM}).`,
    );
  }
  if (counts.detectionOnlyImages > 0) {
    warnings.push(
      `${counts.detectionOnlyImages} of ${counts.totalImages} images lack usable geometry and will be detection-only.`,
    );
  }
  if (counts.missingMetadataImages > 0) {
    warnings.push(
      `${counts.missingMetadataImages} images have no provider metadata; the worker retries once at preparation.`,
    );
  }
  const plan: ResolvedAutoPlan = {
    mode: request.mode,
    snapshotId: request.snapshotId,
    streetSnapshotId: request.streetSnapshotId,
    sequenceIds: [...request.sequenceIds],
    imageIds: matched.map((seed) => seed.id),
    perSequence,
    totalImages: matched.length,
    droppedSeeds,
    excludedOutsideRoi,
    thinnedBySpacing,
    concepts: request.concepts.map((concept) => ({ ...concept })),
    estimatedCalls,
    maxImages: request.maxImages,
    maxCalls: request.maxCalls,
    minSpacingM: request.minSpacingM,
    anchor: {
      lngLat: [lngSum / matched.length, latSum / matched.length],
      altM: 0,
    },
    thresholds: currentAutoThresholds(),
    recipe: autoViewRecipe(),
    images,
    counts,
    warnings,
    plannedAt: now,
  };
  return { plan, planHash: canonicalPlanHash(planHashInput(plan)) };
}
