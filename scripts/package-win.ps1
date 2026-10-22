$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$tempOutput = Join-Path $env:TEMP 'mtg-sideboard-coach-release'
$releaseOutput = Join-Path $projectRoot 'release'
$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$artifactName = "$($packageJson.build.productName) v$($packageJson.version) portable.exe"

if (Test-Path $tempOutput) {
  Remove-Item -LiteralPath $tempOutput -Recurse -Force
}

Push-Location $projectRoot
try {
  & npx electron-builder --win portable --x64 "--config.directories.output=$tempOutput"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  New-Item -ItemType Directory -Force -Path $releaseOutput | Out-Null
  Copy-Item -LiteralPath (Join-Path $tempOutput $artifactName) -Destination $releaseOutput -Force
}
finally {
  Pop-Location
}
