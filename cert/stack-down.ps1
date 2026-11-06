param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{2,40}$')][string]$ProjectName,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{2,60}$')][string]$MeetDbContainerName,
  [switch]$RemoveVolumes
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$EnvFile = (Resolve-Path $EnvFile).Path
$projectContainers = @(docker ps -aq --filter "label=com.docker.compose.project=$ProjectName")
if ($projectContainers.Count -eq 0) { throw "No containers found for '$ProjectName'; refusing to clean up an unverified project." }
$meetDb = docker inspect $MeetDbContainerName 2>$null
if (-not $meetDb) { throw "Meet database '$MeetDbContainerName' was not found; refusing incomplete cleanup." }
$arguments = @('compose', '--env-file', $EnvFile, '-p', $ProjectName, 'down')
if ($RemoveVolumes) { $arguments += '-v' }
docker @arguments
if ($LASTEXITCODE -ne 0) { throw "Docker Compose cleanup failed for '$ProjectName'." }
docker rm -f $MeetDbContainerName
if ($LASTEXITCODE -ne 0) { throw "Meet database cleanup failed for '$MeetDbContainerName'." }
if (-not $RemoveVolumes) { Write-Host "Containers removed; '$ProjectName' volumes were preserved. Pass -RemoveVolumes only for disposable test data." }
