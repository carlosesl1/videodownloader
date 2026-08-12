[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sdkVersion = '10.0.400'
$nativeArchitecture = if (@($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -ccontains 'ARM64') {
  'arm64'
} elseif (@($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -ccontains 'AMD64') {
  'x64'
} else {
  throw 'O bootstrap do SDK suporta somente Windows x64 e ARM64.'
}
$sdkArtifacts = @{
  'x64' = [ordered]@{
    url = 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.400/dotnet-sdk-10.0.400-win-x64.zip'
    sha512 = '9b8b88590e4da131bfd0da7aa089d0fc04d5418d5f8607ec13d55dc5a17b4399afd54d496c12657fa05c6c6546dc5eab930f26ac6c50f2d3a7712c0fb378c366'
  }
  'arm64' = [ordered]@{
    url = 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.400/dotnet-sdk-10.0.400-win-arm64.zip'
    sha512 = '9d4ecd7439f15c7797d6f46d368cb7aa6513755c5fc3d6de7621bc4878a1805f6b8ffb60ffb9d3e72a049cca87edb252f7c8c03023b643e333544c4606509d7f'
  }
}
$sdkUrl = [string]$sdkArtifacts[$nativeArchitecture].url
$sdkSha512 = [string]$sdkArtifacts[$nativeArchitecture].sha512
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$toolsRoot = Join-Path $root '.tools'
$installDir = Join-Path $toolsRoot "dotnet\$nativeArchitecture"
$archive = Join-Path ([IO.Path]::GetTempPath()) `
  "video-radar-dotnet-$sdkVersion-$nativeArchitecture-$([Guid]::NewGuid().ToString('N')).zip"
$staging = Join-Path $toolsRoot "dotnet-$sdkVersion-$nativeArchitecture-staging-$([Guid]::NewGuid().ToString('N'))"
$backup = Join-Path $toolsRoot "dotnet-$nativeArchitecture-backup-$([Guid]::NewGuid().ToString('N'))"
$backupCreated = $false

function Get-InstalledVersion {
  param([Parameter(Mandatory = $true)][string]$Directory)
  $executable = Join-Path $Directory 'dotnet.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $null }
  $version = @(& $executable --version 2>$null)
  if ($LASTEXITCODE -ne 0 -or $version.Count -ne 1) { return $null }
  return [string]$version[0]
}

New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $installDir) -Force | Out-Null
if ((Get-InstalledVersion -Directory $installDir) -ceq $sdkVersion) {
  Write-Output $sdkVersion
  exit 0
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri $sdkUrl -OutFile $archive
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash.ToLowerInvariant()
  if ($actualHash -cne $sdkSha512) {
    throw 'O SHA-512 do SDK .NET não corresponde ao release oficial fixado.'
  }

  New-Item -ItemType Directory -Path $staging | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $staging
  if ((Get-InstalledVersion -Directory $staging) -cne $sdkVersion) {
    throw 'O SDK .NET extraído não corresponde à versão fixada.'
  }

  if (Test-Path -LiteralPath $installDir) {
    Move-Item -LiteralPath $installDir -Destination $backup
    $backupCreated = $true
  }
  Move-Item -LiteralPath $staging -Destination $installDir
  if ((Get-InstalledVersion -Directory $installDir) -cne $sdkVersion) {
    throw 'A instalação local do SDK .NET falhou na verificação final.'
  }
  if ($backupCreated -and (Test-Path -LiteralPath $backup)) {
    Remove-Item -LiteralPath $backup -Recurse -Force
    $backupCreated = $false
  }
  Write-Output $sdkVersion
}
catch {
  if ($backupCreated -and (Test-Path -LiteralPath $installDir)) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
  }
  if ($backupCreated -and (Test-Path -LiteralPath $backup)) {
    Move-Item -LiteralPath $backup -Destination $installDir
    $backupCreated = $false
  }
  throw
}
finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  # If rollback itself failed, preserve the previous SDK backup for manual
  # recovery instead of deleting the only known-good installation.
}
