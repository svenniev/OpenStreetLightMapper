import { polylineLengthM, type Bbox, type LngLat } from "@openstreetlightmapper/geo";
import type { StreetSearchResponse, StreetWorkItem } from "../../lib/api";

/**
 * Demo-street seeding: an explicitly labeled workaround for when Overpass is
 * unreachable, so street selection and preparation stay exercisable. The
 * seeded street is quarantined, never OSM data:
 *
 * - stable `demo-*` identity, "demo seed" part label, `seeded-demo` query
 *   status, and a dedicated warning code;
 * - geometry follows all in-region sequenced camera positions in capture
 *   order (the demo's stated arbitrary rule), with real measured length;
 * - sequence links are display-only; preparation still records
 *   `imageAssociation: "pending"` because no real association was performed.
 */

export const DEMO_STREET_ID = "demo-seeded-street";
export const DEMO_STREET_NAME = "Meta Way";
export const SEEDED_DEMO_DATA = "SEEDED_DEMO_DATA";

export interface SeedPoint {
  id: string;
  lng: number;
  lat: number;
  sequenceId: string;
  capturedAt: number | null;
}

export interface DemoSeed {
  street: StreetWorkItem;
  query: StreetSearchResponse["query"];
  warnings: string[];
  /** Distinct sequence IDs linked for display (not a real association). */
  sequenceIds: string[];
  pointCount: number;
}

function isUsable(point: SeedPoint): boolean {
  return (
    Number.isFinite(point.lng) &&
    Number.isFinite(point.lat) &&
    typeof point.sequenceId === "string" &&
    point.sequenceId.length > 0
  );
}

/**
 * Build the demo seed, or null when fewer than two distinct positions are
 * available (no line can be formed).
 */
export function buildDemoSeed(
  points: SeedPoint[],
  bbox: Bbox,
  nowIso: string = new Date().toISOString(),
): DemoSeed | null {
  const usable = points.filter(isUsable).sort((a, b) => {
    const timeA = a.capturedAt ?? Number.MAX_SAFE_INTEGER;
    const timeB = b.capturedAt ?? Number.MAX_SAFE_INTEGER;
    if (timeA !== timeB) return timeA - timeB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const line: LngLat[] = [];
  const sequenceIds: string[] = [];
  const seenSequences = new Set<string>();
  for (const point of usable) {
    const last = line[line.length - 1];
    if (!last || last[0] !== point.lng || last[1] !== point.lat) {
      line.push([point.lng, point.lat]);
    }
    if (!seenSequences.has(point.sequenceId)) {
      seenSequences.add(point.sequenceId);
      sequenceIds.push(point.sequenceId);
    }
  }
  if (line.length < 2) return null;

  const street: StreetWorkItem = {
    id: DEMO_STREET_ID,
    displayName: DEMO_STREET_NAME,
    partLabel: "demo seed — not OSM data",
    name: DEMO_STREET_NAME,
    ref: null,
    wayIds: [0],
    segments: [
      {
        wayId: 0,
        highway: "residential",
        nodeIds: [0],
        tags: {},
        version: null,
        timestamp: null,
      },
    ],
    geometry: { type: "MultiLineString", coordinates: [line] },
    lengthM: polylineLengthM(line),
    demoSequenceIds: sequenceIds,
  };
  return {
    street,
    query: {
      bbox: [...bbox] as Bbox,
      requestedAt: nowIso,
      retrievedAt: nowIso,
      candidateCount: usable.length,
      invalidWayCount: 0,
      ineligibleWayCount: 0,
      outsideCount: 0,
      streetCount: 1,
      status: "seeded-demo",
    },
    warnings: [SEEDED_DEMO_DATA],
    sequenceIds,
    pointCount: usable.length,
  };
}
