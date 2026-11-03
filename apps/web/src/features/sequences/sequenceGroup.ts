import { isInRegion } from "../../lib/search";
import type { ImageResult } from "../../lib/searchTypes";

/**
 * Pure sequence grouping, filtering, ordering, and representative selection
 * over discovered seed records. Framework-free and unit-tested; the hook and
 * panel consume these without reimplementing the rules.
 */

export type SequenceFilter = "all" | "panoramas" | "standard" | "unknown";
export type PanoBadge = "Panorama" | "Standard" | "Mixed" | "Unknown";

export interface SequenceGroup {
  sequenceId: string;
  shortId: string;
  /** In-RoI discovered members (seeds), newest capture first. */
  seeds: ImageResult[];
  seedCount: number;
  panoCount: number;
  standardCount: number;
  unknownCount: number;
  badge: PanoBadge;
  earliestCapture: number | null;
  latestCapture: number | null;
}

export interface GroupedSequences {
  /** Pano-containing first, then most recent known capture, then stable ID. */
  sequences: SequenceGroup[];
  /** Ungrouped images follow as individual rows, newest first. */
  ungrouped: ImageResult[];
}

export function shortSequenceId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 10)}…`;
}

function compareCapturesDesc(a: number | null, b: number | null): number {
  if (a !== null && b !== null && a !== b) return b - a;
  if ((a === null) !== (b === null)) return a === null ? 1 : -1;
  return 0;
}

function badgeFor(pano: number, standard: number, unknown: number): PanoBadge {
  const kinds = [pano > 0, standard > 0, unknown > 0].filter(Boolean).length;
  if (kinds === 0) return "Unknown";
  if (kinds > 1) return "Mixed";
  if (pano > 0) return "Panorama";
  if (standard > 0) return "Standard";
  return "Unknown";
}

function buildGroup(sequenceId: string, seeds: ImageResult[]): SequenceGroup {
  const ordered = [...seeds].sort(
    (a, b) => compareCapturesDesc(a.capturedAt, b.capturedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let panoCount = 0;
  let standardCount = 0;
  let unknownCount = 0;
  let earliestCapture: number | null = null;
  let latestCapture: number | null = null;
  for (const seed of ordered) {
    if (seed.isPano === true) panoCount += 1;
    else if (seed.isPano === false) standardCount += 1;
    else unknownCount += 1;
    if (seed.capturedAt !== null) {
      if (earliestCapture === null || seed.capturedAt < earliestCapture) {
        earliestCapture = seed.capturedAt;
      }
      if (latestCapture === null || seed.capturedAt > latestCapture) {
        latestCapture = seed.capturedAt;
      }
    }
  }
  return {
    sequenceId,
    shortId: shortSequenceId(sequenceId),
    seeds: ordered,
    seedCount: ordered.length,
    panoCount,
    standardCount,
    unknownCount,
    badge: badgeFor(panoCount, standardCount, unknownCount),
    earliestCapture,
    latestCapture,
  };
}

/**
 * Group seed records by provider sequence ID. Missing/blank sequence IDs
 * stay ungrouped as individually selectable images (never a fake sequence).
 */
export function groupSeedRecords(images: ImageResult[]): GroupedSequences {
  const buckets = new Map<string, ImageResult[]>();
  const ungrouped: ImageResult[] = [];
  for (const image of images) {
    const sequenceId = image.sequenceId;
    if (typeof sequenceId === "string" && sequenceId.length > 0) {
      const bucket = buckets.get(sequenceId) ?? [];
      bucket.push(image);
      buckets.set(sequenceId, bucket);
    } else {
      ungrouped.push(image);
    }
  }
  const sequences = [...buckets.entries()]
    .map(([sequenceId, seeds]) => buildGroup(sequenceId, seeds))
    .sort(
      (a, b) =>
        Number(b.panoCount > 0) - Number(a.panoCount > 0) ||
        compareCapturesDesc(a.latestCapture, b.latestCapture) ||
        (a.sequenceId < b.sequenceId ? -1 : a.sequenceId > b.sequenceId ? 1 : 0),
    );
  ungrouped.sort(
    (a, b) => compareCapturesDesc(a.capturedAt, b.capturedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { sequences, ungrouped };
}

export function groupMatchesFilter(group: SequenceGroup, filter: SequenceFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "panoramas":
      return group.panoCount > 0;
    case "standard":
      return group.standardCount > 0 && group.panoCount === 0 && group.unknownCount === 0;
    case "unknown":
      return group.unknownCount > 0;
  }
}

export function imageMatchesFilter(image: ImageResult, filter: SequenceFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "panoramas":
      return image.isPano === true;
    case "standard":
      return image.isPano === false;
    case "unknown":
      return image.isPano === null;
  }
}

/**
 * Representative in-RoI image: panorama preferred, then earliest capture,
 * then stable ID. Returns null when no candidate is usable.
 */
export function pickRepresentative(candidates: ImageResult[]): ImageResult | null {
  const usable = candidates.filter(isInRegion);
  if (usable.length === 0) return null;
  const rank = (image: ImageResult): number =>
    image.isPano === true ? 0 : image.isPano === false ? 1 : 2;
  return [...usable].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.capturedAt ?? Number.MAX_SAFE_INTEGER) - (b.capturedAt ?? Number.MAX_SAFE_INTEGER) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}
