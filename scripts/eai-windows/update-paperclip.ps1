# EKS-277: przygotowanie aktualizacji Paperclip po kliknieciu "Zaktualizuj" w banerze.
# Uruchamia go serwer (PAPERCLIP_UPDATE_COMMAND) z PAPERCLIP_UPDATE_TARGET_VERSION. Serwer dziala dalej.
#
# 1. Galaz w forku od tagu nowej wersji + cherry-pick naszych commitow (widget limitow, restart, baner...).
# 2. Instalacja, testy naszych zmian, build UI.
# 3. Nowy katalog pkg-<wersja> z npm + nasze pliki serwera (esbuild) + nasz ui-dist, test importu.
# 4. Stan "ready_to_switch" -> serwer sam sie restartuje, a switch-paperclip.ps1 podmienia wersje.
# Konflikt / blad testow / buildu -> nic nie jest podmieniane, stan "failed" + zadanie w Paperclip.
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
$state = @{ state = 'preparing'; targetVersion = $TargetVersion; fromVersion = $fromMeta.version; pkg = $newPkg; log = $workLog }

function Step([string]$text) {
  $state.step = $text
  Write-UpdateState $state
  Log ("aktualizacja " + $TargetVersion + ": " + $text)
  Add-Content -Path $workLog -Encoding UTF8 -Value ("=== " + $text) -ErrorAction SilentlyContinue
}

# Uruchamia narzedzie, dopisuje wyjscie do logu aktualizacji; kod != 0 -> wyjatek z czytelnym opisem.
function Run([string]$what, [scriptblock]$cmd) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $cmd *>> $workLog
  $code = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($code -ne 0) { throw "$what (kod $code)" }
}

function RepoGit { & git.exe -C $repo -c user.name="EkspertAI Updater" -c user.email=dev-agent@ekspertai.local @args }

if ((Test-Path $updLock) -and ((Get-Item $updLock).LastWriteTime -gt (Get-Date).AddMinutes(-90))) {
  Log 'aktualizacja juz trwa (update.lock) - pomijam'
  exit 0
}
Set-Content -Path $updLock -Value "update $TargetVersion $stamp"
$env:Path = "$($Cfg.nodeDir);$env:Path"
$pnpm = @((Join-Path $Cfg.nodeDir 'corepack.cmd'), 'pnpm')

try {
  if (-not $TargetVersion) { throw 'brak docelowej wersji' }
  if (-not $fromMeta) { throw "brak $fromPkg\eai-meta.json - nie wiem, ktore commity sa nasze" }

  Step 'Pobieram nowa wersje z GitHuba'
  Run 'git fetch' { RepoGit fetch upstream --tags --force }
  $newTag = "v$installVersion"
  Run "brak tagu $newTag w upstream" { RepoGit rev-parse --verify --quiet "refs/tags/$newTag" }

  $ours = @(RepoGit rev-list --reverse "$($fromMeta.baseTag)..$($fromMeta.branch)")
  if ($ours.Count -eq 0) { throw "brak naszych commitow w $($fromMeta.branch)" }
  $touched = @(RepoGit diff --name-only "$($fromMeta.baseTag)..$($fromMeta.branch)")
  $outside = @($touched | Where-Object { $_ -notmatch '^(server/src|ui/src|scripts/eai-windows)/' })
  if ($outside.Count -gt 0) { throw ("nasze zmiany dotykaja plikow poza server/ui - automat ich nie przeniesie: " + ($outside -join ', ')) }

  Step ("Przenosze nasze zmiany (" + $ours.Count + " commitow)")
  Run 'git checkout' { RepoGit checkout -f -B $newBranch $newTag }
  foreach ($c in $ours) {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    RepoGit cherry-pick -x $c *>> $workLog
    $code = $LASTEXITCODE; $ErrorActionPreference = $eap
    if ($code -ne 0) {
      $subject = RepoGit log -1 --format=%s $c
      RepoGit cherry-pick --abort *>> $workLog
      throw ("konflikt przy przenoszeniu zmiany: " + $subject)
    }
  }

  Step 'Instaluje zaleznosci'
  Run 'pnpm install' { & $pnpm[0] $pnpm[1] -C $repo install --frozen-lockfile --ignore-scripts }

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
  Run 'build interfejsu' { & $pnpm[0] $pnpm[1] -C $repo --filter '@paperclipai/ui' build }

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

  Step 'Sprawdzam, czy nowa wersja sie laduje'
  $imports = @('dist/app.js') + ($serverSrc | ForEach-Object { 'dist/' + ($_ -replace '^server/src/', '' -replace '\.ts$', '.js') })
  $js = ($imports | Select-Object -Unique | ForEach-Object {
      "await import('file:///" + ((Join-Path $serverPkg $_) -replace '\\', '/') + "');"
    }) -join ' '
  Run 'nowa wersja serwera nie laduje sie' { & $NodeExe --input-type=module -e "$js console.log('import ok'); process.exit(0);" }
  if (!(Test-Path (Join-Path $serverPkg 'ui-dist\index.html'))) { throw 'brak ui-dist\index.html' }

  if ($Cfg.test.breakAt -eq 'startup') {
    # Symulacja buildu, ktory przechodzi testy, ale serwer nie wstaje -> sprawdza automatyczne wycofanie.
    Set-Content -Path (Get-PkgEntry $newPkg) -Value "throw new Error('EKS-277 simulated broken startup');"
  }

  $meta = [ordered]@{ version = $installVersion; branch = $newBranch; baseTag = $newTag; builtAt = (Get-Date).ToString('o') } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $pkgPath 'eai-meta.json'), $meta, (New-Object System.Text.UTF8Encoding($false)))

  if ($Cfg.pushBranch) {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    RepoGit push -q origin $newBranch *>> $workLog
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
  $issue = New-PaperclipIssue "Aktualizacja Paperclip do $TargetVersion wymaga recznej pracy" (
    "Automatyczna aktualizacja z banera zatrzymala sie przed podmiana wersji. Serwer dziala dalej na $($fromMeta.version).`n`n" +
    "- Krok: $($state.step)`n- Blad: $msg`n- Galaz w forku: $newBranch (repo $repo)`n- Log: $workLog`n`n" +
    "Do zrobienia: rozwiazac problem na galezi $newBranch (np. konflikt cherry-pick), zbudowac i podmienic wersje wg EKS-277.")
  if ($issue) { $state.issue = $issue; Write-UpdateState $state }
  exit 1
}
finally {
  Remove-Item $updLock -Force -ErrorAction SilentlyContinue
  if ($overlay -and (Test-Path $overlay)) { Remove-Item -Recurse -Force $overlay -ErrorAction SilentlyContinue }
  if ($Cfg.test.breakAt -eq 'build') { git -C $repo checkout -- ui/src/main.tsx 2>$null }
}
