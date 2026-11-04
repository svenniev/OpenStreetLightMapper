/**
 * Typed, validated storage contracts for workspace persistence.
 *
 * Pure functions (no database access): every persistence route validates its
 * body here before touching MongoDB. Unknown schema versions, invalid
 * coordinates, broken evidence/support links, oversized payloads, and
 * synthetic/real context mixing are rejected with actionable errors.
 */

export const STORAGE_SCHEMA_VERSION = 1;

/** JSON-byte caps per persisted payload (checked after parsing). */
export const WORKSPACE_JSON_BYTES_MAX = 512 * 1024;
export const SESSION_JSON_BYTES_MAX = 2 * 1024 * 1024;
export const SNAPSHOT_JSON_BYTES_MAX = 8 * 1024 * 1024;
export const ITEM_JSON_BYTES_MAX = 4 * 1024 * 1024;
export const RESULT_JSON_BYTES_MAX = 2 * 1024 * 1024;
export const ARTIFACT_BYTES_MAX = 8 * 1024 * 1024;

/** Record-count caps inside snapshots (separate docs, still bounded). */
export const SNAPSHOT_IMAGES_MAX = 5000;
export const SNAPSHOT_STREETS_MAX = 2000;

/** Parsed objects per detection item (mirrors the SAM object cap). */
export const ITEM_OBJECTS_MAX = 200;
/** Bytes per stored SVG mask path. */
export const MASK_PATH_BYTES_MAX = 1024 * 1024;

export type StorageErrorCode =
  | "STORAGE_BAD_REQUEST"
  | "STORAGE_SCHEMA_VERSION"
  | "STORAGE_PAYLOAD_TOO_LARGE"
  | "STORAGE_RECORD_LIMIT"
  | "BROKEN_EVIDENCE_LINK"
  | "BROKEN_SUPPORT_LINK"
  | "CONTEXT_MIXING"
  | "REVISION_CONFLICT"
  | "SESSION_EXISTS"
  | "SESSION_MODE_NOT_PERSISTED"
  | "ITEM_CONFLICT"
  | "ITEM_ALREADY_COMPLETE"
  | "ITEM_NOT_FOUND"
  | "RESULT_CONFLICT"
  | "SNAPSHOT_CONFLICT"
  | "WORKSPACE_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "ARTIFACT_NOT_FOUND"
  | "DB_UNAVAILABLE";

export class StorageValidationError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable = false;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: StorageErrorCode, message: string): never {
  throw new StorageValidationError(code, message);
}

export function checkJsonBytes(
  payload: unknown,
  maxBytes: number,
  what: string,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > maxBytes) {
    fail(
      "STORAGE_PAYLOAD_TOO_LARGE",
      `${what} is ${(bytes / 1024 / 1024).toFixed(2)} MiB, above the ${(maxBytes / 1024 / 1024).toFixed(2)} MiB limit. ` +
        `Split the work (fewer images, views, or detections per save).`,
    );
  }
}

function checkSchemaVersion(value: unknown): void {
  if (value !== STORAGE_SCHEMA_VERSION) {
    fail(
      "STORAGE_SCHEMA_VERSION",
      `Unsupported schemaVersion ${JSON.stringify(value)}; this server stores version ${STORAGE_SCHEMA_VERSION}.`,
    );
  }
}

/**
 * Client-supplied identity inside URLs and documents: bounded, no slashes
 * (they would break routing), no whitespace or control characters.
 */
export function checkClientId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a 1..160 character string.`);
  }
  const id = value as string;
  // eslint-disable-next-line no-control-regex -- control ranges are the point of this check.
  if (/[\s\x00-\x1f\x7f/?#]/.test(id)) {
    fail("STORAGE_BAD_REQUEST", `${field} must not contain whitespace, slashes, or URL delimiters.`);
  }
  return id;
}

function checkRevision(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a positive safe integer.`);
  }
  return value as number;
}

function checkFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a finite number.`);
  }
  return value as number;
}

function checkLngLat(value: unknown, field: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a [lng, lat] pair.`);
  }
  const [lng, lat] = value as unknown[];
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    fail("STORAGE_BAD_REQUEST", `${field} must be finite WGS84 [lng, lat] within range.`);
  }
  return [lng, lat];
}

function checkBbox(value: unknown, field: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a [west, south, east, north] bbox.`);
  }
  const [west, south, east, north] = value as unknown[];
  for (const entry of [west, south, east, north]) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      fail("STORAGE_BAD_REQUEST", `${field} must hold four finite numbers.`);
    }
  }
  return [west as number, south as number, east as number, north as number];
}

function checkString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a string of at most ${maxLength} characters.`);
  }
  return value as string;
}

function checkStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail("STORAGE_BAD_REQUEST", `${field} must be an array of at most ${maxItems} strings.`);
  }
  return (value as unknown[]).map((entry, index) => checkString(entry, `${field}[${index}]`, maxLength));
}

function checkIsoDate(value: unknown, field: string): string {
  const text = checkString(value, field, 40);
  if (Number.isNaN(Date.parse(text))) fail("STORAGE_BAD_REQUEST", `${field} must be an ISO date string.`);
  return text;
}

function checkNormalizedRect(value: unknown, field: string): { x: number; y: number; w: number; h: number } {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be a normalized rectangle.`);
  const record = value as Record<string, unknown>;
  const rect = {
    x: checkFiniteNumber(record.x, `${field}.x`),
    y: checkFiniteNumber(record.y, `${field}.y`),
    w: checkFiniteNumber(record.w, `${field}.w`),
    h: checkFiniteNumber(record.h, `${field}.h`),
  };
  if (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > 1.0001 || rect.y + rect.h > 1.0001) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a normalized rectangle inside the unit square.`);
  }
  return rect;
}

function checkPolygon(value: unknown, field: string): { type: "Polygon"; coordinates: [number, number][][] } {
  if (!isRecord(value) || value.type !== "Polygon" || !Array.isArray(value.coordinates)) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a GeoJSON Polygon.`);
  }
  const rings = (value as { coordinates: unknown }).coordinates as unknown[];
  if (rings.length === 0 || rings.length > 4) {
    fail("STORAGE_BAD_REQUEST", `${field} must hold 1..4 rings.`);
  }
  const checked = rings.map((ring, ringIndex) => {
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > 5000) {
      fail("STORAGE_BAD_REQUEST", `${field} ring ${ringIndex} must hold 4..5000 positions.`);
    }
    return (ring as unknown[]).map((position, positionIndex) =>
      checkLngLat(position, `${field}[${ringIndex}][${positionIndex}]`),
    );
  });
  for (const [ringIndex, ring] of checked.entries()) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      fail("STORAGE_BAD_REQUEST", `${field} ring ${ringIndex} must be closed.`);
    }
  }
  return { type: "Polygon", coordinates: checked };
}

// ---------------------------------------------------------------------------
// Input snapshots (immutable provider-result captures, referenced by workspaces)
// ---------------------------------------------------------------------------

export type SnapshotKind = "imagery-discovery" | "street-snapshot";

export interface ValidatedImageRecord {
  id: string;
  coordinate: [number, number];
  coordinateSource: "geometry" | "computed_geometry";
  originalCoordinate: [number, number] | null;
  computedCoordinate: [number, number] | null;
  capturedAt: number | null;
  isPano: boolean | null;
  sequenceId: string | null;
  inRoi?: boolean;
}

function checkOptionalLngLat(value: unknown, field: string): [number, number] | null {
  if (value === null) return null;
  return checkLngLat(value, field);
}

function checkImageRecord(value: unknown, field: string): ValidatedImageRecord {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be an image record.`);
  const record = value as Record<string, unknown>;
  const coordinateSource = record.coordinateSource;
  if (coordinateSource !== "geometry" && coordinateSource !== "computed_geometry") {
    fail("STORAGE_BAD_REQUEST", `${field}.coordinateSource must be geometry or computed_geometry.`);
  }
  const capturedAt = record.capturedAt;
  if (capturedAt !== null && (typeof capturedAt !== "number" || !Number.isFinite(capturedAt))) {
    fail("STORAGE_BAD_REQUEST", `${field}.capturedAt must be a finite number or null.`);
  }
  const isPano = record.isPano;
  if (isPano !== null && typeof isPano !== "boolean") {
    fail("STORAGE_BAD_REQUEST", `${field}.isPano must be a boolean or null.`);
  }
  const sequenceId = record.sequenceId;
  if (sequenceId !== null && (typeof sequenceId !== "string" || sequenceId.length > 160)) {
    fail("STORAGE_BAD_REQUEST", `${field}.sequenceId must be a string or null.`);
  }
  const inRoi = record.inRoi;
  if (inRoi !== undefined && typeof inRoi !== "boolean") {
    fail("STORAGE_BAD_REQUEST", `${field}.inRoi must be a boolean when present.`);
  }
  return {
    id: checkClientId(record.id, `${field}.id`),
    coordinate: checkLngLat(record.coordinate, `${field}.coordinate`),
    coordinateSource: coordinateSource as ValidatedImageRecord["coordinateSource"],
    originalCoordinate: checkOptionalLngLat(record.originalCoordinate, `${field}.originalCoordinate`),
    computedCoordinate: checkOptionalLngLat(record.computedCoordinate, `${field}.computedCoordinate`),
    capturedAt: capturedAt as number | null,
    isPano: isPano as boolean | null,
    sequenceId: sequenceId as string | null,
    ...(inRoi === undefined ? {} : { inRoi: inRoi as boolean }),
  };
}

export interface ValidatedImagerySnapshot {
  query: Record<string, unknown>;
  warnings: string[];
  status: string;
  everSearched: boolean;
  seeds: ValidatedImageRecord[];
  hydrated: ValidatedImageRecord[];
  truncatedCount: number;
}

function checkImagerySnapshot(payload: unknown): ValidatedImagerySnapshot {
  if (!isRecord(payload)) fail("STORAGE_BAD_REQUEST", "Imagery snapshot payload must be an object.");
  const record = payload as Record<string, unknown>;
  const seeds = record.seeds;
  const hydrated = record.hydrated;
  if (!Array.isArray(seeds) || !Array.isArray(hydrated)) {
    fail("STORAGE_BAD_REQUEST", "Imagery snapshot needs seeds and hydrated arrays.");
  }
  const total = (seeds as unknown[]).length + (hydrated as unknown[]).length;
  if (total > SNAPSHOT_IMAGES_MAX) {
    fail(
      "STORAGE_RECORD_LIMIT",
      `Imagery snapshot holds ${total} image records, above the ${SNAPSHOT_IMAGES_MAX} cap. ` +
        `Save a smaller working set (fewer sequences) instead.`,
    );
  }
  const truncatedCount = record.truncatedCount;
  if (typeof truncatedCount !== "number" || !Number.isSafeInteger(truncatedCount) || truncatedCount < 0) {
    fail("STORAGE_BAD_REQUEST", "Imagery snapshot truncatedCount must be a non-negative integer.");
  }
  if (!isRecord(record.query)) fail("STORAGE_BAD_REQUEST", "Imagery snapshot query must be an object.");
  return {
    query: record.query as Record<string, unknown>,
    warnings: checkStringArray(record.warnings, "warnings", 50, 500),
    status: checkString(record.status, "status", 40),
    everSearched: record.everSearched === true,
    seeds: (seeds as unknown[]).map((entry, index) => checkImageRecord(entry, `seeds[${index}]`)),
    hydrated: (hydrated as unknown[]).map((entry, index) => checkImageRecord(entry, `hydrated[${index}]`)),
    truncatedCount: truncatedCount as number,
  };
}

export interface ValidatedStreetSnapshot {
  streets: Record<string, unknown>[];
  query: Record<string, unknown> | null;
  warnings: string[];
  seeded: boolean;
  retrievedAt: string | null;
}

function checkStreetGeometry(value: unknown, field: string): void {
  if (!isRecord(value) || value.type !== "MultiLineString" || !Array.isArray(value.coordinates)) {
    fail("STORAGE_BAD_REQUEST", `${field} must be a MultiLineString geometry.`);
  }
  const lines = (value as { coordinates: unknown }).coordinates as unknown[];
  if (lines.length > 200) fail("STORAGE_BAD_REQUEST", `${field} must hold at most 200 lines.`);
  for (const [lineIndex, line] of lines.entries()) {
    if (!Array.isArray(line) || line.length > 5000) {
      fail("STORAGE_BAD_REQUEST", `${field} line ${lineIndex} must hold at most 5000 positions.`);
    }
    for (const [positionIndex, position] of (line as unknown[]).entries()) {
      checkLngLat(position, `${field}[${lineIndex}][${positionIndex}]`);
    }
  }
}

function checkStreetRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be a street record.`);
  const record = value as Record<string, unknown>;
  checkClientId(record.id, `${field}.id`);
  checkString(record.displayName, `${field}.displayName`, 300);
  if (!Array.isArray(record.wayIds)) fail("STORAGE_BAD_REQUEST", `${field}.wayIds must be an array.`);
  for (const wayId of record.wayIds as unknown[]) {
    if (typeof wayId !== "number" || !Number.isSafeInteger(wayId)) {
      fail("STORAGE_BAD_REQUEST", `${field}.wayIds must hold safe integers.`);
    }
  }
  checkStreetGeometry(record.geometry, `${field}.geometry`);
  checkFiniteNumber(record.lengthM, `${field}.lengthM`);
  return record;
}

function checkStreetSnapshot(payload: unknown): ValidatedStreetSnapshot {
  if (!isRecord(payload)) fail("STORAGE_BAD_REQUEST", "Street snapshot payload must be an object.");
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.streets)) fail("STORAGE_BAD_REQUEST", "Street snapshot needs a streets array.");
  const streets = record.streets as unknown[];
  if (streets.length > SNAPSHOT_STREETS_MAX) {
    fail(
      "STORAGE_RECORD_LIMIT",
      `Street snapshot holds ${streets.length} streets, above the ${SNAPSHOT_STREETS_MAX} cap. ` +
        `Select a smaller region instead.`,
    );
  }
  const query = record.query;
  if (query !== null && !isRecord(query)) {
    fail("STORAGE_BAD_REQUEST", "Street snapshot query must be an object or null.");
  }
  const retrievedAt = record.retrievedAt;
  if (retrievedAt !== null) checkIsoDate(retrievedAt, "retrievedAt");
  return {
    streets: streets.map((entry, index) => checkStreetRecord(entry, `streets[${index}]`)),
    query: (query ?? null) as Record<string, unknown> | null,
    warnings: checkStringArray(record.warnings, "warnings", 50, 500),
    seeded: record.seeded === true,
    retrievedAt: (retrievedAt ?? null) as string | null,
  };
}

export interface ValidatedSnapshotInput {
  snapshotId: string;
  kind: SnapshotKind;
  payload: ValidatedImagerySnapshot | ValidatedStreetSnapshot;
}

export function validateSnapshotInput(body: unknown): ValidatedSnapshotInput {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Snapshot body must be an object.");
  const record = body as Record<string, unknown>;
  checkSchemaVersion(record.schemaVersion);
  checkJsonBytes(body, SNAPSHOT_JSON_BYTES_MAX, "Snapshot payload");
  const kind = record.kind;
  if (kind !== "imagery-discovery" && kind !== "street-snapshot") {
    fail("STORAGE_BAD_REQUEST", "Snapshot kind must be imagery-discovery or street-snapshot.");
  }
  return {
    snapshotId: checkClientId(record.snapshotId, "snapshotId"),
    kind,
    payload: kind === "imagery-discovery" ? checkImagerySnapshot(record.payload) : checkStreetSnapshot(record.payload),
  };
}

// ---------------------------------------------------------------------------
// Workspaces (mutable selection/context state, revision-guarded)
// ---------------------------------------------------------------------------

export interface ValidatedWorkspace {
  name: string;
  roi: Record<string, unknown> | null;
  imagerySnapshotId: string | null;
  imagerySelection: Record<string, unknown>;
  streetSnapshotId: string | null;
  streetSelection: Record<string, unknown>;
  preparation: Record<string, unknown>;
  activeSessionKey: string | null;
  sessionKeys: string[];
}

function checkRoi(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", "roi must be an object or null.");
  const record = value as Record<string, unknown>;
  // Stable input revision: a positive integer that survives restarts.
  checkRevision(record.revision, "roi.revision");
  if (record.shape !== "rectangle" && record.shape !== "polygon") {
    fail("STORAGE_BAD_REQUEST", "roi.shape must be rectangle or polygon.");
  }
  checkPolygon(record.polygon, "roi.polygon");
  checkBbox(record.bbox, "roi.bbox");
  checkFiniteNumber(record.areaSqM, "roi.areaSqM");
  if (typeof record.valid !== "boolean") fail("STORAGE_BAD_REQUEST", "roi.valid must be a boolean.");
  const center = record.center;
  if (center !== null) {
    if (!isRecord(center)) fail("STORAGE_BAD_REQUEST", "roi.center must be {lng,lat} or null.");
    checkLngLat(
      [(center as Record<string, unknown>).lng, (center as Record<string, unknown>).lat],
      "roi.center",
    );
  }
  const zoom = record.zoom;
  if (zoom !== null && (typeof zoom !== "number" || !Number.isFinite(zoom))) {
    fail("STORAGE_BAD_REQUEST", "roi.zoom must be a finite number or null.");
  }
  return record;
}

function checkSnapshotRef(value: unknown, field: string): string | null {
  if (value === null) return null;
  return checkClientId(value, field);
}

export function validateWorkspaceInput(body: unknown): ValidatedWorkspace {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Workspace body must be an object.");
  const record = body as Record<string, unknown>;
  checkSchemaVersion(record.schemaVersion);
  checkJsonBytes(body, WORKSPACE_JSON_BYTES_MAX, "Workspace payload");
  const name = checkString(record.name, "name", 120);
  if (name.trim().length === 0) fail("STORAGE_BAD_REQUEST", "Workspace name must not be blank.");
  if (!isRecord(record.imagerySelection) || !isRecord(record.streetSelection) || !isRecord(record.preparation)) {
    fail("STORAGE_BAD_REQUEST", "Workspace needs imagerySelection, streetSelection, and preparation objects.");
  }
  const activeSessionKey = record.activeSessionKey;
  if (activeSessionKey !== null) checkClientId(activeSessionKey, "activeSessionKey");
  if (!Array.isArray(record.sessionKeys) || (record.sessionKeys as unknown[]).length > 500) {
    fail("STORAGE_BAD_REQUEST", "sessionKeys must be an array of at most 500 entries.");
  }
  const sessionKeys = (record.sessionKeys as unknown[]).map((entry, index) =>
    checkClientId(entry, `sessionKeys[${index}]`),
  );
  return {
    name,
    roi: checkRoi(record.roi),
    imagerySnapshotId: checkSnapshotRef(record.imagerySnapshotId, "imagerySnapshotId"),
    imagerySelection: record.imagerySelection as Record<string, unknown>,
    streetSnapshotId: checkSnapshotRef(record.streetSnapshotId, "streetSnapshotId"),
    streetSelection: record.streetSelection as Record<string, unknown>,
    preparation: record.preparation as Record<string, unknown>,
    activeSessionKey: (activeSessionKey ?? null) as string | null,
    sessionKeys,
  };
}

export function validateExpectedRevision(body: unknown): number | null {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Body must be an object.");
  const record = body as Record<string, unknown>;
  if (record.expectedRevision === null || record.expectedRevision === undefined) return null;
  return checkRevision(record.expectedRevision, "expectedRevision");
}

// ---------------------------------------------------------------------------
// Inventory sessions (mutable review/asset state, revision-guarded)
// ---------------------------------------------------------------------------

const OBSERVATION_CATEGORIES = new Set(["pole", "luminaire", "uncertain"]);
const OBSERVATION_DECISIONS = new Set(["pending", "accepted", "rejected", "deferred"]);
const OBSERVATION_ORIGINS = new Set(["demo", "manual", "sam-text", "sam-assisted"]);
const ASSET_CATEGORIES = new Set(["pole", "luminaire"]);
const SUPPORT_KINDS = new Set(["pole", "wall", "suspended", "unknown"]);
const PLACEMENT_KINDS = new Set(["geographic", "diagram", "inherited", "unknown"]);
const STREET_SOURCES = new Set(["osm", "manual-work-area", "synthetic-demo"]);
const WORKFLOW_STEPS = new Set(["detect", "review", "group", "place", "inventory"]);
const ITEM_STATUSES = new Set([
  "queued",
  "preparing",
  "detecting",
  "succeeded",
  "empty",
  "failed",
  "cancelled",
  "interrupted",
]);

function checkPlacement(value: unknown, field: string): void {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be a placement object.`);
  const record = value as Record<string, unknown>;
  if (!PLACEMENT_KINDS.has(record.kind as string)) {
    fail("STORAGE_BAD_REQUEST", `${field}.kind is not a known placement kind.`);
  }
  if (record.kind === "geographic") {
    checkLngLat([record.lng, record.lat], field);
  } else if (record.kind === "diagram") {
    const x = checkFiniteNumber(record.x, `${field}.x`);
    const y = checkFiniteNumber(record.y, `${field}.y`);
    if (x < 0 || x > 100 || y < 0 || y > 100) {
      fail("STORAGE_BAD_REQUEST", `${field} diagram coordinates must be within 0..100.`);
    }
  }
}

function checkSupportLink(value: unknown, field: string, assetIds: Set<string>): void {
  if (value === null) return;
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be a support link or null.`);
  const record = value as Record<string, unknown>;
  if (!SUPPORT_KINDS.has(record.kind as string)) {
    fail("STORAGE_BAD_REQUEST", `${field}.kind is not a known support kind.`);
  }
  if (record.kind === "pole") {
    const poleAssetId = checkClientId(record.poleAssetId, `${field}.poleAssetId`);
    if (!assetIds.has(poleAssetId)) {
      fail("BROKEN_SUPPORT_LINK", `${field} references unknown asset ${poleAssetId}.`);
    }
  }
}

/** Artifact IDs referenced by this payload (validated for existence by routes). */
export function collectArtifactIds(session: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const views = (session.views ?? {}) as Record<string, Record<string, unknown>>;
  for (const view of Object.values(views)) {
    if (typeof view.artifactId === "string" && view.artifactId.length > 0) ids.add(view.artifactId);
  }
  return [...ids];
}

function checkObservation(
  value: unknown,
  field: string,
  mode: string,
  viewIds: Set<string>,
): void {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be an observation.`);
  const record = value as Record<string, unknown>;
  checkClientId(record.id, `${field}.id`);
  checkClientId(record.imageId, `${field}.imageId`);
  if (record.viewId !== null) {
    const viewId = checkClientId(record.viewId, `${field}.viewId`);
    if (!viewIds.has(viewId)) fail("STORAGE_BAD_REQUEST", `${field} references unknown view ${viewId}.`);
  }
  if (!OBSERVATION_CATEGORIES.has(record.category as string)) {
    fail("STORAGE_BAD_REQUEST", `${field}.category is not a known category.`);
  }
  checkString(record.description, `${field}.description`, 500);
  if (record.imageRegion !== null) checkNormalizedRect(record.imageRegion, `${field}.imageRegion`);
  // Masks live in immutable detection items; sessions carry decisions, not pixels.
  if (record.mask !== null) {
    fail(
      "STORAGE_BAD_REQUEST",
      `${field}.mask must be null in stored sessions; masks are served from detection items.`,
    );
  }
  if (typeof record.maskStale !== "boolean") {
    fail("STORAGE_BAD_REQUEST", `${field}.maskStale must be a boolean.`);
  }
  const origin = record.origin;
  if (!OBSERVATION_ORIGINS.has(origin as string)) {
    fail("STORAGE_BAD_REQUEST", `${field}.origin is not a known origin.`);
  }
  // Synthetic/real isolation: demo records never persist, and manual
  // sessions reject demo observations outright.
  if (origin === "demo" || record.mode === "demo") {
    fail("CONTEXT_MIXING", `${field} is a demo record; only manual sessions persist.`);
  }
  if (record.mode !== mode) {
    fail("CONTEXT_MIXING", `${field}.mode does not match the session mode.`);
  }
  if (!OBSERVATION_DECISIONS.has(record.decision as string)) {
    fail("STORAGE_BAD_REQUEST", `${field}.decision is not a known decision.`);
  }
  checkString(record.note, `${field}.note`, 2000);
  const provenance = record.provenance;
  if (origin === "sam-text" || origin === "sam-assisted") {
    if (!isRecord(provenance)) fail("STORAGE_BAD_REQUEST", `${field}.provenance is required for model origins.`);
    const prov = provenance as Record<string, unknown>;
    if (prov.provider !== "meta-sam") fail("STORAGE_BAD_REQUEST", `${field}.provenance.provider must be meta-sam.`);
    checkString(prov.model, `${field}.provenance.model`, 120);
    checkString(prov.prompt, `${field}.provenance.prompt`, 120);
    checkClientId(prov.runId, `${field}.provenance.runId`);
    checkClientId(prov.itemId, `${field}.provenance.itemId`);
    checkClientId(prov.requestId, `${field}.provenance.requestId`);
    checkClientId(prov.providerObjectId, `${field}.provenance.providerObjectId`);
    if (prov.geometrySource !== "model" && prov.geometrySource !== "manual-adjusted") {
      fail("STORAGE_BAD_REQUEST", `${field}.provenance.geometrySource must be model or manual-adjusted.`);
    }
  } else if (provenance !== null) {
    fail("STORAGE_BAD_REQUEST", `${field}.provenance must be null for manual observations.`);
  }
}

function checkAsset(
  value: unknown,
  field: string,
  mode: string,
  streetSource: string,
  observationIds: Set<string>,
  assetIds: Set<string>,
): void {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be an asset.`);
  const record = value as Record<string, unknown>;
  const id = checkClientId(record.id, `${field}.id`);
  if (!ASSET_CATEGORIES.has(record.category as string)) {
    fail("STORAGE_BAD_REQUEST", `${field}.category must be pole or luminaire.`);
  }
  if (!Array.isArray(record.observationIds)) {
    fail("STORAGE_BAD_REQUEST", `${field}.observationIds must be an array.`);
  }
  for (const [index, entry] of (record.observationIds as unknown[]).entries()) {
    const obsId = checkClientId(entry, `${field}.observationIds[${index}]`);
    if (!observationIds.has(obsId)) {
      fail("STORAGE_BAD_REQUEST", `${field} references unknown observation ${obsId}.`);
    }
  }
  if (typeof record.confirmed !== "boolean") {
    fail("STORAGE_BAD_REQUEST", `${field}.confirmed must be a boolean.`);
  }
  checkSupportLink(record.support, `${field}.support`, assetIds);
  if (record.category === "pole" && record.support !== null) {
    fail("STORAGE_BAD_REQUEST", `${field}: pole assets must carry a null support link.`);
  }
  checkPlacement(record.placement, `${field}.placement`);
  if (record.mode !== mode || record.mode === "demo") {
    fail("CONTEXT_MIXING", `${field}.mode does not match the manual session mode.`);
  }
  if (record.streetSource !== streetSource) {
    fail("STORAGE_BAD_REQUEST", `${field}.streetSource does not match the session context.`);
  }
  checkString(record.note, `${field}.note`, 2000);
  void id;
}

function checkView(value: unknown, field: string): void {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be a view descriptor.`);
  const record = value as Record<string, unknown>;
  checkClientId(record.viewId, `${field}.viewId`);
  checkClientId(record.imageId, `${field}.imageId`);
  for (const dimension of ["fullWidth", "fullHeight", "width", "height"] as const) {
    const entry = record[dimension];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0 || entry > 32768) {
      fail("STORAGE_BAD_REQUEST", `${field}.${dimension} must be a positive safe integer.`);
    }
  }
  const orientation = record.orientation;
  if (typeof orientation !== "number" || !Number.isSafeInteger(orientation) || orientation < 1 || orientation > 8) {
    fail("STORAGE_BAD_REQUEST", `${field}.orientation must be an integer 1..8.`);
  }
  if (typeof record.isPano !== "boolean" || typeof record.fullyReviewed !== "boolean") {
    fail("STORAGE_BAD_REQUEST", `${field} flags must be booleans.`);
  }
  if (record.crop !== null) checkNormalizedRect(record.crop, `${field}.crop`);
  // Transient server-memory handles must never persist, even alongside an
  // artifact reference: durable evidence is artifact-or-image identity.
  if (record.mediaHandle !== "") {
    fail(
      "STORAGE_BAD_REQUEST",
      `${field}.mediaHandle must be empty in stored sessions; evidence resolves via artifactId.`,
    );
  }
  const artifactId = record.artifactId;
  if (artifactId !== null && artifactId !== undefined) {
    if (typeof artifactId !== "string" || !/^[0-9a-f]{24}$/.test(artifactId)) {
      fail("STORAGE_BAD_REQUEST", `${field}.artifactId must be a stored evidence ID or null.`);
    }
  }
}

function checkRunItem(value: unknown, field: string, viewIds: Set<string>, conceptIds: Set<string>): void {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be a run item.`);
  const record = value as Record<string, unknown>;
  checkClientId(record.itemId, `${field}.itemId`);
  checkClientId(record.requestId, `${field}.requestId`);
  const viewId = checkClientId(record.viewId, `${field}.viewId`);
  if (!viewIds.has(viewId)) fail("STORAGE_BAD_REQUEST", `${field} references unknown view ${viewId}.`);
  const conceptId = checkClientId(record.conceptId, `${field}.conceptId`);
  if (!conceptIds.has(conceptId)) fail("STORAGE_BAD_REQUEST", `${field} references unknown concept ${conceptId}.`);
  checkString(record.conceptText, `${field}.conceptText`, 120);
  if (!ITEM_STATUSES.has(record.status as string)) {
    fail("STORAGE_BAD_REQUEST", `${field}.status is not a known item status.`);
  }
  // Full parsed objects live in immutable detection items; the session keeps
  // the slim status record so saves stay small.
  if (!Array.isArray(record.objects) || (record.objects as unknown[]).length > 0) {
    fail(
      "STORAGE_BAD_REQUEST",
      `${field}.objects must be empty in stored sessions; parsed geometry lives in detection items.`,
    );
  }
  const model = record.model;
  if (model !== null) checkString(model, `${field}.model`, 120);
  const error = record.error;
  if (error !== null) checkString(error, `${field}.error`, 2000);
  for (const counter of ["attempts"] as const) {
    const entry = record[counter];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      fail("STORAGE_BAD_REQUEST", `${field}.${counter} must be a non-negative integer.`);
    }
  }
  for (const flag of ["truncated", "imported", "resultSaved", "registered"] as const) {
    if (typeof record[flag] !== "boolean") fail("STORAGE_BAD_REQUEST", `${field}.${flag} must be a boolean.`);
  }
  const invalidDiscarded = record.invalidDiscarded;
  if (typeof invalidDiscarded !== "number" || !Number.isSafeInteger(invalidDiscarded) || invalidDiscarded < 0) {
    fail("STORAGE_BAD_REQUEST", `${field}.invalidDiscarded must be a non-negative integer.`);
  }
  for (const stamp of ["startedAt", "finishedAt"] as const) {
    if (record[stamp] !== null) checkIsoDate(record[stamp], `${field}.${stamp}`);
  }
  const artifactId = record.artifactId;
  if (artifactId !== null && artifactId !== undefined) {
    if (typeof artifactId !== "string" || !/^[0-9a-f]{24}$/.test(artifactId)) {
      fail("STORAGE_BAD_REQUEST", `${field}.artifactId must be a stored evidence ID or null.`);
    }
  }
  const supersedes = record.supersedes;
  if (supersedes !== null && supersedes !== undefined) checkClientId(supersedes, `${field}.supersedes`);
}

export interface ValidatedSession {
  session: Record<string, unknown>;
  artifactIds: string[];
}

export function validateSessionInput(body: unknown): ValidatedSession {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Session body must be an object.");
  const record = body as Record<string, unknown>;
  checkSchemaVersion(record.schemaVersion);
  checkJsonBytes(body, SESSION_JSON_BYTES_MAX, "Session payload");
  if (record.mode !== "manual") {
    fail("SESSION_MODE_NOT_PERSISTED", "Only manual sessions persist; demo sessions stay memory-only.");
  }
  const context = record.context;
  if (!isRecord(context)) fail("STORAGE_BAD_REQUEST", "Session context must be an object.");
  const contextRecord = context as Record<string, unknown>;
  checkClientId(contextRecord.streetId, "context.streetId");
  checkString(contextRecord.streetDisplayName, "context.streetDisplayName", 300);
  if (!STREET_SOURCES.has(contextRecord.streetSource as string)) {
    fail("STORAGE_BAD_REQUEST", "context.streetSource is not a known street source.");
  }
  const streetSource = contextRecord.streetSource as string;
  if (!WORKFLOW_STEPS.has(record.activeStep as string)) {
    fail("STORAGE_BAD_REQUEST", "activeStep is not a known workflow step.");
  }
  const observations = record.observations;
  const assets = record.assets;
  const views = record.views;
  if (!isRecord(observations) || !isRecord(assets) || !isRecord(views)) {
    fail("STORAGE_BAD_REQUEST", "Session needs observations, assets, and views objects.");
  }
  const observationsRecord = observations as Record<string, unknown>;
  const assetsRecord = assets as Record<string, unknown>;
  const viewsRecord = views as Record<string, unknown>;
  if (Object.keys(observationsRecord).length > 5000 || Object.keys(assetsRecord).length > 2000) {
    fail("STORAGE_RECORD_LIMIT", "Session holds too many observations/assets; split the work.");
  }
  const observationIds = new Set(Object.keys(observationsRecord));
  const assetIds = new Set(Object.keys(assetsRecord));
  const viewIds = new Set(Object.keys(viewsRecord));
  for (const [id, entry] of Object.entries(viewsRecord)) {
    if ((entry as Record<string, unknown>).viewId !== id) {
      fail("STORAGE_BAD_REQUEST", `View key ${id} does not match its viewId.`);
    }
    checkView(entry, `views.${id}`);
  }
  for (const [id, entry] of Object.entries(observationsRecord)) {
    if ((entry as Record<string, unknown>).id !== id) {
      fail("STORAGE_BAD_REQUEST", `Observation key ${id} does not match its id.`);
    }
    checkObservation(entry, `observations.${id}`, "manual", viewIds);
  }
  for (const [id, entry] of Object.entries(assetsRecord)) {
    if ((entry as Record<string, unknown>).id !== id) {
      fail("STORAGE_BAD_REQUEST", `Asset key ${id} does not match its id.`);
    }
    checkAsset(entry, `assets.${id}`, "manual", streetSource, observationIds, assetIds);
  }
  for (const [list, ids, what] of [
    [record.obsOrder, observationIds, "obsOrder"],
    [record.assetOrder, assetIds, "assetOrder"],
    [record.viewOrder, viewIds, "viewOrder"],
  ] as const) {
    if (!Array.isArray(list)) fail("STORAGE_BAD_REQUEST", `${what} must be an array.`);
    for (const entry of list as unknown[]) {
      if (typeof entry !== "string" || !ids.has(entry)) {
        fail("STORAGE_BAD_REQUEST", `${what} references unknown id ${JSON.stringify(entry)}.`);
      }
    }
  }
  const concepts = record.concepts;
  if (!Array.isArray(concepts) || (concepts as unknown[]).length > 12) {
    fail("STORAGE_BAD_REQUEST", "concepts must be an array of at most 12 entries.");
  }
  const conceptIds = new Set<string>();
  for (const [index, entry] of (concepts as unknown[]).entries()) {
    if (!isRecord(entry)) fail("STORAGE_BAD_REQUEST", `concepts[${index}] must be an object.`);
    const concept = entry as Record<string, unknown>;
    conceptIds.add(checkClientId(concept.id, `concepts[${index}].id`));
    checkString(concept.text, `concepts[${index}].text`, 120);
  }
  const runs = record.runs;
  if (!Array.isArray(runs) || (runs as unknown[]).length > 500) {
    fail("STORAGE_BAD_REQUEST", "runs must be an array of at most 500 entries.");
  }
  for (const [index, entry] of (runs as unknown[]).entries()) {
    if (!isRecord(entry)) fail("STORAGE_BAD_REQUEST", `runs[${index}] must be an object.`);
    const run = entry as Record<string, unknown>;
    checkClientId(run.runId, `runs[${index}].runId`);
    if (!Array.isArray(run.items) || (run.items as unknown[]).length > 60) {
      fail("STORAGE_BAD_REQUEST", `runs[${index}].items must be an array of at most 60 entries.`);
    }
    for (const [itemIndex, item] of (run.items as unknown[]).entries()) {
      checkRunItem(item, `runs[${index}].items[${itemIndex}]`, viewIds, conceptIds);
    }
  }
  return { session: record, artifactIds: collectArtifactIds(record) };
}

// ---------------------------------------------------------------------------
// Detection items (immutable inference records with attempt links)
// ---------------------------------------------------------------------------

export interface ValidatedItemRegistration {
  runId: string;
  itemId: string;
  kind: "test" | "batch";
  viewId: string;
  conceptId: string;
  prompt: string;
  categoryIntent: "pole" | "luminaire";
  model: string | null;
  viewDescriptor: Record<string, unknown>;
  artifactId: string;
  supersedes: string | null;
}

export function validateItemRegistration(body: unknown): ValidatedItemRegistration {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Item registration body must be an object.");
  const record = body as Record<string, unknown>;
  checkSchemaVersion(record.schemaVersion);
  checkJsonBytes(body, 64 * 1024, "Item registration");
  const kind = record.kind;
  if (kind !== "test" && kind !== "batch") {
    fail("STORAGE_BAD_REQUEST", "Item kind must be test or batch.");
  }
  const categoryIntent = record.categoryIntent;
  if (categoryIntent !== "pole" && categoryIntent !== "luminaire") {
    fail("STORAGE_BAD_REQUEST", "Item categoryIntent must be pole or luminaire.");
  }
  if (!isRecord(record.viewDescriptor)) {
    fail("STORAGE_BAD_REQUEST", "Item viewDescriptor must be an object.");
  }
  const artifactId = checkString(record.artifactId, "artifactId", 24);
  if (!/^[0-9a-f]{24}$/.test(artifactId)) {
    fail("STORAGE_BAD_REQUEST", "Item artifactId must be a stored evidence ID.");
  }
  const model = record.model;
  if (model !== null && model !== undefined) checkString(model, "model", 120);
  const supersedes = record.supersedes;
  if (supersedes !== null && supersedes !== undefined) checkClientId(supersedes, "supersedes");
  return {
    runId: checkClientId(record.runId, "runId"),
    itemId: checkClientId(record.itemId, "itemId"),
    kind,
    viewId: checkClientId(record.viewId, "viewId"),
    conceptId: checkClientId(record.conceptId, "conceptId"),
    prompt: checkString(record.prompt, "prompt", 120),
    categoryIntent,
    model: (model ?? null) as string | null,
    viewDescriptor: record.viewDescriptor as Record<string, unknown>,
    artifactId,
    supersedes: (supersedes ?? null) as string | null,
  };
}

export type ItemTerminalStatus = "succeeded" | "empty" | "failed" | "cancelled";

export interface ValidatedDetectionObject {
  providerObjectId: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number | null;
  mask: {
    svgPath: string;
    width: number;
    height: number;
    bounds: { left: number; top: number; right: number; bottom: number };
  } | null;
}

function checkDetectionObject(value: unknown, field: string): ValidatedDetectionObject {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", `${field} must be a detection object.`);
  const record = value as Record<string, unknown>;
  const confidence = record.confidence;
  if (confidence !== null && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
    fail("STORAGE_BAD_REQUEST", `${field}.confidence must be within 0..1 or null.`);
  }
  const mask = record.mask;
  if (mask !== null) {
    if (!isRecord(mask)) fail("STORAGE_BAD_REQUEST", `${field}.mask must be an object or null.`);
    const maskRecord = mask as Record<string, unknown>;
    const svgPath = checkString(maskRecord.svgPath, `${field}.mask.svgPath`, MASK_PATH_BYTES_MAX);
    if (svgPath.length === 0) fail("STORAGE_BAD_REQUEST", `${field}.mask.svgPath must not be empty.`);
    for (const dimension of ["width", "height"] as const) {
      const entry = maskRecord[dimension];
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0 || entry > 32768) {
        fail("STORAGE_BAD_REQUEST", `${field}.mask.${dimension} must be a positive safe integer.`);
      }
    }
    const bounds = maskRecord.bounds;
    if (!isRecord(bounds)) fail("STORAGE_BAD_REQUEST", `${field}.mask.bounds must be an object.`);
    for (const edge of ["left", "top", "right", "bottom"] as const) {
      checkFiniteNumber((bounds as Record<string, unknown>)[edge], `${field}.mask.bounds.${edge}`);
    }
  }
  return {
    providerObjectId: checkClientId(record.providerObjectId, `${field}.providerObjectId`),
    box: checkNormalizedRect(record.box, `${field}.box`),
    confidence: confidence as number | null,
    mask: mask as ValidatedDetectionObject["mask"],
  };
}

export interface ValidatedItemCompletion {
  status: ItemTerminalStatus;
  objects: ValidatedDetectionObject[];
  model: string | null;
  truncated: boolean;
  invalidDiscarded: number;
  error: string | null;
  providerRequestId: string | null;
  finishedAt: string;
}

export function validateItemCompletion(body: unknown): ValidatedItemCompletion {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Item completion body must be an object.");
  const record = body as Record<string, unknown>;
  checkSchemaVersion(record.schemaVersion);
  checkJsonBytes(body, ITEM_JSON_BYTES_MAX, "Item completion");
  const status = record.status;
  if (status !== "succeeded" && status !== "empty" && status !== "failed" && status !== "cancelled") {
    fail("STORAGE_BAD_REQUEST", "Item completion status must be succeeded, empty, failed, or cancelled.");
  }
  if (!Array.isArray(record.objects)) fail("STORAGE_BAD_REQUEST", "Item completion objects must be an array.");
  const objects = record.objects as unknown[];
  if (objects.length > ITEM_OBJECTS_MAX) {
    fail(
      "STORAGE_RECORD_LIMIT",
      `Item completion holds ${objects.length} objects, above the ${ITEM_OBJECTS_MAX} cap.`,
    );
  }
  if (status === "succeeded" && objects.length === 0) {
    fail("STORAGE_BAD_REQUEST", "A succeeded item must carry at least one object.");
  }
  if ((status === "empty" || status === "failed" || status === "cancelled") && objects.length > 0) {
    fail("STORAGE_BAD_REQUEST", `A ${status} item must not carry objects.`);
  }
  const model = record.model;
  if (model !== null) checkString(model, "model", 120);
  if (typeof record.truncated !== "boolean") {
    fail("STORAGE_BAD_REQUEST", "Item completion truncated must be a boolean.");
  }
  const invalidDiscarded = record.invalidDiscarded;
  if (typeof invalidDiscarded !== "number" || !Number.isSafeInteger(invalidDiscarded) || invalidDiscarded < 0) {
    fail("STORAGE_BAD_REQUEST", "Item completion invalidDiscarded must be a non-negative integer.");
  }
  const error = record.error;
  if (error !== null) checkString(error, "error", 2000);
  const providerRequestId = record.providerRequestId;
  if (providerRequestId !== null && providerRequestId !== undefined) {
    checkClientId(providerRequestId, "providerRequestId");
  }
  return {
    status: status as ItemTerminalStatus,
    objects: objects.map((entry, index) => checkDetectionObject(entry, `objects[${index}]`)),
    model: (model ?? null) as string | null,
    truncated: record.truncated as boolean,
    invalidDiscarded: invalidDiscarded as number,
    error: (error ?? null) as string | null,
    providerRequestId: (providerRequestId ?? null) as string | null,
    finishedAt: checkIsoDate(record.finishedAt, "finishedAt"),
  };
}

// ---------------------------------------------------------------------------
// Evidence artifacts (immutable raster bytes in GridFS, keyed by content hash)
// ---------------------------------------------------------------------------

export type ArtifactMime = "image/png" | "image/jpeg";

export interface ValidatedArtifactMeta {
  contentHash: string;
  mime: ArtifactMime;
  width: number;
  height: number;
  byteLength: number;
  imageId: string;
  viewId: string | null;
  orientation: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  attribution: string;
  sourceUrl: string;
}

export function validateArtifactMeta(value: unknown): ValidatedArtifactMeta {
  if (!isRecord(value)) fail("STORAGE_BAD_REQUEST", "Artifact meta must be an object.");
  const record = value as Record<string, unknown>;
  const contentHash = checkString(record.contentHash, "meta.contentHash", 64);
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    fail("STORAGE_BAD_REQUEST", "meta.contentHash must be a 64-hex SHA-256 hash.");
  }
  const mime = record.mime;
  if (mime !== "image/png" && mime !== "image/jpeg") {
    fail("STORAGE_BAD_REQUEST", "meta.mime must be image/png or image/jpeg.");
  }
  for (const dimension of ["width", "height"] as const) {
    const entry = record[dimension];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0 || entry > 32768) {
      fail("STORAGE_BAD_REQUEST", `meta.${dimension} must be a positive safe integer.`);
    }
  }
  const byteLength = record.byteLength;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
    fail("STORAGE_BAD_REQUEST", "meta.byteLength must be a positive safe integer.");
  }
  if (byteLength > ARTIFACT_BYTES_MAX) {
    fail(
      "STORAGE_PAYLOAD_TOO_LARGE",
      `Artifact is ${(byteLength / 1024 / 1024).toFixed(2)} MiB, above the ${(ARTIFACT_BYTES_MAX / 1024 / 1024).toFixed(0)} MiB cap.`,
    );
  }
  const orientation = record.orientation;
  if (typeof orientation !== "number" || !Number.isSafeInteger(orientation) || orientation < 1 || orientation > 8) {
    fail("STORAGE_BAD_REQUEST", "meta.orientation must be an integer 1..8.");
  }
  const viewId = record.viewId;
  if (viewId !== null && viewId !== undefined) checkClientId(viewId, "meta.viewId");
  const crop = record.crop;
  const sourceUrl = checkString(record.sourceUrl, "meta.sourceUrl", 2000);
  if (!/^https?:\/\//.test(sourceUrl)) {
    fail("STORAGE_BAD_REQUEST", "meta.sourceUrl must be an http(s) URL.");
  }
  return {
    contentHash,
    mime: mime as ArtifactMime,
    width: record.width as number,
    height: record.height as number,
    byteLength: byteLength as number,
    imageId: checkClientId(record.imageId, "meta.imageId"),
    viewId: (viewId ?? null) as string | null,
    orientation: orientation as number,
    crop: crop === null || crop === undefined ? null : checkNormalizedRect(crop, "meta.crop"),
    attribution: checkString(record.attribution, "meta.attribution", 500),
    sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// Reviewed results (immutable versioned snapshots)
// ---------------------------------------------------------------------------

export interface ValidatedResultInput {
  resultId: string;
  sessionRevision: number;
  inputRevision: number | null;
  counts: Record<string, unknown>;
  limitations: string[];
  provenance: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  artifactIds: string[];
}

export function validateResultInput(body: unknown): ValidatedResultInput {
  if (!isRecord(body)) fail("STORAGE_BAD_REQUEST", "Result body must be an object.");
  const record = body as Record<string, unknown>;
  checkSchemaVersion(record.schemaVersion);
  checkJsonBytes(body, RESULT_JSON_BYTES_MAX, "Result payload");
  if (!isRecord(record.counts) || !isRecord(record.provenance) || !isRecord(record.snapshot)) {
    fail("STORAGE_BAD_REQUEST", "Result needs counts, provenance, and snapshot objects.");
  }
  const inputRevision = record.inputRevision;
  if (inputRevision !== null && (typeof inputRevision !== "number" || !Number.isSafeInteger(inputRevision))) {
    fail("STORAGE_BAD_REQUEST", "Result inputRevision must be a safe integer or null.");
  }
  const artifactIds = record.artifactIds;
  if (!Array.isArray(artifactIds) || (artifactIds as unknown[]).length > 200) {
    fail("STORAGE_BAD_REQUEST", "Result artifactIds must be an array of at most 200 entries.");
  }
  for (const entry of artifactIds as unknown[]) {
    if (typeof entry !== "string" || !/^[0-9a-f]{24}$/.test(entry)) {
      fail("STORAGE_BAD_REQUEST", "Result artifactIds must be stored evidence IDs.");
    }
  }
  return {
    resultId: checkClientId(record.resultId, "resultId"),
    sessionRevision: checkRevision(record.sessionRevision, "sessionRevision"),
    inputRevision: (inputRevision ?? null) as number | null,
    counts: record.counts as Record<string, unknown>,
    limitations: checkStringArray(record.limitations, "limitations", 50, 500),
    provenance: record.provenance as Record<string, unknown>,
    snapshot: record.snapshot as Record<string, unknown>,
    artifactIds: (artifactIds as unknown[]) as string[],
  };
}
