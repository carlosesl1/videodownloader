[CmdletBinding()]
param(
  [string]$ExpectedTag,
  [string]$IsccPath,
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$workRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tools\v1-release'))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $projectRoot 'dist\release'
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)

function Assert-ProjectChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $prefix = $projectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay inside the project directory."
  }
}

function Copy-ApprovedTree {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][string[]]$Extensions
  )

  $sourcePrefix = [IO.Path]::GetFullPath($SourceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) +
    [IO.Path]::DirectorySeparatorChar
  foreach ($file in @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | Sort-Object FullName)) {
    if ($Extensions -cnotcontains $file.Extension) {
      throw "Release tree contains a non-allowlisted file: $($file.FullName)"
    }
    $filePath = [IO.Path]::GetFullPath($file.FullName)
    if (-not $filePath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Release file escaped its approved source tree: $filePath"
    }
    $relativePath = $filePath.Substring($sourcePrefix.Length)
    $destinationPath = Join-Path $DestinationRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destinationPath
  }
}

function Copy-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($entry in @(Get-ChildItem -LiteralPath $Source)) {
    Copy-Item -LiteralPath $entry.FullName -Destination $Destination -Recurse
  }
}

Assert-ProjectChildPath -Path $workRoot -Label 'WorkRoot'
Assert-ProjectChildPath -Path $OutputRoot -Label 'OutputRoot'

$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = [string]$packageJson.version
if ($Version -cnotmatch '^\d+\.\d+\.\d+$') {
  throw 'package.json must contain a stable semantic version.'
}
if ([string]::IsNullOrWhiteSpace($ExpectedTag)) {
  $ExpectedTag = "v$Version"
}

& node (Join-Path $projectRoot 'scripts\validate-release.mjs') "--tag=$ExpectedTag"
if ($LASTEXITCODE -ne 0) {
  throw "Release validation failed with exit code $LASTEXITCODE."
}

$helperRoot = Join-Path $workRoot 'helper'
$packageScript = Join-Path $projectRoot 'scripts\package-native-helper.ps1'
& $packageScript -OutputRoot $helperRoot

$buildId = [Guid]::NewGuid().ToString('N')
$stagingRoot = Join-Path $workRoot "staging-$buildId"
$payloadRoot = Join-Path $stagingRoot 'payload'
$extensionRoot = Join-Path $payloadRoot 'Extension'
$artifactStaging = Join-Path $stagingRoot 'artifacts'
$developerRoot = Join-Path $stagingRoot 'developer'
$outputBackup = "$OutputRoot.backup-$buildId"
$outputMoved = $false
$backupMoved = $false

$topLevelExtensionFiles = @('manifest.json', 'popup.html', 'options.html', 'offscreen.html')
$approvedTrees = @(
  @{ Name = 'assets'; Extensions = @('.png') },
  @{ Name = 'styles'; Extensions = @('.css') },
  @{ Name = 'src'; Extensions = @('.js') }
)
$excludedReleaseRoots = @('test', '.git', '.tools', 'dist')

New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
New-Item -ItemType Directory -Path $artifactStaging -Force | Out-Null
try {
  foreach ($relativePath in $topLevelExtensionFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $relativePath) `
      -Destination (Join-Path $extensionRoot $relativePath)
  }
  foreach ($tree in $approvedTrees) {
    $destination = Join-Path $extensionRoot $tree.Name
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-ApprovedTree -SourceRoot (Join-Path $projectRoot $tree.Name) `
      -DestinationRoot $destination -Extensions $tree.Extensions
  }
  foreach ($excludedRoot in $excludedReleaseRoots) {
    if (Test-Path -LiteralPath (Join-Path $extensionRoot $excludedRoot)) {
      throw "Excluded development root reached the extension payload: $excludedRoot"
    }
  }

  Copy-DirectoryContents -Source (Join-Path $helperRoot 'host') `
    -Destination (Join-Path $payloadRoot 'host')
  Copy-DirectoryContents -Source (Join-Path $helperRoot 'licenses') `
    -Destination (Join-Path $payloadRoot 'licenses')
  Copy-DirectoryContents -Source (Join-Path $projectRoot 'installer\onboarding') `
    -Destination (Join-Path $payloadRoot 'onboarding')

  $legalRoot = Join-Path $payloadRoot 'legal'
  New-Item -ItemType Directory -Path $legalRoot -Force | Out-Null
  foreach ($legalFile in @('LICENSE', 'PRIVACY.md', 'SECURITY.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $legalFile) -Destination (Join-Path $legalRoot $legalFile)
  }

  $manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $toolLockHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot 'native-host\tool-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  $buildInfo = [ordered]@{
    version = $Version
    extensionId = 'cakpfifpfmbdcilimpedanglnopnmckg'
    manifestVersion = [string]$manifest.version
    nativeToolLockSha256 = $toolLockHash
  }
  [IO.File]::WriteAllText(
    (Join-Path $payloadRoot 'build-info.json'),
    (($buildInfo | ConvertTo-Json -Depth 3) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )

  if ([string]::IsNullOrWhiteSpace($IsccPath)) {
    $bootstrapOutput = @(& (Join-Path $projectRoot 'scripts\bootstrap-inno-setup.ps1'))
    if ($bootstrapOutput.Count -eq 0) {
      throw 'The Inno Setup bootstrap returned no compiler path.'
    }
    $IsccPath = [string]$bootstrapOutput[-1]
  }
  $isccPath = [IO.Path]::GetFullPath($IsccPath)
  if (-not (Test-Path -LiteralPath $isccPath -PathType Leaf) -or
      [IO.Path]::GetFileName($isccPath) -cne 'ISCC.exe') {
    throw 'ISCC.exe was not found. Run scripts/bootstrap-inno-setup.ps1 or pass -IsccPath.'
  }

  & $isccPath '/Qp' "/DReleaseVersion=$Version" "/DPayloadRoot=$payloadRoot" `
    "/O$artifactStaging" "/FVideoRadar-Setup-$Version-Windows-x64" `
    (Join-Path $projectRoot 'installer\video-radar.iss')
  if ($LASTEXITCODE -ne 0) {
    throw "ISCC failed with exit code $LASTEXITCODE."
  }

  $setupName = "VideoRadar-Setup-$Version-Windows-x64.exe"
  $setupPath = Join-Path $artifactStaging $setupName
  if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    throw "The installer was not produced: $setupName"
  }

  $developerExtension = Join-Path $developerRoot 'Extension'
  $developerHelper = Join-Path $developerRoot 'Helper'
  Copy-DirectoryContents -Source $extensionRoot -Destination $developerExtension
  Copy-DirectoryContents -Source $helperRoot -Destination $developerHelper
  foreach ($legalFile in @('LICENSE', 'PRIVACY.md', 'SECURITY.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $legalFile) -Destination (Join-Path $developerRoot $legalFile)
  }
  Copy-Item -LiteralPath (Join-Path $projectRoot 'installer\README-INSTALL.txt') `
    -Destination (Join-Path $developerRoot 'README-INSTALL.txt')

  $developerZipName = "VideoRadar-$Version-Developer.zip"
  $developerZipPath = Join-Path $artifactStaging $developerZipName
  $developerEntries = @(Get-ChildItem -LiteralPath $developerRoot | ForEach-Object { $_.FullName })
  Compress-Archive -LiteralPath $developerEntries -DestinationPath $developerZipPath -CompressionLevel Optimal

  $checksumName = 'SHA256SUMS.txt'
  $checksumPath = Join-Path $artifactStaging $checksumName
  $checksumLines = @(
    foreach ($artifact in @(Get-Item -LiteralPath $setupPath, $developerZipPath | Sort-Object Name)) {
      $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      "$hash  $($artifact.Name)"
    }
  )
  [IO.File]::WriteAllLines($checksumPath, $checksumLines, [Text.UTF8Encoding]::new($false))

  New-Item -ItemType Directory -Path (Split-Path -Parent $OutputRoot) -Force | Out-Null
  if (Test-Path -LiteralPath $OutputRoot) {
    Move-Item -LiteralPath $OutputRoot -Destination $outputBackup
    $backupMoved = $true
  }
  Move-Item -LiteralPath $artifactStaging -Destination $OutputRoot
  $outputMoved = $true
  if ($backupMoved) {
    Remove-Item -LiteralPath $outputBackup -Recurse -Force
    $backupMoved = $false
  }

  Write-Host "Video Radar $Version release created at $OutputRoot"
  Write-Host "  $setupName"
  Write-Host "  $developerZipName"
  Write-Host "  $checksumName"
}
catch {
  if ($outputMoved -and (Test-Path -LiteralPath $OutputRoot)) {
    Move-Item -LiteralPath $OutputRoot -Destination "$OutputRoot.failed-$buildId"
  }
  if ($backupMoved -and (Test-Path -LiteralPath $outputBackup)) {
    Move-Item -LiteralPath $outputBackup -Destination $OutputRoot
  }
  throw
}
finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
