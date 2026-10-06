# Hearth updater for Windows.
# Double-click Update-Hearth.bat, or drag an update .zip onto it.
# It uploads the update to your server and runs the safe updater there (backups + automatic rollback).
param([string]$Zip, [switch]$Rollback, [switch]$Setup)

# 'Continue' on purpose: Windows PowerShell 5.1 turns harmless SSH messages into fatal errors under 'Stop'.
# Every step checks its own result instead.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgFile = Join-Path $here 'hearth-update.json'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Done($code) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null; exit $code }
function Fail($msg) { Say ''; Say "[X] $msg" Red; Done 1 }

Say ''
Say '  Hearth updater' Cyan
Say '  --------------' Cyan

if (-not (Get-Command ssh -ErrorAction SilentlyContinue) -or -not (Get-Command scp -ErrorAction SilentlyContinue)) {
  Fail "Windows' SSH tools aren't installed. Open Settings > Apps > Optional features > Add a feature > 'OpenSSH Client', then run this again."
}

# ---------------------------------------------------------------- server details (asked once)
$cfg = $null
if ((Test-Path $cfgFile) -and -not $Setup) { try { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json } catch { $cfg = $null } }
if (-not $cfg -or -not $cfg.host) {
  Say ''
  Say 'First-time setup (saved for next time in hearth-update.json)' Yellow
  $h = (Read-Host "Your server's address (IP or domain, e.g. 66.94.120.105)").Trim()
  if (-not $h) { Fail 'No server address given.' }
  $u = (Read-Host 'User name on the server [root]').Trim(); if (-not $u) { $u = 'root' }
  $p = (Read-Host 'SSH port [22]').Trim(); if (-not $p) { $p = '22' }
  $cfg = [pscustomobject]@{ host = $h; user = $u; port = [int]$p }
  $cfg | ConvertTo-Json | Set-Content -Path $cfgFile -Encoding ASCII
}
$target = "$($cfg.user)@$($cfg.host)"
$sshOpts = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15')
$sudo = if ($cfg.user -eq 'root') { '' } else { 'sudo ' }
Say "Server: $target (port $($cfg.port))"

# ---------------------------------------------------------------- password-free login (optional, once)
$key = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
& ssh @sshOpts -p $cfg.port -o BatchMode=yes -o ConnectTimeout=8 $target 'true' 2>$null
if ($LASTEXITCODE -ne 0) {
  $ans = Read-Host "Set up password-free login, so you only type the server password this one time? [Y/n]"
  if ($ans -notmatch '^[Nn]') {
    if (-not (Test-Path $key)) {
      New-Item -ItemType Directory -Force -Path (Split-Path $key) | Out-Null
      Start-Process -FilePath 'ssh-keygen' -ArgumentList ('-t ed25519 -q -N "" -C hearth-updater -f "' + $key + '"') -NoNewWindow -Wait
    }
    Say 'Enter your server password once to install the key:' Yellow
    Get-Content "$key.pub" -Raw | & ssh @sshOpts -p $cfg.port $target "umask 077; mkdir -p ~/.ssh && tr -d '\r' >> ~/.ssh/authorized_keys"
    if ($LASTEXITCODE -eq 0) { Say '[OK] Password-free login is set up.' Green } else { Say 'Could not install the key; you will be asked for the password instead.' Yellow }
  }
}

# ---------------------------------------------------------------- rollback
if ($Rollback) {
  Say ''
  Say 'Rolling back to the version before the last update...' Yellow
  & ssh @sshOpts -t -p $cfg.port $target "${sudo}hearth-update --rollback"
  if ($LASTEXITCODE -eq 0) { Say ''; Say '[OK] Rolled back.' Green; Done 0 } else { Fail 'Rollback did not finish. See the messages above.' }
}

# ---------------------------------------------------------------- pick the update zip
if (-not $Zip) {
  $places = @($here, (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Desktop')) | Where-Object { Test-Path $_ }
  $latest = Get-ChildItem -Path $places -Filter *.zip -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'hearth|update' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    $ans = Read-Host "Install $($latest.Name) from $($latest.DirectoryName) (saved $($latest.LastWriteTime))? [Y/n]"
    if ($ans -notmatch '^[Nn]') { $Zip = $latest.FullName }
  }
  if (-not $Zip) {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = 'Choose the Hearth update (.zip)'
    $dlg.Filter = 'Hearth update (*.zip)|*.zip'
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Fail 'No update chosen.' }
    $Zip = $dlg.FileName
  }
}
if (-not (Test-Path $Zip)) { Fail "Can't find $Zip" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$looksRight = $false
try {
  $z = [IO.Compression.ZipFile]::OpenRead($Zip)
  $looksRight = @($z.Entries | Where-Object { ($_.FullName -replace '\\', '/') -eq 'hearth/server/index.js' }).Count -gt 0
  $z.Dispose()
} catch { Fail "Couldn't open $Zip as a zip file." }
if (-not $looksRight) { Fail "$Zip doesn't look like a Hearth update (no hearth/server/index.js inside)." }

# ---------------------------------------------------------------- upload + install
Say ''
Say "Uploading $([IO.Path]::GetFileName($Zip))..." Yellow
& scp @sshOpts -P $cfg.port $Zip "${target}:/tmp/hearth-update.zip"
if ($LASTEXITCODE -ne 0) { Fail 'Upload failed. Check the server address and your connection.' }

Say 'Connecting to the server to install it. If it asks, type your server password (nothing shows while you type).' Yellow
Say '(The server backs up first and rolls back by itself if anything goes wrong.)' Gray
Say ''
$remote = "command -v unzip >/dev/null 2>&1 || { ${sudo}apt-get update -qq && ${sudo}apt-get install -y -qq unzip; } >/dev/null 2>&1; " +
          "unzip -p /tmp/hearth-update.zip hearth/scripts/hearth-update.sh > /tmp/hearth-update.sh && ${sudo}bash /tmp/hearth-update.sh /tmp/hearth-update.zip"
& ssh @sshOpts -t -p $cfg.port $target $remote
$code = $LASTEXITCODE
Say ''
Say "Server finished with exit code $code" Gray
if ($code -eq 0) {
  Say ''
  Say '[OK] Update installed. People with Hearth open will get a "new version ready" prompt.' Green
  Say '     Changed your mind? Double-click Rollback-Hearth.bat.' Gray
  Done 0
}
# Explain the failure in plain words, then fetch the server's log so it can be shared.
switch ($code) {
  255 { Say "Couldn't log in to the server (wrong password, or the connection dropped)." Red }
  127 { Say "A command was missing on the server (see the message above)." Red }
  11  { Say "The zip you chose doesn't contain the updater (scripts/hearth-update.sh). Use the newest Hearth download." Red }
  default { Say "The update stopped on the server. Your site is still on the previous version (or was rolled back)." Red }
}
$logFile = Join-Path $here 'last-update-log.txt'
& ssh @sshOpts -p $cfg.port $target 'cat /root/hearth-backups/last-update.log 2>/dev/null || echo "(no log on the server - the updater never started)"' > $logFile
if (Test-Path $logFile) {
  Say ''
  Say "Last lines of the server log (full log saved to $logFile):" Yellow
  Get-Content $logFile -Tail 25 | ForEach-Object { Say "  $_" }
}
Fail 'The update did not finish. Send the lines above (or last-update-log.txt) to whoever gave you the update.'
