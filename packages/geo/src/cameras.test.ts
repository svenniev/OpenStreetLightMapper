import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cameraRayToWorld,
  equirectPixelToRay,
  focalPixels,
  maskColumnSupport,
  normalizedToPixels,
  perspectivePixelToRay,
  pixelsToNormalized,
  poleBaseAnchorFromBox,
  projectWorldToEquirect,
  projectWorldToPerspective,
  validateCameraDescriptor,
  type CameraPose,
  type PerspectiveCamera,
} from "./cameras.js";
import { levelPoseFromCompass } from "./frames.js";

function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

const PERSP: PerspectiveCamera = { kind: "perspective", width: 100, height: 60, focal: 1, k1: 0, k2: 0 };

function northPose(center: [number, number, number] = [0, 0, 0]): CameraPose {
  const rotationWc = levelPoseFromCompass(0);
  assert.ok(rotationWc);
  return { centerEnu: center, rotationWc };
}

describe("cameras", () => {
  it("accepts only supported, in-range camera descriptors", () => {
    const ok = validateCameraDescriptor({
      cameraType: "perspective",
      cameraParameters: [0.9, -0.1, 0.02],
      width: 4000,
      height: 3000,
    });
    assert.equal(ok.ok, true);

    const pano = validateCameraDescriptor({
      cameraType: "equirectangular",
      cameraParameters: [],
      width: 4096,
      height: 2048,
    });
    assert.equal(pano.ok, true);

    for (const [label, input, reason] of [
      ["fisheye", { cameraType: "fisheye", cameraParameters: [1, 0, 0], width: 100, height: 100 }, /fisheye/],
      ["unknown type", { cameraType: "thin-prism", cameraParameters: [], width: 100, height: 100 }, /unsupported/],
      ["missing type", { cameraType: null, cameraParameters: [], width: 100, height: 100 }, /unsupported/],
      ["missing params", { cameraType: "perspective", cameraParameters: null, width: 100, height: 100 }, /camera_parameters/],
      ["short params", { cameraType: "perspective", cameraParameters: [1, 0], width: 100, height: 100 }, /camera_parameters/],
      ["bad focal", { cameraType: "perspective", cameraParameters: [0.05, 0, 0], width: 100, height: 100 }, /focal/],
      ["bad k1", { cameraType: "perspective", cameraParameters: [1, 5, 0], width: 100, height: 100 }, /k1/],
      ["bad width", { cameraType: "perspective", cameraParameters: [1, 0, 0], width: 0, height: 100 }, /width/],
      ["non-2:1 pano", { cameraType: "equirectangular", cameraParameters: [], width: 400, height: 300 }, /aspect/],
    ] as const) {
      const verdict = validateCameraDescriptor(input);
      assert.equal(verdict.ok, false, label);
      if (!verdict.ok) assert.match(verdict.reason, reason, label);
    }
  });

  it("maps pixels to OpenSfM normalized coordinates and back", () => {
    const [u, v] = pixelsToNormalized(0, 0, 100, 60);
    near(u, -0.495, 1e-12, "corner u");
    near(v, -0.295, 1e-12, "corner v");
    const [px, py] = normalizedToPixels(u, v, 100, 60);
    near(px, 0, 1e-9, "round-trip x");
    near(py, 0, 1e-9, "round-trip y");
  });

  it("casts exact perspective rays at hand-computed pixels", () => {
    // Image centre ray is the optical axis.
    const centre = perspectivePixelToRay(49.5, 29.5, PERSP);
    assert.equal(centre.ok, true);
    if (centre.ok) {
      near(centre.ray[0], 0, 1e-12, "centre x");
      near(centre.ray[1], 0, 1e-12, "centre y");
      near(centre.ray[2], 1, 1e-12, "centre z");
    }
    // Half-width right of centre with f=1: direction (0.5, 0, 1) normalized.
    const right = perspectivePixelToRay(99.5, 29.5, PERSP);
    assert.equal(right.ok, true);
    if (right.ok) {
      const norm = Math.hypot(0.5, 0, 1);
      near(right.ray[0], 0.5 / norm, 1e-12, "right x");
      near(right.ray[2], 1 / norm, 1e-12, "right z");
    }
  });

  it("round-trips project and unproject with distortion", () => {
    const camera: PerspectiveCamera = { ...PERSP, width: 4000, height: 3000, focal: 0.9, k1: -0.15, k2: 0.04 };
    const pose = northPose();
    const points: [number, number, number][] = [
      [0, 10, 0],
      [5, 12, 1],
      [-8, 20, -2],
      [15, 9, 3],
    ];
    for (const point of points) {
      const projected = projectWorldToPerspective(point, pose, camera);
      assert.equal(projected.ok, true);
      if (!projected.ok) continue;
      const ray = perspectivePixelToRay(projected.px, projected.py, camera);
      assert.equal(ray.ok, true);
      if (!ray.ok) continue;
      // Expected camera-frame ray straight from the pose math.
      const translated: [number, number, number] = [point[0], point[1], point[2]];
      const cam = [
        pose.rotationWc[0][0] * translated[0] + pose.rotationWc[0][1] * translated[1] + pose.rotationWc[0][2] * translated[2],
        pose.rotationWc[1][0] * translated[0] + pose.rotationWc[1][1] * translated[1] + pose.rotationWc[1][2] * translated[2],
        pose.rotationWc[2][0] * translated[0] + pose.rotationWc[2][1] * translated[1] + pose.rotationWc[2][2] * translated[2],
      ] as const;
      const norm = Math.hypot(cam[0], cam[1], cam[2]);
      const dot =
        (ray.ray[0] * cam[0] + ray.ray[1] * cam[1] + ray.ray[2] * cam[2]) / norm;
      assert.ok(dot > 1 - 1e-9, `round-trip ray alignment for ${point}: ${dot}`);
    }
  });

  it("projects hand-computed perspective pixels and rejects behind-camera points", () => {
    const pose = northPose();
    const centre = projectWorldToPerspective([0, 10, 0], pose, PERSP);
    assert.deepEqual(centre, { ok: true, px: 49.5, py: 29.5 });
    const right = projectWorldToPerspective([5, 10, 0], pose, PERSP);
    assert.deepEqual(right, { ok: true, px: 99.5, py: 29.5 });
    const behind = projectWorldToPerspective([0, -10, 0], pose, PERSP);
    assert.equal(behind.ok, false);
    if (!behind.ok) assert.match(behind.reason, /behind/);
  });

  it("rotates camera rays to world rays through the pose", () => {
    const pose = northPose();
    assert.deepEqual(cameraRayToWorld([0, 0, 1], pose), [0, 1, 0]);
    assert.deepEqual(cameraRayToWorld([1, 0, 0], pose), [1, 0, 0]);
  });

  it("casts exact equirectangular rays with seam continuity and pole gates", () => {
    const camera = { kind: "equirectangular", width: 200, height: 100 } as const;
    const centre = equirectPixelToRay(99.5, 49.5, camera);
    assert.equal(centre.ok, true);
    if (centre.ok) {
      near(centre.ray[0], 0, 1e-12, "centre x");
      near(centre.ray[1], 0, 1e-12, "centre y");
      near(centre.ray[2], 1, 1e-12, "centre z");
    }
    // Quarter width right of centre: lon=+90deg, camera-right.
    const right = equirectPixelToRay(149.5, 49.5, camera);
    assert.equal(right.ok, true);
    if (right.ok) {
      near(right.ray[0], 1, 1e-12, "right x");
      near(right.ray[1], 0, 1e-12, "right y");
      near(right.ray[2], 0, 1e-12, "right z");
    }
    // Seam: u=-0.5 and u=+0.5 are the same meridian (lon=+-PI).
    const left = equirectPixelToRay(-0.5, 49.5, camera);
    const wrapped = equirectPixelToRay(199.5, 49.5, camera);
    assert.equal(left.ok, true);
    assert.equal(wrapped.ok, true);
    if (left.ok && wrapped.ok) {
      const dot = left.ray[0] * wrapped.ray[0] + left.ray[1] * wrapped.ray[1] + left.ray[2] * wrapped.ray[2];
      assert.ok(dot > 1 - 1e-12, `seam continuity: ${dot}`);
    }
    // Poles excluded.
    const zenith = equirectPixelToRay(99.5, 0, camera);
    assert.equal(zenith.ok, false);
    if (!zenith.ok) assert.match(zenith.reason, /pole/);
    const nadir = equirectPixelToRay(99.5, 99, camera);
    assert.equal(nadir.ok, false);
  });

  it("round-trips equirectangular project and unproject", () => {
    const camera = { kind: "equirectangular", width: 2048, height: 1024 } as const;
    const pose = northPose([0, 0, 1.5]);
    const points: [number, number, number][] = [
      [0, 10, 1.5],
      [7, 9, 0],
      [-6, 14, 4],
      [0, -12, 1.5],
    ];
    for (const point of points) {
      const projected = projectWorldToEquirect(point, pose, camera);
      assert.equal(projected.ok, true, `project ${point}`);
      if (!projected.ok) continue;
      const ray = equirectPixelToRay(projected.px, projected.py, camera);
      assert.equal(ray.ok, true, `unproject ${point}`);
      if (!ray.ok) continue;
      const world = cameraRayToWorld(ray.ray, pose);
      const expected: [number, number, number] = [point[0] - 0, point[1] - 0, point[2] - 1.5];
      const norm = Math.hypot(expected[0], expected[1], expected[2]);
      const dot = (world[0] * expected[0] + world[1] * expected[1] + world[2] * expected[2]) / norm;
      assert.ok(dot > 1 - 1e-9, `pano round-trip alignment for ${point}: ${dot}`);
    }
  });

  it("reports focal lengths in stored pixels", () => {
    near(focalPixels({ ...PERSP, focal: 0.8 }), 80, 1e-9, "perspective focal");
    near(focalPixels({ kind: "equirectangular", width: 200, height: 100 }), 200 / (2 * Math.PI), 1e-9, "pano focal");
  });

  it("anchors pole bases below the box bottom with a 3deg default margin", () => {
    const anchor = poleBaseAnchorFromBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.4 }, 1000, 800, 800);
    near(anchor.x, 500, 1e-9, "anchor x");
    near(anchor.y, 640 + ((3 * Math.PI) / 180) * 800, 1e-6, "anchor y");
    assert.equal(anchor.clamped, false);
    const edge = poleBaseAnchorFromBox({ x: 0.4, y: 0.9, w: 0.2, h: 0.1 }, 1000, 800, 800);
    assert.equal(edge.y, 799);
    assert.equal(edge.clamped, true);
  });

  it("scores mask-column support over the anchor band", () => {
    const full = maskColumnSupport(() => true, 100, 100, 50, 40, 80);
    assert.equal(full.supported, true);
    assert.equal(full.fraction, 1);
    const empty = maskColumnSupport(() => false, 100, 100, 50, 40, 80);
    assert.equal(empty.supported, false);
    assert.equal(empty.fraction, 0);
    // Left half masked: fraction 0.5 clears the 0.25 bar.
    const half = maskColumnSupport((x) => x < 50, 100, 100, 50, 40, 80);
    assert.ok(Math.abs(half.fraction - 0.5) < 0.2, `half fraction ${half.fraction}`);
    assert.equal(half.supported, true);
    const sliver = maskColumnSupport((x, y) => x === 50 && y === 60, 100, 100, 50, 40, 80);
    assert.equal(sliver.supported, false);
  });
});
