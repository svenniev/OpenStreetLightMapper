import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ValidatedAutoViewDescriptor } from "../db/autoValidation.js";
import type { SamObject } from "../sam.js";
import { buildAutoObservations } from "./observations.js";

function descriptor(overrides: Record<string, unknown> = {}): ValidatedAutoViewDescriptor {
  return {
    width: 2048,
    height: 1536,
    chain: { ops: [] },
    camera: { cameraType: "perspective", cameraParameters: [0.8, 0, 0] },
    pose: {
      centerEnu: [0, 0, 2],
      rotationWcAxisAngle: [Math.PI / 2, 0, 0],
      positionSource: "computed",
      rotationSource: "computed",
    },
    anchor: { lngLat: [19, 47], altM: 0 },
    source: { imageId: "img-1", geometrySource: "plan" },
    ...overrides,
  } as unknown as ValidatedAutoViewDescriptor;
}

function samObject(overrides: Partial<SamObject> = {}): SamObject {
  return {
    providerObjectId: "sam-1",
    box: { left: 100, top: 100, right: 200, bottom: 400 },
    boxNorm: { x: 0.4, y: 0.3, w: 0.05, h: 0.2 },
    confidence: 0.9,
    mask: null,
    ...overrides,
  };
}

describe("buildAutoObservations", () => {
  it("anchors poles below the box and luminaires at the centre with rays", () => {
    const pole = buildAutoObservations({
      itemId: "img-1--v0--pole",
      attempts: 0,
      category: "pole",
      descriptor: descriptor(),
      objects: [samObject()],
      maskArtifactIds: new Map(),
    });
    assert.equal(pole.invalidDiscarded, 0);
    assert.equal(pole.observations.length, 1);
    const observation = pole.observations[0];
    assert.equal(observation.observationId, "img-1--v0--pole--a0--o0");
    const anchor = observation.anchor as { method: string; uPx: number; vPx: number };
    assert.equal(anchor.method, "pole-base-margin");
    // Bottom-centre of the box plus the ground-contact margin below it.
    const boxBottomPx = (0.3 + 0.2) * 1536;
    assert.ok(anchor.vPx > boxBottomPx);
    assert.ok(Math.abs(anchor.uPx - (0.4 + 0.025) * 2048) < 1);
    assert.ok(observation.ray);
    assert.equal(observation.rayFailure, null);
    assert.equal(observation.truncated, false);

    const lamp = buildAutoObservations({
      itemId: "img-1--v0--lamp",
      attempts: 0,
      category: "luminaire",
      descriptor: descriptor(),
      objects: [samObject()],
      maskArtifactIds: new Map(),
    });
    const lampAnchor = lamp.observations[0].anchor as { method: string; uPx: number; vPx: number };
    assert.equal(lampAnchor.method, "box-center");
    assert.ok(Math.abs(lampAnchor.uPx - (0.4 + 0.025) * 2048) < 1);
    assert.ok(Math.abs(lampAnchor.vPx - (0.3 + 0.1) * 1536) < 1);
  });

  it("fails rays closed with stable reasons when geometry is missing", () => {
    const noCamera = buildAutoObservations({
      itemId: "item-1",
      attempts: 0,
      category: "pole",
      descriptor: descriptor({ camera: null }),
      objects: [samObject()],
      maskArtifactIds: new Map(),
    });
    assert.equal(noCamera.observations[0].ray, null);
    assert.equal(noCamera.observations[0].rayFailure, "unknown-camera");

    const noPose = buildAutoObservations({
      itemId: "item-1",
      attempts: 0,
      category: "pole",
      descriptor: descriptor({ pose: null }),
      objects: [samObject()],
      maskArtifactIds: new Map(),
    });
    assert.equal(noPose.observations[0].rayFailure, "no-pose");
  });

  it("records seam proximity, truncation, and mask support", () => {
    const pano = descriptor({
      width: 2048,
      height: 1024,
      camera: { cameraType: "equirectangular", cameraParameters: [] },
    });
    const seam = buildAutoObservations({
      itemId: "item-1",
      attempts: 0,
      category: "luminaire",
      descriptor: pano,
      objects: [samObject({ boxNorm: { x: 0.001, y: 0.4, w: 0.01, h: 0.1 } })],
      maskArtifactIds: new Map(),
    });
    assert.equal(seam.observations[0].nearSeam, true);
    assert.ok(seam.observations[0].ray);

    const clipped = buildAutoObservations({
      itemId: "item-1",
      attempts: 0,
      category: "pole",
      descriptor: descriptor(),
      objects: [samObject({ boxNorm: { x: 0.4, y: 0.8, w: 0.05, h: 0.2 } })],
      maskArtifactIds: new Map(),
    });
    assert.equal(clipped.observations[0].truncated, true);
    assert.equal((clipped.observations[0].anchor as { bottomClipped: boolean }).bottomClipped, true);

    const masked = buildAutoObservations({
      itemId: "item-1",
      attempts: 0,
      category: "pole",
      descriptor: descriptor(),
      objects: [
        samObject({
          mask: {
            svgPath: "M0 0L10 0L10 10L0 10Z",
            width: 64,
            height: 64,
            bounds: { left: 819, top: 460, right: 921, bottom: 768 },
          },
        }),
      ],
      maskArtifactIds: new Map([["sam-1", "0123456789abcdef01234567"]]),
    });
    assert.deepEqual(masked.observations[0].maskSupport, {
      usable: true,
      bounds: { left: 819, top: 460, right: 921, bottom: 768 },
      rasterWidth: 64,
      rasterHeight: 64,
    });
    assert.equal(masked.observations[0].maskArtifactId, "0123456789abcdef01234567");

    const degenerate = buildAutoObservations({
      itemId: "item-1",
      attempts: 0,
      category: "pole",
      descriptor: descriptor(),
      objects: [
        samObject({
          mask: {
            svgPath: "",
            width: 64,
            height: 64,
            bounds: { left: 10, top: 10, right: 10, bottom: 10 },
          },
        }),
      ],
      maskArtifactIds: new Map(),
    });
    assert.equal((degenerate.observations[0].maskSupport as { usable: boolean }).usable, false);
  });

  it("discards invalid objects and counts them", () => {
    const output = buildAutoObservations({
      itemId: "item-1",
      attempts: 2,
      category: "pole",
      descriptor: descriptor(),
      objects: [
        samObject(),
        samObject({ providerObjectId: "sam-2", boxNorm: { x: 0.1, y: 0.1, w: 2, h: 0.1 } }),
      ],
      maskArtifactIds: new Map(),
    });
    assert.equal(output.observations.length, 1);
    assert.equal(output.invalidDiscarded, 1);
    assert.equal(output.observations[0].observationId, "item-1--a2--o0");
  });
});
