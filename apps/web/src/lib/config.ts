export const MAPILLARY_CLIENT_TOKEN: string =
  (import.meta.env.VITE_MAPILLARY_CLIENT_TOKEN as string | undefined)?.trim() ?? "";

export const OSM_TILE_URL: string =
  (import.meta.env.VITE_OSM_TILE_URL as string | undefined)?.trim() ||
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const OSM_ATTRIBUTION: string =
  (import.meta.env.VITE_OSM_ATTRIBUTION as string | undefined)?.trim() ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const OSM_TILE_URL_IS_DEFAULT: boolean =
  !((import.meta.env.VITE_OSM_TILE_URL as string | undefined)?.trim() ?? "");
