using VideoRadar.NativeHost.Tests;

if (args is ["--process-runner-stdin-probe"])
{
    const string script = "$value = [Console]::In.ReadToEnd(); if ($value.Length -eq 0) { Write-Output 'EOF' } else { Write-Output 'DATA' }";
    var result = await new VideoRadar.NativeHost.Processes.ProcessRunner().RunAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", script],
        null,
        CancellationToken.None);
    Console.Write(result.StandardOutput);
    return result.ExitCode;
}

try
{
    TestSuite.RunAll();
    Console.WriteLine("Native host tests passed");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error);
    return 1;
}
