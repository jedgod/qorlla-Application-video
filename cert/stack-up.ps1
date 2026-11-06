# Starts a new, isolated certification stack. Never reuses or removes an existing project or volume.
param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{2,40}$')][string]$ProjectName
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$EnvFile = (Resolve-Path $EnvFile).Path
$settings = @{}
foreach ($line in Get-Content $EnvFile) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim('"').Trim("'") }
}
$required = @('MAIN_DB_PASSWORD', 'QORLLA_APP_DB_PASSWORD', 'QORLLA_BRIDGE_SECRET', 'QORLLA_VAULT_KEY',
  'MEET_APP_DB_PASSWORD', 'MEET_APP_DB_URL', 'JWT_SECRET', 'RECOVERY_ESCROW_KEY', 'MAIN_HOST_PORT',
  'MAIN_CONTAINER_NAME', 'MEET_DB_CONTAINER_NAME', 'MEET_DB_HOST_PORT')
foreach ($key in $required) {
  if (-not $settings.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($settings[$key])) { throw "Missing $key in certification env file." }
}
if ($settings.MAIN_CONTAINER_NAME -notmatch '^[a-z0-9][a-z0-9_-]{2,60}$' -or
    $settings.MEET_DB_CONTAINER_NAME -notmatch '^[a-z0-9][a-z0-9_-]{2,60}$') {
  throw 'Certification container names must be unique simple names.'
}
if ((docker ps -aq --filter "label=com.docker.compose.project=$ProjectName").Count -gt 0) {
  throw "Docker project '$ProjectName' already exists. Choose a new project name; existing volumes are never removed."
}
if ((docker ps -aq --filter "name=^/$($settings.MEET_DB_CONTAINER_NAME)$").Count -gt 0) {
  throw "Meet database container '$($settings.MEET_DB_CONTAINER_NAME)' already exists. Choose a new name."
}
if ((docker ps -aq --filter "name=^/$($settings.MAIN_CONTAINER_NAME)$").Count -gt 0) {
  throw "MAIN container '$($settings.MAIN_CONTAINER_NAME)' already exists. Choose a new name."
}
$volumeNames = @(docker volume ls -q --filter "name=^${ProjectName}_")
if ($volumeNames.Count -gt 0) { throw "Docker volumes already exist for '$ProjectName'. Choose a new project name." }

$meetPort = [int]$settings.MEET_DB_HOST_PORT
docker run -d --name $settings.MEET_DB_CONTAINER_NAME `
  -e POSTGRES_DB=qorlla_meet -e POSTGRES_USER=qorlla -e POSTGRES_PASSWORD=qorlla_dev_only `
  -p "127.0.0.1:${meetPort}:5432" postgres:16-alpine | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Meet database container could not be started.' }
$ready = $false
$readyError = ''
for ($attempt = 0; $attempt -lt 60 -and -not $ready; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    docker exec $settings.MEET_DB_CONTAINER_NAME psql -v ON_ERROR_STOP=1 -Atq -U qorlla -d qorlla_meet -c 'SELECT 1' *> $null
    $ready = $LASTEXITCODE -eq 0
  } catch {
    $readyError = $_.Exception.Message
  }
}
if (-not $ready) { throw "Meet database did not become query-ready: $readyError" }

foreach ($migration in 'schema', 'v2_migration', 'v3_migration', 'v3_1_to_v3_5_migration', '002_recovery') {
  Get-Content "qorlla-meet-video/sql/$migration.sql" -Raw |
    docker exec -i $settings.MEET_DB_CONTAINER_NAME psql -v ON_ERROR_STOP=1 -q -U qorlla -d qorlla_meet
  if ($LASTEXITCODE -ne 0) { throw "Meet migration '$migration' failed." }
}
$meetPassword = $settings.MEET_APP_DB_PASSWORD.Replace("'", "''")
Get-Content "qorlla-meet-video/sql/005_app_role.sql" -Raw |
  docker exec -i $settings.MEET_DB_CONTAINER_NAME psql -v ON_ERROR_STOP=1 "-v" "app_pw=$meetPassword" -q -U qorlla -d qorlla_meet
if ($LASTEXITCODE -ne 0) { throw 'Meet application role creation failed.' }

docker compose --env-file $EnvFile -p $ProjectName up -d --build main-db workspace-signaling-engine meet-sync-worker
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed to start the certification services.' }
Write-Host "Isolated certification stack '$ProjectName' started. Meet migrations applied; MAIN migrations run on its new project volume."
