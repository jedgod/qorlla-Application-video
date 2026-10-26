# Brings up a fresh certification stack (disposable). Usage: powershell -File cert/stack-up.ps1 -EnvFile <cert.env>
# Meet itself is started by the cert runners (node process on :3000); this script provides every Docker service.
param([Parameter(Mandatory = $true)][string]$EnvFile)
$ErrorActionPreference = 'Continue' # docker writes progress to stderr; failures are checked by the verification steps
Set-Location (Split-Path $PSScriptRoot -Parent)
docker compose --env-file $EnvFile -p qcert down -v *>$null
docker rm -f cert-meet-db 2>$null | Out-Null
docker run -d --name cert-meet-db -e POSTGRES_DB=qorlla_meet -e POSTGRES_USER=qorlla -e POSTGRES_PASSWORD=qorlla_dev_only -p 127.0.0.1:25501:5432 postgres:16-alpine | Out-Null
Start-Sleep 10
foreach ($f in 'schema', 'v2_migration', 'v3_migration', 'v3_1_to_v3_5_migration', '002_recovery') {
  Get-Content "qorlla-meet-video/sql/$f.sql" -Raw | docker exec -i cert-meet-db psql -v ON_ERROR_STOP=1 -q -U qorlla -d qorlla_meet 2>&1 | Where-Object { $_ -notmatch 'NOTICE' }
}
$meetPw = (Get-Content $EnvFile | Where-Object { $_ -like 'MEET_APP_DB_PASSWORD=*' }) -replace '^MEET_APP_DB_PASSWORD=', ''
Get-Content "qorlla-meet-video/sql/005_app_role.sql" -Raw | docker exec -i cert-meet-db psql -v ON_ERROR_STOP=1 -v app_pw=$meetPw -q -U qorlla -d qorlla_meet
if ($LASTEXITCODE -ne 0) { throw 'Meet application role creation failed' }
docker compose --env-file $EnvFile -p qcert up -d --build main-db workspace-signaling-engine meet-sync-worker
Write-Host "Meet migrations applied: schema v2_migration v3_migration v3_1_to_v3_5_migration 002_recovery; MAIN migrations via compose initdb: 001 002_recovery 003_passcode 004_ack_retry"

