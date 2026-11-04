#Requires -Version 5.1
<#
.SYNOPSIS
  Start the OpenStreetLightMapper local MongoDB container.

.DESCRIPTION
  Starts only this project's Compose service (openstreetlightmapper/mongodb),
  waits for its healthcheck with a bounded timeout, and verifies the port.
  Re-running is harmless. Never touches unrelated containers, images, or
  volumes to resolve a conflict: on conflict it stops with guidance instead.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\database\start.ps1
#>
[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ComposeFile = Join-Path $PSScriptRoot "compose.yaml"
$ProjectName = "openstreetlightmapper"
$ContainerName = "openstreetlightmapper-mongodb"
$HostPort = 27018

function Fail([string]$message) {
  Write-Error $message
  exit 1
}

# 1. Docker + Compose availability.
try {
  $null = docker info 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "Docker daemon is not reachable (docker info failed). Start Docker Desktop and retry." }
} catch {
  Fail "Docker CLI is not available on PATH. Install/start Docker Desktop and retry."
}
$composeOk = $false
try {
  docker compose version 2>$null | Out-Null
  $composeOk = ($LASTEXITCODE -eq 0)
} catch { $composeOk = $false }
if (-not $composeOk) { Fail "Docker Compose v2 is not available (docker compose version failed)." }
if (-not (Test-Path $ComposeFile)) { Fail "Compose file not found: $ComposeFile" }

# 2. Name conflict: a container with our name that is NOT from our project.
$existingId = (docker ps -a --filter "name=^${ContainerName}$" --format "{{.ID}}" 2>$null | Select-Object -First 1)
if ($existingId) {
  $existingProject = (docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' $existingId 2>$null)
  if ($existingProject -ne $ProjectName) {
    Fail ("A container named '{0}' already exists but is not part of Compose project '{1}'. " +
      "This script will not stop, rename, or remove it. Rename or remove it yourself, then retry." -f $ContainerName, $ProjectName)
  }
}

# 3. Port conflict: something listening on 27018 that is not our container.
$portBusyElsewhere = $false
try {
  $listeners = Get-NetTCPConnection -LocalPort $HostPort -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    $ourRunning = (docker ps --filter "name=^${ContainerName}$" --format "{{.ID}}" 2>$null | Select-Object -First 1)
    if (-not $ourRunning) { $portBusyElsewhere = $true }
  }
} catch { }
if ($portBusyElsewhere) {
  Fail ("Host port {0} is already in use by something other than '{1}'. " +
    "Stop that listener or change the published port, then retry. Nothing was changed." -f $HostPort, $ContainerName)
}

# 4. Start only our service.
Write-Host "Starting '$ContainerName' (project '$ProjectName')..."
docker compose -f $ComposeFile -p $ProjectName up -d mongodb
if ($LASTEXITCODE -ne 0) { Fail "docker compose up failed (exit $LASTEXITCODE). See output above." }

# 5. Bounded wait for health.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  $health = (docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $ContainerName 2>$null)
  if ($health -eq "healthy" -or $health -eq "running") { $healthy = $true; break }
  if ($health -eq "unhealthy") { break }
  Start-Sleep -Seconds 2
}
if (-not $healthy) {
  Write-Host "--- recent container logs ---"
  docker logs --tail 30 $ContainerName 2>&1 | Write-Host
  Fail ("Container '{0}' did not become healthy within {1}s. Logs above. " +
    "Fix the cause and re-run this script (it is harmless to re-run)." -f $ContainerName, $TimeoutSeconds)
}

# 6. Port probe on loopback.
$probeOk = $false
try {
  $client = New-Object Net.Sockets.TcpClient
  $iar = $client.BeginConnect("127.0.0.1", $HostPort, $null, $null)
  $probeOk = $iar.AsyncWaitHandle.WaitOne(5000)
  $client.Close()
} catch { $probeOk = $false }
if (-not $probeOk) { Fail "Container is healthy but 127.0.0.1:$HostPort is not accepting connections." }

Write-Host "OK: $ContainerName healthy, mongodb://127.0.0.1:${HostPort}/openstreetlightmapper reachable."
Write-Host "Next: start the backend (npm run dev --workspace @openstreetlightmapper/server) and check /api/health."
