$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$nativeArchitecture = if (@($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -ccontains 'ARM64') {
  'arm64'
} elseif (@($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -ccontains 'AMD64') {
  'x64'
} else {
  throw 'O wrapper .NET suporta somente Windows x64 e ARM64.'
}
$local = Join-Path $root ".tools\dotnet\$nativeArchitecture\dotnet.exe"
$globalJsonPath = Join-Path $root 'global.json'
$bootstrapPath = Join-Path $PSScriptRoot 'bootstrap-dotnet.ps1'
$sdk = Get-Content -LiteralPath $globalJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedVersion = [string]$sdk.sdk.version

function Get-SdkVersion {
  param([Parameter(Mandatory = $true)][string]$Executable)
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $null }
  $version = @(& $Executable --version 2>$null)
  if ($LASTEXITCODE -ne 0 -or $version.Count -ne 1) { return $null }
  return [string]$version[0]
}

$dotnet = $null
if ((Get-SdkVersion -Executable $local) -ceq $expectedVersion) {
  $dotnet = $local
}
else {
  $installedCommand = Get-Command dotnet -CommandType Application -ErrorAction SilentlyContinue
  if ($null -ne $installedCommand -and
      (Get-SdkVersion -Executable $installedCommand.Source) -ceq $expectedVersion) {
    $dotnet = $installedCommand.Source
  }
}

if ($null -eq $dotnet) {
  & $bootstrapPath
  if ($LASTEXITCODE -ne 0) {
    throw "O bootstrap do SDK .NET falhou com codigo $LASTEXITCODE."
  }
  if ((Get-SdkVersion -Executable $local) -cne $expectedVersion) {
    throw "O SDK .NET local nao corresponde a versao fixada $expectedVersion."
  }
  $dotnet = $local
}

& $dotnet @args
exit $LASTEXITCODE
