/**
 * Shared WGS84 polygon validation and measurement for region-of-interest search.
 *
 * Coordinate ordering: GeoJSON **[longitude, latitude]** everywhere in this module.
 * Leaflet's [latitude, longitude] arrays must be converted explicitly at the call site.
 *
 * Used by both the web client (instant feedback, search gating) and the Express
 * server (authoritative validation before any upstream provider request), so the
 * two can never disagree on what a valid region is.
 */

export type LngLat = [number, number];
/** west, south, east, north — matches the Mapillary `bbox` parameter order. */
export type Bbox = [number, number, number, number];

export interface RoiPolygon {
  type: "Polygon";
  coordinates: LngLat[][];
}

/** Milestone design limit: selected polygon area must be at most 25 km². */
export const MAX_ROI_AREA_SQ_M = 25_000_000;
export const MAX_ROI_VERTICES = 100;
export const MIN_ROI_VERTICES = 3;
/** Web Mercator latitude range. */
export const MAX_LATITUDE = 85.051129;
/** Provider constraint: bbox angular area must be strictly smaller than this. */
export const PROVIDER_BBOX_MAX_SQ_DEG = 0.01;
/** IUGG mean Earth radius. */
export const EARTH_RADIUS_M = 6_371_008.8;

export type RoiValidationCode =
  | "NOT_POLYGON"
  | "MULTIPLE_RINGS"
  | "EMPTY_RING"
  | "TOO_FEW_VERTICES"
  | "TOO_MANY_VERTICES"
  | "NON_FINITE_COORDINATE"
  | "LATITUDE_OUT_OF_RANGE"
  | "LONGITUDE_OUT_OF_RANGE"
  | "DEGENERATE_BBOX"
  | "ZERO_AREA"
  | "ANTIMERIDIAN_CROSSING"
  | "SELF_INTERSECTION";

export type RoiLimitCode = "AREA_TOO_LARGE" | "BBOX_TOO_LARGE";

export interface RoiValidationSuccess {
  ok: true;
  /** Normalized polygon: single closed ring. */
  polygon: RoiPolygon;
  ring: LngLat[];
  bbox: Bbox;
  areaSqM: number;
}

export interface RoiValidationFailure {
  ok: false;
  code: RoiValidationCode;
  message: string;
}

export type RoiValidation = RoiValidationSuccess | RoiValidationFailure;

export interface RoiLimitCheck {
  ok: boolean;
  code: RoiLimitCode | null;
  message: string | null;
}

function fail(code: RoiValidationCode, message: string): RoiValidationFailure {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Geodesic area via the Chamberlain–Duquette spherical-polygon summation.
 * Accurate for the small regions this milestone permits; never multiplies
 * degree differences as though they were metres.
 */
export function ringAreaSqM(ring: LngLat[]): number {
  let total = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    total +=
      dLng *
      (2 +
        Math.sin((lat1 * Math.PI) / 180) +
        Math.sin((lat2 * Math.PI) / 180));
  }
  return (Math.abs(total) * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2;
}

export function bboxOfRing(ring: LngLat[]): Bbox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

/**
 * Provider angular-area constraint check. This is solely the provider's
 * bbox-size rule — it is not the displayed metric area.
 */
export function bboxAngularAreaSqDeg(bbox: Bbox): number {
  return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

export function bboxMeetsProviderLimit(bbox: Bbox): boolean {
  return bboxAngularAreaSqDeg(bbox) < PROVIDER_BBOX_MAX_SQ_DEG;
}

/** Closed rectangle ring from a bbox, in [lng, lat] order. */
export function rectangleRingFromBbox(bbox: Bbox): LngLat[] {
  const [west, south, east, north] = bbox;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** Explicit Leaflet [lat, lng] → GeoJSON [lng, lat] conversion. */
export function latLngToLngLat(lat: number, lng: number): LngLat {
  return [lng, lat];
}

type Orientation = -1 | 0 | 1;

function orientation(a: LngLat, b: LngLat, c: LngLat): Orientation {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a: LngLat, b: LngLat, c: LngLat): boolean {
  return (
    b[0] >= Math.min(a[0], c[0]) - 1e-12 &&
    b[0] <= Math.max(a[0], c[0]) + 1e-12 &&
    b[1] >= Math.min(a[1], c[1]) - 1e-12 &&
    b[1] <= Math.max(a[1], c[1]) + 1e-12
  );
}

/** True when segments p1–p2 and p3–p4 share any point (touching counts). */
function segmentsIntersect(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p3, p2)) return true;
  if (o2 === 0 && onSegment(p1, p4, p2)) return true;
  if (o3 === 0 && onSegment(p3, p1, p4)) return true;
  if (o4 === 0 && onSegment(p3, p2, p4)) return true;
  return false;
}

function ringSelfIntersects(ring: LngLat[]): boolean {
  // Ring is closed: edges are ring[i] → ring[i+1] for i in [0, ring.length - 2].
  const edgeCount = ring.length - 1;
  for (let i = 0; i < edgeCount; i += 1) {
    for (let j = i + 1; j < edgeCount; j += 1) {
      // Adjacent edges share a vertex by construction; first/last are adjacent too.
      if (j === i + 1) continue;
      if (i === 0 && j === edgeCount - 1) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

/**
 * Point-in-polygon with boundary inclusion: points on an edge or vertex count
 * as inside. `point` and `ring` are [lng, lat].
 */
export function pointInRing(point: LngLat, ring: LngLat[]): boolean {
  const [x, y] = point;
  // Boundary test first: on any edge → inside.
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (orientation(a, point, b) === 0 && onSegment(a, point, b)) return true;
  }
  // Even-odd ray casting.
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Validate unknown input as a milestone-1 region of interest. Normalizes by
 * closing the ring when the caller supplies matching first/last intent.
 */
export function validateRoiPolygon(input: unknown): RoiValidation {
  if (!isRecord(input) || input.type !== "Polygon" || !Array.isArray(input.coordinates)) {
    return fail("NOT_POLYGON", "Region must be a GeoJSON Polygon.");
  }
  const rings = input.coordinates as unknown[];
  if (rings.length !== 1) {
    return fail(
      "MULTIPLE_RINGS",
      "Region must have exactly one exterior ring (no holes or multi-polygons).",
    );
  }
  if (!Array.isArray(rings[0]) || rings[0].length === 0) {
    return fail("EMPTY_RING", "Region ring must contain coordinates.");
  }
  const raw = rings[0] as unknown[];
  const ring: LngLat[] = [];
  for (const position of raw) {
    if (
      !Array.isArray(position) ||
      position.length < 2 ||
      typeof position[0] !== "number" ||
      typeof position[1] !== "number" ||
      !Number.isFinite(position[0]) ||
      !Number.isFinite(position[1])
    ) {
      return fail("NON_FINITE_COORDINATE", "Every coordinate must be a finite number.");
    }
    const [lng, lat] = position as [number, number];
    if (lat < -MAX_LATITUDE || lat > MAX_LATITUDE) {
      return fail(
        "LATITUDE_OUT_OF_RANGE",
        `Latitude ${lat} is outside the supported ±${MAX_LATITUDE}° range.`,
      );
    }
    if (lng < -180 || lng > 180) {
      return fail("LONGITUDE_OUT_OF_RANGE", `Longitude ${lng} is outside ±180°.`);
    }
    ring.push([lng, lat]);
  }

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    // Normalize: close the ring explicitly rather than rejecting drawable shapes.
    ring.push([first[0], first[1]]);
  }

  const distinct = new Set(ring.map(([lng, lat]) => `${lng},${lat}`));
  if (distinct.size < MIN_ROI_VERTICES) {
    return fail(
      "TOO_FEW_VERTICES",
      `Region needs at least ${MIN_ROI_VERTICES} distinct vertices.`,
    );
  }
  if (distinct.size > MAX_ROI_VERTICES) {
    return fail(
      "TOO_MANY_VERTICES",
      `Region has ${distinct.size} distinct vertices; at most ${MAX_ROI_VERTICES} are supported.`,
    );
  }

  const bbox = bboxOfRing(ring);
  if (!(bbox[2] > bbox[0]) || !(bbox[3] > bbox[1])) {
    return fail("DEGENERATE_BBOX", "Region must span a nonzero width and height.");
  }
  if (bbox[2] - bbox[0] > 180) {
    return fail(
      "ANTIMERIDIAN_CROSSING",
      "Regions crossing the antimeridian are not supported; select an area fully east or west of ±180°.",
    );
  }
  if (ringSelfIntersects(ring)) {
    return fail("SELF_INTERSECTION", "Region edges must not cross; redraw a simple shape.");
  }

  const areaSqM = ringAreaSqM(ring);
  if (!(areaSqM > 0)) {
    return fail("ZERO_AREA", "Region must enclose a positive area.");
  }

  return { ok: true, polygon: { type: "Polygon", coordinates: [ring] }, ring, bbox, areaSqM };
}

export {
  clipPolylineToRing,
  clipSegmentToRing,
  fragmentsLengthM,
  haversineM,
  polylineLengthM,
} from "./clip.js";

/**
 * Milestone size limits: 25 km² polygon area plus the provider's strict bbox
 * constraint. A thin polygon can pass the area limit yet fail the bbox limit.
 */
export function checkRoiLimits(areaSqM: number, bbox: Bbox): RoiLimitCheck {
  if (!(areaSqM > 0)) {
    return { ok: false, code: "AREA_TOO_LARGE", message: "Region must enclose a positive area." };
  }
  if (areaSqM > MAX_ROI_AREA_SQ_M) {
    return {
      ok: false,
      code: "AREA_TOO_LARGE",
      message: `Region is ${(areaSqM / 1_000_000).toFixed(2)} km²; the limit is 25 km². Select a smaller area.`,
    };
  }
  if (!bboxMeetsProviderLimit(bbox)) {
    return {
      ok: false,
      code: "BBOX_TOO_LARGE",
      message:
        "The region's bounding box exceeds the supported search size. Select a smaller area.",
    };
  }
  return { ok: true, code: null, message: null };
}
