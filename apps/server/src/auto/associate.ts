import { createHash } from "node:crypto";
import {
  axisAngleToMatrix,
  checkTriangulationFit,
  closestRayPoints,
  enuToLla,
  estimateUncertaintyM,
  focalPixels,
  llaToEnu,
  PANO_ASPECT_TOLERANCE,
  projectWorldToPixel,
  triangulateRays,
  type CameraDescriptor,
  type CameraPose,
  type Triangulation,
  type Vec3,
} from "@openstreetlightmapper/geo";
import type { AutoObservationDocument } from "../db/autoModels.js";
import {
  validateAutoCandidate,
  type ValidatedAutoCandidate,
  type ValidatedAutoViewDescriptor,
} from "../db/autoValidation.js";
import type { ResolvedAutoPlan } from "./plan.js";

/**
 * Conservative multi-view association: within-image dedup, windowed
 * correspondence, whole-cluster refit with reprojection and assignment
 * checks, support linking, street assignment, and the 10 m proximity
 * check. Pure and deterministic: same inputs, same candidates.
 */

export const ASSOCIATION_VERSION = 1;
/** Spec engineering values (Â§6): baseline, parallax, range, sensitivity. */
export const ASSOC_MIN_BASELINE_M = 2;
export const ASSOC_MIN_PARALLAX_DEG = 5;
export const ASSOC_MAX_RANGE_M = 80;
export const ASSOC_MAX_SENSITIVITY_M = 3;
/** Reprojection gate as a fraction of the view diagonal. */
export const ASSOC_REPROJ_DIAGONAL_FRACTION = 0.01;
/** Best assignment must beat the runner-up by this margin. */
export const ASSOC_ASSIGNMENT_MARGIN = 1.5;
/** Within-image duplicate overlap (same category). */
export const ASSOC_DEDUP_IOU = 0.5;
/** Duplicate anchors must also agree within this fraction of the view diagonal. */
export const ASSOC_DEDUP_ANCHOR_FRACTION = 0.02;
/** Same-sequence correspondence window in images (each side). */
export const ASSOC_IMAGE_WINDOW = 5;
/** Cross-sequence origin prefilter and temporal bound. */
export const ASSOC_CROSS_ORIGIN_M = 200;
export const ASSOC_CROSS_SEQUENCE_MAX_DAYS = 30;
/** Street assignment: nearest within range and unambiguous by ratio. */
export const ASSOC_STREET_ASSIGN_M = 25;
export const ASSOC_STREET_ASSIGN_RATIO = 2;
/** Support link: shared vertical axis within these bounds. */
export const ASSOC_LINK_HORIZONTAL_M = 2;
export const ASSOC_LINK_VERTICAL_MIN_M = 1;
export const ASSOC_LINK_VERTICAL_MAX_M = 15;
export const ASSOC_LINK_AMBIGUITY_M = 0.5;
/** Close-spacing anomaly check (flag, never merge). */
export const ASSOC_PROXIMITY_M = 10;
/** Assumed pose and alignment error folded into reported uncertainty. */
export const ASSOC_POSE_ERROR_M = 0.5;
export const ASSOC_ALIGNMENT_M = 0.5;

export interface StreetLine {
  id: string;
  displayName: string;
  lines: Array<Array<[number, number]>>;
}

export interface AssociationView {
  imageId: string;
  descriptor: ValidatedAutoViewDescriptor;
}

export interface AssociateInput {
  plan: ResolvedAutoPlan;
  observations: AutoObservationDocument[];
  views: AssociationView[];
  streets: StreetLine[] | null;
}

export interface UnlocatedObservation {
  observationId: string;
  reason: string;
}

export interface AssociateOutput {
  candidates: ValidatedAutoCandidate[];
  unlocated: UnlocatedObservation[];
  duplicateGroupCount: number;
}

interface PreparedView {
  camera: CameraDescriptor;
  pose: CameraPose;
  diagonalPx: number;
  focalPx: number;
}

interface PairLink {
  a: string;
  b: string;
  flags: string[];
  crossSequence: boolean;
  triangulation: Triangulation;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function candidateIdFor(kind: string, observationIds: string[]): string {
  const hash = createHash("sha256").update([...observationIds].sort().join(","), "utf8").digest("hex");
  return `ca-${kind}-${hash.slice(0, 12)}`;
}

function boxIoU(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function preparedView(descriptor: ValidatedAutoViewDescriptor): PreparedView | null {
  if (!descriptor.camera || !descriptor.pose) return null;
  const { cameraType, cameraParameters } = descriptor.camera;
  let camera: CameraDescriptor;
  if (cameraType === "equirectangular" || cameraType === "spherical") {
    if (Math.abs(descriptor.width / descriptor.height - 2) > PANO_ASPECT_TOLERANCE) return null;
    camera = { kind: "equirectangular", width: descriptor.width, height: descriptor.height };
  } else if (cameraType === "perspective" && Array.isArray(cameraParameters)) {
    const [focal, k1, k2] = cameraParameters as unknown[];
    if (
      typeof focal !== "number" ||
      typeof k1 !== "number" ||
      typeof k2 !== "number" ||
      !Number.isFinite(focal) ||
      !Number.isFinite(k1) ||
      !Number.isFinite(k2)
    ) {
      return null;
    }
    camera = { kind: "perspective", width: descriptor.width, height: descriptor.height, focal, k1, k2 };
  } else {
    return null;
  }
  const rotationWc = axisAngleToMatrix(descriptor.pose.rotationWcAxisAngle);
  if (!rotationWc) return null;
  return {
    camera,
    pose: { centerEnu: [...descriptor.pose.centerEnu], rotationWc },
    diagonalPx: Math.hypot(descriptor.width, descriptor.height),
    focalPx: focalPixels(camera),
  };
}

function pointSegmentDistanceM(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function associateObservations(input: AssociateInput): AssociateOutput {
  const anchor = input.plan.anchor;
  const metaByImage = new Map(input.plan.images.map((meta) => [meta.imageId, meta]));
  const views = new Map<string, PreparedView>();
  for (const view of input.views) {
    const prepared = preparedView(view.descriptor);
    if (prepared) views.set(view.imageId, prepared);
  }
  const sorted = [...input.observations].sort((a, b) =>
    a.observationId < b.observationId ? -1 : 1,
  );

  const anchorOf = (doc: AutoObservationDocument): { u: number; v: number } => ({
    u: (doc.anchor as { uPx?: unknown }).uPx as number,
    v: (doc.anchor as { vPx?: unknown }).vPx as number,
  });

  // Within-image dedup first: same image and category, largest box wins.
  const merged = new Set<string>();
  const byImageCategory = new Map<string, AutoObservationDocument[]>();
  for (const doc of sorted) {
    const key = JSON.stringify([doc.imageId, doc.category]);
    const group = byImageCategory.get(key) ?? [];
    group.push(doc);
    byImageCategory.set(key, group);
  }
  for (const group of byImageCategory.values()) {
    group.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h || (a.observationId < b.observationId ? -1 : 1));
    const diagonal = Math.hypot(
      views.get(group[0].imageId)?.camera.width ?? 0,
      views.get(group[0].imageId)?.camera.height ?? 0,
    );
    const anchorGate = diagonal > 0 ? diagonal * ASSOC_DEDUP_ANCHOR_FRACTION : Number.MAX_VALUE;
    const kept: AutoObservationDocument[] = [];
    for (const doc of group) {
      // Overlap alone must not collapse two distinct shafts with large
      // boxes: their anchors must also agree.
      const duplicate = kept.some((other) => {
        if (boxIoU(doc.box, other.box) <= ASSOC_DEDUP_IOU) return false;
        const anchor = anchorOf(doc);
        const rival = anchorOf(other);
        return Math.hypot(anchor.u - rival.u, anchor.v - rival.v) <= anchorGate;
      });
      if (duplicate) {
        merged.add(doc.observationId);
      } else {
        kept.push(doc);
      }
    }
  }
  const kept = sorted.filter((doc) => !merged.has(doc.observationId));
  const keptById = new Map(kept.map((doc) => [doc.observationId, doc]));
  const candidates: ValidatedAutoCandidate[] = [];
  const unlocated: UnlocatedObservation[] = [];
  const unlocatedIds = new Set<string>();
  const fittedPoint = new Map<string, Vec3>();
  const markUnlocated = (observationId: string, reason: string): void => {
    if (unlocatedIds.has(observationId)) return;
    unlocatedIds.add(observationId);
    unlocated.push({ observationId, reason });
  };
  const keptInView = new Map<string, AutoObservationDocument[]>();
  for (const doc of kept) {
    const group = keptInView.get(doc.imageId) ?? [];
    group.push(doc);
    keptInView.set(doc.imageId, group);
  }
  // Image order per sequence for the correspondence window.
  const imageOrder = new Map<string, number>();
  const imagesBySequence = new Map<string, string[]>();
  for (const meta of input.plan.images) {
    const group = imagesBySequence.get(meta.sequenceId) ?? [];
    group.push(meta.imageId);
    imagesBySequence.set(meta.sequenceId, group);
  }
  for (const group of imagesBySequence.values()) {
    group.sort((a, b) => {
      const ma = metaByImage.get(a);
      const mb = metaByImage.get(b);
      const ta = ma?.capturedAt ?? Number.MAX_SAFE_INTEGER;
      const tb = mb?.capturedAt ?? Number.MAX_SAFE_INTEGER;
      return ta - tb || (a < b ? -1 : 1);
    });
    group.forEach((imageId, index) => imageOrder.set(imageId, index));
  }
  const sequenceOf = (imageId: string): string | null =>
    metaByImage.get(imageId)?.sequenceId ?? null;

  const rayOf = (doc: AutoObservationDocument): { origin: Vec3; direction: Vec3 } | null =>
    doc.ray ? { origin: [...doc.ray.origin], direction: [...doc.ray.direction] } : null;

  // Pair gates: geometry first, then component/temporal context.
  const pairOf = new Map<string, PairLink>();
  const pairKey = (a: string, b: string): string => JSON.stringify(a < b ? [a, b] : [b, a]);
  const withRay = kept.filter((doc) => doc.ray);
  const byCategory = new Map<string, AutoObservationDocument[]>();
  for (const doc of withRay) {
    const group = byCategory.get(doc.category) ?? [];
    group.push(doc);
    byCategory.set(doc.category, group);
  }
  for (const group of byCategory.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a.imageId === b.imageId) continue;
        const seqA = sequenceOf(a.imageId);
        const seqB = sequenceOf(b.imageId);
        if (seqA === null || seqB === null) continue;
        const crossSequence = seqA !== seqB;
        if (!crossSequence) {
          const orderA = imageOrder.get(a.imageId) ?? 0;
          const orderB = imageOrder.get(b.imageId) ?? 0;
          if (Math.abs(orderA - orderB) > ASSOC_IMAGE_WINDOW) continue;
        }
        const rayA = rayOf(a);
        const rayB = rayOf(b);
        if (!rayA || !rayB) continue;
        if (crossSequence) {
          const originGap = Math.hypot(
            rayA.origin[0] - rayB.origin[0],
            rayA.origin[1] - rayB.origin[1],
            rayA.origin[2] - rayB.origin[2],
          );
          if (originGap > ASSOC_CROSS_ORIGIN_M) continue;
          const metaA = metaByImage.get(a.imageId);
          const metaB = metaByImage.get(b.imageId);
          if (metaA?.mergeCc == null || metaA.mergeCc !== metaB?.mergeCc) continue;
          if (metaA.capturedAt != null && metaB?.capturedAt != null) {
            const days = Math.abs(metaA.capturedAt - metaB.capturedAt) / 86400000;
            if (days > ASSOC_CROSS_SEQUENCE_MAX_DAYS) continue;
          }
        }
        const closest = closestRayPoints(rayA.origin, rayA.direction, rayB.origin, rayB.direction);
        if (!closest || !(closest.gapM <= 1.0)) continue;
        const solution = triangulateRays([rayA, rayB]);
        if (!solution) continue;
        const parallax = solution.pairParallaxDeg[0] ?? 0;
        const baseline = solution.pairBaselinesM[0] ?? 0;
        if (!(parallax >= ASSOC_MIN_PARALLAX_DEG)) continue;
        if (!(baseline >= ASSOC_MIN_BASELINE_M)) continue;
        if (solution.depthsM.some((depth) => !(depth >= 0.5) || !(depth <= ASSOC_MAX_RANGE_M))) continue;
        const flags: string[] = [];
        if (crossSequence) {
          flags.push("cross-sequence");
          const metaA = metaByImage.get(a.imageId);
          const metaB = metaByImage.get(b.imageId);
          if (metaA?.capturedAt == null || metaB?.capturedAt == null) {
            flags.push("unknown-date");
          } else {
            const dayA = Math.floor(metaA.capturedAt / 86400000);
            const dayB = Math.floor(metaB.capturedAt / 86400000);
            if (dayA !== dayB) flags.push("multi-date");
          }
        }
        pairOf.set(pairKey(a.observationId, b.observationId), {
          a: a.observationId,
          b: b.observationId,
          flags,
          crossSequence,
          triangulation: solution,
        });
      }
    }
  }

  // Greedy growth: lowest-gap pairs seed clusters; members join only while
  // the whole cluster stays valid. One false pair can no longer merge two
  // true clusters the way union-find would.
  const pairGap = (pair: PairLink): number => pair.triangulation.pairGapsM[0] ?? 0;
  const pairList = [...pairOf.values()].sort(
    (p, q) => pairGap(p) - pairGap(q) || (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : 1),
  );
  const partners = new Map<string, Array<{ id: string; gap: number }>>();
  for (const pair of pairList) {
    for (const [from, to] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ]) {
      const list = partners.get(from) ?? [];
      list.push({ id: to, gap: pairGap(pair) });
      partners.set(from, list);
    }
  }
  for (const list of partners.values()) {
    list.sort((x, y) => x.gap - y.gap || (x.id < y.id ? -1 : 1));
  }
  const consumed = new Set<string>();

  interface ClusterFit {
    ok: boolean;
    reason?: string;
    solution?: Triangulation;
    reprojection?: Array<{ imageId: string; observationId: string; errorPx: number; errorFraction: number }>;
    uncertaintyM?: number;
    geometricM?: number;
  }

  const fitCluster = (memberIds: string[]): ClusterFit => {
    const members = memberIds.map((id) => keptById.get(id)).filter((doc): doc is AutoObservationDocument => Boolean(doc));
    const imageIds = new Set(members.map((doc) => doc.imageId));
    if (imageIds.size !== members.length) return { ok: false, reason: "multi-obs-image" };
    for (const doc of members) {
      if (!views.has(doc.imageId)) return { ok: false, reason: "view-missing" };
    }
    const rays = members.map((doc) => rayOf(doc)).filter((ray): ray is { origin: Vec3; direction: Vec3 } => Boolean(ray));
    if (rays.length !== members.length) return { ok: false, reason: "degenerate" };
    const solution = triangulateRays(rays);
    if (!solution) return { ok: false, reason: "degenerate" };
    const reprojection: ClusterFit["reprojection"] = [];
    for (const doc of members) {
      const view = views.get(doc.imageId);
      if (!view) return { ok: false, reason: "view-missing" };
      const projected = projectWorldToPixel(solution.point, view.pose, view.camera);
      if (!projected.ok) return { ok: false, reason: "reprojection" };
      const { u, v } = anchorOf(doc);
      const errorPx = Math.hypot(projected.px - u, projected.py - v);
      reprojection.push({
        imageId: doc.imageId,
        observationId: doc.observationId,
        errorPx: round3(errorPx),
        errorFraction: round4(errorPx / view.diagonalPx),
      });
    }
    const fit = checkTriangulationFit(
      {
        viewCount: imageIds.size,
        solution,
        reprojectionPx: reprojection.map((entry) => entry.errorFraction),
      },
      {
        minViews: imageIds.size >= 3 ? 3 : 2,
        minParallaxDeg: ASSOC_MIN_PARALLAX_DEG,
        maxRayGapM: 1.0,
        minDepthM: 0.5,
        maxDepthM: ASSOC_MAX_RANGE_M,
        maxReprojection: ASSOC_REPROJ_DIAGONAL_FRACTION,
        reprojectionUnit: "Ã—diagonal",
        minBaselineM: ASSOC_MIN_BASELINE_M,
      },
    );
    if (!fit.ok) {
      const reason = fit.reasons[0] ?? "fit-rejected";
      if (reason.startsWith("depth ")) return { ok: false, reason: "depth" };
      if (reason.startsWith("ray gap")) return { ok: false, reason: "gap" };
      if (reason.startsWith("parallax")) return { ok: false, reason: "parallax" };
      if (reason.startsWith("baseline")) return { ok: false, reason: "baseline" };
      if (reason.startsWith("reprojection")) return { ok: false, reason: "reprojection" };
      return { ok: false, reason: "fit-rejected" };
    }
    // Best assignment: the supporting observation must clearly win its view.
    for (const doc of members) {
      const view = views.get(doc.imageId);
      if (!view) return { ok: false, reason: "view-missing" };
      const projected = projectWorldToPixel(solution.point, view.pose, view.camera);
      if (!projected.ok) return { ok: false, reason: "reprojection" };
      const { u, v } = anchorOf(doc);
      const own = Math.hypot(projected.px - u, projected.py - v);
      for (const other of keptInView.get(doc.imageId) ?? []) {
        if (other.observationId === doc.observationId || other.category !== doc.category) continue;
        const anchor = anchorOf(other);
        const rival = Math.hypot(projected.px - anchor.u, projected.py - anchor.v);
        if (rival < own * ASSOC_ASSIGNMENT_MARGIN) return { ok: false, reason: "assignment" };
      }
    }
    const depths = solution.depthsM;
    const meanDepth = depths.reduce((sum, depth) => sum + depth, 0) / depths.length;
    const focalPx = Math.min(...members.map((doc) => views.get(doc.imageId)?.focalPx ?? Number.MAX_VALUE));
    const pixelErrPx = Math.max(...reprojection.map((entry) => entry.errorPx));
    const geometricM = estimateUncertaintyM({
      depthM: meanDepth,
      parallaxDeg: Math.min(...solution.pairParallaxDeg),
      focalPx: Number.isFinite(focalPx) ? focalPx : 1,
      pixelErrPx,
      rayGapM: Math.max(...solution.pairGapsM),
    });
    return {
      ok: true,
      solution,
      reprojection,
      geometricM: round3(geometricM),
      uncertaintyM: round3(geometricM + ASSOC_POSE_ERROR_M + ASSOC_ALIGNMENT_M),
    };
  };

  const emitNeedsReviewPair = (aId: string, bId: string): void => {
    const pair = pairOf.get(pairKey(aId, bId));
    if (!pair) return;
    const a = keptById.get(aId);
    const b = keptById.get(bId);
    if (!a || !b) return;
    const fit = fitCluster([aId, bId]);
    const checks = [...new Set(pair.flags)].sort();
    const seedId = candidateIdFor(a.category === "pole" ? "pole" : "lum", [aId, bId]);
    if (fit.solution) fittedPoint.set(seedId, [...fit.solution.point]);
    candidates.push(
      validateAutoCandidate({
        candidateId: seedId,
        kind: a.category === "pole" ? "pole" : "luminaire",
        status: "needs-review",
        observationIds: [aId, bId].sort(),
        imageIds: [a.imageId, b.imageId].sort(),
        viewCount: 2,
        position: null,
        fit: {
          associationVersion: ASSOCIATION_VERSION,
          method: "two-view-seed",
          pairGapM: round3(pair.triangulation.pairGapsM[0] ?? 0),
          pairParallaxDeg: round3(pair.triangulation.pairParallaxDeg[0] ?? 0),
          pairBaselineM: round3(pair.triangulation.pairBaselinesM[0] ?? 0),
          depthsM: pair.triangulation.depthsM.map(round3),
          reprojection: (fit.reprojection ?? []).map((entry) => ({ ...entry })),
          uncertaintyM: fit.uncertaintyM ?? null,
          unresolvedPointEnu: fit.solution ? fit.solution.point.map(round3) : null,
          unresolvedReason: "two-views",
        },
        poleCandidateId: null,
        luminaireCandidateIds: [],
        checks,
      }),
    );
  };

  const emitCluster = (sortedMembers: string[]): void => {
    const fit = fitCluster(sortedMembers);
    if (!fit.ok || !fit.solution || !fit.reprojection || fit.uncertaintyM === undefined) return;
    const first = keptById.get(sortedMembers[0]);
    if (!first) return;
    const imageIds = [...new Set(sortedMembers.map((id) => keptById.get(id)?.imageId ?? ""))].sort();
    const pairFlags = new Set<string>();
    for (let i = 0; i < sortedMembers.length; i += 1) {
      for (let j = i + 1; j < sortedMembers.length; j += 1) {
        const pair = pairOf.get(pairKey(sortedMembers[i], sortedMembers[j]));
        if (pair) for (const flag of pair.flags) pairFlags.add(flag);
      }
    }
    const located = fit.uncertaintyM <= ASSOC_MAX_SENSITIVITY_M;
    const depths = fit.solution.depthsM;
    const meanDepth = depths.reduce((sum, depth) => sum + depth, 0) / depths.length;
    const fitRecord: Record<string, unknown> = {
      associationVersion: ASSOCIATION_VERSION,
      method: `triangulation-${imageIds.length}view`,
      uncertaintyM: fit.uncertaintyM,
      geometricM: fit.geometricM,
      poseAssumedM: ASSOC_POSE_ERROR_M,
      alignmentAssumedM: ASSOC_ALIGNMENT_M,
      pixelErrPxMax: Math.max(...fit.reprojection.map((entry) => entry.errorPx)),
      minParallaxDeg: round3(Math.min(...fit.solution.pairParallaxDeg)),
      maxRayGapM: round3(Math.max(...fit.solution.pairGapsM)),
      meanDepthM: round3(meanDepth),
      minBaselineM: round3(Math.min(...fit.solution.pairBaselinesM)),
      reprojection: fit.reprojection.map((entry) => ({ ...entry })),
      pointEnu: fit.solution.point.map(round3),
    };
    let position: ValidatedAutoCandidate["position"] = null;
    if (!located) {
      fitRecord.unresolvedReason = "uncertainty";
    } else {
      const [lng, lat] = enuToLla(fit.solution.point[0], fit.solution.point[1], fit.solution.point[2], anchor);
      position = {
        lng,
        lat,
        uncertaintyM: fit.uncertaintyM,
        method: `triangulation-${imageIds.length}view`,
      };
    }
    const clusterId = candidateIdFor(first.category === "pole" ? "pole" : "lum", sortedMembers);
    fittedPoint.set(clusterId, [...fit.solution.point]);
    candidates.push(
      validateAutoCandidate({
        candidateId: clusterId,
        kind: first.category === "pole" ? "pole" : "luminaire",
        status: located ? "located" : "needs-review",
        observationIds: sortedMembers,
        imageIds,
        viewCount: imageIds.length,
        position,
        fit: fitRecord,
        poleCandidateId: null,
        luminaireCandidateIds: [],
        checks: [...pairFlags].sort(),
      }),
    );
    for (const id of sortedMembers) consumed.add(id);
  };

  for (const seed of pairList) {
    if (consumed.has(seed.a) || consumed.has(seed.b)) continue;
    // An ambiguous seed stays free: its members may still seed elsewhere.
    if (!fitCluster([seed.a, seed.b]).ok) continue;
    const members = [seed.a, seed.b];
    const tried = new Set<string>(members);
    let grew = true;
    while (grew) {
      grew = false;
      const candidatesByGap = new Map<string, number>();
      for (const member of members) {
        for (const partner of partners.get(member) ?? []) {
          if (consumed.has(partner.id) || tried.has(partner.id)) continue;
          const best = candidatesByGap.get(partner.id);
          if (best === undefined || partner.gap < best) candidatesByGap.set(partner.id, partner.gap);
        }
      }
      const ordered = [...candidatesByGap.entries()].sort(
        (x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1),
      );
      for (const [id] of ordered) {
        tried.add(id);
        if (consumed.has(id)) continue;
        if (fitCluster([...members, id]).ok) {
          members.push(id);
          grew = true;
        }
      }
    }
    members.sort();
    for (const id of members) consumed.add(id);
    if (members.length === 2) {
      emitNeedsReviewPair(members[0], members[1]);
    } else {
      emitCluster(members);
    }
  }

  for (const doc of withRay) {
    if (!consumed.has(doc.observationId)) {
      markUnlocated(doc.observationId, "single-view");
    }
  }

  // Street assignment for located candidates (nearest unambiguous line).
  const streetEnu =
    input.streets?.map((street) => ({
      id: street.id,
      segments: street.lines.flatMap((line) => {
        const points = line.map(([lng, lat]) => llaToEnu(lng, lat, anchor.altM, anchor));
        const segments: Array<[[number, number], [number, number]]> = [];
        for (let i = 0; i + 1 < points.length; i += 1) {
          segments.push([
            [points[i][0], points[i][1]],
            [points[i + 1][0], points[i + 1][1]],
          ]);
        }
        return segments;
      }),
    })) ?? null;
  const assignStreet = (lng: number, lat: number): string | null => {
    if (!streetEnu || streetEnu.length === 0) return null;
    const [e, n] = llaToEnu(lng, lat, anchor.altM, anchor);
    const distances = streetEnu.map((street) => ({
      id: street.id,
      distance: Math.min(
        ...street.segments.map(([a, b]) => pointSegmentDistanceM(e, n, a[0], a[1], b[0], b[1])),
        Number.MAX_VALUE,
      ),
    }));
    distances.sort((a, b) => a.distance - b.distance);
    const [nearest, second] = distances;
    if (!nearest || !(nearest.distance <= ASSOC_STREET_ASSIGN_M)) return null;
    if (second && !(second.distance > nearest.distance * ASSOC_STREET_ASSIGN_RATIO)) return null;
    return nearest.id;
  };
  for (const candidate of candidates) {
    if (candidate.status === "located" && candidate.position) {
      candidate.streetId = assignStreet(candidate.position.lng, candidate.position.lat);
    }
  }

  // Luminaire to pole support links (shared views plus axis agreement).
  const poles = candidates.filter((candidate) => candidate.kind === "pole");
  const luminaires = candidates.filter((candidate) => candidate.kind === "luminaire");
  for (const lum of luminaires) {
    const lumImages = new Set(lum.imageIds);
    const eligible: Array<{ pole: ValidatedAutoCandidate; shared: number; horizontal: number | null }> = [];
    for (const pole of poles) {
      const shared = pole.imageIds.filter((imageId) => lumImages.has(imageId)).length;
      if (shared === 0) continue;
      const lumPoint = fittedPoint.get(lum.candidateId);
      const polePoint = fittedPoint.get(pole.candidateId);
      if (lumPoint && polePoint) {
        const horizontal = Math.hypot(lumPoint[0] - polePoint[0], lumPoint[1] - polePoint[1]);
        // Vertical uses fitted heights above the shared anchor altitude.
        const vertical = Math.abs(lumPoint[2] - polePoint[2]);
        if (horizontal > ASSOC_LINK_HORIZONTAL_M) continue;
        if (vertical < ASSOC_LINK_VERTICAL_MIN_M || vertical > ASSOC_LINK_VERTICAL_MAX_M) continue;
        eligible.push({ pole, shared, horizontal });
      } else {
        eligible.push({ pole, shared, horizontal: null });
      }
    }
    eligible.sort(
      (a, b) => b.shared - a.shared || (a.horizontal ?? 0) - (b.horizontal ?? 0) || (a.pole.candidateId < b.pole.candidateId ? -1 : 1),
    );
    const best = eligible[0];
    if (!best) continue;
    const runnerUp = eligible[1];
    const ambiguous =
      runnerUp &&
      runnerUp.shared >= best.shared &&
      (best.horizontal === null ||
        runnerUp.horizontal === null ||
        Math.abs(runnerUp.horizontal - best.horizontal) <= ASSOC_LINK_AMBIGUITY_M);
    if (ambiguous) {
      lum.checks.push("ambiguous-support");
      lum.checks.sort();
      continue;
    }
    lum.poleCandidateId = best.pole.candidateId;
    best.pole.luminaireCandidateIds.push(lum.candidateId);
    best.pole.luminaireCandidateIds.sort();
    if (best.shared === 1) {
      lum.checks.push("single-view-support");
      lum.checks.sort();
    }
  }

  // 10 m proximity check over fitted pole positions (flag, never merge).
  const locatedPoles = poles.filter((candidate) => candidate.status === "located" && candidate.position);
  const proximityEdges = new Map<string, Set<string>>();
  for (let i = 0; i < locatedPoles.length; i += 1) {
    for (let j = i + 1; j < locatedPoles.length; j += 1) {
      const a = locatedPoles[i];
      const b = locatedPoles[j];
      if (!a.position || !b.position) continue;
      const [ae, an] = llaToEnu(a.position.lng, a.position.lat, anchor.altM, anchor);
      const [be, bn] = llaToEnu(b.position.lng, b.position.lat, anchor.altM, anchor);
      if (Math.hypot(ae - be, an - bn) >= ASSOC_PROXIMITY_M) continue;
      const sameStreet = a.streetId !== null && a.streetId === b.streetId;
      const check = sameStreet ? "possible-duplicate" : "unclassified-proximity";
      for (const candidate of [a, b]) {
        if (!candidate.checks.includes(check)) candidate.checks.push(check);
        candidate.checks.sort();
      }
      const setA = proximityEdges.get(a.candidateId) ?? new Set<string>();
      setA.add(b.candidateId);
      proximityEdges.set(a.candidateId, setA);
      const setB = proximityEdges.get(b.candidateId) ?? new Set<string>();
      setB.add(a.candidateId);
      proximityEdges.set(b.candidateId, setB);
    }
  }
  let duplicateGroupCount = 0;
  const visited = new Set<string>();
  for (const id of proximityEdges.keys()) {
    if (visited.has(id)) continue;
    duplicateGroupCount += 1;
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      for (const next of proximityEdges.get(current) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
  }

  // Unlocated outcomes for everything not consumed by a candidate.
  const memberOf = new Set<string>();
  for (const candidate of candidates) {
    for (const id of candidate.observationIds) memberOf.add(id);
  }
  for (const doc of kept) {
    if (memberOf.has(doc.observationId)) continue;
    markUnlocated(doc.observationId, doc.ray ? "single-view" : "no-ray");
  }
  for (const doc of sorted) {
    if (merged.has(doc.observationId)) {
      markUnlocated(doc.observationId, "duplicate-in-image");
    }
  }
  unlocated.sort((a, b) => (a.observationId < b.observationId ? -1 : 1));
  candidates.sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1));
  return { candidates, unlocated, duplicateGroupCount };
}