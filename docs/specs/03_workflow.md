# OpenStreetLightMapper — 03: Workflow

## Instruction to Muse

Implement **Milestone 2: sequence browsing, street selection, and preparation of a per-street processing workflow**, building on `02_initial_tailoring.md`.

Meta Muse performs the implementation. This document is a specification and source review, not an implemented change. Inspect repository instructions and current code first, preserve existing work, and make routine implementation decisions independently. Do not rebuild the application shell or change its stack. Stop after this milestone; do not implement image segmentation or lighting-asset detection.

Repository: `B:\2026\OpenStreetLightMapper`  
Specification: `docs/specs/03_workflow.md`  
Reviewed revision: `b60a320` (includes `265e28c initial tailoring`)  
Review date: 2026-11-03

The intended filename is `03_workflow.md`, alongside the previous specifications. This milestone supersedes the previous deferrals of street extraction and workflow preparation only. Keep all other product/evidence boundaries from specifications 01 and 02. Do not commit, push, or deploy as part of this implementation unless separately instructed.

## 1. Review of the current implementation

### What is present

The implementation substantially follows specification 02:

- `useRoiSearch.ts` separates drawing drafts, committed RoI, image search state, and actual viewer state, with request-generation guards.
- `packages/geo` provides shared RoI validation, geographic area, bounding-box limits, and boundary-inclusive point-in-polygon testing.
- `apps/server/src/mapillary.ts` makes one bounded Mapillary metadata query; `search.ts` normalizes coordinates, filters against the polygon, deduplicates, and warns on possible truncation.
- The image contract already carries `sequenceId` and `isPano`. These are sufficient to begin grouping the discovered images without guessing groups from proximity.
- The map renders the entire returned `images` array. Only the sidebar list is paginated, in groups of 50.
- MapillaryJS is reused, and `viewerQueue.ts` serializes/coalesces requested moves.
- Tests exist for geometry, normalization, provider requests, routes, search helpers, and the viewer queue. There are no street or sequence workflow modules yet.

The owner's supplied screenshot shows a 0.05 km² rectangular RoI, 1,135 returned/unique images, zero excluded/duplicate/invalid records, 23 list pages, panorama and standard images, and a displayed Mapillary image. The actual search button is **Find Mapillary images**; **Fit region** is a separate viewport action.

The screenshot does not show a 2,000-result cap being reached. Source inspection finds no map-side sampling of those 1,135 records. Overlapping camera points, provider availability, original/refined coordinate differences, and the discovery query's limitations can affect what appears on the map. Do not claim a specific cause for missing imagery without a reproducible provider comparison.

This review used source files and the supplied screenshot. It did not rerun tests/builds, change configuration, or reproduce live viewer behavior. Treat the findings below as source-level findings.

### Fix these relevant gaps while extending the workflow

| Priority | Source finding | Required correction and regression check |
| --- | --- | --- |
| P1 | In `apps/server/src/mapillary.ts:138`, the deadline and caller-abort listener are cleared before `response.json()` at line 144. A response that sends headers then stalls can outlive the advertised timeout; caller cancellation no longer reaches body consumption. | Keep timeout/cancellation active through body reading and validation, handle already-aborted signals, and release resources in an outer finally. Test delayed/stalled bodies and cancellation after headers. Apply the same pattern to new provider calls. |
| P2 | `useRoiSearch.ts:272` updates the actual image ID but does not update/clear `selectedId`; `OsmMap.tsx:172` uses that old selection for highlighting. | Derive the viewed-image highlight from actual viewer state, with a separate pending-request indication if needed. Test navigation to another loaded image and outside the loaded set, not just the move queue. |
| P2 | `sanitizeProviderMessage` in `mapillary.ts:69` only truncates text. It is not redaction; raw provider messages are returned. `classifyViewerError` also interpolates raw error messages. | Use safe, stable user messages and redacted diagnostics. Test an upstream/viewer error that contains a fake token and token-bearing URL; neither may reach UI or logs. No credential leak was observed in this review. |
| P2 | `cancelSearch` aborts transport but does not immediately invalidate its generation; `useRoiSearch` has no unmount cleanup for the request. | Cancellation must invalidate acceptance immediately and set cancelled state. Abort/invalidate on unmount. Test a transport that resolves after abort and a response that races cancellation. Reuse this discipline for streets and sequence detail. |

Also tighten metadata normalization when extending it: numeric `captured_at` follows Mapillary's documented milliseconds contract; do not infer seconds from magnitude. Reject unsafe numeric IDs instead of converting already-rounded numbers into plausible strings. Optional fields remain unknown when invalid.

## 2. Intended workflow and layout

The user journey is:

1. Commit a valid RoI.
2. Automatically retrieve the street dataset for that RoI.
3. Click **Find Mapillary sequences** to discover imagery, then inspect distinct sequences and their image types.
4. Review the street list and uncheck streets that should not participate.
5. Click **Start Processing** to prepare an in-memory work plan for the checked streets.
6. See preparation status. Inventory results remain unavailable until a later real mapping stage produces them.

Keep the map on the left, the existing viewer beside it, and Settings on the right. Place a **Mapillary sequences** panel directly below the Map. Add a **Streets in region** panel below the workspace, with enough width for readable rows. At narrow widths, stack these panels with usable heights and accessible controls.

Move the long global image list out of Settings. Settings contains region summary, discovery controls, provider status, checked-street count, Start Processing, and preparation summary. A selected sequence may have an expandable/paginated image list in its own panel.

Keep `Fit region` as a viewport-only action. Replace the imagery search label with `Find Mapillary sequences`, explaining briefly that sequences are discovered from available image records. Do not automatically search Mapillary on pan, zoom, drawing preview, or street checkbox changes.

Every committed RoI has a revision identity. Street responses, image discovery, sequence membership, and prepared plans must be associated with it. Draft cancellation preserves the previous committed state. Committing or clearing a region aborts dependent work and discards its current lists, checkbox choices, and plan. A displayed viewer image may remain, clearly marked outside the current working selection.

## 3. Sequence discovery and browsing

### What a sequence means

Use the provider term **sequence** in UI, with “capture stream” as optional explanatory copy. Mapillary groups captured images by sequence ID; its viewer can navigate between sequences as well as within one. Do not assume every spatial-arrow movement stays in the selected sequence. [Mapillary sequence explanation](https://help.mapillary.com/hc/en-us/articles/115001724849-Understanding-Mapillary-sequences-their-symbology)

Keep the current bounded RoI image search as the discovery mechanism. Group records by their real `sequenceId`; retain deduplicated IDs and metadata. Records without a sequence ID appear as individually selectable **Ungrouped images**. Never merge all unknown IDs into a fabricated stream.

Each sequence row shows:

- A readable short sequence ID, with access to its full ID.
- Number of **discovered images inside this RoI**, not an asserted whole-sequence total.
- Capture date/range in UTC, unknown where absent.
- Counts of panorama, standard/non-panorama, and unknown image types.
- Metadata status: discovery only, loading detail, loaded, partial, or failed.
- A selection/open control, including keyboard operation.

Use `isPano === true`, `false`, and `null` as three different states. Show an aggregate badge such as Panorama, Standard, Mixed, or Unknown; when known types coexist with unknowns, display those counts rather than declaring the entire sequence homogeneous.

Default to **All types**, with panorama-containing sequences ordered first, then most recent known capture time and stable ID. Add a simple **All / Contains panoramas / Standard only / Unknown type** sequence-list filter. Define filters against currently available metadata, show counts, and keep the selected sequence visible if a filter changes. These filters affect browsing only, not processing participation.

Panoramas are a useful browsing preference because they offer a wider view. They are not proof of lighting visibility, image quality, or suitability for measuring heights. Do not discard standard imagery or claim panorama images are inherently accurate measurements.

### Selecting a sequence must reveal its images

On selection:

1. Immediately show its currently known camera points.
2. Retrieve the sequence's image-ID list and missing image metadata on demand through the backend.
3. Merge by image ID and preserve provider sequence order.
4. Show **all successfully retrieved positions** for the selected sequence within the chosen display scope.
5. Load a representative in-RoI image in the existing viewer: prefer a known panorama, then earliest known capture time with stable ID tie-breaking. If the currently displayed image already belongs to it, keep that image.

Provide **Inside RoI** (default) and **Whole sequence** display scopes. The latter shows fetched positions outside the RoI as context with a visibly different style. Keep the RoI visible and offer an explicit `Fit sequence` action; do not automatically zoom far away. Outside-RoI images never enter the processing input pool.

Unselected sequences must not leave a wall of image dots on the map. Street lines, RoI, selected-sequence points, and the actual viewer-camera marker have distinct styles. Overlapping points remain separately selectable through the sequence's image list.

A connecting sequence line is optional. If drawn, use verified sequence order, break across missing/unresolved members and RoI gaps, and never imply that it is road geometry. Sorting an incomplete set by date does not establish a continuous route.

Viewer events update the actual image highlight. If the actual sequence is known and differs, identify it and offer `Show this sequence`; do not automatically launch a chain of sequence queries while the user navigates. Manual image loading remains a secondary option.

### Provider strategy and honest completeness

The official [sequence API reference](https://www.mapillary.com/developer/api-documentation/#sequence) describes `GET /image_ids?sequence_id=...`; it yields member IDs, not all needed coordinates. The [official SDK reference](https://mapillary.github.io/mapillary-python-sdk/docs/mapillary.config.api/mapillary.config.api.entities/) also documents this membership endpoint. Fetch missing metadata through documented image-entity or multiple-entity requests, not an invented sequence-search endpoint. Recheck the current API and response shapes before implementation.

Retain the previous bbox discovery constraints, including the raw 2,000-record warning and lack of general bbox pagination. A sequence found through discovery can have additional members not present in the original response. Loading its membership can recover those members, but cannot discover sequences that were never represented by a seed image. Surface these two limitations separately.

Use bounded metadata loading:

- One active selected-sequence load; at most two concurrent metadata batch requests.
- Batch size 50 IDs, subject to a smaller verified provider limit.
- Maximum 5,000 member IDs hydrated per sequence and 20,000 cached image records per browser session. These are application limits, not provider quotas.
- Approximately 30 seconds per upstream request, including body consumption; a 120-second total sequence-detail deadline.
- A 10 MiB response-body limit per provider request. Fail clearly rather than buffering indefinitely.
- Cancel superseded requests; no eager hydration of every discovered sequence.
- Session-memory caching, bounded eviction, request deduplication, and explicit retry after recoverable errors.

If membership itself is capped, indicates more pages, or is undocumented/uncertain, report membership as partial/unknown. Only follow pagination actually documented for that endpoint, with bounded requests and validated provider host/path. Do not apply the bbox pagination assumptions to another endpoint or invent cursors.

Keep separate counts for member IDs returned, metadata loaded, invalid/unavailable members, inside/outside RoI, and unresolved remainder. Never label capped/failed hydration “all images loaded.” A below-cap discovery response still does not establish complete coverage of the region.

The direct API documentation required login through the web reader during this review; its relevant sections were previously readable in a browser in this project chat. Muse must verify current semantics and live behavior rather than treating an inaccessible page as successful validation.

## 4. Retrieve and select streets

### Source and trigger

Use OpenStreetMap vector data through a server-side Overpass adapter. Raster basemap tiles contain no usable street records; do not scrape map labels.

Automatically request streets **once per valid committed RoI**, including a debounced/deduplicated initial effect that survives React StrictMode. No request for an unfinished drawing, pan, zoom, or invalid selection. Keep street loading/error/retry independent of Mapillary configuration and search. Provide `Retry streets` on failure.

Preserve current geometry/area limits for this milestone; do not silently broaden region size. Configure the Overpass endpoint server-side, defaulting to `https://overpass-api.de/api/interpreter` for modest local development. Use one bounded query, a server timeout around 25 seconds and client deadline around 35 seconds, cancellation through body reading, a 10 MiB body limit, and explicit retry. Do not spray retries across public endpoints. Public Overpass service is shared infrastructure; retain a replaceable endpoint and document a suitable service/self-hosted deployment boundary. [Overpass usage guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)

### Street eligibility and geometry

For this milestone, include OSM highway ways with these values:

`motorway, trunk, primary, secondary, tertiary, unclassified, residential, living_street, service, road, pedestrian, footway, cycleway, path, steps, track, bridleway`, plus `motorway_link, trunk_link, primary_link, secondary_link, tertiary_link`.

This intentionally includes pedestrian/cycle ways potentially relevant to lighting. Show their type so users can exclude them. Do not require a name or an existing `lit` tag. Exclude area features (`area=yes`), proposed/construction/abandoned features, and unrelated highway objects. Preserve access, service, bridge, tunnel, layer, and lit tags as source metadata when present. These tags do not establish public ownership or verified lighting. Document the supported class scope. [OSM highway definitions](https://wiki.openstreetmap.org/wiki/Key:highway)

“Within the RoI” means a way has **positive-length geometry inside or along the boundary**, including a street that crosses the RoI. Retrieve full candidate-way geometry, then clip to the actual polygon and measure only its in-region length. Retain OSM way IDs, node IDs, source tags, and retrieval timestamp; use `out meta geom;` if source version/timestamp metadata is desired. Support multiple clipped fragments of one way. Exclude a point-only touch.

Do not test only way centroids or only vertices: a segment can cross a polygon with both endpoints outside. Candidate retrieval must also handle this case. A practical query design is a union of eligible ways selected within the RoI bbox and eligible ways within a narrow buffer of its closed boundary polyline, then exact clipping. Overpass supports proximity to a coordinate polyline; verify it with a crossing-way fixture and a live sample. Do not claim a bbox/node-only query is exhaustive. [Spatial filters](https://dev.overpass-api.de/overpass-doc/en/full_data/polygon.html), [Overpass QL around syntax](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL#Relative_to_other_elements_(around))

Use about a 1 m boundary-query buffer only to retrieve candidates, not to expand final inclusion. Overpass bbox order is **south, west, north, east** and its coordinate polylines use latitude/longitude; GeoJSON remains longitude/latitude. Test both conversions explicitly. Build queries only from validated numeric geometry and fixed class filters.

Treat Overpass error remarks, incomplete geometry, byte/element limits, and malformed responses as incomplete/failed retrieval, not an empty successful list. Use a 5,000 candidate-way application limit; reject an oversized response with a smaller-region suggestion, never silently keep the first N. A successful empty result is distinct from failure.

### One row per street work item

OSM ways are segments, not necessarily whole named streets. Keep that distinction in the data:

- Group named ways by normalized `name` and topological connectivity through shared OSM nodes; preserve the original display name and constituent way IDs.
- If no name exists, use `ref` plus connectivity when available; otherwise label `Unnamed <highway type> · OSM way <id>` and keep it as an individual work item.
- Do not merge same-named but disconnected streets, or geometrically crossing ways that share no OSM node. Parallel carriageways may remain separate parts.
- Give ambiguous names a part label and stable ID. Preserve each segment's highway/bridge/tunnel/layer tags instead of flattening them.
- Group using source topology; clipped fragments are geometry for the region-specific work item. Document the grouping rule and test deterministic ordering/IDs.

Each row contains, in order: **participation checkbox (default checked), street name/identifier, type and in-RoI length, workflow status, Results button**.

Offer `Select all` and `Deselect all`, selected/total counts, and a master checkbox with indeterminate state. All eligible newly loaded streets start checked, even those without known imagery. Do not reset user exclusions during unrelated rerenders or imagery browsing. Row focus/selection highlights its geometry; checkbox toggling changes participation only. Unchecked street lines remain visible but muted.

The **Results** button starts disabled, with accessible explanatory text: `Available after inventory mapping is complete.` Keep it at the end of every row. The next section defines why preparation does not enable it.

## 5. Start Processing: a real preparation step, without segmentation

### Required behavior in this milestone

Add a primary **Start Processing** button to Settings, with concise explanatory copy:

> Prepares selected streets and available imagery for mapping. Lighting detection is not available yet.

The button runs **metadata/work-plan preparation only**. It must perform real validation and construct usable, inspectable work items; do not use a timer to simulate AI work, show invented progress, or create zero-lamp “results.”

Enable it when:

- There is a valid committed RoI and a successful, complete street response for that revision.
- At least one street is checked.
- Mapillary discovery has finished successfully for that revision, either with records or a genuine empty response.
- No discovery/detail request or preparation is currently mutating those inputs.
- No drawing draft is active.

Show the specific disabled reason. Mapillary authorization/network errors are not successful empty discovery. A successful but possibly truncated imagery response may be used for preparation with its warning preserved; preparation is not a claim of complete imagery. An empty imagery response may produce a clearly labeled preparation plan with **no imagery available**; do not imply the selected streets have no lights.

On click:

1. Freeze an immutable input snapshot: RoI and revision, selected street IDs and clipped geometry, street source/retrieval metadata, available in-RoI image records, discovered sequence IDs and load states, and all provider warnings.
2. Validate the snapshot and construct exactly one work item per checked street. Excluded streets generate no work item.
3. Reference a shared region-imagery pool by ID rather than duplicating thousands of image records per street.
4. Record preparation timestamps, an input fingerprint/revision, and stage status.
5. Display `Preparation complete — N streets ready; inventory mapping not implemented.` Include a real summary and an expandable `View preparation details` area.

This milestone does **not** assign images to individual streets. Each work item references the region-level pool with `imageAssociation: "pending"`; do not imply that every sequence covers every street or assign by nearest-road guesses. Image-to-street association, candidate sampling, and geometric inference require a later specification.

Preparation must not trigger full-image downloads, viewer playback, segmentation, light detection, or eager loading of all sequences. It uses the current available metadata snapshot and records unresolved sequence membership honestly. Browsing a sequence may expand this pool; the plan must then become stale until prepared again.

The run can be a focused client-side service/reducer with cooperative cancellation and small work batches. A durable queue, worker service, database, or synthetic processing endpoint is unnecessary. If preparation is fast, complete immediately; do not manufacture a wait.

### States and invalidation

Use distinct states for discovery, preparation, and future inventory completion. Suggested preparation states:

`not_started -> preparing -> prepared`, with `failed`, `cancelled`, and `stale` as explicit alternatives.

A street can be `excluded`, `not_prepared`, `preparing`, `prepared`, or `preparation_failed`. “Prepared” must not be called “Mapped” or “Inventory complete.” Use a separate inventory state initialized to `not_started`.

- Disable duplicate starts; while preparing, show `Cancel preparation`.
- Count actual completed work items if progress is shown.
- Cancellation invalidates the run generation immediately and prevents late success. Partial preparations are not usable results.
- On committing/clearing the RoI, cancel/discard the current run.
- Changing street participation or the source street/imagery snapshot makes a prepared plan stale. If changed during preparation, cancel it first.
- Display-only actions (sequence-list filter, map pan, selected-sequence visibility, viewer navigation) do not invalidate the plan unless they actually add/change available input metadata.
- Retrying a provider fetch must not silently replace the inputs of a currently “prepared” plan.
- Identical repeated preparation must not append duplicate street work items. Keep at most the latest in-memory plan and explain that reload clears it.

### Results buttons and future modal

A row's Results button becomes enabled **only** when a future inventory stage supplies a valid completed result for that street and the current input/run revision. A prepared plan, elapsed timer, viewer load, empty image query, or mocked response must never enable it in normal operation.

Implement the modal component and its data boundary now so the workflow is ready for real results. In this milestone it is verified through automated fixtures/component tests; do not add a production “mark complete” or fake-results switch.

The future completed-result modal must:

- Identify the street, constituent OSM ways, RoI/run revision, and mapping completion time.
- Present only supplied inventory records, source image references, review state, and supplied measurements with units/unknowns.
- Distinguish **no completed result** from a legitimate completed result containing zero assets.
- Explain that inventory geometry alone is not EN 13201 compliance.
- Support a title, Close button, Escape, focus containment, and return focus to the originating Results button.
- Refuse stale/wrong-street payloads; stale results cannot be shown as current.

Do not invent a final inventory schema or add editable asset CRUD here. A small typed result-view contract with test fixtures is sufficient. Keep preparation details accessible through their own clearly named control, separate from Results.

## 6. Data and integration boundaries

Retain Express, React, Leaflet, MapillaryJS, npm workspaces, TypeScript, and `packages/geo`. Extend focused modules instead of putting all orchestration in the existing `useRoiSearch` hook.

Suggested changes:

| Boundary | Responsibility |
| --- | --- |
| `App.tsx` / a focused workspace coordinator | Current RoI revision; coordinate discovery, street selection, sequence preview, and preparation. |
| `useRoiSearch.ts` | Preserve drawing/discovery behavior; repair cancellation/viewer selection; expose imagery snapshot identity. |
| New sequence feature | Group seed records, browse types, select sequence, load/cache detail, derive map-visible images. |
| New streets feature | Fetch on committed RoI, street list/checkboxes, map street layers and focus. |
| New preparation feature | Immutable inputs, validation, per-street work items, cancellation/staleness, preparation details. |
| `MapillaryPanel.tsx` | Continue as the single viewer; report actual image/sequence when supplied; preserve queue and cleanup. |
| Server provider modules/routes | Validated Overpass retrieval and bounded sequence membership/metadata loading. |
| `packages/geo` | Shared, tested clipping/measurement helpers if appropriate; use a maintained geometry library when helpful. |

Keep separate identities for: RoI revision, discovery snapshot, sequence detail generation, street snapshot, checkbox selection version, and preparation run. They can be simple counters/fingerprints rather than a new framework.

### API contracts

Preserve `POST /api/mapillary/images/search` and its existing compatible response for seed discovery.

Add these routes or clearly documented equivalents:

| Route | Request | Response semantics |
| --- | --- | --- |
| `POST /api/mapillary/sequences/:sequenceId/images` | Validated `{ roi }`; sequence ID validated as a bounded opaque provider ID | Ordered image records; sequence ID; per-record in-RoI flag and source-coordinate provenance; membership/detail status; returned/loaded/missing/invalid/in-region counts; retrieval timestamp; limit/error warnings. |
| `POST /api/streets/search` | Validated `{ roi }` | Street work items with stable IDs, display names, source ways/tags/node topology, clipped LineString/MultiLineString geometry, in-RoI length in metres, retrieval/source timestamps, and dataset status/warnings. |

The sequence-detail route may return both inside and outside records for the display-scope toggle. Mark them explicitly; preparation accepts only inside/boundary points under the existing original-coordinate-first rule. Do not lose outside members and then pretend to implement “Whole sequence.”

Validate complete envelopes and individual records at runtime on provider boundaries. Do not accept arbitrary upstream URLs, raw Overpass queries, client tokens, unbounded IDs, or client-supplied area/limits. Credentials remain in the existing server configuration; add only the Overpass URL placeholder/documentation.

Use safe error envelopes with stable codes for invalid request, missing configuration, auth failure, throttling, timeout, bad response, and limit exceeded. A failed sequence detail request may retain its seed points with a partial/error label. A failed street dataset must not masquerade as an empty successful dataset or enable preparation.

For sequence metadata batching, validate each entity independently and preserve missing/error counts. Verify member metadata belongs to the requested sequence where supplied. A deleted/unavailable image must not fabricate a location. IDs stay strings and timestamps have an explicit unit.

Keep one typed, immutable preparation snapshot containing:

- `runId`, `roiRevision`, `inputFingerprint`, start/end timestamps, and preparation state.
- Selected street work items keyed by stable street ID.
- References to shared street/source data and in-RoI image records.
- Discovered sequence references and retrieval status, including unresolved members.
- Inherited coverage/quality warnings.
- `inventoryStatus: "not_started"` and no completed result payload.

Do not persist provider imagery, create MongoDB schemas, or introduce server-side long-lived jobs for this milestone.

## 7. Acceptance criteria and verification for Muse

Extend existing tests with meaningful integration/state tests. Tests of the standalone move queue or pure grouping helpers alone do not verify the UI's event wiring.

| Scenario | Required outcome |
| --- | --- |
| Seed sequence grouping | Multiple images with one real sequence ID create one row; different IDs stay separate; unknown-sequence images are not combined into a fabricated sequence. |
| Type categories | True/false/null remain distinct; mixed and partly unknown membership is labeled honestly; browsing filters never silently drop processing inputs. |
| Sequence hydration | Member IDs absent from seed discovery can acquire valid positions; provider order is retained; all loaded members remain accessible through the list. |
| Sequence scopes | Inside RoI and Whole sequence display correctly; outside members never enter preparation. |
| Partial sequence | Missing entities, an oversized membership list, timeout, and cap all retain honest counts/status; never show “all loaded.” |
| Request race/cache | Select A then B; late A cannot replace B. Re-selecting loaded B does not repeat needless requests. Unmount/clear cancels outstanding work. |
| Viewer synchronization | Navigate within and between sequences, including outside the RoI; actual marker/highlight/status agree and no unwanted discovery chain starts. |
| Street query trigger | One logical request per committed valid RoI, including StrictMode; none on draw preview, pan, zoom, or checkbox changes. |
| Crossing geometry | A road crossing the polygon with both endpoints outside is retrieved/retained and clipped; bbox-only outside roads and point-only touches are excluded. |
| Concave polygon | A way entering/leaving several times yields correct disconnected fragments; in-region length excludes gaps. |
| Street grouping | Connected named source ways group; unrelated same-name ways, grade-separated crossings, unnamed ways, and parallel carriageways retain distinguishable IDs/topology. |
| Street eligibility | Named/unnamed roads and supported pedestrian/cycle ways appear; lack of imagery or lit tags does not remove them. Excluded classes/areas do not appear. |
| Street selections | All initially checked; one checkbox and select/deselect-all behave correctly; focus differs from participation; choices survive imagery browsing. |
| Street errors | Overpass HTTP error, error remark with HTTP 200, malformed/incomplete data, throttle, timeout, and response limits are not successful empty results. |
| Preparation inputs | Only checked streets generate work items; shared image pool contains only valid in-RoI records; image-to-street association remains pending. |
| Empty/capped imagery | Preparation reports the actual limitation; never synthesizes zero-light inventories or coverage percentages. |
| Start/cancel/retry | Disabled reasons are accurate; repeated starts don't duplicate items; cancellation and late responses cannot resurrect a completed state. |
| Invalidation | New RoI discards the plan; changed selections/data mark it stale; display-only changes do not. |
| Results gating | Prepared, cancelled, failed, and stale states keep Results disabled. Only a matching completed fixture enables it in tests. |
| Modal | Matching complete/zero-asset fixtures render correctly; stale/wrong-street data is rejected; keyboard close/focus restoration works. |
| Provider regressions | Deadline covers stalled bodies, already-aborted requests stop, cancellation after headers works, and fake tokens in upstream/viewer errors never leak. |
| Rendering scale | The supplied 1,135-image example becomes a compact sequence list; selecting a sequence plots its members without leaving every discovery dot visible. Test the 5,000-member detail bound without freezing the UI. |
| Layout | At desktop and narrow widths, sequence and street panels are readable; checkbox labels, status messages, keyboard focus, attribution, map resize, and viewer controls remain usable. |

Use mocked providers for deterministic tests. Fixtures must remain in tests, not become a fallback live dataset.

Run and report `npm run test`, `npm run typecheck`, `npm run lint`, and `npm run build`. Resolve meaningful failures in the touched workflow. Do not claim current tests cover cases they do not exercise.

Manually verify, when provider access is available:

1. A small Budapest RoI comparable to the supplied screenshot loads street rows automatically.
2. Find Mapillary sequences, inspect at least two sequences, and exercise inside/whole-sequence scopes and panorama categories.
3. Confirm returned sequence-member counts and missing/partial labels against real responses.
4. Uncheck a street; prepare; verify the plan excludes it and no Results button becomes enabled.
5. Change participation/metadata and confirm staleness; replace RoI while loading and confirm no old state returns.
6. Verify actual viewer navigation and map highlights, including navigation outside the selected sequence.
7. Record the tested RoI, capture/sequence IDs, timestamps, and observable results without tokens.

If live verification is blocked, name the blocked checks and required configuration. Do not claim provider completeness or insert fabricated success data. Finish with implemented behavior, verification results, known limitations, and configuration steps.

## 8. Scope and evidence boundaries

This milestone delivers sequence discovery/detail browsing, OSM street work items, user participation choices, and a real preparation plan. It deliberately does not deliver image segmentation, image-to-street matching, streetlight detection, manual inventory editing, measurement, photometry, exports, satellite imagery, or EN 13201 compliance.

No image count or sequence line is a count or location of lights. A street with no available imagery is not a street without lights. OSM street tags and image capture dates remain source evidence, not verified asset facts. Keep unknowns explicit and retain attribution for both providers.

Update README setup, architecture, limitations, new Overpass configuration, metadata limits, and the distinction between preparation and inventory completion. Preserve the previous specifications as history; do not rewrite them to pretend these features existed earlier.

## Official references

- [Specification 02](02_initial_tailoring.md) and [kickoff](01_OpenStreetLightMapper-Kickoff.md).
- [Mapillary sequences explained](https://help.mapillary.com/hc/en-us/articles/115001724849-Understanding-Mapillary-sequences-their-symbology).
- [Mapillary image API](https://www.mapillary.com/developer/api-documentation/#image), [sequence API](https://www.mapillary.com/developer/api-documentation/#sequence), [multiple entities](https://www.mapillary.com/developer/api-documentation/#multiple-entities), and [authentication](https://www.mapillary.com/developer/api-documentation/#authentication).
- [Official Mapillary SDK entity reference](https://mapillary.github.io/mapillary-python-sdk/docs/mapillary.config.api/mapillary.config.api.entities/).
- [MapillaryJS Viewer API](https://mapillary.github.io/mapillary-js/api/classes/viewer.Viewer/).
- [Overpass spatial selection](https://dev.overpass-api.de/overpass-doc/en/full_data/polygon.html), [bounding-box ordering](https://dev.overpass-api.de/overpass-doc/en/full_data/bbox.html), [QL reference](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL), and [service usage](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).
- [OSM highway tagging](https://wiki.openstreetmap.org/wiki/Key:highway) and [attribution/licensing](https://www.openstreetmap.org/copyright).

**Done means:** select a region, browse its discovered sequences and selected-sequence image locations, choose participating streets, and prepare a traceable work plan. No inventory is marked complete until a real mapping stage exists.
