# OpenStreetLightMapper

**AI-assisted public-lighting inventory** — Milestone 1: region search.

OpenStreetLightMapper is an open-source system intended to convert street-level imagery
and map geometry into an auditable public-lighting asset inventory and a
roadway-lighting dataset suitable for subsequent EN 13201 workflows.

> This milestone delivers a geographic workspace with region-of-interest search: draw
> a region on the OpenStreetMap panel, find Mapillary image records inside it via
> the backend, and inspect selected imagery in the MapillaryJS viewer. It is **not**
> an inventory system yet and is **not** EN 13201 compliant or standards-certified.
> See [What is deferred](#what-is-deferred).

Specifications: [docs/specs/01_OpenStreetLightMapper-Kickoff.md](docs/specs/01_OpenStreetLightMapper-Kickoff.md),
[docs/specs/02_initial_tailoring.md](docs/specs/02_initial_tailoring.md)

## Requirements

- **Node.js** `>= 20.19.0` (developed and verified with `v22.19.0`; Node 22 LTS recommended)
- **npm** 10+ (lockfile is committed; install with `npm install`)
- No MongoDB instance required for this milestone.
- No Mapillary token required to open the app, draw regions, or use the map. A
  browser viewer token enables imagery; a server search token enables region search
  (see [Configuration](#configuration)).

## Quick start (Windows PowerShell)

```powershell
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in a browser.

- Frontend (Vite): `http://localhost:5173`
- Backend health (via Vite proxy): `http://localhost:5173/api/health`
- Backend direct: `http://localhost:3001/api/health`

## Commands

| Command            | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `npm run dev`      | Start frontend + backend together (via `concurrently`)    |
| `npm run dev:web`  | Start only the Vite frontend                              |
| `npm run dev:server` | Start only the Express backend (tsx watch)              |
| `npm run build`    | Production build (geo package, then web + server)         |
| `npm run typecheck`| `tsc --noEmit` in all workspaces                          |
| `npm run lint`     | ESLint over the whole repository                          |
| `npm run test`     | Focused unit tests in all workspaces (Node test runner)   |

All commands run from the repository root and work from Windows PowerShell.

## Configuration

Copy the example files and adjust (never commit real secrets):

```powershell
Copy-Item apps\web\.env.example apps\web\.env
Copy-Item apps\server\.env.example apps\server\.env
```

| Variable                        | Where          | Purpose                                                        |
| ------------------------------- | -------------- | -------------------------------------------------------------- |
| `VITE_MAPILLARY_CLIENT_TOKEN`   | `apps/web/.env`| Mapillary **client** access token for the browser viewer       |
| `VITE_OSM_TILE_URL` (optional)  | `apps/web/.env`| Override for the OSM raster tile URL                            |
| `VITE_OSM_ATTRIBUTION` (optional) | `apps/web/.env` | Override for the basemap attribution string                 |
| `PORT`                          | `apps/server/.env` | Express listen port (default `3001`)                        |
| `MAPILLARY_ACCESS_TOKEN`        | `apps/server/.env` | Mapillary access token for server-side region search        |
| `MONGODB_URI`                   | `apps/server/.env` | **Reserved, unused.** No connection is made.                |

Get a Mapillary client token from the
[Mapillary developer dashboard](https://www.mapillary.com/dashboard/developers)
(sign in → register an application → client access token). The same suitable
client token may be configured in both places, but they are independent settings:
a server-only search token is not available to the viewer, and a configured viewer
does not prove server search is configured.

> **Security note:** every `VITE_*` value is embedded in the public browser bundle.
> Use only a token intended for client-side use; never put a private application
> secret in a `VITE_*` variable. Future Meta model calls and private credentials
> must live on the Express server.

## Region search

1. Navigate the map to a street or small district.
2. Draw one rectangle or polygon with the map toolbar, or commit the current map
   view (`Use current map view` — keyboard-accessible via Leaflet's map keyboard
   navigation). `Escape` cancels a draft.
3. Check the sidebar for shape type, approximate geodesic area, and readiness.
   Regions are limited to **25 km²** and a provider bounding box strictly below
   **0.01 square degrees**; oversized selections stay visible with an error so you
   can redraw them.
4. Click `Find Mapillary images`. Returned image camera positions appear as map
   markers plus a paged result list (50 per page, newest captures first).
5. Select a marker or list row to load that image in the MapillaryJS viewer. Manual
   image-ID entry remains available as a testing option.

Search results are the images returned for that query only — never complete
coverage, never proof about streetlights. Camera positions are not lamp positions.

## Architecture

```text
apps/
  web/                      React + Vite + TypeScript
    src/
      components/           Header, backend connection indicator
      features/map/         OSM panel + region toolbar, drawing, result layers
      features/street-imagery/ MapillaryJS viewer (selection + manual loading)
      features/search/      Result list + client search helpers
      features/settings/    Region/search sidebar + config status
      hooks/                Backend health, region/search orchestration
      lib/                  Config, API clients, shared types
    .env.example
  server/                   Node.js + Express + TypeScript
    src/
      app.ts                Express app (health, search route, 404 handler)
      routes/               POST /api/mapillary/images/search
      mapillary.ts          Bounded provider client (one bbox query, 30 s cap)
      search.ts             Record normalization and RoI filtering
      index.ts              Listen on PORT
    .env.example
packages/
  geo/                      Shared WGS84 validation/measurement (no dependencies)
```

- **Frontend** (`apps/web`): React 19, Vite 6, React-Leaflet 5 + Leaflet 1.9 with an
  OpenStreetMap basemap, and the official MapillaryJS 4 viewer. Plain CSS, no UI
  framework. Drawing and region validation work fully offline of any token or
  backend.
- **Backend** (`apps/server`): Express app exposing `GET /api/health` (with a
  `providers.mapillarySearch.configured` flag) and
  `POST /api/mapillary/images/search`, which validates the submitted GeoJSON
  polygon, runs one bounded Mapillary bbox query, filters points to the region,
  and returns a normalized envelope with diagnostic counts. The Vite dev server
  proxies `/api` to it.
- **Shared geo** (`packages/geo`): single source of truth for region validation,
  geodesic area, and point-in-polygon, used identically by client and server.
- **Database boundary (pending):** MongoDB/Mongoose persistence is deferred. The
  server establishes **no** database connection, creates no schemas or collections,
  and the health response reports no database state. `MONGODB_URI` is reserved in
  `apps/server/.env.example` for the future milestone.

The workspace layout is a large central area (Map ≈60% / street imagery ≈40%) with
an ~300 px settings sidebar; panels stack at narrow widths. The header's backend
indicator is derived live from `/api/health` (connected / checking / unavailable +
retry) — a stopped backend produces a clear, recoverable state instead of a crash.

The map marker shows the **Mapillary camera position** when viewer metadata supplies
coordinates — never an inferred lamp location. Failed or missing imagery never moves
the map to fabricated coordinates.

## Current limitations

- One bounded bbox query per search (`limit=2000`); capped searches warn instead of
  paginating, and large districts need smaller selections. No automatic subdivision.
- Without `VITE_MAPILLARY_CLIENT_TOKEN`, the imagery panel shows a "Mapillary is
  not configured" hint; without `MAPILLARY_ACCESS_TOKEN`, search reports its own
  configuration state. Map, drawing, and settings keep working regardless.
- No persistence: regions, results, and viewer state are in-memory only.
- Live Mapillary search/viewer validation needs real tokens and was exercised
  against the documented APIs plus mocked provider fixtures; see the milestone
  report for what was verified live.

## Attribution and terms

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
  available under the Open Database License. Standard OSM raster tiles are used only
  for modest interactive development viewing, per the
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
  No bulk download, prefetch, or offline tile cache is implemented.
- Street imagery via Mapillary (Meta); the MapillaryJS viewer retains its provider
  attribution and controls. Imagery use is subject to Mapillary's terms — the
  repository license does not license third-party imagery or map data.

## Future inventory principles (documented, not implemented)

Recorded here as product direction for later milestones; none of this is built yet:

- Separate physical poles, attached luminaires, road segments, imagery observations,
  and reviewed asset records.
- WGS84 coordinates for exchange (ordering stated explicitly); metric/geodesic
  distance methods — never arithmetic on lat/lng degrees as metres.
- Record units; distinguish estimated / measured / manually supplied / unknown.
  Unknown is not zero.
- Preserve image IDs, source links, capture dates, inference method/model version,
  uncertainty, and review status; multiple sightings may describe one asset.
- Mounting height and pole location need defensible geometric evidence or manual
  measurement; one uncalibrated image is not an exact measuring instrument.
- Model pole spacing along road segments; distinguish single-sided, opposite,
  staggered, central, mixed, and unknown arrangements when specified.
- Keep detected candidates separate from human-confirmed assets; track coverage
  gaps and stale observations. Never present incomplete coverage as proof of absence.
- Verify provider permissions for automated retrieval, retention, AI processing,
  and redistribution before implementing collection.
- Keep the eventual EN 13201 standards mapping versioned and explicit.

## What is deferred

AI detection, automated collection, satellite/aerial integration, district
boundaries, geocoding search, bulk download, vector-tile ingestion, automatic
subdivision, object detections, pole/luminaire records, height/spacing calculations,
EN 13201 assessment, exports, persistence, authentication, payments, cloud
deployment, and a general settings framework — all intentionally absent. Coverage
overlays and exhaustive large-area retrieval need a separately specified strategy.

## License

MIT — see [LICENSE](LICENSE) (© 2026 Viktor Zsellér, original project code).
Dependencies and third-party imagery/map data retain their own licenses and terms.
