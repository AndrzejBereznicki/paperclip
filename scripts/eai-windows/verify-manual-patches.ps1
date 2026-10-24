# EKS-451: reczne latki (npm->cmd.exe w adapters.js z EKS-275, manifest display=standalone z EKS-308,
# windowsHide na wywolaniach git z EKS-474) nie zyja w forku - npm install i nadpisanie ui-dist kasuja
# je przy kazdej aktualizacji. update-paperclip.ps1 naklada manifest i windowsHide sam (EKS-577);
# ten skrypt konczy sie bledem (exit 1), nie tylko ostrzezeniem, zeby aktualizacja nie przeszla cicho
# bez ktorejs z nich. Mozna tez odpalic recznie na dowolnym pkg-* do kontroli.
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

if ($failures.Count -gt 0) {
  foreach ($f in $failures) { Write-Error $f }
  exit 1
}
Write-Output "OK: wszystkie reczne latki obecne w $ServerPkgPath"
exit 0
