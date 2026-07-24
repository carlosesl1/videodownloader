using System.Globalization;
using System.Text.Json;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Host;
using VideoRadar.NativeHost.Processes;
using VideoRadar.NativeHost.Protocol;
using VideoRadar.NativeHost.Tools;
using VideoRadar.NativeHost.Windows;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost;

public static class Program
{
    private static readonly JsonSerializerOptions DiagnosticJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static async Task<int> Main(string[] args)
    {
        var baseDirectory = AppContext.BaseDirectory;
        var toolsDirectory = Path.Combine(baseDirectory, "tools");
        if (args.Length == 1 && string.Equals(args[0], "--ping", StringComparison.Ordinal))
        {
            var diagnostic = CreatePingDiagnostic(toolsDirectory);
            Console.Out.WriteLine(JsonSerializer.Serialize(diagnostic, DiagnosticJson));
            return diagnostic.Ok ? 0 : 1;
        }

        if (!TryParseNativeInvocation(args, out var parentWindow))
        {
            Console.Error.WriteLine(
                "Uso: video-radar-host.exe --ping | <origem autorizada> [--parent-window=<decimal>]");
            return 2;
        }

        try
        {
            var channel = new NativeMessageChannel(Console.OpenStandardInput(), Console.OpenStandardOutput());
            var processRunner = new ProcessRunner();
            var downloadPaths = new DownloadPaths();
            var downloadPathsFactory = new DownloadPathsFactory(downloadPaths.Home, downloadPaths.TempRoot);
            var youtubeService = new YouTubeService(toolsDirectory, processRunner, downloadPathsFactory);
            var updatePolicy = new UpdatePolicy(toolsDirectory, processRunner);
            var fileMover = new DownloadFileMover();
            if (!OperatingSystem.IsWindows())
                throw new PlatformNotSupportedException("The folder picker requires Windows.");
            var folderPicker = new WindowsFolderPicker(parentWindow);
            INativeHostServer server = new NativeHostServer(
                channel,
                youtubeService,
                updatePolicy,
                folderPicker,
                downloadPaths.Home,
                fileMover);
            await server.RunAsync(CancellationToken.None);
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Falha fatal do host nativo ({exception.GetType().Name}).");
            return 1;
        }
    }

    public static bool TryParseNativeInvocation(
        IReadOnlyList<string> args,
        out IntPtr parentWindow)
    {
        parentWindow = IntPtr.Zero;
        if (args is null || args.Count is < 1 or > 2) return false;
        if (!string.Equals(args[0], HostInfo.AllowedOrigin, StringComparison.Ordinal)) return false;
        if (args.Count == 1) return true;

        const string parentWindowPrefix = "--parent-window=";
        var parentWindowArgument = args[1];
        if (parentWindowArgument is null
            || !parentWindowArgument.StartsWith(parentWindowPrefix, StringComparison.Ordinal))
            return false;

        var parentWindowText = parentWindowArgument.AsSpan(parentWindowPrefix.Length);
        if (parentWindowText.IsEmpty) return false;
        foreach (var character in parentWindowText)
        {
            if (character is < '0' or > '9') return false;
        }

        if (!long.TryParse(
                parentWindowText,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var parentWindowValue))
            return false;

        try
        {
            parentWindow = new IntPtr(parentWindowValue);
            return true;
        }
        catch (OverflowException)
        {
            return false;
        }
    }

    public static PingDiagnostic CreatePingDiagnostic(string toolsDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(toolsDirectory);
        var tools = new ToolDiagnostic(
            File.Exists(Path.Combine(toolsDirectory, "yt-dlp.exe")),
            File.Exists(Path.Combine(toolsDirectory, "deno.exe")),
            File.Exists(Path.Combine(toolsDirectory, "ffmpeg.exe")),
            File.Exists(Path.Combine(toolsDirectory, "ffprobe.exe")));
        return new PingDiagnostic(
            tools.YtDlp && tools.Deno && tools.Ffmpeg && tools.Ffprobe,
            HostInfo.NativeName,
            HostInfo.ProtocolVersion,
            tools);
    }

    public sealed record PingDiagnostic(bool Ok, string Host, int ProtocolVersion, ToolDiagnostic Tools);

    public sealed record ToolDiagnostic(bool YtDlp, bool Deno, bool Ffmpeg, bool Ffprobe);
}
