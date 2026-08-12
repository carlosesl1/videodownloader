using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using VideoRadar.NativeHost.Files;

namespace VideoRadar.NativeHost.Diagnostics;

public sealed partial class DiagnosticService : IDiagnosticService
{
    private const int MaximumLogFiles = 8;
    private const long MaximumLogBytes = 256 * 1024;
    private const long MaximumExportedLogBytes = MaximumLogFiles * MaximumLogBytes;
    private const long MaximumJavaScriptSafeInteger = 9_007_199_254_740_991;
    private static readonly TimeSpan StateLeaseTimeout = TimeSpan.FromSeconds(2);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };
    private static readonly JsonSerializerOptions LogJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private static readonly string[] ToolNames = ["yt-dlp.exe", "deno.exe", "ffmpeg.exe", "ffprobe.exe"];

    private readonly object sync = new();
    private readonly string toolsDirectory;
    private readonly string diagnosticsDirectory;
    private readonly string settingsPath;
    private readonly string stateLockPath;
    private readonly string currentLogPath;
    private bool enabled;

    public DiagnosticService(string toolsDirectory, string? localApplicationData = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(toolsDirectory);
        this.toolsDirectory = Path.GetFullPath(toolsDirectory);
        var localRoot = localApplicationData
            ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localRoot) || !Path.IsPathFullyQualified(localRoot))
            throw new DirectoryNotFoundException("Local application data directory is unavailable.");

        diagnosticsDirectory = Path.Combine(Path.GetFullPath(localRoot), "VideoRadar", "diagnostics");
        Directory.CreateDirectory(diagnosticsDirectory);
        settingsPath = Path.Combine(diagnosticsDirectory, "settings.json");
        stateLockPath = Path.Combine(diagnosticsDirectory, "state.lock");
        currentLogPath = Path.Combine(
            diagnosticsDirectory,
            $"events-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Environment.ProcessId}.jsonl");
        using var stateLease = AcquireStateLease();
        enabled = ReadEnabledSetting();
        PruneLogsUnsafe();
    }

    public bool Enabled
    {
        get
        {
            lock (sync)
            {
                try
                {
                    using var stateLease = AcquireStateLease();
                    enabled = ReadEnabledSetting();
                }
                catch (Exception exception) when (IsRecoverableIo(exception))
                {
                    // A stale in-memory opt-in must never enable logging when the
                    // durable preference cannot be consulted.
                    enabled = false;
                }
                return enabled;
            }
        }
    }

    public DiagnosticSummary GetSummary(string downloadFolder) =>
        CreateSummary(downloadFolder, includeHashes: false);

    public void SetEnabled(bool enabledValue)
    {
        lock (sync)
        {
            using var stateLease = AcquireStateLease();
            // The durable preference is authoritative across overlapping native
            // hosts. Do not expose the new value in memory unless its atomic
            // replacement completed successfully.
            WriteSettings(enabledValue);
            enabled = enabledValue;
            if (enabledValue) AppendRecordBestEffort("diagnostics_enabled", null);
        }
    }

    public void Record(string eventName, string? code = null)
    {
        if (!IsSafeToken(eventName) || (code is not null && !IsSafeToken(code)))
            throw new ArgumentException("Diagnostic event contains unsafe data.", nameof(eventName));

        lock (sync)
        {
            try
            {
                using var stateLease = AcquireStateLease();
                enabled = ReadEnabledSetting();
                if (!enabled) return;
                AppendRecordBestEffort(eventName, code);
            }
            catch (Exception exception) when (IsRecoverableIo(exception))
            {
                // Diagnostics must never break a download or the Native Messaging
                // protocol. Fail closed if the durable opt-in cannot be read.
                enabled = false;
            }
        }
    }

    public string Export(string destinationFolder, string downloadFolder)
    {
        var canonicalDestination = DownloadPaths.NormalizeDestination(
            destinationFolder,
            nameof(destinationFolder));
        Directory.CreateDirectory(canonicalDestination);
        var summary = CreateSummary(downloadFolder, includeHashes: true);
        var exportPath = ReserveExportPath(canonicalDestination);

        try
        {
            using var stream = new FileStream(
                exportPath,
                FileMode.CreateNew,
                FileAccess.ReadWrite,
                FileShare.None,
                64 * 1024,
                FileOptions.WriteThrough);
            using var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: false);
            WriteJsonEntry(archive, "health.json", summary);
            WriteTextEntry(
                archive,
                "README.txt",
                "Video Radar diagnostics\r\n"
                + "This archive is created only on explicit request. Local logs contain event names and error codes; URLs, cookies, media paths and process stderr are never recorded.\r\n");
            AddLogs(archive);
            return exportPath;
        }
        catch
        {
            try { if (File.Exists(exportPath)) File.Delete(exportPath); } catch { }
            throw;
        }
    }

    public void Clear()
    {
        lock (sync)
        {
            using var stateLease = AcquireStateLease();
            foreach (var path in EnumerateAllLogPathsStrict()) File.Delete(path);
            if (EnumerateAllLogPathsStrict().Any())
                throw new IOException("Diagnostic logs could not be removed completely.");
        }
    }

    private void AppendRecordBestEffort(string eventName, string? code)
    {
        try
        {
            var line = JsonSerializer.Serialize(
                new DiagnosticEvent(DateTimeOffset.UtcNow, eventName, code),
                LogJsonOptions) + Environment.NewLine;
            var bytes = Encoding.UTF8.GetByteCount(line);
            if (bytes > 1024) return;
            var length = File.Exists(currentLogPath) ? new FileInfo(currentLogPath).Length : 0;
            if (length + bytes > MaximumLogBytes) return;
            File.AppendAllText(
                currentLogPath,
                line,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch (Exception exception) when (IsRecoverableIo(exception))
        {
            // The opt-in setting is durable even if an individual event cannot be
            // appended. Event logging remains strictly best-effort.
        }
    }

    private DiagnosticSummary CreateSummary(string downloadFolder, bool includeHashes)
    {
        var canonicalDownloadFolder = DownloadPaths.NormalizeDestination(downloadFolder, nameof(downloadFolder));
        return new DiagnosticSummary(
            DateTimeOffset.UtcNow,
            HostInfo.Version,
            HostInfo.ProtocolVersion,
            RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
            Limit(RuntimeInformation.OSDescription, 160) ?? "Unknown",
            TryGetAvailableBytes(canonicalDownloadFolder),
            Enabled,
            EnumerateLogPaths().Count,
            ToolNames.Select(name => InspectTool(name, includeHashes)).ToArray());
    }

    private DiagnosticTool InspectTool(string fileName, bool includeHash)
    {
        var path = Path.Combine(toolsDirectory, fileName);
        if (!File.Exists(path)) return new DiagnosticTool(fileName, false, null, null, null);
        try
        {
            var info = new FileInfo(path);
            var version = FileVersionInfo.GetVersionInfo(path).FileVersion;
            string? hash = null;
            if (includeHash)
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            }
            return new DiagnosticTool(fileName, true, Limit(version, 96), info.Length, hash);
        }
        catch (Exception exception) when (IsRecoverableIo(exception))
        {
            return new DiagnosticTool(fileName, false, null, null, null);
        }
    }

    private void AddLogs(ZipArchive archive)
    {
        long exportedBytes = 0;
        var index = 0;
        foreach (var path in EnumerateLogPaths())
        {
            try
            {
                var sanitized = ReadSanitizedLog(path);
                if (sanitized is null) continue;
                var bytes = Encoding.UTF8.GetByteCount(sanitized);
                if (bytes <= 0 || exportedBytes + bytes > MaximumExportedLogBytes) continue;
                WriteTextEntry(archive, $"logs/events-{index++}.jsonl", sanitized);
                exportedBytes += bytes;
            }
            catch (Exception exception) when (IsRecoverableIo(exception))
            {
                // A host may still be writing its own bounded log; skip an unreadable file.
            }
        }
    }

    private static string? ReadSanitizedLog(string path)
    {
        try
        {
            var bytes = File.ReadAllBytes(path);
            if (bytes.LongLength is <= 0 or > MaximumLogBytes) return null;
            var contents = new UTF8Encoding(
                encoderShouldEmitUTF8Identifier: false,
                throwOnInvalidBytes: true).GetString(bytes);
            var output = new StringBuilder(contents.Length);
            var outputBytes = 0;
            using var reader = new StringReader(contents);
            for (var lineCount = 0; ; lineCount++)
            {
                var line = reader.ReadLine();
                if (line is null) break;
                if (lineCount >= 4_096 || line.Length is <= 0 or > 1_024) return null;
                using var document = JsonDocument.Parse(
                    line,
                    new JsonDocumentOptions { MaxDepth = 4 });
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || root.EnumerateObject().Count() != 3
                    || !root.TryGetProperty("timestamp", out var timestampValue)
                    || timestampValue.ValueKind != JsonValueKind.String
                    || !timestampValue.TryGetDateTimeOffset(out var timestamp)
                    || !root.TryGetProperty("event", out var eventValue)
                    || eventValue.ValueKind != JsonValueKind.String
                    || eventValue.GetString() is not { } eventName
                    || !IsSafeToken(eventName)
                    || !root.TryGetProperty("code", out var codeValue)
                    || codeValue.ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
                {
                    return null;
                }
                var code = codeValue.ValueKind == JsonValueKind.String
                    ? codeValue.GetString()
                    : null;
                if (code is not null && !IsSafeToken(code)) return null;
                var sanitizedLine = JsonSerializer.Serialize(
                    new DiagnosticEvent(timestamp, eventName, code),
                    LogJsonOptions);
                outputBytes += Encoding.UTF8.GetByteCount(sanitizedLine) + 1;
                if (outputBytes > MaximumLogBytes) return null;
                output.Append(sanitizedLine);
                output.Append('\n');
            }
            return output.Length == 0 ? null : output.ToString();
        }
        catch (Exception exception) when (
            exception is JsonException or DecoderFallbackException || IsRecoverableIo(exception))
        {
            return null;
        }
    }

    private IReadOnlyList<string> EnumerateLogPaths()
    {
        try
        {
            return Directory.EnumerateFiles(diagnosticsDirectory, "events-*.jsonl", SearchOption.TopDirectoryOnly)
                .Where(IsSafeLogFile)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .Take(MaximumLogFiles)
                .ToArray();
        }
        catch (Exception exception) when (IsRecoverableIo(exception))
        {
            return [];
        }
    }

    private IEnumerable<string> EnumerateAllLogPathsStrict()
    {
        foreach (var path in Directory.EnumerateFiles(
            diagnosticsDirectory,
            "events-*.jsonl",
            SearchOption.TopDirectoryOnly))
        {
            if (!IsSafeLogFile(path))
                throw new IOException("A diagnostic log path is not a regular local file.");
            yield return path;
        }
    }

    private void PruneLogsUnsafe()
    {
        try
        {
            var paths = Directory.EnumerateFiles(diagnosticsDirectory, "events-*.jsonl", SearchOption.TopDirectoryOnly)
                .Where(IsSafeLogFile)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .ToArray();
            foreach (var path in paths.Skip(MaximumLogFiles - 1))
            {
                try { File.Delete(path); }
                catch (Exception exception) when (IsRecoverableIo(exception)) { }
            }
        }
        catch (Exception exception) when (IsRecoverableIo(exception)) { }
    }

    private bool IsSafeLogFile(string path)
    {
        try
        {
            var fullPath = Path.GetFullPath(path);
            var prefix = Path.EndsInDirectorySeparator(diagnosticsDirectory)
                ? diagnosticsDirectory
                : diagnosticsDirectory + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
            var attributes = File.GetAttributes(fullPath);
            return (attributes & FileAttributes.ReparsePoint) == 0;
        }
        catch (Exception exception) when (IsRecoverableIo(exception))
        {
            return false;
        }
    }

    private bool ReadEnabledSetting()
    {
        try
        {
            if (!File.Exists(settingsPath) || new FileInfo(settingsPath).Length > 1024) return false;
            using var document = JsonDocument.Parse(
                File.ReadAllBytes(settingsPath),
                new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.EnumerateObject().Count() == 1
                && root.TryGetProperty("enabled", out var value)
                && value.ValueKind == JsonValueKind.True;
        }
        catch (Exception exception) when (exception is JsonException || IsRecoverableIo(exception))
        {
            return false;
        }
    }

    private void WriteSettings(bool value)
    {
        Directory.CreateDirectory(diagnosticsDirectory);
        var temporary = Path.Combine(diagnosticsDirectory, $"settings-{Guid.NewGuid():N}.tmp");
        try
        {
            var bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(
                JsonSerializer.Serialize(new { enabled = value }, LogJsonOptions));
            using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, settingsPath, overwrite: true);
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
        }
    }

    private FileStream AcquireStateLease()
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                return new FileStream(
                    stateLockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.None);
            }
            catch (IOException) when (stopwatch.Elapsed < StateLeaseTimeout)
            {
                Thread.Sleep(10);
            }
        }
    }

    private static string ReserveExportPath(string destinationFolder)
    {
        var prefix = $"VideoRadar-Diagnostics-{DateTime.Now:yyyyMMdd-HHmmss}";
        for (var suffix = 0; suffix < 100; suffix++)
        {
            var name = suffix == 0 ? $"{prefix}.zip" : $"{prefix}-{suffix}.zip";
            var path = Path.GetFullPath(Path.Combine(destinationFolder, name));
            if (!File.Exists(path)) return path;
        }
        throw new IOException("Could not reserve a diagnostics export name.");
    }

    private static void WriteJsonEntry<T>(ZipArchive archive, string name, T value) =>
        WriteTextEntry(archive, name, JsonSerializer.Serialize(value, JsonOptions));

    private static void WriteTextEntry(ZipArchive archive, string name, string value)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        using var writer = new StreamWriter(
            entry.Open(),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            leaveOpen: false);
        writer.Write(value);
    }

    private static long? TryGetAvailableBytes(string path)
    {
        try
        {
            var root = Path.GetPathRoot(path);
            if (string.IsNullOrWhiteSpace(root)) return null;
            var drive = new DriveInfo(root);
            return drive.IsReady
                ? Math.Min(drive.AvailableFreeSpace, MaximumJavaScriptSafeInteger)
                : null;
        }
        catch (Exception exception) when (IsRecoverableIo(exception))
        {
            return null;
        }
    }

    private static bool IsSafeToken(string value) =>
        value.Length is >= 1 and <= 64 && SafeToken().IsMatch(value);

    private static string? Limit(string? value, int maximum) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Length <= maximum ? value : value[..maximum];

    private static bool IsRecoverableIo(Exception exception) =>
        exception is IOException or UnauthorizedAccessException or ArgumentException
            or NotSupportedException or System.Security.SecurityException;

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeToken();

    private sealed record DiagnosticEvent(DateTimeOffset Timestamp, string Event, string? Code);
}
