import type { StreetWorkItem } from "../../lib/api";

/** Best-effort readable highway label; raw values pass through unchanged. */
export function highwayLabel(highway: string): string {
  return highway
    .split("_")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Distinct highway types across a street's segments, in first-seen order. */
export function streetHighwayTypes(street: StreetWorkItem): string[] {
  const types: string[] = [];
  for (const segment of street.segments) {
    if (!types.includes(segment.highway)) types.push(segment.highway);
  }
  return types.map(highwayLabel);
}

export function formatStreetLength(lengthM: number): string {
  if (!Number.isFinite(lengthM) || lengthM < 0) return "Unknown length";
  if (lengthM < 1000) return `${Math.round(lengthM)} m in RoI`;
  return `${(lengthM / 1000).toFixed(2)} km in RoI`;
}
