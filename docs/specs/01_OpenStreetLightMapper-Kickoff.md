# OpenStreetLightMapper — Muse kickoff specification

## Instruction to Muse

Implement Milestone 0 below in the current local repository. This is an implementation task, not merely a planning exercise. Inspect the existing files and repository instructions first, then scaffold, build, and verify the application. Make routine implementation decisions independently and document them. Preserve existing work. Stop after delivering this milestone; do not implement the future inventory pipeline yet.

Repository: https://github.com/svenniev/OpenStreetLightMapper.git

## Product vision

**AI-assisted public-lighting inventory tool.**

OpenStreetLightMapper is an open-source system intended to convert street-level imagery and map geometry into an auditable public-lighting asset inventory and a roadway-lighting dataset suitable for subsequent EN 13201 workflows.

Eventually, a user will select streets or a district, retrieve available street-level and satellite/aerial imagery from permitted sources, identify lighting assets, review AI proposals, and export a traceable inventory. The aim is comprehensive coverage, but missing imagery, occlusion, outdated captures, and uncertain measurements must remain explicit. Never present incomplete image coverage as proof that no streetlights exist.

Future data includes pole and luminaire locations, pole-to-pole spacing, lighting arrangement, mounting height, outreach, orientation, road geometry, source evidence, and reviewer decisions. Treat this as a product direction, not a complete or normative EN 13201 schema. Inventory geometry alone does not establish lighting performance or compliance; a future validated standards mapping and photometric calculation workflow will be needed.

## Milestone 0: working application shell

Deliver only:

1. A clean, non-destructive Git/project setup and suitable `.gitignore`.
2. A React application with a basic, functional workspace UI.
3. An interactive OpenStreetMap-based map and a Mapillary street-imagery panel.
4. A settings sidebar reserved for requirements that will follow.
5. A minimal Express backend and a documented MongoDB integration boundary.
6. Clear local setup instructions and verified build/type-check/lint commands.

Do not build AI detection, automated collection, satellite integration, area-selection tools, inventory CRUD, photometric calculations, exports, accounts, payments, or cloud deployment in this milestone. Do not invent detailed settings or fake completed analysis results.

## Technology and structure

Use the MERN stack, with TypeScript for application code:

- Frontend: React + Vite.
- Backend: Node.js + Express.
- Database: MongoDB, with Mongoose when persistence is introduced.
- Map: Leaflet with React Leaflet and an OpenStreetMap basemap.
- Street imagery: official MapillaryJS viewer.
- Package manager: npm with a committed lockfile and a simple workspace layout.
- Styling: plain CSS or a small existing styling solution; avoid a large UI framework for this shell.

Use current mutually compatible stable package versions. Verify official documentation before implementing provider APIs; do not guess endpoints or rely on outdated examples. Document the supported Node.js version.

Suggested layout, adaptable to existing repository contents:

```text
apps/
  web/
    src/
      components/
      features/map/
      features/street-imagery/
      features/settings/
      App.tsx
    .env.example
  server/
    src/
      app.ts
      index.ts
    .env.example
README.md
LICENSE
.gitignore
package.json
package-lock.json
```

Keep components small and readable. A separate database service, queue, plugin framework, or elaborate shared-domain package is unnecessary for this milestone.

## Repository setup

- Check `git status`, the current branch, and `git remote -v` before changing anything.
- If Git already exists, preserve its history, remote, branch, and user changes. Do not run destructive reset/clean operations or create a nested repository.
- Only initialize Git if this directory is not already in a repository. Add the supplied origin only if no origin exists; report a conflicting origin rather than overwriting it.
- Preserve an existing license. If none exists, add the standard MIT license with `Copyright (c) 2026 Viktor Zsellér` for original project code. Dependencies and imagery retain their own licenses and terms.
- Ignore `node_modules/`, build output, coverage, logs, local caches, editor/OS artifacts, local database files, and actual environment files. Explicitly retain `.env.example` files. Never ignore the lockfile or source files.
- Never commit tokens, API secrets, downloaded imagery, or database dumps.
- Do not push to GitHub or deploy. Leave a reviewable working tree and summarize changes.

## Basic UI

Use a restrained, practical engineering-tool appearance: light neutral background, readable typography, clear borders, and a single accent color. No marketing landing page or decorative dashboard statistics.

### Header

Show `OpenStreetLightMapper` and the subtitle `AI-assisted public-lighting inventory`. Include a small backend connection indicator derived from the health endpoint, rather than a hard-coded success badge.

### Workspace

On desktop, use a large central workspace and an approximately 300 px right settings sidebar. Within the workspace, place the map and Mapillary viewer side by side, approximately 60/40. Both should have clear panel titles. At smaller widths, stack the panels with usable heights and keep settings accessible. CSS grid/flex is sufficient; drag-resizable splitters are not required.

### OpenStreetMap panel

- Render a real interactive map with pan and zoom controls, initially centered on Budapest at city scale.
- Keep the tile URL and attribution configurable. The standard OSM raster tiles may be used for modest interactive development; preserve visible OpenStreetMap contributor attribution and follow the tile usage policy.
- Load only tiles needed for normal interactive viewing. No bulk download, prefetch job, or offline tile cache feature.
- Show the selected imagery camera position when coordinates are available.
- Label this panel `Map`. OpenStreetMap is map data/basemap content, not a satellite imagery source. Satellite/aerial imagery is deferred.

### Mapillary panel

- Integrate MapillaryJS as a real viewer, not a screenshot or iframe mockup.
- Provide a small image-ID input and a `Load image` button for testing a known Mapillary image. This is enough for Milestone 0; nearby-image search and coverage overlays are deferred.
- Read the Mapillary browser client access token from configuration. Document that any frontend environment value is public in the browser bundle: use only a token intended for client-side use, and never a private application secret.
- With no token, render a helpful `Mapillary is not configured` state explaining where to configure it. The map and rest of the application must still work.
- Handle loading, invalid image IDs, authorization errors, unavailable imagery, network errors, and unavailable WebGL without crashing the page.
- On viewer image changes, update the camera-position marker on the map when metadata provides coordinates. The marker represents the camera, never an inferred lamp location. Do not move the map to fabricated coordinates.
- Dispose of viewer instances and listeners on unmount; support React development-mode lifecycle behavior without duplicate viewers.
- Retain provider attribution and required viewer controls.

### Settings panel

Show `Settings` and a concise placeholder: `Project and analysis settings will be added in the next milestone.`

A read-only provider/configuration status is acceptable. Do not add speculative AI thresholds, EN 13201 class selectors, height defaults, or editable API-secret fields. A provider error should remain in its relevant panel rather than blocking the whole application.

## Backend and environment

- Implement `GET /api/health`, returning a small JSON response with service name and status. Do not report a database connection that has not been established.
- Use the Vite development proxy for `/api` requests.
- Document `PORT`, `MONGODB_URI`, and the frontend Mapillary client-token variable in example environment files using placeholders only.
- MongoDB is not required to open and use the shell. Defer schemas and persistence; document that database integration is pending. Do not create meaningless database collections just to claim MERN completeness.
- Keep future Meta model calls and private credentials on the Express server. Do not implement AI calls yet.
- Provide root commands for `npm run dev`, `npm run build`, `npm run typecheck`, and `npm run lint`. Development should start frontend and backend together and work from Windows PowerShell.

## Future inventory principles — document, do not implement

- Separate physical poles, luminaires attached to them, road segments, imagery observations, and reviewed asset records.
- Use WGS84 coordinates for geographic exchange; specify coordinate ordering explicitly. Use suitable metric/geodesic methods for distances, never arithmetic on latitude/longitude degrees as though they were metres.
- Record units and distinguish estimated, measured, manually supplied, and unknown values. Unknown is not zero.
- Preserve image IDs, source links, capture dates when available, inference method/model version, uncertainty, and review status. Multiple sightings may describe the same physical asset.
- Mounting height and pole location require defensible geometric evidence or manual measurement; a single uncalibrated image is not an exact measuring instrument.
- Model pole spacing along associated road segments and distinguish single-sided, opposite, staggered, central, mixed, and unknown arrangements when this feature is specified.
- Keep detected candidates separate from human-confirmed assets. Track coverage gaps and stale observations.
- Verify provider permissions for automated retrieval, retention, AI processing, and redistribution before implementing collection. The repository license does not license third-party imagery or map data.
- Keep the eventual standards mapping versioned and explicit. Do not label this kickoff as EN 13201 compliant or standards-certified.

## Acceptance criteria

- Fresh installation with the documented Node.js version and `npm install` succeeds.
- `npm run dev` launches the application and health endpoint.
- A user sees the header, interactive map, Mapillary panel, and settings placeholder.
- Without a Mapillary token or MongoDB instance, the application remains usable and accurately reports its limited configuration.
- With a valid browser token and image ID, the Mapillary viewer loads real imagery; camera position updates when coordinates are available.
- Missing/invalid imagery and a stopped backend produce clear recoverable states.
- Layout works at desktop and narrow/mobile widths; controls have accessible labels and keyboard focus indicators.
- Build, type-check, and lint pass. Verify the health endpoint and manually inspect the UI if browser tools are available.
- Check viewer cleanup and map resizing when panel dimensions change.
- README documents setup, configuration, commands, architecture, current limitations, attribution, and what is deferred.
- No secrets or generated dependencies appear in the Git diff.

If live Mapillary validation is blocked by missing credentials, explicitly report it as unverified; do not replace it with a fake success state. Finish with a concise list of implemented features, verification results, and remaining configuration steps.

## Official implementation references

Consult these when implementing; they are not an authorization to expand scope:

- MapillaryJS: https://mapillary.github.io/mapillary-js/
- OpenStreetMap tile usage policy: https://operations.osmfoundation.org/policies/tiles/
- OpenStreetMap attribution and copyright: https://www.openstreetmap.org/copyright
- React: https://react.dev/
- Vite: https://vite.dev/guide/
- React Leaflet: https://react-leaflet.js.org/
- Express: https://expressjs.com/

The kickoff ends with a working geographic workspace, not a completed lighting-inventory system.
