# OpenStreetLightMapper — 05: Real imagery → SAM detection → reviewed inventory

## Instruction to Muse

Complete the smallest useful, demonstrable inventory MVP using the **actual Mapillary images already queried by the user**. Reuse the five-step workflow from specification 04: **Detect → Review → Group assets → Place assets → Inventory**.

The primary journey must show real photographs throughout, call SAM on explicitly selected image views, and let the user turn reviewed sightings into manually merged and placed assets. An illustration-only walkthrough is no longer the main deliverable.

Repository: `B:\2026\OpenStreetLightMapper`  
Predecessor: `docs/specs/04_detect_to_display_inventory.md`  
Specification/review date: 2026-11-03

This milestone supersedes 04's prohibition on model calls, image fetching, and real-photo annotations. It retains memory-only inventory state: **no database or persistence yet**. Muse implements the code; this specification is the handoff. Preserve unrelated working-tree changes. Do not commit, push, deploy, or change actual secret files unless separately instructed.

### Success in one sentence

Select an existing sequence and street, choose a few real image views, run SAM, inspect detections on those exact photographs, accept/reject/correct them, merge repeated sightings, place assets approximately, and open an evidence-backed inventory result.

## 1. Review of the current uncommitted implementation

The working tree contains both specifications 03 and 04 implementation, beyond the last commit. This review covered the integration, inventory domain/state, photo handling, and supporting provider code; it is not a full audit of every uncommitted line.

| Finding | Required response |
| --- | --- |
| `DetectStep.tsx` uses fixed `DEMO_IMAGES` for its working detector. Real mode only offers manual continuation. | Add a real-image selector and real SAM producer. |
| `ReviewStep.tsx:352–368` displays an image ID and “Open in viewer”, without the photograph or annotation canvas. | Render the selected photograph and overlays inside Review. |
| `GroupStep.tsx:26–30` renders a real source as text, while only demo sources have pictures. | Comparison must show actual photographs/crops and their marked observations. |
| `inventoryTypes.ts` supports only demo/manual origins and lacks source-view/model provenance. `ImageResult` contains metadata, not downloadable image data. | Add separate image-source/view and detection provenance records. Keep synthetic fixtures isolated. |
| `App.tsx:85` offers the entire in-RoI image pool to each street. | Explicitly select the sequence/images for the active street; do not claim automatic street association. Hydrated sequence members already merge into this pool. |
| `seedDemo.ts` constructs “Meta Way” from camera positions when Overpass fails. The screenshot is using this fallback. | Treat it as a temporary imagery work area, not a real street. Carry that provenance into workflow and results. |
| `inventoryReducer.ts:516–534`: returning assigned evidence to pending leaves its asset confirmed. Reaccepting it allows finishing without reconfirmation. | Invalidate asset confirmation when supporting evidence changes review state. Add a regression test. |
| `useInventorySessions.ts:290–301,530`: Undo has no stale-context guard and remains enabled when history exists. | Guard Undo in both UI and handler so a read-only stale session cannot mutate. Keep explicit restart/reset behavior separate. |

The illustrations follow specification 04; their presence is not a failure to follow that specification. This milestone deliberately changes the product direction.

Validation during review: workspace TypeScript and lint checks passed; 16 existing inventory reducer tests and 17 inventory component tests passed. A read-only reducer reproduction confirmed the pending/reaccept confirmation issue above. No live SAM inference was executed during this review.

## 2. Delivery order and scope

Implement in this order; demonstrate each slice before expanding it:

1. **Real photos throughout:** choose a sequence and up to five images, display them in Detect/Review/Group/Results, and add a manual annotation on a photograph.
2. **One live SAM call:** connect credentials, test one image with one prompt, and draw the returned boxes/masks on the same image.
3. **Small batch:** run the chosen prompts across selected views, review results, and finish one street/work-area inventory.
4. **Prompt comparison and corrections:** test alternative prompts, compare a small held-out set, and refine missed/poor detections.

Do not spend the deadline on a training platform, video assembly/tracking, automatic deduplication, triangulation, satellite analysis, database, exports, accounts, or EN 13201 calculations. Keep heights, spacing, power, mounting details, and arrangement unknown. This is an image-assisted inventory prototype, not a validated lighting survey or standards compliance result.

Use existing React/TypeScript, Express, map, grouping, placement, and Results components. Avoid a second parallel inventory application.

## 3. Get SAM access and expose readiness in the UI

Use hosted **SAM 3.1 through Meta Model API** as the first implementation. Official documentation currently identifies `sam-3.1`, the Responses API at `https://api.meta.ai/v1/responses`, and Bearer authentication. Recheck the linked documentation at implementation time. Muse's coding-agent sign-in does not establish that the application has a working model API credential. [Meta SAM overview](https://dev.meta.ai/docs/sam/overview)

Settings must contain a compact **SAM detection** section:

- **Not configured**, **Configured — not tested**, **Available — last test succeeded**, or a specific failed-test state.
- A **Setup instructions** disclosure with a link to the [Meta developer dashboard](https://dev.meta.ai/) and instructions: select the appropriate account/project, claim available hackathon credits if applicable, create an API key, set server-only `MODEL_API_KEY`, and restart the server.
- **Test on selected image**, enabled after configuration and one source view is ready. This sends one explicit inference request; show that it uses model credits and transmits the selected image to Meta.
- Model name, last test outcome/time, and actionable authentication, entitlement, quota/rate-limit, timeout, or network errors.

Follow [Meta's key setup instructions](https://dev.meta.ai/docs/quickstart). Do not assume a listed model, present key, or available credit proves access: only a successful image inference validates this application's route. Empty valid output is still a successful connectivity test.

Keep the key in the server environment, never a `VITE_*` variable, frontend bundle, browser storage, screenshot, log, or response. Update `.env.example` with placeholders and README setup guidance. The user performs account access, acceptance, and credential entry; do not ask them to paste secrets into chat. If credentials are unavailable, finish the real-image/manual workflow and provider adapter tests, but report live inference as blocked, not complete.

The health endpoint reports configuration only. It must not make chargeable inference calls. Limit model requests to explicit Test/Detect/Refine actions.

## 4. Make queried imagery the default workflow

Replace the prominent **Try demo workflow** button with **Use queried images** (or make the existing Open inventory workflow the single primary action). Opening it must reveal real thumbnails immediately.

Move synthetic scenes to a collapsed **Developer examples — illustrations** section, or leave them only in automated tests. Never silently fall back to them on API failure.

### Select input

Within Detect, show:

- Active street/work-area name and provenance.
- Sequence selector populated from existing discovery and hydrated sequence data.
- Filters for Panorama / Standard / Unknown, capture date, and an image strip/grid with checkboxes.
- Thumbnail, image ID, sequence, capture date when known, and Mapillary attribution/source link.
- **Use current sequence** and **Use current image** shortcuts. An image outside the RoI cannot silently enter this run.
- A visible count and **Choose images for this street** acknowledgement. Camera proximity or sequence membership alone does not prove street association.

Start with up to five selected images; hard cap ten inference views per run, including crops. Select across the sequence rather than choosing ten virtually identical consecutive frames. Show any sampling rule and allow replacement/unchecking. Opening the workflow does not start inference.

Freeze a selected-source manifest for the session. Keep images available when switching workflow steps. Lazy thumbnail retrieval must not mutate the preparation fingerprint or invalidate review. Meaningful RoI/street/source-set changes require a new run or explicit restart. Never attach a late result to a newly selected street.

### Keep the Overpass workaround usable and honest

If real OSM streets are unavailable, offer **Continue with selected imagery — street unverified**. Reuse the existing fallback mechanism only as a manually named work area. Do not describe its camera polyline as a road centerline, use it for street length/spacing, or assign a fake OSM identity.

Carry `streetSource: osm | manual-work-area | synthetic-demo` and real OSM IDs only where available through sessions, assets, and Results. Real photos and real detections are allowed in an unverified work area; its street assignment remains explicitly unverified. Retrying Overpass must not silently relabel old results.

## 5. Retrieve photographs and define stable inference views

Add a small backend image-metadata/media adapter using the existing Mapillary credential and an image ID. Fetch images by ID on demand, not the entire sequence.

Mapillary exposes thumbnail URL fields such as `thumb_1024_url` and `thumb_2048_url`; source creator and orientation metadata are also available. Verify supported fields in the current API. Use decoded image dimensions, not original-upload dimensions, for the actual image being analyzed. [Official Mapillary SDK entity reference](https://mapillary.github.io/mapillary-python-sdk/docs/mapillary.config.api/mapillary.config.api.entities/)

Use a same-origin image endpoint or equivalent backend-resolved media handle so the annotation canvas can read pixels without cross-origin tainting. Never send Mapillary credentials to the model. Do not scrape or screenshot the MapillaryJS/WebGL viewer. The contextual interactive viewer can remain alongside the static evidence workspace.

Media handling must be bounded: trusted provider-derived HTTPS destinations, redirect validation, request deadline, byte/decode limits, and a short-lived bounded in-memory cache. The endpoint must not accept arbitrary URLs as a general proxy. Signed image URLs are transient fetch details, not evidence identifiers. Refresh an expired URL without discarding annotations. Keep visible attribution and a link to the corresponding image. [Mapillary's official integration attribution guidance](https://github.com/mapillary/api-demo#attribution-requirements)

### Standard images and panoramas

For the deadline, use a **static decoded photograph** as the annotation surface. Correct orientation once, and send exactly that raster, or its recorded crop, to SAM.

Panoramas must remain usable: display the available panorama raster as a flat image, clearly labeled **Panorama — flat view may distort objects**, and allow the user to choose a rectangular crop around a visible streetlight area. Show the frozen crop before inference. This is sufficient for the MVP; perspective/cubemap conversion is deferred. If the supplied media format cannot be decoded correctly, show an explicit unsupported-source error.

A crop is a source view, not a new photograph. Record parent image ID, pixel dimensions, orientation, crop rectangle, actual inference dimensions, and a stable view ID. Keep uncropped access for context. A seam-crossing object may need a second crop/manual annotation; never imply complete 360-degree coverage.

Do not overlay static boxes on a rotating panorama viewer. No camera position becomes an asset location.

## 6. Detect and calibrate prompts — no model training required

“Training” in this milestone means **testing prompts and reviewing examples**, not updating SAM's weights. A Mapillary sequence is a collection of photographs, not automatically a video tracking session.

Provide editable short prompts with category mapping. Initial candidates to evaluate:

- `street light pole` → Pole/support
- `street light fixture` → Luminaire

These are hypotheses, not guaranteed effective prompts. Alternatives such as `lamp post` or `streetlight` may be tested one at a time. A broad “streetlight” mask may include both support and fixture; mark ambiguous results Other/uncertain until reviewed.

SAM's hosted prompt guidance uses one concept per request, with short noun phrases. Do not put pole and luminaire concepts into a comma-separated instruction. Box/point prompts are an alternative prompt mode for assisted refinement, not extra text mixed into the same concept prompt. [Official prompting guide](https://dev.meta.ai/docs/sam/segmenting)

### UI actions and states

- **Test prompt on this view**: one call, visible preview, no automatic insertion into accepted inventory.
- **Use these detections**: transfers the displayed test result once into pending observations.
- **Detect selected views**: show number of views × enabled concepts before running. Default concurrency one; maximum twenty calls for ten views and two concepts.
- Actual progress: queued, fetching, detecting, succeeded with count, succeeded with zero, failed, cancelled. No simulated detection spinner or fabricated scores.
- **Cancel** stops queued work and aborts the current request where possible; suppress late responses.
- **Retry failed** retries only failed items. Explicitly replacing a successful run requires confirmation if it affects reviewed observations/assets.

Keep results atomic per view/concept request. Completed items may remain after batch cancellation; clearly mark the batch partial and list unfinished views. Never interpret a failed request or malformed response as zero matches. Do not silently repeat chargeable POSTs.

Assign stable request/run IDs. Repeated callbacks or importing the same test result twice must not duplicate observations. Replacing one run must retain manual observations, invalidate affected asset confirmation, and expose any detached evidence. Do not clear unrelated street sessions.

### Small evaluation panel

Use three calibration images and two additional test images when available. Include both easy and difficult scenes, and a negative example when practical; do not cherry-pick only successes. Small pools are allowed and must show their actual size.

For each tested prompt/view, show returned candidates, accepted correct detections, rejected false positives, deferred items, and manually marked misses. Only show precision/recall when the user explicitly marks that view fully reviewed, excludes unresolved decisions, and has enumerated visible target objects consistently. Label metrics as **this reviewed sample**, with denominators; otherwise show counts only. Separate automatic text-prompt results from manually prompted/refined detections.

Optional box/point refinement may follow the first complete workflow. A user-drawn box locating a missed lamp is assisted segmentation, not evidence that automatic detection found it.

The [official SAM demo](https://segment-anything.com/) can help explore prompts outside the app. It is an online playground, not an offline training dashboard. The [research repository](https://github.com/facebookresearch/sam3) provides inference and fine-tuning resources, but custom training requires a separate dataset/evaluation and compute effort. Do not make it a dependency of this MVP. The application's own one-image test remains the acceptance test for the deployed API integration.

## 7. Backend contract and evidence provenance

Keep the service small: an image/view preparation boundary and one-image detection endpoint; the browser orchestrates a bounded queue. No database, persistent jobs, or multi-provider framework.

Suggested application contract:

- `GET /api/imagery/:imageId`: validated source metadata/attribution and an app-owned media handle.
- A media/view route serves the exact decoded input and optional recorded crop.
- `POST /api/detection/sam`: validated image/view handle, one concept or supported visual prompt, and request ID.
- Response: request/view IDs, model/prompt provenance, input dimensions, parsed objects, and a genuine success/empty outcome; sanitized typed errors otherwise.

Use the official `@meta-sam/parser` rather than assuming SAM returns JSON masks or inventing a parser. The output uses a special-token grammar; the library handles boxes/masks and coordinate conventions. Verify inclusive wire coordinates versus the library's rectangle representation before normalization. Apply decoded masks to the identical inference raster. [SAM client libraries](https://dev.meta.ai/docs/sam/client-libraries)

Follow the [official TypeScript image example](https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/01_api_basics) for transport and parsing. Use request cancellation, an explicit configurable deadline (initially 120 seconds), bounded responses, and stable error messages. Keep raw provider bodies, credentials, and signed URLs out of logs/UI. Use documented retention controls where supported; do not claim control over provider-side retention.

Extend the existing model with these responsibilities, choosing idiomatic names:

- **Source image:** Mapillary ID, sequence/capture metadata, attribution/source link, camera position explicitly typed as camera position.
- **Source view:** immutable view ID, image ID, dimensions, orientation/crop/resize transform, reference to exact raster.
- **Detection run/item:** source manifest, provider/model, exact prompt and category intent, actual timestamps, per-item outcome, request ID.
- **Observation:** view/image IDs, normalized region, mask reference if available, origin `sam-text | sam-assisted | manual`, model/run provenance, decision/note.
- **Asset/result:** existing evidence links plus street/work-area provenance and processing/review summary.

Provider object IDs are local to the request, not globally unique poles. Confidence is nullable; show it only if the actual API returns a documented score. Preserve the original model geometry separately from a manually adjusted box. Manual corrections must not masquerade as new model masks.

## 8. Complete Review, Group, Place, and Inventory on real evidence

Reuse existing domain rules, fixing the review defects in section 1.

- **Review:** large real image, selectable masks/boxes, pan/zoom, observation list, accept/reject/defer, category edit, and manual rectangle for missed objects. Overlay alignment must survive resizing, image switching, crop transforms, and zoom. Hide/mark a model mask stale when its associated annotation is manually changed.
- **Group:** side-by-side photographic evidence with highlighted regions and full-image context. Keep create/add/merge/split/unassign/undo. Do not auto-merge by sequence, appearance, camera proximity, or SAM object ordinal.
- **Place:** manually place on the map or explicitly choose unknown. Keep poles and luminaires separate, allow multiple luminaires per support, and preserve inherited-position labeling.
- **Inventory/Results:** table and map selection synchronize; View evidence opens the actual source view and detections. Include model/prompt provenance, manual edits, reviewed asset counts, processed/failed/unprocessed image counts, and unverified street warnings.

One image sighting is not one unique asset. Counts must distinguish observations, poles, and luminaires. Process one street/work area for the demo; cross-street duplicate reconciliation remains out of scope.

Update current hardcoded “AI detection is not connected” / “no AI has run” messages according to actual provenance. A completed review can be labeled **Inventory reviewed — session only**, while preparation remains a separate stage.

Finishing requires no pending observations, accepted observations assigned, included assets reconfirmed, and explicit acknowledgement of deferred evidence, unknown positions, and any incomplete image processing. Incomplete processing cannot produce “street fully mapped” or “no streetlights exist”. Preserve an explicit manual-only completion path when SAM is unavailable.

Keep all source selections, detections, corrections, and inventory in memory. No browser storage, disk image archive, automatic downloads, database, or exports. Display **Temporary session — refresh loses this work**. Bound and release blob URLs, masks, and image buffers; avoid cloning raster bytes into every undo snapshot.

## 9. Acceptance and handoff

Automated regression checks must cover:

1. Correct photo/view identity and overlay alignment, including an oriented image and panorama crop.
2. Mocked SAM positive, valid empty, malformed, timeout, access-denied, and rate-limited responses.
3. Cancellation, stale-session responses, retry/import deduplication, and no silent replacement of reviewed evidence.
4. Returning evidence to pending clears asset confirmation; Undo cannot edit a stale session.
5. Synthetic fixtures never enter real sessions; unverified street provenance survives Results.

Retain existing inventory tests and run typecheck/lint plus affected tests. Add no live-model calls to CI.

The live acceptance walkthrough is mandatory once credentials are available:

1. Query an RoI; select one real sequence and an OSM street or explicitly unverified work area.
2. Open the workflow and see actual queried thumbnails, not illustrations.
3. Test SAM on one view, then process a small batch; visibly inspect returned overlays.
4. Record actual correct/false/missed examples. If no useful detections are obtained, report that outcome and the tested prompts rather than injecting fixtures.
5. Review observations, merge repeated sightings, attach luminaires, place at least one asset or explicitly leave it unknown.
6. Finish review and open Results with real photographic evidence and accurate limitations.
7. Switch away/back without losing state; refreshing clears the temporary session as stated.

Report changed files, checks run, tested source image IDs/prompts and observed outcomes without secrets. Distinguish **UI implemented**, **API verified**, and **automatic streetlight detection demonstrated**. A mock provider test proves only the first integration boundary, not model accuracy. Prioritize one credible end-to-end demonstration over feature breadth.
