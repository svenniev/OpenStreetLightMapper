import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyViewChain,
  axisAngleToMatrix,
  chainOutputDims,
  enuToLla,
  invertViewChain,
  levelPoseFromCompass,
  llaToEnu,
  matTranspose,
  matVec,
  type ViewChain,
} from "./frames.js";

function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

describe("frames", () => {
  it("converts axis-angle to rotation matrices (Rodrigues)", () => {
    const identity = axisAngleToMatrix([0, 0, 0]);
    assert.deepEqual(identity, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    // 90deg about +Z: X -> Y.
    const quarter = axisAngleToMatrix([0, 0, Math.PI / 2]);
    assert.ok(quarter);
    const rotated = matVec(quarter, [1, 0, 0]);
    near(rotated[0], 0, 1e-12, "rotated x");
    near(rotated[1], 1, 1e-12, "rotated y");
    near(rotated[2], 0, 1e-12, "rotated z");
    // Non-finite input is rejected, never a NaN matrix.
    assert.equal(axisAngleToMatrix([0, Number.NaN, 0]), null);
  });

  it("keeps the documented example rotation orthonormal with det +1", () => {
    const rotation = axisAngleToMatrix([1.033, -1.267, 1.394]);
    assert.ok(rotation);
    const transpose = matTranspose(rotation);
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        let dot = 0;
        for (let k = 0; k < 3; k += 1) dot += rotation[row][k] * transpose[k][col];
        near(dot, row === col ? 1 : 0, 1e-12, `orthonormal [${row}][${col}]`);
      }
    }
    const [a, b, c] = rotation;
    const det =
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    near(det, 1, 1e-12, "determinant");
  });

  it("builds level compass poses for the cardinal headings", () => {
    for (const [heading, forward, right] of [
      [0, [0, 1, 0], [1, 0, 0]],
      [90, [1, 0, 0], [0, -1, 0]],
      [180, [0, -1, 0], [-1, 0, 0]],
      [270, [-1, 0, 0], [0, 1, 0]],
    ] as const) {
      const pose = levelPoseFromCompass(heading);
      assert.ok(pose);
      const rounded = (row: readonly number[]): number[] =>
        row.map((entry) => Math.round(entry) + 0);
      assert.deepEqual(rounded(pose[2]), forward, `forward at ${heading}deg`);
      assert.deepEqual(rounded(pose[0]), right, `right at ${heading}deg`);
      assert.deepEqual(pose[1], [0, 0, -1]);
    }
    assert.equal(levelPoseFromCompass(Number.NaN), null);
  });

  it("converts WGS84 to ENU with the documented spherical scale", () => {
    const anchor = { lngLat: [19.04, 47.49] as [number, number], altM: 100 };
    // One degree of longitude at 47.49degN: R * cos(47.49deg) * PI/180 ~= 75136.6m.
    const [e] = llaToEnu(20.04, 47.49, 100, anchor);
    near(e, 75136.6, 0.5, "east metres per degree");
    const [, n] = llaToEnu(19.04, 48.49, 100, anchor);
    near(n, 111195.08, 0.5, "north metres per degree");
    const [, , u] = llaToEnu(19.04, 47.49, 105.5, anchor);
    near(u, 5.5, 1e-9, "up metres");
  });

  it("round-trips ENU to WGS84 within nanometres", () => {
    const anchor = { lngLat: [19.04, 47.49] as [number, number], altM: 100 };
    const [lng, lat, alt] = enuToLla(123.456, -78.9, 2.5, anchor);
    const [e, n, u] = llaToEnu(lng, lat, alt, anchor);
    near(e, 123.456, 1e-6, "east round-trip");
    near(n, -78.9, 1e-6, "north round-trip");
    near(u, 2.5, 1e-9, "up round-trip");
  });

  it("maps EXIF orientation 6 exactly and inverts every view chain", () => {
    // Stored 100x60, EXIF 6: upright is 60x100, stored (10,20) -> (39,10).
    const orient6: ViewChain = { ops: [{ op: "orient", exif: 6, fromW: 100, fromH: 60 }] };
    assert.deepEqual(applyViewChain(orient6, [10, 20]), [39, 10]);
    assert.deepEqual(chainOutputDims(orient6, 100, 60), [60, 100]);
    const cases: ViewChain[] = [
      { ops: [{ op: "orient", exif: 1, fromW: 100, fromH: 60 }] },
      { ops: [{ op: "orient", exif: 3, fromW: 100, fromH: 60 }] },
      orient6,
      { ops: [{ op: "orient", exif: 8, fromW: 100, fromH: 60 }] },
      { ops: [{ op: "resize", fromW: 100, fromH: 60, toW: 50, toH: 30 }] },
      { ops: [{ op: "crop", x: 5, y: 7, w: 50, h: 40 }] },
      {
        ops: [
          { op: "orient", exif: 6, fromW: 100, fromH: 60 },
          { op: "resize", fromW: 60, fromH: 100, toW: 30, toH: 50 },
          { op: "crop", x: 2, y: 3, w: 20, h: 40 },
        ],
      },
    ];
    for (const chain of cases) {
      for (const point of [
        [0, 0],
        [10, 20],
        [99, 59],
      ] as const) {
        const forward = applyViewChain(chain, [point[0], point[1]]);
        const back = invertViewChain(chain, forward);
        near(back[0], point[0], 1e-9, "chain round-trip x");
        near(back[1], point[1], 1e-9, "chain round-trip y");
      }
    }
  });
});
