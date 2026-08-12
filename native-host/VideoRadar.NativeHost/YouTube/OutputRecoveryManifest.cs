using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using VideoRadar.NativeHost.Files;

namespace VideoRadar.NativeHost.YouTube;

/// <summary>
/// Durable ownership record for the exact output names reserved by one job.
/// The record is created before yt-dlp starts and survives until the queue's
/// terminal state has been committed.
/// </summary>
internal sealed partial class OutputRecoveryManifest
{
    private const int SchemaVersion = 2;
    private const int MaximumManifestBytes = 32 * 1024;
    private const string FileName = "output-manifest.json";
    private const string Prepared = "prepared";
    private const string Reported = "reported";
    private const string Validated = "validated";
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private static readonly HashSet<string> States =
        [Prepared, Reported, Validated];
    private static readonly HashSet<string> ManifestProperties =
    [
        "schemaVersion", "jobId", "mediaId", "identityHash", "ownershipToken",
        "ownershipHash", "stem", "ownedFileNames", "fileFingerprints",
        "finalFileName", "state", "createdAt", "updatedAt"
    ];

    private readonly string home;
    private readonly string jobTemp;
    private readonly string manifestPath;
    private ManifestData data;

    private OutputRecoveryManifest(
        string home,
        string jobTemp,
        string manifestPath,
        ManifestData data)
    {
        this.home = home;
        this.jobTemp = jobTemp;
        this.manifestPath = manifestPath;
        this.data = data;
    }

    public string Stem => data.Stem;

    public static OutputRecoveryManifest OpenOrCreate(
        IDownloadPaths paths,
        string jobTemp,
        string jobId,
        string canonicalUrl,
        string mediaId,
        DownloadSelection selection,
        Func<string> reserveStem)
    {
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentException.ThrowIfNullOrWhiteSpace(jobTemp);
        ArgumentException.ThrowIfNullOrWhiteSpace(jobId);
        ArgumentException.ThrowIfNullOrWhiteSpace(canonicalUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(mediaId);
        ArgumentNullException.ThrowIfNull(selection);
        ArgumentNullException.ThrowIfNull(reserveStem);

        var home = CanonicalDirectory(paths.Home, nameof(paths));
        var temp = CanonicalJobTemp(paths.TempRoot, jobTemp, jobId);
        var manifestPath = Path.Combine(temp, FileName);
        var identityHash = IdentityHash(jobId, canonicalUrl, mediaId, selection);
        if (File.Exists(manifestPath))
        {
            var existing = Read(manifestPath);
            Validate(existing, jobId, mediaId, identityHash, selection);
            EnsureOwnedNamesSafeForResume(home, existing);
            return new OutputRecoveryManifest(home, temp, manifestPath, existing);
        }

        var stem = reserveStem();
        if (!DownloadPaths.IsSafeOutputStem(stem))
            throw new InvalidDataException("The reserved output stem is invalid.");
        var ownedFileNames = ExpectedOwnedFileNames(stem, selection);
        EnsureOutputsAbsent(home, ownedFileNames);
        var now = DateTimeOffset.UtcNow;
        var ownershipToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32))
            .ToLowerInvariant();
        var created = new ManifestData(
            SchemaVersion,
            jobId,
            mediaId,
            identityHash,
            ownershipToken,
            string.Empty,
            stem,
            ownedFileNames,
            [],
            null,
            Prepared,
            now,
            now);
        created = created with { OwnershipHash = OwnershipHash(created) };

        var written = false;
        try
        {
            WriteAtomic(manifestPath, created, overwrite: false);
            written = true;
        }
        catch (IOException) when (File.Exists(manifestPath))
        {
            var concurrent = Read(manifestPath);
            Validate(concurrent, jobId, mediaId, identityHash, selection);
            EnsureOwnedNamesSafeForResume(home, concurrent);
            return new OutputRecoveryManifest(home, temp, manifestPath, concurrent);
        }
        finally
        {
            if (!written) paths.ReleaseStem(stem);
        }
        return new OutputRecoveryManifest(home, temp, manifestPath, created);
    }

    public string? FindRecoveryOutput()
    {
        // A file that appeared before after_move has no durable fingerprint and
        // must never be adopted merely because its name matches the reserved
        // stem. Prepared-name collisions are rejected by OpenOrCreate.
        if (data.FinalFileName is null) return null;
        var reported = OwnedPath(data.FinalFileName);
        if (!File.Exists(reported)) return null;
        RequireFingerprintMatch(reported, data.FinalFileName);
        return reported;
    }

    public void MarkOutput(string path)
    {
        var (_, name) = ValidateFinalPath(path);
        var fingerprints = new List<FileFingerprintData>();
        foreach (var ownedName in data.OwnedFileNames)
        {
            var ownedPath = OwnedPath(ownedName);
            if (!File.Exists(ownedPath)) continue;
            if (!IsSafeRegularFile(ownedPath))
                throw new InvalidDataException("An owned output path is not a regular file.");
            fingerprints.Add(Fingerprint(ownedPath, ownedName));
        }
        if (!fingerprints.Any(value =>
                string.Equals(value.Name, name, StringComparison.OrdinalIgnoreCase)))
        {
            // ValidateFinalPath already proved that the final path exists. This
            // guards an unexpected replacement/removal while fingerprints were
            // being collected.
            throw new OutputOwnershipMismatchException();
        }
        Update(data with
        {
            FileFingerprints = fingerprints
                .OrderBy(value => value.Name, StringComparer.Ordinal)
                .ToArray(),
            FinalFileName = name,
            State = Reported,
            UpdatedAt = DateTimeOffset.UtcNow
        });
    }

    public void MarkValidated(string path)
    {
        var (_, name) = ValidateFinalPath(path);
        if (data.FinalFileName is null
            || !string.Equals(data.FinalFileName, name, StringComparison.OrdinalIgnoreCase))
        {
            throw new OutputOwnershipMismatchException();
        }
        RequireFingerprintMatch(OwnedPath(name), name);
        Update(data with
        {
            State = Validated,
            UpdatedAt = DateTimeOffset.UtcNow
        });
    }

    public void DeleteOwnedOutputs()
    {
        // Delete only files whose current bytes still match a fingerprint taken
        // synchronously at after_move. An absent or replaced file is not owned
        // strongly enough to remove.
        foreach (var name in data.OwnedFileNames)
        {
            var path = OwnedPath(name);
            if (!File.Exists(path) && !Directory.Exists(path)) continue;
            var fingerprint = data.FileFingerprints.SingleOrDefault(candidate =>
                string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase));
            if (fingerprint is null || !FingerprintMatches(path, fingerprint))
                throw new OutputOwnershipMismatchException();
        }
        foreach (var fingerprint in data.FileFingerprints)
        {
            var path = OwnedPath(fingerprint.Name);
            if (!File.Exists(path)) continue;
            // Re-check immediately before deletion to narrow the unavoidable
            // path-based TOCTOU window on platforms without handle deletion.
            if (!FingerprintMatches(path, fingerprint))
                throw new OutputOwnershipMismatchException();
            File.Delete(path);
        }
        EnsureOutputsAbsent(home, data.OwnedFileNames);
        Update(data with
        {
            FileFingerprints = [],
            FinalFileName = null,
            State = Prepared,
            UpdatedAt = DateTimeOffset.UtcNow
        });
    }

    public void ClearPartialFiles()
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(
            jobTemp,
            "*",
            SearchOption.TopDirectoryOnly))
        {
            if (string.Equals(entry, manifestPath, PathComparison)) continue;
            DeleteTempEntry(entry);
        }
    }

    public static void Commit(
        IDownloadPaths paths,
        string jobTemp,
        string jobId,
        string finalPath)
    {
        ArgumentNullException.ThrowIfNull(paths);
        var temp = CanonicalJobTemp(paths.TempRoot, jobTemp, jobId);
        var manifestPath = Path.Combine(temp, FileName);
        if (!File.Exists(manifestPath)) return;
        var manifest = Read(manifestPath);
        ValidateSelf(manifest);
        if (!string.Equals(manifest.JobId, jobId, StringComparison.Ordinal)
            || manifest.State != Validated
            || manifest.FinalFileName is null)
        {
            throw new InvalidDataException("The output manifest is not committed.");
        }

        var expected = Path.GetFullPath(Path.Combine(paths.Home, manifest.FinalFileName));
        if (!string.Equals(expected, Path.GetFullPath(finalPath), PathComparison))
            throw new InvalidDataException("The committed output does not match its manifest.");
        new OutputRecoveryManifest(paths.Home, temp, manifestPath, manifest)
            .RequireFingerprintMatch(expected, manifest.FinalFileName);
        paths.DeleteJobTemp(jobId);
    }

    public static void Discard(
        IDownloadPaths paths,
        string jobTemp,
        string jobId)
    {
        ArgumentNullException.ThrowIfNull(paths);
        var temp = CanonicalJobTemp(paths.TempRoot, jobTemp, jobId);
        var manifestPath = Path.Combine(temp, FileName);
        if (File.Exists(manifestPath))
        {
            var value = Read(manifestPath);
            ValidateSelf(value);
            if (!string.Equals(value.JobId, jobId, StringComparison.Ordinal))
                throw new InvalidDataException("The output manifest belongs to another job.");
            try
            {
                new OutputRecoveryManifest(paths.Home, temp, manifestPath, value)
                    .DeleteOwnedOutputs();
            }
            catch (OutputOwnershipMismatchException)
            {
                // The durable identity is being explicitly discarded. Preserve
                // every possibly foreign output, but release the job temp below.
            }
        }
        paths.DeleteJobTemp(jobId);
    }

    private (string Canonical, string Name) ValidateFinalPath(string path)
    {
        var canonical = Path.GetFullPath(path);
        if (!IsDirectChild(home, canonical) || !IsSafeRegularFile(canonical))
            throw new InvalidDataException("The final output is outside its owned directory.");
        var name = Path.GetFileName(canonical);
        if (!data.OwnedFileNames.Contains(name, StringComparer.OrdinalIgnoreCase)
            || !IsMediaFileName(name))
        {
            throw new InvalidDataException("The final output is not owned by its manifest.");
        }
        return (canonical, name);
    }

    private void Update(ManifestData next)
    {
        next = next with { OwnershipHash = string.Empty };
        next = next with { OwnershipHash = OwnershipHash(next) };
        WriteAtomic(manifestPath, next, overwrite: true);
        data = next;
    }

    private string OwnedPath(string fileName)
    {
        var path = Path.GetFullPath(Path.Combine(home, fileName));
        if (!IsDirectChild(home, path))
            throw new InvalidDataException("The output manifest escaped its destination.");
        return path;
    }

    private static ManifestData Read(string path)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new InvalidDataException("The output manifest is not a regular file.");
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            4096,
            FileOptions.SequentialScan);
        if (stream.Length is <= 0 or > MaximumManifestBytes)
            throw new InvalidDataException("The output manifest has an invalid size.");
        var bytes = new byte[(int)stream.Length];
        stream.ReadExactly(bytes);
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException("The output manifest is invalid.");
            var properties = document.RootElement.EnumerateObject()
                .Select(property => property.Name)
                .ToArray();
            if (properties.Length != ManifestProperties.Count
                || properties.Distinct(StringComparer.Ordinal).Count() != properties.Length
                || properties.Any(property => !ManifestProperties.Contains(property)))
            {
                throw new InvalidDataException("The output manifest has unexpected properties.");
            }
            return JsonSerializer.Deserialize<ManifestData>(StrictUtf8.GetString(bytes), Json)
                ?? throw new InvalidDataException("The output manifest is empty.");
        }
        catch (Exception exception) when (
            exception is JsonException or NotSupportedException or DecoderFallbackException)
        {
            throw new InvalidDataException("The output manifest is invalid.", exception);
        }
    }

    private static void Validate(
        ManifestData value,
        string expectedJobId,
        string expectedMediaId,
        string expectedIdentityHash,
        DownloadSelection selection)
    {
        ValidateSelf(value);
        if (!string.Equals(value.JobId, expectedJobId, StringComparison.Ordinal)
            || !string.Equals(value.MediaId, expectedMediaId, StringComparison.Ordinal)
            || !FixedEquals(value.IdentityHash, expectedIdentityHash)
            || !value.OwnedFileNames.SequenceEqual(
                ExpectedOwnedFileNames(value.Stem, selection),
                StringComparer.Ordinal))
        {
            throw new InvalidDataException("The output manifest belongs to another operation.");
        }
    }

    private static void ValidateSelf(ManifestData value)
    {
        if (value.SchemaVersion != SchemaVersion
            || !SafeJobId().IsMatch(value.JobId ?? string.Empty)
            || !SafeMediaId().IsMatch(value.MediaId ?? string.Empty)
            || !SafeHash().IsMatch(value.IdentityHash ?? string.Empty)
            || !SafeHash().IsMatch(value.OwnershipToken ?? string.Empty)
            || !SafeHash().IsMatch(value.OwnershipHash ?? string.Empty)
            || !DownloadPaths.IsSafeOutputStem(value.Stem)
            || value.OwnedFileNames is null or { Length: < 1 or > 4 }
            || value.OwnedFileNames.Distinct(StringComparer.OrdinalIgnoreCase).Count()
                != value.OwnedFileNames.Length
            || value.OwnedFileNames.Any(name => !IsSafeOwnedFileName(value.Stem, name))
            || value.FileFingerprints is null or { Length: > 4 }
            || value.FileFingerprints.DistinctBy(
                    fingerprint => fingerprint?.Name,
                    StringComparer.OrdinalIgnoreCase).Count()
                != value.FileFingerprints.Length
            || value.FileFingerprints.Any(fingerprint =>
                fingerprint is null
                || !value.OwnedFileNames.Contains(
                    fingerprint.Name,
                    StringComparer.OrdinalIgnoreCase)
                || !IsSafeOwnedFileName(value.Stem, fingerprint.Name)
                || fingerprint.Size < 0
                || !SafeHash().IsMatch(fingerprint.Sha256 ?? string.Empty))
            || (value.FinalFileName is not null
                && (!value.OwnedFileNames.Contains(value.FinalFileName, StringComparer.OrdinalIgnoreCase)
                    || !IsMediaFileName(value.FinalFileName)))
            || !States.Contains(value.State)
            || value.CreatedAt == default
            || value.UpdatedAt < value.CreatedAt
            || (value.State == Prepared
                && (value.FinalFileName is not null || value.FileFingerprints.Length != 0))
            || (value.State is Reported or Validated
                && (value.FinalFileName is null
                    || value.FileFingerprints.Length == 0
                    || !value.FileFingerprints.Any(fingerprint =>
                        string.Equals(
                            fingerprint.Name,
                            value.FinalFileName,
                            StringComparison.OrdinalIgnoreCase)))))
        {
            throw new InvalidDataException("The output manifest payload is invalid.");
        }

        var expectedOwnershipHash = OwnershipHash(value with { OwnershipHash = string.Empty });
        if (!FixedEquals(value.OwnershipHash!, expectedOwnershipHash))
            throw new InvalidDataException("The output manifest identity hash is invalid.");
    }

    private static string[] ExpectedOwnedFileNames(string stem, DownloadSelection selection)
    {
        var names = selection.AudioOnly
            ? new List<string> { $"{stem}.m4a" }
            : [
                $"{stem}.mp4",
                $"{stem}.webm",
                $"{stem}.mkv"
            ];
        if (selection.SubtitleLanguage is not null)
            names.Add($"{stem}.{selection.SubtitleLanguage}.vtt");
        return names.ToArray();
    }

    private static void EnsureOutputsAbsent(string home, IEnumerable<string> names)
    {
        foreach (var name in names)
        {
            var path = Path.GetFullPath(Path.Combine(home, name));
            if (!IsDirectChild(home, path) || File.Exists(path) || Directory.Exists(path))
                throw new IOException("An output name was already occupied before reservation.");
        }
    }

    private static void EnsureOwnedNamesSafeForResume(string home, ManifestData value)
    {
        foreach (var name in value.OwnedFileNames)
        {
            var path = Path.GetFullPath(Path.Combine(home, name));
            if (!File.Exists(path) && !Directory.Exists(path)) continue;
            if (value.State == Prepared || Directory.Exists(path))
                throw new OutputOwnershipMismatchException();

            var expected = value.FileFingerprints.SingleOrDefault(candidate =>
                string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase));
            if (expected is null || !FingerprintMatches(path, expected))
                throw new OutputOwnershipMismatchException();
        }
    }

    private void RequireFingerprintMatch(string path, string name)
    {
        var expected = data.FileFingerprints.SingleOrDefault(value =>
            string.Equals(value.Name, name, StringComparison.OrdinalIgnoreCase));
        if (expected is null || !FingerprintMatches(path, expected))
            throw new OutputOwnershipMismatchException();
    }

    private static bool FingerprintMatches(string path, FileFingerprintData expected)
    {
        try
        {
            var actual = Fingerprint(path, expected.Name);
            return actual.Size == expected.Size
                && FixedEquals(actual.Sha256, expected.Sha256);
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or InvalidDataException)
        {
            return false;
        }
    }

    private static FileFingerprintData Fingerprint(string path, string name)
    {
        if (!IsSafeRegularFile(path))
            throw new InvalidDataException("An output fingerprint requires a regular file.");
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            128 * 1024,
            FileOptions.SequentialScan);
        var size = stream.Length;
        var sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (stream.Length != size)
            throw new IOException("The output changed while it was being fingerprinted.");
        return new FileFingerprintData(name, size, sha256);
    }

    private static string CanonicalDirectory(string path, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new ArgumentException("A fully-qualified directory is required.", parameterName);
        var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (!Directory.Exists(canonical)
            || (File.GetAttributes(canonical) & FileAttributes.ReparsePoint) != 0)
        {
            throw new IOException("The output directory is unavailable or redirected.");
        }
        return canonical;
    }

    private static string CanonicalJobTemp(string tempRoot, string jobTemp, string jobId)
    {
        if (jobId is null || !SafeJobId().IsMatch(jobId))
            throw new ArgumentException("Invalid job id.", nameof(jobId));
        var root = CanonicalDirectory(tempRoot, nameof(tempRoot));
        var canonical = CanonicalDirectory(jobTemp, nameof(jobTemp));
        var expected = Path.GetFullPath(Path.Combine(root, jobId));
        if (!string.Equals(canonical, expected, PathComparison) || !IsDirectChild(root, canonical))
            throw new InvalidDataException("The output manifest is outside its job directory.");
        return canonical;
    }

    private static void WriteAtomic(string path, ManifestData value, bool overwrite)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new InvalidDataException("The output manifest path is invalid.");
        var temporary = Path.Combine(directory, $"output-manifest-{Guid.NewGuid():N}.tmp");
        try
        {
            var bytes = StrictUtf8.GetBytes(JsonSerializer.Serialize(value, Json));
            if (bytes.Length > MaximumManifestBytes)
                throw new InvalidDataException("The output manifest is too large.");
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
            File.Move(temporary, path, overwrite);
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
        }
    }

    private static string IdentityHash(
        string jobId,
        string canonicalUrl,
        string mediaId,
        DownloadSelection selection) => HashFields(
            "video-radar-output-v1",
            jobId,
            canonicalUrl,
            mediaId,
            selection.Height?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "null",
            selection.AudioOnly ? "true" : "false",
            selection.SubtitleLanguage ?? "null",
            selection.IncludeAutomaticSubtitles ? "true" : "false");

    private static string OwnershipHash(ManifestData value) => HashFields(
        "video-radar-ownership-v2",
        value.SchemaVersion.ToString(System.Globalization.CultureInfo.InvariantCulture),
        value.JobId,
        value.MediaId,
        value.IdentityHash,
        value.OwnershipToken,
        value.Stem,
        string.Join("\0", value.OwnedFileNames),
        string.Join("\0", value.FileFingerprints.Select(fingerprint =>
            string.Join("\0",
                fingerprint.Name,
                fingerprint.Size.ToString(System.Globalization.CultureInfo.InvariantCulture),
                fingerprint.Sha256))),
        value.FinalFileName ?? "null",
        value.State,
        value.CreatedAt.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture),
        value.UpdatedAt.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture));

    private static string HashFields(params string[] values)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> length = stackalloc byte[sizeof(int)];
        foreach (var value in values)
        {
            var bytes = StrictUtf8.GetBytes(value);
            System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
            hash.AppendData(length);
            hash.AppendData(bytes);
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static bool FixedEquals(string left, string right)
    {
        try
        {
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(left),
                Convert.FromHexString(right));
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool IsSafeOwnedFileName(string stem, string name) =>
        !string.IsNullOrWhiteSpace(name)
        && name.Length <= 240
        && string.Equals(name, Path.GetFileName(name), StringComparison.Ordinal)
        && name.StartsWith(stem + ".", StringComparison.Ordinal)
        && !name.Any(character => Path.GetInvalidFileNameChars().Contains(character));

    private static bool IsMediaFileName(string name) =>
        Path.GetExtension(name).ToLowerInvariant() is ".mp4" or ".webm" or ".mkv" or ".m4a";

    private static bool IsSafeRegularFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return false;
            var attributes = File.GetAttributes(path);
            return (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return false;
        }
    }

    private static void DeleteTempEntry(string path)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.Directory) == 0)
        {
            File.Delete(path);
            return;
        }
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            Directory.Delete(path, recursive: false);
            return;
        }
        foreach (var child in Directory.EnumerateFileSystemEntries(
            path,
            "*",
            SearchOption.TopDirectoryOnly))
        {
            DeleteTempEntry(child);
        }
        Directory.Delete(path, recursive: false);
    }

    private static bool IsDirectChild(string root, string path) =>
        string.Equals(Path.GetDirectoryName(path), root, PathComparison);

    private static StringComparison PathComparison => OperatingSystem.IsWindows()
        ? StringComparison.OrdinalIgnoreCase
        : StringComparison.Ordinal;

    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeJobId();

    [GeneratedRegex("^[A-Za-z0-9._:-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeMediaId();

    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeHash();

    private sealed record ManifestData(
        int SchemaVersion,
        string JobId,
        string MediaId,
        string IdentityHash,
        string OwnershipToken,
        string OwnershipHash,
        string Stem,
        string[] OwnedFileNames,
        FileFingerprintData[] FileFingerprints,
        string? FinalFileName,
        string State,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    private sealed record FileFingerprintData(
        string Name,
        long Size,
        string Sha256);
}

internal sealed class OutputOwnershipMismatchException()
    : Exception("A reserved output was replaced by another file.");
