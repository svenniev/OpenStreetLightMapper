# OpenStreetLightMapper — 07: Automatic detection and mapping

## Instruction to Muse

Implement an **automatic, server-run inventory workflow**: select an RoI, check several Mapillary sequences, launch once, and return a saved map of estimated poles and luminaires with their image evidence. No per-image review, manual grouping, or manual placement is required to complete an automatic run.

Repository: `B:\2026\OpenStreetLightMapper`  
Predecessor: `docs/specs/06_init_database_UI_clean.md`  
Reviewed baseline: `d8dae75` — working database, workspace system; clean working tree.  
Date: 2026-11-04

Preserve the existing manual workflow, workspaces, database volume, and saved results. This milestone extends them. Do not reset data, deploy, commit, or push. Implement a small working vertical slice first, then expand it; do not deliver only a simulated progress panel.

**The central distinction:** SAM supplies image detections, not geographic pole positions or identities across images. Camera coordinates are not pole coordinates. The user's expectation that poles are normally at least 10 metres apart is a useful anomaly check, not a universal rule or a safe merge radius. Nearby distinct poles, poles on opposite sides, intersections, and multiple luminaires on one support must remain possible.

Automatic output is explicitly **Automatically generated — not human reviewed**. When geometry or identity is ambiguous, finish with an unresolved record instead of inventing a location or silently discarding evidence. The goal is unattended execution with honest results, not a promise to locate every visible object.

## 1. Baseline review and prerequisites

The existing code now has MongoDB/Mongoose storage, GridFS evidence, revision-guarded workspace/session saves, saved result versions, and the cleaner panel order. Typecheck and lint pass; all 331 tests pass: 76 frontend unit, 102 component, 125 server, and 28 geometry tests. Tests used the existing guarded test database, not the working database. Review did not run paid inference or alter the user's browser session.

Address these findings while implementing this milestone:

| Current implementation | Required change |
| --- | --- |
| `routes/items.ts:197–206` completes an item by reading a document and later calling `save()`; the interrupt route uses the same pattern. Concurrent completion/interrupt requests can both observe a nonterminal state and overwrite one another. | Use atomic conditional state transitions, with worker ownership where applicable. A losing transition re-reads the winner; terminal results cannot be overwritten. Add concurrent tests, not only sequential idempotency tests. |
| `routes/sessions.ts:233–241` only checks session existence before accepting a result's claimed `sessionRevision`. `useWorkspaceStore.ts:954–960` builds the result from the latest tracked body after awaiting a flush, which may differ from the acknowledged body if another edit landed during the save. | Pin result contents to the exact acknowledged revision/snapshot. Validate that identity on the server; do not attach newer edits to an older revision. Preserve idempotent retries of an already-created result. |
| `useInventorySessions.ts` owns the inference queue in browser refs. `routes/detection.ts` is a single-call proxy tied to HTTP disconnect. | Add a durable server worker. Closing a browser must not cancel an automatic job. Reuse the SAM service directly, not loopback HTTP calls to this route. |
| `useSequences.ts` has one `selectedSequenceId`, used for browsing. | Add a separate persisted set of sequences included in an automatic run. Browsing a sequence must not toggle its checkbox. |
| `records.ts` keeps original/computed camera points; `imagery.ts` requests compass metadata but no full camera calibration/rotation. Inventory source records retain only camera position. | Add a separate, provenance-preserving pose/calibration descriptor and verified image-to-world geometry. The existing search coordinate preference is not sufficient for triangulation. |
| Existing `AssetPlacement`/result types describe manual, inherited, or unknown placement and confirmed results. | Add automatic estimated placement, geometric quality, and unreviewed status explicitly. Do not set `confirmed=true` just to bypass manual finish checks. |

## 2. User journey and UI

Keep the map top-left and contextual Street imagery top-right. Add **Manual / Automatic** mode near the workflow entry, not a new settings accordion.

1. User chooses/saves an RoI and searches Mapillary as today.
2. Sequence rows gain inclusion checkboxes, capture-date range, panorama/standard summary, and in-RoI image counts. Add Select visible / Clear selection; filtering never silently removes checked sequences. Show the total selected, including selections hidden by a filter.
3. A compact Automatic run panel below Sequences shows **Prepare run**, then **Launch automatic mapping** once a plan is ready. Preparing metadata does not call SAM. The launch button is the authorization to execute the displayed bounded plan; no repeated per-image confirmations.
4. During execution show phase, image/view/concept progress, failures, estimated mapped poles, luminaires, and unresolved observations. Offer Stop. The user can browse elsewhere or close the tab while the local backend continues.
5. Results appear on the main map and in a compact inventory table. Save automatically as a version of this run. Optional **Inspect / Open in manual workflow** supports corrections afterward; it is not a completion prerequisite.

Automatic mode does not require manually preparing or opening every street. Use the existing street snapshot/checks when available; group results by a plausible street after locating them. OSM failure must not block image processing: retain area-level results with street unknown. If streets were excluded, mark/exclude their confidently associated results from the street inventory without deleting the original detections. Ambiguous street assignments remain unassigned.

Keep advanced prompts, limits, matching thresholds, and diagnostics collapsed. Display ordinary progress and actionable failures in the run panel. Use the cleaned layout from #06; do not reinstate a crowded permanent sidebar.

## 3. Freeze a bounded, inspectable plan

Prepare all selected sequences through the existing membership/hydration services; filter images against the actual polygon, not merely its bounding box. Deduplicate image IDs across selected sequences. Preserve membership order, timestamps, retrieval limits, unresolved metadata counts, and sequence provenance. Never treat the discovery seed dots as complete sequence coverage.

Freeze the workspace/input revision, RoI, selected sequences, available street snapshot/checks, image IDs, view-generation recipe, exact prompts/model, and algorithm/config versions into a job input snapshot. Later edits create a new plan and do not change a running job.

For the first working version:

- Default to all successfully hydrated in-RoI images from the selected sequences, subject to explicit run limits. Do not silently take the first N.
- Start with a configurable hard ceiling of **100 source images and 200 SAM calls**, one SAM call in flight globally. These are application defaults, not provider limits. Images × generated views × enabled concepts determine calls; panorama views can make the call limit bind first.
- If over budget, disable Launch and offer a smaller selection or an explicitly selected preview sample. The preview should preserve short consecutive frame groups at several positions along each sequence, since isolated evenly spaced photographs can lose overlap. Show included/excluded counts and keep the resulting manifest deterministic.
- Any optional wider-area camera buffer must be separately displayed and included in the call estimate; default is no buffer. Images outside an RoI and objects outside an RoI are different things.
- Report usable pose/calibration counts per image type. Missing-pose images may still be detected, but are marked detection-only. If none support location estimation, say **No usable geometry: detections can run, map placement unavailable** before launch.
- Use the existing pole and luminaire prompts as separate concept calls. Allow poles-only, but do not silently omit failed luminaire calls from completion.

The run is bounded, not a claim of exhaustive coverage or detection recall. Sampling, provider caps, missing members, unsupported cameras, and outside-RoI results must remain in saved summaries.

## 4. Backend execution and persistence

Implement the worker inside the existing local Node server; no Redis, cloud queue, separate fleet, or new infrastructure service. The backend and Docker database must remain running. Headless means no dependency on React, an open tab, a viewer, canvas screenshots, or a browser timer.

Suggested modules: `apps/server/src/automatic/` for planning, worker, projection, association, quality checks and publication; small pure geometry functions can live in `packages/geo`. Keep browser-only dependencies out of server imports. Add routes for prepare/create, list/get jobs, stop, explicit resume, and paginated results. The UI uses these same routes; document a local API example, so the workflow is operable without the UI too.

Use durable records for:

- Job: stable ID, workspace ID, immutable input snapshot, configuration, status, timestamps, counters, lease/owner and result reference.
- Work item: stable job/image/view/concept identity, artifact reference, attempt, status, provider request identity, response/warnings, and error.
- Observations: immutable detection/mask references, geometry eligibility, extracted anchors, and provenance.
- Candidate assets: evidence membership, association decisions, estimate/uncertainty or unresolved reason, support links and street association.
- Result: immutable automatic version with counts, limitations and reproducible evidence/algorithm references.

Reuse existing evidence and detection-item storage where practical, with explicit ownership/type changes. Do not store every mask/base64 raster inside a workspace or repeatedly autosave all job results through the frontend's bounded session document. Paginate result/history reads and enforce document/body limits. Keep browser autosave from overwriting worker-owned job state. Existing manual sessions remain readable; use additive/versioned migrations without dropping collections.

Worker lifecycle: `queued → preparing → detecting → locating/matching → publishing → completed` or `completed_with_gaps`, with stopped/interrupted/failed states. Empty successful detection is a completed item, not a failure or proof that no streetlights exist.

Required execution guarantees:

- Save the plan before accepting launch; return a job ID promptly. Use a launch idempotency key, bound to the plan fingerprint. Double-clicks/repeated POSTs with that key return the same job, not duplicate paid work.
- Claim work atomically; persist a lease/ownership token and check it on completion. Two workers/tabs cannot claim the same item. Persist exact decoded inference pixels before calling SAM, then response before publishing downstream results.
- Fetch and prepare rasters server-side using the existing restricted Mapillary fetch path plus a tested image-decoding library. Validate decoded dimensions, orientation and memory bounds. Do not rely on 15-minute media handles after a restart. Store exact used views in GridFS with attribution and source links.
- Browser disconnection only stops polling. It must not interrupt work or invoke the old browser recovery routine against worker-owned items.
- Stop prevents new calls; allow the current call to settle and save its outcome where possible. Do not promise an upstream charge can be cancelled. Keep partial results accessible.
- On server restart, show Interrupted and allow explicit Resume. Reuse completed items and continue never-started items. A crashed/expired in-flight call with unknown provider outcome must not be automatically reissued; retain it as outcome unknown and offer an explicit new attempt. Resume does not grant blanket retries of uncertain calls.
- Retry safe metadata reads with bounded backoff. For SAM, distinguish explicit rejection/rate limiting from an ambiguous timeout/disconnect; never silently loop paid retries. Keep attempt links and prevent duplicate imports.
- On database loss, stop issuing new SAM work. Retain an in-flight response in memory and retry its save separately; if the process is then lost, report the unknown outcome honestly.
- Publish completion only after its result is durably stored. Publication is idempotent and recoverable if the process stops between storing results and updating the job reference.

## 5. Implement and verify image geometry first

Before running a large batch, prove projection and multi-view positioning on a small existing imagery sample. Detection accuracy alone does not establish position accuracy.

Request and persist the available camera model/parameters, original dimensions, EXIF orientation, computed position/rotation and altitude, original GPS/compass separately, and reconstruction/connected-component identifiers where provided. Check the currently accessible Graph fields using official documentation/provider responses; MapillaryJS entity property names are not automatically Graph field names. Optional missing fields should disable the affected geometric capability, not break all imagery loading.

Use a coherent pose family. Do not combine original GPS, computed rotation, assumed altitude and an invented focal length into a supposedly calibrated camera. Record which values are used; absent values remain absent. A compass heading alone does not provide full pitch, roll, intrinsics, or distance.

Support verified spherical panoramas and calibrated perspective images. Explicitly classify other/unknown models as unsupported for automatic positioning until implemented and tested. Do not infer spherical calibration solely from `is_pano`. Preserve detections from unsupported images.

For every inference view retain an invertible transform back to the calibrated original image, including resize, orientation, crop, and any panorama reprojection. For panoramas, use a deterministic set of overlapping perspective views if needed for usable SAM results; record yaw/pitch/FOV and count every view in the plan. A flat panorama crop must retain its spherical mapping. Handle the panorama seam; overlapping crops from one photograph are not independent viewpoints.

Implement image-pixel → camera ray → world ray and world point → image reprojection in a local metric coordinate system, then convert estimates to WGS84. Test axis direction, rotation inversion, units, longitude/latitude order, distorted perspective rays, orientation, and panorama wrap. Never use CSS/viewer coordinates or average camera GPS points as object coordinates. Do not implement pixel-to-metres using a guessed pole height.

Primary technical references: [Mapillary image entities](https://mapillary.github.io/mapillary-js/api/interfaces/api.ImageEnt/), [Mapillary coordinate systems](https://mapillary.github.io/mapillary-js/docs/theory/coordinates/), and [OpenSfM camera geometry](https://opensfm.org/docs/geometry.html). These describe camera/coordinate conventions; actual metadata availability and alignment still need verification on this application's images.

## 6. Detect, locate, and associate automatically

Keep three distinct identities: an observation in one image, a proposed physical asset, and a saved inventory version. SAM object IDs are request-local. Do not use image/sequence IDs or proximity alone as asset identity.

### Per-view observations

Retain all valid raw detections and masks, model/prompt, confidence if supplied, and truncation/invalid-output warnings. Confidence is not a calibrated probability that a pole exists. Bad/empty masks or unusable anchors can exclude a detection from positioning without deleting the observation.

Deduplicate overlapping view detections within the same original image using transformed masks/boxes and compatible category. Preserve provenance of both calls. Avoid collapsing two distinct shafts merely because their large boxes overlap.

Choose a repeatable geometric anchor: for a pole, a visible shaft/base point with explicit quality checks; for a luminaire, a consistently identifiable fixture point. A clipped/occluded lower mask edge is not automatically the pole's ground contact. Do not triangulate arbitrary box centres from different partial masks as though they were the same physical point. If a reliable point cannot be extracted, keep it unresolved; a tested vertical-shaft geometric method can be added, but must have its own documented model and fixtures.

### Multi-view hypotheses

1. Generate candidate correspondences from nearby frames and compatible categories, using camera poses and image geometry. Start within a sequence; use a spatial index/temporal window to bound comparisons rather than comparing every detection with every other detection.
2. Form candidate locations from intersecting calibrated rays for matching anchors; robustly fit/refine across supporting images. Require positive ray distance and adequate parallax. Reject behind-camera, distant, or ill-conditioned solutions.
3. Reproject each candidate into the supporting images. It must match the relevant anchor/mask, with no conflicting assignment to another distinct detection in that image. Require a clear best assignment; a repeated row of similar poles can produce multiple plausible intersections.
4. Default to at least **three distinct source images** with useful baseline for a mapped automatic pole. Two views may seed a hypothesis, but an ambiguous two-view result stays unresolved. Several crops of the same source image count once. Missing detections in another frame are not automatically negative evidence because of occlusion.
5. Consolidate across sequences only with compatible geometry, temporal context and evidence. Different reconstruction components or widely separated dates require stronger checks; conflicting positions/support layouts stay flagged as possible duplicates or temporal change. Do not silently identify a replaced pole as the same asset.

Make thresholds explicit, versioned and stored with the job. Initial engineering values to test, not guarantees: useful camera baseline at least 2 m, ray intersection angle at least 5 degrees away from parallel/antiparallel, range at most 80 m, and an estimated horizontal sensitivity radius at most 3 m for publishing a map point. Use normalized reprojection error (initially about 1% of image diagonal) together with local mask/anchor fit; that broad image threshold alone must not match adjacent poles. Validate/tune on representative imagery before enabling default launch.

Estimate sensitivity to pixel-anchor error and plausible pose/GPS error, including systematic alignment uncertainty. Record assumptions and the computed residuals; do not call a heuristic radius a statistical 95% confidence bound. More images do not eliminate shared GPS bias. If uncertainty exceeds the configured limit, retain the hypothesis as unresolved instead of drawing a precise-looking asset pin.

### Merge checks and the 10-metre expectation

Merge only compatible asset hypotheses supported by reprojection, assignment consistency and location uncertainty. Refit/recheck the entire merged cluster, not just the nearest pair; prevent chain merging A–B–C when A and C are distinct. At most one independent observation of an asset per source image after within-image duplicate handling. Two separated poles visible in the same photograph are strong cannot-link evidence.

Run a final close-spacing check: flag pole pairs less than **10 m** apart in comparable street/side context, and spatial duplicate candidates across sequence boundaries. This flags a suspected duplicate or unusual arrangement; it does not delete or automatically merge the pair. Opposite sides, junctions and islands can contain legitimate close poles. Use the fitted asset locations, never distances between camera points, for this check. If street/side is unknown, show an unclassified proximity warning instead of asserting an error.

Keep ambiguous duplicate groups separate from the consolidated count, with a visible possible-duplicate flag/count. A rerun creates a new result version; it must not append a second copy to an older inventory or merge over a user's reviewed corrections.

### Luminaires and support relationships

Detect luminaires independently. Never create one luminaire per detected pole by assumption. A pole can carry zero, one or multiple observed fixtures; poles may also be non-lighting supports.

Link a luminaire to a pole only when image evidence/geometry supports attachment and distinguishes other nearby poles. Prefer agreement in multiple views; ambiguous support remains unknown. Preserve multiple fixture identities on a single pole. A linked luminaire may inherit its pole's map position, labeled **Support position**, not measured fixture position or mounting height. Wall-mounted/suspended/unattached candidates remain possible and require their own supported position or remain unlocated. Count poles and luminaires separately.

## 7. Display and optional correction

Add a separate **Automatic inventory** map layer, visually distinct from image-camera dots and manually reviewed assets. Show estimated pole markers with uncertainty on selection; associated fixtures can be listed in the pole popup rather than stacked identical pins. Independently located fixtures use a different symbol.

Popup/table fields: category, automatic/unreviewed state, estimated/support/unknown location method, number of independent images/sequences, capture dates, support/fixture relationships, quality flags and evidence thumbnails linking to the original Mapillary images. Show nearby-duplicate warnings in plain language. An optional diagnostic view can display rays and reprojection overlays.

Show totals separately for detected observations, consolidated mapped poles, supported fixtures, unresolved hypotheses/observations, and possible duplicates. Do not call unresolved sightings unique physical assets or add them to a definitive inventory total. Use an Unlocated tab/list with reasons and image links; never put these at the camera position or `[0,0]`. Keep out-of-RoI located objects in evidence, excluded from in-RoI totals; boundary uncertainty should be flagged.

Publish a saved automatic result even when some items failed or geometry was unavailable. Call it Completed with gaps and disclose what was processed. A run with no located poles is a legitimate result, not a reason to fabricate markers. **Results** can open automatic versions but must label them separately from reviewed versions.

Open in manual workflow creates an editable draft from a selected automatic result, retaining provenance, masks and source rasters. Allow corrections/merge/split/place using existing tools. Review status changes only through explicit user action. Preserve the original automatic version and earlier reviewed results.

Do not report mounting height, EN 13201 compliance, complete regional coverage, or survey-grade pole spacing in this milestone. If distances between estimated points are shown in diagnostics, label them estimated and retain uncertainty.

## 8. Delivery order and acceptance

1. Fix the completion/result consistency gaps and introduce additive automatic data types.
2. Prove camera projection and one small multi-view pole location using real metadata and stored imagery. Record any unavailable pose fields or supported-camera limits before scaling the detector.
3. Implement server-only image preparation and the durable bounded worker; test with mocked SAM first.
4. Add multi-sequence checkboxes, plan summary, launch/stop/progress, and saved result map/table.
5. Add conservative association, uncertainty/spacing checks, fixture support, and manual-draft handoff. Validate a small real run, then expand within the displayed cap.

Required checks:

- Existing typecheck/lint/tests remain passing. New CI tests use mocked providers and the isolated guarded database; no live paid inference in tests.
- Geometry fixtures recover known points and reject parallel rays, behind-camera intersections, insufficient baseline, incorrect orientation, missing calibration and perturbed GPS/heading. Cover a cropped/rotated perspective image and panorama seam.
- Matching fixtures include one pole in three images, two poles less than 10 m apart in one image, opposite-side poles, a repeated row, overlapping crops, a chain-merge trap, conflicting sequences, and two fixtures on one pole. Wrong merges must fail even when all SAM masks are individually good.
- Pause/stop, tab close, server restart, DB outage, duplicate launch, two worker claims, simultaneous interrupt/completion, and idempotent publication preserve completed evidence without duplicate inference/import. Verify the stale-result revision case from the review.
- Persist/check multiple sequence selections and reopen them; changing the active browsed sequence must not change inclusion. Restore an automatic result without refetching imagery or rerunning SAM.
- Counts reconcile for all planned items, including empty/failed/truncated/unsupported/sampled-out outcomes. Spatial output respects actual RoI containment and keeps unknown locations unknown.
- Run a small real sample through the UI, close its tab while processing, reopen the workspace, and verify saved automatic map results and image evidence. Independently inspect a small subset afterward for validation (this is developer QA, not a user workflow gate). Report observations, mapped poles/fixtures, unresolved cases, duplicate warnings, and observed bad merges/positions; do not invent accuracy percentages without a labeled reference set.

At handoff state exactly which camera models/metadata were verified, the threshold values and run limits, checks performed, and remaining limitations. Deliver actual background execution and evidence-backed map estimates. If the available images cannot support positioning, clearly identify that blocker and still preserve the automatic detection results; detection-only output must not be described as successful automatic geographic inventory.
