<#
  Lets OTHER devices on your network reach the Qorlla development servers running on this Windows PC (main app 3200, Meet 3300).
  It adds two narrow inbound rules, it does not turn the firewall off:
    - TCP 3200 and 3300 only (not the whole program, not other ports)
    - only from your local subnet (RemoteAddress = LocalSubnet), never from the internet
    - on the Private and Public network profiles (your Wi-Fi is currently "Public": pass -Profile Private to limit it)
  Run it from an Administrator PowerShell (it asks for elevation itself if needed):
      powershell -ExecutionPolicy Bypass -File scripts\windows-firewall.ps1            # add the rules
      powershell -ExecutionPolicy Bypass -File scripts\windows-firewall.ps1 -Remove    # take them away again
  Mail is unaffected: outgoing mail uses ports 587/465, which Windows allows; port 25 is usually blocked by networks, not by this PC.
  Honest limits: this only opens the PORTS. A browser on another device refuses camera and microphone on a plain http:// address that is not
  localhost, so real meetings with other devices need https (the Docker stack with a certificate, or a tunnel).
#>
param([int[]]$Ports = @(3200, 3300), [ValidateSet('Private', 'Public', 'Private,Public')][string]$Profile = 'Private,Public', [switch]$Remove)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Profile', $Profile, '-Ports', ($Ports -join ','))
  if ($Remove) { $args2 += '-Remove' }
  Write-Host 'Windows will ask for permission (UAC) to change the firewall...'
  Start-Process powershell -Verb RunAs -Wait -ArgumentList $args2
  exit $LASTEXITCODE
}

$prefix = 'Qorlla dev TCP '
foreach ($p in $Ports) {
  $name = $prefix + $p
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if (-not $Remove) {
    New-NetFirewallRule -DisplayName $name -Description 'Qorlla development server: other devices on the local subnet (remove with scripts/windows-firewall.ps1 -Remove)' `
      -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -RemoteAddress LocalSubnet -Profile ($Profile -split ',') | Out-Null
    Write-Host "Allowed inbound TCP $p from the local subnet ($Profile)."
  } else { Write-Host "Removed the rule for TCP $p (if it existed)." }
}
if (-not $Remove) {
  $ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } | Select-Object -ExpandProperty IPAddress
  foreach ($ip in $ips) { Write-Host "From another device on this network try: http://${ip}:$($Ports[0])/qorlla.html" }
}
Start-Sleep -Seconds 3
