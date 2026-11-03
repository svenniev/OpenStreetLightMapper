import type {
  InventoryMode,
  InventoryObservation,
  NormalizedRect,
  ObservationCategory,
} from "./inventoryTypes";

/**
 * Isolated demo content: a sample street, three schematic viewpoints, and a
 * deterministic observation set. Synthetic IDs only (`demo-*`); no Mapillary
 * IDs, capture dates, or attribution are invented.
 *
 * Fixture IDs are neutral sequence numbers: they deliberately do not reveal
 * which observations belong together. Expected associations for tests live in
 * test files, never here.
 */

export const DEMO_STREET_ID = "demo-street";
export const DEMO_STREET_NAME = "Demo Street";

export interface DemoImage {
  id: string;
  label: string;
}

export const DEMO_IMAGES: DemoImage[] = [
  { id: "demo-image-01", label: "Main Street — east view" },
  { id: "demo-image-02", label: "Main Street — west view" },
  { id: "demo-image-03", label: "Side alley — north view" },
];

export type DemoScenario = "happy" | "empty" | "error";

export const DEMO_SCENARIO_LABELS: Record<DemoScenario, string> = {
  happy: "Happy path",
  empty: "Empty result",
  error: "Detection error",
};

export const DEMO_ERROR_MESSAGE =
  "Demo detection failed: the sample adapter reported an error. Retry or pick another scenario.";

interface FixtureRow {
  imageId: string;
  category: ObservationCategory;
  description: string;
  region: NormalizedRect;
}

const FIXTURES: FixtureRow[] = [
  { imageId: "demo-image-01", category: "pole", description: "Tall pole with two arms", region: { x: 0.15, y: 0.217, w: 0.15, h: 0.45 } },
  { imageId: "demo-image-01", category: "luminaire", description: "Upper lamp head", region: { x: 0.255, y: 0.27, w: 0.05, h: 0.033 } },
  { imageId: "demo-image-01", category: "luminaire", description: "Lower lamp head", region: { x: 0.255, y: 0.327, w: 0.05, h: 0.033 } },
  { imageId: "demo-image-01", category: "pole", description: "Single-arm pole", region: { x: 0.6, y: 0.267, w: 0.145, h: 0.4 } },
  { imageId: "demo-image-02", category: "pole", description: "Tall pole with two arms", region: { x: 0.59, y: 0.233, w: 0.15, h: 0.433 } },
  { imageId: "demo-image-02", category: "pole", description: "Single-arm pole", region: { x: 0.28, y: 0.287, w: 0.135, h: 0.383 } },
  { imageId: "demo-image-02", category: "luminaire", description: "Upper lamp head", region: { x: 0.595, y: 0.283, w: 0.05, h: 0.033 } },
  { imageId: "demo-image-02", category: "uncertain", description: "Distant dark shape, unclear", region: { x: 0.856, y: 0.475, w: 0.065, h: 0.113 } },
  { imageId: "demo-image-03", category: "pole", description: "Tall pole with two arms", region: { x: 0.43, y: 0.217, w: 0.155, h: 0.45 } },
  { imageId: "demo-image-03", category: "luminaire", description: "Lower lamp head", region: { x: 0.53, y: 0.327, w: 0.05, h: 0.033 } },
  { imageId: "demo-image-03", category: "pole", description: "Possible pole beside alley", region: { x: 0.66, y: 0.35, w: 0.21, h: 0.317 } },
];

/**
 * Deterministic demo detection adapter: the only implemented observation
 * producer. No model runs; fixtures are filtered by selected image.
 */
export function runDemoDetection(
  selectedImageIds: string[],
  scenario: DemoScenario,
  mode: InventoryMode = "demo",
): InventoryObservation[] {
  if (scenario === "error") throw new Error(DEMO_ERROR_MESSAGE);
  if (scenario === "empty") return [];
  const selected = new Set(selectedImageIds);
  const observations: InventoryObservation[] = [];
  FIXTURES.forEach((row, fixtureIndex) => {
    if (!selected.has(row.imageId)) return;
    observations.push({
      id: `demo-obs-${String(fixtureIndex + 1).padStart(2, "0")}`,
      imageId: row.imageId,
      viewId: null,
      category: row.category,
      description: row.description,
      imageRegion: { ...row.region },
      mask: null,
      maskStale: false,
      origin: "demo",
      provenance: null,
      mode,
      decision: "pending",
      note: "",
    });
  });
  return observations;
}

/** All fixture observations (handy for tests building sessions directly). */
export function allDemoObservations(): InventoryObservation[] {
  return runDemoDetection(
    DEMO_IMAGES.map((image) => image.id),
    "happy",
  );
}
