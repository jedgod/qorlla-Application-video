param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
if (-not (Test-Path -LiteralPath $Installer)) { throw 'Installer not found' }
$sha=(Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLower()
Write-Host "SHA256: $sha"
$sig=Get-AuthenticodeSignature -LiteralPath $Installer
Write-Host "Authenticode status: $($sig.Status)"
if ($sig.Status -ne 'Valid') { throw 'Not signed/verified: internal test only; public release forbidden' }
Write-Host 'Signature verified. Install/uninstall and media tests must still be performed manually.'
