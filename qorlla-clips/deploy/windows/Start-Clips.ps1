# Starts Qorlla Clips (API :5400, web :3410 under /clips) detached from any terminal. Safe to run again: it only starts what is not listening.
# Needs the Clips containers (qorlla-clips-dev-postgres/minio/redis) to be up. Logs: %TEMP%\clips_api.log, %TEMP%\clips_web.log
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\cj_wo\qv-shield\qorlla-clips'
function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

if (-not (Listening 5400)) {
    Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WorkingDirectory "$root\api" -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\clips_api.log" -RedirectStandardError "$env:TEMP\clips_api.err.log"
}
if (-not (Listening 3410)) {
    $env:CLIPS_BASE_PATH = '/clips'; $env:CLIPS_API_URL = 'http://127.0.0.1:5400'
    if (-not (Test-Path "$root\web\.next\BUILD_ID")) { Push-Location "$root\web"; & npx next build; Pop-Location }
    Start-Process -FilePath 'npx.cmd' -ArgumentList 'next', 'start', '-p', '3410' -WorkingDirectory "$root\web" -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\clips_web.log" -RedirectStandardError "$env:TEMP\clips_web.err.log"
}
for ($i = 0; $i -lt 40 -and -not ((Listening 5400) -and (Listening 3410)); $i++) { Start-Sleep -Seconds 2 }
"api:5400 listening=$(Listening 5400)  web:3410 listening=$(Listening 3410)"
