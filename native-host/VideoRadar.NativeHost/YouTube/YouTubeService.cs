using System.Text.RegularExpressions;
using System.Text;
using System.Text.Json;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Media;
using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.YouTube;

public sealed partial class YouTubeService : IYouTubeService, IResumableYouTubeService
{
    private const int MaximumCachedCatalogs = 16;
    private const int MaximumCachedMetadataBytes = 4 * 1024 * 1024;
    private const long MinimumRequiredFreeSpaceBytes = 512L * 1024 * 1024;
    private const long DiskSpaceSafetyMarginBytes = 256L * 1024 * 1024;
    private static readonly TimeSpan SocialCatalogLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan YouTubeCatalogLifetime = TimeSpan.FromMinutes(30);
    private const string MetadataLookupError = "Unable to retrieve media metadata.";
    private const string InvalidOutputError = "The downloaded file was not reported safely.";
    private readonly string tools;
    private readonly IProcessRunner processRunner;
    private readonly IDownloadPathsFactory downloadPathsFactory;
    private readonly IVolumeSpaceProbe volumeSpaceProbe;
    private readonly IMediaFileValidator mediaFileValidator;
    private readonly TimeProvider timeProvider;
    private readonly object stateLock = new();
    private readonly Dictionary<string, CatalogLookup> catalogCache = new(StringComparer.Ordinal);
    private readonly Queue<string> catalogOrder = new();
    private int cachedMetadataBytes;
    private ActiveJob? activeJob;
    private JobSnapshot? snapshot;

    public YouTubeService(string tools, IProcessRunner processRunner)
        : this(tools, processRunner, CreateDefaultFactory(), TimeProvider.System, new DriveInfoVolumeSpaceProbe(), SkipMediaFileValidator.Instance)
    {
    }

    public YouTubeService(string tools, IProcessRunner processRunner, IDownloadPaths downloadPaths)
        : this(
            tools,
            processRunner,
            new ExistingDownloadPathsFactory(downloadPaths),
            TimeProvider.System,
            new DriveInfoVolumeSpaceProbe(),
            SkipMediaFileValidator.Instance)
    {
        ArgumentNullException.ThrowIfNull(downloadPaths);
    }

    public YouTubeService(string tools, IProcessRunner processRunner, IDownloadPathsFactory downloadPathsFactory)
        : this(tools, processRunner, downloadPathsFactory, TimeProvider.System, new DriveInfoVolumeSpaceProbe(), SkipMediaFileValidator.Instance)
    {
    }

    public YouTubeService(
        string tools,
        IProcessRunner processRunner,
        IDownloadPathsFactory downloadPathsFactory,
        IMediaFileValidator mediaFileValidator)
        : this(
            tools,
            processRunner,
            downloadPathsFactory,
            TimeProvider.System,
            new DriveInfoVolumeSpaceProbe(),
            mediaFileValidator)
    {
    }

    public YouTubeService(
        string tools,
        IProcessRunner processRunner,
        IDownloadPathsFactory downloadPathsFactory,
        TimeProvider timeProvider)
        : this(
            tools,
            processRunner,
            downloadPathsFactory,
            timeProvider,
            new DriveInfoVolumeSpaceProbe(),
            SkipMediaFileValidator.Instance)
    {
    }

    internal YouTubeService(
        string tools,
        IProcessRunner processRunner,
        IDownloadPathsFactory downloadPathsFactory,
        TimeProvider timeProvider,
        IVolumeSpaceProbe volumeSpaceProbe)
        : this(
            tools,
            processRunner,
            downloadPathsFactory,
            timeProvider,
            volumeSpaceProbe,
            SkipMediaFileValidator.Instance)
    {
    }

    internal YouTubeService(
        string tools,
        IProcessRunner processRunner,
        IDownloadPathsFactory downloadPathsFactory,
        TimeProvider timeProvider,
        IVolumeSpaceProbe volumeSpaceProbe,
        IMediaFileValidator mediaFileValidator)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tools);
        ArgumentNullException.ThrowIfNull(processRunner);
        ArgumentNullException.ThrowIfNull(downloadPathsFactory);
        ArgumentNullException.ThrowIfNull(timeProvider);
        ArgumentNullException.ThrowIfNull(volumeSpaceProbe);
        ArgumentNullException.ThrowIfNull(mediaFileValidator);
        this.tools = tools;
        this.processRunner = processRunner;
        this.downloadPathsFactory = downloadPathsFactory;
        this.timeProvider = timeProvider;
        this.volumeSpaceProbe = volumeSpaceProbe;
        this.mediaFileValidator = mediaFileValidator;
    }

    public async Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken)
    {
        return (await GetCatalogAsync(url, cancellationToken)).Catalog;
    }

    private async Task<CachedCatalog> GetCatalogAsync(string url, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!MediaPage.TryCanonicalize(url, out var page))
            throw new InvalidDataException("Invalid media URL.");
        var canonicalUrl = page!.CanonicalUrl;

        CatalogLookup lookup;
        lock (stateLock)
        {
            if (catalogCache.TryGetValue(canonicalUrl, out lookup!) && IsExpired(lookup))
            {
                RemoveCatalogLocked(canonicalUrl, lookup);
                lookup = null!;
            }
            if (lookup is null)
            {
                lookup = new CatalogLookup(
                    page.Platform,
                    token => LoadCatalogAsync(canonicalUrl, page.Platform, token));
                catalogCache.Add(canonicalUrl, lookup);
                catalogOrder.Enqueue(canonicalUrl);
                TrimCatalogsLocked(canonicalUrl);
            }

            lookup.ObserverCount++;
        }

        return await ObserveCatalogAsync(canonicalUrl, lookup, cancellationToken);
    }

    private bool IsExpired(CatalogLookup lookup)
    {
        if (!lookup.Task.IsValueCreated || !lookup.Task.Value.IsCompletedSuccessfully) return false;
        var lifetime = lookup.Platform == "youtube" ? YouTubeCatalogLifetime : SocialCatalogLifetime;
        return timeProvider.GetUtcNow() - lookup.Task.Value.Result.CreatedAt >= lifetime;
    }

    private async Task<CachedCatalog> LoadCatalogAsync(
        string canonicalUrl,
        string platform,
        CancellationToken cancellationToken)
    {
        var result = await processRunner.RunAsync(
            Path.Combine(tools, "yt-dlp.exe"),
            YtDlpArguments.Metadata(tools, canonicalUrl),
            onOutput: null,
            cancellationToken);

        if (result.ExitCode != 0 || result.StandardOutputTruncated)
            throw new InvalidOperationException(MetadataLookupError);
        var metadataBytes = Encoding.UTF8.GetByteCount(result.StandardOutput);
        if (metadataBytes > MaximumCachedMetadataBytes)
            throw new InvalidOperationException(MetadataLookupError);
        var catalog = FormatCatalog.Parse(result.StandardOutput);
        return new CachedCatalog(
            catalog with { Platform = platform },
            result.StandardOutput,
            timeProvider.GetUtcNow(),
            metadataBytes);
    }

    private async Task<CachedCatalog> ObserveCatalogAsync(
        string canonicalUrl,
        CatalogLookup lookup,
        CancellationToken cancellationToken)
    {
        CachedCatalog cached;
        try
        {
            cached = await lookup.Task.Value.WaitAsync(cancellationToken);
            lock (stateLock)
            {
                if (catalogCache.TryGetValue(canonicalUrl, out var current)
                    && ReferenceEquals(current, lookup)
                    && lookup.MetadataBytes == 0)
                {
                    lookup.MetadataBytes = cached.MetadataBytes;
                    cachedMetadataBytes += cached.MetadataBytes;
                    TrimCatalogsLocked(canonicalUrl);
                }
            }

            return cached;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            lock (stateLock) RemoveCatalogLocked(canonicalUrl, lookup);
            throw;
        }
        finally
        {
            ReleaseCatalogObserver(canonicalUrl, lookup);
        }
    }

    private void ReleaseCatalogObserver(string canonicalUrl, CatalogLookup lookup)
    {
        var cancelLookup = false;
        var disposeLookup = false;
        lock (stateLock)
        {
            if (lookup.ObserverCount > 0) lookup.ObserverCount--;
            if (lookup.ObserverCount == 0)
            {
                if (!lookup.Task.IsValueCreated || lookup.Task.Value.IsCompleted)
                {
                    disposeLookup = true;
                }
                else
                {
                    RemoveCatalogLocked(canonicalUrl, lookup);
                    cancelLookup = true;
                }
            }
        }

        if (cancelLookup) lookup.Cancel();
        else if (disposeLookup) lookup.DisposeCancellation();
    }

    private void InvalidateCatalog(string canonicalUrl)
    {
        CatalogLookup? cancelLookup = null;
        lock (stateLock)
        {
            if (catalogCache.TryGetValue(canonicalUrl, out var lookup))
            {
                RemoveCatalogLocked(canonicalUrl, lookup);
                if (lookup.ObserverCount == 0)
                {
                    if (lookup.Task.IsValueCreated && !lookup.Task.Value.IsCompleted)
                        cancelLookup = lookup;
                    else
                        lookup.DisposeCancellation();
                }
            }
        }

        cancelLookup?.Cancel();
    }

    private void RemoveCatalogLocked(string canonicalUrl, CatalogLookup lookup)
    {
        if (!catalogCache.TryGetValue(canonicalUrl, out var current) || !ReferenceEquals(current, lookup)) return;
        catalogCache.Remove(canonicalUrl);
        cachedMetadataBytes -= lookup.MetadataBytes;
        var retained = catalogOrder
            .Where(url => !string.Equals(url, canonicalUrl, StringComparison.Ordinal))
            .ToArray();
        catalogOrder.Clear();
        foreach (var url in retained) catalogOrder.Enqueue(url);
    }

    private void TrimCatalogsLocked(string newestUrl)
    {
        while ((catalogCache.Count > MaximumCachedCatalogs || cachedMetadataBytes > MaximumCachedMetadataBytes)
            && catalogOrder.Count > 0)
        {
            var oldest = catalogOrder.Dequeue();
            if (!catalogCache.TryGetValue(oldest, out var lookup)) continue;
            if (string.Equals(oldest, newestUrl, StringComparison.Ordinal) && catalogCache.Count > 1)
            {
                catalogOrder.Enqueue(oldest);
                continue;
            }
            catalogCache.Remove(oldest);
            cachedMetadataBytes -= lookup.MetadataBytes;
            if (lookup.ObserverCount == 0)
            {
                if (lookup.Task.IsValueCreated && !lookup.Task.Value.IsCompleted)
                    lookup.Cancel();
                else
                    lookup.DisposeCancellation();
            }
        }
    }

    public async Task<JobResult> StartDownloadAsync(
        string jobId,
        string url,
        int height,
        string? destinationFolder,
        Func<JobProgress, Task> onProgress,
        CancellationToken cancellationToken) =>
        await StartDownloadAsync(
            jobId,
            url,
            DownloadSelection.Video(height),
            destinationFolder,
            new DownloadRunOptions(),
            onProgress,
            cancellationToken);

    public async Task<JobResult> StartDownloadAsync(
        string jobId,
        string url,
        DownloadSelection selection,
        string? destinationFolder,
        DownloadRunOptions runOptions,
        Func<JobProgress, Task> onProgress,
        CancellationToken cancellationToken)
    {
        ValidateJobId(jobId);
        ArgumentNullException.ThrowIfNull(selection);
        ArgumentNullException.ThrowIfNull(runOptions);
        if (!MediaPage.TryCanonicalize(url, out var page))
            throw new InvalidDataException("Invalid media URL.");
        var canonicalUrl = page!.CanonicalUrl;
        ValidateSelectionShape(selection);
        ArgumentNullException.ThrowIfNull(onProgress);
        cancellationToken.ThrowIfCancellationRequested();

        var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var job = new ActiveJob(jobId, selection, linkedCancellation)
        {
            PreservePartialOnCancellation = runOptions.PreservePartialOnCancellation
        };
        lock (stateLock)
        {
            if (activeJob is not null)
            {
                linkedCancellation.Dispose();
                throw new InvalidOperationException("Another download is already active.");
            }

            activeJob = job;
            snapshot = new JobSnapshot(jobId, string.Empty, string.Empty, selection.Height ?? 0, "preparing", null, null, null);
        }

        string? reservedStem = null;
        IDownloadPaths? paths = null;
        OutputRecoveryManifest? outputManifest = null;
        var tempCreated = false;
        var preserveTemp = runOptions.DurableOutputIdentity;
        try
        {
            var cachedCatalog = await GetCatalogAsync(canonicalUrl, linkedCancellation.Token);
            var catalog = cachedCatalog.Catalog;
            EnsureSelectionAvailable(job, catalog, selection, "invalid_selection");

            SetMetadata(job, catalog);
            paths = downloadPathsFactory.Create(destinationFolder);
            var estimatedBytes = EstimateDownloadBytes(cachedCatalog.MetadataJson, selection);
            var temp = paths.CreateJobTemp(jobId);
            tempCreated = true;
            outputManifest = OutputRecoveryManifest.OpenOrCreate(
                paths,
                temp,
                jobId,
                canonicalUrl,
                catalog.VideoId,
                selection,
                () => paths.ReserveStem(catalog.Title, catalog.VideoId));
            reservedStem = outputManifest.Stem;
            var validationRequest = new MediaValidationRequest(
                ExpectVideo: !selection.AudioOnly,
                ExpectAudio: true,
                ExpectedDurationSeconds: catalog.DurationSeconds,
                EstimatedSizeBytes: estimatedBytes);
            var recoveredOutput = outputManifest.FindRecoveryOutput();
            if (recoveredOutput is not null)
            {
                try
                {
                    await mediaFileValidator.ValidateAsync(
                        recoveredOutput,
                        validationRequest,
                        linkedCancellation.Token);
                    outputManifest.MarkValidated(recoveredOutput);
                    SetCompleted(job, recoveredOutput);
                    return new JobResult(jobId, recoveredOutput);
                }
                catch (MediaValidationException)
                {
                    outputManifest.DeleteOwnedOutputs();
                    runOptions = runOptions with { ResumePartial = true };
                }
            }

            EnsureSufficientDiskSpace(job, paths, estimatedBytes);

            for (var attempt = 0; ; attempt++)
            {
                string? infoJsonPath = null;
                if (page.Platform == "instagram")
                {
                    infoJsonPath = Path.Combine(temp, "media.info.json");
                    await File.WriteAllTextAsync(
                        infoJsonPath,
                        cachedCatalog.MetadataJson,
                        new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                        linkedCancellation.Token);
                }

                var result = await processRunner.RunAsync(
                    Path.Combine(tools, "yt-dlp.exe"),
                    YtDlpArguments.Download(
                        tools,
                        paths.Home,
                        temp,
                        reservedStem,
                        canonicalUrl,
                        selection,
                        runOptions,
                        infoJsonPath),
                    line => HandleOutputAsync(job, paths, outputManifest, line, onProgress),
                    linkedCancellation.Token);

                linkedCancellation.Token.ThrowIfCancellationRequested();
                if (result.ExitCode == 0) break;

                var failure = ClassifyDownloadFailure(result.StandardError);
                if (page.Platform == "instagram"
                    && attempt == 0
                    && failure.Code == "MEDIA_ACCESS_DENIED")
                {
                    InvalidateCatalog(canonicalUrl);
                    outputManifest.ClearPartialFiles();
                    cachedCatalog = await GetCatalogAsync(canonicalUrl, linkedCancellation.Token);
                    catalog = cachedCatalog.Catalog;
                    EnsureSelectionAvailable(job, catalog, selection, "FORMAT_UNAVAILABLE");
                    SetMetadata(job, catalog);
                    continue;
                }

                SetTerminal(job, "failed", failure.Code);
                throw failure;
            }

            string? finalPath;
            lock (stateLock) finalPath = job.FinalPath;
            if (finalPath is null)
            {
                SetTerminal(job, "failed", "invalid_output");
                throw new InvalidOperationException(InvalidOutputError);
            }

            try
            {
                await mediaFileValidator.ValidateAsync(
                    finalPath,
                    validationRequest,
                    linkedCancellation.Token);
                outputManifest.MarkValidated(finalPath);
            }
            catch (MediaValidationException)
            {
                outputManifest.DeleteOwnedOutputs();
                SetTerminal(job, "failed", "MEDIA_VALIDATION_FAILED");
                throw new MediaDownloadException(
                    "MEDIA_VALIDATION_FAILED",
                    "O arquivo baixado não passou pela validação final de mídia.");
            }

            SetCompleted(job, finalPath);
            return new JobResult(jobId, finalPath);
        }
        catch (OutputOwnershipMismatchException)
        {
            SetTerminal(job, "failed", "OUTPUT_OWNERSHIP_MISMATCH");
            throw new MediaDownloadException(
                "OUTPUT_OWNERSHIP_MISMATCH",
                "O arquivo reservado foi alterado por outro processo e foi preservado.");
        }
        catch (OperationCanceledException)
        {
            var cancellationRequested = linkedCancellation.IsCancellationRequested;
            preserveTemp = job.PreservePartialOnCancellation
                || (runOptions.DurableOutputIdentity && !cancellationRequested);
            if (!preserveTemp && outputManifest is not null)
            {
                try
                {
                    outputManifest.DeleteOwnedOutputs();
                }
                catch (OutputOwnershipMismatchException)
                {
                    preserveTemp = true;
                    SetTerminal(job, "failed", "OUTPUT_OWNERSHIP_MISMATCH");
                    throw new MediaDownloadException(
                        "OUTPUT_OWNERSHIP_MISMATCH",
                        "O arquivo reservado foi alterado por outro processo e foi preservado.");
                }
            }
            SetTerminal(
                job,
                cancellationRequested ? "cancelled" : "failed",
                cancellationRequested ? "cancelled" : "DOWNLOAD_INTERRUPTED");
            throw;
        }
        catch
        {
            SetFailureUnlessTerminal(job);
            throw;
        }
        finally
        {
            if (paths is not null && tempCreated && !preserveTemp) TryCleanup(() => paths.DeleteJobTemp(jobId));
            if (paths is not null && reservedStem is not null) TryCleanup(() => paths.ReleaseStem(reservedStem));
            lock (stateLock)
            {
                if (ReferenceEquals(activeJob, job)) activeJob = null;
            }

            linkedCancellation.Dispose();
        }
    }

    public Task<JobResult> StartDownloadAsync(
        string jobId,
        string url,
        int height,
        Func<JobProgress, Task> onProgress,
        CancellationToken cancellationToken) =>
        StartDownloadAsync(jobId, url, height, null, onProgress, cancellationToken);

    public Task PauseAsync(string jobId)
    {
        ValidateJobId(jobId);
        CancellationTokenSource? cancellation = null;
        lock (stateLock)
        {
            if (activeJob is not null && string.Equals(activeJob.JobId, jobId, StringComparison.Ordinal))
            {
                activeJob.PreservePartialOnCancellation = true;
                cancellation = activeJob.Cancellation;
            }
        }
        TryCancel(cancellation);
        return Task.CompletedTask;
    }

    public Task DiscardPartialAsync(
        string jobId,
        string? destinationFolder,
        CancellationToken cancellationToken = default)
    {
        ValidateJobId(jobId);
        cancellationToken.ThrowIfCancellationRequested();
        lock (stateLock)
        {
            if (activeJob is not null && string.Equals(activeJob.JobId, jobId, StringComparison.Ordinal))
                throw new InvalidOperationException("Cannot discard an active download.");
        }
        var paths = downloadPathsFactory.Create(destinationFolder);
        var jobTemp = paths.FindJobTemp(jobId);
        if (jobTemp is null) return Task.CompletedTask;
        OutputRecoveryManifest.Discard(paths, jobTemp, jobId);
        return Task.CompletedTask;
    }

    public Task CommitCompletedAsync(
        string jobId,
        string? destinationFolder,
        string finalPath,
        CancellationToken cancellationToken = default)
    {
        ValidateJobId(jobId);
        cancellationToken.ThrowIfCancellationRequested();
        lock (stateLock)
        {
            if (activeJob is not null && string.Equals(activeJob.JobId, jobId, StringComparison.Ordinal))
                throw new InvalidOperationException("Cannot commit an active download.");
        }
        var paths = downloadPathsFactory.Create(destinationFolder);
        var jobTemp = paths.FindJobTemp(jobId);
        if (jobTemp is null) return Task.CompletedTask;
        OutputRecoveryManifest.Commit(paths, jobTemp, jobId, finalPath);
        return Task.CompletedTask;
    }

    public Task CancelAsync(string jobId)
    {
        CancellationTokenSource? cancellation = null;
        lock (stateLock)
        {
            if (activeJob is not null && string.Equals(activeJob.JobId, jobId, StringComparison.Ordinal))
            {
                activeJob.PreservePartialOnCancellation = false;
                cancellation = activeJob.Cancellation;
            }
        }

        if (cancellation is not null)
        {
            TryCancel(cancellation);
        }

        return Task.CompletedTask;
    }

    public JobSnapshot? GetJob()
    {
        lock (stateLock) return snapshot;
    }

    private void EnsureSelectionAvailable(
        ActiveJob job,
        FormatCatalog catalog,
        DownloadSelection selection,
        string errorCode)
    {
        var formatAvailable = selection.AudioOnly
            ? catalog.Formats.Any(format => format.AudioOnly)
            : catalog.Qualities.Any(quality => quality.Height == selection.Height);
        var subtitlesAvailable = selection.SubtitleLanguage is null
            || catalog.Subtitles.Any(track =>
                string.Equals(track.Language, selection.SubtitleLanguage, StringComparison.OrdinalIgnoreCase)
                && track.Automatic == selection.IncludeAutomaticSubtitles);
        if (formatAvailable && subtitlesAvailable) return;
        SetTerminal(job, "failed", errorCode);
        if (errorCode == "FORMAT_UNAVAILABLE")
        {
            throw new MediaDownloadException(
                errorCode,
                "A qualidade escolhida não está mais disponível.");
        }

        throw new InvalidDataException("Selected quality is unavailable.");
    }

    private void EnsureSufficientDiskSpace(
        ActiveJob job,
        IDownloadPaths paths,
        long? estimatedBytes)
    {
        var homeRequired = estimatedBytes.HasValue
            ? Math.Max(
                MinimumRequiredFreeSpaceBytes,
                SaturatingAdd(estimatedBytes.Value, DiskSpaceSafetyMarginBytes))
            : MinimumRequiredFreeSpaceBytes;
        var tempRequired = estimatedBytes.HasValue
            ? Math.Max(
                MinimumRequiredFreeSpaceBytes,
                SaturatingAdd(SaturatingMultiplyByTwo(estimatedBytes.Value), DiskSpaceSafetyMarginBytes))
            : MinimumRequiredFreeSpaceBytes;

        var homeRoot = TryGetVolumeRoot(paths.Home);
        var tempRoot = TryGetVolumeRoot(paths.TempRoot);
        var spaceStatus = VolumeSpaceStatus.Enough;
        if (homeRoot is not null
            && tempRoot is not null
            && string.Equals(homeRoot, tempRoot, StringComparison.OrdinalIgnoreCase))
        {
            spaceStatus = volumeSpaceProbe.Check(homeRoot, Math.Max(homeRequired, tempRequired));
        }
        else
        {
            if (homeRoot is not null)
                spaceStatus = MergeSpaceStatus(spaceStatus, volumeSpaceProbe.Check(homeRoot, homeRequired));
            if (tempRoot is not null)
                spaceStatus = MergeSpaceStatus(spaceStatus, volumeSpaceProbe.Check(tempRoot, tempRequired));
        }

        if (spaceStatus == VolumeSpaceStatus.Enough) return;
        if (spaceStatus == VolumeSpaceStatus.Unavailable)
        {
            SetTerminal(job, "failed", "STORAGE_UNAVAILABLE");
            throw new MediaDownloadException(
                "STORAGE_UNAVAILABLE",
                "A unidade de destino não está disponível para receber o download.");
        }

        SetTerminal(job, "failed", "DISK_SPACE_LOW");
        throw new MediaDownloadException(
            "DISK_SPACE_LOW",
            "Não há espaço livre suficiente para baixar este vídeo com segurança.");
    }

    private static long? EstimateDownloadBytes(string metadataJson, DownloadSelection selection)
    {
        try
        {
            using var document = JsonDocument.Parse(metadataJson);
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("formats", out var formats)
                || formats.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            long largestCombined = 0;
            long largestVideo = 0;
            long largestAudio = 0;
            foreach (var format in formats.EnumerateArray())
            {
                if (format.ValueKind != JsonValueKind.Object || !TryGetFormatBytes(format, out var bytes))
                    continue;

                var hasVideo = HasCodec(format, "vcodec");
                var hasAudio = HasCodec(format, "acodec");
                if (selection.AudioOnly)
                {
                    if (!hasVideo && hasAudio) largestAudio = Math.Max(largestAudio, bytes);
                }
                else if (hasVideo
                    && format.TryGetProperty("height", out var formatHeight)
                    && formatHeight.ValueKind == JsonValueKind.Number
                    && formatHeight.TryGetInt32(out var candidateHeight)
                    && candidateHeight == selection.Height)
                {
                    if (hasAudio)
                        largestCombined = Math.Max(largestCombined, bytes);
                    else
                        largestVideo = Math.Max(largestVideo, bytes);
                }
                else if (!hasVideo && hasAudio)
                {
                    largestAudio = Math.Max(largestAudio, bytes);
                }
            }

            if (selection.AudioOnly) return largestAudio > 0 ? largestAudio : null;
            var separate = largestVideo == 0
                ? 0
                : SaturatingAdd(largestVideo, largestAudio);
            var estimate = Math.Max(largestCombined, separate);
            return estimate > 0 ? estimate : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool TryGetFormatBytes(JsonElement format, out long bytes)
    {
        return TryGetPositiveInt64(format, "filesize", out bytes)
            || TryGetPositiveInt64(format, "filesize_approx", out bytes);
    }

    private static bool TryGetPositiveInt64(JsonElement element, string propertyName, out long value)
    {
        value = 0;
        return element.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.Number
            && property.TryGetInt64(out value)
            && value > 0;
    }

    private static bool HasCodec(JsonElement format, string propertyName) =>
        format.TryGetProperty(propertyName, out var codec)
        && codec.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(codec.GetString())
        && !string.Equals(codec.GetString(), "none", StringComparison.OrdinalIgnoreCase);

    private static string? TryGetVolumeRoot(string path)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            return string.IsNullOrWhiteSpace(root) ? null : root;
        }
        catch (Exception exception) when (
            exception is ArgumentException or IOException or NotSupportedException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static VolumeSpaceStatus MergeSpaceStatus(
        VolumeSpaceStatus left,
        VolumeSpaceStatus right) =>
        (VolumeSpaceStatus)Math.Max((int)left, (int)right);

    private static long SaturatingAdd(long left, long right) =>
        left > long.MaxValue - right ? long.MaxValue : left + right;

    private static long SaturatingMultiplyByTwo(long value) =>
        value > long.MaxValue / 2 ? long.MaxValue : value * 2;

    private async Task HandleOutputAsync(
        ActiveJob job,
        IDownloadPaths paths,
        OutputRecoveryManifest outputManifest,
        string line,
        Func<JobProgress, Task> onProgress)
    {
        if (!ProgressParser.TryParse(line, out var parsed) || parsed is null) return;
        if (parsed.Stage == "finalize" && (parsed.Path is null || !paths.ContainsFinalPath(parsed.Path)))
            return;
        if (parsed.Stage == "finalize") outputManifest.MarkOutput(parsed.Path!);

        JobProgress? normalized;
        lock (stateLock)
        {
            normalized = NormalizeProgress(job, parsed);
            if (normalized?.Path is not null) job.FinalPath = normalized.Path;
            if (normalized is not null && ReferenceEquals(activeJob, job))
            {
                var current = snapshot!;
                snapshot = current with
                {
                    Stage = normalized.Stage,
                    Percent = normalized.Percent ?? current.Percent,
                    Path = normalized.Path ?? current.Path
                };
            }
        }

        if (normalized is not null) await onProgress(normalized);
    }

    private static JobProgress? NormalizeProgress(ActiveJob job, JobProgress progress)
    {
        var rank = StageRank(progress.Stage);
        if (rank < job.ProgressRank) return null;
        if (rank == job.ProgressRank)
        {
            if (!string.Equals(job.ProgressStage, progress.Stage, StringComparison.Ordinal)) return null;
            if (job.ProgressPercent.HasValue && progress.Percent.HasValue && progress.Percent.Value < job.ProgressPercent.Value)
                return null;
        }
        if (job.LastProgress == progress) return null;

        job.ProgressRank = rank;
        job.ProgressStage = progress.Stage;
        if (progress.Percent.HasValue) job.ProgressPercent = progress.Percent;
        job.LastProgress = progress;
        return progress;
    }

    private static int StageRank(string stage) => stage switch
    {
        "video" or "download" => 1,
        "audio" => 2,
        "merge" => 3,
        "finalize" => 4,
        _ => 0
    };

    private void SetMetadata(ActiveJob job, FormatCatalog catalog)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job)) return;
            job.ProgressRank = 0;
            job.ProgressStage = null;
            job.ProgressPercent = null;
            job.LastProgress = null;
            job.FinalPath = null;
            snapshot = new JobSnapshot(job.JobId, catalog.VideoId, catalog.Title, job.Selection.Height ?? 0, "preparing", null, null, null);
        }
    }

    private void SetCompleted(ActiveJob job, string path)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job)) return;
            var current = snapshot!;
            snapshot = current with { Stage = "complete", Percent = 100, Path = path, ErrorCode = null };
            job.Terminal = true;
        }
    }

    private void SetTerminal(ActiveJob job, string stage, string errorCode)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job)) return;
            var current = snapshot!;
            snapshot = current with { Stage = stage, ErrorCode = errorCode };
            job.Terminal = true;
        }
    }

    private void SetFailureUnlessTerminal(ActiveJob job)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job) || job.Terminal) return;
            var current = snapshot!;
            snapshot = current with { Stage = "failed", ErrorCode = "MEDIA_DOWNLOAD_FAILED" };
            job.Terminal = true;
        }
    }

    private static void TryCleanup(Action cleanup)
    {
        try
        {
            cleanup();
        }
        catch
        {
            // Cleanup is best-effort and must not replace the operation result or cancellation.
        }
    }

    private static MediaDownloadException ClassifyDownloadFailure(string standardError)
    {
        var diagnostic = standardError ?? string.Empty;
        if (ContainsAny(diagnostic, "login required", "sign in", "registered users", "follow this account"))
            return new MediaDownloadException("LOGIN_REQUIRED", "A plataforma exige login para acessar este vídeo.");
        if (ContainsAny(diagnostic, "http error 429", "too many requests", "rate limit", "rate-limit"))
            return new MediaDownloadException("RATE_LIMITED", "A plataforma limitou temporariamente as tentativas.");
        if (ContainsAny(diagnostic, "requested format is not available", "requested format not available"))
            return new MediaDownloadException("FORMAT_UNAVAILABLE", "A qualidade escolhida não está mais disponível.");
        if (ContainsAny(diagnostic, "http error 403", "forbidden"))
            return new MediaDownloadException("MEDIA_ACCESS_DENIED", "O servidor da plataforma recusou o arquivo de vídeo.");
        if (ContainsAny(diagnostic, "there is no video", "only images", "does not contain a video"))
            return new MediaDownloadException("NO_VIDEO", "Esta publicação não contém um vídeo compatível.");
        return new MediaDownloadException("MEDIA_DOWNLOAD_FAILED", "Não foi possível baixar o arquivo de vídeo.");
    }

    private static bool ContainsAny(string value, params string[] fragments) =>
        fragments.Any(fragment => value.Contains(fragment, StringComparison.OrdinalIgnoreCase));

    private static void ValidateJobId(string jobId)
    {
        if (string.IsNullOrEmpty(jobId) || !SafeJobId().IsMatch(jobId))
            throw new ArgumentException("Invalid job id.", nameof(jobId));
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeJobId();

    private static IDownloadPathsFactory CreateDefaultFactory()
    {
        var paths = new DownloadPaths();
        return new DownloadPathsFactory(paths.Home, paths.TempRoot);
    }

    private static void ValidateSelectionShape(DownloadSelection selection)
    {
        if (selection.AudioOnly)
        {
            if (selection.Height is not null)
                throw new ArgumentException("Audio-only selection cannot specify height.", nameof(selection));
        }
        else if (selection.Height is null or < 144 or > 4320)
        {
            throw new ArgumentOutOfRangeException(nameof(selection));
        }
        if (selection.IncludeAutomaticSubtitles && selection.SubtitleLanguage is null)
            throw new ArgumentException("Automatic subtitles require a language.", nameof(selection));
    }

    private static void TryCancel(CancellationTokenSource? cancellation)
    {
        if (cancellation is null) return;
        try
        {
            cancellation.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Completion won the race with cancellation.
        }
    }

    private sealed class ActiveJob(string jobId, DownloadSelection selection, CancellationTokenSource cancellation)
    {
        public string JobId { get; } = jobId;
        public DownloadSelection Selection { get; } = selection;
        public CancellationTokenSource Cancellation { get; } = cancellation;
        public int ProgressRank { get; set; }
        public string? ProgressStage { get; set; }
        public int? ProgressPercent { get; set; }
        public JobProgress? LastProgress { get; set; }
        public string? FinalPath { get; set; }
        public bool Terminal { get; set; }
        public bool PreservePartialOnCancellation { get; set; }
    }

    private sealed class CatalogLookup
    {
        private readonly CancellationTokenSource cancellation = new();
        private int cancellationDisposed;

        public CatalogLookup(string platform, Func<CancellationToken, Task<CachedCatalog>> load)
        {
            Platform = platform;
            Task = new Lazy<Task<CachedCatalog>>(
                () => load(cancellation.Token),
                LazyThreadSafetyMode.ExecutionAndPublication);
        }

        public string Platform { get; }
        public Lazy<Task<CachedCatalog>> Task { get; }
        public int MetadataBytes { get; set; }
        public int ObserverCount { get; set; }

        public void Cancel()
        {
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // Completion won the race with the final observer leaving.
            }

            if (!Task.IsValueCreated)
            {
                DisposeCancellation();
                return;
            }

            _ = Task.Value.ContinueWith(
                static (completed, state) =>
                {
                    _ = completed.Exception;
                    ((CatalogLookup)state!).DisposeCancellation();
                },
                this,
                default,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }

        public void DisposeCancellation()
        {
            if (Interlocked.Exchange(ref cancellationDisposed, 1) == 0)
                cancellation.Dispose();
        }
    }

    private sealed record CachedCatalog(
        FormatCatalog Catalog,
        string MetadataJson,
        DateTimeOffset CreatedAt,
        int MetadataBytes);

    private sealed class SkipMediaFileValidator : IMediaFileValidator
    {
        public static SkipMediaFileValidator Instance { get; } = new();

        public Task<MediaValidationResult> ValidateAsync(
            string path,
            MediaValidationRequest request,
            CancellationToken cancellationToken) =>
            Task.FromResult(new MediaValidationResult(string.Empty, 0, 0, 0, 0));
    }

    private sealed class ExistingDownloadPathsFactory(IDownloadPaths paths) : IDownloadPathsFactory
    {
        public IDownloadPaths Create(string? destinationFolder)
        {
            if (destinationFolder is not null)
                throw new ArgumentException("The fixed paths instance does not accept another destination.", nameof(destinationFolder));
            return paths;
        }
    }
}

internal enum VolumeSpaceStatus
{
    Enough = 0,
    Insufficient = 1,
    Unavailable = 2
}

internal interface IVolumeSpaceProbe
{
    VolumeSpaceStatus Check(string volumeRoot, long requiredBytes);
}

internal sealed class DriveInfoVolumeSpaceProbe : IVolumeSpaceProbe
{
    public VolumeSpaceStatus Check(string volumeRoot, long requiredBytes)
    {
        try
        {
            var drive = new DriveInfo(volumeRoot);
            if (!drive.IsReady) return VolumeSpaceStatus.Unavailable;
            return drive.AvailableFreeSpace >= requiredBytes
                ? VolumeSpaceStatus.Enough
                : VolumeSpaceStatus.Insufficient;
        }
        catch (Exception exception) when (
            exception is ArgumentException or IOException or UnauthorizedAccessException)
        {
            // Some UNC and virtual filesystems do not expose capacity through DriveInfo.
            return VolumeSpaceStatus.Enough;
        }
    }
}
