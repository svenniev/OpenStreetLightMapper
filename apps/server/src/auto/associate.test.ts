import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  axisAngleToMatrix,
  enuToLla,
  llaToEnu,
  projectWorldToPixel,
  type CameraPose,
  type Vec3,
} from "@openstreetlightmapper/geo";
import type { AutoObservationDocument } from "../db/autoModels.js";
import type { ValidatedAutoViewDescriptor } from "../db/autoValidation.js";
import type { ResolvedAutoPlan } from "./plan.js";
import { associateObservations, type AssociationView, type StreetLine } from "./associate.js";

const ANCHOR = { lngLat: [19.0, 47.0] as [number, number], altM: 0 };
// Cameras look level along +Y (north); rotationWc is +90deg about X.
const AXIS_ANGLE: [number, number, number] = [Math.PI / 2, 0, 0];
const VIEW_W = 2048;
const VIEW_H = 1536;
const FOCAL = 0.8;

const ROTATION = axisAngleToMatrix(AXIS_ANGLE);
assert.ok(ROTATION);

function pose(centerEnu: Vec3): CameraPose {
  return { centerEnu, rotationWc: ROTATION as unknown as CameraPose["rotationWc"] };
}

function project(centerEnu: Vec3, point: Vec3): { u: number; v: number } {
  const projected = projectWorldToPixel(point, pose(centerEnu), {
    kind: "perspective",
    width: VIEW_W,
    height: VIEW_H,
    focal: FOCAL,
    k1: 0,
    k2: 0,
  });
  assert.equal(projected.ok, true);
  if (!projected.ok) throw new Error("projection failed in fixture");
  return { u: projected.px, v: projected.py };
}

function rayThrough(centerEnu: Vec3, point: Vec3): { origin: Vec3; direction: Vec3 } {
  const direction: Vec3 = [point[0] - centerEnu[0], point[1] - centerEnu[1], point[2] - centerEnu[2]];
  const norm = Math.hypot(...direction);
  return { origin: [...centerEnu], direction: [direction[0] / norm, direction[1] / norm, direction[2] / norm] };
}

let obsCounter = 0;

function observation(
  imageId: string,
  category: "pole" | "luminaire",
  centerEnu: Vec3,
  point: Vec3,
  overrides: Partial<AutoObservationDocument> = {},
): AutoObservationDocument {
  obsCounter += 1;
  const { u, v } = project(centerEnu, point);
  const boxW = 100 / VIEW_W;
  const boxH = 300 / VIEW_H;
  return {
    observationId: `o-${obsCounter}`,
    imageId,
    category,
    box: { x: u / VIEW_W - boxW / 2, y: v / VIEW_H - boxH, w: boxW, h: boxH },
    confidence: 0.9,
    anchor: { method: "fixture", uPx: u, vPx: v, marginPx: 10, clamped: false },
    maskSupport: null,
    ray: rayThrough(centerEnu, point),
    rayFailure: null,
    nearSeam: false,
    truncated: false,
    ...overrides,
  } as unknown as AutoObservationDocument;
}

function view(imageId: string, centerEnu: Vec3): AssociationView {
  return {
    imageId,
    descriptor: {
      width: VIEW_W,
      height: VIEW_H,
      chain: { ops: [] },
      camera: { cameraType: "perspective", cameraParameters: [FOCAL, 0, 0] },
      pose: { centerEnu: [...centerEnu], rotationWcAxisAngle: [...AXIS_ANGLE], positionSource: "computed", rotationSource: "computed" },
      anchor: ANCHOR,
      source: { imageId, geometrySource: "plan" },
    } as unknown as ValidatedAutoViewDescriptor,
  };
}

function plan(
  images: Array<{ imageId: string; sequenceId: string; mergeCc?: number | null; capturedAt?: number | null }>,
): ResolvedAutoPlan {
  return {
    mode: "locate",
    snapshotId: "snap-1",
    streetSnapshotId: null,
    sequenceIds: [...new Set(images.map((image) => image.sequenceId))],
    imageIds: images.map((image) => image.imageId),
    anchor: ANCHOR,
    images: images.map((image) => ({
      imageId: image.imageId,
      sequenceId: image.sequenceId,
      mergeCc: image.mergeCc ?? null,
      capturedAt: image.capturedAt ?? null,
    })),
  } as unknown as ResolvedAutoPlan;
}

function streetAt(yMeters: number, id: string): StreetLine {
  const line: Array<[number, number]> = [];
  for (const e of [-10, 0, 10, 20, 30]) {
    const [lng, lat] = enuToLla(e, yMeters, 0, ANCHOR);
    line.push([lng, lat]);
  }
  return { id, displayName: id, lines: [line] };
}

const C1: Vec3 = [0, 0, 2];
const C2: Vec3 = [4, 0, 2];
const C3: Vec3 = [8, 0, 2];
const POLE_A: Vec3 = [4, 15, 0];
const POLE_B: Vec3 = [4, 22, 0];
const LAMP_A: Vec3 = [4, 15, 6];

describe("associateObservations fixtures", () => {
  it("locates one pole from three views and assigns its street", () => {
    obsCounter = 0;
    const observations = [
      observation("img-1", "pole", C1, POLE_A, { observationId: "o-a1" }),
      observation("img-2", "pole", C2, POLE_A, { observationId: "o-a2" }),
      observation("img-3", "pole", C3, POLE_A, { observationId: "o-a3" }),
    ];
    const output = associateObservations({
      plan: plan([
        { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
        { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
        { imageId: "img-3", sequenceId: "seq-a", mergeCc: 1, capturedAt: 3000 },
      ]),
      observations,
      views: [view("img-1", C1), view("img-2", C2), view("img-3", C3)],
      streets: [streetAt(13, "street-main"), streetAt(100, "street-far")],
    });
    assert.equal(output.candidates.length, 1);
    const candidate = output.candidates[0];
    assert.equal(candidate.status, "located");
    assert.equal(candidate.kind, "pole");
    assert.deepEqual(candidate.observationIds, ["o-a1", "o-a2", "o-a3"]);
    assert.equal(candidate.viewCount, 3);
    assert.equal(candidate.streetId, "street-main");
    assert.ok(candidate.position);
    const [expectedLng, expectedLat] = enuToLla(POLE_A[0], POLE_A[1], POLE_A[2], ANCHOR);
    assert.ok(Math.abs(candidate.position.lng - expectedLng) < 1e-6);
    assert.ok(Math.abs(candidate.position.lat - expectedLat) < 1e-6);
    assert.ok(candidate.position.uncertaintyM <= 3);
    assert.deepEqual(output.unlocated, []);
    assert.equal(output.duplicateGroupCount, 0);
  });

  it("flags pole pairs under 10 m and keeps both positions", () => {
    obsCounter = 0;
    const observations = [
      observation("img-1", "pole", C1, POLE_A, { observationId: "o-a1" }),
      observation("img-2", "pole", C2, POLE_A, { observationId: "o-a2" }),
      observation("img-3", "pole", C3, POLE_A, { observationId: "o-a3" }),
      observation("img-1", "pole", C1, POLE_B, { observationId: "o-b1" }),
      observation("img-2", "pole", C2, POLE_B, { observationId: "o-b2" }),
      observation("img-3", "pole", C3, POLE_B, { observationId: "o-b3" }),
    ];
    const output = associateObservations({
      plan: plan([
        { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
        { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
        { imageId: "img-3", sequenceId: "seq-a", mergeCc: 1, capturedAt: 3000 },
      ]),
      observations,
      views: [view("img-1", C1), view("img-2", C2), view("img-3", C3)],
      streets: [streetAt(13, "street-main")],
    });
    assert.equal(output.candidates.length, 2);
    assert.ok(output.candidates.every((candidate) => candidate.status === "located"));
    assert.ok(output.candidates.every((candidate) => candidate.checks.includes("possible-duplicate")));
    assert.equal(output.duplicateGroupCount, 1);
  });

  it("rejects the chain-merge trap without a wrong located pin", () => {
    obsCounter = 0;
    // Two poles 1.5 m apart at the same depth: V2 sees both nearly aligned.
    const trapA: Vec3 = [4, 15, 0];
    const trapB: Vec3 = [5.5, 15, 0];
    const observations = [
      observation("img-1", "pole", C1, trapA, { observationId: "o-a1" }),
      observation("img-2", "pole", C2, trapA, { observationId: "o-a2" }),
      observation("img-3", "pole", C3, trapB, { observationId: "o-b3" }),
    ];
    const output = associateObservations({
      plan: plan([
        { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
        { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
        { imageId: "img-3", sequenceId: "seq-a", mergeCc: 1, capturedAt: 3000 },
      ]),
      observations,
      views: [view("img-1", C1), view("img-2", C2), view("img-3", C3)],
      streets: null,
    });
    assert.equal(output.candidates.filter((candidate) => candidate.status === "located").length, 0);
    // The agreeing pair stays an unresolved hypothesis; the third view,
    // which breaks the joint fit, awaits more evidence instead of merging.
    assert.equal(output.candidates.length, 1);
    assert.deepEqual(output.candidates[0].observationIds, ["o-a1", "o-a2"]);
    assert.deepEqual(output.unlocated, [{ observationId: "o-b3", reason: "single-view" }]);
  });

  it("dedupes overlapping boxes within one image and keeps separated shafts", () => {
    obsCounter = 0;
    const base = observation("img-1", "pole", C1, POLE_A, { observationId: "o-keep" });
    const duplicate = observation("img-1", "pole", C1, POLE_A, { observationId: "o-dup" });
    // Largely overlapping but smaller: the largest box wins, deterministically.
    duplicate.box = { x: base.box.x + 0.005, y: base.box.y + 0.01, w: base.box.w * 0.9, h: base.box.h * 0.9 };
    const separated = observation("img-1", "pole", C1, POLE_B, { observationId: "o-sep" });
    const output = associateObservations({
      plan: plan([{ imageId: "img-1", sequenceId: "seq-a" }]),
      observations: [base, duplicate, separated],
      views: [view("img-1", C1)],
      streets: null,
    });
    assert.deepEqual(output.candidates, []);
    assert.deepEqual(output.unlocated, [
      { observationId: "o-dup", reason: "duplicate-in-image" },
      { observationId: "o-keep", reason: "single-view" },
      { observationId: "o-sep", reason: "single-view" },
    ]);
  });

  it("links a luminaire to its pole and leaves distant fixtures unlinked", () => {
    obsCounter = 0;
    const observations = [
      observation("img-1", "pole", C1, POLE_A, { observationId: "o-p1" }),
      observation("img-2", "pole", C2, POLE_A, { observationId: "o-p2" }),
      observation("img-3", "pole", C3, POLE_A, { observationId: "o-p3" }),
      observation("img-1", "luminaire", C1, LAMP_A, { observationId: "o-l1" }),
      observation("img-2", "luminaire", C2, LAMP_A, { observationId: "o-l2" }),
      observation("img-3", "luminaire", C3, LAMP_A, { observationId: "o-l3" }),
      observation("img-1", "luminaire", C1, [24, 15, 6], { observationId: "o-far" }),
    ];
    const output = associateObservations({
      plan: plan([
        { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
        { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
        { imageId: "img-3", sequenceId: "seq-a", mergeCc: 1, capturedAt: 3000 },
      ]),
      observations,
      views: [view("img-1", C1), view("img-2", C2), view("img-3", C3)],
      streets: null,
    });
    const pole = output.candidates.find((candidate) => candidate.kind === "pole");
    const lamp = output.candidates.find((candidate) => candidate.kind === "luminaire" && candidate.status === "located");
    assert.ok(pole && lamp);
    assert.equal(lamp.poleCandidateId, pole.candidateId);
    assert.deepEqual(pole.luminaireCandidateIds, [lamp.candidateId]);
    assert.ok(lamp.position);
    // Fixture height is measured, not inherited: ~6 m above the base fit.
    const lampFit = lamp.fit as { pointEnu?: Vec3 };
    const poleFit = pole.fit as { pointEnu?: Vec3 };
    assert.ok(lampFit.pointEnu && poleFit.pointEnu);
    assert.ok(Math.abs(lampFit.pointEnu[2] - poleFit.pointEnu[2] - 6) < 0.5);
    assert.ok(output.unlocated.some((entry) => entry.observationId === "o-far" && entry.reason === "single-view"));
  });

  it("gates cross-sequence pairs on components, dates, and windows", () => {
    obsCounter = 0;
    const observations = [
      observation("img-1", "pole", C1, POLE_A, { observationId: "o-a1" }),
      observation("img-2", "pole", C2, POLE_A, { observationId: "o-a2" }),
      observation("img-x", "pole", C3, POLE_A, { observationId: "o-ax" }),
    ];
    const run = (meta: Array<{ imageId: string; sequenceId: string; mergeCc?: number | null; capturedAt?: number | null }>) =>
      associateObservations({
        plan: plan(meta),
        observations,
        views: [view("img-1", C1), view("img-2", C2), view("img-x", C3)],
        streets: null,
      });
    const sameComponent = run([
      { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
      { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
      { imageId: "img-x", sequenceId: "seq-b", mergeCc: 1, capturedAt: 3000 },
    ]);
    assert.equal(sameComponent.candidates.filter((candidate) => candidate.status === "located").length, 1);
    assert.ok(sameComponent.candidates[0].checks.includes("cross-sequence"));

    const splitComponent = run([
      { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
      { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
      { imageId: "img-x", sequenceId: "seq-b", mergeCc: 2, capturedAt: 3000 },
    ]);
    // img-x cannot join: the remaining pair stays a two-view hypothesis.
    assert.equal(splitComponent.candidates.filter((candidate) => candidate.status === "located").length, 0);
    assert.ok(splitComponent.unlocated.some((entry) => entry.observationId === "o-ax"));

    const staleDate = run([
      { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
      { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
      { imageId: "img-x", sequenceId: "seq-b", mergeCc: 1, capturedAt: 1000 + 31 * 86400000 },
    ]);
    assert.equal(staleDate.candidates.filter((candidate) => candidate.status === "located").length, 0);
  });

  it("reports rayless observations as no-ray with their stored failure", () => {
    obsCounter = 0;
    const rayless = observation("img-1", "pole", C1, POLE_A, {
      observationId: "o-dark",
      ray: null,
      rayFailure: "no-pose",
    });
    const output = associateObservations({
      plan: plan([{ imageId: "img-1", sequenceId: "seq-a" }]),
      observations: [rayless],
      views: [],
      streets: null,
    });
    assert.deepEqual(output.unlocated, [{ observationId: "o-dark", reason: "no-ray" }]);
  });

  it("leaves street assignment empty when streets are ambiguous or missing", () => {
    obsCounter = 0;
    const observations = [
      observation("img-1", "pole", C1, POLE_A, { observationId: "o-a1" }),
      observation("img-2", "pole", C2, POLE_A, { observationId: "o-a2" }),
      observation("img-3", "pole", C3, POLE_A, { observationId: "o-a3" }),
    ];
    const meta = [
      { imageId: "img-1", sequenceId: "seq-a", mergeCc: 1, capturedAt: 1000 },
      { imageId: "img-2", sequenceId: "seq-a", mergeCc: 1, capturedAt: 2000 },
      { imageId: "img-3", sequenceId: "seq-a", mergeCc: 1, capturedAt: 3000 },
    ];
    const views = [view("img-1", C1), view("img-2", C2), view("img-3", C3)];
    const ambiguous = associateObservations({
      plan: plan(meta),
      observations,
      views,
      streets: [streetAt(13, "street-near"), streetAt(17, "street-near-2")],
    });
    assert.equal(ambiguous.candidates[0].status, "located");
    assert.equal(ambiguous.candidates[0].streetId, null);
    const missing = associateObservations({ plan: plan(meta), observations, views, streets: null });
    assert.equal(missing.candidates[0].streetId, null);
    // Sanity: the test anchor math places the pole between the two streets.
    assert.ok(llaToEnu(19.0, 47.0, 0, ANCHOR)[0] === 0);
  });
});
