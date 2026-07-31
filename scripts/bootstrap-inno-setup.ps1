[CmdletBinding()]
param(
  [string]$LockPath,
  [string]$CacheRoot,
  [string]$ReadyRoot,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tools'))
if ([string]::IsNullOrWhiteSpace($LockPath)) {
  $LockPath = Join-Path $projectRoot 'installer\inno-tool-lock.json'
}
if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
  $CacheRoot = Join-Path $toolsRoot 'inno-cache'
}
$LockPath = [IO.Path]::GetFullPath($LockPath)
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)

function Assert-ProjectToolPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $prefix = $toolsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay inside the project .tools directory."
  }
}

function Get-LowerSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-LockedInstaller {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Lock
  )

  $file = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ([long]$file.Length -ne [long]$Lock.size) {
    throw 'The Inno Setup installer size differs from the lock.'
  }
  if ((Get-LowerSha256 -Path $Path) -cne [string]$Lock.sha256) {
    throw 'The Inno Setup installer SHA-256 differs from the lock.'
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "The Inno Setup Authenticode signature is not valid: $($signature.Status)."
  }
  if ($null -eq $signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -cne [string]$Lock.publisher) {
    throw 'The Inno Setup Authenticode publisher differs from the lock.'
  }
}

$lock = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedProperties = @('fileName', 'publisher', 'schemaVersion', 'sha256', 'size', 'url', 'version')
$actualProperties = @($lock.PSObject.Properties.Name | Sort-Object)
if (($actualProperties -join "`n") -cne (($expectedProperties | Sort-Object) -join "`n")) {
  throw 'installer/inno-tool-lock.json has unexpected or missing fields.'
}
if ([int]$lock.schemaVersion -ne 1 -or
    [string]$lock.version -cnotmatch '^\d+\.\d+\.\d+$' -or
    [string]$lock.fileName -cne "innosetup-$($lock.version)-x64.exe" -or
    [string]$lock.url -cne "https://github.com/jrsoftware/issrc/releases/download/is-$(([string]$lock.version).Replace('.', '_'))/$($lock.fileName)" -or
    [string]$lock.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
    [long]$lock.size -le 0) {
  throw 'installer/inno-tool-lock.json is invalid.'
}

if ([string]::IsNullOrWhiteSpace($ReadyRoot)) {
  $ReadyRoot = Join-Path $toolsRoot "inno-ready\$($lock.version)"
}
$ReadyRoot = [IO.Path]::GetFullPath($ReadyRoot)
Assert-ProjectToolPath -Path $CacheRoot -Label 'CacheRoot'
Assert-ProjectToolPath -Path $ReadyRoot -Label 'ReadyRoot'

$isccPath = Join-Path $ReadyRoot 'ISCC.exe'
if (-not $Force -and (Test-Path -LiteralPath $isccPath -PathType Leaf)) {
  Write-Output $isccPath
  exit 0
}

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
$installerPath = Join-Path $CacheRoot ([string]$lock.fileName)
$downloadPath = "$installerPath.download-$([Guid]::NewGuid().ToString('N'))"
try {
  $needsDownload = $true
  if (Test-Path -LiteralPath $installerPath -PathType Leaf) {
    try {
      Assert-LockedInstaller -Path $installerPath -Lock $lock
      $needsDownload = $false
    }
    catch {
      Remove-Item -LiteralPath $installerPath -Force
    }
  }

  if ($needsDownload) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = 'VideoRadar-ReleaseBuilder/1.0' }
    Invoke-WebRequest -Uri ([string]$lock.url) -Headers $headers -OutFile $downloadPath
    Assert-LockedInstaller -Path $downloadPath -Lock $lock
    Move-Item -LiteralPath $downloadPath -Destination $installerPath
  }

  Assert-LockedInstaller -Path $installerPath -Lock $lock
  if (Test-Path -LiteralPath $ReadyRoot) {
    Remove-Item -LiteralPath $ReadyRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $ReadyRoot -Force | Out-Null

  $arguments = @(
    '/PORTABLE=1',
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    "/DIR=`"$ReadyRoot`""
  )
  $process = Start-Process -FilePath $installerPath -ArgumentList $arguments `
    -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    throw "Portable Inno Setup failed with exit code $($process.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $isccPath -PathType Leaf)) {
    throw 'ISCC.exe was not produced by the portable bootstrap.'
  }
  Write-Output $isccPath
}
finally {
  if (Test-Path -LiteralPath $downloadPath) {
    Remove-Item -LiteralPath $downloadPath -Force
  }
}
