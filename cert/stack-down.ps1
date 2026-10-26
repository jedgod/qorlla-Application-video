param([Parameter(Mandatory = $true)][string]$EnvFile)
Set-Location (Split-Path $PSScriptRoot -Parent)
docker compose --env-file $EnvFile -p qcert down -v
docker rm -f cert-meet-db qcert-w2 qcert-w3 2>$null | Out-Null
