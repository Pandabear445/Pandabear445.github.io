# Hearth updater for Windows.
# Double-click Update-Hearth.bat, or drag an update .zip onto it.
# It uploads the update to your server and runs the safe updater there (backups + automatic rollback).
# Remote commands below never contain double quotes: Windows PowerShell 5.1 strips them when it starts ssh.
param([string]$Zip, [switch]$Rollback, [switch]$Setup, [switch]$Status)

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
$sudo = if ($cfg.user -eq 'root') { '' } else { 'sudo ' }
Say "Server: $target (port $($cfg.port))"

# ---------------------------------------------------------------- password-free login (optional, once)
# The key is always passed with -i: another ssh on PATH (e.g. Git's) may look in a different .ssh folder,
# which is why the password could still be asked for right after "Password-free login is set up".
$key = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
function SshOpts {
  $o = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15')
  if (Test-Path $key) { $o += @('-i', $key) }
  return $o
}
function KeyWorks {
  $o = SshOpts
  & ssh @o -p $cfg.port -o BatchMode=yes -o ConnectTimeout=8 $target 'true' 2>$null
  return ($LASTEXITCODE -eq 0)
}
if (-not (KeyWorks)) {
  $ans = Read-Host "Set up password-free login, so you only type the server password this one time? [Y/n]"
  if ($ans -notmatch '^[Nn]') {
    if (-not (Test-Path $key)) {
      New-Item -ItemType Directory -Force -Path (Split-Path $key) | Out-Null
      # "" must reach ssh-keygen as an empty passphrase; Start-Process passes this string through unchanged.
      Start-Process -FilePath 'ssh-keygen' -ArgumentList ('-t ed25519 -q -N "" -C hearth-updater -f "' + $key + '"') -NoNewWindow -Wait
    }
    Say 'Enter your server password once to install the key:' Yellow
    # Adds the key once (no duplicates), on its own line even if the file didn't end with a newline,
    # with the permissions sshd insists on.
    # Single-quoted on purpose: nothing in it is touched by PowerShell. sed '$a\' adds a final newline if missing.
    $install = 'umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; ' +
               't=$(mktemp); tr -d ''\r'' > $t; [ -s $t ] || exit 3; sed -i -e ''$a\'' ~/.ssh/authorized_keys; ' +
               'grep -qxF -f $t ~/.ssh/authorized_keys || cat $t >> ~/.ssh/authorized_keys; rm -f $t; ' +
               'command -v restorecon >/dev/null 2>&1 && restorecon -R ~/.ssh; true'
    $pub = (Get-Content "$key.pub" -Raw).Trim()
    $o = SshOpts
    $pub | & ssh @o -p $cfg.port $target $install
    if ((KeyWorks)) { Say '[OK] Password-free login is set up.' Green }
    else {
      Say 'The key was sent, but the server still asks for a password.' Yellow
      Say '  Common causes: the server only allows passwords (PubkeyAuthentication no in /etc/ssh/sshd_config),' Gray
      Say '  or the home folder on the server is writable by others. You can keep using the password.' Gray
    }
  }
}
$sshOpts = SshOpts

# ---------------------------------------------------------------- status (health check, no changes)
if ($Status) {
  Say ''
  Say 'Checking the server (nothing is changed)...' Yellow
  & ssh @sshOpts -t -p $cfg.port $target "if ${sudo}grep -q -- --status /usr/local/bin/hearth-update 2>/dev/null; then ${sudo}hearth-update --status; else echo 'The updater on the server is an older one without --status. Install an update first (Update-Hearth.bat).'; fi"
  Done 0
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

# Its SHA-256: compared with update.zip.sha256 when that file is next to it (published with each release), and
# handed to the server, which checks the upload against it before unpacking or running anything from it.
$sum = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLower()
$sumFile = "$Zip.sha256"
if (Test-Path -LiteralPath $sumFile) {
  $first = [string](Get-Content -LiteralPath $sumFile -TotalCount 1)
  $want = ($first.Trim() -split '\s+')[0].ToLower()
  if ($want -ne $sum) { Fail "$Zip doesn't match $([IO.Path]::GetFileName($sumFile)): it's damaged or not the published update. Nothing was uploaded." }
  Say "[OK] Checksum matches ($sum)." Green
} else {
  Say "SHA-256 of this update: $sum (no .sha256 file next to it to compare with)." Gray
}

# ---------------------------------------------------------------- upload + install
# Upload into a private folder on the server (mktemp: only this account can open it), not a fixed /tmp name
# that another account could create first and swap before it runs as root.
$dir = ((& ssh @sshOpts -p $cfg.port $target 'mktemp -d') | Out-String).Trim()
if ($dir -notmatch '^/[A-Za-z0-9._/-]+$') { Fail "Couldn't make a temporary folder on the server. Check the server address and your connection." }
Say ''
Say "Uploading $([IO.Path]::GetFileName($Zip))..." Yellow
& scp @sshOpts -P $cfg.port $Zip "${target}:$dir/update.zip"
if ($LASTEXITCODE -ne 0) { Fail 'Upload failed. Check the server address and your connection.' }

Say 'Connecting to the server to install it. If it asks, type your server password (nothing shows while you type).' Yellow
Say '(The server backs up first and rolls back by itself if anything goes wrong.)' Gray
Say ''
# The folder goes away afterwards; 12 = the upload isn't the file checked above.
$remote = "trap 'rm -rf $dir' EXIT; command -v unzip >/dev/null 2>&1 || { ${sudo}apt-get update -qq && ${sudo}apt-get install -y -qq unzip; } >/dev/null 2>&1; " +
          "cd $dir || exit 13; echo '$sum  update.zip' > update.zip.sha256; sha256sum -c --quiet update.zip.sha256 >/dev/null 2>&1 || exit 12; " +
          "unzip -p update.zip hearth/scripts/hearth-update.sh > hearth-update.sh || exit 11; ${sudo}bash hearth-update.sh $dir/update.zip"
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
  12  { Say "The upload doesn't match the file on this computer (damaged on the way?). Nothing was installed; try again." Red }
  default { Say "The update stopped on the server. Your site is still on the previous version (or was rolled back)." Red }
}
$logFile = Join-Path $here 'last-update-log.txt'
# No double quotes in here (PowerShell 5.1 would strip them and bash would see a syntax error).
$logText = & ssh @sshOpts -p $cfg.port $target "${sudo}cat /root/hearth-backups/last-update.log 2>/dev/null || echo '(no log on the server - the updater never started)'"
if ($logText) {
  $logText | Out-File -FilePath $logFile -Encoding utf8
  Say ''
  Say "Last lines of the server log (full log saved to $logFile):" Yellow
  $logText | Select-Object -Last 25 | ForEach-Object { Say "  $_" }
}
Fail 'The update did not finish. Send the lines above (or last-update-log.txt) to whoever gave you the update.'
