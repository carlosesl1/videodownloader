using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using VideoRadar.NativeHost.Windows;

namespace VideoRadar.NativeHost.Files;

public sealed class DownloadFileMover : IDownloadFileMover
{
    private const long MaximumJournalBytes = 16 * 1024;
    private const int HashBufferBytes = 1024 * 1024;
    private static readonly TimeSpan OperationLockTimeout = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan DeliveryLockTimeout = TimeSpan.FromMinutes(30);
    private static readonly Regex SafeOperationId =
        new("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Digest =
        new("^[A-Fa-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);
    private readonly IFileTransfer transfer;
    private readonly ExplorerFileRevealer fileRevealer;
    private readonly string journalRoot;
    private static readonly JsonSerializerOptions JournalJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public DownloadFileMover()
        : this(new FileTransfer(), new ExplorerFileRevealer(), DefaultJournalRoot())
    {
    }

    internal DownloadFileMover(IFileTransfer transfer)
        : this(transfer, new ExplorerFileRevealer(), DefaultJournalRoot())
    {
    }

    internal DownloadFileMover(IFileTransfer transfer, ExplorerFileRevealer fileRevealer)
        : this(transfer, fileRevealer, DefaultJournalRoot())
    {
    }

    internal DownloadFileMover(
        IFileTransfer transfer,
        ExplorerFileRevealer fileRevealer,
        string journalRoot)
    {
        this.transfer = transfer ?? throw new ArgumentNullException(nameof(transfer));
        this.fileRevealer = fileRevealer ?? throw new ArgumentNullException(nameof(fileRevealer));
        ArgumentException.ThrowIfNullOrWhiteSpace(journalRoot);
        this.journalRoot = Path.GetFullPath(journalRoot);
    }

    public FileMoveResult Move(string sourcePath, string destinationFolder, long downloadId)
    {
        if (downloadId < 0)
            throw new ArgumentOutOfRangeException(nameof(downloadId));

        var (source, destination) = ValidatePaths(sourcePath, destinationFolder);

        Directory.CreateDirectory(destination);
        ValidateNoReparsePoints(destination, nameof(destinationFolder));
        EnsureWritable(destination);
        var finalPath = ReserveFinalPath(destination, Path.GetFileName(source));

        Deliver(source, finalPath);
        return new FileMoveResult(downloadId, finalPath);
    }

    public FileMoveResult Move(
        string sourcePath,
        string destinationFolder,
        long downloadId,
        string operationId)
    {
        if (downloadId < 0)
            throw new ArgumentOutOfRangeException(nameof(downloadId));
        if (string.IsNullOrWhiteSpace(operationId)
            || !SafeOperationId.IsMatch(operationId)
            || IsWindowsDeviceName(operationId))
            throw new ArgumentException("Invalid operation id.", nameof(operationId));

        var source = DownloadPaths.NormalizeDestination(sourcePath, nameof(sourcePath));
        ValidateStagingStructure(source);
        ValidateStagingOperation(source, operationId);
        var destination = DownloadPaths.NormalizeDestination(destinationFolder, nameof(destinationFolder));
        Directory.CreateDirectory(journalRoot);
        ValidateNoReparsePoints(journalRoot, nameof(journalRoot));

        using var operationLock = AcquireLock(OperationLockPath(operationId), OperationLockTimeout);
        var journalPath = Path.Combine(journalRoot, $"{operationId}.json");
        Directory.CreateDirectory(destination);
        ValidateNoReparsePoints(destination, nameof(destinationFolder));
        using var destinationLock = AcquireLock(
            Path.Combine(journalRoot, "global-delivery.lock"),
            DeliveryLockTimeout);

        var existing = ReadJournal(journalPath);
        if (existing is not null)
        {
            EnsureSameOperation(existing, operationId, downloadId, source, destination);
            existing = EnsureJournalHash(existing, journalPath);
            if (TryRecoverCommitted(existing, journalPath, out var recovered)) return recovered;
        }

        ValidateExistingStagingSource(source);
        var sourceLength = new FileInfo(source).Length;
        if (existing is not null && sourceLength != existing.SourceLength)
            throw new IOException("The staging source changed after the delivery was prepared.");
        var sourceSha256 = ComputeSha256(source);
        if (existing?.SourceSha256 is not null
            && !string.Equals(existing.SourceSha256, sourceSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("The staging source changed after the delivery was prepared.");
        }

        EnsureWritable(destination);
        var finalPath = existing?.FinalPath
            ?? ReserveFinalPath(destination, Path.GetFileName(source));
        var prepared = existing ?? new MoveJournalEntry(
            operationId,
            downloadId,
            source,
            destination,
            finalPath,
            sourceLength,
            sourceSha256,
            "prepared",
            DateTimeOffset.UtcNow);
        WriteJournal(journalPath, prepared);

        Deliver(source, finalPath);
        var committed = prepared with { State = "committed", UpdatedAt = DateTimeOffset.UtcNow };
        WriteJournal(journalPath, committed);
        PruneJournalBestEffort();
        return new FileMoveResult(downloadId, finalPath);
    }

    private (string Source, string Destination) ValidatePaths(
        string sourcePath,
        string destinationFolder)
    {
        var source = DownloadPaths.NormalizeDestination(sourcePath, nameof(sourcePath));
        ValidateStagingStructure(source);
        ValidateExistingStagingSource(source);
        var destination = DownloadPaths.NormalizeDestination(destinationFolder, nameof(destinationFolder));
        return (source, destination);
    }

    private void Deliver(string source, string finalPath)
    {
        if (transfer.IsSameVolume(source, finalPath))
        {
            transfer.MoveSameVolume(source, finalPath);
            return;
        }

        CopyAcrossVolumes(source, finalPath);
    }

    public void Reveal(string path)
    {
        var canonical = DownloadPaths.NormalizeDestination(path, nameof(path));
        if (!File.Exists(canonical))
            throw new FileNotFoundException("Downloaded file was not found.", canonical);
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows Explorer is required.");

        fileRevealer.Reveal(canonical);
    }

    private static void ValidateStagingStructure(string source)
    {
        var fileName = Path.GetFileName(source);
        var operationDirectory = Directory.GetParent(source);
        var stagingDirectory = operationDirectory?.Parent;
        var videoRadarDirectory = stagingDirectory?.Parent;
        var browserDownloadRoot = videoRadarDirectory?.Parent;

        if (string.IsNullOrEmpty(fileName)
            || operationDirectory is null
            || stagingDirectory is null
            || videoRadarDirectory is null
            || browserDownloadRoot is null
            || !SafeOperationId.IsMatch(operationDirectory.Name)
            || !string.Equals(stagingDirectory.Name, ".staging", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(videoRadarDirectory.Name, "Video Radar", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Staging source has an invalid structure.", nameof(source));
        }
    }

    private static void ValidateStagingOperation(string source, string operationId)
    {
        var operationDirectory = Directory.GetParent(source);
        if (operationDirectory is null
            || !string.Equals(operationDirectory.Name, operationId, StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "Staging source does not belong to the delivery operation.",
                nameof(source));
        }
    }

    private void ValidateExistingStagingSource(string source)
    {
        if (!File.Exists(source))
            throw new ArgumentException("Staging source must be an existing file.", nameof(source));

        for (var current = source; current is not null;)
        {
            var attributes = transfer.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Staging source cannot traverse reparse points.", nameof(source));
            if (string.Equals(current, source, StringComparison.OrdinalIgnoreCase)
                && (attributes & FileAttributes.Directory) != 0)
            {
                throw new ArgumentException("Staging source must be a regular file.", nameof(source));
            }

            current = Directory.GetParent(current)?.FullName;
        }
    }

    private void ValidateNoReparsePoints(string path, string parameterName)
    {
        for (var current = path; current is not null; current = Directory.GetParent(current)?.FullName)
        {
            var attributes = transfer.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("The path cannot traverse reparse points.", parameterName);
        }
    }

    private bool TryRecoverCommitted(
        MoveJournalEntry entry,
        string journalPath,
        out FileMoveResult result)
    {
        result = default!;
        if (!File.Exists(entry.FinalPath)) return false;
        ValidateRegularFile(entry.FinalPath, "The committed destination is not a regular file.");
        ValidateNoReparsePoints(entry.FinalPath, "journal");
        var finalLength = new FileInfo(entry.FinalPath).Length;
        if (finalLength != entry.SourceLength)
            throw new IOException("The committed destination does not match the staged file.");
        var finalSha256 = ComputeSha256(entry.FinalPath);
        if (!string.Equals(entry.SourceSha256, finalSha256, StringComparison.OrdinalIgnoreCase))
            throw new IOException("The committed destination does not match the staged file.");

        if (File.Exists(entry.SourcePath))
        {
            ValidateExistingStagingSource(entry.SourcePath);
            var sourceLength = new FileInfo(entry.SourcePath).Length;
            if (sourceLength != entry.SourceLength)
                throw new IOException("The staging source changed after the delivery was prepared.");
            var sourceSha256 = ComputeSha256(entry.SourcePath);
            if (!string.Equals(entry.SourceSha256, sourceSha256, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The staging source changed after the delivery was prepared.");
            try { transfer.DeleteSource(entry.SourcePath); } catch (Exception exception) when (
                exception is IOException or UnauthorizedAccessException)
            {
                // The destination is already committed; cleanup can be retried later.
            }
        }

        if (!string.Equals(entry.State, "committed", StringComparison.Ordinal))
        {
            entry = entry with { State = "committed", UpdatedAt = DateTimeOffset.UtcNow };
            WriteJournal(journalPath, entry);
        }
        result = new FileMoveResult(entry.DownloadId, entry.FinalPath);
        return true;
    }

    private void ValidateRegularFile(string path, string message)
    {
        var attributes = transfer.GetAttributes(path);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new IOException(message);
    }

    private MoveJournalEntry EnsureJournalHash(MoveJournalEntry entry, string journalPath)
    {
        if (entry.SourceSha256 is not null) return entry;
        if (!File.Exists(entry.SourcePath))
        {
            throw new IOException(
                "A legacy delivery journal cannot authenticate its destination without the staging source.");
        }

        ValidateExistingStagingSource(entry.SourcePath);
        if (new FileInfo(entry.SourcePath).Length != entry.SourceLength)
            throw new IOException("The staging source changed after the delivery was prepared.");

        entry = entry with
        {
            SourceSha256 = ComputeSha256(entry.SourcePath),
            UpdatedAt = DateTimeOffset.UtcNow
        };
        WriteJournal(journalPath, entry);
        return entry;
    }

    private static string ComputeSha256(string path)
    {
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            HashBufferBytes,
            FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void EnsureSameOperation(
        MoveJournalEntry entry,
        string operationId,
        long downloadId,
        string source,
        string destination)
    {
        if (!string.Equals(entry.OperationId, operationId, StringComparison.Ordinal)
            || entry.DownloadId != downloadId
            || !string.Equals(entry.SourcePath, source, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(entry.DestinationFolder, destination, StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(entry.FinalPath)
            || !string.Equals(
                Path.GetDirectoryName(entry.FinalPath),
                destination,
                StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrEmpty(Path.GetFileName(entry.FinalPath))
            || (entry.State != "prepared" && entry.State != "committed")
            || entry.SourceLength < 0
            || (entry.SourceSha256 is not null && !Sha256Digest.IsMatch(entry.SourceSha256)))
        {
            throw new IOException("The delivery operation conflicts with its durable journal.");
        }
    }

    private static FileStream AcquireLock(string path, TimeSpan timeout)
    {
        if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        Directory.CreateDirectory(Path.GetDirectoryName(path)
            ?? throw new IOException("The delivery lock directory is unavailable."));
        IOException? lastError = null;
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                return new FileStream(
                    path,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.WriteThrough);
            }
            catch (IOException error)
            {
                lastError = error;
                if (stopwatch.Elapsed >= timeout) break;
                Thread.Sleep(50);
            }
        }
        throw new IOException("Another delivery operation did not release its lock.", lastError);
    }

    private static MoveJournalEntry? ReadJournal(string path)
    {
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
            if (stream.Length is <= 0 or > MaximumJournalBytes)
                throw new InvalidDataException("The delivery journal has an invalid size.");
            var bytes = new byte[(int)stream.Length];
            stream.ReadExactly(bytes);
            if (stream.ReadByte() != -1)
                throw new InvalidDataException("The delivery journal changed while it was read.");
            var json = StrictUtf8.GetString(bytes);
            return JsonSerializer.Deserialize<MoveJournalEntry>(json, JournalJson)
                ?? throw new InvalidDataException("The delivery journal is empty.");
        }
        catch (Exception exception) when (
            exception is JsonException or NotSupportedException or DecoderFallbackException)
        {
            throw new InvalidDataException("The delivery journal is invalid.", exception);
        }
    }

    private static void WriteJournal(string path, MoveJournalEntry entry)
    {
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            var json = JsonSerializer.Serialize(entry, JournalJson);
            using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 4096,
                FileOptions.WriteThrough))
            using (var writer = new StreamWriter(
                stream,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                bufferSize: 4096,
                leaveOpen: true))
            {
                writer.Write(json);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private void PruneJournalBestEffort()
    {
        try
        {
            var cutoff = DateTimeOffset.UtcNow.AddDays(-30);
            foreach (var file in Directory.EnumerateFiles(
                journalRoot,
                "*.json",
                SearchOption.TopDirectoryOnly))
            {
                try
                {
                    var information = new FileInfo(file);
                    if (information.LastWriteTimeUtc >= cutoff.UtcDateTime) continue;
                    var operationId = Path.GetFileNameWithoutExtension(file);
                    if (!SafeOperationId.IsMatch(operationId)) continue;
                    if (!TryAcquireLock(
                        OperationLockPath(operationId),
                        out var operationLock))
                    {
                        continue;
                    }

                    using (operationLock)
                    {
                        var entry = ReadJournal(file);
                        if (entry is not null
                            && string.Equals(entry.State, "committed", StringComparison.Ordinal)
                            && entry.UpdatedAt < cutoff
                            && !File.Exists(entry.SourcePath))
                        {
                            File.Delete(file);
                        }
                    }
                }
                catch
                {
                    // A busy, malformed, or inaccessible entry remains available for recovery.
                }
            }
        }
        catch
        {
            // Journal pruning is maintenance only and cannot invalidate a committed delivery.
        }
    }

    private static bool TryAcquireLock(string path, out FileStream? lockStream)
    {
        lockStream = null;
        try
        {
            lockStream = new FileStream(
                path,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None,
                bufferSize: 1,
                FileOptions.WriteThrough);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static string DefaultJournalRoot()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
            throw new DirectoryNotFoundException("Local application data is unavailable.");
        return Path.Combine(localAppData, "VideoRadar", "move-journal");
    }

    private string OperationLockPath(string operationId) =>
        Path.Combine(journalRoot, $"operation-{operationId}.lock");

    private static bool IsWindowsDeviceName(string value) =>
        value.Equals("CON", StringComparison.OrdinalIgnoreCase)
        || value.Equals("PRN", StringComparison.OrdinalIgnoreCase)
        || value.Equals("AUX", StringComparison.OrdinalIgnoreCase)
        || value.Equals("NUL", StringComparison.OrdinalIgnoreCase)
        || Enumerable.Range(1, 9).Any(index =>
            value.Equals($"COM{index}", StringComparison.OrdinalIgnoreCase)
            || value.Equals($"LPT{index}", StringComparison.OrdinalIgnoreCase));

    private static void EnsureWritable(string destination)
    {
        var probe = Path.Combine(destination, $".video-radar-{Guid.NewGuid():N}.probe");
        try
        {
            using var stream = new FileStream(
                probe,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 1,
                FileOptions.WriteThrough);
            stream.WriteByte(0);
            stream.Flush(flushToDisk: true);
        }
        finally
        {
            if (File.Exists(probe)) File.Delete(probe);
        }
    }

    private static string ReserveFinalPath(string destination, string fileName)
    {
        var extension = Path.GetExtension(fileName);
        var stem = Path.GetFileNameWithoutExtension(fileName);
        if (stem.Length == 0)
        {
            stem = fileName;
            extension = string.Empty;
        }

        for (var suffix = 0; ; suffix++)
        {
            var candidateName = suffix == 0
                ? fileName
                : $"{stem} ({suffix}){extension}";
            var candidate = Path.Combine(destination, candidateName);
            if (!File.Exists(candidate) && !Directory.Exists(candidate))
                return candidate;
        }
    }

    private void CopyAcrossVolumes(string source, string finalPath)
    {
        var destination = Path.GetDirectoryName(finalPath)
            ?? throw new IOException("Destination directory is unavailable.");
        var partial = Path.Combine(destination, $".video-radar-{Guid.NewGuid():N}.partial");

        try
        {
            transfer.CopyToPartial(source, partial);
            transfer.PromotePartial(partial, finalPath);
        }
        catch
        {
            try
            {
                transfer.DeletePartial(partial);
            }
            catch
            {
                // The staging source remains the recovery copy even if partial cleanup fails.
            }
            throw;
        }

        try
        {
            transfer.DeleteSource(source);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Delivery is already complete. Keeping staging is safer than making a retry duplicate it.
        }
    }

    private sealed class FileTransfer : IFileTransfer
    {
        public FileAttributes GetAttributes(string path) => File.GetAttributes(path);

        public bool IsSameVolume(string source, string destination)
        {
            var sourceRoot = Path.GetPathRoot(source);
            var destinationRoot = Path.GetPathRoot(destination);
            return !string.IsNullOrEmpty(sourceRoot)
                && !string.IsNullOrEmpty(destinationRoot)
                && string.Equals(sourceRoot, destinationRoot, StringComparison.OrdinalIgnoreCase);
        }

        public void MoveSameVolume(string source, string destination) =>
            File.Move(source, destination, overwrite: false);

        public void CopyToPartial(string source, string partial)
        {
            using var sourceStream = new FileStream(
                source,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 1024 * 1024,
                FileOptions.SequentialScan);
            using var partialStream = new FileStream(
                partial,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 1024 * 1024,
                FileOptions.SequentialScan);
            sourceStream.CopyTo(partialStream);
            partialStream.Flush(flushToDisk: true);
        }

        public void PromotePartial(string partial, string destination) =>
            File.Move(partial, destination, overwrite: false);

        public void DeleteSource(string source) => File.Delete(source);

        public void DeletePartial(string partial)
        {
            if (File.Exists(partial)) File.Delete(partial);
        }
    }

    private sealed record MoveJournalEntry(
        string OperationId,
        long DownloadId,
        string SourcePath,
        string DestinationFolder,
        string FinalPath,
        long SourceLength,
        string? SourceSha256,
        string State,
        DateTimeOffset UpdatedAt);
}
