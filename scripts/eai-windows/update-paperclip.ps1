# EKS-277: przygotowanie aktualizacji Paperclip po kliknieciu "Zaktualizuj" w banerze.
# Uruchamia go serwer (PAPERCLIP_UPDATE_COMMAND) z PAPERCLIP_UPDATE_TARGET_VERSION. Serwer dziala dalej.
#
# 1. Galaz w forku od tagu nowej wersji + cherry-pick naszych commitow (widget limitow, restart, baner...).
# 2. Instalacja, testy naszych zmian, build UI.
# 3. Nowy katalog pkg-<wersja> z npm + nasze pliki serwera (esbuild) + nasz ui-dist, test importu.
# 4. Stan "ready_to_switch" -> serwer sam sie restartuje, a switch-paperclip.ps1 podmienia wersje.
# Konflikt / blad testow / buildu -> nic nie jest podmieniane, stan "failed"; serwer zaklada zadanie w Paperclip.
#
# Test na sucho: instance.json -> test.installVersion (zainstaluj istniejaca wersje zamiast docelowej)
# i test.breakAt = "build" (celowo zepsuty build) albo "startup" (nowa wersja nie wstaje -> wycofanie).

param([string]$TargetVersion = $env:PAPERCLIP_UPDATE_TARGET_VERSION)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'paperclip-common.ps1')

$updLock = Join-Path $Root 'update.lock'
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$repo    = $Cfg.repo
$fromPkg = Get-ActivePkg
$fromMeta = Get-PkgMeta $fromPkg
$installVersion = if ($Cfg.test.installVersion) { $Cfg.test.installVersion } else { $TargetVersion }
$newPkg  = if ($Cfg.test.installVersion) { "pkg-$TargetVersion-test-$stamp" } else { "pkg-$TargetVersion" }
$newBranch = if ($Cfg.test.installVersion) { "eai-test-$stamp" } else { "eai-$TargetVersion" }
$workLog = Join-Path $Root "update-$stamp.log"
$state = @{ state = 'preparing'; targetVersion = $TargetVersion; fromVersion = $fromMeta.version; pkg = $newPkg; branch = $newBranch; log = $workLog }

# EKS-327: baner pokazuje numer kroku, % i szacowany czas (pomiar z 2026-09-30: cala aktualizacja ~9 min).
$Steps = @(
  @{ name = 'Pobieram nowa wersje z GitHuba'; min = 0.5 },
  @{ name = 'Przenosze nasze zmiany';         min = 0.2 },
  @{ name = 'Instaluje zaleznosci';           min = 2 },
  @{ name = 'Testuje nasze zmiany';           min = 1 },
  @{ name = 'Buduje interfejs';               min = 3 },
  @{ name = 'Buduje zmiany serwera';          min = 0.2 },
  @{ name = 'Instaluje paperclipai';          min = 2 },
  @{ name = 'Nakladam nasze zmiany';          min = 0.2 },
  @{ name = 'Sprawdzam, czy nowa wersja';     min = 0.2 },
  @{ name = 'Weryfikuje reczne latki';        min = 0.1 },
  @{ name = 'Gotowe';                         min = 0 }
)
$started = Get-Date

function Step([string]$text) {
  $i = 0; while ($i -lt $Steps.Count - 1 -and -not $text.StartsWith($Steps[$i].name)) { $i++ }
  $done = 0; $total = 0
  for ($j = 0; $j -lt $Steps.Count; $j++) { $total += $Steps[$j].min; if ($j -lt $i) { $done += $Steps[$j].min } }
  $pct = [int](100 * $done / $total)
  $left = [math]::Ceiling($total - $done)
  $elapsed = [int]((Get-Date) - $started).TotalMinutes
  $eta = if ($left -gt 0) { ", zostalo ok. $left min" } else { '' }
  $state.step = "Krok $($i + 1)/$($Steps.Count) ($pct%): $text - trwa $elapsed min$eta"
  $state.percent = $pct
  Write-UpdateState $state
  Log ("aktualizacja " + $TargetVersion + ": " + $text)
  Add-Content -Path $workLog -Encoding UTF8 -Value ("=== " + $text) -ErrorAction SilentlyContinue
}

# Uruchamia narzedzie, dopisuje wyjscie do logu aktualizacji; kod != 0 -> wyjatek z czytelnym opisem.
function Run([string]$what, [scriptblock]$cmd) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $cmd 2>&1 | Out-File -Append -Encoding utf8 $workLog
  $code = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($code -ne 0) { throw "$what (kod $code)" }
}

# EKS-576: pnpm install zawisl na pobieraniu ostatnich paczek (zastoj sieci) i stal 90 min bez bledu.
# Twardy limit czasu: po $minutes min zabija drzewo procesow i rzuca wyjatek (wywolujacy moze ponowic).
function RunTimed([string]$what, [int]$minutes, [string]$dir, [string[]]$argv) {
  $out = "$workLog.part"
  $p = Start-Process -FilePath $argv[0] -ArgumentList $argv[1..($argv.Count - 1)] -WorkingDirectory $dir `
    -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  $null = $p.Handle  # bez tego ExitCode po zakonczeniu jest pusty (Start-Process -PassThru)
  $finished = $p.WaitForExit($minutes * 60000)
  if (-not $finished) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null; $p.WaitForExit(30000) | Out-Null }
  foreach ($f in $out, "$out.err") {
    if (Test-Path $f) { Get-Content $f | Out-File -Append -Encoding utf8 $workLog; Remove-Item $f -ErrorAction SilentlyContinue }
  }
  if (-not $finished) { throw "$what - brak konca po $minutes min (przerwane)" }
  if ($p.ExitCode -ne 0) { throw "$what (kod $($p.ExitCode))" }
}

function RepoGit { & git.exe -C $repo -c user.name="EkspertAI Updater" -c user.email=dev-agent@ekspertai.local @args }

if ((Test-Path $updLock) -and ((Get-Item $updLock).LastWriteTime -gt (Get-Date).AddMinutes(-90))) {
  Log 'aktualizacja juz trwa (update.lock) - pomijam'
  exit 0
}
Set-Content -Path $updLock -Value "update $TargetVersion $stamp"
$env:Path = "$($Cfg.nodeDir);$env:Path"
# Zmienne odziedziczone po serwerze nie moga trafic do testow i buildu (test restartu odpalilby prawdziwy respawn).
foreach ($v in 'PAPERCLIP_RESTART_RESPAWN_COMMAND', 'PAPERCLIP_UPDATE_COMMAND', 'PAPERCLIP_UPDATE_STATE_FILE', 'PAPERCLIP_UPDATE_SIMULATE_LATEST') {
  Remove-Item "env:$v" -ErrorAction SilentlyContinue
}
$pnpm = @((Join-Path $Cfg.nodeDir 'corepack.cmd'), 'pnpm')

try {
  if (-not $TargetVersion) { throw 'brak docelowej wersji' }
  if (-not $fromMeta) { throw "brak $fromPkg\eai-meta.json - nie wiem, ktore commity sa nasze" }

  Step 'Pobieram nowa wersje z GitHuba'
  # EKS-444: fetch zawisl na 90 min bez bledu - przy zastoju sieci (<1 KB/s przez 60 s) ma sie przerwac
  Run 'git fetch' { RepoGit -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 -c credential.interactive=never fetch upstream --tags --force }
  $newTag = "v$installVersion"
  Run "brak tagu $newTag w upstream" { RepoGit rev-parse --verify --quiet "refs/tags/$newTag" }

  $ours = @(RepoGit rev-list --reverse "$($fromMeta.baseTag)..$($fromMeta.branch)")
  if ($ours.Count -eq 0) { throw "brak naszych commitow w $($fromMeta.branch)" }
  $touched = @(RepoGit diff --name-only "$($fromMeta.baseTag)..$($fromMeta.branch)")
  $outside = @($touched | Where-Object { $_ -notmatch '^(server/src|ui/src|scripts/eai-windows)/' })
  if ($outside.Count -gt 0) { throw ("nasze zmiany dotykaja plikow poza server/ui - automat ich nie przeniesie: " + ($outside -join ', ')) }

  Step ("Przenosze nasze zmiany (" + $ours.Count + " commitow)")
  # EKS-575: po konflikcie czlowiek/agent przenosi zmiany recznie na $newBranch. Jesli galaz stoi na
  # nowym tagu i ma wszystkie nasze commity (po tytule), uzyj jej zamiast cherry-pick od zera.
  # Polowiczna galaz po nieudanej probie nie przejdzie tego sprawdzenia i zostanie zbudowana od nowa.
  $prepared = $false
  RepoGit rev-parse --verify --quiet "refs/heads/$newBranch" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    RepoGit merge-base --is-ancestor $newTag $newBranch
    if ($LASTEXITCODE -eq 0) {
      $have = @(RepoGit log --format=%s "$newTag..$newBranch")
      $missing = @($ours | Where-Object { $have -notcontains (RepoGit log -1 --format=%s $_) })
      $prepared = $missing.Count -eq 0
    }
  }
  if ($prepared) {
    Add-Content -Path $workLog -Encoding UTF8 -Value "=== uzywam przygotowanej galezi $newBranch"
    Run 'git checkout' { RepoGit checkout -f $newBranch }
    $ours = @()
    $touched = @(RepoGit diff --name-only "$newTag..$newBranch")
  } else {
    Run 'git checkout' { RepoGit checkout -f -B $newBranch $newTag }
  }
  foreach ($c in $ours) {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    RepoGit cherry-pick -x $c 2>&1 | Out-File -Append -Encoding utf8 $workLog
    $code = $LASTEXITCODE; $ErrorActionPreference = $eap
    if ($code -ne 0) {
      $subject = RepoGit log -1 --format=%s $c
      RepoGit cherry-pick --abort 2>&1 | Out-File -Append -Encoding utf8 $workLog
      throw ("konflikt przy przenoszeniu zmiany: " + $subject)
    }
  }

  Step 'Instaluje zaleznosci'
  # corepack wybiera wersje pnpm z packageManager w BIEZACYM katalogu - dlatego Push-Location, nie -C
  # EKS-327: bez okna pnpm nie moze pytac "usunac node_modules? (Y/n)" - inaczej wisi w nieskonczonosc
  $env:CI = 'true'
  # EKS-444: upstream potrafi wydac tag z nieaktualnym pnpm-lock.yaml (2026.1012.0) - wtedy instalacja bez frozen.
  # Repo sluzy tylko do budowy UI i nakladki; serwer i tak pochodzi z npm.
  # EKS-576: kazda proba max 15 min; ponowienie korzysta z paczek juz pobranych do magazynu pnpm.
  $pnpmArgs = @('install', '--ignore-scripts', '--config.confirm-modules-purge=false', '--reporter=append-only')
  $lockFlags = @('--frozen-lockfile', '--no-frozen-lockfile', '--no-frozen-lockfile')
  for ($a = 0; $a -lt $lockFlags.Count; $a++) {
    try { RunTimed 'pnpm install' 15 $repo (@($pnpm) + $pnpmArgs + $lockFlags[$a]); break }
    catch {
      if ($a -eq $lockFlags.Count - 1) { throw }
      Add-Content -Path $workLog -Encoding UTF8 -Value ("=== " + $_.Exception.Message + " - ponawiam z " + $lockFlags[$a + 1])
    }
  }

  Step 'Testuje nasze zmiany'
  $tests = @($touched | Where-Object { $_ -match '\.test\.tsx?$' })
  foreach ($pkgDir in @('server', 'ui')) {
    $files = @($tests | Where-Object { $_ -like "$pkgDir/*" } | ForEach-Object { $_.Substring($pkgDir.Length + 1) })
    if ($files.Count -eq 0) { continue }
    Run "testy $pkgDir nie przechodza" { Push-Location (Join-Path $repo $pkgDir); try { & (Join-Path $repo 'node_modules\.bin\vitest.cmd') run @files } finally { Pop-Location } }
  }

  Step 'Buduje interfejs'
  if ($Cfg.test.breakAt -eq 'build') {
    Add-Content -Path (Join-Path $repo 'ui\src\main.tsx') -Value 'const eks277SimulatedBrokenBuild: number = ;'
  }
  Run 'build interfejsu' { Push-Location $repo; try { & $pnpm[0] $pnpm[1] --filter '@paperclipai/ui' build } finally { Pop-Location } }

  Step 'Buduje zmiany serwera'
  $serverSrc = @($touched | Where-Object { $_ -match '^server/src/.*\.ts$' -and $_ -notmatch '(\.test\.ts|/__tests__/)' } |
    Where-Object { Test-Path (Join-Path $repo $_) })
  $overlay = Join-Path $env:TEMP "pc-overlay-$stamp"
  if ($serverSrc.Count -gt 0) {
    $full = $serverSrc | ForEach-Object { Join-Path $repo $_ }
    Run 'esbuild serwera' { & (Join-Path $repo 'node_modules\.bin\esbuild.cmd') @full "--outdir=$overlay" "--outbase=$(Join-Path $repo 'server\src')" --format=esm --platform=node --target=node22 --log-level=warning }
  }

  Step ("Instaluje paperclipai " + $installVersion + " (npm)")
  $pkgPath = Join-Path $Root $newPkg
  if (Test-Path $pkgPath) { Rename-Item $pkgPath "$newPkg.old-$stamp" }
  New-Item -ItemType Directory -Path $pkgPath | Out-Null
  $deps = [ordered]@{ paperclipai = $installVersion }
  foreach ($p in $Cfg.extraDependencies.PSObject.Properties) { $deps[$p.Name] = $p.Value }
  $pj = [ordered]@{ name = 'paperclip-pinned'; version = '1.0.0'; private = $true; dependencies = $deps } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $pkgPath 'package.json'), $pj, (New-Object System.Text.UTF8Encoding($false)))
  Run 'npm install' { Push-Location $pkgPath; try { & (Join-Path $Cfg.nodeDir 'npm.cmd') install --no-audit --no-fund } finally { Pop-Location } }

  Step 'Nakladam nasze zmiany na nowa wersje'
  $serverPkg = Join-Path $pkgPath 'node_modules\@paperclipai\server'
  if (!(Test-Path (Join-Path $serverPkg 'dist\app.js'))) { throw 'npm nie zainstalowal @paperclipai/server' }
  if (Test-Path $overlay) {
    Copy-Item -Recurse -Force (Join-Path $overlay '*') (Join-Path $serverPkg 'dist')
  }
  Rename-Item (Join-Path $serverPkg 'ui-dist') 'ui-dist.upstream'
  Copy-Item -Recurse (Join-Path $repo 'ui\dist') (Join-Path $serverPkg 'ui-dist')
  # EKS-577: reczne latki nakladane automatycznie (wczesniej tylko sprawdzane -> aktualizacja stawala)
  # EKS-308: PWA na telefonie bez paska przegladarki
  $manifest = Join-Path $serverPkg 'ui-dist\site.webmanifest'
  $mf = [System.IO.File]::ReadAllText($manifest) -replace '"display"\s*:\s*"browser"', '"display": "standalone"'
  [System.IO.File]::WriteAllText($manifest, $mf, (New-Object System.Text.UTF8Encoding($false)))
  # EKS-474: git bez windowsHide = migajace czarne okienka przy kazdym heartbeacie
  $entry = Get-PkgEntry $newPkg
  Run 'latka windowsHide' { & $NodeExe (Join-Path $Root 'patch-windows-hide.mjs') $entry }
  Run 'index.js po latce windowsHide nie parsuje sie' { & $NodeExe --check $entry }

  Step 'Sprawdzam, czy nowa wersja sie laduje'
  $imports = @('dist/app.js') + ($serverSrc | ForEach-Object { 'dist/' + ($_ -replace '^server/src/', '' -replace '\.ts$', '.js') })
  $js = ($imports | Select-Object -Unique | ForEach-Object {
      "await import('file:///" + ((Join-Path $serverPkg $_) -replace '\\', '/') + "');"
    }) -join ' '
  Run 'nowa wersja serwera nie laduje sie' { & $NodeExe --input-type=module -e "$js console.log('import ok'); process.exit(0);" }
  if (!(Test-Path (Join-Path $serverPkg 'ui-dist\index.html'))) { throw 'brak ui-dist\index.html' }

  Step 'Weryfikuje reczne latki'
  # EKS-451: npm install i nadpisanie ui-dist (krok wyzej) moga ubic reczne latki bez sladu -
  # blad tutaj, nie ostrzezenie, zeby aktualizacja nie przeszla cicho bez nich.
  Run 'reczne latki (npm->cmd.exe w adapters.js / manifest standalone / windowsHide) nie przetrwaly aktualizacji' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'verify-manual-patches.ps1') -ServerPkgPath $serverPkg
  }

  if ($Cfg.test.breakAt -eq 'startup') {
    # Symulacja buildu, ktory przechodzi testy, ale serwer nie wstaje -> sprawdza automatyczne wycofanie.
    Set-Content -Path (Get-PkgEntry $newPkg) -Value "throw new Error('EKS-277 simulated broken startup');"
  }

  $meta = [ordered]@{ version = $installVersion; branch = $newBranch; baseTag = $newTag; builtAt = (Get-Date).ToString('o') } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $pkgPath 'eai-meta.json'), $meta, (New-Object System.Text.UTF8Encoding($false)))

  if ($Cfg.pushBranch) {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    RepoGit push -q origin $newBranch 2>&1 | Out-File -Append -Encoding utf8 $workLog
    if ($LASTEXITCODE -ne 0) { Log "push $newBranch nie powiodl sie - galaz zostaje lokalnie" }
    $ErrorActionPreference = $eap
  }

  $state.state = 'ready_to_switch'
  Step 'Gotowe - czekam na restart serwera'
  exit 0
}
catch {
  $msg = $_.Exception.Message
  Log ("aktualizacja " + $TargetVersion + " PRZERWANA: " + $msg)
  Add-Content -Path $workLog -Encoding UTF8 -Value ("BLAD: " + $msg) -ErrorAction SilentlyContinue
  $state.state = 'failed'
  $state.message = "Nieudany krok: $($state.step) - $msg. Nic nie zostalo podmienione."
  Write-UpdateState $state
  # zadanie dla czlowieka zaklada serwer (widzi stan "failed" w pliku)
  exit 1
}
finally {
  Remove-Item $updLock -Force -ErrorAction SilentlyContinue
  if ($overlay -and (Test-Path $overlay)) { Remove-Item -Recurse -Force $overlay -ErrorAction SilentlyContinue }
  if ($Cfg.test.breakAt -eq 'build') {
    $ErrorActionPreference = 'Continue'
    RepoGit checkout -- ui/src/main.tsx 2>&1 | Out-File -Append -Encoding utf8 $workLog
  }
}
