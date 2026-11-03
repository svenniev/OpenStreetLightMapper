import { EARTH_RADIUS_M, pointInRing, type LngLat } from "./geo.js";

/**
 * Polyline clipping and length measurement for street work items.
 *
 * All coordinates are GeoJSON [longitude, latitude]. Inclusion is
 * boundary-inclusive: geometry inside or ALONG the polygon boundary counts.
 * Point-only touches yield no fragments and are excluded by callers.
 */

const EPS = 1e-9;
/** Fragments shorter than a nanometre are point touches, not streets. */
const MIN_FRAGMENT_M = 1e-9;

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function lerpPoint(a: LngLat, b: LngLat, t: number): LngLat {
  if (t <= 0) return [a[0], a[1]];
  if (t >= 1) return [b[0], b[1]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Clip one segment to a closed ring. Returns inside fragments as [start, end]
 * pairs in segment order; boundary-collinear overlap counts as inside.
 */
export function clipSegmentToRing(a: LngLat, b: LngLat, ring: LngLat[]): [LngLat, LngLat][] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx * dx + dy * dy < EPS * EPS) return []; // degenerate: no length to keep

  const lenSq = dx * dx + dy * dy;
  const params: number[] = [0, 1];
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const p = ring[i];
    const q = ring[i + 1];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const denom = cross(dx, dy, ex, ey);
    if (Math.abs(denom) < 1e-15) {
      // Parallel: check collinearity, then project the edge onto the segment
      // so boundary overlap brackets an inside interval.
      if (Math.abs(cross(p[0] - a[0], p[1] - a[1], dx, dy)) >= 1e-12) continue;
      for (const point of [p, q]) {
        const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq;
        if (t >= -EPS && t <= 1 + EPS) params.push(Math.min(1, Math.max(0, t)));
      }
      continue;
    }
    const t = cross(p[0] - a[0], p[1] - a[1], ex, ey) / denom;
    const u = cross(p[0] - a[0], p[1] - a[1], dx, dy) / denom;
    if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
      params.push(Math.min(1, Math.max(0, t)));
    }
  }

  params.sort((x, y) => x - y);
  const deduped = params.filter((t, index) => index === 0 || t - params[index - 1] > EPS);
  const fragments: [LngLat, LngLat][] = [];
  for (let i = 0; i + 1 < deduped.length; i += 1) {
    const t0 = deduped[i];
    const t1 = deduped[i + 1];
    if (t1 - t0 < EPS) continue;
    // Midpoint test: pointInRing is boundary-inclusive, so intervals along
    // the boundary classify as inside.
    if (!pointInRing(lerpPoint(a, b, (t0 + t1) / 2), ring)) continue;
    fragments.push([lerpPoint(a, b, t0), lerpPoint(a, b, t1)]);
  }
  return fragments;
}

/**
 * Clip a polyline to a ring. Returns positive-length fragments only; a way
 * that merely touches the polygon at a point yields no fragments.
 */
export function clipPolylineToRing(points: LngLat[], ring: LngLat[]): LngLat[][] {
  const fragments: LngLat[][] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    for (const [start, end] of clipSegmentToRing(points[i], points[i + 1], ring)) {
      if (haversineM(start, end) >= MIN_FRAGMENT_M) fragments.push([start, end]);
    }
  }
  return fragments;
}

export function haversineM(a: LngLat, b: LngLat): number {
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Geodesic length of a polyline in metres (haversine per subsegment). */
export function polylineLengthM(points: LngLat[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    total += haversineM(points[i], points[i + 1]);
  }
  return total;
}

/** Total geodesic length of clipped fragments in metres. */
export function fragmentsLengthM(fragments: LngLat[][]): number {
  return fragments.reduce((total, fragment) => total + polylineLengthM(fragment), 0);
}
