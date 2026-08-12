using System.Reflection;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    public static void RunAll()
    {
        HostInfoTest();
        ProtocolVersionTest();
        NativeInvocationParserTest();
        DialogOwnerWindowTests();
        ExplorerFileRevealerTests();
        HostExecutableTest();
        HostExecutableRejectsInvalidNativeInvocationTest();
        DotnetWrapperForwardsInfoArgumentsTest();
        DotnetWrapperForwardsPublishOutputArgumentsTest();
        ProtocolTests();
        MediaPageTests();
        YouTubeUrlTests();
        FormatCatalogTests();
        DiagnosticTests();
        DownloadTests();
        ServerTests();
    }

    private static void HostInfoTest()
    {
        Equal("com.videoradar.helper", global::VideoRadar.NativeHost.HostInfo.NativeName);
        Equal(
            "chrome-extension://cakpfifpfmbdcilimpedanglnopnmckg/",
            global::VideoRadar.NativeHost.HostInfo.AllowedOrigin);
    }

    private static void ProtocolVersionTest()
    {
        Equal(5, global::VideoRadar.NativeHost.HostInfo.ProtocolVersion);
        Equal("1.2.0", global::VideoRadar.NativeHost.HostInfo.Version);
        var informationalVersion = typeof(global::VideoRadar.NativeHost.HostInfo).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;
        Equal(
            global::VideoRadar.NativeHost.HostInfo.Version,
            informationalVersion?.Split('+', 2)[0]);
        True(
            global::VideoRadar.NativeHost.HostInfo.Capabilities.SequenceEqual(
                ["idempotentStart", "idempotentFileMove", "jobReconciliation", "boundedProcessOutput", "durableQueue", "pauseResume", "restartRecovery", "richMediaCatalog", "ffprobeValidation", "diagnosticsExport", "arm64"]),
            "Native protocol capabilities changed unexpectedly.");
    }

    private static void NativeInvocationParserTest()
    {
        var allowedOrigin = global::VideoRadar.NativeHost.HostInfo.AllowedOrigin;

        True(
            global::VideoRadar.NativeHost.Program.TryParseNativeInvocation(
                [allowedOrigin],
                out var originOnlyParent),
            "The allowed origin-only invocation was rejected.");
        Equal(IntPtr.Zero, originOnlyParent);

        True(
            global::VideoRadar.NativeHost.Program.TryParseNativeInvocation(
                [allowedOrigin, "--parent-window=123"],
                out var explicitParent),
            "A valid decimal parent window was rejected.");
        Equal(new IntPtr(123), explicitParent);

        True(
            global::VideoRadar.NativeHost.Program.TryParseNativeInvocation(
                [allowedOrigin, $"--parent-window={long.MaxValue}"],
                out var maximumParent),
            "The maximum signed 64-bit parent window was rejected.");
        Equal(new IntPtr(long.MaxValue), maximumParent);

        string[][] rejectedInvocations =
        [
            [],
            ["--ping"],
            ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
            [allowedOrigin, ""],
            [allowedOrigin, "--parent-window="],
            [allowedOrigin, "--parent-window=-1"],
            [allowedOrigin, "--parent-window=+1"],
            [allowedOrigin, "--parent-window= 1"],
            [allowedOrigin, "--parent-window=1.0"],
            [allowedOrigin, "--parent=1"],
            [allowedOrigin, "--parent-window=9223372036854775808"],
            [allowedOrigin, "--parent-window=0", "extra"]
        ];

        foreach (var invocation in rejectedInvocations)
        {
            True(
                !global::VideoRadar.NativeHost.Program.TryParseNativeInvocation(
                    invocation,
                    out _),
                $"Invalid native invocation was accepted: {string.Join(" ", invocation)}");
        }
    }

    private static void HostExecutableTest()
    {
        var executable = Path.Combine(AppContext.BaseDirectory, "video-radar-host.exe");
        True(File.Exists(executable), $"Host executable not found: {executable}");

        var result = RunProcess(
            executable,
            [global::VideoRadar.NativeHost.HostInfo.AllowedOrigin, "--parent-window=0"]);

        True(result.ExitCode == 0, $"Chrome native mode failed.{Environment.NewLine}{result.StandardError}");
        Equal(string.Empty, result.StandardOutput);
        Equal(string.Empty, result.StandardError);

        result = RunProcess(
            executable,
            [global::VideoRadar.NativeHost.HostInfo.AllowedOrigin]);

        True(result.ExitCode == 0, $"Origin-only native mode failed.{Environment.NewLine}{result.StandardError}");
        Equal(string.Empty, result.StandardOutput);
        Equal(string.Empty, result.StandardError);
    }

    private static void HostExecutableRejectsInvalidNativeInvocationTest()
    {
        var executable = Path.Combine(AppContext.BaseDirectory, "video-radar-host.exe");
        const string wrongOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";

        string[][] rejectedInvocations =
        [
            [],
            [wrongOrigin],
            [global::VideoRadar.NativeHost.HostInfo.AllowedOrigin, "--parent-window=-1"],
            ["--ping", "extra"]
        ];

        foreach (var invocation in rejectedInvocations)
        {
            var result = RunProcess(executable, invocation);

            Equal(2, result.ExitCode);
            Equal(string.Empty, result.StandardOutput);
            True(
                result.StandardError.Contains("Uso:", StringComparison.Ordinal),
                "Rejected native invocation did not print a safe usage message.");
            True(
                !result.StandardError.Contains(wrongOrigin, StringComparison.Ordinal),
                "Rejected native invocation leaked the supplied origin.");
        }
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
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = workingDirectory ?? AppContext.BaseDirectory
            }
        };
        process.StartInfo.Environment["DOTNET_CLI_UI_LANGUAGE"] = "en-US";

        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);

        process.Start();
        process.StandardInput.Close();
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
