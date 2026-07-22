$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $root '.tools\dotnet'
$installer = Join-Path ([System.IO.Path]::GetTempPath()) 'video-radar-dotnet-install.ps1'
Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Channel '10.0' -InstallDir $installDir -NoPath
if ($LASTEXITCODE -ne 0) { throw "dotnet-install falhou: $LASTEXITCODE" }
& (Join-Path $installDir 'dotnet.exe') --version
