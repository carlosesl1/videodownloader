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

  Assert-PropertySet -Value $PayloadManifest -Expected @(
    'schemaVersion', 'generatedAt', 'targetRid', 'architecture', 'files'
  ) -Label 'package-manifest.json'
  if ([int]$PayloadManifest.schemaVersion -ne 2) {
    throw 'Versão incompatível de package-manifest.json.'
  }

  $targetRid = [string]$PayloadManifest.targetRid
  $architecture = [string]$PayloadManifest.architecture
  if (($targetRid -cne 'win-x64' -or $architecture -cne 'x64') -and
      ($targetRid -cne 'win-arm64' -or $architecture -cne 'arm64')) {
    throw 'Target ou arquitetura inválida em package-manifest.json.'
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

function Get-NativeWindowsArchitecture {
  foreach ($value in @($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE)) {
    if ([string]$value -ceq 'ARM64') { return 'arm64' }
    if ([string]$value -ceq 'AMD64') { return 'x64' }
  }
  throw 'A arquitetura nativa do Windows não é suportada.'
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
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "Assinatura PE inválida: $Path"
    }
    if ($reader.ReadUInt16() -ne $expectedMachine) {
      throw "O pacote contém executável de arquitetura diferente de $Architecture."
    }
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
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
    $pingTimeoutMilliseconds = 30000
    if (-not $process.WaitForExit($pingTimeoutMilliseconds)) {
      try {
        $process.Kill()
      }
      catch [System.InvalidOperationException] {
        # O processo encerrou entre o timeout e o Kill().
      }
      # WaitForExit(Int32) e Kill() existem no .NET Framework do PowerShell 5.1.
      [void]$process.WaitForExit(5000)
      throw 'O diagnóstico do auxiliar excedeu o limite de 30 segundos.'
    }
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

function Enter-InstallationLock {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $stream = [IO.File]::Open(
      $Path,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None)
  }
  catch [IO.IOException] {
    throw 'Outra instalação ou atualização do Vídeo Radar já está em andamento.'
  }

  try {
    $stream.SetLength(0)
    $content = [Text.Encoding]::UTF8.GetBytes(
      "process=$PID`nstartedAt=$([DateTimeOffset]::UtcNow.ToString('O'))`n")
    $stream.Write($content, 0, $content.Length)
    $stream.Flush($true)
    return $stream
  }
  catch {
    $stream.Dispose()
    throw
  }
}

function Enter-SetupMutex {
  param([Parameter(Mandatory = $true)][string]$Name)

  $createdNew = $false
  try {
    $mutex = [Threading.Mutex]::new($false, $Name, [ref]$createdNew)
  }
  catch {
    throw 'Não foi possível criar o lock compartilhado da instalação.'
  }
  if (-not $createdNew) {
    $mutex.Dispose()
    throw 'Outra instalação ou atualização do Vídeo Radar já está em andamento.'
  }
  return $mutex
}

function Assert-ExistingRuntimeComponents {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths
  )

  foreach ($relativePath in $RelativePaths) {
    $path = Join-Path $Root $relativePath
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "O componente instalado $relativePath não pode ser um link."
    }
    $mustBeDirectory = $relativePath -cne 'extension-id.txt'
    if ($mustBeDirectory -and -not $item.PSIsContainer) {
      throw "O componente instalado $relativePath deveria ser um diretório."
    }
    if (-not $mustBeDirectory -and $item.PSIsContainer) {
      throw "O componente instalado $relativePath deveria ser um arquivo."
    }
  }
}

function Move-RuntimeComponents {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths,
    [Parameter(Mandatory = $true)][Collections.Generic.List[string]]$Moved,
    [switch]$RequireAll
  )

  foreach ($relativePath in $RelativePaths) {
    $sourcePath = Join-Path $SourceRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath)) {
      if ($RequireAll) { throw "Componente de runtime ausente: $relativePath" }
      continue
    }
    $destinationPath = Join-Path $DestinationRoot $relativePath
    if (Test-Path -LiteralPath $destinationPath) {
      throw "O destino da troca de runtime já existe: $relativePath"
    }
    if (-not (Test-Path -LiteralPath $DestinationRoot)) {
      New-Item -ItemType Directory -Path $DestinationRoot | Out-Null
    }
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath
    $Moved.Add($relativePath)
  }
}

function Remove-DirectoryWithoutFollowingReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return }
  $rootItem = Get-Item -LiteralPath $Path -Force
  if (-not $rootItem.PSIsContainer -or
      ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'A raiz do backup desta transação não é um diretório físico.'
  }

  foreach ($entryPath in @([IO.Directory]::EnumerateFileSystemEntries($Path))) {
    $attributes = [IO.File]::GetAttributes($entryPath)
    $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
    $isReparsePoint = ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isDirectory -and -not $isReparsePoint) {
      Remove-DirectoryWithoutFollowingReparsePoints -Path $entryPath
    }
    elseif ($isDirectory) {
      # Exclui somente o link/junction, sem percorrer o destino.
      [IO.Directory]::Delete($entryPath, $false)
    }
    else {
      if (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
        [IO.File]::SetAttributes(
          $entryPath,
          $attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
        )
      }
      [IO.File]::Delete($entryPath)
    }
  }
  [IO.Directory]::Delete($Path, $false)
}

function Remove-TransactionBackup {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedParent
  )

  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullParent = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd(
    [IO.Path]::DirectorySeparatorChar
  )
  if ([IO.Path]::GetDirectoryName($fullPath) -cne $fullParent -or
      [IO.Path]::GetFileName($fullPath) -cnotmatch
        '^VideoRadar\.runtime-backup-[0-9a-f]{32}$') {
    throw 'O caminho do backup desta transação não é seguro para remoção.'
  }
  Remove-DirectoryWithoutFollowingReparsePoints -Path $fullPath
}

$installRoot = $null
$installStaging = $null
$installBackup = $null
$installLock = $null
$installLockPath = $null
$setupMutex = $null
$setupMutexName = 'Local\VideoRadarInstall-7A5C59C3-0DCE-4D0C-9BE1-5621E2AA4EA4'
$runtimeComponents = @('host', 'licenses', 'extension-id.txt', 'native-host')
$movedOldRuntime = [Collections.Generic.List[string]]::new()
$movedNewRuntime = [Collections.Generic.List[string]]::new()
$registryTouched = $false
$registrySnapshot = @()
$transactionCommitted = $false

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

  $nativeArchitecture = Get-NativeWindowsArchitecture
  if ([string]$packageManifest.architecture -cne $nativeArchitecture) {
    throw "Este pacote é $($packageManifest.architecture), mas o Windows é $nativeArchitecture. Baixe o pacote correto."
  }

  # Esta chamada termina a validação de todos os hashes antes da primeira cópia.
  $payload = @(Assert-PackagePayload -Root $PackageRoot -PayloadManifest $packageManifest)
  foreach ($relativePath in @(
    'host/video-radar-host.exe',
    'host/tools/deno.exe',
    'host/tools/ffmpeg.exe',
    'host/tools/ffprobe.exe',
    'host/tools/yt-dlp.exe'
  )) {
    $entry = @($payload | Where-Object { $_.relativePath -ceq $relativePath })
    if ($entry.Count -ne 1) {
      throw "Executável ausente no payload: $relativePath"
    }
    Assert-PeArchitecture -Path $entry[0].sourcePath -Architecture $nativeArchitecture
  }
  $extensionEntry = @($payload | Where-Object { $_.relativePath -ceq 'extension-id.txt' })
  if ($extensionEntry.Count -ne 1) {
    throw 'extension-id.txt não está no payload verificado.'
  }
  $extensionId = [IO.File]::ReadAllText($extensionEntry[0].sourcePath, [Text.Encoding]::UTF8).Trim()
  if ($extensionId -cnotmatch '^[a-p]{32}$') {
    throw 'O ID da extensão no pacote é inválido.'
  }

  # Inno Setup creates the same named mutex for its complete lifetime. Holding
  # this handle prevents the two installers from exchanging the runtime at once.
  $setupMutex = Enter-SetupMutex -Name $setupMutexName
  $installLockPath = Join-Path $localAppData 'VideoRadar.install.lock'
  $installLock = Enter-InstallationLock -Path $installLockPath
  $pendingSetupBackup = "$installRoot.runtime-backup"
  if (Test-Path -LiteralPath $pendingSetupBackup) {
    throw "Existe um rollback pendente do instalador em $pendingSetupBackup. Preserve-o para recuperação antes de continuar."
  }
  $installStaging = Join-Path $localAppData ('VideoRadar.runtime-installing-' + [Guid]::NewGuid().ToString('N'))
  $installBackup = Join-Path $localAppData ('VideoRadar.runtime-backup-' + [Guid]::NewGuid().ToString('N'))
  Copy-PackagePayload -Payload $payload -DestinationRoot $installStaging

  # A cópia em staging é verificada novamente antes de tocar no runtime ativo.
  [void]@(Assert-PackagePayload -Root $installStaging -PayloadManifest $packageManifest)

  $nativeManifestDirectory = Join-Path $installStaging 'native-host'
  New-Item -ItemType Directory -Path $nativeManifestDirectory -Force | Out-Null
  $expectedHostPath = Join-Path $installRoot 'host\video-radar-host.exe'
  $expectedOrigin = "chrome-extension://$extensionId/"
  $hostManifest = [ordered]@{
    name = 'com.videoradar.helper'
    description = 'Auxiliar local do Vídeo Radar'
    path = (Join-Path $installRoot 'host\video-radar-host.exe')
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
  }
  $manifestPath = Join-Path $installStaging 'native-host\com.videoradar.helper.json'
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
  ) -Label 'Manifesto nativo preparado'
  if ([string]$installedManifest.name -cne 'com.videoradar.helper' -or
      [string]$installedManifest.description -cne 'Auxiliar local do Vídeo Radar' -or
      [string]$installedManifest.path -cne $expectedHostPath -or
      [string]$installedManifest.type -cne 'stdio' -or
      @($installedManifest.allowed_origins).Count -ne 1 -or
      [string]$installedManifest.allowed_origins[0] -cne $expectedOrigin) {
    throw 'O manifesto nativo preparado não corresponde ao contrato esperado.'
  }
  Invoke-InstalledPing -HostPath (Join-Path $installStaging 'host\video-radar-host.exe')

  if (Test-Path -LiteralPath $installRoot) {
    if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
      throw 'A raiz de instalação existente não é um diretório.'
    }
    $installRootItem = Get-Item -LiteralPath $installRoot -Force
    if (($installRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'A raiz de instalação existente não pode ser um link.'
    }
    Assert-ExistingRuntimeComponents -Root $installRoot -RelativePaths $runtimeComponents
  }
  else {
    New-Item -ItemType Directory -Path $installRoot | Out-Null
  }

  # Somente estes quatro componentes são imutáveis. Fila, temporários, journals,
  # diagnósticos, Extension, conteúdo legal, onboarding e uninstaller nunca saem
  # de $installRoot durante um upgrade.
  Move-RuntimeComponents `
    -SourceRoot $installRoot `
    -DestinationRoot $installBackup `
    -RelativePaths $runtimeComponents `
    -Moved $movedOldRuntime
  Move-RuntimeComponents `
    -SourceRoot $installStaging `
    -DestinationRoot $installRoot `
    -RelativePaths $runtimeComponents `
    -Moved $movedNewRuntime `
    -RequireAll

  $manifestPath = Join-Path $installRoot 'native-host\com.videoradar.helper.json'
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  if ($manifestBytes.Length -ge 3 -and
      $manifestBytes[0] -eq 0xef -and $manifestBytes[1] -eq 0xbb -and $manifestBytes[2] -eq 0xbf) {
    throw 'O manifesto nativo foi gravado com BOM inesperado.'
  }
  $installedManifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  Assert-PropertySet -Value $installedManifest -Expected @(
    'name', 'description', 'path', 'type', 'allowed_origins'
  ) -Label 'Manifesto nativo instalado'
  if ([string]$installedManifest.name -cne 'com.videoradar.helper' -or
      [string]$installedManifest.description -cne 'Auxiliar local do Vídeo Radar' -or
      [string]$installedManifest.path -cne $expectedHostPath -or
      [string]$installedManifest.type -cne 'stdio' -or
      @($installedManifest.allowed_origins).Count -ne 1 -or
      [string]$installedManifest.allowed_origins[0] -cne $expectedOrigin) {
    throw 'O manifesto nativo instalado não corresponde ao contrato esperado.'
  }

  Invoke-InstalledPing -HostPath $expectedHostPath

  # Todos os itens válidos de staging foram movidos; a pasta deve estar vazia.
  [IO.Directory]::Delete($installStaging, $false)
  $installStaging = $null

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

  # O runtime novo já passou no ping e os quatro registros foram gravados. A
  # partir daqui a transação está confirmada e o backup desta execução pode ser
  # removido; uma falha de cleanup não deve tentar um rollback parcial.
  $transactionCommitted = $true
  if (Test-Path -LiteralPath $installBackup) {
    try {
      Remove-TransactionBackup -Path $installBackup -ExpectedParent $localAppData
      $movedOldRuntime.Clear()
      $installBackup = $null
    }
    catch {
      Write-Warning "A instalação foi concluída, mas o backup desta transação não pôde ser removido: $installBackup"
    }
  }

  Write-Host 'Vídeo Radar instalado com sucesso para Chrome, Edge, Brave e Vivaldi.'
  Write-Host "Manifesto nativo: $manifestPath"
  exit 0
}
catch {
  $failureMessage = $_.Exception.Message
  if ($transactionCommitted) {
    Write-Error "A instalação foi concluída, mas a finalização falhou. $failureMessage"
    exit 1
  }
  if ($registryTouched -and $registrySnapshot.Count -gt 0) {
    try {
      Restore-RegistrySnapshot -Snapshot $registrySnapshot
    }
    catch {
      $failureMessage = "$failureMessage A configuração dos navegadores pode exigir reparo."
    }
  }

  $rollbackErrors = [Collections.Generic.List[string]]::new()
  $failedRoot = if ($null -ne $installRoot) {
    Join-Path ([IO.Path]::GetDirectoryName($installRoot)) ('VideoRadar.runtime-failed-' + [Guid]::NewGuid().ToString('N'))
  } else { $null }
  foreach ($relativePath in $movedNewRuntime) {
    try {
      $newPath = Join-Path $installRoot $relativePath
      if (Test-Path -LiteralPath $newPath) {
        if (-not (Test-Path -LiteralPath $failedRoot)) {
          New-Item -ItemType Directory -Path $failedRoot | Out-Null
        }
        Move-Item -LiteralPath $newPath -Destination (Join-Path $failedRoot $relativePath)
      }
    }
    catch {
      $rollbackErrors.Add("não foi possível isolar $relativePath")
    }
  }
  foreach ($relativePath in $movedOldRuntime) {
    try {
      $backupPath = Join-Path $installBackup $relativePath
      $activePath = Join-Path $installRoot $relativePath
      if ((Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $activePath)) {
        Move-Item -LiteralPath $backupPath -Destination $activePath
      }
      elseif (Test-Path -LiteralPath $backupPath) {
        $rollbackErrors.Add("o runtime anterior de $relativePath permanece no backup")
      }
    }
    catch {
      $rollbackErrors.Add("não foi possível restaurar $relativePath")
    }
  }
  if ($null -ne $installStaging -and (Test-Path -LiteralPath $installStaging)) {
    try {
      $failedStaging = Join-Path ([IO.Path]::GetDirectoryName($installStaging)) ('VideoRadar.runtime-staging-failed-' + [Guid]::NewGuid().ToString('N'))
      Move-Item -LiteralPath $installStaging -Destination $failedStaging
    }
    catch {
      $rollbackErrors.Add('o staging validado não pôde ser isolado')
    }
  }
  if ($rollbackErrors.Count -gt 0) {
    $failureMessage = "$failureMessage O runtime anterior permanece preservado para recuperação: $($rollbackErrors -join '; ')."
  }

  Write-Error "A instalação não foi concluída. $failureMessage"
  exit 1
}
finally {
  if ($null -ne $installLock) {
    $installLock.Dispose()
  }
  if ($null -ne $setupMutex) {
    $setupMutex.Dispose()
  }
}
