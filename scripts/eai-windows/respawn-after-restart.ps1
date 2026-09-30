# EKS-276: przycisk "Uruchom ponownie" w ustawieniach Paperclip.
# Serwer odpala ten skrypt (PAPERCLIP_RESTART_RESPAWN_COMMAND) tuz przed bezpiecznym zamknieciem.
# Czekamy, az stary proces (PAPERCLIP_RESTART_PREVIOUS_PID) sie zakonczy, i od razu uruchamiamy
# watchdoga - zamiast czekac do 5 min na kolejny tick zadania "Paperclip".
# EKS-277: jesli restart wynika z aktualizacji (stan ready_to_switch) - zamiast watchdoga podmiana wersji.

. (Join-Path $PSScriptRoot 'paperclip-common.ps1')

$oldPid = 0
[int]::TryParse("$env:PAPERCLIP_RESTART_PREVIOUS_PID", [ref]$oldPid) | Out-Null
Log ("restart z UI: czekam na zakonczenie procesu " + $oldPid)
if ($oldPid -gt 0) {
  try { Wait-Process -Id $oldPid -Timeout 600 -ErrorAction Stop } catch { }
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    Log 'restart z UI: stary proces nie zakonczyl sie w 10 min - zostawiam watchdogowi'
    exit 1
  }
}
Start-Sleep -Seconds 2

$st = Read-UpdateState
if ($st -and $st.state -eq 'ready_to_switch') {
  Log ("restart z UI: aktualizacja do " + $st.targetVersion + " - uruchamiam podmiane wersji")
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'switch-paperclip.ps1')
  exit $LASTEXITCODE
}

Log 'restart z UI: stary proces zakonczony - uruchamiam watchdoga'
# Przez Harmonogram (gdy jest), nie bezposrednio: nowy serwer dostaje czyste srodowisko zadania,
# a nie zmienne odziedziczone po starym procesie.
Start-Watchdog
exit 0
