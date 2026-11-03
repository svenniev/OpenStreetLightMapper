import type { Bbox, RoiPolygon } from "@openstreetlightmapper/geo";
import type { CameraPosition } from "./types";

/** Leaflet-order [latitude, longitude] pair (never GeoJSON order). */
export type LatLngPair = [number, number];

export type RoiShape = "rectangle" | "polygon";

export interface CommittedRoi {
  /** Increments on every commit; part of the stale-response guard. */
  id: number;
  shape: RoiShape;
  polygon: RoiPolygon;
  areaSqM: number;
  bbox: Bbox;
  /** False when the region is visible but not searchable (too large, invalid). */
  valid: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export type DrawingTool = "rectangle" | "polygon" | null;

export interface DraftShape {
  tool: Exclude<DrawingTool, null>;
  /** Committed draft vertices in Leaflet [lat, lng] order. */
  vertices: LatLngPair[];
  /** Live cursor position for the preview shape. */
  cursor: LatLngPair | null;
}

/** Mirrors the server SearchResponse image contract. */
export interface ImageResult {
  id: string;
  coordinate: [number, number]; // longitude, latitude
  coordinateSource: "geometry" | "computed_geometry";
  originalCoordinate: [number, number] | null;
  computedCoordinate: [number, number] | null;
  capturedAt: number | null; // Unix milliseconds
  isPano: boolean | null;
  sequenceId: string | null;
}

export interface SearchQueryMeta {
  bbox: Bbox;
  requestedAt: string;
  retrievedAt: string;
  providerLimit: number;
  rawReturnedCount: number;
  matchedCount: number;
  invalidRecordCount: number;
  outsideRoiCount: number;
  duplicateCount: number;
  retrievalStatus: "not_capped" | "possibly_truncated";
}

export interface SearchResponse {
  images: ImageResult[];
  query: SearchQueryMeta;
  warnings: string[];
}

export type SearchStatus = "idle" | "loading" | "cancelled" | "failed" | "empty" | "results";

export interface SearchError {
  code: string;
  message: string;
  retryable: boolean;
}

/** A viewer load request: the token disambiguates rapid re-requests of one ID. */
export interface RequestedImage {
  id: string;
  token: number;
}

export interface ViewerActual {
  imageId: string | null;
  position: CameraPosition | null;
}

/** Re-exported for components that only need the camera type alongside search types. */
export type { CameraPosition };
