[CmdletBinding()]
param(
  [string]$PackageRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
  $PackageRoot = Split-Path -Parent $PSScriptRoot
}
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)

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
    throw 'Digest SHA-256 inválido no pacote.'
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

function Assert-NoReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  $current = $Root
  foreach ($segment in $RelativePath -split '[\\/]') {
    $current = Join-Path $current $segment
    $item = Get-Item -LiteralPath $current -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "O pacote contém um link não permitido em $RelativePath."
    }
  }
}

function Assert-PackagePayload {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)]$PayloadManifest
  )

  Assert-PropertySet -Value $PayloadManifest -Expected @('schemaVersion', 'generatedAt', 'files') -Label 'package-manifest.json'
  if ([int]$PayloadManifest.schemaVersion -ne 1) {
    throw 'Versão incompatível de package-manifest.json.'
  }

  $expectedPaths = @(
    'extension-id.txt',
    'host/tools/deno.exe',
    'host/tools/ffmpeg.exe',
    'host/tools/ffprobe.exe',
    'host/tools/yt-dlp.exe',
    'host/video-radar-host.exe',
    'licenses/deno-LICENSE.md',
    'licenses/ffmpeg-builds-LICENSE.txt',
    'licenses/ffmpeg-GPL-LICENSE.txt',
    'licenses/yt-dlp-LICENSE.txt'
  )
  $entries = @($PayloadManifest.files)
  if ($entries.Count -ne $expectedPaths.Count) {
    throw 'O manifesto do pacote não contém exatamente o payload esperado.'
  }

  $rootPrefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $seen = @{}
  $validated = @()
  foreach ($entry in $entries) {
    Assert-PropertySet -Value $entry -Expected @('path', 'sha256', 'size') -Label 'Entrada de payload'
    $relativePath = [string]$entry.path
    # Caminhos ../ e ..\ são recusados antes de qualquer cópia.
    if ([string]::IsNullOrWhiteSpace($relativePath) -or
        [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Contains(':') -or
        $relativePath -match '(^|[\\/])\.\.([\\/]|$)' -or
        $relativePath -match '(^|[\\/])\.([\\/]|$)') {
      throw "Caminho relativo inválido no pacote: $relativePath"
    }
    $normalizedRelativePath = $relativePath.Replace('\', '/')
    if ($seen.ContainsKey($normalizedRelativePath)) {
      throw "Caminho duplicado no pacote: $normalizedRelativePath"
    }
    $seen[$normalizedRelativePath] = $true

    $nativeRelativePath = $normalizedRelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $Root $nativeRelativePath))
    if (-not $sourcePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Caminho escapou da raiz do pacote: $relativePath"
    }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Arquivo ausente no pacote: $relativePath"
    }
    Assert-NoReparsePoint -Root $Root -RelativePath $nativeRelativePath

    [long]$expectedSize = 0
    if (-not [long]::TryParse([string]$entry.size, [ref]$expectedSize) -or $expectedSize -lt 0) {
      throw "Tamanho inválido no pacote: $relativePath"
    }
    $file = Get-Item -LiteralPath $sourcePath
    if ([long]$file.Length -ne $expectedSize) {
      throw "Tamanho divergente no pacote: $relativePath"
    }
    $expectedHash = [string]$entry.sha256
    if ($expectedHash -cnotmatch '^[0-9a-f]{64}$') {
      throw "SHA-256 inválido no pacote: $relativePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not (Test-HexDigestEqual -Expected $expectedHash -Actual $actualHash)) {
      throw "Falha de integridade no pacote: $relativePath"
    }
    $validated += [pscustomobject]@{
      relativePath = $normalizedRelativePath
      nativeRelativePath = $nativeRelativePath
      sourcePath = $sourcePath
      sha256 = $expectedHash
      size = $expectedSize
    }
  }

  $actualPaths = @($validated | Sort-Object relativePath | ForEach-Object { $_.relativePath })
  if (($actualPaths -join "`n") -cne ($expectedPaths -join "`n")) {
    throw 'O manifesto do pacote contém caminhos não permitidos.'
  }
  return $validated
}

function Copy-PackagePayload {
  param(
    [Parameter(Mandatory = $true)][object[]]$Payload,
    [Parameter(Mandatory = $true)][string]$DestinationRoot
  )

  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  foreach ($entry in $Payload) {
    $destinationPath = Join-Path $DestinationRoot $entry.nativeRelativePath
    $destinationDirectory = Split-Path -Parent $destinationPath
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $entry.sourcePath -Destination $destinationPath
  }
}

function Invoke-InstalledPing {
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
      throw 'O auxiliar instalado não iniciou.'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    [void]$stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      throw 'O auxiliar instalado falhou no diagnóstico.'
    }
    $lines = @($stdout -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -ne 1) {
      throw 'O auxiliar instalado não retornou um único JSON.'
    }
    try {
      $diagnostic = $lines[0] | ConvertFrom-Json
    }
    catch {
      throw 'O auxiliar instalado retornou diagnóstico inválido.'
    }
    if ($diagnostic.ok -ne $true -or
        $diagnostic.tools.ytDlp -ne $true -or
        $diagnostic.tools.deno -ne $true -or
        $diagnostic.tools.ffmpeg -ne $true -or
        $diagnostic.tools.ffprobe -ne $true) {
      throw 'O auxiliar instalado não encontrou todos os componentes.'
    }
  }
  finally {
    $process.Dispose()
  }
}

function Get-RegistrySnapshot {
  param([Parameter(Mandatory = $true)][string[]]$Keys)

  $snapshot = @()
  foreach ($key in $Keys) {
    $exists = Test-Path -Path $key
    $hasDefaultValue = $false
    $defaultValue = $null
    if ($exists) {
      $item = Get-Item -Path $key
      $hasDefaultValue = @($item.GetValueNames()) -ccontains ''
      if ($hasDefaultValue) {
        $defaultValue = $item.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      }
    }
    $snapshot += [pscustomobject]@{
      key = $key
      exists = $exists
      hasDefaultValue = $hasDefaultValue
      defaultValue = $defaultValue
    }
  }
  return $snapshot
}

function Restore-RegistrySnapshot {
  param([Parameter(Mandatory = $true)][object[]]$Snapshot)

  foreach ($record in $Snapshot) {
    if ($record.exists) {
      New-Item -Path $record.key -Force | Out-Null
      if ($record.hasDefaultValue) {
        Set-Item -Path $record.key -Value $record.defaultValue
      }
      else {
        (Get-Item -Path $record.key).DeleteValue('', $false)
      }
    }
    elseif (Test-Path -Path $record.key) {
      Remove-Item -Path $record.key -Force
    }
  }
}

$installRoot = $null
$installStaging = $null
$installBackup = $null
$oldInstallMoved = $false
$newInstallMoved = $false
$registryTouched = $false
$registrySnapshot = @()

try {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
      -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA não aponta para um diretório absoluto.'
  }
  $localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($localAppData -ceq [IO.Path]::GetPathRoot($localAppData).TrimEnd([IO.Path]::DirectorySeparatorChar)) {
    throw 'LOCALAPPDATA aponta para um diretório amplo demais.'
  }
  $installRoot = Join-Path $env:LOCALAPPDATA 'VideoRadar'
  $installRoot = [IO.Path]::GetFullPath($installRoot)
  if ([IO.Path]::GetDirectoryName($installRoot) -cne $localAppData -or
      [IO.Path]::GetFileName($installRoot) -cne 'VideoRadar') {
    throw 'A raiz de instalação não é a esperada.'
  }

  $packageManifestPath = Join-Path $PackageRoot 'package-manifest.json'
  if (-not (Test-Path -LiteralPath $packageManifestPath -PathType Leaf)) {
    throw 'package-manifest.json não foi encontrado ao lado do instalador.'
  }
  $packageManifest = Get-Content -LiteralPath $packageManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

  # Esta chamada termina a validação de todos os hashes antes da primeira cópia.
  $payload = @(Assert-PackagePayload -Root $PackageRoot -PayloadManifest $packageManifest)
  $extensionEntry = @($payload | Where-Object { $_.relativePath -ceq 'extension-id.txt' })
  if ($extensionEntry.Count -ne 1) {
    throw 'extension-id.txt não está no payload verificado.'
  }
  $extensionId = [IO.File]::ReadAllText($extensionEntry[0].sourcePath, [Text.Encoding]::UTF8).Trim()
  if ($extensionId -cnotmatch '^[a-p]{32}$') {
    throw 'O ID da extensão no pacote é inválido.'
  }

  $installStaging = Join-Path $localAppData ('VideoRadar.installing-' + [Guid]::NewGuid().ToString('N'))
  $installBackup = Join-Path $localAppData ('VideoRadar.backup-' + [Guid]::NewGuid().ToString('N'))
  Copy-PackagePayload -Payload $payload -DestinationRoot $installStaging

  # A cópia em staging é verificada novamente antes da troca atômica.
  [void]@(Assert-PackagePayload -Root $installStaging -PayloadManifest $packageManifest)

  if (Test-Path -LiteralPath $installRoot) {
    if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
      throw 'A raiz de instalação existente não é um diretório.'
    }
    Move-Item -LiteralPath $installRoot -Destination $installBackup
    $oldInstallMoved = $true
  }
  Move-Item -LiteralPath $installStaging -Destination $installRoot
  $newInstallMoved = $true

  $nativeManifestDirectory = Join-Path $installRoot 'native-host'
  New-Item -ItemType Directory -Path $nativeManifestDirectory -Force | Out-Null
  $hostManifest = [ordered]@{
    name = 'com.videoradar.helper'
    description = 'Auxiliar local do Vídeo Radar'
    path = (Join-Path $installRoot 'host\video-radar-host.exe')
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
  }
  $manifestPath = Join-Path $installRoot 'native-host\com.videoradar.helper.json'
  $manifestJson = $hostManifest | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($manifestPath, $manifestJson, [Text.UTF8Encoding]::new($false))

  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  if ($manifestBytes.Length -ge 3 -and
      $manifestBytes[0] -eq 0xef -and $manifestBytes[1] -eq 0xbb -and $manifestBytes[2] -eq 0xbf) {
    throw 'O manifesto nativo foi gravado com BOM inesperado.'
  }
  $installedManifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  Assert-PropertySet -Value $installedManifest -Expected @(
    'name', 'description', 'path', 'type', 'allowed_origins'
  ) -Label 'Manifesto nativo instalado'
  $expectedHostPath = Join-Path $installRoot 'host\video-radar-host.exe'
  $expectedOrigin = "chrome-extension://$extensionId/"
  if ([string]$installedManifest.name -cne 'com.videoradar.helper' -or
      [string]$installedManifest.description -cne 'Auxiliar local do Vídeo Radar' -or
      [string]$installedManifest.path -cne $expectedHostPath -or
      [string]$installedManifest.type -cne 'stdio' -or
      @($installedManifest.allowed_origins).Count -ne 1 -or
      [string]$installedManifest.allowed_origins[0] -cne $expectedOrigin) {
    throw 'O manifesto nativo instalado não corresponde ao contrato esperado.'
  }

  Invoke-InstalledPing -HostPath $expectedHostPath

  $registryKeys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.videoradar.helper',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.videoradar.helper',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videoradar.helper',
    'HKCU:\Software\Vivaldi\NativeMessagingHosts\com.videoradar.helper'
  )
  $registrySnapshot = @(Get-RegistrySnapshot -Keys $registryKeys)
  $registryTouched = $true
  foreach ($key in $registryKeys) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifestPath
  }

  Write-Host 'Vídeo Radar instalado com sucesso para Chrome, Edge, Brave e Vivaldi.'
  Write-Host "Manifesto nativo: $manifestPath"
  if ($oldInstallMoved) {
    Write-Host "Cópia anterior preservada em: $installBackup"
  }
  exit 0
}
catch {
  $failureMessage = $_.Exception.Message
  if ($registryTouched -and $registrySnapshot.Count -gt 0) {
    try {
      Restore-RegistrySnapshot -Snapshot $registrySnapshot
    }
    catch {
      $failureMessage = "$failureMessage A configuração dos navegadores pode exigir reparo."
    }
  }

  try {
    if ($newInstallMoved -and $null -ne $installRoot -and (Test-Path -LiteralPath $installRoot)) {
      $failedRoot = Join-Path ([IO.Path]::GetDirectoryName($installRoot)) ('VideoRadar.failed-' + [Guid]::NewGuid().ToString('N'))
      Move-Item -LiteralPath $installRoot -Destination $failedRoot
    }
    elseif ($null -ne $installStaging -and (Test-Path -LiteralPath $installStaging)) {
      $failedStaging = Join-Path ([IO.Path]::GetDirectoryName($installStaging)) ('VideoRadar.failed-' + [Guid]::NewGuid().ToString('N'))
      Move-Item -LiteralPath $installStaging -Destination $failedStaging
    }
    if ($oldInstallMoved -and $null -ne $installBackup -and (Test-Path -LiteralPath $installBackup)) {
      Move-Item -LiteralPath $installBackup -Destination $installRoot
    }
  }
  catch {
    $failureMessage = "$failureMessage A cópia anterior permanece preservada para recuperação."
  }

  Write-Error "A instalação não foi concluída. $failureMessage"
  exit 1
}
