[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture,
  [ValidateRange(5, 120)][int]$ToolTimeoutSeconds = 30,
  [ValidateRange(30, 600)][int]$InstallerTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Architecture = $Architecture.ToLowerInvariant()
$architectureLabel = $Architecture.ToUpperInvariant()
$expectedOsArchitecture = if ($Architecture -ceq 'arm64') { 'Arm64' } else { 'X64' }
$expectedPeMachine = if ($Architecture -ceq 'arm64') { 0xaa64 } else { 0x8664 }
$targetRid = "win-$Architecture"

function Assert-File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label não foi encontrado: $Path"
  }
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-File -Path $FilePath -Label $Label
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) {
    [void]$startInfo.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "$Label não iniciou."
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        $process.Kill($true)
        [void]$process.WaitForExit(5000)
      }
      catch {
        Write-Warning "Não foi possível encerrar a árvore de $Label após o timeout."
      }
      throw "$Label excedeu o limite de $TimeoutSeconds segundos."
    }
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout.Length -gt 262144 -or $stderr.Length -gt 262144) {
      throw "$Label produziu saída excessiva."
    }
    if ($process.ExitCode -ne 0) {
      $safeError = ($stderr -replace '[\r\n]+', ' ').Trim()
      if ($safeError.Length -gt 300) {
        $safeError = $safeError.Substring(0, 300)
      }
      throw "$Label terminou com código $($process.ExitCode). $safeError"
    }
    return [pscustomobject]@{
      stdout = $stdout
      stderr = $stderr
    }
  }
  finally {
    $process.Dispose()
  }
}

function Assert-OutputPattern {
  param(
    [Parameter(Mandatory = $true)]$Result,
    [Parameter(Mandatory = $true)][string]$Pattern,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $combined = ([string]$Result.stdout) + "`n" + ([string]$Result.stderr)
  if ($combined -cnotmatch $Pattern) {
    throw "$Label não retornou a identificação de versão esperada."
  }
}

function Assert-PeArchitecture {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-File -Path $Path -Label $Label
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) {
      throw "$Label não é um executável PE válido."
    }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 64 -or ($peOffset + 6) -gt $stream.Length) {
      throw "$Label tem cabeçalho PE fora dos limites."
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550 -or
        $reader.ReadUInt16() -ne $expectedPeMachine) {
      throw "$Label não é $architectureLabel nativo."
    }
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Invoke-NativeToolSmoke {
  param(
    [Parameter(Mandatory = $true)][string]$HostRoot,
    [Parameter(Mandatory = $true)][string]$LabelPrefix
  )

  $hostPath = Join-Path $HostRoot 'video-radar-host.exe'
  $toolsRoot = Join-Path $HostRoot 'tools'
  foreach ($nativeExecutable in @(
    $hostPath,
    (Join-Path $toolsRoot 'deno.exe'),
    (Join-Path $toolsRoot 'ffmpeg.exe'),
    (Join-Path $toolsRoot 'ffprobe.exe'),
    (Join-Path $toolsRoot 'yt-dlp.exe')
  )) {
    Assert-PeArchitecture -Path $nativeExecutable `
      -Label "$LabelPrefix $([IO.Path]::GetFileName($nativeExecutable))"
  }
  $ping = Invoke-CheckedProcess -FilePath $hostPath -Arguments @('--ping') `
    -WorkingDirectory $HostRoot -TimeoutSeconds $ToolTimeoutSeconds `
    -Label "$LabelPrefix host --ping"
  $pingLines = @($ping.stdout -split '\r?\n' | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
  })
  if ($pingLines.Count -ne 1) {
    throw "$LabelPrefix host --ping não retornou um único JSON."
  }
  try {
    $diagnostic = $pingLines[0] | ConvertFrom-Json
  }
  catch {
    throw "$LabelPrefix host --ping retornou JSON inválido."
  }
  if ($diagnostic.ok -ne $true -or
      [string]$diagnostic.host -cne 'com.videoradar.helper' -or
      [int]$diagnostic.protocolVersion -ne 5 -or
      $diagnostic.tools.ytDlp -ne $true -or
      $diagnostic.tools.deno -ne $true -or
      $diagnostic.tools.ffmpeg -ne $true -or
      $diagnostic.tools.ffprobe -ne $true) {
    throw "$LabelPrefix host --ping não confirmou o contrato e todas as ferramentas."
  }

  $deno = Invoke-CheckedProcess -FilePath (Join-Path $toolsRoot 'deno.exe') `
    -Arguments @('--version') -WorkingDirectory $toolsRoot `
    -TimeoutSeconds $ToolTimeoutSeconds -Label "$LabelPrefix deno --version"
  Assert-OutputPattern -Result $deno -Pattern '(?m)^deno\s+\d' `
    -Label "$LabelPrefix deno --version"

  $ffmpeg = Invoke-CheckedProcess -FilePath (Join-Path $toolsRoot 'ffmpeg.exe') `
    -Arguments @('-version') -WorkingDirectory $toolsRoot `
    -TimeoutSeconds $ToolTimeoutSeconds -Label "$LabelPrefix ffmpeg -version"
  Assert-OutputPattern -Result $ffmpeg -Pattern '(?m)^ffmpeg version\s+\S+' `
    -Label "$LabelPrefix ffmpeg -version"

  $ffprobe = Invoke-CheckedProcess -FilePath (Join-Path $toolsRoot 'ffprobe.exe') `
    -Arguments @('-version') -WorkingDirectory $toolsRoot `
    -TimeoutSeconds $ToolTimeoutSeconds -Label "$LabelPrefix ffprobe -version"
  Assert-OutputPattern -Result $ffprobe -Pattern '(?m)^ffprobe version\s+\S+' `
    -Label "$LabelPrefix ffprobe -version"

  $ytDlp = Invoke-CheckedProcess -FilePath (Join-Path $toolsRoot 'yt-dlp.exe') `
    -Arguments @('--version') -WorkingDirectory $toolsRoot `
    -TimeoutSeconds $ToolTimeoutSeconds -Label "$LabelPrefix yt-dlp --version"
  Assert-OutputPattern -Result $ytDlp -Pattern '(?m)^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?\s*$' `
    -Label "$LabelPrefix yt-dlp --version"
}

function Expand-ValidatedZip {
  param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Path $Destination | Out-Null
  $destinationRoot = [IO.Path]::GetFullPath($Destination)
  $destinationPrefix = $destinationRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) +
    [IO.Path]::DirectorySeparatorChar
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt 4096) {
      throw "O ZIP $architectureLabel tem uma quantidade inválida de entradas."
    }
    [long]$expandedSize = 0
    foreach ($entry in $archive.Entries) {
      $entryName = $entry.FullName.Replace('\', '/')
      $segments = @($entryName -split '/')
      if ([string]::IsNullOrWhiteSpace($entryName) -or
          $entryName.StartsWith('/', [StringComparison]::Ordinal) -or
          $entryName.Contains(':') -or
          @($segments | Where-Object { $_ -ceq '.' -or $_ -ceq '..' }).Count -gt 0 -or
          -not $seen.Add($entryName)) {
        throw "O ZIP $architectureLabel contém caminho inseguro ou duplicado: $entryName"
      }
      $expandedSize += [long]$entry.Length
      if ($expandedSize -gt 2147483648) {
        throw "O ZIP $architectureLabel excede o limite expandido de 2 GiB."
      }

      $relativePath = $entryName.Replace('/', [IO.Path]::DirectorySeparatorChar)
      $destinationPath = [IO.Path]::GetFullPath((Join-Path $destinationRoot $relativePath))
      if (-not $destinationPath.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Entrada do ZIP $architectureLabel escapou da raiz: $entryName"
      }
      if ($entryName.EndsWith('/', [StringComparison]::Ordinal)) {
        New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
        continue
      }
      $parent = Split-Path -Parent $destinationPath
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destinationPath, $false)
    }
  }
  finally {
    $archive.Dispose()
  }

  foreach ($item in @(Get-ChildItem -LiteralPath $destinationRoot -Recurse -Force)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "O ZIP $architectureLabel extraiu um reparse point não permitido: $($item.FullName)"
    }
  }
}

function Assert-SameFile {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Actual,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-File -Path $Expected -Label "$Label no ZIP"
  Assert-File -Path $Actual -Label "$Label instalado"
  $expectedItem = Get-Item -LiteralPath $Expected
  $actualItem = Get-Item -LiteralPath $Actual
  if ($expectedItem.Length -ne $actualItem.Length -or
      (Get-FileHash -LiteralPath $Expected -Algorithm SHA256).Hash -cne
      (Get-FileHash -LiteralPath $Actual -Algorithm SHA256).Hash) {
    throw "$Label instalado diverge do ZIP $architectureLabel do mesmo artifact."
  }
}

function Get-RegistryBase {
  return [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry64
  )
}

function Assert-RegistryAbsent {
  param([Parameter(Mandatory = $true)][string[]]$Subkeys)

  $base = Get-RegistryBase
  try {
    foreach ($subkey in $Subkeys) {
      $key = $base.OpenSubKey($subkey, $false)
      if ($null -ne $key) {
        $key.Dispose()
        throw "O runner $architectureLabel não está limpo; registro já existente: HKCU\$subkey"
      }
    }
  }
  finally {
    $base.Dispose()
  }
}

function Assert-InstalledRegistry {
  param(
    [Parameter(Mandatory = $true)][string[]]$Subkeys,
    [Parameter(Mandatory = $true)][string]$ExpectedManifest
  )

  $base = Get-RegistryBase
  try {
    foreach ($subkey in $Subkeys) {
      $key = $base.OpenSubKey($subkey, $false)
      if ($null -eq $key) {
        throw "Registro nativo ausente após instalar: HKCU\$subkey"
      }
      try {
        $value = [string]$key.GetValue(
          '',
          $null,
          [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
        )
        if ($value -cne $ExpectedManifest) {
          throw "Registro nativo aponta para caminho inesperado: HKCU\$subkey"
        }
      }
      finally {
        $key.Dispose()
      }
    }
  }
  finally {
    $base.Dispose()
  }
}

function Assert-UninstallRegistry {
  param(
    [Parameter(Mandatory = $true)][string]$Subkey,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$ExpectedInstallRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedUninstaller
  )

  $base = Get-RegistryBase
  try {
    $key = $base.OpenSubKey($Subkey, $false)
    if ($null -eq $key) {
      throw "Registro do desinstalador ausente: HKCU\$Subkey"
    }
    try {
      $displayVersion = [string]$key.GetValue('DisplayVersion')
      $installLocation = ([string]$key.GetValue('InstallLocation')).TrimEnd('\')
      $uninstallString = ([string]$key.GetValue('UninstallString')).Trim().Trim('"')
      if ($displayVersion -cne $ExpectedVersion -or
          $installLocation -cne $ExpectedInstallRoot.TrimEnd('\') -or
          $uninstallString -cne $ExpectedUninstaller) {
        throw "O registro do desinstalador $architectureLabel não corresponde à instalação isolada."
      }
    }
    finally {
      $key.Dispose()
    }
  }
  finally {
    $base.Dispose()
  }
}

function Remove-OwnedRegistry {
  param(
    [Parameter(Mandatory = $true)][string[]]$Subkeys,
    [Parameter(Mandatory = $true)][string]$ExpectedManifest
  )

  $base = Get-RegistryBase
  try {
    foreach ($subkey in $Subkeys) {
      $key = $base.OpenSubKey($subkey, $false)
      if ($null -eq $key) { continue }
      try {
        $value = [string]$key.GetValue(
          '',
          $null,
          [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
        )
      }
      finally {
        $key.Dispose()
      }
      if ($value -ceq $ExpectedManifest) {
        $base.DeleteSubKeyTree($subkey, $false)
      }
    }
  }
  finally {
    $base.Dispose()
  }
}

function Remove-OwnedUninstallRegistry {
  param(
    [Parameter(Mandatory = $true)][string]$Subkey,
    [Parameter(Mandatory = $true)][string]$ExpectedInstallRoot
  )

  $base = Get-RegistryBase
  try {
    $key = $base.OpenSubKey($Subkey, $false)
    if ($null -eq $key) { return }
    try {
      $installLocation = ([string]$key.GetValue('InstallLocation')).TrimEnd('\')
    }
    finally {
      $key.Dispose()
    }
    if ($installLocation -ceq $ExpectedInstallRoot.TrimEnd('\')) {
      $base.DeleteSubKeyTree($Subkey, $false)
    }
  }
  finally {
    $base.Dispose()
  }
}

if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [Runtime.InteropServices.OSPlatform]::Windows)) {
  throw "O smoke de release $architectureLabel exige Windows."
}
$actualOsArchitecture = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($actualOsArchitecture -cne $expectedOsArchitecture) {
  throw "O smoke de release $architectureLabel exige Windows $architectureLabel nativo."
}
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
  throw 'Este smoke instala e remove o produto; execute-o somente no runner GitHub-hosted isolado.'
}
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
    -not [IO.Path]::IsPathRooted($env:RUNNER_TEMP)) {
  throw 'RUNNER_TEMP não aponta para um diretório absoluto.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') `
  -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$packageJson.version
if ($version -cnotmatch '^\d+\.\d+\.\d+$') {
  throw 'package.json não contém uma versão estável.'
}
$ArtifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
if (-not (Test-Path -LiteralPath $ArtifactRoot -PathType Container)) {
  throw "A raiz do artifact não existe: $ArtifactRoot"
}
$developerZip = Join-Path $ArtifactRoot "VideoRadar-$version-Developer-Windows-$Architecture.zip"
$setupPath = Join-Path $ArtifactRoot "VideoRadar-Setup-$version-Windows-$Architecture.exe"
Assert-File -Path $developerZip -Label "ZIP Developer $architectureLabel exato"
Assert-File -Path $setupPath -Label "Setup $architectureLabel exato"

$registrySubkeys = @(
  'Software\Google\Chrome\NativeMessagingHosts\com.videoradar.helper',
  'Software\Microsoft\Edge\NativeMessagingHosts\com.videoradar.helper',
  'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videoradar.helper',
  'Software\Vivaldi\NativeMessagingHosts\com.videoradar.helper'
)
Assert-RegistryAbsent -Subkeys $registrySubkeys
$uninstallSubkey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7A5C59C3-0DCE-4D0C-9BE1-5621E2AA4EA4}_is1'
Assert-RegistryAbsent -Subkeys @($uninstallSubkey)

$smokeRoot = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) `
  ("video-radar-$Architecture-release-smoke-" + [Guid]::NewGuid().ToString('N'))
$extractRoot = Join-Path $smokeRoot 'developer'
$installRoot = Join-Path $smokeRoot 'installed'
$installLog = Join-Path $smokeRoot 'setup.log'
$uninstallLog = Join-Path $smokeRoot 'uninstall.log'
$installedManifestPath = Join-Path $installRoot 'native-host\com.videoradar.helper.json'
$uninstalled = $false
New-Item -ItemType Directory -Path $smokeRoot | Out-Null

try {
  Expand-ValidatedZip -ZipPath $developerZip -Destination $extractRoot
  $developerHelper = Join-Path $extractRoot 'Helper'
  $developerManifestPath = Join-Path $developerHelper 'package-manifest.json'
  Assert-File -Path $developerManifestPath -Label "package-manifest.json $architectureLabel"
  $developerManifest = Get-Content -LiteralPath $developerManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  if ([int]$developerManifest.schemaVersion -ne 2 -or
      [string]$developerManifest.targetRid -cne $targetRid -or
      [string]$developerManifest.architecture -cne $Architecture) {
    throw "O ZIP Developer baixado não declara um payload $targetRid válido."
  }
  Invoke-NativeToolSmoke -HostRoot (Join-Path $developerHelper 'host') `
    -LabelPrefix "ZIP $architectureLabel"

  $setupArguments = @(
    '/SP-',
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/NOCANCEL',
    '/NOICONS',
    "/DIR=$installRoot",
    "/LOG=$installLog"
  )
  [void](Invoke-CheckedProcess -FilePath $setupPath -Arguments $setupArguments `
    -WorkingDirectory $ArtifactRoot -TimeoutSeconds $InstallerTimeoutSeconds `
    -Label "Setup $architectureLabel silencioso")

  $buildInfoPath = Join-Path $installRoot 'build-info.json'
  Assert-File -Path $buildInfoPath -Label 'build-info.json instalado'
  $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$buildInfo.version -cne $version -or
      [string]$buildInfo.targetRid -cne $targetRid -or
      [string]$buildInfo.architecture -cne $Architecture) {
    throw "O Setup $architectureLabel instalou build-info.json incompatível."
  }

  $developerHostRoot = Join-Path $developerHelper 'host'
  $installedHostRoot = Join-Path $installRoot 'host'
  foreach ($relativeExecutable in @(
    'video-radar-host.exe',
    'tools\deno.exe',
    'tools\ffmpeg.exe',
    'tools\ffprobe.exe',
    'tools\yt-dlp.exe'
  )) {
    Assert-SameFile -Expected (Join-Path $developerHostRoot $relativeExecutable) `
      -Actual (Join-Path $installedHostRoot $relativeExecutable) `
      -Label $relativeExecutable
  }

  Assert-File -Path $installedManifestPath -Label 'manifesto Native Messaging instalado'
  $installedManifest = Get-Content -LiteralPath $installedManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $expectedHostPath = Join-Path $installedHostRoot 'video-radar-host.exe'
  if ([string]$installedManifest.name -cne 'com.videoradar.helper' -or
      [string]$installedManifest.path -cne $expectedHostPath -or
      [string]$installedManifest.type -cne 'stdio' -or
      @($installedManifest.allowed_origins).Count -ne 1 -or
      [string]$installedManifest.allowed_origins[0] -cne
        'chrome-extension://cakpfifpfmbdcilimpedanglnopnmckg/') {
    throw 'O manifesto Native Messaging instalado é incompatível.'
  }
  Assert-InstalledRegistry -Subkeys $registrySubkeys `
    -ExpectedManifest $installedManifestPath
  Invoke-NativeToolSmoke -HostRoot $installedHostRoot `
    -LabelPrefix "Setup $architectureLabel"

  $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -File | Where-Object {
    $_.Name -cmatch '^unins\d{3}\.exe$'
  })
  if ($uninstallers.Count -ne 1) {
    throw "O Setup $architectureLabel não produziu um único desinstalador esperado."
  }
  Assert-UninstallRegistry -Subkey $uninstallSubkey -ExpectedVersion $version `
    -ExpectedInstallRoot $installRoot -ExpectedUninstaller $uninstallers[0].FullName
  [void](Invoke-CheckedProcess -FilePath $uninstallers[0].FullName `
    -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$uninstallLog") `
    -WorkingDirectory $installRoot -TimeoutSeconds $InstallerTimeoutSeconds `
    -Label "Desinstalador $architectureLabel silencioso")
  # Inno pode terminar o processo inicial enquanto sua cópia temporária ainda
  # conclui a remoção. Aguarde o efeito observável antes de validar o cleanup.
  $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path -LiteralPath $installRoot) -and
         [DateTime]::UtcNow -lt $cleanupDeadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $installRoot) {
    throw "O desinstalador $architectureLabel não removeu a raiz isolada de instalação."
  }
  Assert-RegistryAbsent -Subkeys $registrySubkeys
  Assert-RegistryAbsent -Subkeys @($uninstallSubkey)
  $uninstalled = $true
  Write-Host "Artifact $architectureLabel $version validado: ZIP, Setup, host, ferramentas, registro e cleanup."
}
finally {
  if (-not $uninstalled -and (Test-Path -LiteralPath $installRoot -PathType Container)) {
    $cleanupUninstallers = @(Get-ChildItem -LiteralPath $installRoot -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -cmatch '^unins\d{3}\.exe$' })
    if ($cleanupUninstallers.Count -eq 1) {
      try {
        [void](Invoke-CheckedProcess -FilePath $cleanupUninstallers[0].FullName `
          -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') `
          -WorkingDirectory $installRoot -TimeoutSeconds $InstallerTimeoutSeconds `
          -Label "Cleanup do desinstalador $architectureLabel")
      }
      catch {
        Write-Warning "Falha no cleanup do desinstalador ${architectureLabel}: $($_.Exception.Message)"
      }
    }
  }
  Remove-OwnedRegistry -Subkeys $registrySubkeys -ExpectedManifest $installedManifestPath
  Remove-OwnedUninstallRegistry -Subkey $uninstallSubkey -ExpectedInstallRoot $installRoot
  if (Test-Path -LiteralPath $smokeRoot) {
    Remove-Item -LiteralPath $smokeRoot -Recurse -Force
  }
}
