using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Media;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Host;

public sealed class StartOperationJournal
{
    private const int SchemaVersion = 1;
    private const int MaximumEntries = 64;
    private const int MaximumEnumeratedEntries = 256;
    private const int MaximumEntryBytes = 32 * 1024;
    private static readonly Regex SafeId =
        new("^[A-Za-z0-9._:-]{1,128}$", RegexOptions.CultureInvariant);
    private static readonly Regex SafeErrorCode =
        new("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> AllowedStages = new(StringComparer.Ordinal)
    {
        "preparing", "download", "video", "audio", "merge", "finalize",
        "complete", "failed", "cancelled"
    };
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private readonly string root;

    public StartOperationJournal(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        this.root = Path.GetFullPath(root);
        Directory.CreateDirectory(this.root);
        EnsureNoReparsePoints(this.root);
    }

    public static StartOperationJournal CreateDefault()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
            throw new DirectoryNotFoundException("Local application data is unavailable.");
        return new StartOperationJournal(Path.Combine(localAppData, "VideoRadar", "start-journal"));
    }

    internal StartOperationJournalEntry? Read(string operationId)
    {
        ValidateOperationId(operationId);
        var path = EntryPath(operationId);
        if (!File.Exists(path)) return null;

        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.SequentialScan);
            if (stream.Length is <= 0 or > MaximumEntryBytes)
                throw new InvalidDataException("The start journal entry has an invalid size.");
            var bytes = new byte[(int)stream.Length];
            stream.ReadExactly(bytes);
            var entry = JsonSerializer.Deserialize<StartOperationJournalEntry>(
                StrictUtf8.GetString(bytes),
                Json) ?? throw new InvalidDataException("The start journal entry is empty.");
            ValidateEntry(entry);
            if (!string.Equals(entry.OperationId, operationId, StringComparison.Ordinal))
                throw new InvalidDataException("The start journal key does not match its payload.");
            return entry;
        }
        catch (Exception exception) when (
            exception is JsonException or NotSupportedException or DecoderFallbackException)
        {
            throw new InvalidDataException("The start journal entry is invalid.", exception);
        }
    }

    internal StartOperationJournalEntry? ReadMostRecent()
    {
        var files = Directory.EnumerateFiles(root, "*.json", SearchOption.TopDirectoryOnly)
            .Take(MaximumEnumeratedEntries + 1)
            .Select(path => new FileInfo(path))
            .OrderByDescending(file => file.LastWriteTimeUtc)
            .ToArray();
        if (files.Length > MaximumEnumeratedEntries)
            throw new IOException("The start journal contains too many entries.");

        foreach (var file in files)
        {
            try
            {
                var entry = ReadEntryFile(file.FullName);
                ValidateEntry(entry);
                if (!string.Equals(file.FullName, EntryPath(entry.OperationId), StringComparison.OrdinalIgnoreCase))
                    continue;
                return entry;
            }
            catch (Exception exception) when (
                exception is IOException
                or ArgumentException
                or UnauthorizedAccessException
                or JsonException
                or DecoderFallbackException)
            {
                // A corrupt unrelated entry cannot hide a newer valid job from reconciliation.
            }
        }

        return null;
    }

    internal void Write(StartOperationJournalEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        ValidateEntry(entry);
        Directory.CreateDirectory(root);
        EnsureNoReparsePoints(root);
        var path = EntryPath(entry.OperationId);
        PruneBeforeWrite(path);
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            var bytes = StrictUtf8.GetBytes(JsonSerializer.Serialize(entry, Json));
            if (bytes.Length > MaximumEntryBytes)
                throw new InvalidDataException("The start journal entry is too large.");
            using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 4096,
                FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    internal IDisposable? TryAcquireActiveLock(string operationId, string jobId)
    {
        ValidateOperationId(operationId);
        ValidateSafeId(jobId, "job id");
        Directory.CreateDirectory(root);
        EnsureNoReparsePoints(root);
        FileStream? stream = null;
        try
        {
            stream = new FileStream(
                Path.Combine(root, "active-download.lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.WriteThrough);
            stream.SetLength(0);
            var owner = StrictUtf8.GetBytes(JsonSerializer.Serialize(
                new ActiveLockOwner(operationId, jobId),
                Json));
            stream.Write(owner);
            stream.Flush(flushToDisk: true);
            stream.Position = 0;
            return stream;
        }
        catch (IOException)
        {
            stream?.Dispose();
            return null;
        }
        catch
        {
            stream?.Dispose();
            throw;
        }
    }

    internal ActiveLockOwner? ReadActiveOwner()
    {
        try
        {
            using var stream = new FileStream(
                Path.Combine(root, "active-download.lock"),
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite,
                bufferSize: 4096,
                FileOptions.SequentialScan);
            if (stream.Length is <= 0 or > MaximumEntryBytes) return null;
            var bytes = new byte[(int)stream.Length];
            stream.ReadExactly(bytes);
            var owner = JsonSerializer.Deserialize<ActiveLockOwner>(StrictUtf8.GetString(bytes), Json);
            if (owner is null || !SafeId.IsMatch(owner.OperationId) || !SafeId.IsMatch(owner.JobId))
                return null;
            return owner;
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or JsonException
            or DecoderFallbackException)
        {
            return null;
        }
    }

    private void PruneBeforeWrite(string targetPath)
    {
        var files = Directory.EnumerateFiles(root, "*.json", SearchOption.TopDirectoryOnly)
            .Take(MaximumEnumeratedEntries + 1)
            .Select(path => new FileInfo(path))
            .ToList();
        if (files.Count > MaximumEnumeratedEntries)
            throw new IOException("The start journal contains too many entries.");
        if (files.Any(file => string.Equals(file.FullName, targetPath, StringComparison.OrdinalIgnoreCase)))
            return;

        foreach (var file in files.OrderBy(file => file.LastWriteTimeUtc).ToArray())
        {
            if (files.Count < MaximumEntries) break;
            try
            {
                var entry = ReadEntryFile(file.FullName);
                if (!entry.Terminal) continue;
                File.Delete(file.FullName);
                files.Remove(file);
            }
            catch
            {
                // Unreadable entries remain fail-closed and count against the journal limit.
            }
        }

        if (files.Count >= MaximumEntries)
            throw new IOException("The start journal reached its durable entry limit.");
    }

    private static StartOperationJournalEntry ReadEntryFile(string path)
    {
        var bytes = File.ReadAllBytes(path);
        if (bytes.Length is <= 0 or > MaximumEntryBytes)
            throw new InvalidDataException("The start journal entry has an invalid size.");
        return JsonSerializer.Deserialize<StartOperationJournalEntry>(StrictUtf8.GetString(bytes), Json)
            ?? throw new InvalidDataException("The start journal entry is empty.");
    }

    private string EntryPath(string operationId)
    {
        var digest = Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(operationId)))
            .ToLowerInvariant();
        return Path.Combine(root, $"{digest}.json");
    }

    private static void ValidateEntry(StartOperationJournalEntry entry)
    {
        if (entry.SchemaVersion != SchemaVersion) throw new InvalidDataException("Unsupported start journal schema.");
        ValidateOperationId(entry.OperationId);
        ValidateSafeId(entry.JobId, "job id");
        if (!MediaPage.TryCanonicalize(entry.Url, out var page)
            || !string.Equals(page!.CanonicalUrl, entry.Url, StringComparison.Ordinal)
            || entry.Height is < 144 or > 4320)
        {
            throw new InvalidDataException("The start journal payload is invalid.");
        }
        if (entry.DestinationFolder is not null)
        {
            try
            {
                if (!string.Equals(
                    DownloadPaths.NormalizeDestination(entry.DestinationFolder),
                    entry.DestinationFolder,
                    StringComparison.Ordinal))
                {
                    throw new InvalidDataException("The start journal destination is invalid.");
                }
            }
            catch (ArgumentException exception)
            {
                throw new InvalidDataException("The start journal destination is invalid.", exception);
            }
        }
        if (entry.Snapshot is null
            || !string.Equals(entry.Snapshot.JobId, entry.JobId, StringComparison.Ordinal)
            || !string.Equals(entry.Snapshot.OperationId, entry.OperationId, StringComparison.Ordinal)
            || entry.Snapshot.Height != entry.Height
            || !AllowedStages.Contains(entry.Snapshot.Stage)
            || entry.Snapshot.Percent is < 0 or > 100
            || entry.Snapshot.DownloadedBytes is < 0
            || entry.Snapshot.TotalBytes is < 0
            || entry.Snapshot.SpeedBytesPerSecond is < 0
            || entry.Snapshot.EtaSeconds is < 0
            || entry.Snapshot.VideoId is null or { Length: > 128 }
            || entry.Snapshot.VideoId.Any(char.IsControl)
            || entry.Snapshot.Title is null or { Length: > 512 }
            || entry.Snapshot.Title.Any(char.IsControl)
            || (entry.Snapshot.ErrorCode is not null
                && !SafeErrorCode.IsMatch(entry.Snapshot.ErrorCode))
            || entry.Terminal != IsTerminal(entry.Snapshot))
        {
            throw new InvalidDataException("The start journal snapshot is invalid.");
        }
        if (entry.Snapshot.Path is not null)
        {
            try
            {
                if (!string.Equals(
                    DownloadPaths.NormalizeDestination(entry.Snapshot.Path),
                    entry.Snapshot.Path,
                    StringComparison.Ordinal))
                {
                    throw new InvalidDataException("The start journal path is invalid.");
                }
            }
            catch (ArgumentException exception)
            {
                throw new InvalidDataException("The start journal path is invalid.", exception);
            }
        }
    }

    private static bool IsTerminal(JobSnapshot snapshot) =>
        snapshot.Stage is "complete" or "failed" or "cancelled";

    private static void ValidateOperationId(string operationId) =>
        ValidateSafeId(operationId, "operation id");

    private static void ValidateSafeId(string value, string description)
    {
        if (string.IsNullOrWhiteSpace(value) || !SafeId.IsMatch(value))
            throw new ArgumentException($"Invalid {description}.", nameof(value));
    }

    private static void EnsureNoReparsePoints(string path)
    {
        for (var current = path; current is not null; current = Directory.GetParent(current)?.FullName)
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("The start journal cannot traverse reparse points.");
        }
    }

    internal sealed record ActiveLockOwner(string OperationId, string JobId);
}

internal sealed record StartOperationJournalEntry(
    int SchemaVersion,
    string OperationId,
    string JobId,
    string Url,
    int Height,
    string? DestinationFolder,
    JobSnapshot Snapshot,
    bool Terminal,
    DateTimeOffset UpdatedAt)
{
    public static StartOperationJournalEntry Create(
        string operationId,
        string jobId,
        string url,
        int height,
        string? destinationFolder,
        JobSnapshot snapshot) =>
        new(
            1,
            operationId,
            jobId,
            url,
            height,
            destinationFolder,
            snapshot,
            snapshot.Stage is "complete" or "failed" or "cancelled",
            DateTimeOffset.UtcNow);
}
