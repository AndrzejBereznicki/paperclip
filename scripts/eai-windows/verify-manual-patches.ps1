# EKS-451: reczne latki (npm->cmd.exe w adapters.js z EKS-275, manifest display=standalone z EKS-308,
# windowsHide na wywolaniach git z EKS-474, node-pty bridge w local-ai-browser-login.js z EKS-585,
# fallback na lokalny login w costs.js z EKS-589, curl --data-binary @plik w skills/paperclip/scripts
# z EKS-606)
# nie zyja w forku - npm install i nadpisanie ui-dist kasuja je przy kazdej aktualizacji.
# update-paperclip.ps1 naklada manifest, windowsHide i latke curl sam (EKS-577, EKS-606); ten skrypt
# konczy sie bledem (exit 1), nie tylko ostrzezeniem, zeby aktualizacja nie przeszla cicho bez
# ktorejs z nich.
# Mozna tez odpalic recznie na dowolnym pkg-* do kontroli.
param([Parameter(Mandatory = $true)][string]$ServerPkgPath)

$ErrorActionPreference = 'Stop'
$failures = @()

$adaptersJs = Join-Path $ServerPkgPath 'dist\routes\adapters.js'
if (!(Test-Path $adaptersJs)) {
  $failures += "brak pliku $adaptersJs"
} else {
  $content = Get-Content -Raw -Encoding UTF8 $adaptersJs
  if ($content -notmatch 'cmd\.exe' -or $content -notmatch 'npm\.cmd') {
    $failures += "adapters.js: brak latki npm->cmd.exe (EKS-275) - instalacja/reinstalacja adaptera na Windows posypie sie EINVAL"
  }
}

$manifest = Join-Path $ServerPkgPath 'ui-dist\site.webmanifest'
if (!(Test-Path $manifest)) {
  $failures += "brak pliku $manifest"
} else {
  $content = Get-Content -Raw -Encoding UTF8 $manifest
  if ($content -notmatch '"display"\s*:\s*"standalone"') {
    $failures += "site.webmanifest: brak latki display=standalone (EKS-308) - telefon znow pokaze pasek przegladarki zamiast PWA"
  }
}

# ServerPkgPath = <pkg>\node_modules\@paperclipai\server -> wejscie CLI w <pkg>\node_modules\paperclipai
$entry = Join-Path (Split-Path (Split-Path $ServerPkgPath)) 'paperclipai\dist\index.js'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (!(Test-Path $entry)) {
  $failures += "brak pliku $entry"
} elseif (-not $node) {
  $failures += "brak node.exe w PATH - nie sprawdze latki windowsHide (EKS-474)"
} else {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $node (Join-Path $PSScriptRoot 'patch-windows-hide.mjs') $entry --check 2>&1 | Out-Null
  $code = $LASTEXITCODE; $ErrorActionPreference = $eap
  if ($code -ne 0) {
    $failures += "index.js: brak latki windowsHide na wywolaniach git (EKS-474) - wroca migajace czarne okienka"
  }
}

$loginJs = Join-Path $ServerPkgPath 'dist\services\local-ai-browser-login.js'
if (!(Test-Path $loginJs)) {
  $failures += "brak pliku $loginJs"
} else {
  $content = Get-Content -Raw -Encoding UTF8 $loginJs
  if ($content -notmatch 'win32' -or $content -notmatch "import\(.node-pty.\)") {
    $failures += "local-ai-browser-login.js: brak latki node-pty/ConPTY na Windows (EKS-585) - logowanie subskrypcja Claude w kreatorze nowej organizacji znow sie wywali na brak pty"
  } else {
    $ptyNested = Join-Path $ServerPkgPath 'node_modules\node-pty\lib\index.js'
    $ptyHoisted = Join-Path (Split-Path (Split-Path $ServerPkgPath)) 'node-pty\lib\index.js'
    if (!(Test-Path $ptyNested) -and !(Test-Path $ptyHoisted)) {
      $failures += "node-pty: kod ma latke EKS-585, ale pakiet node-pty nie jest zainstalowany w node_modules - import('node-pty') na Windows wywali sie w runtime"
    }
  }
}

$costsJs = Join-Path $ServerPkgPath 'dist\routes\costs.js'
if (!(Test-Path $costsJs)) {
  $failures += "brak pliku $costsJs"
} else {
  $content = Get-Content -Raw -Encoding UTF8 $costsJs
  if ($content -notmatch 'fetchAllQuotaWindows') {
    $failures += "costs.js: brak latki fallback na fetchAllQuotaWindows (EKS-589) - widget Claude limits znow zniknie dla firm bez zarzadzanego polaczenia AI"
  }
}

# EKS-606: skills/paperclip/scripts/*.sh wysylaja payload do curla jako argument - na Windows psuje
# to polskie znaki (--data-binary "$var" -> trzeba --data-binary @plik).
$adaptersRoot = Split-Path $ServerPkgPath
$curlPatchTargets = @(
  Join-Path $adaptersRoot 'adapter-claude-local\skills\paperclip\scripts\paperclip-issue-update.sh'
  Join-Path $adaptersRoot 'adapter-codex-local\skills\paperclip\scripts\paperclip-issue-update.sh'
  Join-Path $ServerPkgPath 'skills\paperclip\scripts\paperclip-issue-update.sh'
  Join-Path $adaptersRoot 'adapter-claude-local\skills\paperclip\scripts\paperclip-upload-artifact.sh'
  Join-Path $adaptersRoot 'adapter-codex-local\skills\paperclip\scripts\paperclip-upload-artifact.sh'
  Join-Path $ServerPkgPath 'skills\paperclip\scripts\paperclip-upload-artifact.sh'
) | Where-Object { Test-Path $_ }
if ($curlPatchTargets.Count -eq 0) {
  $failures += "brak plikow skills/paperclip/scripts/paperclip-{issue-update,upload-artifact}.sh pod $ServerPkgPath"
} elseif (-not $node) {
  $failures += "brak node.exe w PATH - nie sprawdze latki curl --data-binary @plik (EKS-606)"
} else {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $node (Join-Path $PSScriptRoot 'patch-curl-data-file.mjs') @curlPatchTargets --check 2>&1 | Out-Null
  $code = $LASTEXITCODE; $ErrorActionPreference = $eap
  if ($code -ne 0) {
    $failures += "skills/paperclip/scripts/*.sh: brak latki curl --data-binary @plik (EKS-606) - polskie znaki w komentarzach/opisach znow sie rozjedza na Windows"
  }
}

# EKS-600: @paperclipai/adapter-utils writePaperclipClaudeSettings() hardcodes
# Bash(curl:*)/Bash(env)/Bash(env:*) into every agent workspace's settings.local.json allow list
# on every run, overwriting the EKS-447/EKS-460 removal. Check both the active pkg's own copy and
# the separate shared adapter-plugins install the ACP engine actually runs agent sessions from
# (not touched by update-paperclip.ps1 - a stale, un-reinstalled copy there is expected and fine).
if (-not $node) {
  $failures += "brak node.exe w PATH - nie sprawdze latki no-wide-bash-allow (EKS-600)"
} else {
  $adapterUtilsTargets = @(
    (Join-Path $adaptersRoot 'adapter-utils\dist\acpx-engine\execute.js')
    'C:\Users\xfire\.paperclip\adapter-plugins\node_modules\@paperclipai\adapter-utils\dist\acpx-engine\execute.js'
  ) | Where-Object { Test-Path $_ }
  if ($adapterUtilsTargets.Count -eq 0) {
    $failures += "brak plikow adapter-utils/dist/acpx-engine/execute.js do sprawdzenia latki EKS-600"
  } else {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $node (Join-Path $PSScriptRoot 'patch-no-wide-bash-allow.mjs') @adapterUtilsTargets --check 2>&1 | Out-Null
    $code = $LASTEXITCODE; $ErrorActionPreference = $eap
    if ($code -ne 0) {
      $failures += "adapter-utils/execute.js: brak latki no-wide-bash-allow (EKS-600) - workspace CTO/CMO znow dostanie blankietowe Bash(curl:*)/Bash(env) w settings.local.json"
    }
  }
}

if ($failures.Count -gt 0) {
  foreach ($f in $failures) { Write-Error $f }
  exit 1
}
Write-Output "OK: wszystkie reczne latki obecne w $ServerPkgPath"
exit 0
