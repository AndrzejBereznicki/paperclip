# Paperclip watchdog - wersja "one-shot".
# Uruchamiany przez zadanie Harmonogramu "Paperclip": przy logowaniu ORAZ co 5 min.
# Kazde uruchomienie: sprawdz health -> jesli serwer nie odpowiada, wystartuj go w tle
# (odlaczony proces) i natychmiast zakoncz.
#
# EKS-277: katalog wersji (pkg-*) czytany z active-pkg.txt - przelacza go skrypt aktualizacji
# (switch-paperclip.ps1). Ustawienia instalacji w instance.json obok skryptu.
# Historia: EKS-193 przypieta instalacja zamiast npx, EKS-275 2026.916.1, EKS-276 przycisk restartu.

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'paperclip-common.ps1')

$outLog = Join-Path $Root 'paperclip.out.log'
$errLog = Join-Path $Root 'paperclip.err.log'

# rotacja logu po przekroczeniu 5 MB
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) { Move-Item $LogFile "$LogFile.1" -Force }

# 1. Serwer juz odpowiada -> nic nie rob.
try {
  $r = Invoke-WebRequest -UseBasicParsing $Cfg.healthUrl -TimeoutSec 5
  if ($r.StatusCode -eq 200) { exit 0 }
} catch { }

# 1b. Trwa przelaczanie/wycofanie wersji -> nie startuj. Lock starszy niz 30 min ignorujemy.
if ((Test-Path $MaintLock) -and ((Get-Item $MaintLock).LastWriteTime -gt (Get-Date).AddMinutes(-30))) { Log 'maintenance.lock - pomijam start'; exit 0 }

# 2. Nie odpowiada, ale proces "paperclipai ... run" juz wstaje -> daj mu czas, nie startuj drugiego.
if (Get-ServerProcesses) { Log 'health NIE ok, ale proces run juz istnieje - czekam na kolejny tick'; exit 0 }

# 3. Sanity: aktywna instalacja musi istniec.
$pkg = Get-ActivePkg
$entry = Get-PkgEntry $pkg
if (!(Test-Path $entry)) { Log ("BLAD: brak instalacji " + $entry); exit 1 }

# 4. Start serwera w tle (odlaczony) i wyjscie.
$env:Path = "$($Cfg.nodeDir);C:\nvm4w\nodejs;$env:Path"
$env:PAPERCLIP_ANNOUNCEMENTS_ENABLED = 'false'
$ps = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File'
# EKS-276: przycisk "Uruchom ponownie" - serwer odpala to tuz przed zamknieciem
$env:PAPERCLIP_RESTART_RESPAWN_COMMAND = "$ps `"$Root\respawn-after-restart.ps1`""
# EKS-277: baner "Dostepna nowa wersja" - klik "Zaktualizuj" odpala przygotowanie nowej wersji
$env:PAPERCLIP_UPDATE_COMMAND = "$ps `"$Root\update-paperclip.ps1`""
$env:PAPERCLIP_UPDATE_STATE_FILE = $StateFile
foreach ($p in $Cfg.env.PSObject.Properties) { Set-Item -Path ("env:" + $p.Name) -Value $p.Value }

$argList = @("`"$entry`"", 'run')
if ($Cfg.dataDir) { $argList += @('--data-dir', "`"$($Cfg.dataDir)`"") }
Log ("health NIE ok - startuje: " + $pkg + " run")
try {
  Start-Process -FilePath $NodeExe -ArgumentList $argList -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  Log 'proces serwera wystartowany w tle'
} catch {
  Log ("BLAD startu: " + $_.Exception.Message)
  exit 1
}
exit 0
