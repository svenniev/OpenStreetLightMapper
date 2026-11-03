# OpenStreetLightMapper — 04: Detect to display inventory

## Instruction to Muse

Implement **Milestone 3: an interactive UI prototype for detect → review → manually merge → place → display inventory**.

The objective is to make the whole user journey usable and reviewable before connecting AI or a database. Implement working UI interactions and temporary state, not just static mockups. **No real detection, segmentation, database integration, or persistence is required or authorized by this milestone.**

Repository: `B:\2026\OpenStreetLightMapper`  
Predecessor: `docs/specs/03_workflow.md`  
Specification date: 2026-11-03

Inspect repository instructions and current implementation first. Preserve the existing map, sequence browsing, street selection, and preparation workflow. Retain the stack and styling. Meta Muse performs the coding; this file specifies the work. Do not commit, push, deploy, or modify actual environment files unless separately instructed.

This specification explicitly extends specification 03: the previously test-only result presentation must now be reachable through an **explicit, labeled UI preview workflow**, using demo or manually entered session data. This does not authorize fabricated live detection results or marking real inventory mapping complete.

## 1. Scope, integration, and temporary state

Current source inspection shows:

- `App.tsx` coordinates `useRoiSearch`, `useSequences`, `useStreets`, and `usePreparation`.
- `PreparationPanel.tsx` contains Start Processing and the preparation summary.
- `StreetPanel.tsx` accepts workflow statuses and a set of streets with Results available.
- `App.tsx` currently passes an empty Results-available set and a null result payload.
- `ResultsModal.tsx` already has result rendering, identity validation, and keyboard/focus behavior.
- Existing preparation types intentionally report `inventoryStatus: "not_started"`.

These are integration points, not a claim that every previous acceptance test has passed. Reinspect the files because implementation may change.

Keep existing Start Processing as preparation. After preparation, provide **Open inventory workflow** for each included street, or an equivalent street selector plus prominent action. An excluded street cannot start a new real-context preview. Add **Try demo workflow** as an always-available secondary action, including when the backend, Mapillary, or street data is unavailable.

All new review decisions, observation assignments, candidate assets, map placements, and preview results exist only in React/in-memory application state:

- No MongoDB, Mongoose schemas, server inventory endpoints, accounts, or background jobs.
- No localStorage, sessionStorage, IndexedDB, cookies, URL-encoded datasets, filesystem writes, downloads, or export feature for this workflow.
- Do not log evidence or draft inventory as a substitute for persistence.
- Keep state when closing/reopening the workflow or switching streets in the same page session.
- Reloading or closing the page loses the work. Display **Temporary session — changes are not saved** persistently.
- Use actions such as **Apply**, **Confirm**, and **Finish preview**, never “Save to database” or a misleading “Saved” toast.
- An optional before-unload warning may protect edited sessions; it must not claim browser recovery.

Static demo fixtures shipped in source are allowed. User changes to those fixtures are memory-only.

Do not implement AI calls, panorama conversion, automatic matching, triangulation, measurements, photometry, standards validation, or a job-processing service. Keep current provider integrations operational; new workflow actions must not start extra provider searches or bulk image downloads.

## 2. Two explicit entry paths

### A. Demo workflow: the complete testable journey

This is the required happy path for evaluating the UI without any services.

`Try demo workflow` opens an isolated sample street, sample image sequence, and a small deterministic observation set. Label the workspace **Demo workflow — sample observations, no AI has run**. Carry demo labels into asset details, map pins, the street row, and Results modal.

Use self-contained schematic street scenes, for example local SVG illustrations with recognizable poles and luminaire heads. Clearly identify them as illustrations. Give them synthetic IDs such as `demo-image-01`; do not invent Mapillary IDs, actual capture dates, or attribution. No remote imagery dependency is needed for this path.

The demo map can be a simple local street diagram with manual pin placement. Its positions are diagram coordinates, not geographic measurements. Do not invent longitude/latitude or put demo poles onto a real-world map.

Provide at least:

- Three illustrative viewpoints of the same sample street.
- Three observations of the same pole, two of another pole, and one distractor to reject.
- Luminaire observations allowing the user to attach two distinct luminaires to one pole.
- One uncertain observation to defer.
- A way to add a missed observation manually.
- An empty-detection example and an error/cancel example, selectable inside a clearly labeled demo scenario control.

Fixture names/IDs must not reveal or pre-apply the correct merge decisions. Keep any expected associations in test fixtures separate from the state users edit.

### B. Prepared street: manual-only preview

Opening a prepared real street creates a temporary preview tied to that street, preparation run, RoI revision, and input fingerprint. It begins with **zero observations**; never inject synthetic detections into real photographs.

Users can select available image references for the street and inspect them in the existing viewer. This is a manual choice, not automatic image-to-street association. Preserve image/sequence IDs and capture dates when known. Do not assume every image in the region belongs to the active street.

Show **AI detection is not connected**. Offer **Continue with manual observations** and a separate link to the demo workflow. The latter switches to an isolated demo context; it must not mutate this street's evidence or results.

Allow manual observations linked to the currently selected source image, a short object description, and a category. Pixel annotation is required for the static demo scenes; it is optional for live Mapillary imagery in this milestone. If an accurate source-coordinate annotation is not implemented for live imagery, keep the image reference and description with `imageRegion: null`. Do not draw fixed screen-space boxes over a rotating panorama or imply those boxes identify stable pixels.

Both entry paths use the same review, grouping, placement, and inventory-preview UI. The mode remains visible and is part of every record's provenance.

## 3. Workspace structure and navigation

Open a substantial workflow workspace, drawer, or full-width in-app view. Do not squeeze the whole workflow into Settings or a small modal.

Show:

- Active street and source mode.
- The persistent temporary-session notice.
- A step strip: **1 Detect · 2 Review · 3 Group assets · 4 Place assets · 5 Inventory**.
- Relevant counts: observations awaiting review, accepted, rejected, deferred; assets created; assets placed/unplaced.
- Back to workspace, Back/Next controls, and Reset this preview.

Keep the source image/illustration large enough to inspect. Put observations or asset cards beside it, with a map/placement area where appropriate. Preserve existing map/viewer lifecycle and resize handling.

Users can return to an earlier step without losing decisions. Navigating between steps is not a mutation. Later-step controls explain missing prerequisites rather than hiding the workflow. The Inventory step may show a **Draft preview** before the user finishes review.

Closing the view preserves its temporary state. Reset requires a concise confirmation only when edited work would be discarded; cancel preserves everything. This is a UI product behavior, not a request for Muse to pause implementation.

## 4. Step 1 — Detect

### Demo behavior

Show the available sample images with checkboxes and a **Run demo detection** button. The action produces deterministic sample observations for the selected images. It does not call a model.

Implement these visible states:

| State | UI behavior |
| --- | --- |
| Ready | Show selected image count and Run demo detection. |
| Running | Process the finite fixture list; show counts only as work is applied; offer Cancel. |
| Finished | Show returned observation count and Continue to Review. |
| Empty | Show “No sample detections in the selected images”; allow Add observation or explicitly review an empty set. |
| Failed | Show an actionable demo error and Retry; never equate failure to zero detections. |
| Cancelled | Stay on Detect; keep the pre-run state and allow retry. |

A short deterministic operation is sufficient. Do not fabricate model timings, accuracy, confidence, or a long “AI thinking” animation. Demo error/empty cases must be directly reachable through the scenario selector rather than random failures.

Apply a detection run atomically: cancellation or failure cannot leave a half-applied observation set. A rerun cannot silently wipe reviewed work or append duplicates. Offer **Replace demo observations** with confirmation once decisions exist; cancel preserves the previous state.

### Manual-only behavior

Show selected real image references and the unavailable-detection message. **Continue with manual observations** opens Review with an empty set. No fake spinner or simulated completion is shown for real imagery.

The future detector integration boundary can be a typed frontend function returning observations. The only implemented producer now is the deterministic demo adapter; live mode has manual entry. No model SDK, API token field, or dummy backend endpoint is needed.

## 5. Step 2 — Review observations

An **observation** is one sighting in one source image. It is not yet one physical asset.

Each observation card shows a session ID, source image, category, short description, origin (`Demo` or `Manual`), and decision state:

`pending | accepted | rejected | deferred`

Categories should cover **Pole/support**, **Luminaire**, and **Other/uncertain**. A pole and its lamp head must not be collapsed into one category. Unknown category can remain deferred.

Required actions:

- **Accept**, **Reject**, **Defer**, and **Return to pending**.
- Edit category and description.
- Add a missed observation manually, with a source image and category.
- In static scenes: select/highlight its bounding box; add, adjust, or remove a rectangle.
- Filter by decision/category; jump between observations and their source images.

For static scenes, store normalized image coordinates relative to the underlying illustration, not the CSS viewport. Overlays must remain aligned on resize and zoom. Do not use segmentation masks or claim pixel precision. Live source images with no annotation support remain reviewable via image reference and description.

Rejected and deferred observations stay visible under their filters. Retain them for traceability; do not silently delete their history. An optional rejection/defer note is enough; do not require elaborate forms.

Only accepted Pole/support or Luminaire observations can enter an asset group. Pending/deferred items do not block exploring the next step, but the finish action must require all pending items to be explicitly resolved or deferred. Deferred evidence remains an unresolved-count warning in the preview.

An edit to an observation already assigned to an asset must update that asset's review validity. Rejecting/defering it removes the assignment after an inline explanation and invalidates any finished preview. Never leave a confirmed asset silently supported by rejected evidence. Changing category while assigned requires detaching it from the incompatible asset first.

## 6. Step 3 — Manually group sightings into assets

This is the central workflow demonstration. A user identifies which accepted observations refer to the same physical object.

Provide a comparison area with selected observations side by side, their source images, and category. Provide an asset list beside it.

Required operations:

1. Select one or more accepted observations and choose **Create asset from selection**.
2. Select an existing asset and choose **Add selected observations**.
3. Select two compatible assets and choose **Merge assets**.
4. Remove an observation from an asset, returning it to accepted/unassigned.
5. Select part of an asset's evidence and **Split into new asset**.
6. Undo the latest grouping operation. Include merge/split and link changes, not only text edits.

Rules:

- Group pole observations into a pole/support asset and luminaire observations into a luminaire asset.
- Mixed pole/luminaire selections cannot merge; explain that these are related objects, not duplicate sightings.
- A single observation can belong to at most one active asset.
- Several observations may create one asset; a single accepted observation may also create one.
- Do not require matching image IDs; repeated sightings normally come from different images.
- Do not merge automatically because objects are close, share a sequence, or have similar labels.
- Do not merge across street sessions or mix demo and real-context records in this milestone.
- Give assets stable session IDs. Array reordering/filtering must not change identity.
- Keep evidence links and source observation IDs through all operations.

Show a merge preview before applying: selected asset IDs, combined observation count, retained ID, and any conflicts. If both assets have different map positions or support links, the user chooses the retained value/link or clears it. Never average coordinates or silently discard a relationship. State what changes, then apply as one undoable operation.

A split leaves the original asset's position with the original group; the new asset starts unplaced and unconfirmed. If removing evidence leaves an asset empty, exclude it from inventory and return it to a clear invalid/empty state until repaired or removed. Undo restores the exact previous state.

### Poles and luminaires are related separately

Allow **Attach luminaire to support** using an existing pole/support asset. Multiple luminaires can attach to one pole; never merge those distinct luminaire records merely to express this relationship.

Provide **Wall-mounted**, **Suspended**, and **Support unknown** alternatives when no pole is appropriate. No fake pole is required. Support links must remain valid after merges, splits, and removal; where a change is ambiguous, require a new explicit selection.

The inventory must count poles/supports and luminaires separately. Do not add both together and label the sum “streetlights.”

## 7. Step 4 — Manually place assets

The user selects an asset and chooses **Place on map**, then clicks a location and applies it. Allow repositioning, clearing the position, and cancellation of a draft placement.

- Real-context previews use the existing geographic map and WGS84 coordinates.
- Demo previews use the local street diagram and separate diagram coordinates.
- Never reuse the camera marker's coordinates as an asset position.
- Distinguish camera markers, draft placement, and confirmed asset markers by labels/shapes as well as color.
- Keep **Position unknown** as a valid explicit choice; an asset can appear in a preview without a point.
- Label user placements **Manually placed — approximate**, with no invented accuracy radius.
- Permit keyboard-accessible coordinate entry for real positions, with finite/range validation, and a keyboard alternative to moving a pin in the demo diagram.
- For this milestone, restrict real placements to the current RoI including the boundary; explain invalid clicks. This is a workflow scope rule, not proof of street membership.
- Street assignment is the active street chosen by the user. Do not snap to or automatically infer the nearest road.
- A luminaire may use its linked support's map location for display, labeled **Location inherited from support**; this is not its measured 3D position. If that support is unplaced, its inherited position remains unknown.

Pole height, mounting height, outreach, power, spacing, and lighting arrangement remain **Unknown / not assessed**. Do not estimate them from the illustration, image pixels, or placed pins. These attributes may be represented read-only to illustrate future inventory needs, but require no inputs or calculations now.

## 8. Step 5 — Inventory preview and Results

Display a live table plus corresponding placed-asset markers. Table rows contain:

- Asset ID and category.
- Support relationship for luminaires.
- Street.
- Position state/method and coordinates only where meaningful.
- Number of supporting observations and distinct source images.
- Review state and unresolved notes.
- **View evidence** and **Edit** actions.

Selecting a row highlights its marker; selecting a marker selects the row. Unplaced assets remain fully accessible in the table. View evidence shows the source observations and their decisions, not just a count. Demo image references must never launch Mapillary with synthetic IDs.

Provide filters for asset category, confirmed/unconfirmed, and placed/unplaced. Summary counts derive from active assets, not observations. Include a separate unresolved/deferred count. Do not present a coverage percentage.

Each asset has **Confirm asset** after the user reviews its category, evidence, support relationship, and location state. At least one accepted observation is required. Position may be explicitly unknown; a pole link or explicit non-pole/unknown support choice is required for a luminaire. Confirmation means the user's session review, not survey verification.

**Finish preview** is enabled only when:

- No pending observations remain.
- Every accepted observation is assigned to an asset; otherwise show the unassigned list.
- Every included asset satisfies the confirmation checks above.
- Any deferred observations and unknown positions are acknowledged through one clear unresolved-items summary.
- The session's input context is current.

An explicitly reviewed empty set may finish as **No assets recorded in this preview**. Do not say “No streetlights exist.” A failed or never-run demo detection cannot be finished as a successful empty run; manual mode can finish empty only after an explicit empty-review decision.

Finishing creates a frozen **session preview result** in memory. It does not mark the preparation plan's real `inventoryStatus` as mapped/complete. Later edits reopen review and invalidate the finished snapshot until the user finishes again.

### Results button integration

Replace the unconditional empty Results-available set with eligibility derived from the matching, finished session preview. Keep the row button disabled before that point.

- In real street rows, a finished manual preview enables **Results**, with adjacent **Session preview** labeling.
- In the isolated demo street view, the same button opens **Demo inventory preview**.
- Extend/reuse `ResultsModal` with a typed preview payload and unmistakable mode labels. Do not disguise a demo payload as a completed production inventory result.
- Keep street ID, RoI revision, input fingerprint, and run/session identity checks.
- Show the asset table, separate pole/luminaire counts, evidence links, placement state, outstanding limitations, and **Not saved — temporary preview**.
- Provide **Return to review** and Close.
- Keep keyboard focus containment, Escape, focus restoration, and readable narrow-screen layout.

No Save, Publish, Export, or “EN 13201 compliant” action is included.

## 9. State integrity and implementation boundaries

Use focused components/hooks or a reducer under the existing frontend feature structure. Keep demo fixtures, observations, assets, relationships, and result rendering separate. Avoid a large new state framework.

The minimum conceptual data separation is:

| Record | Essential session fields |
| --- | --- |
| Workflow session | Mode, session ID, street/context identity, input snapshot, active step, revision, dirty/finished/stale state. |
| Source image | Demo or Mapillary source, stable ID, sequence/capture metadata when known, image-region coordinate convention. |
| Observation | ID, image ID, category, optional normalized rectangle, description, origin, review decision and note. |
| Asset | Stable ID, category, observation IDs, review state, optional support relationship, typed placement, notes. |
| Preview result | Frozen matching context/revision, included assets/evidence, finish timestamp, mode, explicit temporary-preview status. |

Use a discriminated placement type: geographic coordinates, demo diagram coordinates, inherited support location, or unknown. Never pass diagram coordinates to geographic functions.

Derive observation-to-asset membership from a single source of truth, or enforce consistency atomically. Avoid independent mutable arrays that can leave one observation in two assets. All merge/split operations validate category, ownership, IDs, and support links.

Use a bounded session-level undo history for review/grouping/placement mutations, for example the latest 20 operations. Reset/replacement clears its history after confirmation. Undo must invalidate a finished result and recalculate derived counts.

Changing the prepared context must not silently relabel evidence:

- Switching streets preserves each street's temporary session.
- Changing the RoI/run/fingerprint marks affected sessions stale; do not auto-transfer observations or positions into the new context.
- A stale session is read-only with a visible reason and an explicit Restart preview action; its Results button is disabled as a current result.
- Leaving demo mode preserves or resets its separate state by an explicit action; it never merges with real sessions.
- Source-viewer navigation alone does not invalidate a review.
- Late demo-task callbacks and cancelled operations are guarded by session/run identity.
- Clearing/replacing the whole workspace warns before discarding edited previews; cancel leaves the existing workspace intact.

Do not weaken existing result validation merely to make a button clickable. Introduce a separate preview payload discriminator and adapt the modal deliberately. Keep any future real-result contract distinct.

Update UI text and README to explain the preview workflow, demo entry, manual-only path, temporary state, and deferred integrations. Do not rewrite earlier specifications as though AI or persistence existed.

## 10. Acceptance criteria and verification for Muse

The workflow must be testable entirely through visible controls, with no console commands, database seeding, manually edited IDs, or developer-only route needed.

Required walkthrough:

1. Open Try demo workflow without provider credentials.
2. Select sample images and run demo detection.
3. Accept several pole/luminaire observations, reject the distractor, defer one uncertain sighting, and add a missed observation.
4. Group repeated pole sightings, keep distinct poles separate, attach two luminaires to one support.
5. Merge two compatible asset groups, undo, then split an observation into another asset.
6. Place an asset on the diagram, move it, and leave another explicitly unplaced.
7. Review evidence, confirm the assets, acknowledge unresolved items, and finish.
8. Open Results; verify distinct asset counts, evidence, labels, and temporary status.
9. Return to review, change a decision, and verify the old finished result becomes unavailable.
10. Close/reopen the view, switch street context, reset with cancel/confirm, and reload to verify no state is persisted.

Add meaningful reducer/component integration tests for:

- Demo isolation and no synthetic annotations on real imagery.
- Demo happy/empty/error/cancel behavior, atomic rerun, and late-response suppression.
- Review decisions, manual additions, category edits, and normalized overlay alignment.
- Many observations → one asset; no duplicate assignment; category mismatch rejection.
- Merge conflicts, split/unassign, empty assets, stable IDs, and undo restoring relationships/positions.
- Two distinct luminaires attached to one support; valid link updates after merge/removal.
- Placement cancel/reposition/clear; camera coordinates never becoming asset coordinates; diagram/geographic separation.
- Finish gating, explicit empty review, unknown positions, deferred evidence, and correct counts.
- Session persistence only during the mounted application lifetime; no storage or inventory-write calls.
- Current/stale/edited result gating and wrong-street/mode payload rejection.
- Keyboard operation, labels, focus restoration, and usable desktop/narrow layouts.

Use the repository's existing test tools. Run `npm run test`, `npm run typecheck`, `npm run lint`, and `npm run build`. Manually inspect the complete demo flow and report which checks actually ran. Do not claim real AI accuracy or live detections were validated.

Check browser network/storage during the demo: it must not need provider/model/database calls. Existing app health polling is acceptable; keep any live workspace/background provider activity separate from demo behavior. The real manual-only path may use the existing Mapillary viewer but adds no detection/write service.

Finish with a concise implementation summary, UI walkthrough, verification results, and known limitations. Leave reviewable source changes for the owner.

**Done means:** the user can experience detect, review, manual matching, placement, and inventory display through the UI, using an explicit demo or manually created session observations. Nothing is stored persistently, and no AI-generated or production-ready inventory is claimed.
