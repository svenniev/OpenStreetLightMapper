# OpenStreetLightMapper

**AI-assisted public-lighting inventory** — Milestone 6: local database persistence
and UI cleanup.

OpenStreetLightMapper is an open-source system intended to convert street-level imagery
and map geometry into an auditable public-lighting asset inventory and a
roadway-lighting dataset suitable for subsequent EN 13201 workflows.

> This milestone persists work in named local workspaces: regions, streets,
> imagery selections, inventory sessions, detection evidence, and immutable
> reviewed results all survive refresh and restart via a loopback-only MongoDB.
> Detection still runs on Mapillary photographs (SAM 3.1 text prompts, or
> manual-only without a model key), and nothing here is EN 13201 compliant or
> standards-certified. See [What is deferred](#what-is-deferred).

Specifications: [docs/specs/01_OpenStreetLightMapper-Kickoff.md](docs/specs/01_OpenStreetLightMapper-Kickoff.md),
[docs/specs/02_initial_tailoring.md](docs/specs/02_initial_tailoring.md),
[docs/specs/03_workflow.md](docs/specs/03_workflow.md),
[docs/specs/04_detect_to_display_inventory.md](docs/specs/04_detect_to_display_inventory.md),
[docs/specs/05_detect_to_display_inventory_2.md](docs/specs/05_detect_to_display_inventory_2.md),
[docs/specs/06_init_database_UI_clean.md](docs/specs/06_init_database_UI_clean.md)

## Requirements

- **Node.js** `>= 20.19.0` (developed and verified with `v22.19.0`; Node 22 LTS recommended)
- **npm** 10+ (lockfile is committed; install with `npm install`)
- **Docker Desktop** with Compose, for the local MongoDB container that stores
  workspaces (loopback-only, no authentication — see
  [infra/database/README.md](infra/database/README.md)). Without it the app opens
  but reports **Not saved — local database unavailable**.
- No Mapillary token required to open the app, draw regions, or use the map. A
  browser viewer token enables imagery; a server search token enables region search
  (see [Configuration](#configuration)).
- No model key required to review and annotate photographs manually. `MODEL_API_KEY`
  enables SAM text-prompt detection (test + batch); without it the workflow stays
  manual-only.

## Quick start (Windows PowerShell)

```powershell
npm install
powershell -ExecutionPolicy Bypass -File infra\database\start.ps1
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in a browser. Create a
workspace from the header menu — the URL carries its ID, so refresh and restart
reopen the same workspace from the server.

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
| `OVERPASS_URL` (optional)       | `apps/server/.env` | Overpass API endpoint (default `https://overpass-api.de/api/interpreter`) |
| `MODEL_API_KEY`                 | `apps/server/.env` | Meta Model API key for server-side SAM detection (test + batch) |
| `SAM_MODEL` (optional)          | `apps/server/.env` | SAM model name (default `sam-3.1`)                          |
| `SAM_TIMEOUT_MS` (optional)     | `apps/server/.env` | Per-inference deadline in ms, 10 s–300 s (default `120000`) |
| `MONGODB_URI`                   | `apps/server/.env` | Local MongoDB connection (`mongodb://127.0.0.1:27018/openstreetlightmapper`) |

Get a Mapillary client token from the
[Mapillary developer dashboard](https://www.mapillary.com/dashboard/developers)
(sign in → register an application → client access token). The same suitable
client token may be configured in both places, but they are independent settings:
a server-only search token is not available to the viewer, and a configured viewer
does not prove server search is configured.

> **Security note:** every `VITE_*` value is embedded in the public browser bundle.
> Use only a token intended for client-side use; never put a private application
> secret in a `VITE_*` variable. Meta model calls and the `MODEL_API_KEY`
> credential live on the Express server only — the key never enters the browser
> bundle, logs, or responses. Explicit Test/Detect work transmits the selected
> image bytes to Meta and spends model credits; nothing is sent implicitly.

## Workflow

1. Navigate the map to a street or small district.
2. Draw one rectangle or polygon with the map toolbar, or commit the current map
   view (`Use current map view` — keyboard-accessible via Leaflet's map keyboard
   navigation). `Escape` cancels a draft. Every committed region has a revision
   identity; replacing or clearing it discards dependent lists and plans.
3. Check the map panel for shape type, approximate geodesic area, and readiness.
   Regions are limited to **25 km²** and a provider bounding box strictly below
   **0.01 square degrees**; oversized selections stay visible with an error so you
   can redraw them.
4. Streets load automatically for the committed region (once per region, via the
   server-side Overpass adapter). Review the **Streets in region** panel and uncheck
   streets that should not participate; row focus highlights geometry, the checkbox
   alone controls participation. If Overpass is down, **Seed data** (next to Retry)
   builds a clearly labeled demo street from sequence positions so the workflow
   stays exercisable; a later successful fetch replaces it with real data.
5. Click `Find Mapillary sequences`. Discovery groups the returned image records by
   their real provider sequence ID; browse sequences (with type filters and capture
   dates), select one to plot its camera positions, and page its image list. The
   **Inside RoI / Whole sequence** scope toggles outside-region context points.
6. Select a map marker or list row to load that image in the MapillaryJS viewer.
   Manual image-ID entry lives under Settings → Developer tools.
7. Click `Prepare selected streets` (beside the street list) when enabled. It
   validates the current inputs and builds an immutable work plan (one work item
   per checked street, shared in-RoI image pool by reference, preserved warnings)
   — real preparation, not a simulation. Changing streets, selections, or imagery
   marks the plan stale until prepared again.
8. Optionally verify **SAM detection** in the Settings drawer: with `MODEL_API_KEY`
   configured, `Test on selected image` runs one concept on the viewer image and
   reports success (even with zero matches) or an actionable error. Only a
   successful inference proves access.
9. Open the **Inventory workflow** beside the street list for an included street
   (`Use queried images`; a seeded work area instead offers `Continue with selected
   imagery — street unverified`). In Detect, choose up to ten in-region source images
   (spread sampling available), freeze them, edit one-concept-per-request prompts,
   test one view, then batch across views × concepts. Without a model key, continue
   manual-only. Walk the five steps — Detect, Review, Group assets, Place assets,
   Inventory — to review every sighting on the analyzed photographs, group them into
   pole/luminaire assets, place them manually, finish a preview, and **Save reviewed
   result**. Saved results (server-acknowledged, immutable versions) enable that
   street's `Results` button. The schematic demo still exists under `Developer
   examples — illustrations`. Edits autosave to the open workspace (see the header
   save state); later edits open a draft while prior saved versions stay
   reproducible.

Search results are the images returned for that query only — never complete
coverage, never proof about streetlights. Camera positions are not lamp positions.
A street with no available imagery is not a street without lights.

**Previews are not inventory completion.** SAM sightings are candidates until a
human accepts, corrects (corrected output reads as SAM assisted), and groups them;
failed or cancelled calls are never zero matches, and finishing acknowledges any
incomplete processing. Unfinished session previews are clearly labeled with street
provenance, model, and processing counts; only server-acknowledged **Saved
results** count as durable reviewed inventory — and even those are not measured
asset positions, complete street coverage, or EN 13201 compliance. Completed
inventory records (measurement) remain a future stage. Preparation never downloads
full images, runs segmentation, or detects lights.

## Architecture

```text
apps/
  web/                      React + Vite + TypeScript
    src/
      components/           Header, backend connection indicator
      features/map/         OSM panel + region toolbar, drawing, sequence/street layers
      features/street-imagery/ MapillaryJS viewer (selection + manual loading)
      features/sequences/   Sequence grouping, browsing, on-demand detail hydration
      features/streets/     Street retrieval, participation list, workflow statuses
      features/preparation/ Work-plan preparation (snapshot, validation, staleness)
      features/inventory/   Source selection, SAM test/batch queue, photo review,
                            grouping, placement, inventory previews (demo + manual)
      features/results/     Result modal: completed contract + session-preview branch
      features/settings/    Action sections (map/sequences/streets) + settings drawer
                            (Providers, Local database, Developer tools)
      features/workspaces/  Workspace store (autosave, revisions, conflicts),
                            content shell, save banner, workspace menu
      hooks/                Backend health, region/search orchestration
      lib/                  Config, API + detection clients, shared types
    .env.example
  server/                   Node.js + Express + TypeScript
    src/
      app.ts                Express app (health, routes, 404 handler)
      db/                   Mongoose connection, schemas, GridFS evidence, validation
      routes/               images/search, sequences/:id/images, streets/search,
                            imagery/:id, imagery/media/:handle, detection/sam,
                            workspaces, sessions, detection items, artifacts,
                            reviewed results
      mapillary.ts          Bounded Mapillary client (shared provider transport)
      sequences.ts          Sequence membership + batched metadata hydration
      streets.ts            Overpass adapter: eligibility, clipping, grouping
      search.ts             Record normalization and RoI filtering
      imagery.ts            Image detail + bounded same-origin media proxy
      sam.ts                Hosted SAM 3.1 client (official @meta-sam/parser)
      index.ts              Listen on PORT
    .env.example
packages/
  geo/                      Shared WGS84 validation/measurement/clipping (no dependencies)
```

- **Frontend** (`apps/web`): React 19, Vite 6, React-Leaflet 5 + Leaflet 1.9 with an
  OpenStreetMap basemap, and the official MapillaryJS 4 viewer. Plain CSS, no UI
  framework. Drawing and region validation work fully offline of any token or
  backend.
- **Backend** (`apps/server`): Express app exposing `GET /api/health` (with
  `providers.mapillarySearch.configured` and `providers.samDetection` configuration
  flags — health never makes billable calls),
  `POST /api/mapillary/images/search` (one bounded Mapillary bbox query, region
  filtering, normalized envelope with diagnostic counts),
  `POST /api/mapillary/sequences/:sequenceId/images` (documented membership
  endpoint plus batched metadata hydration, in-RoI flags, honest partial counts),
  `POST /api/streets/search` (Overpass retrieval, highway eligibility,
  polygon clipping, topology-based grouping),
  `GET /api/imagery/:imageId` (on-demand photo metadata, attribution, and an
  app-owned media handle — signed provider URLs never leave the server),
  `GET /api/imagery/media/:handle` (bounded same-origin photo bytes with validated
  redirects; unknown handles fail closed), and `POST /api/detection/sam` (one
  concept on one raster: exactly one streamed SAM 3.1 call, parsed with the
  official `@meta-sam/parser`, wire dimensions verified before normalization).
  The Vite dev server proxies `/api` to it. All provider calls share one bounded
  transport family (deadline through body reading, byte caps, stable template
  errors that never leak raw provider/viewer text, credentials, or image bytes).
- **Shared geo** (`packages/geo`): single source of truth for region validation,
  geodesic area, point-in-polygon, and segment/polygon clipping with fragment
  measurement, used identically by client and server.
- **Database:** Mongoose-backed MongoDB persistence (loopback-only container, see
  [infra/database/README.md](infra/database/README.md)). Named workspaces hold the
  RoI, street/imagery selections, preparation, inventory sessions, immutable
  detection items, GridFS evidence artifacts, and immutable reviewed-result
  versions. Mutable records carry monotonic revisions; stale writes conflict
  (reload newer or save as new workspace) instead of overwriting. Health reports
  `database.state` (connected / connecting / unavailable) without credentials.

The header holds the app title, the workspace menu (New/Open/Rename), the save
state with Save now, Settings, and the backend indicator. Below it run full-width
panels in DOM order: Map + street imagery side by side, Mapillary sequences,
Streets in region (with Prepare selected streets and the inventory entry beside
the selection), then the inventory workspace. Panels stack at narrow widths.
The header's backend indicator is derived live from `/api/health`
(connected / checking / unavailable + retry) — a stopped backend produces a
clear, recoverable state instead of a crash.

The map marker shows the **Mapillary camera position** when viewer metadata supplies
coordinates — never an inferred lamp location. Failed or missing imagery never moves
the map to fabricated coordinates.

## Current limitations

- One bounded bbox query per search (`limit=2000`); capped searches warn instead of
  paginating, and large districts need smaller selections. No automatic subdivision.
  Sequence detail hydrates at most 5,000 member IDs per sequence (batches of 50,
  ≤2 concurrent) with a 120 s total deadline; capped membership is reported as
  partial, never as complete. The browser keeps at most 20,000 hydrated records
  per session; seeds are never evicted.
- Street retrieval runs one bounded Overpass query (~25 s server timeout, ~35 s
  client deadline, 5,000 candidate-way application limit — oversized responses are
  rejected with a smaller-region suggestion, never truncated silently). Supported
  highway classes are the motorway→track set plus `*_link`, pedestrian, and cycle
  ways (see [03_workflow.md](docs/specs/03_workflow.md#street-eligibility-and-geometry));
  areas, proposed/construction/abandoned features, and unrelated objects are
  excluded. "Within the RoI" means positive-length clipped geometry (crossing
  streets included, point-only touches excluded). The public Overpass endpoint is
  shared infrastructure — configure `OVERPASS_URL` to a self-hosted deployment for
  anything beyond modest local use. Timeouts and 5xx errors mean the instance is
  busy or the region is heavy: wait and retry, shrink the region, or point
  `OVERPASS_URL` at another public instance from the *Public Overpass API
  instances* list on the [Overpass API wiki](https://wiki.openstreetmap.org/wiki/Overpass_API).
- Without `VITE_MAPILLARY_CLIENT_TOKEN`, the imagery panel shows a "Mapillary is
  not configured" hint; without `MAPILLARY_ACCESS_TOKEN`, search reports its own
  configuration state. Street retrieval is independent of Mapillary configuration.
  Map, drawing, and settings keep working regardless.
- Persistence is local-only: workspaces live in the loopback MongoDB container
  (no authentication — a local-development configuration, not remotely
  deployable). Unsaved edits stay in memory with a before-unload warning; a
  second tab with an old revision gets a conflict dialog instead of a silent
  merge. There is no workspace deletion, no cloud sync, and no
  authentication. Previously lost memory-only sessions cannot be recovered
  retroactively.
- Preparation references the shared in-RoI image pool by ID with
  `imageAssociation: "pending"` — no image-to-street matching is performed, and no
  sequence is assumed to cover any street.
- Inventory previews are human-reviewed candidates, not measurements: poles and
  luminaires are counted separately (never summed as "streetlights"); placements are
  manual approximations or explicitly unknown; heights, mounting, power, spacing, and
  arrangement are not assessed. Demo positions live on a schematic diagram and are
  never geographic. There is no Publish, Export, or EN 13201 function.
- Detection is bounded: at most ten inference views per run (crops included), at most
  twenty model calls per batch, one call at a time, one concept per request. Masks
  are shown for inspection; only rectangles enter review geometry. Precision/recall
  in the prompt check cover the reviewed sample only.
- Seeded work areas are camera paths, not streets: the street list shows no road
  length for them, and inventory labels them unverified end to end (entry, Detect,
  Inventory, Results). Camera polylines are never used for street length or spacing.
- Live Mapillary/Overpass/Meta validation needs real tokens and network access.
  Provider behavior was verified against the documented APIs plus mocked provider
  fixtures; the milestone report records what was verified live.

## Attribution and terms

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
  available under the Open Database License. Standard OSM raster tiles are used only
  for modest interactive development viewing, per the
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
  No bulk download, prefetch, or offline tile cache is implemented.
- Street imagery via Mapillary (Meta); the MapillaryJS viewer retains its provider
  attribution and controls. Imagery use is subject to Mapillary's terms — the
  repository license does not license third-party imagery or map data.
- Detection via the Meta Model API (SAM 3.1); model use is subject to Meta's terms.
  Explicit Test/Detect work transmits the selected image bytes to Meta and spends
  model credits. Parsing uses the official `@meta-sam/parser` package.

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

Automated collection, satellite/aerial integration, district boundaries, geocoding
search, bulk download, vector-tile ingestion, automatic subdivision, completed
pole/luminaire records, height/spacing calculations, EN 13201 assessment, exports,
authentication, payments, cloud deployment, workspace deletion, and a general
settings framework — all intentionally absent. Coverage overlays and exhaustive
large-area retrieval need a separately specified strategy. Box/point-assisted
prompting and prompt-comparison calibration beyond the prompt check are future
work.

## License

MIT — see [LICENSE](LICENSE) (© 2026 Viktor Zsellér, original project code).
Dependencies and third-party imagery/map data retain their own licenses and terms.
