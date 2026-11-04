/**
 * Reference frames for automatic map positioning.
 *
 * Conventions (all tested by fixtures):
 * - Camera frame (OpenSfM, https://opensfm.org/docs/cam_coord_system.html):
 *   X right, Y down, Z forward. Points in front of the camera have Z > 0.
 * - Poses store the rotation taking points from WORLD to CAMERA coordinates
 *   (OpenSfM Pose convention). A camera ray in world coordinates is therefore
 *   R_wc-transpose times the camera-frame ray.
 * - World frame is a local tangent-plane ENU (East, North, Up) in metres about
 *   a per-job anchor (OpenSfM "topocentric" convention). The spherical
 *   approximation is millimetre-accurate at street scale and degrades with
 *   distance from the anchor; jobs keep one anchor per street area.
 * - Pixels follow OpenSfM pixel coordinates: the origin is the CENTRE of the
 *   top-left pixel, so the bottom-right pixel centre is (w-1, h-1). This is a
 *   half-pixel shift from corner-origin conventions (e.g. mapillary-js basic
 *   coordinates); the exact OpenSfM H matrix is used so provider
 *   camera_parameters interpret correctly.
 * - GeoJSON [lng, lat] order everywhere (matches geo.ts).
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Row-major 3x3 rotation matrix. */
export type Mat3 = [Vec3, Vec3, Vec3];

/** IUGG mean Earth radius (mirrors geo.ts). */
export const EARTH_RADIUS_M = 6_371_008.8;

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vecScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vecDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vecNorm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vecNormalize(a: Vec3): Vec3 | null {
  const norm = vecNorm(a);
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  return [a[0] / norm, a[1] / norm, a[2] / norm];
}

export function matTranspose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/**
 * Rodrigues' formula: axis-angle vector (direction = axis, length = radians,
 * OpenSfM computed_rotation convention) to a world-to-camera rotation matrix.
 * A zero vector is the identity. Returns null for non-finite input.
 */
export function axisAngleToMatrix(axisAngle: Vec3): Mat3 | null {
  const [x, y, z] = axisAngle;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const angle = Math.hypot(x, y, z);
  if (angle === 0) {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }
  const ux = x / angle;
  const uy = y / angle;
  const uz = z / angle;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const oneMinusCos = 1 - cos;
  return [
    [
      cos + ux * ux * oneMinusCos,
      ux * uy * oneMinusCos - uz * sin,
      ux * uz * oneMinusCos + uy * sin,
    ],
    [
      uy * ux * oneMinusCos + uz * sin,
      cos + uy * uy * oneMinusCos,
      uy * uz * oneMinusCos - ux * sin,
    ],
    [
      uz * ux * oneMinusCos - uy * sin,
      uz * uy * oneMinusCos + ux * sin,
      cos + uz * uz * oneMinusCos,
    ],
  ];
}

/**
 * Level-camera pose from a compass heading (degrees clockwise from north,
 * Mapillary compass_angle convention). Assumes zero pitch and roll, which is
 * NOT verified against any provider reference: automatic positioning never
 * uses this; it exists for diagnostics and for fixtures without SfM poses.
 */
export function levelPoseFromCompass(headingDeg: number): Mat3 | null {
  if (!Number.isFinite(headingDeg)) return null;
  const theta = (headingDeg * Math.PI) / 180;
  const forward: Vec3 = [Math.sin(theta), Math.cos(theta), 0];
  const right: Vec3 = [Math.cos(theta), -Math.sin(theta), 0];
  const down: Vec3 = [0, 0, -1];
  return [right, down, forward];
}

export interface EnuAnchor {
  /** [lng, lat] of the local origin. */
  lngLat: [number, number];
  /** Altitude of the local origin in metres above sea level. */
  altM: number;
}

/** WGS84 position to local ENU metres about the anchor. */
export function llaToEnu(lng: number, lat: number, altM: number, anchor: EnuAnchor): Vec3 {
  const dLng = ((lng - anchor.lngLat[0]) * Math.PI) / 180;
  const dLat = ((lat - anchor.lngLat[1]) * Math.PI) / 180;
  const lat0 = (anchor.lngLat[1] * Math.PI) / 180;
  return [EARTH_RADIUS_M * dLng * Math.cos(lat0), EARTH_RADIUS_M * dLat, altM - anchor.altM];
}

/** Local ENU metres back to [lng, lat, alt]. Inverse of llaToEnu. */
export function enuToLla(e: number, n: number, u: number, anchor: EnuAnchor): Vec3 {
  const lat0 = (anchor.lngLat[1] * Math.PI) / 180;
  const dLng = e / (EARTH_RADIUS_M * Math.cos(lat0));
  const dLat = n / EARTH_RADIUS_M;
  return [
    anchor.lngLat[0] + (dLng * 180) / Math.PI,
    anchor.lngLat[1] + (dLat * 180) / Math.PI,
    anchor.altM + u,
  ];
}

// ---------------------------------------------------------------------------
// Analysis-view chains: the exact pixel transforms the server prep applies.
// ---------------------------------------------------------------------------

/**
 * One pixel transform in the stored-bytes to analysis-view chain. The chain
 * always runs orient -> resize -> crop (any suffix may be absent); unknown
 * future ops make a view ineligible rather than guessing.
 */
export type ViewOp =
  | { op: "orient"; exif: 1 | 3 | 6 | 8; fromW: number; fromH: number }
  | { op: "resize"; fromW: number; fromH: number; toW: number; toH: number }
  | { op: "crop"; x: number; y: number; w: number; h: number };

export interface ViewChain {
  ops: ViewOp[];
}

function applyOrientOp(
  op: Extract<ViewOp, { op: "orient" }>,
  point: Vec2,
  inverse: boolean,
): Vec2 {
  const [x, y] = point;
  const { exif, fromW, fromH } = op;
  if (exif === 1) return [x, y];
  if (exif === 3) return [fromW - 1 - x, fromH - 1 - y];
  // 90-degree rotations swap dimensions; forward and inverse differ.
  if (exif === 6) {
    // Stored -> upright is 90deg clockwise: upright(x, y) = (H-1-y, x).
    if (!inverse) return [fromH - 1 - y, x];
    // Upright (fromH x fromW) -> stored.
    return [y, fromH - 1 - x];
  }
  // exif === 8: stored -> upright is 90deg counter-clockwise.
  if (!inverse) return [y, fromW - 1 - x];
  return [fromW - 1 - y, x];
}

function applyResizeOp(
  op: Extract<ViewOp, { op: "resize" }>,
  point: Vec2,
  inverse: boolean,
): Vec2 {
  const [x, y] = point;
  if (!inverse) return [(x * op.toW) / op.fromW, (y * op.toH) / op.fromH];
  return [(x * op.fromW) / op.toW, (y * op.fromH) / op.toH];
}

function applyCropOp(
  op: Extract<ViewOp, { op: "crop" }>,
  point: Vec2,
  inverse: boolean,
): Vec2 {
  const [x, y] = point;
  if (!inverse) return [x - op.x, y - op.y];
  return [x + op.x, y + op.y];
}

function applyOp(op: ViewOp, point: Vec2, inverse: boolean): Vec2 {
  if (op.op === "orient") return applyOrientOp(op, point, inverse);
  if (op.op === "resize") return applyResizeOp(op, point, inverse);
  return applyCropOp(op, point, inverse);
}

/** Stored-bytes pixels to analysis-view pixels. */
export function applyViewChain(chain: ViewChain, point: Vec2): Vec2 {
  let current = point;
  for (const op of chain.ops) current = applyOp(op, current, false);
  return current;
}

/** Analysis-view pixels back to stored-bytes pixels. Inverse of applyViewChain. */
export function invertViewChain(chain: ViewChain, point: Vec2): Vec2 {
  let current = point;
  for (let index = chain.ops.length - 1; index >= 0; index -= 1) {
    current = applyOp(chain.ops[index], current, true);
  }
  return current;
}

/** Analysis-view dimensions after the chain, from stored dimensions. */
export function chainOutputDims(chain: ViewChain, fromW: number, fromH: number): Vec2 {
  let w = fromW;
  let h = fromH;
  for (const op of chain.ops) {
    if (op.op === "orient" && (op.exif === 6 || op.exif === 8)) {
      [w, h] = [h, w];
    } else if (op.op === "resize") {
      w = op.toW;
      h = op.toH;
    } else if (op.op === "crop") {
      w = op.w;
      h = op.h;
    }
  }
  return [w, h];
}
