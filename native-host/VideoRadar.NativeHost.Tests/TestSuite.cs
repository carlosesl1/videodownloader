namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    public static void RunAll()
    {
        HostInfoTest();
        ProtocolVersionTest();
        HostExecutableTest();
        DotnetWrapperForwardsInfoArgumentsTest();
        DotnetWrapperForwardsPublishOutputArgumentsTest();
        ProtocolTests();
        YouTubeUrlTests();
        FormatCatalogTests();
        DownloadTests();
    }

    private static void HostInfoTest()
    {
        Equal("com.videoradar.helper", global::VideoRadar.NativeHost.HostInfo.NativeName);
    }

    private static void ProtocolVersionTest()
    {
        Equal(1, global::VideoRadar.NativeHost.HostInfo.ProtocolVersion);
    }

    private static void HostExecutableTest()
    {
        var executable = Path.Combine(AppContext.BaseDirectory, "video-radar-host.exe");
        True(File.Exists(executable), $"Host executable not found: {executable}");

        var result = RunProcess(executable, []);

        Equal(0, result.ExitCode);
        Equal(string.Empty, result.StandardOutput);
        Equal($"com.videoradar.helper v1{Environment.NewLine}", result.StandardError);
    }

    private static void DotnetWrapperForwardsInfoArgumentsTest()
    {
        var result = RunDotnetWrapper("--info");

        Equal(0, result.ExitCode);
        True(
            result.StandardOutput.Contains(".NET SDK", StringComparison.Ordinal)
                || result.StandardOutput.Contains("SDK do .NET", StringComparison.Ordinal),
            $"dotnet --info did not reach the SDK.{Environment.NewLine}{result.StandardError}");
    }

    private static void DotnetWrapperForwardsPublishOutputArgumentsTest()
    {
        var outputDirectory = Path.Combine(Path.GetTempPath(), "video-radar-native-host-tests", Guid.NewGuid().ToString("N"));

        try
        {
            var result = RunDotnetWrapper(
                "publish",
                "native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj",
                "-o",
                outputDirectory);

            Equal(0, result.ExitCode);
            True(
                File.Exists(Path.Combine(outputDirectory, "video-radar-host.exe")),
                $"Publish output was not created in {outputDirectory}.{Environment.NewLine}{result.StandardError}");
        }
        finally
        {
            if (Directory.Exists(outputDirectory)) Directory.Delete(outputDirectory, recursive: true);
        }
    }

    private static ProcessResult RunDotnetWrapper(params string[] dotnetArguments)
    {
        var root = FindRepositoryRoot();
        var arguments = new List<string>
        {
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            Path.Combine(root, "scripts", "dotnet.ps1")
        };
        arguments.AddRange(dotnetArguments);

        return RunProcess("powershell", arguments, root);
    }

    private static ProcessResult RunProcess(string fileName, IEnumerable<string> arguments, string? workingDirectory = null)
    {
        using var process = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo(fileName)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = workingDirectory ?? AppContext.BaseDirectory
            }
        };
        process.StartInfo.Environment["DOTNET_CLI_UI_LANGUAGE"] = "en-US";

        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);

        process.Start();
        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        process.WaitForExit();

        return new ProcessResult(process.ExitCode, standardOutput, standardError);
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json"))) return directory.FullName;
        }

        throw new InvalidOperationException("Repository root not found");
    }

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);

    internal static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException($"Expected {expected}, received {actual}");
    }

    internal static void True(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }
}
