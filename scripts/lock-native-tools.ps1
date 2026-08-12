[CmdletBinding()]
param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $projectRoot 'native-host\tool-lock.json'
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$toolsRoot = Join-Path $projectRoot '.tools'
$tempRoot = Join-Path $toolsRoot ('.lock-native-' + [Guid]::NewGuid().ToString('N'))

$apiHeaders = @{
  'User-Agent' = 'VideoRadar-ToolLock/1.0'
  'Accept' = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}
if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
  $apiHeaders['Authorization'] = 'Bearer ' + $env:GITHUB_TOKEN
}
$assetHeaders = $apiHeaders.Clone()
$assetHeaders['Accept'] = 'application/octet-stream'
$rawHeaders = $apiHeaders.Clone()
$rawHeaders['Accept'] = 'application/octet-stream'

$targetDefinitions = @(
  [ordered]@{
    rid = 'win-x64'
    architecture = 'x64'
    sources = @(
      [ordered]@{
        name = 'deno'
        repository = 'denoland/deno'
        assetName = 'deno-x86_64-pc-windows-msvc.zip'
        checksumAssetName = 'deno-x86_64-pc-windows-msvc.zip.sha256sum'
        archive = 'zip'
        outputs = @('deno.exe')
        licensePath = 'LICENSE.md'
        licenseFileName = 'deno-LICENSE.md'
        archiveLicenses = @()
      },
      [ordered]@{
        name = 'ffmpeg'
        repository = 'yt-dlp/FFmpeg-Builds'
        releaseTag = 'autobuild-2026-07-31-16-16'
        assetName = 'ffmpeg-N-125875-g5d4d3bdc61-win64-gpl.zip'
        checksumAssetName = 'checksums.sha256'
        archive = 'zip'
        outputs = @('ffmpeg.exe', 'ffprobe.exe')
        licensePath = 'LICENSE'
        licenseFileName = 'ffmpeg-builds-LICENSE.txt'
        archiveLicenses = @(
          [ordered]@{
            archivePath = 'ffmpeg-N-125875-g5d4d3bdc61-win64-gpl/LICENSE.txt'
            fileName = 'ffmpeg-GPL-LICENSE.txt'
          }
        )
      },
      [ordered]@{
        name = 'yt-dlp'
        repository = 'yt-dlp/yt-dlp'
        assetName = 'yt-dlp.exe'
        checksumAssetName = 'SHA2-256SUMS'
        archive = 'file'
        outputs = @('yt-dlp.exe')
        licensePath = 'LICENSE'
        licenseFileName = 'yt-dlp-LICENSE.txt'
        archiveLicenses = @()
      }
    )
  },
  [ordered]@{
    rid = 'win-arm64'
    architecture = 'arm64'
    sources = @(
      [ordered]@{
        name = 'deno'
        repository = 'denoland/deno'
        assetName = 'deno-aarch64-pc-windows-msvc.zip'
        checksumAssetName = 'deno-aarch64-pc-windows-msvc.zip.sha256sum'
        archive = 'zip'
        outputs = @('deno.exe')
        licensePath = 'LICENSE.md'
        licenseFileName = 'deno-LICENSE.md'
        archiveLicenses = @()
      },
      [ordered]@{
        name = 'ffmpeg'
        repository = 'yt-dlp/FFmpeg-Builds'
        # Monthly snapshots are retained upstream; never lock the rolling alias.
        releaseTag = 'autobuild-2026-07-31-16-16'
        assetName = 'ffmpeg-N-125875-g5d4d3bdc61-winarm64-gpl.zip'
        checksumAssetName = 'checksums.sha256'
        archive = 'zip'
        outputs = @('ffmpeg.exe', 'ffprobe.exe')
        licensePath = 'LICENSE'
        licenseFileName = 'ffmpeg-builds-LICENSE.txt'
        archiveLicenses = @(
          [ordered]@{
            archivePath = 'ffmpeg-N-125875-g5d4d3bdc61-winarm64-gpl/LICENSE.txt'
            fileName = 'ffmpeg-GPL-LICENSE.txt'
          }
        )
      },
      [ordered]@{
        name = 'yt-dlp'
        repository = 'yt-dlp/yt-dlp'
        assetName = 'yt-dlp_arm64.exe'
        checksumAssetName = 'SHA2-256SUMS'
        archive = 'file'
        outputs = @('yt-dlp.exe')
        licensePath = 'LICENSE'
        licenseFileName = 'yt-dlp-LICENSE.txt'
        archiveLicenses = @()
      }
    )
  }
)

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-UniqueAsset {
  param(
    [Parameter(Mandatory = $true)]$Release,
    [Parameter(Mandatory = $true)][string]$AssetName,
    [Parameter(Mandatory = $true)][string]$Repository
  )

  $matches = @($Release.assets | Where-Object { [string]$_.name -ceq $AssetName })
  if ($matches.Count -ne 1) {
    throw "A release de $Repository deve conter exatamente um asset chamado $AssetName."
  }
  return $matches[0]
}

function Get-AssetDigest {
  param(
    [Parameter(Mandatory = $true)]$Asset,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $digest = [string]$Asset.digest
  if ($digest -cnotmatch '^(?<algorithm>sha256):(?<hash>[0-9a-fA-F]{64})$') {
    throw "$Label não publicou digest SHA-256 na API oficial do GitHub."
  }
  return $Matches.hash.ToLowerInvariant()
}

function Save-OfficialAsset {
  param(
    [Parameter(Mandatory = $true)]$Asset,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  [long]$assetId = 0
  if (-not [long]::TryParse([string]$Asset.id, [ref]$assetId) -or $assetId -le 0) {
    throw "Asset sem ID numérico válido em $Repository."
  }
  $expectedUrl = "https://api.github.com/repos/$Repository/releases/assets/$assetId"
  if ([string]$Asset.url -cne $expectedUrl) {
    throw "URL inesperada para asset oficial de $Repository."
  }

  Invoke-WebRequest -UseBasicParsing -Headers $assetHeaders -Uri $expectedUrl -OutFile $Destination
}

function Get-PublishedChecksum {
  param(
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$AssetName
  )

  foreach ($match in [regex]::Matches($Content, '(?im)^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$')) {
    $publishedName = [IO.Path]::GetFileName($match.Groups[2].Value.Trim())
    if ($publishedName -ceq $AssetName) {
      return $match.Groups[1].Value.ToLowerInvariant()
    }
  }

  if ($Content.Contains($AssetName) -and
      $Content -match '(?im)^Hash\s*:\s*([0-9a-fA-F]{64})\s*$') {
    return $Matches[1].ToLowerInvariant()
  }

  throw "O checksum oficial não contém uma entrada inequívoca para $AssetName."
}

function Resolve-CommitSha {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Reference
  )

  $escapedReference = [Uri]::EscapeDataString($Reference)
  $commit = Invoke-RestMethod -Headers $apiHeaders -Uri "https://api.github.com/repos/$Repository/commits/$escapedReference"
  if ([string]$commit.sha -cnotmatch '^[0-9a-f]{40}$') {
    throw "Não foi possível fixar o commit da licença de $Repository."
  }
  return [string]$commit.sha
}

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
  $lockedTargets = @()
  foreach ($targetDefinition in $targetDefinitions) {
    $lockedSources = @()
    foreach ($definition in @($targetDefinition.sources)) {
      $repository = [string]$definition.repository
      $releaseEndpoint = if ($definition.Contains('releaseTag')) {
        $releaseTag = [string]$definition.releaseTag
        if ($releaseTag -cnotmatch '^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$') {
          throw "A release fixada de $repository possui tag inválida."
        }
        "https://api.github.com/repos/$repository/releases/tags/$([Uri]::EscapeDataString($releaseTag))"
      }
      else {
        "https://api.github.com/repos/$repository/releases/latest"
      }
      $release = Invoke-RestMethod -Headers $apiHeaders -Uri $releaseEndpoint
      if ([bool]$release.draft -or [bool]$release.prerelease) {
        throw "A release de $repository não é uma release estável."
      }
      if ([string]::IsNullOrWhiteSpace([string]$release.tag_name)) {
        throw "A release de $repository não possui tag."
      }
      if ($definition.Contains('releaseTag') -and
          [string]$release.tag_name -cne [string]$definition.releaseTag) {
        throw "A API não retornou a release fixada de $repository."
      }

      $asset = Get-UniqueAsset -Release $release -AssetName $definition.assetName -Repository $repository
      $assetDigest = Get-AssetDigest -Asset $asset -Label "$repository/$($definition.assetName)"
      [long]$assetId = [long]$asset.id
      [long]$assetSize = [long]$asset.size
      if ($assetSize -le 0) {
        throw "Asset vazio ou sem tamanho válido: $repository/$($definition.assetName)."
      }

      $checksumAsset = Get-UniqueAsset -Release $release -AssetName $definition.checksumAssetName -Repository $repository
      $checksumDigest = Get-AssetDigest -Asset $checksumAsset -Label "$repository/$($definition.checksumAssetName)"
      [long]$checksumAssetId = [long]$checksumAsset.id
      $checksumPath = Join-Path $tempRoot ("$($targetDefinition.rid)-$($definition.name)-checksum-$checksumAssetId.txt")
      if (-not (Test-Path -LiteralPath $checksumPath)) {
        Save-OfficialAsset -Asset $checksumAsset -Repository $repository -Destination $checksumPath
      }
      if ((Get-Sha256 -Path $checksumPath) -cne $checksumDigest) {
        throw "O próprio artefato de checksum de $repository não corresponde ao digest da API."
      }
      $checksumText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($checksumPath))
      $publishedDigest = Get-PublishedChecksum -Content $checksumText -AssetName $definition.assetName
      if ($publishedDigest -cne $assetDigest) {
        throw "Digest da API e checksum publicado divergem para $repository/$($definition.assetName)."
      }

      $commitReference = if ([string]$release.tag_name -ceq 'latest') {
        [string]$release.target_commitish
      } else {
        [string]$release.tag_name
      }
      $licenseCommit = Resolve-CommitSha -Repository $repository -Reference $commitReference
      $licenseUrl = "https://raw.githubusercontent.com/$repository/$licenseCommit/$($definition.licensePath)"
      $licensePath = Join-Path $tempRoot ("$($targetDefinition.rid)-$($definition.licenseFileName)")
      Invoke-WebRequest -UseBasicParsing -Headers $rawHeaders -Uri $licenseUrl -OutFile $licensePath
      $licenseDigest = Get-Sha256 -Path $licensePath

      $lockedSources += [ordered]@{
        name = [string]$definition.name
        repository = $repository
        version = [string]$release.tag_name
        assetName = [string]$definition.assetName
        assetId = $assetId
        url = "https://api.github.com/repos/$repository/releases/assets/$assetId"
        sha256 = $assetDigest
        size = $assetSize
        archive = [string]$definition.archive
        outputs = @($definition.outputs)
        archiveLicenses = @($definition.archiveLicenses)
        checksum = [ordered]@{
          assetName = [string]$definition.checksumAssetName
          assetId = $checksumAssetId
          url = "https://api.github.com/repos/$repository/releases/assets/$checksumAssetId"
          sha256 = $checksumDigest
        }
        license = [ordered]@{
          fileName = [string]$definition.licenseFileName
          url = $licenseUrl
          sha256 = $licenseDigest
        }
      }
    }
    $lockedTargets += [ordered]@{
      rid = [string]$targetDefinition.rid
      architecture = [string]$targetDefinition.architecture
      sources = @($lockedSources | Sort-Object { $_.name })
    }
  }

  $lock = [ordered]@{
    schemaVersion = 2
    generatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    targets = @($lockedTargets)
  }
  $json = ($lock | ConvertTo-Json -Depth 8) + [Environment]::NewLine
  $outputDirectory = Split-Path -Parent $OutputPath
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
  [IO.File]::WriteAllText($OutputPath, $json, [Text.UTF8Encoding]::new($false))
  Write-Host "Lock verificável gravado em $OutputPath"
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
