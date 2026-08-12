using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Media;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Host;

public static class DownloadQueueStates
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string Paused = "paused";
    public const string Complete = "complete";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";

    public static bool IsTerminal(string state) =>
        state is Complete or Failed or Cancelled;
}

public sealed record DownloadQueueEntry(
    int SchemaVersion,
    string OperationId,
    string JobId,
    string Url,
    DownloadSelection Selection,
    string? DestinationFolder,
    string State,
    JobSnapshot Snapshot,
    bool ResumePartial,
    int AttemptCount,
    long Sequence,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt)
{
    public bool Terminal => DownloadQueueStates.IsTerminal(State);
    public int SnapshotHeight => Selection.Height ?? 0;

    public static DownloadQueueEntry Create(
        string operationId,
        string jobId,
        string url,
        DownloadSelection selection,
        string? destinationFolder,
        long sequence,
        string? videoId = null,
        string? title = null)
    {
        var now = DateTimeOffset.UtcNow;
        return new DownloadQueueEntry(
            1,
            operationId,
            jobId,
            url,
            selection,
            destinationFolder,
            DownloadQueueStates.Queued,
            new JobSnapshot(
                jobId,
                videoId ?? string.Empty,
                title ?? string.Empty,
                selection.Height ?? 0,
                DownloadQueueStates.Queued,
                null,
                null,
                null,
                operationId),
            false,
            0,
            sequence,
            now,
            now);
    }
}

public sealed record DownloadQueueEnqueueResult(
    DownloadQueueEntry Entry,
    bool Replayed,
    int? Position);

/// <summary>
/// A bounded, per-user durable queue. Each entry is independently replaced so a
/// power loss cannot truncate the complete queue. A short-lived mutation lease
/// serializes read/modify/write cycles across native-host processes.
/// </summary>
public sealed class DownloadQueueStore
{
    private const int SchemaVersion = 1;
    public const int MaximumEntries = 64;
    public const int MaximumNonTerminalEntries = 32;
    private const int MaximumEnumeratedEntries = 256;
    private const int MaximumEntryBytes = 64 * 1024;
    private const long MaximumJavaScriptSafeInteger = 9_007_199_254_740_991;
    private static readonly TimeSpan MutationLeaseTimeout = TimeSpan.FromSeconds(2);
    private static readonly Regex SafeId =
        new("^[A-Za-z0-9._:-]{1,128}$", RegexOptions.CultureInvariant);
    private static readonly Regex SafeErrorCode =
        new("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> States = new(StringComparer.Ordinal)
    {
        DownloadQueueStates.Queued,
        DownloadQueueStates.Running,
        DownloadQueueStates.Paused,
        DownloadQueueStates.Complete,
        DownloadQueueStates.Failed,
        DownloadQueueStates.Cancelled
    };
    private static readonly HashSet<string> RunningStages = new(StringComparer.Ordinal)
    {
        DownloadQueueStates.Running,
        "preparing",
        "download",
        "video",
        "audio",
        "merge",
        "finalize"
    };
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private readonly object inProcessLock = new();
    private readonly string root;

    public DownloadQueueStore(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        this.root = Path.GetFullPath(root);
        Directory.CreateDirectory(this.root);
        EnsureNoReparsePoints(this.root);
    }

    public static DownloadQueueStore CreateDefault()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
            throw new DirectoryNotFoundException("Local application data is unavailable.");
        return new DownloadQueueStore(Path.Combine(localAppData, "VideoRadar", "download-queue"));
    }

    public IReadOnlyList<DownloadQueueEntry> ReadAll() =>
        WithMutationLease(ReadAllUnsafe);

    public DownloadQueueEntry? ReadByJobId(string jobId)
    {
        ValidateSafeId(jobId, "job id");
        return WithMutationLease(() =>
            ReadAllUnsafe().SingleOrDefault(entry =>
                string.Equals(entry.JobId, jobId, StringComparison.Ordinal)));
    }

    public DownloadQueueEnqueueResult Enqueue(
        string operationId,
        string jobId,
        string url,
        DownloadSelection selection,
        string? destinationFolder,
        string? videoId = null,
        string? title = null)
    {
        ValidateSafeId(operationId, "operation id");
        ValidateSafeId(jobId, "job id");
        return WithMutationLease(() =>
        {
            var entries = ReadAllUnsafe().ToList();
            var existing = entries.SingleOrDefault(entry =>
                string.Equals(entry.OperationId, operationId, StringComparison.Ordinal));
            if (existing is not null)
            {
                EnsureMatchingPayload(existing, url, selection, destinationFolder, videoId, title);
                if (videoId is not null
                    && string.IsNullOrEmpty(existing.Snapshot.VideoId)
                    && string.IsNullOrEmpty(existing.Snapshot.Title))
                {
                    var enriched = existing with
                    {
                        Snapshot = existing.Snapshot with { VideoId = videoId, Title = title! },
                        UpdatedAt = DateTimeOffset.UtcNow
                    };
                    ValidateEntry(enriched);
                    WriteUnsafe(enriched);
                    var enrichedIndex = entries.FindIndex(entry =>
                        string.Equals(entry.JobId, existing.JobId, StringComparison.Ordinal));
                    entries[enrichedIndex] = enriched;
                    existing = enriched;
                }
                if (existing.State == DownloadQueueStates.Failed)
                {
                    if (entries.Count(entry => !entry.Terminal) >= MaximumNonTerminalEntries)
                        throw new DownloadQueueFullException();
                    var retried = existing with
                    {
                        State = DownloadQueueStates.Queued,
                        Snapshot = existing.Snapshot with
                        {
                            Stage = DownloadQueueStates.Queued,
                            ErrorCode = null,
                            Path = null,
                            OperationId = existing.OperationId
                        },
                        ResumePartial = true,
                        UpdatedAt = DateTimeOffset.UtcNow
                    };
                    ValidateEntry(retried);
                    WriteUnsafe(retried);
                    var index = entries.FindIndex(entry =>
                        string.Equals(entry.JobId, existing.JobId, StringComparison.Ordinal));
                    entries[index] = retried;
                    return new DownloadQueueEnqueueResult(
                        retried,
                        true,
                        QueuePosition(entries, retried));
                }
                return new DownloadQueueEnqueueResult(
                    existing,
                    true,
                    QueuePosition(entries, existing));
            }

            if (entries.Count(entry => !entry.Terminal) >= MaximumNonTerminalEntries)
                throw new DownloadQueueFullException();

            PruneTerminalEntries(entries);
            var sequence = entries.Count == 0
                ? 1
                : checked(entries.Max(entry => entry.Sequence) + 1);
            var created = DownloadQueueEntry.Create(
                operationId,
                jobId,
                url,
                selection,
                destinationFolder,
                sequence,
                videoId,
                title);
            ValidateEntry(created);
            WriteUnsafe(created);
            entries.Add(created);
            return new DownloadQueueEnqueueResult(
                created,
                false,
                QueuePosition(entries, created));
        });
    }

    public DownloadQueueEntry Update(
        string jobId,
        Func<DownloadQueueEntry, DownloadQueueEntry> update)
    {
        ValidateSafeId(jobId, "job id");
        ArgumentNullException.ThrowIfNull(update);
        return WithMutationLease(() =>
        {
            var entry = ReadAllUnsafe().SingleOrDefault(candidate =>
                string.Equals(candidate.JobId, jobId, StringComparison.Ordinal))
                ?? throw new DownloadQueueJobNotFoundException();
            var updated = update(entry) with
            {
                SchemaVersion = SchemaVersion,
                OperationId = entry.OperationId,
                JobId = entry.JobId,
                Url = entry.Url,
                Selection = entry.Selection,
                DestinationFolder = entry.DestinationFolder,
                Sequence = entry.Sequence,
                CreatedAt = entry.CreatedAt,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            ValidateTransition(entry, updated);
            ValidateEntry(updated);
            WriteUnsafe(updated);
            return updated;
        });
    }

    public DownloadQueueEntry? TryMarkCompletedOutputMismatch(
        string jobId,
        string expectedPath)
    {
        ValidateSafeId(jobId, "job id");
        ValidateDestination(expectedPath);
        return WithMutationLease(() =>
        {
            var entry = ReadAllUnsafe().SingleOrDefault(candidate =>
                string.Equals(candidate.JobId, jobId, StringComparison.Ordinal));
            if (entry is null
                || entry.State != DownloadQueueStates.Complete
                || !string.Equals(
                    entry.Snapshot.Path,
                    expectedPath,
                    StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            var failed = entry with
            {
                State = DownloadQueueStates.Failed,
                Snapshot = entry.Snapshot with
                {
                    Stage = DownloadQueueStates.Failed,
                    Path = null,
                    ErrorCode = "OUTPUT_OWNERSHIP_MISMATCH"
                },
                ResumePartial = true,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            ValidateEntry(failed);
            WriteUnsafe(failed);
            return failed;
        });
    }

    public DownloadQueueEntry? TryFinalizeCompletedOutput(
        string jobId,
        string expectedPath)
    {
        ValidateSafeId(jobId, "job id");
        ValidateDestination(expectedPath);
        return WithMutationLease(() =>
        {
            var entry = ReadAllUnsafe().SingleOrDefault(candidate =>
                string.Equals(candidate.JobId, jobId, StringComparison.Ordinal));
            if (entry is null
                || entry.State != DownloadQueueStates.Complete
                || !string.Equals(
                    entry.Snapshot.Path,
                    expectedPath,
                    StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            if (!entry.ResumePartial) return entry;
            var finalized = entry with
            {
                ResumePartial = false,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            ValidateEntry(finalized);
            WriteUnsafe(finalized);
            return finalized;
        });
    }

    public bool IsCompletedOutputStillCurrent(string jobId, string expectedPath)
    {
        ValidateSafeId(jobId, "job id");
        ValidateDestination(expectedPath);
        return WithMutationLease(() =>
        {
            var entry = ReadAllUnsafe().SingleOrDefault(candidate =>
                string.Equals(candidate.JobId, jobId, StringComparison.Ordinal));
            return entry is not null
                && entry.State == DownloadQueueStates.Complete
                && string.Equals(
                    entry.Snapshot.Path,
                    expectedPath,
                    StringComparison.OrdinalIgnoreCase);
        });
    }

    public IReadOnlyList<DownloadQueueEntry> ReconcileAfterRestart()
    {
        return WithMutationLease(() =>
        {
            var entries = ReadAllUnsafe().ToList();
            for (var index = 0; index < entries.Count; index++)
            {
                var entry = entries[index];
                if (!string.Equals(entry.State, DownloadQueueStates.Running, StringComparison.Ordinal))
                    continue;

                // A second Chrome connection can briefly overlap the old native
                // host. Only recover a running entry after proving that no process
                // still owns its runner lease.
                using var abandonedRunner = TryAcquireRunnerLease(
                    entry.OperationId,
                    entry.JobId);
                if (abandonedRunner is null) continue;

                var reconciled = entry with
                {
                    State = DownloadQueueStates.Queued,
                    Snapshot = entry.Snapshot with
                    {
                        Stage = DownloadQueueStates.Queued,
                        ErrorCode = null,
                        OperationId = entry.OperationId
                    },
                    ResumePartial = true,
                    UpdatedAt = DateTimeOffset.UtcNow
                };
                ValidateEntry(reconciled);
                WriteUnsafe(reconciled);
                entries[index] = reconciled;
            }
            return Order(entries);
        });
    }

    public IDisposable? TryAcquireRunnerLease(string operationId, string jobId)
    {
        ValidateSafeId(operationId, "operation id");
        ValidateSafeId(jobId, "job id");
        Directory.CreateDirectory(root);
        EnsureNoReparsePoints(root);
        FileStream? stream = null;
        try
        {
            stream = new FileStream(
                Path.Combine(root, "active-runner.lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.WriteThrough);
            stream.SetLength(0);
            var owner = StrictUtf8.GetBytes(JsonSerializer.Serialize(
                new RunnerLeaseOwner(operationId, jobId),
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

    private T WithMutationLease<T>(Func<T> action)
    {
        lock (inProcessLock)
        {
            Directory.CreateDirectory(root);
            EnsureNoReparsePoints(root);
            var stopwatch = Stopwatch.StartNew();
            while (true)
            {
                try
                {
                    using var lease = new FileStream(
                        Path.Combine(root, "mutation.lock"),
                        FileMode.OpenOrCreate,
                        FileAccess.ReadWrite,
                        FileShare.None,
                        bufferSize: 1,
                        FileOptions.None);
                    return action();
                }
                catch (IOException) when (stopwatch.Elapsed < MutationLeaseTimeout)
                {
                    Thread.Sleep(10);
                }
            }
        }
    }

    private IReadOnlyList<DownloadQueueEntry> ReadAllUnsafe()
    {
        var files = Directory.EnumerateFiles(root, "*.json", SearchOption.TopDirectoryOnly)
            .Take(MaximumEnumeratedEntries + 1)
            .ToArray();
        if (files.Length > MaximumEnumeratedEntries)
            throw new IOException("The download queue contains too many files.");

        var entries = new List<DownloadQueueEntry>(files.Length);
        var operationIds = new HashSet<string>(StringComparer.Ordinal);
        var jobIds = new HashSet<string>(StringComparer.Ordinal);
        var sequences = new HashSet<long>();
        foreach (var path in files)
        {
            var entry = ReadEntryUnsafe(path);
            ValidateEntry(entry);
            if (!string.Equals(path, EntryPath(entry.OperationId), StringComparison.OrdinalIgnoreCase)
                || !operationIds.Add(entry.OperationId)
                || !jobIds.Add(entry.JobId)
                || !sequences.Add(entry.Sequence))
            {
                throw new InvalidDataException("The download queue contains conflicting entries.");
            }
            entries.Add(entry);
        }

        if (entries.Count > MaximumEntries)
            throw new IOException("The download queue exceeds its durable entry limit.");
        return Order(entries);
    }

    private DownloadQueueEntry ReadEntryUnsafe(string path)
    {
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 4096,
            FileOptions.SequentialScan);
        if (stream.Length is <= 0 or > MaximumEntryBytes)
            throw new InvalidDataException("The download queue entry has an invalid size.");
        var bytes = new byte[(int)stream.Length];
        stream.ReadExactly(bytes);
        try
        {
            return JsonSerializer.Deserialize<DownloadQueueEntry>(StrictUtf8.GetString(bytes), Json)
                ?? throw new InvalidDataException("The download queue entry is empty.");
        }
        catch (Exception exception) when (
            exception is JsonException or NotSupportedException or DecoderFallbackException)
        {
            throw new InvalidDataException("The download queue entry is invalid.", exception);
        }
    }

    private void WriteUnsafe(DownloadQueueEntry entry)
    {
        var path = EntryPath(entry.OperationId);
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            var bytes = StrictUtf8.GetBytes(JsonSerializer.Serialize(entry, Json));
            if (bytes.Length > MaximumEntryBytes)
                throw new InvalidDataException("The download queue entry is too large.");
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

    private void PruneTerminalEntries(List<DownloadQueueEntry> entries)
    {
        while (entries.Count >= MaximumEntries)
        {
            var oldestTerminal = entries
                // Failed entries can still own resumable data under their durable
                // job id. Never prune that identity before the user retries or
                // explicitly cancels it. A cancelled entry is safe to prune only
                // after its partials were discarded successfully.
                .Where(entry => (entry.State == DownloadQueueStates.Complete && !entry.ResumePartial)
                    || (entry.State == DownloadQueueStates.Cancelled && !entry.ResumePartial))
                .OrderBy(entry => entry.UpdatedAt)
                .ThenBy(entry => entry.Sequence)
                .FirstOrDefault()
                ?? throw new DownloadQueueFullException();
            File.Delete(EntryPath(oldestTerminal.OperationId));
            entries.Remove(oldestTerminal);
        }
    }

    private static int? QueuePosition(
        IEnumerable<DownloadQueueEntry> entries,
        DownloadQueueEntry target)
    {
        if (target.State is not (DownloadQueueStates.Queued or DownloadQueueStates.Running))
            return null;
        var pending = entries
            .Where(entry => entry.State is DownloadQueueStates.Queued or DownloadQueueStates.Running)
            .OrderBy(entry => entry.State == DownloadQueueStates.Running ? 0 : 1)
            .ThenBy(entry => entry.Sequence)
            .ToArray();
        var index = Array.FindIndex(pending, entry =>
            string.Equals(entry.JobId, target.JobId, StringComparison.Ordinal));
        return index < 0 ? null : index + 1;
    }

    private static IReadOnlyList<DownloadQueueEntry> Order(
        IEnumerable<DownloadQueueEntry> entries) =>
        entries
            .OrderBy(entry => entry.Terminal ? 1 : 0)
            .ThenBy(entry => entry.Sequence)
            .ToArray();

    private static void EnsureMatchingPayload(
        DownloadQueueEntry entry,
        string url,
        DownloadSelection selection,
        string? destinationFolder,
        string? videoId,
        string? title)
    {
        if (!string.Equals(entry.Url, url, StringComparison.Ordinal)
            || entry.Selection != selection
            || !string.Equals(
                entry.DestinationFolder,
                destinationFolder,
                StringComparison.OrdinalIgnoreCase)
            || (videoId is not null
                && (!string.IsNullOrEmpty(entry.Snapshot.VideoId)
                    || !string.IsNullOrEmpty(entry.Snapshot.Title))
                && (!string.Equals(entry.Snapshot.VideoId, videoId, StringComparison.Ordinal)
                    || !string.Equals(entry.Snapshot.Title, title, StringComparison.Ordinal))))
        {
            throw new DownloadQueuePayloadConflictException();
        }
    }

    private static void ValidateTransition(
        DownloadQueueEntry current,
        DownloadQueueEntry updated)
    {
        var discardingFailed = current.State == DownloadQueueStates.Failed
            && updated.State == DownloadQueueStates.Cancelled;
        if (current.Terminal
            && !discardingFailed
            && !string.Equals(current.State, updated.State, StringComparison.Ordinal))
            throw new InvalidOperationException("A terminal queue entry cannot transition.");
        if (!string.Equals(updated.Snapshot.JobId, updated.JobId, StringComparison.Ordinal)
            || !string.Equals(updated.Snapshot.OperationId, updated.OperationId, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The queue snapshot identity cannot change.");
        }
    }

    private static void ValidateEntry(DownloadQueueEntry entry)
    {
        if (entry.SchemaVersion != SchemaVersion)
            throw new InvalidDataException("Unsupported download queue schema.");
        ValidateSafeId(entry.OperationId, "operation id");
        ValidateSafeId(entry.JobId, "job id");
        if (!MediaPage.TryCanonicalize(entry.Url, out var page)
            || !string.Equals(page!.CanonicalUrl, entry.Url, StringComparison.Ordinal)
            || !IsValidSelection(entry.Selection)
            || !States.Contains(entry.State)
            || entry.AttemptCount is < 0 or > 100
            || entry.Sequence <= 0
            || entry.CreatedAt == default
            || entry.UpdatedAt < entry.CreatedAt)
        {
            throw new InvalidDataException("The download queue payload is invalid.");
        }
        ValidateDestination(entry.DestinationFolder);
        var snapshot = entry.Snapshot;
        if (snapshot is null
            || !string.Equals(snapshot.JobId, entry.JobId, StringComparison.Ordinal)
            || !string.Equals(snapshot.OperationId, entry.OperationId, StringComparison.Ordinal)
            || snapshot.Height != entry.SnapshotHeight
            || snapshot.Stage is null or { Length: > 64 }
            || snapshot.Stage.Any(char.IsControl)
            || snapshot.Percent is < 0 or > 100
            || snapshot.DownloadedBytes is < 0 or > MaximumJavaScriptSafeInteger
            || snapshot.TotalBytes is < 0 or > MaximumJavaScriptSafeInteger
            || snapshot.SpeedBytesPerSecond is < 0 or > MaximumJavaScriptSafeInteger
            || snapshot.EtaSeconds is < 0
            || snapshot.VideoId is null or { Length: > 128 }
            || snapshot.VideoId.Any(char.IsControl)
            || snapshot.Title is null or { Length: > 512 }
            || snapshot.Title.Any(char.IsControl)
            || (snapshot.ErrorCode is not null && !SafeErrorCode.IsMatch(snapshot.ErrorCode)))
        {
            throw new InvalidDataException("The download queue snapshot is invalid.");
        }
        ValidateDestination(snapshot.Path);
        if (!IsStateStageConsistent(entry.State, snapshot.Stage))
            throw new InvalidDataException("The download queue state and stage are inconsistent.");
        if ((entry.State == DownloadQueueStates.Complete
                && (snapshot.Path is null || snapshot.Percent != 100 || snapshot.ErrorCode is not null))
            || (entry.State == DownloadQueueStates.Failed && snapshot.ErrorCode is null)
            || (entry.State != DownloadQueueStates.Failed && snapshot.ErrorCode is not null)
            || (entry.State != DownloadQueueStates.Complete && snapshot.Path is not null))
        {
            throw new InvalidDataException("The download queue terminal payload is inconsistent.");
        }
        if (entry.Terminal != (entry.State is DownloadQueueStates.Complete
            or DownloadQueueStates.Failed
            or DownloadQueueStates.Cancelled))
        {
            throw new InvalidDataException("The download queue terminal state is inconsistent.");
        }
    }

    private static bool IsStateStageConsistent(string state, string stage) => state switch
    {
        DownloadQueueStates.Running => RunningStages.Contains(stage),
        DownloadQueueStates.Queued => stage == DownloadQueueStates.Queued,
        DownloadQueueStates.Paused => stage == DownloadQueueStates.Paused,
        DownloadQueueStates.Complete => stage == DownloadQueueStates.Complete,
        DownloadQueueStates.Failed => stage == DownloadQueueStates.Failed,
        DownloadQueueStates.Cancelled => stage == DownloadQueueStates.Cancelled,
        _ => false
    };

    private static bool IsValidSelection(DownloadSelection? selection)
    {
        if (selection is null) return false;
        if (selection.AudioOnly)
        {
            if (selection.Height is not null || selection.SubtitleLanguage is not null) return false;
        }
        else if (selection.Height is < 144 or > 4320)
        {
            return false;
        }
        if (selection.SubtitleLanguage is null)
            return !selection.IncludeAutomaticSubtitles;
        if (selection.SubtitleLanguage.Length is < 1 or > 35) return false;
        var languageParts = selection.SubtitleLanguage.Split('-', StringSplitOptions.None);
        return languageParts.Length is >= 1 and <= 4
            && languageParts.All(part =>
                part.Length is >= 1 and <= 8
                && part.All(char.IsAsciiLetterOrDigit));
    }

    private static void ValidateDestination(string? path)
    {
        if (path is null) return;
        try
        {
            if (!string.Equals(
                DownloadPaths.NormalizeDestination(path),
                path,
                StringComparison.Ordinal))
            {
                throw new InvalidDataException("The queue path is invalid.");
            }
        }
        catch (ArgumentException exception)
        {
            throw new InvalidDataException("The queue path is invalid.", exception);
        }
    }

    private string EntryPath(string operationId)
    {
        var digest = Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(operationId)))
            .ToLowerInvariant();
        return Path.Combine(root, $"{digest}.json");
    }

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
                throw new IOException("The download queue cannot traverse reparse points.");
        }
    }

    private sealed record RunnerLeaseOwner(string OperationId, string JobId);
}

public sealed class DownloadQueueFullException : Exception
{
}

public sealed class DownloadQueueJobNotFoundException : Exception
{
}

public sealed class DownloadQueuePayloadConflictException : Exception
{
}
