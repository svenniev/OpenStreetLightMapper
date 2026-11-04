import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cameraRayToWorld,
  equirectPixelToRay,
  perspectivePixelToRay,
  projectWorldToEquirect,
  projectWorldToPerspective,
  type CameraPose,
  type EquirectangularCamera,
  type PerspectiveCamera,
} from "./cameras.js";
import { vecCross, vecNorm, vecSub, type Vec3 } from "./frames.js";
import {
  checkTriangulationFit,
  closestRayPoints,
  distancePointToSegmentM,
  distanceToLineM,
  estimateUncertaintyM,
  fitLine2DTLS,
  projectOntoLineT,
  triangulateRays,
} from "./solve.js";

function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

/** Look-at world-to-camera pose: rows are right, down, forward in ENU. */
function lookAt(center: Vec3, target: Vec3): CameraPose {
  const toTarget = vecSub(target, center);
  const forward: Vec3 = [
    toTarget[0] / vecNorm(toTarget),
    toTarget[1] / vecNorm(toTarget),
    toTarget[2] / vecNorm(toTarget),
  ];
  const up: Vec3 = [0, 0, 1];
  const rightRaw = vecCross(forward, up);
  const rightNorm = vecNorm(rightRaw);
  const right: Vec3 = [rightRaw[0] / rightNorm, rightRaw[1] / rightNorm, rightRaw[2] / rightNorm];
  const down = vecCross(forward, right);
  return { centerEnu: center, rotationWc: [right, down, forward] };
}

describe("solve", () => {
  it("intersects two rays exactly with hand-computed parallax", () => {
    const target: Vec3 = [5, 0, 10];
    const rays = [
      { origin: [0, 0, 0] as Vec3, direction: [5, 0, 10] as Vec3 },
      { origin: [10, 0, 0] as Vec3, direction: [-5, 0, 10] as Vec3 },
    ].map((entry) => ({
      origin: entry.origin,
      direction: [
        entry.direction[0] / vecNorm(entry.direction),
        entry.direction[1] / vecNorm(entry.direction),
        entry.direction[2] / vecNorm(entry.direction),
      ] as Vec3,
    }));
    const solution = triangulateRays(rays);
    assert.ok(solution);
    near(solution.point[0], target[0], 1e-9, "x");
    near(solution.point[1], target[1], 1e-9, "y");
    near(solution.point[2], target[2], 1e-9, "z");
    near(solution.pairGapsM[0], 0, 1e-9, "gap");
    // cos(parallax) = (75)/(125) = 0.6 -> 53.130deg.
    near(solution.pairParallaxDeg[0], 53.130102, 1e-3, "parallax");
    near(solution.pairBaselinesM[0], 10, 1e-9, "baseline");
    near(solution.depthsM[0], Math.hypot(5, 10), 1e-9, "depth");
  });

  it("rejects degenerate ray sets", () => {
    const unit: Vec3 = [0, 0, 1];
    assert.equal(triangulateRays([{ origin: [0, 0, 0], direction: unit }]), null);
    // Parallel rays never meet.
    assert.equal(
      triangulateRays([
        { origin: [0, 0, 0], direction: unit },
        { origin: [1, 0, 0], direction: unit },
      ]),
      null,
    );
    // Non-unit directions are a caller bug, not a solve.
    assert.equal(
      triangulateRays([
        { origin: [0, 0, 0], direction: [0, 0, 2] },
        { origin: [1, 0, 0], direction: [0, 0, 1] },
      ]),
      null,
    );
  });

  it("measures the closest approach of skew rays", () => {
    const closest = closestRayPoints([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    assert.ok(closest);
    near(closest.gapM, 1, 1e-12, "gap");
    assert.deepEqual(closest.pointOnA, [0, 0, 0]);
    assert.deepEqual(closest.pointOnB, [0, 1, 0]);
    assert.equal(closestRayPoints([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0]), null);
  });

  it("gates solutions on views, depth, gap, parallax, and reprojection", () => {
    const good = triangulateRays([
      { origin: [0, 0, 0], direction: [0.4472135955, 0, 0.894427191] },
      { origin: [10, 0, 0], direction: [-0.4472135955, 0, 0.894427191] },
      { origin: [5, -8, 0], direction: [0, 0.6246950476, 0.7808688094] },
    ]);
    assert.ok(good);
    const pass = checkTriangulationFit({ viewCount: 3, solution: good, reprojectionPx: [1, 2, 3] });
    assert.deepEqual(pass, { ok: true, reasons: [] });

    const twoViews = checkTriangulationFit({ viewCount: 2, solution: good, reprojectionPx: [1, 2] });
    assert.equal(twoViews.ok, false);
    assert.match(twoViews.reasons.join(";"), /needs 3/);

    const missing = checkTriangulationFit({ viewCount: 3, solution: good, reprojectionPx: [1, 2] });
    assert.equal(missing.ok, false);

    const badDepth = checkTriangulationFit({
      viewCount: 3,
      solution: { ...good, depthsM: [10, -1, 10] },
      reprojectionPx: [1, 2, 3],
    });
    assert.match(badDepth.reasons.join(";"), /depth/);

    const badGap = checkTriangulationFit({
      viewCount: 3,
      solution: { ...good, pairGapsM: [0, 2.5, 0] },
      reprojectionPx: [1, 2, 3],
    });
    assert.match(badGap.reasons.join(";"), /gap/);

    const badParallax = checkTriangulationFit({
      viewCount: 3,
      solution: { ...good, pairParallaxDeg: [45, 1.2, 45] },
      reprojectionPx: [1, 2, 3],
    });
    assert.match(badParallax.reasons.join(";"), /parallax/);

    const badReproj = checkTriangulationFit({
      viewCount: 3,
      solution: good,
      reprojectionPx: [1, 2, 30],
    });
    assert.match(badReproj.reasons.join(";"), /reprojection/);
  });

  it("estimates uncertainty from geometry with a ray-gap floor", () => {
    // 20m deep, 10deg parallax, 2px error at f=1000: 0.04/sin(10deg) ~= 0.2304.
    const value = estimateUncertaintyM({
      depthM: 20,
      parallaxDeg: 10,
      focalPx: 1000,
      pixelErrPx: 2,
      rayGapM: 0.1,
    });
    near(value, 0.2304, 1e-4, "geometric uncertainty");
    const floored = estimateUncertaintyM({
      depthM: 20,
      parallaxDeg: 10,
      focalPx: 1000,
      pixelErrPx: 2,
      rayGapM: 1.0,
    });
    assert.equal(floored, 1.0);
  });

  it("proves one small multi-view pole location (perspective fixtures)", () => {
    const camera: PerspectiveCamera = {
      kind: "perspective",
      width: 4000,
      height: 3000,
      focal: 0.9,
      k1: -0.12,
      k2: 0.03,
    };
    const poleBase: Vec3 = [6, 8, 0];
    const centres: Vec3[] = [
      [0, 0, 1.5],
      [6, 0, 1.6],
      [12, 0, 1.5],
    ];
    const poses = centres.map((centre) => lookAt(centre, poleBase));
    const pixels = poses.map((pose) => {
      const projected = projectWorldToPerspective(poleBase, pose, camera);
      assert.equal(projected.ok, true);
      if (!projected.ok) throw new Error("fixture projection failed");
      return projected;
    });
    const rays = pixels.map((pixel, index) => {
      const ray = perspectivePixelToRay(pixel.px, pixel.py, camera);
      assert.equal(ray.ok, true);
      if (!ray.ok) throw new Error("fixture unprojection failed");
      return { origin: centres[index], direction: ray.ray };
    });
    // Rays above are camera-frame; rotate to world through each pose.
    const worldRays = rays.map((entry, index) => ({
      origin: entry.origin,
      direction: cameraRayToWorld(entry.direction, poses[index]),
    }));
    const solution = triangulateRays(worldRays);
    assert.ok(solution);
    near(solution.point[0], poleBase[0], 1e-6, "pole x");
    near(solution.point[1], poleBase[1], 1e-6, "pole y");
    near(solution.point[2], poleBase[2], 1e-6, "pole z");
    // Reproject into every view: the proof closes below a tenth of a pixel.
    const reprojectionPx = poses.map((pose) => {
      const projected = projectWorldToPerspective(solution.point, pose, camera);
      assert.equal(projected.ok, true);
      if (!projected.ok) throw new Error("reprojection failed");
      const index = poses.indexOf(pose);
      return Math.hypot(projected.px - pixels[index].px, projected.py - pixels[index].py);
    });
    for (const error of reprojectionPx) assert.ok(error < 0.1, `reprojection ${error}`);
    const check = checkTriangulationFit({ viewCount: 3, solution, reprojectionPx });
    assert.deepEqual(check, { ok: true, reasons: [] });
  });

  it("proves one small multi-view pole location (panorama fixtures)", () => {
    const camera: EquirectangularCamera = { kind: "equirectangular", width: 4096, height: 2048 };
    const poleBase: Vec3 = [6, 8, 0];
    const centres: Vec3[] = [
      [0, 0, 1.5],
      [6, 0, 1.6],
      [12, 0, 1.5],
    ];
    // Panos face wherever they face; give each a simple north-facing level pose.
    const north = [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ] as [Vec3, Vec3, Vec3];
    const poses: CameraPose[] = centres.map((centre) => ({ centerEnu: centre, rotationWc: north }));
    const byView = poses.map((pose, index) => {
      const projected = projectWorldToEquirect(poleBase, pose, camera);
      assert.equal(projected.ok, true);
      if (!projected.ok) throw new Error("fixture projection failed");
      const ray = equirectPixelToRay(projected.px, projected.py, camera);
      assert.equal(ray.ok, true);
      if (!ray.ok) throw new Error("fixture unprojection failed");
      return {
        origin: centres[index],
        direction: cameraRayToWorld(ray.ray, pose),
        pixel: projected,
      };
    });
    const solution = triangulateRays(byView);
    assert.ok(solution);
    near(solution.point[0], poleBase[0], 1e-6, "pole x");
    near(solution.point[1], poleBase[1], 1e-6, "pole y");
    near(solution.point[2], poleBase[2], 1e-6, "pole z");
    const reprojectionPx = byView.map((entry, index) => {
      const projected = projectWorldToEquirect(solution.point, poses[index], camera);
      assert.equal(projected.ok, true);
      if (!projected.ok) throw new Error("reprojection failed");
      return Math.hypot(projected.px - entry.pixel.px, projected.py - entry.pixel.py);
    });
    for (const error of reprojectionPx) assert.ok(error < 0.1, `reprojection ${error}`);
    const check = checkTriangulationFit({ viewCount: 3, solution, reprojectionPx });
    assert.deepEqual(check, { ok: true, reasons: [] });
  });

  it("fits street lines and measures point and segment distances", () => {
    const line = fitLine2DTLS([
      [0, 1],
      [2, 5],
      [4, 9],
      [6, 13],
    ]);
    assert.ok(line);
    // y = 2x + 1: direction [1, 2]/sqrt(5) up to sign.
    const dot = Math.abs((line.direction[0] + 2 * line.direction[1]) / Math.sqrt(5));
    near(dot, 1, 1e-9, "line direction");
    near(distanceToLineM([10, 21], line), 0, 1e-9, "on-line distance");
    near(distanceToLineM([10, 22], line), 1 / Math.sqrt(5), 1e-9, "off-line distance");
    near(projectOntoLineT([10, 21], line), Math.hypot(10 - 3, 21 - 7), 1e-9, "line station");

    const vertical = fitLine2DTLS([
      [5, 0],
      [5, 10],
    ]);
    assert.ok(vertical);
    near(Math.abs(vertical.direction[1]), 1, 1e-9, "vertical direction");
    assert.equal(fitLine2DTLS([[1, 1]]), null);
    assert.equal(fitLine2DTLS([]), null);

    near(distancePointToSegmentM([0, 1], [0, 0], [10, 0]), 1, 1e-12, "segment distance");
    near(distancePointToSegmentM([12, 0], [0, 0], [10, 0]), 2, 1e-12, "past endpoint");
    near(distancePointToSegmentM([3, 4], [0, 0], [0, 0]), 5, 1e-12, "degenerate segment");
  });
});
