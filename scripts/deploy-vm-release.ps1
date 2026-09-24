param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit,
  [ValidatePattern('^v22\.\d+\.\d+$')][string]$NodeVersion = 'v22.23.2'
)
# Run inside the existing TestSite Windows VM through Azure Run Command.
# Keep every release and the shared authentication/configuration directories.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:COMPUTERNAME -ne 'vm-abagent-t01') { throw 'Unexpected deployment VM.' }
$root = 'C:\BrowserAgent'
$release = Join-Path "$root\releases" $Commit
$shared = "$root\shared"
New-Item -ItemType Directory -Force -Path $root,"$root\releases",$shared,"$shared\.auth","$shared\.data","$root\runtime" | Out-Null
$nodeDirectory = "$root\runtime\node-$NodeVersion-win-x64"
if (!(Test-Path "$nodeDirectory\node.exe")) {
  $archiveName = "node-$NodeVersion-win-x64.zip"
  $archive = "$root\runtime\$archiveName"
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/$archiveName" -OutFile $archive
  $checksums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
  $expected = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $archiveName") }) -split '\s+'
  if (!$expected -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $expected[0]) { throw 'Node checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath "$root\runtime"
}
$env:PATH = "$nodeDirectory;$env:PATH"
if (!(Test-Path $release)) {
  $sourceArchive = "$root\releases\$Commit.zip"
  Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/jnxjent/azure-browser-agent/zip/$Commit" -OutFile $sourceArchive
  $unpack = "$root\releases\unpack-$Commit"
  Expand-Archive -LiteralPath $sourceArchive -DestinationPath $unpack
  Move-Item -LiteralPath "$unpack\azure-browser-agent-$Commit" -Destination $release
}
foreach ($directory in @('.auth','.data')) {
  if (!(Test-Path "$release\$directory")) {
    New-Item -ItemType Junction -Path "$release\$directory" -Target "$shared\$directory" | Out-Null
  }
}
Push-Location $release
try {
  & "$nodeDirectory\npm.cmd" ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  & "$nodeDirectory\npm.cmd" run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
} finally { Pop-Location }
# Existing configuration is deliberately never replaced here.
if (!(Test-Path "$shared\.env.local")) { throw 'Provision shared .env.local before activating the release.' }
# Enrollment is optional: existing manual sessions keep working until credentials are registered.
if (!(Select-String -LiteralPath "$shared\.env.local" -Pattern '^DESKNETS_CREDENTIAL_FILE=' -Quiet)) {
  Add-Content -LiteralPath "$shared\.env.local" -Value "`r`nDESKNETS_CREDENTIAL_FILE=C:/BrowserAgent/shared/credentials/desknets.bin" -Encoding UTF8
}
Copy-Item -LiteralPath "$release\scripts\set-desknets-credentials.ps1" -Destination "$shared\set-desknets-credentials.ps1" -Force
$apiArguments = "--enable-source-maps --env-file=$shared\.env.local $release\services\agent-api\dist\server.js"
$apiAction = New-ScheduledTaskAction -Execute "$nodeDirectory\node.exe" -Argument $apiArguments -WorkingDirectory $release
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\abaops" -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\abaops"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$previousTask = Get-ScheduledTask -TaskName 'BrowserAgent-API' -ErrorAction SilentlyContinue
if ($previousTask) { Stop-ScheduledTask -TaskName 'BrowserAgent-API' }
Register-ScheduledTask -TaskName 'BrowserAgent-API' -Action $apiAction -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
$browserAction = New-ScheduledTaskAction -Execute "$nodeDirectory\node.exe" -Argument "--env-file=$shared\.env.local $release\services\browser-worker\dist\desknets-session.js https://desknets.midac.jp/dneo/dneo.cgi?cmd=schindex#cmd=schweekgrp" -WorkingDirectory $release
Register-ScheduledTask -TaskName 'BrowserAgent-DeskNets' -Action $browserAction -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
# Expose only the private interface. Edge CDP stays loopback-only.
Set-Service iphlpsvc -StartupType Automatic
Start-Service iphlpsvc
& netsh interface portproxy add v4tov4 listenaddress=10.251.1.4 listenport=3001 connectaddress=127.0.0.1 connectport=3001
if ($LASTEXITCODE -ne 0) { throw 'Private port proxy setup failed.' }
if (!(Get-NetFirewallRule -DisplayName 'BrowserAgent TestSite only' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'BrowserAgent TestSite only' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 10.251.1.4 -LocalPort 3001 -RemoteAddress 10.251.2.0/26 | Out-Null
}
# Check the built API in a temporary background process; the user-session task
# is the persistent runtime because Edge must be visible in the RDP session.
$healthProcess = Start-Process -FilePath "$nodeDirectory\node.exe" -ArgumentList $apiArguments -WorkingDirectory $release -WindowStyle Hidden -PassThru -RedirectStandardOutput "$shared\deploy-health.log" -RedirectStandardError "$shared\deploy-health.err.log"
try {
  $healthy = $false
  for ($attempt=0;$attempt -lt 20;$attempt++) {
    Start-Sleep -Seconds 1
    try { if ((Invoke-RestMethod 'http://127.0.0.1:3001/health').status -eq 'ok') { $healthy=$true; break } } catch {}
  }
  if (!$healthy) { throw 'API health check failed.' }
  Set-Content -LiteralPath "$shared\active-commit.txt" -Value $Commit -Encoding ASCII
  [pscustomobject]@{commit=$Commit;release=$release;health='ok';interactiveLoginRequired=$true} | ConvertTo-Json -Compress
} finally {
  if (!$healthProcess.HasExited) { Stop-Process -Id $healthProcess.Id }
}
if (Get-CimInstance Win32_LogonSession | Where-Object {$_.LogonType -in @(2,10)}) {
  Start-ScheduledTask -TaskName 'BrowserAgent-API'
  Start-ScheduledTask -TaskName 'BrowserAgent-DeskNets'
}
