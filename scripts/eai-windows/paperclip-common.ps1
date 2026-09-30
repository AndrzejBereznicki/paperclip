# EKS-277: wspolne funkcje skryptow Paperclip na Windows (watchdog, aktualizacja, przelaczenie wersji).
# Dolaczany przez ". (Join-Path $PSScriptRoot 'paperclip-common.ps1')".
# Wszystkie sciezki wynikaja z katalogu skryptu ($Root) + instance.json, dzieki czemu ten sam
# zestaw skryptow dziala produkcyjnie (C:\.claude\paperclip-autostart) i w piaskownicy testowej.

$Root      = $PSScriptRoot
$Cfg       = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'instance.json') | ConvertFrom-Json
$LogFile   = Join-Path $Root 'paperclip.log'
$StateFile = Join-Path $Root 'update-state.json'
$MaintLock = Join-Path $Root 'maintenance.lock'
$NodeExe   = Join-Path $Cfg.nodeDir 'node.exe'

function Log([string]$m) {
  Add-Content -Path $LogFile -Encoding UTF8 -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

function Get-ActivePkg {
  $f = Join-Path $Root 'active-pkg.txt'
  if (Test-Path $f) { $n = (Get-Content -Raw $f).Trim(); if ($n) { return $n } }
  return $Cfg.defaultPkg
}

function Set-ActivePkg([string]$name) {
  Set-Content -Path (Join-Path $Root 'active-pkg.txt') -Value $name -Encoding ASCII
}

function Get-PkgEntry([string]$pkg) { Join-Path $Root "$pkg\node_modules\paperclipai\dist\index.js" }

function Get-PkgMeta([string]$pkg) {
  $f = Join-Path $Root "$pkg\eai-meta.json"
  if (Test-Path $f) { return Get-Content -Raw -Encoding UTF8 $f | ConvertFrom-Json }
  return $null
}

function Read-UpdateState {
  if (!(Test-Path $StateFile)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 $StateFile | ConvertFrom-Json } catch { return $null }
}

# Plik stanu czyta serwer (baner w UI). Zapis przez plik tymczasowy, zeby serwer nie trafil na polowe JSON-a.
function Write-UpdateState([hashtable]$s) {
  $s.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $json = $s | ConvertTo-Json -Depth 5
  $tmp = "$StateFile.tmp"
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Force $tmp $StateFile
}

# Procesy serwera TEJ instalacji (po katalogu $Root w linii polecen), nie wszystkie node.exe.
function Get-ServerProcesses {
  $rootRx = [regex]::Escape($Root)
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'paperclipai' -and $_.CommandLine -match '(^|\s)run(\s|$)' -and $_.CommandLine -match $rootRx }
}

# Procesy bazy TEJ instalacji. Tylko postmaster ma w linii polecen katalog bazy; procesy potomne
# (checkpointer, backend...) maja tylko sciezke programu - ta lezy w pkg-* pod $Root.
function Get-PostgresProcesses {
  $rootFwd = [regex]::Escape($Root.Replace('\', '/'))
  $rootWin = [regex]::Escape($Root)
  Get-CimInstance Win32_Process -Filter "Name = 'postgres.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $rootFwd -or $_.CommandLine -match $rootWin }
}

# Zatrzymuje serwer i jego baze. pg_ctl potrafi zglosic "No such process" (nieaktualny PID) -
# to nie blad; o wyniku decyduje, czy procesy postgres tej bazy nadal istnieja.
function Stop-PaperclipServer([string]$pkg) {
  Get-ServerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  if (Get-PostgresProcesses) {
    $pgCtl = Join-Path $Root "$pkg\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe"
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $pgCtl stop -D $Cfg.dbDir -m fast -w -t 60 2>&1 | ForEach-Object { Log ("pg_ctl: " + $_) }
    $ErrorActionPreference = $eap
    for ($i = 0; $i -lt 15 -and (Get-PostgresProcesses); $i++) { Start-Sleep -Seconds 2 }
  }
  if (Get-PostgresProcesses) {
    Get-PostgresProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
  }
  return -not (Get-PostgresProcesses)
}

function Start-Watchdog {
  if ($Cfg.scheduledTask) {
    schtasks.exe /Run /TN $Cfg.scheduledTask | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Log ('schtasks zwrocil ' + $LASTEXITCODE + ' - uruchamiam watchdoga bezposrednio')
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'start-paperclip.ps1')
}

# Serwer zdrowy = /api/health odpowiada ORAZ dziala proces z oczekiwanego pkg (sam health moze byc stara wersja).
function Wait-ServerUp([string]$pkg, [int]$timeoutSec) {
  $pkgRx = [regex]::Escape((Join-Path $Root $pkg))
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    try {
      $r = Invoke-WebRequest -UseBasicParsing $Cfg.healthUrl -TimeoutSec 5
      if ($r.StatusCode -eq 200 -and (Get-ServerProcesses | Where-Object { $_.CommandLine -match $pkgRx })) { return $true }
    } catch { }
  }
  return $false
}

# Zadanie w Paperclip, gdy aktualizacja wymaga czlowieka. CLI korzysta z zapisanego logowania tej maszyny.
function New-PaperclipIssue([string]$title, [string]$description) {
  if (-not $Cfg.issue) { return $null }
  $cli = Get-PkgEntry (Get-ActivePkg)
  try {
    $out = & $NodeExe $cli issue create --company-id $Cfg.issue.companyId --project-id $Cfg.issue.projectId `
      --assignee-agent-id $Cfg.issue.assigneeAgentId --status todo --priority high `
      --title $title --description $description --json 2>&1
    $obj = ($out | Out-String) | ConvertFrom-Json -ErrorAction Stop
    return $obj.identifier
  } catch {
    Log ('nie udalo sie zalozyc zadania: ' + ($out | Out-String))
    return $null
  }
}
