[CmdletBinding()]
param(
  [ValidateSet('win-x64', 'win-arm64')]
  [string]$RuntimeIdentifier = 'win-x64',
  [string]$LockPath,
  [string]$CacheRoot,
  [string]$ReadyRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LockPath)) {
  $LockPath = Join-Path $projectRoot 'native-host\tool-lock.json'
}
if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
  $CacheRoot = Join-Path $projectRoot '.tools\native-cache'
}
if ([string]::IsNullOrWhiteSpace($ReadyRoot)) {
  $ReadyRoot = Join-Path $projectRoot ".tools\native-ready\$RuntimeIdentifier"
}
$LockPath = [IO.Path]::GetFullPath($LockPath)
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$ReadyRoot = [IO.Path]::GetFullPath($ReadyRoot)
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tools'))

$downloadHeaders = @{
  'User-Agent' = 'VideoRadar-NativeFetch/1.0'
  'Accept' = 'application/octet-stream'
  'X-GitHub-Api-Version' = '2022-11-28'
}

# Every pinned asset below belongs to a public upstream repository. Do not
# forward this repository's GITHUB_TOKEN across repository boundaries: a
# workflow installation token is scoped to Video Radar and is neither needed
# nor an appropriate credential for denoland/deno or yt-dlp/* downloads.

$targetArchitecture = if ($RuntimeIdentifier -ceq 'win-arm64') { 'arm64' } else { 'x64' }
$denoAssetName = if ($RuntimeIdentifier -ceq 'win-arm64') {
  'deno-aarch64-pc-windows-msvc.zip'
} else {
  'deno-x86_64-pc-windows-msvc.zip'
}
$ffmpegAssetName = if ($RuntimeIdentifier -ceq 'win-arm64') {
  'ffmpeg-N-125875-g5d4d3bdc61-winarm64-gpl.zip'
} else {
  'ffmpeg-N-125875-g5d4d3bdc61-win64-gpl.zip'
}
$ytDlpAssetName = if ($RuntimeIdentifier -ceq 'win-arm64') { 'yt-dlp_arm64.exe' } else { 'yt-dlp.exe' }

$expectedSources = @{
  'deno' = [ordered]@{
    repository = 'denoland/deno'
    assetName = $denoAssetName
    archive = 'zip'
    outputs = @('deno.exe')
    checksumAssetName = "$denoAssetName.sha256sum"
    licenseFileName = 'deno-LICENSE.md'
    licensePath = 'LICENSE.md'
    archiveLicenses = @()
  }
  'ffmpeg' = [ordered]@{
    repository = 'yt-dlp/FFmpeg-Builds'
    assetName = $ffmpegAssetName
    archive = 'zip'
    outputs = @('ffmpeg.exe', 'ffprobe.exe')
    checksumAssetName = 'checksums.sha256'
    licenseFileName = 'ffmpeg-builds-LICENSE.txt'
    licensePath = 'LICENSE'
    archiveLicenses = @(
      [ordered]@{
        archivePath = ([IO.Path]::GetFileNameWithoutExtension($ffmpegAssetName) + '/LICENSE.txt')
        fileName = 'ffmpeg-GPL-LICENSE.txt'
      }
    )
  }
  'yt-dlp' = [ordered]@{
    repository = 'yt-dlp/yt-dlp'
    assetName = $ytDlpAssetName
    archive = 'file'
    outputs = @('yt-dlp.exe')
    checksumAssetName = 'SHA2-256SUMS'
    licenseFileName = 'yt-dlp-LICENSE.txt'
    licensePath = 'LICENSE'
    archiveLicenses = @()
  }
}

function Assert-PropertySet {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $actualNames = @($Value.PSObject.Properties.Name | Sort-Object)
  $expectedNames = @($Expected | Sort-Object)
  if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) {
    throw "$Label possui campos inesperados ou ausentes."
  }
}

function Convert-HexToBytes {
  param([Parameter(Mandatory = $true)][string]$Hex)
  if ($Hex -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Digest SHA-256 inválido.'
  }
  $bytes = [byte[]]::new(32)
  for ($index = 0; $index -lt 32; $index++) {
    $bytes[$index] = [Convert]::ToByte($Hex.Substring($index * 2, 2), 16)
  }
  return $bytes
}

function Test-HexDigestEqual {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Actual
  )

  $expectedBytes = Convert-HexToBytes -Hex $Expected
  $actualBytes = Convert-HexToBytes -Hex $Actual
  $cryptographicOperations = 'System.Security.Cryptography.CryptographicOperations' -as [type]
  if ($null -ne $cryptographicOperations) {
    return [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($expectedBytes, $actualBytes)
  }
  $difference = 0
  for ($index = 0; $index -lt $expectedBytes.Length; $index++) {
    $difference = $difference -bor ($expectedBytes[$index] -bxor $actualBytes[$index])
  }
  return $difference -eq 0
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-FileIntegrity {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedHash,
    [long]$ExpectedSize = -1
  )

  $file = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($ExpectedSize -ge 0 -and $file.Length -ne $ExpectedSize) {
    throw "Tamanho inesperado em $($file.Name)."
  }
  $actualHash = Get-Sha256 -Path $file.FullName
  if (-not (Test-HexDigestEqual -Expected $ExpectedHash -Actual $actualHash)) {
    throw "SHA-256 inesperado em $($file.Name)."
  }
}

function Assert-PeArchitecture {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Architecture
  )

  $expectedMachine = if ($Architecture -ceq 'arm64') { 0xaa64 } else { 0x8664 }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) {
      throw "Executável PE inválido: $Path"
    }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 64 -or ($peOffset + 6) -gt $stream.Length) {
      throw "Cabeçalho PE fora dos limites: $Path"
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne $expectedMachine) {
      throw "Arquitetura PE incompatível em $Path. Esperado $Architecture."
    }
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Assert-SafeDirectoryTarget {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $volumeRoot = [IO.Path]::GetPathRoot($fullPath).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($fullPath) -or $fullPath -ceq $volumeRoot -or $fullPath -ceq $projectRoot) {
    throw "$Label aponta para um diretório amplo demais."
  }
}

function Get-VerifiedDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$ExpectedHash,
    [Parameter(Mandatory = $true)][string]$CacheName,
    [long]$ExpectedSize = -1
  )

  $cachePath = Join-Path $CacheRoot $CacheName
  if (Test-Path -LiteralPath $cachePath) {
    try {
      Assert-FileIntegrity -Path $cachePath -ExpectedHash $ExpectedHash -ExpectedSize $ExpectedSize
      return $cachePath
    }
    catch {
      Remove-Item -LiteralPath $cachePath -Force
    }
  }

  $partialPath = "$cachePath.partial-$([Guid]::NewGuid().ToString('N'))"
  try {
    Invoke-WebRequest -UseBasicParsing -Headers $downloadHeaders -Uri $Url -OutFile $partialPath
    Assert-FileIntegrity -Path $partialPath -ExpectedHash $ExpectedHash -ExpectedSize $ExpectedSize
    Move-Item -LiteralPath $partialPath -Destination $cachePath
  }
  finally {
    if (Test-Path -LiteralPath $partialPath) {
      Remove-Item -LiteralPath $partialPath -Force
    }
  }
  return $cachePath
}

function Assert-Source {
  param(
    [Parameter(Mandatory = $true)]$Source,
    [Parameter(Mandatory = $true)]$Expected
  )

  Assert-PropertySet -Value $Source -Expected @(
    'name', 'repository', 'version', 'assetName', 'assetId', 'url', 'sha256',
    'size', 'archive', 'outputs', 'archiveLicenses', 'checksum', 'license'
  ) -Label "Fonte $($Source.name)"
  Assert-PropertySet -Value $Source.checksum -Expected @(
    'assetName', 'assetId', 'url', 'sha256'
  ) -Label "Checksum de $($Source.name)"
  Assert-PropertySet -Value $Source.license -Expected @(
    'fileName', 'url', 'sha256'
  ) -Label "Licença de $($Source.name)"

  if ([string]$Source.repository -cne [string]$Expected.repository -or
      [string]$Source.assetName -cne [string]$Expected.assetName -or
      [string]$Source.archive -cne [string]$Expected.archive -or
      [string]$Source.checksum.assetName -cne [string]$Expected.checksumAssetName -or
      [string]$Source.license.fileName -cne [string]$Expected.licenseFileName) {
    throw "Metadados inesperados para $($Source.name)."
  }
  if ([string]::IsNullOrWhiteSpace([string]$Source.version)) {
    throw "Versão ausente em $($Source.name)."
  }
  if ((@($Source.outputs) -join "`n") -cne (@($Expected.outputs) -join "`n")) {
    throw "Outputs inesperados para $($Source.name)."
  }
  $archiveLicenses = @($Source.archiveLicenses)
  $expectedArchiveLicenses = @($Expected.archiveLicenses)
  if ($archiveLicenses.Count -ne $expectedArchiveLicenses.Count) {
    throw "Licenças internas inesperadas para $($Source.name)."
  }
  for ($index = 0; $index -lt $archiveLicenses.Count; $index++) {
    Assert-PropertySet -Value $archiveLicenses[$index] -Expected @(
      'archivePath', 'fileName'
    ) -Label "Licença interna de $($Source.name)"
    if ([string]$archiveLicenses[$index].archivePath -cne [string]$expectedArchiveLicenses[$index].archivePath -or
        [string]$archiveLicenses[$index].fileName -cne [string]$expectedArchiveLicenses[$index].fileName) {
      throw "Layout de licença interna inesperado para $($Source.name)."
    }
  }
  if ([string]$Source.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$Source.checksum.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$Source.license.sha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw "Digest inválido em $($Source.name)."
  }

  [long]$assetId = 0
  [long]$checksumAssetId = 0
  if (-not [long]::TryParse([string]$Source.assetId, [ref]$assetId) -or $assetId -le 0 -or
      -not [long]::TryParse([string]$Source.checksum.assetId, [ref]$checksumAssetId) -or $checksumAssetId -le 0 -or
      [long]$Source.size -le 0) {
    throw "ID ou tamanho inválido em $($Source.name)."
  }

  # O formato imutável termina em releases/assets/(?<assetId>\d+).
  $assetUrlPattern = '^https://api\.github\.com/repos/' + [regex]::Escape([string]$Expected.repository) + '/releases/assets/(?<assetId>\d+)$'
  if ([string]$Source.url -cnotmatch $assetUrlPattern -or [long]$Matches.assetId -ne $assetId) {
    throw "URL de asset inválida em $($Source.name)."
  }
  if ([string]$Source.checksum.url -cnotmatch $assetUrlPattern -or [long]$Matches.assetId -ne $checksumAssetId) {
    throw "URL de checksum inválida em $($Source.name)."
  }

  $licensePattern = '^https://raw\.githubusercontent\.com/' +
    [regex]::Escape([string]$Expected.repository) + '/(?<commit>[0-9a-f]{40})/' +
    [regex]::Escape([string]$Expected.licensePath) + '$'
  if ([string]$Source.license.url -cnotmatch $licensePattern) {
    throw "URL de licença não está fixada por commit em $($Source.name)."
  }
}

Assert-SafeDirectoryTarget -Path $CacheRoot -Label 'CacheRoot'
Assert-SafeDirectoryTarget -Path $ReadyRoot -Label 'ReadyRoot'
if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
  throw "Lock não encontrado: $LockPath"
}

$lock = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-PropertySet -Value $lock -Expected @('schemaVersion', 'generatedAt', 'targets') -Label 'Lock'
if ([int]$lock.schemaVersion -ne 2 -or @($lock.targets).Count -ne 2) {
  throw 'O lock deve usar schemaVersion 2 e conter exatamente dois targets.'
}
$targetRids = @($lock.targets | ForEach-Object { [string]$_.rid })
if (($targetRids -join "`n") -cne "win-x64`nwin-arm64") {
  throw 'Os targets do lock devem ser win-x64 e win-arm64, nessa ordem.'
}
$targetMatches = @($lock.targets | Where-Object { [string]$_.rid -ceq $RuntimeIdentifier })
if ($targetMatches.Count -ne 1) {
  throw "O lock deve conter exatamente um target $RuntimeIdentifier."
}
$target = $targetMatches[0]
Assert-PropertySet -Value $target -Expected @('rid', 'architecture', 'sources') -Label "Target $RuntimeIdentifier"
if ([string]$target.architecture -cne $targetArchitecture) {
  throw "A arquitetura do target $RuntimeIdentifier não corresponde ao RID."
}
$sourceNames = @($target.sources | ForEach-Object { [string]$_.name })
if (($sourceNames -join "`n") -cne "deno`nffmpeg`nyt-dlp") {
  throw 'As fontes do lock devem estar ordenadas e sem duplicatas.'
}

$validatedSources = @()
foreach ($source in @($target.sources)) {
  $name = [string]$source.name
  if (-not $expectedSources.ContainsKey($name)) {
    throw "Fonte não permitida: $name."
  }
  Assert-Source -Source $source -Expected $expectedSources[$name]
  $validatedSources += $source
}

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
$verifiedDownloads = @{}
foreach ($source in $validatedSources) {
  $assetCacheName = '{0}-{1}-{2}-{3}' -f @(
    [string]$source.name,
    [long]$source.assetId,
    [string]$source.sha256,
    [string]$source.assetName
  )
  $assetPath = Get-VerifiedDownload -Url $source.url -ExpectedHash $source.sha256 `
    -ExpectedSize ([long]$source.size) -CacheName $assetCacheName
  $licenseCacheName = '{0}-license-{1}-{2}' -f @(
    [string]$source.name,
    [string]$source.license.sha256,
    [string]$source.license.fileName
  )
  $licensePath = Get-VerifiedDownload -Url $source.license.url `
    -ExpectedHash $source.license.sha256 -CacheName $licenseCacheName
  $verifiedDownloads[[string]$source.name] = [pscustomobject]@{
    asset = $assetPath
    license = $licensePath
  }
}

# Nenhuma extração ou cópia para ready ocorre antes de todos os downloads acima passarem no hash.
$readyStaging = "$ReadyRoot.installing-$([Guid]::NewGuid().ToString('N'))"
$readyBackup = "$ReadyRoot.backup-$([Guid]::NewGuid().ToString('N'))"
$extractRoots = @()
$oldReadyMoved = $false
$newReadyMoved = $false
try {
  New-Item -ItemType Directory -Path $readyStaging -Force | Out-Null
  $licenseDirectory = Join-Path $readyStaging 'licenses'
  New-Item -ItemType Directory -Path $licenseDirectory -Force | Out-Null

  foreach ($source in $validatedSources) {
    $verified = $verifiedDownloads[[string]$source.name]
    if ([string]$source.archive -ceq 'file') {
      if (@($source.outputs).Count -ne 1) {
        throw "Layout de arquivo inválido em $($source.name)."
      }
      Copy-Item -LiteralPath $verified.asset -Destination (Join-Path $readyStaging $source.outputs[0])
    }
    else {
      $extractRoot = Join-Path $toolsRoot ('.native-extract-' + [string]$source.name + '-' + [Guid]::NewGuid().ToString('N'))
      $extractRoots += $extractRoot
      New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
      Expand-Archive -LiteralPath $verified.asset -DestinationPath $extractRoot
      foreach ($output in @($source.outputs)) {
        $matches = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File | Where-Object { $_.Name -ceq [string]$output })
        if ($matches.Count -ne 1) {
          throw "O archive de $($source.name) deve conter exatamente um $output."
        }
        Copy-Item -LiteralPath $matches[0].FullName -Destination (Join-Path $readyStaging $output)
      }
      foreach ($archiveLicense in @($source.archiveLicenses)) {
        $nativeArchivePath = ([string]$archiveLicense.archivePath).Replace('/', [IO.Path]::DirectorySeparatorChar)
        $archiveLicensePath = [IO.Path]::GetFullPath((Join-Path $extractRoot $nativeArchivePath))
        $extractPrefix = $extractRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $archiveLicensePath.StartsWith($extractPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $archiveLicensePath -PathType Leaf)) {
          throw "Licença interna ausente ou fora do archive de $($source.name)."
        }
        Copy-Item -LiteralPath $archiveLicensePath -Destination (Join-Path $licenseDirectory $archiveLicense.fileName)
      }
    }
    Copy-Item -LiteralPath $verified.license -Destination (Join-Path $licenseDirectory $source.license.fileName)
  }

  $expectedExecutables = @('deno.exe', 'ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe')
  $actualExecutables = @(Get-ChildItem -LiteralPath $readyStaging -File -Filter '*.exe' | Sort-Object Name | ForEach-Object { $_.Name })
  if (($actualExecutables -join "`n") -cne ($expectedExecutables -join "`n")) {
    throw 'O ready staging não contém exatamente os quatro executáveis esperados.'
  }
  foreach ($executable in $expectedExecutables) {
    Assert-PeArchitecture -Path (Join-Path $readyStaging $executable) -Architecture $targetArchitecture
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $ReadyRoot) -Force | Out-Null
  if (Test-Path -LiteralPath $ReadyRoot) {
    Move-Item -LiteralPath $ReadyRoot -Destination $readyBackup
    $oldReadyMoved = $true
  }
  Move-Item -LiteralPath $readyStaging -Destination $ReadyRoot
  $newReadyMoved = $true
  if ($oldReadyMoved) {
    Remove-Item -LiteralPath $readyBackup -Recurse -Force
    $oldReadyMoved = $false
  }
  Write-Host "Ferramentas verificadas em $ReadyRoot"
}
catch {
  if ($newReadyMoved -and (Test-Path -LiteralPath $ReadyRoot)) {
    Move-Item -LiteralPath $ReadyRoot -Destination "$ReadyRoot.failed-$([Guid]::NewGuid().ToString('N'))"
  }
  if ($oldReadyMoved -and (Test-Path -LiteralPath $readyBackup)) {
    Move-Item -LiteralPath $readyBackup -Destination $ReadyRoot
  }
  throw
}
finally {
  foreach ($extractRoot in $extractRoots) {
    if (Test-Path -LiteralPath $extractRoot) {
      Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }
  }
  if (Test-Path -LiteralPath $readyStaging) {
    Remove-Item -LiteralPath $readyStaging -Recurse -Force
  }
}
