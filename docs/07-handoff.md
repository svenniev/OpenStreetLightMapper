# Milestone 07 handoff — automatic detection and mapping

Date: 2026-11-04. Spec: `docs/specs/07_headless_mode.md`. Working tree holds
the implementation uncommitted for review (see `git status`); nothing was
committed, pushed, deployed, or reset. The database volume and existing
workspaces are untouched.

## What was built

- **Consistency fixes (§1):** atomic conditional item transitions with worker
  ownership (loser re-reads the winner; terminal results cannot be
  overwritten), result contents pinned to the exact acknowledged
  revision/snapshot with server-side identity validation, plus concurrent
  transition tests.
- **Geometry core (`packages/geo`):** ENU frames, perspective + equirectangular
  projection/rays with distortion, least-squares multi-view triangulation with
  conservative acceptance gates. OpenSfM conventions (X-right/Y-down/Z-forward,
  rotation world→camera, focal relative to max(w,h)). 53/53 tests.
- **Server pipeline (`apps/server/src/auto/`):** bounded plan resolution with
  frozen recipe v1; batched/retried provider metadata fetch; sharp-based image
  preparation (restricted CDN hosts, EXIF/orient/resize chain, GridFS views
  with attribution); durable in-process worker (one job at a time, one SAM
  call in flight, lease ownership, stop/settle, startup sweep, explicit resume
  without blanket retries of unknown-outcome calls, idempotent publish);
  observation building (pole-base-margin / box-center anchors, mask support);
  greedy-growth association (within-image dedup, 3-view locate, cross-sequence
  gates, street assignment, support links, 10 m proximity flags).
- **Routes:** prepare (no SAM calls), idempotent launch, list/get jobs,
  paginated items/observations, candidates, result, stop, explicit resume,
  per-item retry. Same routes serve the UI and headless use
  (`docs/automatic-api.md`).
- **UI:** Manual/Automatic mode toggle beside the inventory entry; persisted
  per-sequence inclusion checkboxes (browsing never toggles them; filtered-out
  checks stay counted); run panel with prepare → launch → polled progress →
  stop/resume; Automatic inventory map layer (hollow estimated pins with
  uncertainty tooltips); results table with Unlocated reasons; Inspect (opens
  evidence in the viewer) and Open-in-manual handoff (starts the street's
  manual session, preserves the automatic version).

## Verified camera models and metadata

Real-sample proof (metadata only, zero SAM calls) against a small central
Budapest bbox `[19.04, 47.4965, 19.041, 47.4975]` on 2026-11-04:

- Search returned 99 records / 35 sequences / 7 sequences with ≥3 images.
- Metadata fetch: 9/9 found, 0 missing. **All sampled images eligible**:
  `camera_type=perspective`, per-image `camera_parameters` (focal 0.665–0.980,
  small k1/k2), `computed_rotation`, altitude (~0.3–7.3 m), `captured_at`,
  `thumb_2048_url`, `creator`. 124 eligible perspective images total across
  the sampled sequences.
- Real thumbnail decoded via sharp: 2047×1531 JPEG, 389,931 bytes.
- Real-pose rig coherence: a synthetic target projected into three real
  calibrated views, back-projected, and triangulated with error **3.26e-14 m**,
  ray gaps ~1e-14 m, parallax 5.3–31.1°, baselines 1.5–7.8 m, depths 10–15 m.
- Not observed live in this bbox: panoramas (`is_pano` all false) and
  unsupported/unknown camera models. Equirectangular/spherical projection,
  seam handling, fisheye/unknown rejection, rotated/cropped views, and
  perturbed GPS/heading are covered by geometry fixtures, not by live
  provider records. No live SAM inference was run (no paid calls in tests or
  proofs); end-to-end located output with real detections is still to be
  validated on a small real run.

## Threshold values and run limits (stored with every job)

- Run bounds: **100 source images, 200 SAM calls** per job; 1 SAM call in
  flight globally; 1 flat analysis view per image (recipe v1: `thumb_2048_url`,
  2048 px long side, JPEG q90); metadata batches of 50, 3 attempts, 30 s
  timeout.
- Locate gates: ≥3 distinct source images, baseline ≥2 m, parallax ≥5°,
  range ≤80 m, sensitivity ≤3 m, reprojection ≤1% of view diagonal with a
  1.5× best-assignment margin; ray gap ≤1.0 m; depth 0.5–150 m.
- Association: within-image dedup IoU 0.5 + anchor agreement 2% of diagonal;
  same-sequence window ±5 images; cross-sequence origin prefilter 200 m and
  ≤30 days; street assignment within 25 m with 2× unambiguity ratio;
  support link within 2 m horizontal / 1–15 m vertical with 0.5 m ambiguity
  rejection; 10 m close-spacing flag (never a merge); assumed pose error
  0.5 m + alignment 0.5 m folded into reported uncertainty.
- Anchors: pole = box bottom-center pushed below the box by a 3° margin;
  luminaire = box center. Clipped/occluded edges are flagged, not trusted.

## Checks performed

- `npm run typecheck` clean (web, server, geo); `npm run lint` clean;
  `npm run build` succeeds (pre-existing chunk-size warning unchanged).
- Tests (mocked providers, isolated guarded databases, no live inference):
  geo 53/53; server 217/217; web unit 81/81; web component 106/106.
  - Association fixtures: 3-view locate + street, <10 m pair kept separate,
    chain-merge trap, within-image dedup vs separated shafts, fixture support
    link, cross-sequence gates, rayless reporting, ambiguous-street abstention.
  - Worker fixtures: full claim→located run, rate-limit gaps, ambiguous
    timeout parked as unknown, missing-config fast fail, stopped jobs left
    for explicit resume.
  - Routes: prepare/launch idempotency + plan-change conflict, config
    gating, stop/resume/retry lifecycle, pagination, result 404-before-publish.
  - UI: autoApi validators, checkbox toggle/select-visible/hidden-count
    specs, sequence-selection persistence round-trip.
- One full server run showed 2 failures mid-session and passed 217/217 on
  three consecutive reruns without code changes; treated as environmental
  flake, not verified root-caused — rerun the gate after any worker/store
  change.

## Remaining limitations

- No live SAM validation yet: run a small real sample through the UI, close
  the tab mid-run, reopen, and independently inspect a subset (spec §8). Do
  not invent accuracy percentages without a labeled reference set.
- Over-budget selections fail closed with exact counts; the optional
  explicitly-selected preview sample (§3) is not built — shrink the selection
  and re-prepare instead. No wider-area camera buffer option.
- Panorama support is flat-crop only (spherical mapping retained, seam
  flagged); deterministic overlapping perspective reprojection sets are not
  implemented, so pano-heavy runs may detect poorly.
- Open-in-manual starts the street's manual session but does not transfer
  automatic observations/masks into it; corrections reuse the manual tools
  from the evidence images.
- Association thresholds are the spec's engineering values, untuned on real
  detections. Fixture-tested: 3-view locate, <10 m pair separation,
  chain-merge trap, within-image dedup vs separated shafts, single support
  link, cross-sequence gates, rayless reporting, street abstention. Not
  individually fixture-tested: opposite-side poles, a repeated row of similar
  poles, overlapping crops of one photograph, and two fixtures on one pole —
  add these before trusting dense scenes.
- Real-browser journeys (refresh/reopen, two-tab conflicts, responsive
  layouts) still need manual verification; the durability probe suite should
  be re-run after this milestone's store changes.
