/**
 * Camera models for automatic map positioning.
 *
 * Supported (verified against provider references):
 * - perspective: Mapillary camera_type "perspective" with camera_parameters
 *   [focal, k1, k2] in OpenSfM units (focal normalized by max(width, height);
 *   projection u = f*d*xn per https://opensfm.org/docs/geometry.html).
 * - equirectangular: Mapillary camera_type "equirectangular"/"spherical" with
 *   a 2:1 aspect image; projection lon = atan(x/z), lat = atan(-y/hypot(x,z))
 *   per the OpenSfM spherical model. Zenith/nadir past 80deg latitude are
 *   excluded (poles), and the u seam wraps continuously.
 *
 * Explicitly unsupported (views stay detection-only): fisheye (no verified
 * reprojection path), unknown camera types, missing intrinsics, non-2:1
 * panoramas, and any out-of-range or non-finite parameter.
 *
 * Pixel handling follows OpenSfM exactly: normalized coordinates span the
 * larger image dimension, and pixel centres run 0..w-1 / 0..h-1, i.e.
 * H = [max(w,h), 0, (w-1)/2; 0, max(w,h), (h-1)/2].
 */

import { matTranspose, matVec, vecNormalize, type Mat3, type Vec2, type Vec3 } from "./frames.js";

export type CameraKind = "perspective" | "equirectangular";

export interface PerspectiveCamera {
  kind: "perspective";
  /** Original (stored bytes) dimensions. */
  width: number;
  height: number;
  /** Normalized focal length (pixels / max(width, height)). */
  focal: number;
  k1: number;
  k2: number;
}

export interface EquirectangularCamera {
  kind: "equirectangular";
  /** Original (stored bytes) dimensions; must be ~2:1. */
  width: number;
  height: number;
}

export type CameraDescriptor = PerspectiveCamera | EquirectangularCamera;

export interface CameraPose {
  /** Camera centre in local ENU metres. */
  centerEnu: Vec3;
  /** World-to-camera rotation (OpenSfM computed_rotation convention). */
  rotationWc: Mat3;
}

export type CameraVerdict =
  | { ok: true; camera: CameraDescriptor }
  | { ok: false; reason: string };

/** Normalized focal gates: wider than ~130deg or tighter than ~20deg is suspect. */
export const FOCAL_MIN = 0.2;
export const FOCAL_MAX = 5;
/** Radial coefficients beyond this are outside verified provider ranges. */
export const DISTORTION_ABS_MAX = 2;
/** Equirectangular width/height must be 2:1 within this tolerance. */
export const PANO_ASPECT_TOLERANCE = 0.01;
/** Pano latitudes past this (near zenith/nadir) are excluded. */
export const PANO_POLE_LAT_LIMIT_DEG = 80;
/** Undistortion iteration cap and divergence guard radius. */
export const UNDISTORT_ITERATIONS = 20;
export const UNDISTORT_RADIUS_MAX = 8;

/**
 * Raw provider camera fields (Mapillary image entity) to a usable descriptor,
 * or an ineligibility reason. Unknown/missing inputs never guess.
 */
export function validateCameraDescriptor(input: {
  cameraType: unknown;
  cameraParameters: unknown;
  width: unknown;
  height: unknown;
}): CameraVerdict {
  const { cameraType, cameraParameters, width, height } = input;
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0) {
    return { ok: false, reason: "missing or invalid image width" };
  }
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) {
    return { ok: false, reason: "missing or invalid image height" };
  }
  if (cameraType === "equirectangular" || cameraType === "spherical") {
    const aspect = width / height;
    if (Math.abs(aspect - 2) > PANO_ASPECT_TOLERANCE) {
      return {
        ok: false,
        reason: `non-2:1 panorama aspect (${aspect.toFixed(3)}); mapping unknown`,
      };
    }
    return { ok: true, camera: { kind: "equirectangular", width, height } };
  }
  if (cameraType === "fisheye") {
    return { ok: false, reason: "fisheye has no verified reprojection path" };
  }
  if (cameraType !== "perspective") {
    return { ok: false, reason: `unsupported camera type ${JSON.stringify(cameraType)}` };
  }
  if (!Array.isArray(cameraParameters) || cameraParameters.length < 3) {
    return { ok: false, reason: "perspective view lacks camera_parameters [focal, k1, k2]" };
  }
  const [focal, k1, k2] = cameraParameters;
  if (
    typeof focal !== "number" ||
    !Number.isFinite(focal) ||
    focal < FOCAL_MIN ||
    focal > FOCAL_MAX
  ) {
    return { ok: false, reason: `focal ${String(focal)} outside [${FOCAL_MIN}, ${FOCAL_MAX}]` };
  }
  for (const [name, value] of [
    ["k1", k1],
    ["k2", k2],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > DISTORTION_ABS_MAX) {
      return { ok: false, reason: `${name} ${String(value)} outside verified range` };
    }
  }
  return { ok: true, camera: { kind: "perspective", width, height, focal, k1, k2 } };
}

/** Stored-bytes pixels to OpenSfM normalized coordinates. */
export function pixelsToNormalized(px: number, py: number, width: number, height: number): Vec2 {
  const s = Math.max(width, height);
  return [(px - (width - 1) / 2) / s, (py - (height - 1) / 2) / s];
}

/** OpenSfM normalized coordinates to stored-bytes pixels. */
export function normalizedToPixels(u: number, v: number, width: number, height: number): Vec2 {
  const s = Math.max(width, height);
  return [u * s + (width - 1) / 2, v * s + (height - 1) / 2];
}

export type RayResult = { ok: true; ray: Vec3 } | { ok: false; reason: string };

/**
 * Undistorted normalized direction for a perspective view: solves
 * r_observed/focal = d(r) * r by fixed-point iteration (mapillary-js method).
 */
function undistortNormalized(
  u: number,
  v: number,
  camera: PerspectiveCamera,
): { xn: number; yn: number } | null {
  const dxn = u / camera.focal;
  const dyn = v / camera.focal;
  const distorted = Math.hypot(dxn, dyn);
  let radius = distorted;
  let d = 1;
  for (let i = 0; i < UNDISTORT_ITERATIONS; i += 1) {
    radius = distorted / d;
    if (!Number.isFinite(radius) || radius > UNDISTORT_RADIUS_MAX) return null;
    d = 1 + camera.k1 * radius * radius + camera.k2 * radius * radius * radius * radius;
    if (!Number.isFinite(d) || d === 0) return null;
  }
  return { xn: dxn / d, yn: dyn / d };
}

/** Stored-bytes pixel to a unit camera-frame ray (perspective). */
export function perspectivePixelToRay(
  px: number,
  py: number,
  camera: PerspectiveCamera,
): RayResult {
  const [u, v] = pixelsToNormalized(px, py, camera.width, camera.height);
  const undistorted = undistortNormalized(u, v, camera);
  if (!undistorted) return { ok: false, reason: "undistortion diverged" };
  const ray = vecNormalize([undistorted.xn, undistorted.yn, 1]);
  if (!ray) return { ok: false, reason: "degenerate ray" };
  return { ok: true, ray };
}

/** Stored-bytes pixel to a unit camera-frame ray (equirectangular). */
export function equirectPixelToRay(
  px: number,
  py: number,
  camera: EquirectangularCamera,
): RayResult {
  const [u, v] = pixelsToNormalized(px, py, camera.width, camera.height);
  const lon = u * 2 * Math.PI;
  const lat = -v * 2 * Math.PI;
  if (Math.abs(lat) > (PANO_POLE_LAT_LIMIT_DEG * Math.PI) / 180) {
    return { ok: false, reason: "pixel too close to the panorama pole" };
  }
  const cosLat = Math.cos(lat);
  return {
    ok: true,
    ray: [Math.sin(lon) * cosLat, -Math.sin(lat), Math.cos(lon) * cosLat],
  };
}

export function pixelToCameraRay(px: number, py: number, camera: CameraDescriptor): RayResult {
  if (camera.kind === "perspective") return perspectivePixelToRay(px, py, camera);
  return equirectPixelToRay(px, py, camera);
}

/** Camera-frame ray to a world-frame unit ray through the pose. */
export function cameraRayToWorld(ray: Vec3, pose: CameraPose): Vec3 {
  const world = matVec(matTranspose(pose.rotationWc), ray);
  const normalized = vecNormalize(world);
  if (!normalized) throw new Error("cameraRayToWorld: degenerate rotated ray");
  return normalized;
}

export type ProjectResult = { ok: true; px: number; py: number } | { ok: false; reason: string };

/** World point to stored-bytes pixels (perspective; null behind the camera). */
export function projectWorldToPerspective(
  point: Vec3,
  pose: CameraPose,
  camera: PerspectiveCamera,
): ProjectResult {
  const translated: Vec3 = [
    point[0] - pose.centerEnu[0],
    point[1] - pose.centerEnu[1],
    point[2] - pose.centerEnu[2],
  ];
  const cam = matVec(pose.rotationWc, translated);
  if (!(cam[2] > 0)) return { ok: false, reason: "point behind the camera" };
  const xn = cam[0] / cam[2];
  const yn = cam[1] / cam[2];
  const r2 = xn * xn + yn * yn;
  const d = 1 + camera.k1 * r2 + camera.k2 * r2 * r2;
  const [px, py] = normalizedToPixels(camera.focal * d * xn, camera.focal * d * yn, camera.width, camera.height);
  return { ok: true, px, py };
}

/** World point to stored-bytes pixels (equirectangular; sees all directions). */
export function projectWorldToEquirect(
  point: Vec3,
  pose: CameraPose,
  camera: EquirectangularCamera,
): ProjectResult {
  const translated: Vec3 = [
    point[0] - pose.centerEnu[0],
    point[1] - pose.centerEnu[1],
    point[2] - pose.centerEnu[2],
  ];
  const cam = matVec(pose.rotationWc, translated);
  const lon = Math.atan2(cam[0], cam[2]);
  const lat = Math.atan2(-cam[1], Math.hypot(cam[0], cam[2]));
  if (Math.abs(lat) > (PANO_POLE_LAT_LIMIT_DEG * Math.PI) / 180) {
    return { ok: false, reason: "projection too close to the panorama pole" };
  }
  const [px, py] = normalizedToPixels(lon / (2 * Math.PI), -lat / (2 * Math.PI), camera.width, camera.height);
  return { ok: true, px, py };
}

export function projectWorldToPixel(
  point: Vec3,
  pose: CameraPose,
  camera: CameraDescriptor,
): ProjectResult {
  if (camera.kind === "perspective") return projectWorldToPerspective(point, pose, camera);
  return projectWorldToEquirect(point, pose, camera);
}

/** Focal length in stored-bytes pixels (pano: width / 2PI circle constant). */
export function focalPixels(camera: CameraDescriptor): number {
  if (camera.kind === "perspective") return camera.focal * Math.max(camera.width, camera.height);
  return camera.width / (2 * Math.PI);
}

// ---------------------------------------------------------------------------
// Pole-base anchors.
// ---------------------------------------------------------------------------

/** Default angular inset below the visible pole bottom. */
export const POLE_BASE_MARGIN_DEG = 3;

export interface PoleBaseAnchor {
  /** Analysis-view pixels. */
  x: number;
  y: number;
  /** True when the margin ran past the view edge and clamped. */
  clamped: boolean;
}

/**
 * Pole-base anchor: bottom centre of the detection box, pushed strictly below
 * the box bottom by an angular margin (poles continue to ground contact below
 * the visible box). Box is normalized [x, y, w, h].
 */
export function poleBaseAnchorFromBox(
  box: { x: number; y: number; w: number; h: number },
  viewWidth: number,
  viewHeight: number,
  focalPx: number,
  marginDeg: number = POLE_BASE_MARGIN_DEG,
): PoleBaseAnchor {
  const x = (box.x + box.w / 2) * viewWidth;
  const marginPx = ((marginDeg * Math.PI) / 180) * focalPx;
  const rawY = (box.y + box.h) * viewHeight + marginPx;
  const y = Math.min(Math.max(rawY, 0), viewHeight - 1);
  return { x: Math.min(Math.max(x, 0), viewWidth - 1), y, clamped: y !== rawY };
}

/** Minimum mask fraction across the support band for a supported anchor. */
export const MASK_SUPPORT_MIN_FRACTION = 0.25;
/** Half-width of the column band (columns x-2..x+2). */
export const MASK_SUPPORT_HALF_WIDTH_PX = 2;

/**
 * Mask-column support: the fraction of mask pixels in the column band around
 * x between yTop and yBottom (analysis-view pixels). `insideMask` answers
 * point queries against the decoded mask. Below-threshold anchors are still
 * returned with supported=false so callers can log the reason.
 */
export function maskColumnSupport(
  insideMask: (x: number, y: number) => boolean,
  viewWidth: number,
  viewHeight: number,
  x: number,
  yTop: number,
  yBottom: number,
): { supported: boolean; fraction: number } {
  const x0 = Math.max(0, Math.floor(x - MASK_SUPPORT_HALF_WIDTH_PX));
  const x1 = Math.min(viewWidth - 1, Math.ceil(x + MASK_SUPPORT_HALF_WIDTH_PX));
  const top = Math.max(0, Math.floor(Math.min(yTop, yBottom)));
  const bottom = Math.min(viewHeight - 1, Math.ceil(Math.max(yTop, yBottom)));
  let inside = 0;
  let total = 0;
  for (let ix = x0; ix <= x1; ix += 1) {
    for (let iy = top; iy <= bottom; iy += 1) {
      total += 1;
      if (insideMask(ix, iy)) inside += 1;
    }
  }
  if (total === 0) return { supported: false, fraction: 0 };
  const fraction = inside / total;
  return { supported: fraction >= MASK_SUPPORT_MIN_FRACTION, fraction };
}
