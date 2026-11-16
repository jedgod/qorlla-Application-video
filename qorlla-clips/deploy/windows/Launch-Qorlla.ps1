# Opens the Qorlla desktop app against the local Qorlla stack (http://localhost:4800, Meet on 4801).
# Started by the "Qorlla" icon on the Desktop. It needs the local Qorlla stack (Docker) to be running.
$ErrorActionPreference = 'SilentlyContinue'
$app = 'C:\Users\cj_wo\qv-docs-history\qorlla-clients\apps\desktop'
$url = 'http://localhost:4800'

function Test-Up { try { (Invoke-WebRequest -Uri "$url/healthz" -UseBasicParsing -TimeoutSec 4).StatusCode -eq 200 } catch { $false } }

if (-not (Test-Up)) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("The Qorlla server is not answering at $url.`nStart the Qorlla stack (Docker Desktop, then the qlaunch containers) and click the icon again.", 'Qorlla', 'OK', 'Warning') | Out-Null
    exit 1
}

# the desktop shell allows ONE running copy: a stale copy makes a new launch quit at once, so close it first
Get-Process electron | Where-Object { $_.Path -like '*qorlla-clients*electron*' } | Stop-Process -Force
for ($i = 0; $i -lt 10 -and (Get-Process electron | Where-Object { $_.Path -like '*qorlla-clients*electron*' }); $i++) { Start-Sleep -Seconds 1 }

$env:QORLLA_APP_URL = $url
$env:QORLLA_MEET_URLS = 'http://localhost:4801'
Start-Process -FilePath 'node' -ArgumentList 'dev-local.cjs' -WorkingDirectory $app -WindowStyle Hidden


# Qorlla Clips (/clips on the proxy) needs its API and web app running on this machine; this starts them if they are not (no-op when they already are)
Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\cj_wo\Qorlla-Desktop\Start-Clips.ps1' -WindowStyle Hidden
