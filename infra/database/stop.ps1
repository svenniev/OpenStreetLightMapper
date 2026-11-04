#Requires -Version 5.1
<#
.SYNOPSIS
  Stop the OpenStreetLightMapper local MongoDB container (keeps data).

.DESCRIPTION
  Stops only this project's Compose service. The named volume is untouched,
  so data survives stop/start and container recreation. This script never
  uses `down -v`, prune, or any destructive reset.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\database\stop.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ComposeFile = Join-Path $PSScriptRoot "compose.yaml"

if (-not (Test-Path $ComposeFile)) {
  Write-Error "Compose file not found: $ComposeFile"
  exit 1
}

docker compose -f $ComposeFile -p openstreetlightmapper stop mongodb
if ($LASTEXITCODE -ne 0) {
  Write-Error "docker compose stop failed (exit $LASTEXITCODE). Is Docker running?"
  exit 1
}
Write-Host "OK: openstreetlightmapper-mongodb stopped; volume openstreetlightmapper-mongo-data retained."
