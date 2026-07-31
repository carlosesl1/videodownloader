using System.Text.RegularExpressions;
using System.Text;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Media;
using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.YouTube;

public sealed partial class YouTubeService : IYouTubeService
{
    private const int MaximumCachedCatalogs = 16;
    private const int MaximumCachedMetadataBytes = 4 * 1024 * 1024;
    private static readonly TimeSpan SocialCatalogLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan YouTubeCatalogLifetime = TimeSpan.FromMinutes(30);
    private const string MetadataLookupError = "Unable to retrieve media metadata.";
    private const string InvalidOutputError = "The downloaded file was not reported safely.";
    private readonly string tools;
    private readonly IProcessRunner processRunner;
    private readonly IDownloadPathsFactory downloadPathsFactory;
    private readonly TimeProvider timeProvider;
    private readonly object stateLock = new();
    private readonly Dictionary<string, CatalogLookup> catalogCache = new(StringComparer.Ordinal);
    private readonly Queue<string> catalogOrder = new();
    private int cachedMetadataBytes;
    private ActiveJob? activeJob;
    private JobSnapshot? snapshot;

    public YouTubeService(string tools, IProcessRunner processRunner)
        : this(tools, processRunner, CreateDefaultFactory(), TimeProvider.System)
    {
    }

    public YouTubeService(string tools, IProcessRunner processRunner, IDownloadPaths downloadPaths)
        : this(tools, processRunner, new DownloadPathsFactory(downloadPaths.Home, downloadPaths.TempRoot), TimeProvider.System)
    {
        ArgumentNullException.ThrowIfNull(downloadPaths);
    }

    public YouTubeService(string tools, IProcessRunner processRunner, IDownloadPathsFactory downloadPathsFactory)
        : this(tools, processRunner, downloadPathsFactory, TimeProvider.System)
    {
    }

    public YouTubeService(
        string tools,
        IProcessRunner processRunner,
        IDownloadPathsFactory downloadPathsFactory,
        TimeProvider timeProvider)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tools);
        ArgumentNullException.ThrowIfNull(processRunner);
        ArgumentNullException.ThrowIfNull(downloadPathsFactory);
        ArgumentNullException.ThrowIfNull(timeProvider);
        this.tools = tools;
        this.processRunner = processRunner;
        this.downloadPathsFactory = downloadPathsFactory;
        this.timeProvider = timeProvider;
    }

    public async Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken)
    {
        return (await GetCatalogAsync(url, cancellationToken)).Catalog;
    }

    private async Task<CachedCatalog> GetCatalogAsync(string url, CancellationToken cancellationToken)
    {
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
                    new Lazy<Task<CachedCatalog>>(
                        () => LoadCatalogAsync(canonicalUrl, page.Platform, CancellationToken.None),
                        LazyThreadSafetyMode.ExecutionAndPublication));
                catalogCache.Add(canonicalUrl, lookup);
                catalogOrder.Enqueue(canonicalUrl);
                TrimCatalogsLocked(canonicalUrl);
            }
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

        if (result.ExitCode != 0) throw new InvalidOperationException(MetadataLookupError);
        var catalog = FormatCatalog.Parse(result.StandardOutput);
        return new CachedCatalog(
            catalog with { Platform = platform },
            result.StandardOutput,
            timeProvider.GetUtcNow(),
            Encoding.UTF8.GetByteCount(result.StandardOutput));
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

    private void InvalidateCatalog(string canonicalUrl)
    {
        lock (stateLock)
        {
            if (catalogCache.TryGetValue(canonicalUrl, out var lookup))
                RemoveCatalogLocked(canonicalUrl, lookup);
        }
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
        }
    }

    public async Task<JobResult> StartDownloadAsync(
        string jobId,
        string url,
        int height,
        string? destinationFolder,
        Func<JobProgress, Task> onProgress,
        CancellationToken cancellationToken)
    {
        ValidateJobId(jobId);
        if (!MediaPage.TryCanonicalize(url, out var page))
            throw new InvalidDataException("Invalid media URL.");
        var canonicalUrl = page!.CanonicalUrl;
        if (height is < 144 or > 4320) throw new ArgumentOutOfRangeException(nameof(height));
        ArgumentNullException.ThrowIfNull(onProgress);
        cancellationToken.ThrowIfCancellationRequested();

        var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var job = new ActiveJob(jobId, height, linkedCancellation);
        lock (stateLock)
        {
            if (activeJob is not null)
            {
                linkedCancellation.Dispose();
                throw new InvalidOperationException("Another download is already active.");
            }

            activeJob = job;
            snapshot = new JobSnapshot(jobId, string.Empty, string.Empty, height, "preparing", null, null, null);
        }

        string? reservedStem = null;
        IDownloadPaths? paths = null;
        var tempCreated = false;
        try
        {
            var cachedCatalog = await GetCatalogAsync(canonicalUrl, linkedCancellation.Token);
            var catalog = cachedCatalog.Catalog;
            EnsureQualityAvailable(job, catalog, height, "invalid_selection");

            SetMetadata(job, catalog);
            paths = downloadPathsFactory.Create(destinationFolder);
            reservedStem = paths.ReserveStem(catalog.Title, catalog.VideoId);
            var temp = paths.CreateJobTemp(jobId);
            tempCreated = true;

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
                        height,
                        infoJsonPath),
                    line => HandleOutputAsync(job, paths, line, onProgress),
                    linkedCancellation.Token);

                linkedCancellation.Token.ThrowIfCancellationRequested();
                if (result.ExitCode == 0) break;

                var failure = ClassifyDownloadFailure(result.StandardError);
                if (page.Platform == "instagram"
                    && attempt == 0
                    && failure.Code == "MEDIA_ACCESS_DENIED")
                {
                    InvalidateCatalog(canonicalUrl);
                    paths.DeleteJobTemp(jobId);
                    temp = paths.CreateJobTemp(jobId);
                    cachedCatalog = await GetCatalogAsync(canonicalUrl, linkedCancellation.Token);
                    catalog = cachedCatalog.Catalog;
                    EnsureQualityAvailable(job, catalog, height, "FORMAT_UNAVAILABLE");
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

            SetCompleted(job, finalPath);
            return new JobResult(jobId, finalPath);
        }
        catch (OperationCanceledException)
        {
            SetTerminal(job, "cancelled", "cancelled");
            throw;
        }
        catch
        {
            SetFailureUnlessTerminal(job);
            throw;
        }
        finally
        {
            if (paths is not null && tempCreated) TryCleanup(() => paths.DeleteJobTemp(jobId));
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

    public Task CancelAsync(string jobId)
    {
        CancellationTokenSource? cancellation = null;
        lock (stateLock)
        {
            if (activeJob is not null && string.Equals(activeJob.JobId, jobId, StringComparison.Ordinal))
                cancellation = activeJob.Cancellation;
        }

        if (cancellation is not null)
        {
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // The job completed while cancellation was being requested.
            }
        }

        return Task.CompletedTask;
    }

    public JobSnapshot? GetJob()
    {
        lock (stateLock) return snapshot;
    }

    private void EnsureQualityAvailable(
        ActiveJob job,
        FormatCatalog catalog,
        int height,
        string errorCode)
    {
        if (catalog.Qualities.Any(quality => quality.Height == height)) return;
        SetTerminal(job, "failed", errorCode);
        if (errorCode == "FORMAT_UNAVAILABLE")
        {
            throw new MediaDownloadException(
                errorCode,
                "A qualidade escolhida não está mais disponível.");
        }

        throw new InvalidDataException("Selected quality is unavailable.");
    }

    private async Task HandleOutputAsync(ActiveJob job, IDownloadPaths paths, string line, Func<JobProgress, Task> onProgress)
    {
        if (!ProgressParser.TryParse(line, out var parsed) || parsed is null) return;
        if (parsed.Stage == "finalize" && (parsed.Path is null || !paths.ContainsFinalPath(parsed.Path)))
            return;

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

        job.ProgressRank = rank;
        job.ProgressStage = progress.Stage;
        if (progress.Percent.HasValue) job.ProgressPercent = progress.Percent;
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
            job.FinalPath = null;
            snapshot = new JobSnapshot(job.JobId, catalog.VideoId, catalog.Title, job.Height, "preparing", null, null, null);
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

    private sealed class ActiveJob(string jobId, int height, CancellationTokenSource cancellation)
    {
        public string JobId { get; } = jobId;
        public int Height { get; } = height;
        public CancellationTokenSource Cancellation { get; } = cancellation;
        public int ProgressRank { get; set; }
        public string? ProgressStage { get; set; }
        public int? ProgressPercent { get; set; }
        public string? FinalPath { get; set; }
        public bool Terminal { get; set; }
    }

    private sealed class CatalogLookup(string platform, Lazy<Task<CachedCatalog>> task)
    {
        public string Platform { get; } = platform;
        public Lazy<Task<CachedCatalog>> Task { get; } = task;
        public int MetadataBytes { get; set; }
    }

    private sealed record CachedCatalog(
        FormatCatalog Catalog,
        string MetadataJson,
        DateTimeOffset CreatedAt,
        int MetadataBytes);
}
