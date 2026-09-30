# EKS-277: podmiana wersji Paperclip przygotowanej przez update-paperclip.ps1.
# Odpala go respawn-after-restart.ps1, gdy stary serwer juz sie zamknal, a stan to "ready_to_switch".
#
# Kolejnosc (lekcje z EKS-275): maintenance.lock (watchdog nie wstaje w trakcie), zatrzymanie serwera
# i bazy (pg_ctl moze klamac o PID - decyduje brak procesow), kopia bazy NA ZIMNO, przelaczenie
# active-pkg.txt, start, weryfikacja health + linii polecen procesu (nie samego health).
# Porazka -> automatyczne wycofanie: baza z kopii (nieudana odlozona jako db.failed-*), poprzedni pkg.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'paperclip-common.ps1')

$st = Read-UpdateState
if (-not $st -or $st.state -ne 'ready_to_switch') { Log 'switch: brak przygotowanej aktualizacji - nic nie robie'; exit 0 }

$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$newPkg  = $st.pkg
$oldPkg  = Get-ActivePkg
$target  = $st.targetVersion
$from    = (Get-PkgMeta $oldPkg).version
$timeout = if ($Cfg.startTimeoutSec) { [int]$Cfg.startTimeoutSec } else { 300 }
$dbBak   = "$($Cfg.dbDir).bak-update-$stamp"
$state   = @{ state = 'switching'; targetVersion = $target; fromVersion = $from; pkg = $newPkg; previousPkg = $oldPkg; branch = $st.branch; log = $LogFile }

function Fail-Hard([string]$msg, [string]$final = 'failed') {
  $state.state = $final; $state.message = $msg; Write-UpdateState $state
  Log ('switch: ' + $msg)
}
}

if (!(Test-Path (Get-PkgEntry $newPkg))) { Fail-Hard "Brak przygotowanej wersji $newPkg - nic nie podmieniono."; exit 1 }

$state.step = 'Zatrzymuje serwer i baze'; Write-UpdateState $state
Set-Content -Path $MaintLock -Value "switch $target $stamp"
try {
  if (-not (Stop-PaperclipServer $oldPkg)) { throw 'Postgres nadal dziala - przerwano przed kopia bazy' }

  $state.step = 'Kopia bazy'; Write-UpdateState $state
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  robocopy $Cfg.dbDir $dbBak /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  $rc = $LASTEXITCODE; $ErrorActionPreference = $eap
  if ($rc -ge 8) { throw "kopia bazy nie powiodla sie (robocopy $rc)" }
  # zostaw dwie ostatnie kopie z aktualizacji
  Get-ChildItem (Split-Path $Cfg.dbDir) -Directory -Filter ((Split-Path $Cfg.dbDir -Leaf) + '.bak-update-*') |
    Sort-Object Name -Descending | Select-Object -Skip 2 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Set-ActivePkg $newPkg
}
catch {
  Remove-Item $MaintLock -Force -ErrorAction SilentlyContinue
  Fail-Hard ("Podmiana przerwana przed zmiana wersji: " + $_.Exception.Message + ". Dziala dotychczasowa wersja.")
  Start-Watchdog
  exit 1
}
Remove-Item $MaintLock -Force -ErrorAction SilentlyContinue

$state.step = "Uruchamiam $target"; Write-UpdateState $state
Log ("switch: start " + $newPkg)
Start-Watchdog
if (Wait-ServerUp $newPkg $timeout) {
  $state.state = 'updated'; $state.step = 'Gotowe'; Write-UpdateState $state
  Log ("switch: OK - dziala " + $newPkg)
  exit 0
}

# --- wycofanie ---
Log ("switch: " + $newPkg + " nie wstal w " + $timeout + " s - wycofuje do " + $oldPkg)
$state.step = "Wycofuje do $from"; Write-UpdateState $state
Set-Content -Path $MaintLock -Value "rollback $target $stamp"
try {
  Stop-PaperclipServer $newPkg | Out-Null
  if (Get-PostgresProcesses) { throw 'Postgres nowej wersji nie daje sie zatrzymac' }
  Rename-Item $Cfg.dbDir ((Split-Path $Cfg.dbDir -Leaf) + ".failed-$stamp")
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  robocopy $dbBak $Cfg.dbDir /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  $rc = $LASTEXITCODE; $ErrorActionPreference = $eap
  if ($rc -ge 8) { throw "przywracanie bazy nie powiodlo sie (robocopy $rc)" }
  Set-ActivePkg $oldPkg
}
catch {
  Remove-Item $MaintLock -Force -ErrorAction SilentlyContinue
  Fail-Hard ("Nowa wersja nie wstala, a wycofanie sie nie udalo: " + $_.Exception.Message + ". Serwer moze nie dzialac - potrzebna reczna naprawa.")
  exit 1
}
Remove-Item $MaintLock -Force -ErrorAction SilentlyContinue
Start-Watchdog
if (Wait-ServerUp $oldPkg $timeout) {
  Fail-Hard ("Wersja $target nie wystartowala - automatycznie przywrocono $from (z baza sprzed aktualizacji; nieudana odlozona jako db.failed-$stamp).") 'rolled_back'
  exit 1
}
Fail-Hard "Wersja $target nie wystartowala i po wycofaniu $from tez nie odpowiada. Potrzebna reczna naprawa."
exit 1
