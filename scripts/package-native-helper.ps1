[CmdletBinding()]
param(
  [string]$LockPath,
  [string]$CacheRoot,
  [string]$ReadyRoot,
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LockPath)) {
  $LockPath = Join-Path $projectRoot 'native-host\tool-lock.json'
}
if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
  $CacheRoot = Join-Path $projectRoot '.tools\native-cache'
}
if ([string]::IsNullOrWhiteSpace($ReadyRoot)) {
  $ReadyRoot = Join-Path $projectRoot '.tools\native-ready'
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $projectRoot 'dist\video-radar-helper'
}
$LockPath = [IO.Path]::GetFullPath($LockPath)
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$ReadyRoot = [IO.Path]::GetFullPath($ReadyRoot)
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$workRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tools\native-package'))

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

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-DerSubjectPublicKeyInfo {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  if ($Bytes.Length -lt 32 -or $Bytes[0] -ne 0x30) {
    throw 'manifest.key não é um DER SubjectPublicKeyInfo válido.'
  }
  $lengthByte = [int]$Bytes[1]
  $contentOffset = 2
  if (($lengthByte -band 0x80) -ne 0) {
    $lengthOctets = $lengthByte -band 0x7f
    if ($lengthOctets -lt 1 -or $lengthOctets -gt 4 -or $Bytes.Length -lt (2 + $lengthOctets)) {
      throw 'Comprimento DER inválido em manifest.key.'
    }
    $contentLength = 0
    for ($index = 0; $index -lt $lengthOctets; $index++) {
      $contentLength = ($contentLength -shl 8) -bor [int]$Bytes[2 + $index]
    }
    $contentOffset += $lengthOctets
  }
  else {
    $contentLength = $lengthByte
  }
  if (($contentOffset + $contentLength) -ne $Bytes.Length) {
    throw 'O DER de manifest.key possui bytes ausentes ou excedentes.'
  }

  $rsaOid = [byte[]](0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)
  $foundRsaOid = $false
  for ($offset = 0; $offset -le ($Bytes.Length - $rsaOid.Length); $offset++) {
    $equal = $true
    for ($part = 0; $part -lt $rsaOid.Length; $part++) {
      if ($Bytes[$offset + $part] -ne $rsaOid[$part]) {
        $equal = $false
        break
      }
    }
    if ($equal) {
      $foundRsaOid = $true
      break
    }
  }
  if (-not $foundRsaOid) {
    throw 'manifest.key não usa SubjectPublicKeyInfo RSA.'
  }
}

function Get-ExtensionId {
  param([Parameter(Mandatory = $true)][string]$ManifestPath)

  $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$manifest.key)) {
    throw 'manifest.json não contém uma chave estável.'
  }
  try {
    $publicKey = [Convert]::FromBase64String([string]$manifest.key)
  }
  catch {
    throw 'manifest.key não é Base64 válido.'
  }
  Assert-DerSubjectPublicKeyInfo -Bytes $publicKey

  $hashDataMethod = [Security.Cryptography.SHA256].GetMethod('HashData', [type[]]@([byte[]]))
  if ($null -ne $hashDataMethod) {
    $digest = [System.Security.Cryptography.SHA256]::HashData($publicKey)
  }
  else {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      $digest = $sha256.ComputeHash($publicKey)
    }
    finally {
      $sha256.Dispose()
    }
  }

  $builder = [Text.StringBuilder]::new(32)
  foreach ($byte in $digest[0..15]) {
    foreach ($nibble in @(($byte -shr 4), ($byte -band 0x0f))) {
      [void]$builder.Append([char]([int][char]'a' + $nibble))
    }
  }
  $extensionId = $builder.ToString()
  if ($extensionId -cnotmatch '^[a-p]{32}$') {
    throw 'Falha ao derivar o ID estável da extensão.'
  }
  return $extensionId
}

function Invoke-PingDiagnostic {
  param([Parameter(Mandatory = $true)][string]$HostPath)

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $HostPath
  $startInfo.Arguments = '--ping'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw 'O host empacotado não iniciou.'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    [void]$stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      throw 'O host empacotado rejeitou o diagnóstico.'
    }
    $lines = @($stdout -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -ne 1) {
      throw 'O host empacotado não retornou um único JSON de diagnóstico.'
    }
    try {
      $diagnostic = $lines[0] | ConvertFrom-Json
    }
    catch {
      throw 'O host empacotado retornou diagnóstico inválido.'
    }
    if ($diagnostic.ok -ne $true -or
        $diagnostic.tools.ytDlp -ne $true -or
        $diagnostic.tools.deno -ne $true -or
        $diagnostic.tools.ffmpeg -ne $true -or
        $diagnostic.tools.ffprobe -ne $true) {
      throw 'O host empacotado não encontrou todas as ferramentas.'
    }
  }
  finally {
    $process.Dispose()
  }
}

function New-PayloadEntry {
  param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "Caminho inválido no pacote: $RelativePath"
  }
  $nativeRelativePath = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
  $filePath = Join-Path $PackageRoot $nativeRelativePath
  $file = Get-Item -LiteralPath $filePath -ErrorAction Stop
  return [ordered]@{
    path = $RelativePath.Replace('\', '/')
    sha256 = Get-Sha256 -Path $file.FullName
    size = [long]$file.Length
  }
}

Assert-SafeDirectoryTarget -Path $ReadyRoot -Label 'ReadyRoot'
Assert-SafeDirectoryTarget -Path $OutputRoot -Label 'OutputRoot'

$fetchScript = Join-Path $projectRoot 'scripts\fetch-native-tools.ps1'
& $fetchScript -LockPath $LockPath -CacheRoot $CacheRoot -ReadyRoot $ReadyRoot

$lock = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedExecutables = @('deno.exe', 'ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe')
$expectedLicenseNames = @(
  'deno-LICENSE.md',
  'ffmpeg-builds-LICENSE.txt',
  'ffmpeg-GPL-LICENSE.txt',
  'yt-dlp-LICENSE.txt'
)
$actualExecutables = @(Get-ChildItem -LiteralPath $ReadyRoot -File -Filter '*.exe' | Sort-Object Name | ForEach-Object { $_.Name })
if (($actualExecutables -join "`n") -cne ($expectedExecutables -join "`n")) {
  throw 'O diretório ready não contém exatamente os quatro executáveis esperados.'
}
foreach ($source in @($lock.sources)) {
  $licensePath = Join-Path (Join-Path $ReadyRoot 'licenses') $source.license.fileName
  if ((Get-Sha256 -Path $licensePath) -cne [string]$source.license.sha256) {
    throw "Licença inválida para $($source.name)."
  }
}
$lockedLicenseNames = @(
  foreach ($source in @($lock.sources)) {
    [string]$source.license.fileName
    foreach ($archiveLicense in @($source.archiveLicenses)) {
      [string]$archiveLicense.fileName
    }
  }
)
$lockedLicenseNames = @($lockedLicenseNames | Sort-Object)
if (($lockedLicenseNames -join "`n") -cne ($expectedLicenseNames -join "`n")) {
  throw 'O lock não contém exatamente as quatro licenças esperadas.'
}
$actualLicenseNames = @(Get-ChildItem -LiteralPath (Join-Path $ReadyRoot 'licenses') -File | Sort-Object Name | ForEach-Object { $_.Name })
if (($actualLicenseNames -join "`n") -cne ($expectedLicenseNames -join "`n")) {
  throw 'O diretório ready não contém exatamente as quatro licenças esperadas.'
}

$publishRoot = Join-Path $workRoot ('publish-' + [Guid]::NewGuid().ToString('N'))
$packageStaging = "$OutputRoot.installing-$([Guid]::NewGuid().ToString('N'))"
$packageBackup = "$OutputRoot.backup-$([Guid]::NewGuid().ToString('N'))"
$oldPackageMoved = $false
$newPackageMoved = $false
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null
try {
  $dotnetScript = Join-Path $projectRoot 'scripts\dotnet.ps1'
  $hostProject = Join-Path $projectRoot 'native-host\VideoRadar.NativeHost\VideoRadar.NativeHost.csproj'
  & $dotnetScript publish $hostProject -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:PublishTrimmed=false -o $publishRoot
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish falhou com código $LASTEXITCODE."
  }

  $publishedHosts = @(Get-ChildItem -LiteralPath $publishRoot -File | Where-Object { $_.Name -ceq 'video-radar-host.exe' })
  if ($publishedHosts.Count -ne 1) {
    throw 'A publicação deve produzir exatamente um video-radar-host.exe.'
  }

  $hostDirectory = Join-Path $packageStaging 'host'
  $hostToolsDirectory = Join-Path $hostDirectory 'tools'
  $licenseDirectory = Join-Path $packageStaging 'licenses'
  $installerDirectory = Join-Path $packageStaging 'scripts'
  $nativeManifestDirectory = Join-Path $packageStaging 'native-host'
  foreach ($directory in @($hostToolsDirectory, $licenseDirectory, $installerDirectory, $nativeManifestDirectory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $packagedHost = Join-Path $hostDirectory 'video-radar-host.exe'
  Copy-Item -LiteralPath $publishedHosts[0].FullName -Destination $packagedHost
  foreach ($executable in $expectedExecutables) {
    Copy-Item -LiteralPath (Join-Path $ReadyRoot $executable) -Destination (Join-Path $hostToolsDirectory $executable)
  }
  foreach ($licenseName in $expectedLicenseNames) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $ReadyRoot 'licenses') $licenseName) `
      -Destination (Join-Path $licenseDirectory $licenseName)
  }

  Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\install-native-host.ps1') `
    -Destination (Join-Path $installerDirectory 'install-native-host.ps1')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'Instalar-Video-Radar.cmd') `
    -Destination (Join-Path $packageStaging 'Instalar-Video-Radar.cmd')

  $extensionId = Get-ExtensionId -ManifestPath (Join-Path $projectRoot 'manifest.json')
  [IO.File]::WriteAllText(
    (Join-Path $packageStaging 'extension-id.txt'),
    $extensionId,
    [Text.UTF8Encoding]::new($false)
  )

  $payloadPaths = @(
    'extension-id.txt',
    'host/video-radar-host.exe',
    'host/tools/deno.exe',
    'host/tools/ffmpeg.exe',
    'host/tools/ffprobe.exe',
    'host/tools/yt-dlp.exe'
  )
  foreach ($licenseName in $expectedLicenseNames) {
    $payloadPaths += 'licenses/' + $licenseName
  }
  $payloadEntries = @($payloadPaths | Sort-Object | ForEach-Object {
    New-PayloadEntry -PackageRoot $packageStaging -RelativePath $_
  })
  $packageManifest = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    files = $payloadEntries
  }
  $packageManifestJson = ($packageManifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine
  [IO.File]::WriteAllText(
    (Join-Path $packageStaging 'package-manifest.json'),
    $packageManifestJson,
    [Text.UTF8Encoding]::new($false)
  )

  Invoke-PingDiagnostic -HostPath $packagedHost

  New-Item -ItemType Directory -Path (Split-Path -Parent $OutputRoot) -Force | Out-Null
  if (Test-Path -LiteralPath $OutputRoot) {
    Move-Item -LiteralPath $OutputRoot -Destination $packageBackup
    $oldPackageMoved = $true
  }
  Move-Item -LiteralPath $packageStaging -Destination $OutputRoot
  $newPackageMoved = $true
  if ($oldPackageMoved) {
    Remove-Item -LiteralPath $packageBackup -Recurse -Force
    $oldPackageMoved = $false
  }
  Write-Host "Pacote criado em $OutputRoot"
  Write-Host "ID da extensão: $extensionId"
}
catch {
  if ($newPackageMoved -and (Test-Path -LiteralPath $OutputRoot)) {
    Move-Item -LiteralPath $OutputRoot -Destination "$OutputRoot.failed-$([Guid]::NewGuid().ToString('N'))"
  }
  if ($oldPackageMoved -and (Test-Path -LiteralPath $packageBackup)) {
    Move-Item -LiteralPath $packageBackup -Destination $OutputRoot
  }
  throw
}
finally {
  if (Test-Path -LiteralPath $publishRoot) {
    Remove-Item -LiteralPath $publishRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $packageStaging) {
    Remove-Item -LiteralPath $packageStaging -Recurse -Force
  }
}
