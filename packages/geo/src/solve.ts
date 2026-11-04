/**
 * Multi-view solving for automatic map positioning.
 *
 * Geometry rule (conservative by design): two-view geometry only ever
 * *considers* a pair; a map position requires corroboration from at least
 * three views (MIN_LOCATED_VIEWS), a minimum parallax, a bounded ray gap, a
 * sane depth range, and a bounded reprojection error in every contributing
 * view. Pairs that fail any check stay detection-only — never positioned.
 */

import { matVec, vecDot, vecNorm, vecSub, type Vec3 } from "./frames.js";

/** Minimum corroborating views for a map position (pairs only consider). */
export const MIN_LOCATED_VIEWS = 3;
/** Minimum parallax angle at the solution for any contributing pair. */
export const MIN_PARALLAX_DEG = 2;
/** Maximum closest-approach gap between any two contributing rays. */
export const MAX_RAY_GAP_M = 1.0;
/** Maximum reprojection error per view, in original-image pixels. */
export const MAX_REPROJECTION_PX = 8;
/** Solution depth range along each ray (negative = behind the camera). */
export const MIN_DEPTH_M = 0.5;
export const MAX_DEPTH_M = 150;

export interface RayObservation {
  /** Camera centre in local ENU metres. */
  origin: Vec3;
  /** Unit world-frame ray. */
  direction: Vec3;
}

export interface Triangulation {
  /** Least-squares intersection in local ENU metres. */
  point: Vec3;
  /** Depth of the solution along each ray (must all be positive). */
  depthsM: number[];
  /** Closest-approach distance between each ray pair. */
  pairGapsM: number[];
  /** Parallax angle at the solution for each ray pair, in degrees. */
  pairParallaxDeg: number[];
  /** Baseline length for each ray pair, in metres. */
  pairBaselinesM: number[];
}

/** Closest points between two rays; null when parallel. */
export function closestRayPoints(
  aOrigin: Vec3,
  aDir: Vec3,
  bOrigin: Vec3,
  bDir: Vec3,
): { pointOnA: Vec3; pointOnB: Vec3; gapM: number } | null {
  const w0 = vecSub(aOrigin, bOrigin);
  const a = vecDot(aDir, aDir);
  const b = vecDot(aDir, bDir);
  const c = vecDot(bDir, bDir);
  const d = vecDot(aDir, w0);
  const e = vecDot(bDir, w0);
  const denom = a * c - b * b;
  if (!(Math.abs(denom) > 1e-12)) return null;
  const sc = (b * e - c * d) / denom;
  const tc = (a * e - b * d) / denom;
  const pointOnA: Vec3 = [
    aOrigin[0] + sc * aDir[0],
    aOrigin[1] + sc * aDir[1],
    aOrigin[2] + sc * aDir[2],
  ];
  const pointOnB: Vec3 = [
    bOrigin[0] + tc * bDir[0],
    bOrigin[1] + tc * bDir[1],
    bOrigin[2] + tc * bDir[2],
  ];
  return { pointOnA, pointOnB, gapM: vecNorm(vecSub(pointOnA, pointOnB)) };
}

function solve3(
  a: [Vec3, Vec3, Vec3],
  b: Vec3,
): Vec3 | null {
  const [a00, a01, a02] = a[0];
  const [a10, a11, a12] = a[1];
  const [a20, a21, a22] = a[2];
  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);
  const scale = Math.abs(a00) + Math.abs(a11) + Math.abs(a22);
  if (!(Math.abs(det) > 1e-12 * Math.max(scale * scale * scale, 1e-12))) return null;
  const inv = 1 / det;
  const x =
    ((a11 * a22 - a12 * a21) * b[0] +
      (a02 * a21 - a01 * a22) * b[1] +
      (a01 * a12 - a02 * a11) * b[2]) *
    inv;
  const y =
    ((a12 * a20 - a10 * a22) * b[0] +
      (a00 * a22 - a02 * a20) * b[1] +
      (a02 * a10 - a00 * a12) * b[2]) *
    inv;
  const z =
    ((a10 * a21 - a11 * a20) * b[0] +
      (a01 * a20 - a00 * a21) * b[1] +
      (a00 * a11 - a01 * a10) * b[2]) *
    inv;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * Least-squares intersection of N >= 2 rays (minimizes the sum of squared
 * perpendicular distances). Returns null for degenerate inputs; callers still
 * gate on parallax, gap, depth, and reprojection via checkTriangulationFit.
 */
export function triangulateRays(rays: RayObservation[]): Triangulation | null {
  if (rays.length < 2) return null;
  for (const ray of rays) {
    if (Math.abs(vecNorm(ray.direction) - 1) > 1e-6) return null;
    if (!Number.isFinite(ray.origin[0] + ray.origin[1] + ray.origin[2])) return null;
  }
  // Normal equations: A = sum(I - d d'), b = sum((I - d d') C).
  const a: [Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b: Vec3 = [0, 0, 0];
  for (const ray of rays) {
    const [dx, dy, dz] = ray.direction;
    const m: [Vec3, Vec3, Vec3] = [
      [1 - dx * dx, -dx * dy, -dx * dz],
      [-dy * dx, 1 - dy * dy, -dy * dz],
      [-dz * dx, -dz * dy, 1 - dz * dz],
    ];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) a[row][col] += m[row][col];
    }
    const mb = matVec(m, ray.origin);
    b[0] += mb[0];
    b[1] += mb[1];
    b[2] += mb[2];
  }
  const point = solve3(a, b);
  if (!point) return null;
  const depthsM = rays.map((ray) => vecDot(vecSub(point, ray.origin), ray.direction));
  const pairGapsM: number[] = [];
  const pairParallaxDeg: number[] = [];
  const pairBaselinesM: number[] = [];
  for (let i = 0; i < rays.length; i += 1) {
    for (let j = i + 1; j < rays.length; j += 1) {
      const closest = closestRayPoints(rays[i].origin, rays[i].direction, rays[j].origin, rays[j].direction);
      if (!closest) return null;
      pairGapsM.push(closest.gapM);
      const toPointI = vecSub(point, rays[i].origin);
      const toPointJ = vecSub(point, rays[j].origin);
      const normI = vecNorm(toPointI);
      const normJ = vecNorm(toPointJ);
      if (!(normI > 0) || !(normJ > 0)) return null;
      const cosAngle = Math.min(
        1,
        Math.max(-1, vecDot(toPointI, toPointJ) / (normI * normJ)),
      );
      pairParallaxDeg.push((Math.acos(cosAngle) * 180) / Math.PI);
      pairBaselinesM.push(vecNorm(vecSub(rays[i].origin, rays[j].origin)));
    }
  }
  return { point, depthsM, pairGapsM, pairParallaxDeg, pairBaselinesM };
}

export interface TriangulationCheck {
  ok: boolean;
  reasons: string[];
}

export interface TriangulationThresholds {
  minViews?: number;
  minParallaxDeg?: number;
  maxRayGapM?: number;
  minDepthM?: number;
  maxDepthM?: number;
  maxReprojection?: number;
  /** Unit label for reprojection reasons (default "px"). */
  reprojectionUnit?: string;
  /** Minimum pair baseline; 0 disables the gate (default, keeps unit behavior). */
  minBaselineM?: number;
}

/**
 * Conservative acceptance for a triangulated solution. reprojectionPx holds
 * one error per contributing view, measured in original-image pixels unless
 * the caller overrides the threshold unit (e.g. diagonal fractions).
 */
export function checkTriangulationFit(
  input: {
    viewCount: number;
    solution: Triangulation;
    reprojectionPx: number[];
  },
  thresholds: TriangulationThresholds = {},
): TriangulationCheck {
  const reasons: string[] = [];
  const minViews = thresholds.minViews ?? MIN_LOCATED_VIEWS;
  const minParallaxDeg = thresholds.minParallaxDeg ?? MIN_PARALLAX_DEG;
  const maxRayGapM = thresholds.maxRayGapM ?? MAX_RAY_GAP_M;
  const minDepthM = thresholds.minDepthM ?? MIN_DEPTH_M;
  const maxDepthM = thresholds.maxDepthM ?? MAX_DEPTH_M;
  const maxReprojection = thresholds.maxReprojection ?? MAX_REPROJECTION_PX;
  const unit = thresholds.reprojectionUnit ?? "px";
  const minBaselineM = thresholds.minBaselineM ?? 0;
  if (input.viewCount < minViews) {
    reasons.push(`only ${input.viewCount} view(s); locating needs ${minViews}`);
  }
  if (input.reprojectionPx.length !== input.viewCount) {
    reasons.push("reprojection errors missing for a contributing view");
  }
  for (const depth of input.solution.depthsM) {
    if (!(depth >= minDepthM) || !(depth <= maxDepthM)) {
      reasons.push(`depth ${depth.toFixed(2)}m outside [${minDepthM}, ${maxDepthM}]m`);
      break;
    }
  }
  for (const gap of input.solution.pairGapsM) {
    if (!(gap <= maxRayGapM)) {
      reasons.push(`ray gap ${gap.toFixed(2)}m above ${maxRayGapM}m`);
      break;
    }
  }
  for (const parallax of input.solution.pairParallaxDeg) {
    if (!(parallax >= minParallaxDeg)) {
      reasons.push(`parallax ${parallax.toFixed(2)}deg below ${minParallaxDeg}deg`);
      break;
    }
  }
  for (const baseline of input.solution.pairBaselinesM) {
    if (!(baseline >= minBaselineM)) {
      reasons.push(`baseline ${baseline.toFixed(2)}m below ${minBaselineM}m`);
      break;
    }
  }
  for (const error of input.reprojectionPx) {
    if (!Number.isFinite(error) || !(error <= maxReprojection)) {
      reasons.push(`reprojection ${String(error)}${unit} above ${maxReprojection}${unit}`);
      break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Coarse position uncertainty: reprojection error projected through the
 * weakest pair geometry, lower-bounded by the observed ray gap. Callers add
 * pose/GPS terms separately; this covers image-measurement geometry only.
 */
export function estimateUncertaintyM(input: {
  depthM: number;
  parallaxDeg: number;
  focalPx: number;
  pixelErrPx: number;
  rayGapM: number;
}): number {
  const parallaxRad = (Math.max(input.parallaxDeg, MIN_PARALLAX_DEG) * Math.PI) / 180;
  const angularErr = input.pixelErrPx / Math.max(input.focalPx, 1);
  const geometric = (input.depthM * angularErr) / Math.max(Math.sin(parallaxRad), 1e-6);
  return Math.max(geometric, input.rayGapM);
}

// ---------------------------------------------------------------------------
// Street-line utilities for the identical-asset anomaly check.
// ---------------------------------------------------------------------------

export interface FittedLine {
  /** A point on the line (the centroid). */
  point: Vec2Like;
  /** Unit direction. */
  direction: Vec2Like;
}

export type Vec2Like = [number, number];

/** Total-least-squares 2D line fit; null for < 2 points or degeneracy. */
export function fitLine2DTLS(points: Vec2Like[]): FittedLine | null {
  if (points.length < 2) return null;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (!(sxx + syy > 0)) return null;
  // Principal axis of the 2x2 scatter matrix.
  const theta = Math.atan2(2 * sxy, sxx - syy) / 2;
  return { point: [cx, cy], direction: [Math.cos(theta), Math.sin(theta)] };
}

/** Signed distance along the line direction from the line point. */
export function projectOntoLineT(point: Vec2Like, line: FittedLine): number {
  return (point[0] - line.point[0]) * line.direction[0] + (point[1] - line.point[1]) * line.direction[1];
}

/** Perpendicular distance from a point to the (infinite) line. */
export function distanceToLineM(point: Vec2Like, line: FittedLine): number {
  const t = projectOntoLineT(point, line);
  const dx = point[0] - (line.point[0] + t * line.direction[0]);
  const dy = point[1] - (line.point[1] + t * line.direction[1]);
  return Math.hypot(dx, dy);
}

/** Distance from a point to a segment AB. */
export function distancePointToSegmentM(p: Vec2Like, a: Vec2Like, b: Vec2Like): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const denom = abx * abx + aby * aby;
  if (!(denom > 0)) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / denom));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}
