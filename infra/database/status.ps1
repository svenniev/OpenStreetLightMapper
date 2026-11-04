#Requires -Version 5.1
<#
.SYNOPSIS
  Show OpenStreetLightMapper local database status.

.DESCRIPTION
  Reports this project's Compose service state, container health, the
  loopback port probe, and the named volume. Read-only: changes nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\database\status.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$ComposeFile = Join-Path $PSScriptRoot "compose.yaml"
$ContainerName = "openstreetlightmapper-mongodb"
$VolumeName = "openstreetlightmapper-mongo-data"
$HostPort = 27018

Write-Host "== Compose status (project openstreetlightmapper) =="
docker compose -f $ComposeFile -p openstreetlightmapper ps 2>&1 | Write-Host

Write-Host ""
Write-Host "== Container health =="
$health = (docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $ContainerName 2>$null)
if ($LASTEXITCODE -eq 0 -and $health) {
  Write-Host "$ContainerName : $health"
} else {
  Write-Host "$ContainerName : not present"
}

Write-Host ""
Write-Host "== Port probe (127.0.0.1:$HostPort) =="
$probeOk = $false
try {
  $client = New-Object Net.Sockets.TcpClient
  $iar = $client.BeginConnect("127.0.0.1", $HostPort, $null, $null)
  $probeOk = $iar.AsyncWaitHandle.WaitOne(3000)
  $client.Close()
} catch { $probeOk = $false }
Write-Host ($(if ($probeOk) { "reachable" } else { "not reachable" }))

Write-Host ""
Write-Host "== Volume =="
docker volume inspect $VolumeName --format 'name={{.Name}} mountpoint={{.Mountpoint}}' 2>&1 | Write-Host
