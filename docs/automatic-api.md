# Automatic mapping without the UI

The automatic workflow is operable through local HTTP alone: the React UI
uses the same routes documented here. All calls go to the Express server
(default `http://localhost:3001`); the database must be running
(`infra/database/start.ps1`). Examples use Windows PowerShell
(`Invoke-RestMethod`); any HTTP client works.

Prerequisites: `MAPILLARY_ACCESS_TOKEN` and `MODEL_API_KEY` in
`apps/server/.env`. Prepare calls Mapillary metadata only (no SAM calls);
launch spends model calls.

## 1. Health and workspace

```powershell
$base = "http://localhost:3001"
Invoke-RestMethod "$base/api/health" | ConvertTo-Json -Depth 6

$ws = Invoke-RestMethod "$base/api/workspaces" -Method Post `
  -ContentType "application/json" -Body '{"name":"headless run"}'
$wid = $ws.workspaceId
```

## 2. Search Mapillary and freeze an imagery snapshot

Post a GeoJSON polygon RoI (under 25 km², bbox under 0.01 square degrees):

```powershell
$roi = @{
  type = "Polygon"
  coordinates = @(@(
    @(19.0400, 47.4970), @(19.0460, 47.4970),
    @(19.0460, 47.4930), @(19.0400, 47.4930),
    @(19.0400, 47.4970)
  ))
} | ConvertTo-Json -Depth 8 -Compress
$search = Invoke-RestMethod "$base/api/mapillary/images/search" -Method Post `
  -ContentType "application/json" -Body (@{ roi = ($roi | ConvertFrom-Json) } | ConvertTo-Json -Depth 8)
$search.query.matchedCount
```

Save the returned records as an immutable `imagery-discovery` snapshot
(seeds + hydrated image records; see `checkImagerySnapshot` in
`apps/server/src/db/validation.ts` for the record shape):

```powershell
$snapId = "sn_headless_1"
$payload = @{
  query = $search.query
  warnings = @()
  status = "results"
  everSearched = $true
  seeds = $search.images
  hydrated = @()
  truncatedCount = 0
}
Invoke-RestMethod "$base/api/workspaces/$wid/snapshots" -Method Post `
  -ContentType "application/json" -Body (@{
    snapshotId = $snapId; kind = "imagery-discovery"; payload = $payload
  } | ConvertTo-Json -Depth 12)
```

Pick sequence IDs from the records (`$search.images | Group-Object sequenceId`).
A street snapshot is optional; without one, located results keep
`streetId: null` (area-level results, honestly unlabeled).

## 3. Prepare a bounded plan (no SAM calls)

```powershell
$plan = @{
  mode = "locate"               # or "detect" for detection-only output
  snapshotId = $snapId
  streetSnapshotId = $null
  sequenceIds = @("<sequence-id-1>", "<sequence-id-2>")
  concepts = @(
    @{ conceptId = "auto-pole"; text = "street light pole"; category = "pole" }
    @{ conceptId = "auto-luminaire"; text = "street light fixture"; category = "luminaire" }
  )
  maxImages = 100               # hard ceiling: 100 images, 200 calls
  maxCalls = 200
  minSpacingM = 10            # skip images within 10 m of an included one (0 disables)
} | ConvertTo-Json -Depth 6
$prep = Invoke-RestMethod "$base/api/workspaces/$wid/auto/prepare" -Method Post `
  -ContentType "application/json" -Body $plan
$prep | ConvertTo-Json -Depth 8
```

The response shows the frozen plan: image/call totals, per-sequence
locatable counts, outside-RoI exclusions, spacing-thinned images, geometry
warnings, and a `prepareSnapshotId`. Only in-RoI images are ever planned.
Over-budget selections fail closed (`AUTO_PLAN_REJECTED`) with the exact
overage — shrink the selection and re-prepare.

## 4. Launch idempotently

```powershell
$launch = @{
  prepareSnapshotId = $prep.prepareSnapshotId
  idempotencyKey = "headless-run-1"   # reuse to dedupe double-clicks/retries
} | ConvertTo-Json
$job = Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs" -Method Post `
  -ContentType "application/json" -Body $launch
$jid = $job.jobId
```

Repeating the call with the same key returns the same job
(`deduplicated: true`); the same key with a different plan conflicts
(`AUTO_JOB_CONFLICT`, HTTP 409). The in-server worker claims the job within
one poll interval; closing the terminal changes nothing.

## 5. Poll progress

```powershell
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid" | ConvertTo-Json -Depth 8
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs" | ConvertTo-Json -Depth 6
```

Job phases: `queued → preparing → detecting → locating → publishing →
completed` (or `completed_with_gaps`), with `stopped` / `interrupted` /
`failed` on the side. Progress is derived on every read — a crash can never
leave counters behind reality.

## 6. Stop, resume, retry

```powershell
# Stop after the current call settles (partial results stay accessible):
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/stop" -Method Post `
  -ContentType "application/json" -Body '{}'

# Explicit resume (never-started items continue; unknown-outcome calls do not
# retry implicitly):
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/resume" -Method Post `
  -ContentType "application/json" -Body '{}'

# Explicit new attempt for one interrupted (unknown-outcome) item:
$itemId = "<itemId from the items listing>"
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/items/$itemId/retry" `
  -Method Post -ContentType "application/json" -Body '{}'
```

## 7. Read results (paginated)

```powershell
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/items?limit=100&offset=0"
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/items/$itemId"  # full detail
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/observations?limit=100"
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/candidates"
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/candidates?status=located"
Invoke-RestMethod "$base/api/workspaces/$wid/auto/jobs/$jid/result" | ConvertTo-Json -Depth 8
```

The published result is an immutable version with reconciled counts and
limitations. Candidates carry evidence membership, association decisions,
estimate/uncertainty or an unresolved reason — never a position at a camera
point or `[0,0]`.

## Error shape

Failures return `{ "error": { "code", "message", "retryable" } }` with stable
codes (`AUTO_PLAN_REJECTED`, `AUTO_JOB_CONFLICT`, `AUTO_ITEM_CONFLICT`,
`MAPILLARY_*`, `SAM_*`, `DB_UNAVAILABLE`, …). Provider statuses map to HTTP
429 (rate limited, with `Retry-After`), 504 (timeout), or 502 (provider
failure); nothing leaks raw provider text, credentials, or image bytes.
