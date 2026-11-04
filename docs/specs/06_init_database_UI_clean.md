# OpenStreetLightMapper — 06: Local database and UI cleanup

## Instruction to Muse

Implement durable **local persistence for selections, detection evidence, review work, and inventory results**, then reorganize the interface around the order in which the user works.

Repository: `B:\2026\OpenStreetLightMapper`  
Predecessor: `docs/specs/05_detect_to_display_inventory_2.md`  
Reviewed baseline: `e87ec8e` — image segmentation MVP working  
Date: 2026-11-03

The working tree was clean when reviewed. The user reports good pole segmentation and mixed luminaire results. Preserve the working SAM/image pipeline; this milestone is about retaining work and making it easier to operate, not retraining the detector.

Use **MongoDB + Mongoose**, as already selected in the kickoff specification. The user has Docker running. Implement and actually start a new project-specific database container, document its lifecycle, and verify saving/reopening real application state.

This specification supersedes previous prohibitions on database persistence and on editing the server environment file: **the user explicitly requests updating `apps/server/.env` and `apps/server/.env.example` for this local database**. Preserve every unrelated environment setting and secret. Do not commit, push, publish, or deploy.

## 1. Meaning of “offline” and scope

Keep the database and application development deployment on this computer. No MongoDB Atlas, cloud database, hosted storage, authentication service, or remote deployment.

“Local database” does not make Mapillary, Overpass, basemap tiles, or hosted SAM work without an internet connection. Existing online integrations continue as before. Saved selections and results must open without calling those providers; saved analyzed image views should remain reviewable locally. New searches and inference still need their respective providers. Explain this distinction in setup documentation, not as repeated clutter in the workflow.

Primary acceptance: **choose an RoI, select streets/images, detect/review/merge/place, save, refresh the browser, restart the server and database container, then reopen the same work without re-running SAM.**

No multi-user collaboration, cloud synchronization, automatic background inference, public database access, photometric calculations, or export subsystem in this milestone.

## 2. Review findings to address

Review included source inspection and the running initial UI in a separate browser tab; the user's existing processed browser session was not modified. No paid inference was run.

| Finding | Action in this milestone |
| --- | --- |
| `useRoiSearch`, `usePreparation`, and `useInventorySessions` retain selections/results only in React state. `app.ts` does not connect to a database. | Add explicit persistence/restore boundaries and honest save status. |
| `SourceView.mediaHandle` points to a server-memory handle. `imagery.ts` expires handles after 15 minutes and loses them at server restart. | Durable evidence must reference stored artifacts/image identity, never a transient handle alone. |
| `inventoryReducer.ts:518–541` marks a view successful if any concept succeeds, hiding failed concepts for that view. Reproduced: pole succeeds, luminaire fails → one successful view, zero failed views. | Persist and display per-view/per-concept outcomes, with an explicit partial state. |
| `inventoryReducer.ts:1001–1005` slices history to five runs. Reproduced: five prompt tests evict the prior batch; its incomplete-item warning disappears. | Separate bounded UI history from durable processing history; never discard referenced evidence or failures. |
| `useInventorySessions.ts:760–774` drops `response.truncated`, although the server caps detections at 200 objects. | Preserve truncation and invalid-object warnings through runs, review, and saved results. Do not present partial output as complete. |
| `App.tsx` nests sequences in the map column beside imagery; `.workspace` grid stretching makes imagery as tall as map plus sequences. | Put sequences outside that top-row height calculation and align panels to their own content. |
| `App.tsx` renders InventoryWorkspace before StreetPanel. | Render Streets in region before the main working-image workflow in both DOM and visual order. |
| Settings mixes navigation, processing, provider setup, diagnostics, and developer examples; the initial UI repeats “Inventory workflow” and says detection is unavailable. | Move actions to their owning panels, put configuration in a drawer, and correct stale/duplicate text. |

The previous pending/reaccept confirmation and stale-Undo defects are fixed in this baseline. Keep their regression coverage.

Checks passed: workspace typecheck/lint, 105 backend tests, 67 frontend unit tests, and 90 frontend component tests. The component run emitted connection-refused warnings from unmocked localhost requests despite passing; make those provider/image calls deterministic in affected tests.

## 3. Local Docker setup and environment

Create this obvious infrastructure location:

```text
infra/
  database/
    compose.yaml
    start.ps1
    stop.ps1
    status.ps1
    README.md
```

Requirements:

- Docker Compose project name `openstreetlightmapper`, service `mongodb`, new container `openstreetlightmapper-mongodb`.
- Use a supported MongoDB Community image, pin an explicit tested version rather than `latest`, and record it in the README. Choose the matching Mongoose version for the repository's Node runtime.
- Publish **`127.0.0.1:27018:27017`**, avoiding the common host port 27017. Do not bind the database to all interfaces.
- Use a project-specific named volume mounted at the image's database directory; persist data across container restarts/recreation.
- Add a real MongoDB ping healthcheck and a suitable restart policy.
- A single standalone server is enough; use the atomic document/revision design below rather than requiring replica-set transactions.
- For this local-only milestone, authentication-free MongoDB on the loopback-published port is acceptable. Document it as local development configuration, not a remotely deployable setup. Keep the backend/dev server local too; no public binding or tunnel.
- Do not introduce a database admin web container.

`start.ps1` resolves its paths relative to `$PSScriptRoot`, checks Docker/Compose availability and name/port conflicts, starts only this Compose service, waits for health with a bounded timeout, and returns a useful error if startup fails. Running it again must be harmless. Never stop, overwrite, or delete unrelated containers to resolve a conflict.

`stop.ps1` stops this service without removing its volume. `status.ps1` shows this project's status. No normal start/stop command may use `down -v`, prune, drop, or delete data. Do not implement a destructive reset button.

Update both environment files to the actual tested local connection:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27018/openstreetlightmapper
```

Update only the MongoDB setting/comment in the actual `.env`; do not replace the file with the example. If creating it is necessary, preserve other configuration sources. Ensure it remains Git-ignored. Never print the file or unrelated tokens. The example must contain placeholders for provider secrets, not copied credentials.

Document root-relative commands for start, status, stop, reconnect, and server startup; database name, port, volume location/lifecycle, tested image/runtime versions, and common Docker-not-running/port-conflict failures. Link this README from the root README. Include a small backup/restore recipe using MongoDB tooling; restore into a separate named database for verification, not over the user's working database.

Relevant primary references: [Mongo Docker image](https://hub.docker.com/_/mongo), [persistent Docker volumes](https://docs.docker.com/engine/storage/volumes/), and [loopback port publishing](https://docs.docker.com/engine/network/port-publishing/).

## 4. Connection and API lifecycle

Add a small database module and Mongoose schemas under `apps/server/src/db/`. Connect once per process, with bounded connection timeout and reconnect/status handling; close cleanly on shutdown. Avoid Mongoose's implicit buffering making writes appear to hang or succeed while disconnected. [Mongoose connection guidance](https://mongoosejs.com/docs/connections.html)

Extend health information to distinguish backend availability from database readiness. Return a sanitized state such as connected / connecting / unavailable; do not expose the URI or credentials. A present environment variable is not a successful connection.

If the database is unavailable:

- Keep the app usable enough to view already loaded work.
- Clearly show **Not saved — local database unavailable**, preserve dirty state, and offer Retry save.
- Do not silently fall back to another database, localStorage, or fake success.
- Disable starting new paid detection requests until their workspace/input can be recorded. Existing unsaved edits remain in memory with an honest reload-loss warning.

Use typed, validated request/response contracts. Reject unknown schema versions, invalid coordinates, broken evidence/support links, oversized payloads, and synthetic/real context mixing. Apply explicit body/artifact size limits per route rather than increasing the global JSON allowance without bounds.

Provide small REST boundaries for workspace list/create/open/update, session load/update, immutable detection items, evidence artifacts, and reviewed results. Keep implementation simple; no generic repository framework or job queue.

## 5. What must be saved

Introduce a named **Workspace** as the unit the user can reopen. It contains an RoI and its related streets, imagery selections, and inventory sessions. A Workspace menu supports New, Open, and Rename; default names may use area/date. No permanent deletion is needed now.

| Data | Durable content |
| --- | --- |
| Region/context | Committed polygon, shape, bounds, stable input revision, map center/zoom, workspace name. Do not save half-drawn vertices as the current RoI. |
| Streets | Retrieved street snapshot with geometry/OSM identities and query warnings, inclusion checkboxes, focused/active street, manual-work-area provenance. |
| Imagery choices | Discovery metadata needed to restore the list, selected sequence/type filter/scope, selected image IDs and stable order, image/sequence metadata and retrieval limitations. |
| Preparation | Prepared plan, source snapshot IDs, input fingerprint, included streets, incomplete/warning states. |
| Workflow | Active session/step, frozen source manifest, original/cropped view descriptors, concepts and category mappings, fully-reviewed flags. |
| Detection | Every executed item and attempt, exact prompt/model, source-view identity, raw parsed geometry/masks, success/empty/failure/interrupted/truncated status, timestamps and provider request identity where available. |
| Review | Accepted/rejected/deferred decisions, manual additions, notes/category edits, original model geometry versus user-adjusted geometry. |
| Inventory | Stable asset IDs, evidence membership, merges/splits as current state, support links, manual/unknown/inherited positions, confirmation state. |
| Results | Immutable reviewed-result versions with counts, limitations, provenance, the exact evidence/review snapshot and input revision they summarize. |

Do not serialize React hooks, Maps/Sets without an explicit representation, Leaflet objects, timers, AbortControllers, object URLs, signed provider URLs, API secrets, or connection state. UI history/undo stacks may reset on reopen; domain state must not. UI-only preferences can be lower-priority saves.

Use stable workspace/session/run/item/observation/asset IDs. Current per-page integer counters alone are insufficient across workspaces and restarts. Scope uniqueness explicitly. Preserve selected OSM IDs as external identities, never confuse them with database IDs.

Changing an RoI or source selection creates a new input revision. Preserve earlier sessions/results as historical, marked with their original context. Deselecting a street excludes it from future processing; it does not delete its saved assets. Clearing the active map region likewise must not silently erase stored results.

## 6. Storage shape, evidence, and consistency

Prefer a few domain collections: `workspaces`, `inventorySessions`, `detectionItems`, `inventoryResults`, plus immutable input snapshots/artifacts where needed. This is a suggested organization, not permission to duplicate all state in every collection.

Keep the small mutable review/asset state for a session together so a merge/split is one atomic update. Give mutable records `schemaVersion`, monotonic `revision`, and server timestamps. Update with expected revision; return conflict on mismatch rather than overwriting a newer edit. [MongoDB atomic updates](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)

Do not put unlimited runs, thousands of full image records, repeated SVG masks, or base64 photos into one growing workspace document. MongoDB documents have a 16 MiB limit. Keep metadata bounded, separate large snapshots/artifacts, and return actionable size errors without truncating saved evidence. [MongoDB limits](https://www.mongodb.com/docs/manual/reference/limits/)

### Preserve the exact images that were analyzed

Store the **selected analyzed/annotated raster views** and their masks in local MongoDB-backed artifact storage, using GridFS through the existing database connection. This is narrowly scoped evidence persistence, not a bulk image downloader.

The current detection request already carries the exact inference raster. Reuse it rather than capturing the viewer or fetching a second potentially different image. For manual-only review, persist its frozen source view when the user commits an annotation. Keep content hashes, MIME type, actual dimensions, crop/orientation transform, image ID, attribution, and source link. Deduplicate immutable artifacts by content identity where practical.

Save only images used as evidence, not every thumbnail or whole Mapillary sequence. Evidence bytes belong in the database volume, never Git or environment files. Serve stored evidence through the local backend, with bounds/validation; do not inject stored SVG markup as arbitrary HTML. [Node driver GridFS documentation](https://www.mongodb.com/docs/drivers/node/current/crud/gridfs/)

Durable records reference artifact IDs. The 15-minute media handle remains only a fetching convenience. Reopening a saved result must work after that handle expires and after a server restart. If an older record lacks local pixels, show “Source image unavailable locally” and an explicit refetch action; never silently place old masks over a different raster. Preserve attribution in local review.

Write artifacts first, verify they are complete, then publish referencing state/result documents. Interrupted uploads must not appear as complete evidence. Without transactions, use idempotent staging and an atomic final reference update; orphaned unreferenced artifacts may be left for later maintenance. Do not pretend several independent document writes are atomic.

### Detection recovery

Register a stable item/request ID and its input before inference, and persist the parsed response before reporting it saved. Repeating a transport/save request with the same ID must not cause another paid inference or duplicate observations.

On server/browser restart, restore queued/running items as **Interrupted — not automatically retried** unless a completed saved result is found. Offer recovery/import of a completed result by its item ID. A new paid retry is an explicit user action; do not claim exactly-once model execution when a provider timeout leaves the outcome unknown.

If the database drops after a model response arrives, retain the returned result in memory and show **Detection completed, result not saved**. Retry persistence separately from inference. Do not discard the result, report it saved, or immediately charge for a repeat call.

Fix the review findings: keep all durable run records even if only five are rendered initially; paginate history. Derive completion for the current frozen view/concept work plan, with attempt/supersession links. A view is complete only when all its required concept items have usable results. Partial, failed, interrupted, truncated, and discarded-invalid-output counts must survive reopening. An unrelated later prompt test must not erase earlier batch limitations.

## 7. Save, restore, and reviewed-result behavior

Use **debounced autosave** for committed selection/review edits, plus a visible **Save now** action. Start around 750 ms after the last edit, with a bounded maximum wait during continuous work. Save significant detection-item completions promptly. Avoid a write on every pointer movement; save a committed rectangle/pin once its gesture completes.

Header save states: **Loading workspace**, **Unsaved changes**, **Saving…**, **Saved locally · time**, **Save failed · Retry**, and **Conflict**.

- Serialize saves per record; coalesce later edits without dropping them. A response acknowledging revision N cannot mark newer revision N+1 edits saved.
- Never autosave the initial empty React state while a stored workspace is loading.
- Restore RoI, streets, imagery metadata, plan, and session context coherently before enabling effects that would query/reset them.
- Opening a workspace/results must not automatically refresh providers, create a new RoI revision, invalidate its preparation, or run SAM.
- Use a workspace ID in the URL, or an equivalent explicit Open menu, so browser refresh loads the same workspace from the server.
- Flush/await pending saves before switching workspaces. On failure, keep current work and offer Retry or explicit discard; do not silently navigate away.
- Warn before reload/close only when unsaved changes or in-flight work exist. A warning is not a guarantee that browser shutdown can finish a write.
- A second tab with an old revision gets a conflict. Keep its local edits and allow reload of the newer stored version or explicit Save as new workspace; never silently merge or overwrite.

**Finish review** becomes **Save reviewed result**. Run existing domain checks, persist outstanding evidence/edits, then create an immutable reviewed snapshot with idempotent identity. Show completion and enable the saved Results action only after the server acknowledges it.

Later editing opens a draft and requires reconfirmation where appropriate. Keep the prior result accessible as a historical version; never rewrite the evidence beneath it. A newer unfinished draft does not make the older saved version disappear. Incomplete imagery can be acknowledged, but must remain disclosed in the result.

A saved result means durable local user-reviewed inventory. It does not mean measured asset positions, complete street coverage, or EN 13201 compliance. Keep those distinctions.

## 8. UI cleanup: panel order and ownership

Remove the permanent crowded Settings sidebar. Use its width for the working area, and place a **Settings** button in the header opening a properly labeled drawer/dialog. Keep normal workflow actions visible in their owning panels.

Desktop structure:

```text
Header: app | Workspace / Open / New | save state | Save now | Settings
+-----------------------------------+----------------------------+
| Map — existing tools/behavior      | Street imagery             |
|                                   | viewer + compact caption   |
+-----------------------------------+----------------------------+
| Mapillary sequences — compact selectable list and summary      |
+----------------------------------------------------------------+
| Streets in region — include checkboxes, active street, Results |
| Prepare selected streets / Open inventory workflow             |
+----------------------------------------------------------------+
| Inventory workspace — active street + five-step navigation     |
| Large working image / comparisons / placement / inventory      |
+----------------------------------------------------------------+
```

### Map and Street imagery

Preserve the map's top-left position, controls, overlays, and usable height. Keep the contextual Mapillary viewer top-right. These are the only two panels in that grid row; align them to start and avoid stretching either to the height of downstream content.

Remove the enormous empty imagery-card tail. Give the viewer a bounded responsive height/aspect ratio and keep its caption/attribution directly below it. Put manual image-ID testing in developer settings. Do not replace empty space with more diagnostics.

Ensure Mapillary `resize()` and Leaflet `invalidateSize()` run appropriately after layout/visibility changes. Do not remount them on unrelated saves or reset zoom/current imagery merely because Settings opens.

### Sequences and streets before the main image workflow

Keep sequence browsing below the top row in a compact, bounded list. Summarize the selected sequence and image count; expand detailed metadata only on demand.

Move **Streets in region above InventoryWorkspace**, in DOM order as well as CSS. The user should choose inclusion and the active street before working on its images. Put preparation and Open workflow actions beside that selection.

Rename the metadata-only **Start Processing** action to **Prepare selected streets**. Reserve **Detect selected views** for actual SAM inference. Remove outdated “Lighting detection is not available yet” messages and duplicated headings.

Selecting/opening a street activates its workspace below and moves focus/scroll there. Changing the active street preserves its saved/draft work. Results stays on each street row. Keep a concise current-street indicator above the image.

### Inventory workspace

Keep the large annotated image/comparison area as the visual focus. Its step bar and essential actions may be sticky within the workspace, without hiding the image or covering controls. Put prompts/testing in Detect, decisions in Review, grouping in Group, and evidence/result details in Inventory.

Keep technical run IDs, fingerprints, raw query counts, setup help, and full errors in an on-demand details view. Show short actionable errors near the relevant action. Do not scatter repeated memory-only notices now that saving exists.

For Place, keep using the main map. Provide **Place on map** that scrolls/focuses the map with a visible placement mode, and **Return to inventory** afterward. Preserve the active asset/step and avoid duplicating maps just to rearrange the UI.

### Settings drawer and responsive behavior

Use a small set of sections/tabs: **Providers**, **Local database**, **Developer tools**. Include readiness summaries, setup links, model/timeouts where appropriate, and troubleshooting. Do not expose secrets in this drawer. Keep developer examples and manual image-ID entry here.

At narrower widths stack Map → Street imagery → Sequences → Streets → Inventory; keep Save status/actions accessible. Use one primary page scroll, with bounded list scrolling only where it helps. Avoid a stack of nested scrolling accordions.

Verify at approximately 1440×900 and 1280×800, plus a narrow viewport: no horizontal page overflow, clipped dialogs, stretched empty panels, or inaccessible actions. Ensure keyboard focus, Escape/close behavior, and readable labels survive the move. No new UI framework is needed.

## 9. Verification and delivery order

1. Start the isolated database and connect the backend; document and update both environment files.
2. Save/reopen workspace selections and one manual session before changing the detector.
3. Persist real detection items, evidence artifacts, review drafts, and immutable results; add restore/recovery and save-state UI.
4. Fix processing-summary/history/truncation issues.
5. Rearrange the existing panels and simplify Settings; verify the full journey.

Required tests and manual acceptance:

- Fresh setup script succeeds; repeated start is harmless; stop/start and container recreation retain data in the named volume.
- Save an RoI, excluded street, sequence/image selection, prompt edit, crop, review decisions, merge/support link, placement, and reviewed result. Refresh and restart backend/database; reopen all with stable identities.
- Old/expired media handles do not break locally saved evidence. Saved results render without re-running external queries or inference.
- Pole success plus luminaire failure remains partial; adding six prompt tests retains the earlier batch and its warnings. Truncated output stays flagged.
- Slow/out-of-order save responses, two-tab revision conflict, DB outage/reconnect, and partial artifact writes do not produce false Saved status or overwrite newer state.
- Interrupted detection never auto-retries. Importing/retrying a saved response does not duplicate observations or model calls.
- Editing a reviewed asset produces a draft while the previous result remains reproducible.
- Clean layout order and map/viewer resizing are verified with populated lists and a real-image workflow, not only the empty page.
- Existing tests/typecheck/lint pass; provider requests in tests are mocked. Use an isolated test database whose name is checked before cleanup; never drop the user's database.

Do not infer success from HTTP health alone: verify write, read, and restart durability. If an existing browser tab still holds unsaved work from milestone 05, do not reset it as part of testing; offer Save current workspace once persistence is available. Previously lost memory-only sessions cannot be recovered retroactively.

At handoff report the exact startup commands, tested container/image/volume, connection verification without secrets, passing checks, and any remaining limits. Leave application changes reviewable and uncommitted. The coding agent should complete this milestone, not stop after scaffolding schemas or adding a Save button.
