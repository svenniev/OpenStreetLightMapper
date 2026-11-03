# OpenStreetLightMapper — 02: Initial tailoring

## Instruction to Muse

Implement Milestone 1 in the existing repository: **select a region of interest (RoI) on the map, query Mapillary images in that region, and inspect returned images in the existing viewer.**

This is an implementation instruction for Meta Muse. Extend the working application; do not scaffold it again. Read `01_OpenStreetLightMapper-Kickoff.md`, repository instructions, and the current source first. Preserve existing user work, Git history, branch, remote, license, and configuration. Make routine implementation decisions independently. Stop after this milestone.

Repository: `B:\2026\OpenStreetLightMapper`  
Predecessor: `docs/specs/01_OpenStreetLightMapper-Kickoff.md`  
Application: `http://localhost:5173/`  
Specification/review date: 2026-11-03

This specification supersedes the kickoff's deferral of area-selection tools and nearby-image search **only within the scope below**. All other deferred functionality remains deferred. Do not push, deploy, or submit the competition entry.

## 1. Reviewed baseline

The following was observed through read-only source inspection and the running application:

| Area | Current state | Required extension |
| --- | --- | --- |
| Stack | npm workspaces; React 19 / TypeScript / Vite 6; Leaflet 1.9 / React Leaflet 5; MapillaryJS 4; Express 4 | Retain these technologies and compatible installed versions. |
| `apps/web/src/App.tsx` | Owns only the viewer camera position; renders map, imagery, and settings panels | Coordinate RoI, query state, result selection, and actual viewer image state. |
| `features/map/OsmMap.tsx` | Budapest at zoom 12, OSM tiles, resize observer, camera marker | Add region selection and returned image-position markers. |
| `features/street-imagery/MapillaryPanel.tsx` | Manual image-ID input; lazily creates one viewer; calls `moveTo`; handles image events and cleanup | Accept result selection and report actual loaded image ID as well as camera position. |
| `features/settings/SettingsPanel.tsx` | Placeholder plus configuration status | Add a compact region/search summary and action controls. |
| `apps/server/src/app.ts` | Health endpoint, JSON parser, CORS, then 404 handler | Add validated Mapillary search before the 404 handler. |
| Configuration | Browser variable `VITE_MAPILLARY_CLIENT_TOKEN`; server dotenv loading; Vite `/api` proxy | Add an explicit server-side Mapillary search token configuration. |
| Persistence | No database connection or schemas | Keep this milestone in memory. |

The live UI showed the OSM map, `Backend: connected`, `Mapillary: Configured`, an empty viewer awaiting an image ID, and the settings placeholder. The proxied health endpoint returned `{"service":"openstreetlightmapper-server","status":"ok"}`.

“Configured” currently means a nonempty frontend token, not verified authorization. Live image loading was not exercised during this specification review, and no build, lint, or test commands were run. Do not treat the baseline as a fully tested Mapillary integration.

Git inspection showed branch `main`, origin `https://github.com/svenniev/OpenStreetLightMapper.git`, and the current application/specification files as untracked. Preserve them; an untracked file is still existing user work.

## 2. Deliverable and scope

A user must be able to:

1. Navigate the map to a street or small district.
2. Draw one rectangle or simple polygon, or select the current map extent.
3. See the selected region and its approximate area.
4. Click `Find Mapillary images`.
5. See returned image camera positions on the map and a browsable result list.
6. Select a marker or list item to load that image in the existing MapillaryJS viewer.
7. Replace or clear the region and repeat without stale results or duplicate viewers.

Here, “query images” means retrieving image metadata and displaying chosen imagery through MapillaryJS. It does not mean downloading an image archive.

This is an intentionally bounded first search workflow. Large districts may require a smaller selection. Do not imply that this milestone enumerates every image in an arbitrary district.

Out of scope: satellite/aerial providers, road-network extraction, automatic district boundaries, street-name/geocoding search, bulk imagery download, background collection, vector-tile ingestion, automatic spatial subdivision, AI/model calls, Mapillary object detections, pole/luminaire records, height/spacing calculations, EN 13201 assessment, exports, persistence, authentication, deployment, and a general settings framework. Do not add speculative capture-date, AI, or lighting-class filters.

## 3. Region selection

### Controls and interaction

Add a compact toolbar beside or above the map with:

- `Draw rectangle`: choose two opposite corners by click/tap, or use a well-supported equivalent drawing interaction.
- `Draw polygon`: add vertices, then finish with an explicit control or the drawing tool's documented completion gesture.
- `Use current map view`: create a rectangle from the visible geographic extent. This also provides a practical keyboard-accessible alternative using Leaflet's keyboard navigation.
- `Cancel drawing`: also available through Escape.
- `Clear region`.

Show short instructions while drawing. Keep normal map navigation available outside drawing mode. Restore navigation and remove temporary listeners on completion/cancellation. Prevent drawing clicks from accidentally selecting imagery markers.

Maintain exactly one committed RoI. Starting a replacement creates a draft; cancellation restores the previous region and results. Successful replacement invalidates the previous search. Redrawing is sufficient for modification; vertex editing and draggable shape handles are not required.

Render the committed region with a visible outline and lightly transparent fill. Keep attribution and map controls unobstructed. Show shape type, approximate area in km², and a concise ready/invalid message in the sidebar. `Fit region` may be provided as a small convenience.

### Geometry contract and validation

Use a GeoJSON `Polygon` in WGS84 with **[longitude, latitude]** coordinate ordering. Rectangles use the same polygon representation. Leaflet's **[latitude, longitude]** arrays must be converted explicitly at the boundary.

Require:

- One exterior ring; no holes, MultiPolygons, or self-intersections.
- At least three distinct vertices, no more than 100 distinct vertices, and a closed ring.
- Finite, valid coordinates; positive area and nonzero bounding-box width/height.
- No antimeridian-crossing selections; show an actionable unsupported-region message.
- Coordinates within the map's supported Web Mercator latitude range, approximately ±85.051129°.
- A geodesic area calculation, or a documented suitable metric method. Do not calculate square metres by multiplying degree differences.

**Application limit:** selected polygon area must be at most **25 km²**. This is a milestone design limit, not a provider quota. Also enforce the provider bounding-box constraint in section 5; a thin polygon can have a large bounding box even when its polygon area is small.

Allow a too-large selection to remain visible with its error and a disabled search button, so the user can redraw it. Never silently clip or shrink a selection. Apply equivalent validation server-side before making an upstream request.

Drawing and selecting regions must work without a Mapillary token, backend connection, or MongoDB.

## 4. Search workflow and result presentation

Keep the existing map/imagery layout and restrained visual style. Replace only the relevant settings placeholder with region and search controls; retain provider/database status.

### Search state

- Initially show `Select a region to find Mapillary images.`
- Search is explicit: drawing, panning, zooming, and viewer navigation must not trigger provider searches.
- Enable `Find Mapillary images` only for a valid committed region and configured/available search service.
- Show a loading state and `Cancel search`; prevent duplicate submissions.
- On search start, clear the previous result set and query warnings. Keep the region.
- On success, display the count of unique, valid, in-region images returned and the retrieval timestamp.
- On zero valid matches, say `No matching Mapillary images were returned for this region.` Retain any truncation/data-quality warning.
- Distinguish not-yet-searched, loading, cancelled, failed, zero results, and results. A failure is never represented as zero images.
- On replacement or clearing of a committed region, abort its search and invalidate result markers, list selection, counts, and warnings.
- Use an AbortController plus a request/region generation guard: late responses must never overwrite a newer region or search. Guard asynchronous viewer callbacks too.

Cancellation ends this search and keeps the region available for a new explicit search. Abort upstream work when the client disconnects; do not leave a background collection running.

### Markers and list

Plot each returned image's accepted search coordinate as a camera-position marker. Differentiate ordinary results, a selected result, and the currently displayed viewer camera through style plus a small legend. No streetlight/pole icons.

Provide a scrollable result list with image ID, capture date when available, panorama status when known, and an `Open image` action. Display unknown values as `Unknown`, not zero or false. Preserve the full capture timestamp in data; label displayed dates consistently, for example UTC.

Sort the loaded results by capture time descending, unknown dates last, then image ID for deterministic ties. This sorts only the returned set and must not claim the provider returned the newest images in the region.

Keep all returned records accessible without creating an excessive DOM tree: client-side list pages of 50 are sufficient. Label these as pages of **loaded results**, not provider pagination. Leaflet canvas circle markers or another lightweight approach are sufficient at the bounded result count. Identical coordinates may overlap; the list must still expose every image.

Do not load every full-resolution image to populate this list. Text rows are sufficient; thumbnails are optional and, if included, must be lazy-loaded with provider attribution.

### Viewer integration

Selecting a marker or list item must load that ID through the current MapillaryJS instance. Preserve manual ID loading as a secondary/testing option. Replace the existing “Nearby-image search is deferred” copy.

Keep requested image ID separate from successfully displayed image ID. On loading failure, show the failed request clearly and leave any previously displayed image identified accurately. Do not move its camera marker to the failed request's location.

On MapillaryJS image-change events, update the actual displayed image ID and camera position. If that image belongs to the loaded result set, highlight it; otherwise clear the result highlight and label it `Outside current search results`. Viewer sequence navigation and manual loading may leave the search result set; they must not expand or change the RoI or count.

If an image remains displayed after clearing/replacing the RoI, identify it as outside the current search results. Its camera marker may remain as the actual viewer location.

Avoid feedback loops between viewer events and controlled image selection. Rapid A→B selections must settle on B, including the displayed image, status, and camera marker; serialize/coalesce viewer moves where necessary. Ignore callbacks from disposed instances. Retain cleanup, resize handling, attribution, keyboard controls, and recoverable WebGL errors. Do not recreate the viewer for every marker click or map render.

Do not automatically pan away from the selected region during viewer navigation. A separate `Locate viewed image` action is optional.

## 5. Mapillary query behavior

### Verified provider constraints

The official [Mapillary API documentation](https://www.mapillary.com/developer/api-documentation/#image), inspected in a browser on 2026-11-03, documents:

- Image metadata search at `GET https://graph.mapillary.com/images`.
- `bbox` order: west, south, east, north.
- Bounding-box area must be **strictly smaller than 0.01 square degrees**.
- Image-search `limit` has a maximum/default of 2000.
- Pagination is currently supported only with `creator_username`, not a general all-creator bounding-box search.

Entity requests support `Authorization: OAuth <token>`; see [authentication](https://www.mapillary.com/developer/api-documentation/#authentication). Recheck the official documentation when implementing. Do not substitute old v3 endpoints, assume a different authorization scheme, or invent pagination support.

### Bounded retrieval for this milestone

Use one bounding-box image search per explicit user query, with `limit=2000`. Do not add a creator filter: that would exclude other contributors' imagery.

Enforce `(east - west) * (north - south) < 0.01` for the provider request. This calculation is solely the provider's angular-area constraint; it is not the displayed metric area.

If invalid, explain that the region's bounding box exceeds the supported search size and ask the user to select a smaller area. Do not send it upstream, silently query only a portion, or launch unbounded subdivision.

Request only metadata needed for this feature: `id,geometry,computed_geometry,captured_at,is_pano,sequence`. Optional thumbnails or creator attribution may add explicitly needed fields. Preserve IDs as strings.

For returned records:

1. Validate the provider response and record fields.
2. Choose a valid `geometry` point as the search coordinate; use `computed_geometry` only when the original point is unavailable. Record which was used and retain both when supplied.
3. Exclude records with no valid coordinate or ID, and count these exclusions.
4. Apply an exact point-in-polygon test against the committed RoI, including its boundary. The bounding box alone is insufficient for polygons.
5. Deduplicate by image ID, not coordinate or sequence ID.

The inclusion rule is **the image camera point lies inside/on the selected polygon**. It does not mean that all objects visible in the photograph lie inside, or that photographs taken outside the polygon cannot show objects inside.

MapillaryJS may expose a refined camera position that differs from the original search point. Keep that distinction explicit; do not silently rewrite the completed search's membership when the viewer changes position.

### Result limits and coverage honesty

Evaluate truncation against the **raw upstream record count before polygon filtering or deduplication**.

- If 2000 records are returned, report `possibly_truncated`, even if only a few survive polygon filtering.
- If the provider supplies any indication of more results, also report `possibly_truncated`.
- Otherwise report `not_capped`, meaning only that this response did not hit the requested limit. It is not a coverage guarantee.
- Do not follow `paging.next` or invent an `after` loop for this bbox-only search. There is no `Load more from Mapillary` button in this milestone.
- When capped, display: `The search reached the provider result limit. More images may exist; select a smaller region.`
- Surface excluded invalid-coordinate records as a separate data-quality notice.

Never call these results “all streetlights,” “complete district coverage,” or proof that no lighting exists. Zero matches, camera gaps, capture age, occlusion, and original/refined location differences all limit later inference. Larger-area discovery and more exhaustive retrieval require a separately specified strategy.

## 6. Backend and data contract

Use the existing Express backend and Vite proxy. Add:

```text
POST /api/mapillary/images/search
Content-Type: application/json

{
  "roi": {
    "type": "Polygon",
    "coordinates": [[[19.040,47.495],[19.045,47.495],
                     [19.045,47.500],[19.040,47.500],[19.040,47.495]]]
  }
}
```

The coordinates above are a shape-format example, not a promise of imagery.

Compute the bounding box on the server from validated geometry. Do not trust a client-supplied area, provider URL, fields list, result limit, or access token. Keep search validation and provider access separate from the route handler.

Return a small normalized JSON envelope with these semantics; equivalent naming is acceptable if documented and typed consistently:

```ts
type ImageResult = {
  id: string;
  coordinate: [number, number]; // longitude, latitude
  coordinateSource: "geometry" | "computed_geometry";
  originalCoordinate: [number, number] | null;
  computedCoordinate: [number, number] | null;
  capturedAt: number | null; // Unix milliseconds
  isPano: boolean | null;
  sequenceId: string | null;
};

type SearchResponse = {
  images: ImageResult[];
  query: {
    bbox: [number, number, number, number]; // west,south,east,north
    requestedAt: string; // ISO 8601 UTC
    retrievedAt: string; // ISO 8601 UTC
    providerLimit: number;
    rawReturnedCount: number;
    matchedCount: number; // images.length after validation/filter/dedup
    invalidRecordCount: number;
    outsideRoiCount: number;
    duplicateCount: number;
    retrievalStatus: "not_capped" | "possibly_truncated";
  };
  warnings: string[]; // stable codes, mapped to readable UI messages
};
```

Use a defined processing order so diagnostic counts are reproducible. Return no credentials, upstream request URLs containing tokens, or unnecessary raw provider payloads. Browser memory should retain the submitted RoI with its response for the active query; do not create a database audit store in this milestone.

### Configuration and failures

Add `MAPILLARY_ACCESS_TOKEN` to `apps/server/.env.example` using a placeholder. A suitable Mapillary client access token can be configured here for search; keep the existing browser client token for MapillaryJS. The same suitable client token may be configured in both places, but the backend must not read the frontend environment file or accept a token from the request.

Document the two settings clearly. A server-only search token is not automatically available to the viewer, and a configured viewer does not prove server search is configured. Do not display token values or add token-entry UI.

Extend health with an optional provider configuration boolean, for example `providers.mapillarySearch.configured`, while retaining the existing service/status contract. Label this as configured, not authenticated/verified. The rest of the app and health service must work when the search token is absent.

Return a consistent error object, for example `{ error: { code, message, retryable } }`:

| Condition | Expected behavior |
| --- | --- |
| Invalid/unsupported geometry, oversized region | HTTP 400; useful message; no provider request. |
| Missing server search configuration | HTTP 503; `MAPILLARY_NOT_CONFIGURED`. |
| Provider authorization failure | Sanitized upstream-failure response, e.g. HTTP 502 with `MAPILLARY_AUTH_ERROR`; instruct configuration correction. |
| Rate limit, including provider-specific error codes | HTTP 429 with `MAPILLARY_RATE_LIMITED`; preserve a safe Retry-After value if supplied. |
| Provider timeout | HTTP 504 with `MAPILLARY_TIMEOUT`. |
| Network failure, malformed response, other provider failure | HTTP 502 with a stable appropriate code. |
| Successful zero-match response | HTTP 200 with an empty images array and query metadata. |

Use an approximately 30-second upstream deadline. No indefinite waits or automatic retry loops; provide explicit user retry. Inspect both HTTP status and provider error bodies. Validate JSON at runtime rather than trusting a TypeScript cast. Redact credentials in logs and user-visible errors, including existing viewer error paths touched by this integration.

Search remains a local development feature; no new public deployment or permissive arbitrary-URL proxy is authorized.

## 7. Implementation guidance

- Keep `App.tsx` as the coordination boundary, or introduce a focused feature hook/reducer. Keep drawing drafts, committed RoI, query generation, result selection, and actual viewer state distinct.
- Extend `OsmMap.tsx` with focused selection/result-layer components. Add result-list and search-state modules under the existing feature structure.
- Extend `MapillaryPanel.tsx` with a requested-image input and actual-image callback; avoid direct component-to-component DOM manipulation.
- Put request helpers in `apps/web/src/lib/api.ts`; add explicit geographic/result types.
- Add a focused server route/service and validation module before the existing 404 middleware.
- Use a small maintained Leaflet drawing/geospatial dependency if it materially simplifies correct interaction and geometry checks. Verify compatibility with the installed React/Leaflet versions; do not introduce a second map engine or major-version upgrade for this feature.
- Keep map/viewer resize observers and accessible labels/focus styles. At narrow widths, all selection, search, list, and viewer actions must remain reachable.
- Avoid a global state library, job queue, database, Python service, or generic provider framework.
- Keep actual environment files unchanged unless the user separately supplies configuration instructions. Update examples and README with placeholders and required steps.
- Update stale milestone/limitation text to describe what now works and what is still deferred.

These are integration boundaries, not a requirement to copy a particular internal architecture.

## 8. Verification and acceptance criteria

Add focused automated tests for geometry/query/state behavior and the provider boundary using mocked responses. Mocks are test fixtures only; never substitute fake imagery or fake successful searches in the live application.

| Scenario | Acceptance |
| --- | --- |
| Rectangle and polygon selection | Each produces one valid visible RoI with correct coordinate ordering and metric area. |
| Current-view selection | Keyboard-accessible action commits the current extent, or shows the size error. |
| Invalid geometry | Self-intersection, degenerate shape, holes, too many vertices, nonfinite/out-of-range coordinates, and antimeridian crossing are rejected without upstream calls. |
| Size boundaries | 25 km² application limit and strict bbox area below 0.01 square degrees are tested independently, including equality at the provider boundary. |
| Cancel replacement drawing | Previous committed RoI and results survive; normal map interaction returns. |
| Polygon containment | A point inside the bounding box but outside the polygon is excluded; an edge/vertex point is included. |
| Data normalization | Missing original coordinate uses valid computed coordinate; missing both is excluded; missing metadata stays null; IDs remain strings. |
| Duplicate records | Repeated IDs appear once; different IDs at the same position remain distinct. |
| Capped search | 2000 raw rows with few final matches still produce a truncation warning; no fictitious provider pagination or completeness claim. |
| Empty/capped-empty/error | Each has distinct, truthful UI and no fabricated marker. |
| Search races | Start A, commit B, then finish A late: A cannot populate B. Cancellation and clear also reject late responses. |
| Viewer races | Rapid image selection settles on the latest request; stale events cannot corrupt its ID, status, or camera marker. |
| Viewer navigation | Result highlight follows actual loaded IDs; outside-result images are identified without changing RoI or counts. |
| Provider failures | Missing token, rejected token, throttling, timeout, malformed JSON, and unavailable backend show recoverable states with no token leakage. |
| Provider request construction | Fixed endpoint, authorized header, correct bbox ordering/fields/limit, one bounded request, timeout and cancellation propagation. |
| Lifecycle and layout | No duplicate viewer/listeners in React StrictMode; map and viewer resize correctly; list and controls remain usable at narrow widths. |

Run `npm run build`, `npm run typecheck`, `npm run lint`, and the focused tests from the repository root. Add/document a test command if needed. Do not claim unexecuted checks passed.

Manually verify with the running application:

1. Draw a small RoI in an area with known available Mapillary imagery; search and inspect at least two returned images.
2. Confirm map/list/viewer IDs and camera semantics remain consistent.
3. Replace and clear the region during a search.
4. Exercise a polygon with points outside its shape but inside its bounding box using a test fixture.
5. Check missing configuration, empty results, an upstream failure, and a capped response with test fixtures.
6. Verify desktop and narrow layouts and keyboard focus.
7. Confirm no unwanted files, secrets, downloaded imagery, or generated dependencies appear among deliverables.

A live test must report its tested RoI, date, result count, and selected image IDs without tokens. If credentials or provider availability block it, explicitly mark live search/viewer validation as unverified and state the configuration needed. Do not replace it with a demo success state.

Finish with a concise implementation summary, commands/check results, known limits, and required configuration steps. Leave a reviewable working tree.

## 9. Product and evidence boundaries

Keep image IDs, source identity, capture timestamps when supplied, coordinate provenance, query geometry, and retrieval timestamps available in the current session. These form a useful future evidence boundary without pretending that persistent auditing exists already.

Camera positions are not lighting-asset positions. This milestone does not determine mounting height, pole spacing, arrangement, light output, or EN 13201 compliance. Maintain the kickoff's distinction between future inventory data and validated lighting-performance assessment.

Retain OSM and Mapillary attribution and required viewer controls. Use imagery only through the permitted provider workflow; no scraping, retained image archive, redistribution pipeline, or AI processing is part of this milestone. The repository's MIT license does not relicense provider content.

## 10. References

- [Kickoff specification](01_OpenStreetLightMapper-Kickoff.md).
- [Mapillary API: images, bounding boxes, and pagination](https://www.mapillary.com/developer/api-documentation/#image).
- [Mapillary API authentication](https://www.mapillary.com/developer/api-documentation/#authentication).
- [Mapillary API rate limits](https://www.mapillary.com/developer/api-documentation/#rate-limits).
- [MapillaryJS Viewer API](https://mapillary.github.io/mapillary-js/api/classes/viewer.Viewer/) — programmatic image loading and viewer lifecycle/events.
- [React Leaflet](https://react-leaflet.js.org/) and [Leaflet reference](https://leafletjs.com/reference.html).
- [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/) and [attribution](https://www.openstreetmap.org/copyright).
- [Competition context supplied by the project owner](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver). This feature specification does not assert competition eligibility or constitute a submission.

**Milestone completion:** a user can select a bounded region, find available Mapillary image records inside it, and inspect real selected imagery with honest coverage and error states.