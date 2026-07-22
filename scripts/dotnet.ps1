param([Parameter(ValueFromRemainingArguments = $true)][string[]]$DotnetArgs)
$root = Split-Path -Parent $PSScriptRoot
$local = Join-Path $root '.tools\dotnet\dotnet.exe'
$dotnet = if (Test-Path $local) { $local } else { (Get-Command dotnet -ErrorAction Stop).Source }
& $dotnet @DotnetArgs
exit $LASTEXITCODE
