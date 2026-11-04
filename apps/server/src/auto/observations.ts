import {
  axisAngleToMatrix,
  cameraRayToWorld,
  focalPixels,
  PANO_ASPECT_TOLERANCE,
  pixelToCameraRay,
  poleBaseAnchorFromBox,
  type CameraDescriptor,
} from "@openstreetlightmapper/geo";
import {
  validateAutoObservation,
  type ValidatedAutoObservation,
  type ValidatedAutoViewDescriptor,
} from "../db/autoValidation.js";
import type { SamMask, SamObject } from "../sam.js";

/**
 * Pure SAM-object to observation mapping. Anchors follow documented v1
 * heuristics (pole ground-contact estimate, luminaire box centre); rays
 * need a usable camera and pose, otherwise a stable rayFailure reason.
 * Invalid objects are counted and skipped, never silently positioned.
 */

export interface ObservationBuildInput {
  itemId: string;
  attempts: number;
  category: "pole" | "luminaire";
  descriptor: ValidatedAutoViewDescriptor;
  objects: SamObject[];
  /** Stored mask artifact per provider object id (null when unmasked). */
  maskArtifactIds: Map<string, string | null>;
}

export interface ObservationBuildOutput {
  observations: ValidatedAutoObservation[];
  invalidDiscarded: number;
}

const EDGE_EPS = 1e-3;
const SEAM_FRACTION = 0.02;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function cameraDescriptorFor(view: ValidatedAutoViewDescriptor): CameraDescriptor | null {
  if (!view.camera) return null;
  const { cameraType, cameraParameters } = view.camera;
  if (cameraType === "equirectangular" || cameraType === "spherical") {
    if (Math.abs(view.width / view.height - 2) > PANO_ASPECT_TOLERANCE) return null;
    return { kind: "equirectangular", width: view.width, height: view.height };
  }
  if (cameraType !== "perspective" || !Array.isArray(cameraParameters)) return null;
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
  return { kind: "perspective", width: view.width, height: view.height, focal, k1, k2 };
}

function maskSupportFor(
  mask: SamMask | null,
  viewW: number,
  viewH: number,
): Record<string, unknown> | null {
  if (!mask) return null;
  const bounds = mask.bounds;
  const usable =
    typeof mask.svgPath === "string" &&
    mask.svgPath.length > 0 &&
    mask.width > 0 &&
    mask.height > 0 &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top &&
    bounds.left >= 0 &&
    bounds.top >= 0 &&
    bounds.right <= viewW &&
    bounds.bottom <= viewH;
  return {
    usable,
    ...(usable ? {} : { reason: "degenerate or out-of-view mask bounds" }),
    bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    rasterWidth: mask.width,
    rasterHeight: mask.height,
  };
}

function rayFailureFor(reason: string): string {
  if (reason.includes("panorama pole")) return "pano-pole";
  if (reason.includes("undistortion")) return "undistortion-diverged";
  return "degenerate-ray";
}

export function buildAutoObservations(input: ObservationBuildInput): ObservationBuildOutput {
  const viewW = input.descriptor.width;
  const viewH = input.descriptor.height;
  const camera = cameraDescriptorFor(input.descriptor);
  const pose = input.descriptor.pose;
  const rotationWc = pose ? axisAngleToMatrix(pose.rotationWcAxisAngle) : null;
  const focalPx = camera ? focalPixels(camera) : 0;
  const observations: ValidatedAutoObservation[] = [];
  let invalidDiscarded = 0;

  input.objects.forEach((object, index) => {
    try {
      const box = object.boxNorm;
      const anchorPx =
        input.category === "pole"
          ? poleBaseAnchorFromBox(box, viewW, viewH, focalPx)
          : {
              x: Math.min(Math.max((box.x + box.w / 2) * viewW, 0), viewW - 1),
              y: Math.min(Math.max((box.y + box.h / 2) * viewH, 0), viewH - 1),
              clamped:
                (box.x + box.w / 2) * viewW < 0 ||
                (box.x + box.w / 2) * viewW > viewW - 1 ||
                (box.y + box.h / 2) * viewH < 0 ||
                (box.y + box.h / 2) * viewH > viewH - 1,
            };
      const uPx = round2(anchorPx.x);
      const vPx = round2(anchorPx.y);
      const marginPx = round2(Math.min(uPx, vPx, viewW - 1 - uPx, viewH - 1 - vPx));
      const anchor =
        input.category === "pole"
          ? {
              method: "pole-base-margin",
              uPx,
              vPx,
              marginPx,
              clamped: anchorPx.clamped,
              bottomClipped: box.y + box.h >= 1 - EDGE_EPS,
              focalPx: round2(focalPx),
            }
          : {
              method: "box-center",
              uPx,
              vPx,
              marginPx,
              clamped: anchorPx.clamped,
              bottomClipped: false,
              focalPx: round2(focalPx),
            };
      let ray: ValidatedAutoObservation["ray"] = null;
      let rayFailure: string | null = null;
      if (!camera) {
        rayFailure = "unknown-camera";
      } else if (!pose) {
        rayFailure = "no-pose";
      } else if (!rotationWc) {
        rayFailure = "bad-rotation";
      } else {
        const cameraRay = pixelToCameraRay(uPx, vPx, camera);
        if (!cameraRay.ok) {
          rayFailure = rayFailureFor(cameraRay.reason);
        } else {
          try {
            const direction = cameraRayToWorld(cameraRay.ray, {
              centerEnu: pose.centerEnu,
              rotationWc,
            });
            ray = {
              origin: [...pose.centerEnu],
              // Full precision: rounded directions would eat the ray-gap budget.
              direction: [direction[0], direction[1], direction[2]],
            };
          } catch {
            rayFailure = "degenerate-ray";
          }
        }
      }
      const nearSeam =
        camera?.kind === "equirectangular" &&
        (uPx <= SEAM_FRACTION * viewW || uPx >= (1 - SEAM_FRACTION) * viewW);
      const truncated =
        box.x <= EDGE_EPS || box.y <= EDGE_EPS || box.x + box.w >= 1 - EDGE_EPS || box.y + box.h >= 1 - EDGE_EPS;
      observations.push(
        validateAutoObservation({
          observationId: `${input.itemId}--a${input.attempts}--o${index}`,
          box: { x: box.x, y: box.y, w: box.w, h: box.h },
          confidence: object.confidence,
          anchor,
          maskSupport: maskSupportFor(object.mask, viewW, viewH),
          maskArtifactId: input.maskArtifactIds.get(object.providerObjectId) ?? null,
          ray,
          rayFailure,
          nearSeam,
          truncated,
        }),
      );
    } catch {
      invalidDiscarded += 1;
    }
  });
  return { observations, invalidDiscarded };
}
