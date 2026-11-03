import {
  clipPolylineToRing,
  fragmentsLengthM,
  type Bbox,
  type LngLat,
} from "@openstreetlightmapper/geo";
import { TransportError, fetchJsonWithLimits } from "./providerHttp.js";

/**
 * Server-side OpenStreetMap street retrieval through Overpass.
 *
 * Candidate design: eligible highway ways inside the RoI bbox UNION eligible
 * ways within ~1 m of the closed RoI boundary polyline, then exact polygon
 * clipping. A bbox/node-only query would miss roads crossing the polygon with
 * both endpoints outside, so the boundary branch exists; the 1 m buffer only
 * retrieves candidates and never expands final inclusion.
 *
 * Overpass orders bboxes south,west,north,east and coordinate polylines
 * latitude/longitude; GeoJSON stays longitude/latitude. Both conversions are
 * explicit and tested.
 */

export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const OVERPASS_TIMEOUT_MS = 25_000;
export const STREET_CANDIDATE_LIMIT = 5000;
export const BOUNDARY_BUFFER_M = 1;
/**
 * Descriptive client identity. overpass-api.de rejects requests without one
 * (HTTP 406 from its request filter), and Node's fetch sends no User-Agent by
 * default. Keep in sync with the package version.
 */
export const OVERPASS_USER_AGENT = "OpenStreetLightMapper/0.1";

/** Eligible highway values for this milestone (fixed class filter). */
export const ELIGIBLE_HIGHWAY = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
  "pedestrian",
  "footway",
  "cycleway",
  "path",
  "steps",
  "track",
  "bridleway",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

const LIFECYCLE_HIGHWAY = new Set([
  "construction",
  "proposed",
  "abandoned",
  "razed",
  "demolished",
  "removed",
  "planned",
]);

/** Source tags preserved as evidence (never as verified lighting facts). */
const PRESERVED_TAGS = ["service", "access", "bridge", "tunnel", "layer", "lit"] as const;

export type StreetErrorCode =
  | "OVERPASS_NETWORK_ERROR"
  | "OVERPASS_BAD_RESPONSE"
  | "OVERPASS_BODY_TOO_LARGE"
  | "OVERPASS_REQUEST_FAILED"
  | "OVERPASS_RATE_LIMITED"
  | "OVERPASS_TIMEOUT"
  | "OVERPASS_INCOMPLETE"
  | "OVERPASS_MISCONFIGURED"
  | "STREET_LIMIT_EXCEEDED";

export class StreetError extends Error {
  readonly code: StreetErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;

  constructor(
    code: StreetErrorCode,
    message: string,
    options?: { retryable?: boolean; retryAfterSec?: number },
  ) {
    super(message);
    this.name = "StreetError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retryAfterSec = options?.retryAfterSec;
  }
}

/** Thrown when the caller's own AbortSignal fires. Not a provider failure. */
export class StreetAbortedError extends Error {
  constructor() {
    super("Client disconnected; street retrieval aborted.");
    this.name = "StreetAbortedError";
  }
}

function highwayRegex(): string {
  const values = [...ELIGIBLE_HIGHWAY].sort();
  for (const value of values) {
    if (!/^[a-z_]+$/.test(value)) throw new Error("Unsafe highway filter value.");
  }
  return `^(${values.join("|")})$`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Non-finite query coordinate.");
  return String(value);
}

/**
 * Build the Overpass QL query from validated geometry. bbox is [w,s,e,n]
 * (GeoJSON); the query needs (s,w,n,e). The ring converts to lat,lng pairs.
 */
export function buildOverpassQuery(bbox: Bbox, ring: LngLat[]): string {
  const [west, south, east, north] = bbox;
  const bboxSelector = `(${formatNumber(south)},${formatNumber(west)},${formatNumber(north)},${formatNumber(east)})`;
  const polyline = ring
    .map(([lng, lat]) => `${formatNumber(lat)},${formatNumber(lng)}`)
    .join(",");
  const highway = `["highway"~"${highwayRegex()}"]`;
  return (
    `[out:json][timeout:${Math.round(OVERPASS_TIMEOUT_MS / 1000)}];` +
    `way${highway}${bboxSelector}->.inbox;` +
    `way${highway}(around:${BOUNDARY_BUFFER_M},${polyline})->.nearby;` +
    `(.inbox;.nearby;);out meta geom;`
  );
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return undefined;
  return seconds;
}

export interface OverpassFetchOptions {
  endpoint: string;
  query: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function resolveEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_OVERPASS_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new StreetError(
      "OVERPASS_MISCONFIGURED",
      "The configured Overpass endpoint is not a valid URL.",
      { retryable: false },
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new StreetError(
      "OVERPASS_MISCONFIGURED",
      "The configured Overpass endpoint must use http(s).",
      { retryable: false },
    );
  }
  return trimmed;
}

/** POST one bounded query; returns validated way elements. */
export async function fetchOverpassWays(
  options: OverpassFetchOptions,
): Promise<{ elements: unknown[]; headers: Headers }> {
  const endpoint = resolveEndpoint(options.endpoint);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OVERPASS_TIMEOUT_MS;

  let status: number;
  let headers: Headers;
  let body: unknown;
  try {
    const result = await fetchJsonWithLimits(endpoint, {
      fetchImpl,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // The response format is driven by [out:json], not negotiation; a
        // bare Accept value is implicated in 406 refusals, so stay permissive.
        Accept: "*/*",
        "User-Agent": OVERPASS_USER_AGENT,
      },
      body: `data=${encodeURIComponent(options.query)}`,
      timeoutMs,
      signal: options.signal,
    });
    status = result.status;
    headers = result.headers;
    body = result.json;
  } catch (error) {
    if (error instanceof TransportError) {
      switch (error.kind) {
        case "aborted":
          throw new StreetAbortedError();
        case "timeout":
          throw new StreetError(
            "OVERPASS_TIMEOUT",
            "Overpass request timed out. The public instance may be busy — retry, use a smaller region, or configure a dedicated Overpass endpoint (OVERPASS_URL).",
            { retryable: true },
          );
        case "network":
          throw new StreetError(
            "OVERPASS_NETWORK_ERROR",
            "Could not reach the Overpass API (network failure).",
            { retryable: true },
          );
        case "too_large":
          throw new StreetError(
            "OVERPASS_BODY_TOO_LARGE",
            "Overpass response exceeded the 10 MiB safety limit. Select a smaller region.",
            { retryable: false },
          );
        case "bad_json":
          throw new StreetError("OVERPASS_BAD_RESPONSE", "Overpass returned malformed JSON.", {
            retryable: false,
          });
      }
    }
    throw error;
  }

  if (status < 200 || status >= 300) {
    if (status === 429) {
      throw new StreetError(
        "OVERPASS_RATE_LIMITED",
        "Overpass rate limit reached. Wait a little before retrying.",
        { retryable: true, retryAfterSec: parseRetryAfter(headers) },
      );
    }
    const busy = status >= 500;
    throw new StreetError(
      "OVERPASS_REQUEST_FAILED",
      busy
        ? `Overpass request failed (status ${status}). The public instance may be busy — retry or configure a dedicated Overpass endpoint (OVERPASS_URL).`
        : `Overpass request failed (status ${status}).`,
      { retryable: busy },
    );
  }

  if (typeof body !== "object" || body === null) {
    throw new StreetError("OVERPASS_BAD_RESPONSE", "Overpass response was not an object.", {
      retryable: false,
    });
  }
  const envelope = body as { remark?: unknown; elements?: unknown };
  if (typeof envelope.remark === "string" && envelope.remark.length > 0) {
    // Error remarks with HTTP 200 are incomplete/failed retrieval, never success.
    throw new StreetError(
      "OVERPASS_INCOMPLETE",
      "Overpass reported an incomplete result. Retry or select a smaller region.",
      { retryable: true },
    );
  }
  if (!Array.isArray(envelope.elements)) {
    throw new StreetError("OVERPASS_BAD_RESPONSE", "Overpass response had no elements array.", {
      retryable: false,
    });
  }
  return { elements: envelope.elements, headers };
}

// ---------------------------------------------------------------------------
// Way validation, clipping, grouping
// ---------------------------------------------------------------------------

export interface SourceWay {
  wayId: number;
  nodeIds: number[];
  /** Full way geometry in [lng, lat] (source order). */
  points: LngLat[];
  highway: string | null;
  name: string | null;
  ref: string | null;
  area: boolean;
  tags: Partial<Record<(typeof PRESERVED_TAGS)[number], string>>;
  version: number | null;
  timestamp: string | null;
}

function readWayId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readNodeIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) return null;
    ids.push(entry);
  }
  return ids;
}

function readTags(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null) return {};
  const tags: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") tags[key] = entry;
  }
  return tags;
}

function readGeometry(value: unknown): LngLat[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const points: LngLat[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { lat, lon } = entry as { lat?: unknown; lon?: unknown };
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return null;
    }
    points.push([lon, lat]);
  }
  return points;
}

function readSourceWay(element: unknown): SourceWay | null {
  if (typeof element !== "object" || element === null) return null;
  const record = element as Record<string, unknown>;
  if (record.type !== "way") return null;
  const wayId = readWayId(record.id);
  const nodeIds = readNodeIds(record.nodes);
  const points = readGeometry(record.geometry);
  const tags = readTags(record.tags);
  if (wayId === null || nodeIds === null || points === null || tags === null) return null;
  // Geometry and node lists must align; anything else is incomplete data.
  if (nodeIds.length !== points.length || points.length < 2) return null;
  const highway = typeof tags.highway === "string" ? tags.highway : null;
  const version =
    typeof record.version === "number" && Number.isSafeInteger(record.version)
      ? record.version
      : null;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  const preserved: SourceWay["tags"] = {};
  for (const key of PRESERVED_TAGS) {
    if (typeof tags[key] === "string") preserved[key] = tags[key];
  }
  return {
    wayId,
    nodeIds,
    points,
    highway,
    name: typeof tags.name === "string" && tags.name.trim().length > 0 ? tags.name : null,
    ref: typeof tags.ref === "string" && tags.ref.trim().length > 0 ? tags.ref : null,
    area: tags.area === "yes",
    tags: preserved,
    version,
    timestamp,
  };
}

type EligibleWay = SourceWay & { highway: string };

function isEligibleWay(way: SourceWay): way is EligibleWay {
  if (typeof way.highway !== "string") return false;
  if (!ELIGIBLE_HIGHWAY.has(way.highway)) return false;
  if (LIFECYCLE_HIGHWAY.has(way.highway)) return false;
  if (way.area) return false;
  return true;
}

export interface StreetSegment {
  wayId: number;
  highway: string;
  nodeIds: number[];
  tags: SourceWay["tags"];
  version: number | null;
  timestamp: string | null;
}

export interface StreetWorkItem {
  /** Stable deterministic ID for this dataset. */
  id: string;
  displayName: string;
  /** "Part k of n" when one name/ref splits into disconnected components. */
  partLabel: string | null;
  name: string | null;
  ref: string | null;
  wayIds: number[];
  segments: StreetSegment[];
  /** Clipped in-region geometry (fragments only, never gaps). */
  geometry: { type: "MultiLineString"; coordinates: LngLat[][] };
  /** In-region length in metres (fragments only). */
  lengthM: number;
}

export interface StreetDataset {
  streets: StreetWorkItem[];
  candidateCount: number;
  invalidWayCount: number;
  ineligibleWayCount: number;
  outsideCount: number;
  zeroFragmentWays: number;
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function foldLabel(value: string): string {
  return normalizeLabel(value).toLowerCase();
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "x";
}

function compareStrings(a: string, b: string): number {
  // Code-unit ordering: deterministic across ICU versions (no localeCompare).
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Union-find grouping of ways that share OSM nodes (source topology). */
function connectedComponents(ways: EligibleWay[]): EligibleWay[][] {
  const parent = new Map<number, number>();
  const find = (wayId: number): number => {
    const direct = parent.get(wayId) ?? wayId;
    if (direct === wayId) return wayId;
    const root = find(direct);
    parent.set(wayId, root);
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  const nodeOwner = new Map<number, number>();
  for (const way of ways) {
    for (const nodeId of way.nodeIds) {
      const owner = nodeOwner.get(nodeId);
      if (owner === undefined) nodeOwner.set(nodeId, way.wayId);
      else union(owner, way.wayId);
    }
  }
  const groups = new Map<number, EligibleWay[]>();
  for (const way of ways) {
    const root = find(way.wayId);
    const group = groups.get(root) ?? [];
    group.push(way);
    groups.set(root, group);
  }
  return [...groups.values()].map((group) =>
    group.sort((a, b) => a.wayId - b.wayId),
  );
}

/**
 * Group validated ways into street work items and clip to the polygon.
 * Throws StreetError when the candidate set exceeds the application limit.
 */
export function buildStreetDataset(ways: SourceWay[], ring: LngLat[]): StreetDataset {
  if (ways.length > STREET_CANDIDATE_LIMIT) {
    throw new StreetError(
      "STREET_LIMIT_EXCEEDED",
      `Overpass returned ${ways.length} candidate ways, above the ${STREET_CANDIDATE_LIMIT} limit. Select a smaller region.`,
      { retryable: false },
    );
  }

  // Eligibility (area + lifecycle exclusions happen on source tags).
  const eligible: EligibleWay[] = [];
  let ineligibleWayCount = 0;
  let outsideCount = 0;
  let zeroFragmentWays = 0;
  const clipped = new Map<number, { way: EligibleWay; fragments: LngLat[][]; lengthM: number }>();
  for (const way of ways) {
    if (!isEligibleWay(way)) {
      ineligibleWayCount += 1;
      continue;
    }
    const fragments = clipPolylineToRing(way.points, ring);
    if (fragments.length === 0) {
      outsideCount += 1; // outside the polygon or a point-only touch
      continue;
    }
    eligible.push(way);
    clipped.set(way.wayId, {
      way,
      fragments,
      lengthM: fragmentsLengthM(fragments),
    });
  }
  zeroFragmentWays = outsideCount;

  // Buckets: normalized name, else normalized ref, else individual ways.
  const namedBuckets = new Map<string, EligibleWay[]>();
  const refBuckets = new Map<string, EligibleWay[]>();
  const unnamed: EligibleWay[] = [];
  for (const way of eligible) {
    if (way.name !== null) {
      const key = foldLabel(way.name);
      const bucket = namedBuckets.get(key) ?? [];
      bucket.push(way);
      namedBuckets.set(key, bucket);
    } else if (way.ref !== null) {
      const key = foldLabel(way.ref);
      const bucket = refBuckets.get(key) ?? [];
      bucket.push(way);
      refBuckets.set(key, bucket);
    } else {
      unnamed.push(way);
    }
  }

  const streets: StreetWorkItem[] = [];
  const minWayId = (group: EligibleWay[]): number =>
    group.reduce((min, way) => Math.min(min, way.wayId), Number.MAX_SAFE_INTEGER);

  function emitGroup(
    kind: "name" | "ref",
    fold: string,
    components: EligibleWay[][],
  ): void {
    const ordered = components.sort((a, b) => minWayId(a) - minWayId(b));
    ordered.forEach((group, index) => {
      const sorted = [...group].sort((a, b) => a.wayId - b.wayId);
      const first = sorted[0];
      const displayName =
        kind === "name" ? (first.name ?? fold) : (first.ref ?? fold);
      const partLabel = ordered.length > 1 ? `Part ${index + 1} of ${ordered.length}` : null;
      const id = `${kind}-${slugify(fold)}-${fnv1aHex(fold)}-p${index + 1}`;
      const coordinates: LngLat[][] = [];
      let lengthM = 0;
      const segments: StreetSegment[] = [];
      const wayIds: number[] = [];
      for (const way of sorted) {
        const entry = clipped.get(way.wayId);
        if (!entry) continue;
        wayIds.push(way.wayId);
        coordinates.push(...entry.fragments);
        lengthM += entry.lengthM;
        segments.push({
          wayId: way.wayId,
          highway: way.highway,
          nodeIds: way.nodeIds,
          tags: way.tags,
          version: way.version,
          timestamp: way.timestamp,
        });
      }
      streets.push({
        id,
        displayName,
        partLabel,
        name: kind === "name" ? first.name : null,
        ref: kind === "ref" ? first.ref : null,
        wayIds,
        segments,
        geometry: { type: "MultiLineString", coordinates },
        lengthM,
      });
    });
  }

  for (const [fold, bucket] of namedBuckets) emitGroup("name", fold, connectedComponents(bucket));
  for (const [fold, bucket] of refBuckets) emitGroup("ref", fold, connectedComponents(bucket));

  for (const way of unnamed.sort((a, b) => a.wayId - b.wayId)) {
    const entry = clipped.get(way.wayId);
    if (!entry) continue;
    streets.push({
      id: `way-${way.wayId}`,
      displayName: `Unnamed ${way.highway} · OSM way ${way.wayId}`,
      partLabel: null,
      name: null,
      ref: null,
      wayIds: [way.wayId],
      segments: [
        {
          wayId: way.wayId,
          highway: way.highway,
          nodeIds: way.nodeIds,
          tags: way.tags,
          version: way.version,
          timestamp: way.timestamp,
        },
      ],
      geometry: { type: "MultiLineString", coordinates: entry.fragments },
      lengthM: entry.lengthM,
    });
  }

  streets.sort(
    (a, b) => compareStrings(a.displayName.toLowerCase(), b.displayName.toLowerCase()) || compareStrings(a.id, b.id),
  );

  return {
    streets,
    candidateCount: ways.length,
    invalidWayCount: 0, // filled by the caller that filters raw elements
    ineligibleWayCount,
    outsideCount,
    zeroFragmentWays,
  };
}

export interface StreetRetrieval {
  dataset: StreetDataset;
  invalidWayCount: number;
}

/** Validate raw Overpass elements, then group and clip. */
export function processOverpassElements(elements: unknown[], ring: LngLat[]): StreetRetrieval {
  const seen = new Set<number>();
  const ways: SourceWay[] = [];
  let invalidWayCount = 0;
  for (const element of elements) {
    const way = readSourceWay(element);
    if (way === null) {
      // Non-way elements are ignored silently (query asks for ways only);
      // malformed way objects count as invalid.
      if ((element as { type?: unknown } | null)?.type === "way") invalidWayCount += 1;
      continue;
    }
    if (seen.has(way.wayId)) continue; // union branches can overlap
    seen.add(way.wayId);
    ways.push(way);
  }
  const dataset = buildStreetDataset(ways, ring);
  dataset.invalidWayCount = invalidWayCount;
  return { dataset, invalidWayCount };
}
